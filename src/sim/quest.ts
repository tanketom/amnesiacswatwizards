/**
 * Procedural quest generator. Plants the target concretely, then builds a clue
 * chain that provably narrows the candidate set to exactly the target building,
 * and scatters clue carriers between the drop point and the target.
 */
import { RNG } from '../core/rng';
import type { Pt } from '../core/grid';
import type { RasterCity, BuildingInfo } from '../map/rasterize';
import { districtDisplay } from '../map/cityModel';
import { buildingAttrs, questableBuildings, BuildingAttrs } from '../map/cityIndex';
import {
  Quest, QuestKind, Clue, ClueFilter, ARCHETYPES, TRAITS, Unit, makeUnit,
} from './types';

export interface QuestSetup {
  quest: Quest;
  /** target + decoys + bodyguards (positions set). */
  npcs: Unit[];
  /** clue assignments for civilians: clue -> how many carriers wanted. */
  clueCarriers: { clue: Clue; nearBuilding: number | null }[];
}

const SIZE_WORDS: Record<string, string> = {
  small: 'a cramped little place',
  medium: 'a modest house',
  large: 'a grand building',
};

export function generateQuest(raster: RasterCity, rng: RNG, kind?: QuestKind): QuestSetup {
  const candidates = questableBuildings(raster);
  if (candidates.length < 4) throw new Error('city too sparse for a quest');

  const questKind: QuestKind = kind ?? (rng.chance(0.5) ? 'assassinate' : 'extract');
  const arch = rng.pick(ARCHETYPES);

  // Target building: prefer archetype district tags, medium/large.
  const preferred = candidates.filter(
    (b) => arch.preferredTags.includes(b.district) && b.sizeClass !== 'small',
  );
  const pool = preferred.length > 0 ? preferred : candidates.filter((b) => b.sizeClass !== 'small');
  const tb = rng.pick(pool.length > 0 ? pool : candidates);

  const attrsOf = new Map<number, BuildingAttrs>();
  for (const b of candidates) attrsOf.set(b.id, buildingAttrs(raster, b));
  const tAttrs = attrsOf.get(tb.id)!;

  // Build the chain: apply discriminating filters until only the target remains.
  const chain: Clue[] = [];
  let remaining = [...candidates];
  let clueId = 1;
  const tryFilter = (filter: ClueFilter, text: string) => {
    const filtered = remaining.filter((b) => matches(b, attrsOf.get(b.id)!, filter));
    if (filtered.length < remaining.length && filtered.some((b) => b.id === tb.id)) {
      remaining = filtered;
      chain.push({ id: clueId++, text, filter });
    }
  };

  tryFilter(
    { kind: 'district', value: tAttrs.district },
    `Word on the street: ${arch.displayName} operates out of ${districtDisplay(tb.district, tb.districtName)}.`,
  );
  if (remaining.length > 1) {
    tryFilter(
      { kind: 'size', value: tAttrs.size },
      `They say the hideout is ${SIZE_WORDS[tAttrs.size]}.`,
    );
  }
  if (remaining.length > 1) {
    tryFilter(
      { kind: 'quadrant', value: tAttrs.quadrant },
      `A beggar swears it's in the ${tAttrs.quadrant} part of town.`,
    );
  }
  if (remaining.length > 1) {
    tryFilter(
      { kind: 'facing', value: tAttrs.facing },
      `The hideout's door opens to the ${tAttrs.facing}.`,
    );
  }
  if (remaining.length > 1) {
    chain.push({
      id: clueId++,
      text: `A scrap of map with one building circled – that's the place.`,
      filter: { kind: 'exact', value: tb.id },
    });
    remaining = [tb];
  }

  // Identity clue for assassinate-with-decoys.
  const hasDecoys = questKind === 'assassinate' && tb.rooms.length >= 1 && rng.chance(0.8);
  const traits = rng.shuffle([...TRAITS]);
  const targetTrait = traits[0];
  if (hasDecoys) {
    chain.push({
      id: clueId++,
      text: `The real ${arch.displayName} wears ${targetTrait}. Anyone else is a lookalike.`,
      filter: { kind: 'identity', value: targetTrait },
    });
  }

  // --- Place quest NPCs
  const npcs: Unit[] = [];
  const W = raster.grid.width;
  const roomTiles = deepestRoomTiles(raster, tb);
  const spots = rng.shuffle([...roomTiles]);
  const spotAt = (i: number): Pt => {
    const t = spots[i % spots.length];
    return { x: t % W, y: Math.floor(t / W) };
  };

  const targetPos = spotAt(0);
  const target = makeUnit({
    faction: 'civilian',
    x: targetPos.x,
    y: targetPos.y,
    name: arch.displayName,
    hp: 6,
    maxHp: 6,
    move: 5,
    isTarget: true,
    trait: targetTrait,
    homeBuilding: tb.id,
    aiState: 'idle',
  });
  npcs.push(target);

  if (hasDecoys) {
    for (let i = 0; i < 2; i++) {
      const p = spotAt(i + 1);
      npcs.push(
        makeUnit({
          faction: 'civilian',
          x: p.x,
          y: p.y,
          name: `${arch.displayName}?`,
          hp: 4,
          maxHp: 4,
          isDecoy: true,
          trait: traits[i + 1],
          homeBuilding: tb.id,
        }),
      );
    }
  }

  const guardCount = questKind === 'assassinate' && !hasDecoys ? 3 : 2;
  for (let i = 0; i < guardCount; i++) {
    const p = spotAt(i + 3);
    npcs.push(
      makeUnit({
        faction: 'hostile',
        x: p.x,
        y: p.y,
        name: 'Bodyguard',
        hp: 8,
        maxHp: 8,
        move: 5,
        homeBuilding: tb.id,
        aiState: 'idle',
      }),
    );
  }

  // Clue carriers: early clues near the drop side, later clues nearer the target.
  const clueCarriers: { clue: Clue; nearBuilding: number | null }[] = [];
  for (let i = 0; i < chain.length; i++) {
    const clue = chain[i];
    // two carriers per clue for redundancy
    clueCarriers.push({ clue, nearBuilding: null }); // anywhere
    clueCarriers.push({ clue, nearBuilding: i >= chain.length - 2 ? tb.id : null });
  }

  const verb = questKind === 'assassinate' ? 'Eliminate' : 'Subdue and extract';
  const quest: Quest = {
    kind: questKind,
    targetName: arch.displayName,
    targetArchetype: arch.epithet,
    briefing:
      `${verb} ${arch.displayName} – ${arch.epithet}. ` +
      `You've never seen this city before. Find them, do the job, and get back to the anchor stone.`,
    targetBuilding: tb.id,
    targetUnitId: target.id,
    chain,
    hasDecoys,
  };

  return { quest, npcs, clueCarriers };
}

function matches(b: BuildingInfo, a: BuildingAttrs, f: ClueFilter): boolean {
  switch (f.kind) {
    case 'district': return a.district === f.value;
    case 'size': return a.size === f.value;
    case 'quadrant': return a.quadrant === f.value;
    case 'facing': return a.facing === f.value;
    case 'exact': return b.id === f.value;
    default: return true;
  }
}

/** Tiles of the room farthest from the building's main door. */
function deepestRoomTiles(raster: RasterCity, b: BuildingInfo): number[] {
  const W = raster.grid.width;
  if (b.rooms.length === 0) return b.floorTiles;
  if (b.doorTiles.length === 0) return b.rooms[0].tiles;
  const door = b.doorTiles[0];
  const dx = door % W;
  const dy = Math.floor(door / W);
  let best = b.rooms[0];
  let bestD = -1;
  for (const r of b.rooms) {
    const t = r.tiles[0];
    const d = Math.abs((t % W) - dx) + Math.abs(Math.floor(t / W) - dy);
    if (d > bestD) {
      bestD = d;
      best = r;
    }
  }
  return best.tiles;
}
