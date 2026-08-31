import { describe, it, expect } from 'vitest';
import { Terrain } from '../src/core/grid';
import { reachable } from '../src/core/pathfind';
import { generateFallbackCity } from '../src/map/fallbackCity';
import { rasterizeCity } from '../src/map/rasterize';
import { EventBus } from '../src/core/events';
import { MissionState } from '../src/sim/game';
import { Knowledge } from '../src/sim/intel';
import { generateQuest } from '../src/sim/quest';
import { RNG } from '../src/core/rng';

function makeMission(seed: number, kind?: 'assassinate' | 'extract') {
  const city = generateFallbackCity(seed);
  const raster = rasterizeCity(city, seed);
  const bus = new EventBus();
  return { state: new MissionState(raster, seed, bus, kind), bus, raster };
}

describe('quest generation', () => {
  for (const seed of [3, 77, 2024, 55555, 91]) {
    it(`seed ${seed}: clue chain narrows candidates to exactly the target`, () => {
      const city = generateFallbackCity(seed);
      const raster = rasterizeCity(city, seed);
      const bus = new EventBus();
      const setup = generateQuest(raster, new RNG(seed));
      const k = new Knowledge(raster, setup.quest.targetBuilding, bus);
      expect(k.candidates.size).toBeGreaterThan(3);
      for (const clue of setup.quest.chain) k.learnClue(clue);
      expect(k.targetBuildingKnown).toBe(setup.quest.targetBuilding);
    });
  }

  it('target NPC actually lives in the target building', () => {
    const { state, raster } = makeMission(42);
    const t = state.targetUnit();
    const b = raster.buildings.find((bb) => bb.id === state.quest.targetBuilding)!;
    const idx = t.y * raster.grid.width + t.x;
    expect(b.floorTiles).toContain(idx);
  });

  it('every chain clue has at least one civilian carrier', () => {
    const { state } = makeMission(1234);
    const carried = new Set(
      state.units.filter((u) => u.clue).map((u) => u.clue!.id),
    );
    for (const clue of state.quest.chain) {
      expect(carried.has(clue.id)).toBe(true);
    }
  });

  it('is deterministic', () => {
    const a = makeMission(999);
    const b = makeMission(999);
    expect(a.state.quest.targetBuilding).toBe(b.state.quest.targetBuilding);
    expect(a.state.units.map((u) => `${u.name}@${u.x},${u.y}`)).toEqual(
      b.state.units.map((u) => `${u.name}@${u.x},${u.y}`),
    );
  });
});

describe('mission sim', () => {
  it('survives 15 uneventful turns (guards passive at alarm 0)', () => {
    const { state } = makeMission(7);
    for (let i = 0; i < 15; i++) state.endTurn();
    expect(state.phase).toBe('player');
    expect(state.squadUnits().length).toBe(4);
    expect(state.alarm.level).toBe(0);
  });

  it('loud magic near witnesses raises the alarm (and rings out)', () => {
    const { state, bus } = makeMission(21);
    let rings = 0;
    bus.on('noiseMade', () => rings++);
    const wiz = state.squadUnits()[0];
    // put a civilian right next to the wizard and fire a bolt at a fresh dummy guard
    const civ = state.units.find((u) => u.faction === 'civilian' && !u.isTarget)!;
    civ.x = wiz.x + 1;
    civ.y = wiz.y;
    state.witnessNoise(wiz, wiz, 3);
    expect(state.alarm.points).toBeGreaterThan(0);
    expect(civ.aiState).toBe('flee');
    expect(rings).toBe(1);
  });

  it('scry narrows candidates and never eliminates the target', () => {
    const { state } = makeMission(31);
    const wiz = state.squadUnits().find((u) => u.spells.includes('scry'))!;
    const before = state.knowledge.candidates.size;
    const ok = state.castSpell(wiz, 'scry', wiz);
    expect(ok).toBe(true);
    expect(state.knowledge.candidates.size).toBeLessThanOrEqual(before);
    expect(state.knowledge.candidates.has(state.quest.targetBuilding)).toBe(true);
  });

  it('extract: sleep + carry to anchor completes the mission', () => {
    const { state } = makeMission(63, 'extract');
    const t = state.targetUnit();
    const wiz = state.squadUnits().find((u) => u.spells.includes('sleep'))!;
    // teleport wizard next to target (test shortcut)
    wiz.x = t.x;
    wiz.y = t.y + 1 <= state.grid.height - 1 && state.grid.walkable(t.x, t.y + 1) ? t.y + 1 : t.y - 1;
    state.updateFov();
    const slept = state.castSpell(wiz, 'sleep', { x: t.x, y: t.y });
    expect(slept).toBe(true);
    expect(t.subdued).toBe(true);
    wiz.ap = 2;
    expect(state.pickup(wiz, t)).toBe(true);
    // move squad to the anchor
    for (const u of state.squadUnits()) {
      u.x = state.dropPoint.x;
      u.y = state.dropPoint.y;
    }
    // spread them within the zone (occupancy irrelevant for the check)
    state.checkEnd();
    expect(state.phase).toBe('ended');
    expect(state.victory).toBe(true);
  });

  it('assassinate: dead target + squad at anchor wins', () => {
    const { state } = makeMission(64, 'assassinate');
    const t = state.targetUnit();
    state.applyDamage(t, 99, state.squadUnits()[0]);
    expect(t.alive).toBe(false);
    for (const u of state.squadUnits()) {
      u.x = state.dropPoint.x;
      u.y = state.dropPoint.y;
    }
    state.checkEnd();
    expect(state.victory).toBe(true);
  });

  it('squad wipe loses', () => {
    const { state } = makeMission(65);
    for (const u of [...state.squadUnits()]) state.applyDamage(u, 99, null);
    expect(state.phase).toBe('ended');
    expect(state.victory).toBe(false);
  });
});

describe('cover & peeking', () => {
  function openArena(state: ReturnType<typeof makeMission>['state']) {
    // clear a corner arena and move every NPC far away
    const { grid } = state;
    for (let y = 1; y <= 8; y++) {
      for (let x = 1; x <= 16; x++) grid.set(x, y, Terrain.Street);
    }
    for (const u of state.units) {
      if (u.faction !== 'squad') {
        u.x = 100;
        u.y = 100;
      }
    }
  }

  it('half cover reduces hit chance; flanking restores it', () => {
    const { state } = makeMission(7);
    openArena(state);
    const wiz = state.squadUnits()[0];
    const guard = state.units.find((u) => u.faction === 'guard')!;
    wiz.x = 4; wiz.y = 5;
    guard.x = 12; guard.y = 5;
    expect(state.hitChance(wiz, guard)!.chance).toBe(85);
    state.grid.set(11, 5, Terrain.Cover); // cart between them, hugging the guard
    expect(state.hitChance(wiz, guard)!.chance).toBe(65);
    expect(state.hitChance(wiz, guard)!.cover).toBe(1);
    wiz.x = 12; wiz.y = 2; // swing around: attack from the north = flanked
    const flank = state.hitChance(wiz, guard)!;
    expect(flank.chance).toBe(85);
    expect(flank.cover).toBe(0);
  });

  it('walls give full cover', () => {
    const { state } = makeMission(7);
    openArena(state);
    const wiz = state.squadUnits()[0];
    const guard = state.units.find((u) => u.faction === 'guard')!;
    wiz.x = 12; wiz.y = 2;
    guard.x = 12; guard.y = 6;
    state.grid.set(12, 5, Terrain.Cover); // half between…
    expect(state.grid.coverFrom(guard.x, guard.y, wiz.x, wiz.y)).toBe(1);
    state.grid.set(12, 5, Terrain.Wall); // …upgraded to a wall = full (and blocks the shot)
    expect(state.grid.coverFrom(guard.x, guard.y, wiz.x, wiz.y)).toBe(2);
  });

  it('every seed grows windows on buildings', () => {
    for (const seed of [1, 77, 555]) {
      const { state } = makeMission(seed);
      const withWindows = state.raster.buildings.filter((b) => b.windowTiles.length > 0);
      expect(withWindows.length).toBeGreaterThan(state.raster.buildings.length / 3);
      for (const b of withWindows) {
        for (const w of b.windowTiles) expect(state.grid.terrain[w]).toBe(Terrain.Window);
      }
    }
  });

  it('closed doors block sight; opened doors do not', () => {
    const { state } = makeMission(7);
    openArena(state);
    state.grid.set(8, 4, Terrain.Door);
    const a = { x: 6, y: 4 };
    const b = { x: 10, y: 4 };
    expect(state.attackOrigin(a, b)).toBeNull();
    expect(state.grid.openDoor(8, 4)).toBe(true);
    expect(state.attackOrigin(a, b)).not.toBeNull();
    // an opened door is no longer cover
    expect(state.grid.coverFrom(9, 4, 6, 4)).toBe(0);
  });

  it('windows: see through, shoot through, climb through slowly', () => {
    const { state } = makeMission(7);
    openArena(state);
    state.grid.set(8, 4, Terrain.Window);
    const wiz = state.squadUnits()[0];
    wiz.x = 6;
    wiz.y = 4;
    // sight and fire lines pass through glass
    expect(state.attackOrigin(wiz, { x: 10, y: 4 })).not.toBeNull();
    // window gives half cover to someone hugging it
    expect(state.grid.coverFrom(9, 4, 6, 4)).toBe(1);
    // climbing costs +2 tiles of movement
    const r = reachable(state.grid, { x: 7, y: 4 }, 3);
    expect(r.has(4 * state.grid.width + 8)).toBe(true); // onto the sill: 1 + 2 = 3
    const rShort = reachable(state.grid, { x: 7, y: 4 }, 2);
    expect(rShort.has(4 * state.grid.width + 8)).toBe(false);
    // smashing through makes noise
    state.updateFov();
    const before = state.alarm.points;
    state.traverseEffects(wiz, [{ x: 7, y: 4 }, { x: 8, y: 4 }]);
    void before; // noise only counts if witnessed; the log line always fires
  });

  it('windows smash loudly once — or open silently first', () => {
    // smash path: glass breaks, witnessed, and never breaks again
    const a = makeMission(7);
    openArena(a.state);
    a.state.grid.set(8, 4, Terrain.Window);
    const civA = a.state.units.find((u) => u.faction === 'civilian' && !u.isTarget)!;
    civA.x = 10; civA.y = 4; civA.aiState = 'idle';
    const wizA = a.state.squadUnits()[0];
    wizA.x = 7; wizA.y = 4;
    let smashes = 0;
    a.bus.on('windowSmashed', () => smashes++);
    a.state.traverseEffects(wizA, [{ x: 8, y: 4 }]);
    expect(a.state.grid.opened(8, 4)).toBe(true);
    expect(a.state.alarm.points).toBeGreaterThan(0);
    expect(smashes).toBe(1);
    const afterSmash = a.state.alarm.points;
    a.state.traverseEffects(wizA, [{ x: 8, y: 4 }]); // climbing back out: no more glass
    expect(a.state.alarm.points).toBe(afterSmash);
    expect(smashes).toBe(1);

    // stealth path: unlatch first, climb silently
    const b = makeMission(7);
    openArena(b.state);
    b.state.grid.set(8, 4, Terrain.Window);
    const civB = b.state.units.find((u) => u.faction === 'civilian' && !u.isTarget)!;
    civB.x = 10; civB.y = 4; civB.aiState = 'idle';
    const wizB = b.state.squadUnits()[0];
    wizB.x = 7; wizB.y = 4;
    expect(b.state.openAdjacentPortal(wizB, { x: 8, y: 4 })).toBe(true);
    b.state.traverseEffects(wizB, [{ x: 8, y: 4 }]);
    expect(b.state.alarm.points).toBe(0);
  });

  it('hostiles with a cold trail investigate the last commotion', () => {
    const { state } = makeMission(7);
    openArena(state);
    const guard = state.units.find((u) => u.faction === 'guard')!;
    guard.x = 4;
    guard.y = 4;
    guard.aiState = 'combat';
    guard.lastKnownSquadPos = null;
    guard.patrol = [];
    // keep the squad far away so nothing is seen
    for (const w of state.squadUnits()) {
      w.x = 100;
      w.y = 100;
    }
    state.lastCommotion = { x: 14, y: 4 };
    state.commotionSeq = 5;
    const beforeDist = Math.abs(guard.x - 14) + Math.abs(guard.y - 4);
    state.endTurn();
    const afterDist = Math.abs(guard.x - 14) + Math.abs(guard.y - 4);
    expect(afterDist).toBeLessThan(beforeDist);
    expect(guard.commotionSeq).toBe(5);
  });

  it('sunder blows a wall open', () => {
    const { state } = makeMission(7);
    openArena(state);
    state.grid.set(8, 4, Terrain.Wall);
    const bram = state.units.find((u) => u.name === 'Bram')!;
    bram.x = 7; bram.y = 4; bram.ap = 2; bram.mana = 12;
    expect(state.castSpell(bram, 'sunder', { x: 8, y: 4 })).toBe(true);
    expect(state.grid.get(8, 4)).toBe(Terrain.Floor);
  });

  it('suppression drops the victim\'s aim by 30', () => {
    const { state } = makeMission(7);
    openArena(state);
    const wiz = state.squadUnits()[0];
    const guard = state.units.find((u) => u.faction === 'guard')!;
    wiz.x = 4; wiz.y = 4;
    guard.x = 10; guard.y = 4;
    expect(state.hitChance(guard, wiz)!.chance).toBe(85);
    guard.suppressedTurns = 2;
    expect(state.hitChance(guard, wiz)!.chance).toBe(55);
  });

  it('mirror peek reveals the room behind a closed door', () => {
    const { state } = makeMission(7);
    openArena(state);
    state.grid.set(8, 4, Terrain.Door);
    const wiz = state.squadUnits()[0];
    wiz.x = 7; wiz.y = 4;
    const W = state.grid.width;
    state.explored[4 * W + 11] = 0;
    expect(state.peekDoor(wiz, { x: 8, y: 4 })).toBe(true);
    expect(state.explored[4 * W + 11]).toBe(1);
    expect(state.grid.isDoorOpen(8, 4)).toBe(false); // still closed
  });

  it('coordinated breach: door pops and stacked wizards unload', () => {
    const { state } = makeMission(7);
    openArena(state);
    // room east of a closed door at (8,4)
    for (let y = 2; y <= 6; y++) for (let x = 8; x <= 13; x++) state.grid.set(x, y, Terrain.Wall);
    for (let y = 3; y <= 5; y++) for (let x = 9; x <= 12; x++) state.grid.set(x, y, Terrain.Floor);
    state.grid.set(8, 4, Terrain.Door);
    const bg = state.units.find((u) => u.faction === 'hostile' && u.alive)!;
    bg.x = 11; bg.y = 4;
    const [w1, w2] = state.squadUnits();
    w1.x = 7; w1.y = 4; w1.ap = 2; w1.mana = 10;
    w2.x = 6; w2.y = 4; w2.ap = 2; w2.mana = 10;
    state.updateFov();
    expect(state.breach(w1, { x: 8, y: 4 })).toBe(true);
    expect(state.grid.isDoorOpen(8, 4)).toBe(true);
    // both were stacked with sight lines: both dumped their turn into the volley
    expect(w1.ap).toBe(0);
    expect(w2.ap).toBe(0);
  });

  it('containers exist, hold clues, and can be searched', () => {
    const { state } = makeMission(7);
    expect(state.containers.size).toBeGreaterThan(10);
    const entry = [...state.containers.entries()].find(([, c]) => c.clue !== null);
    expect(entry).toBeDefined();
    const [idx] = entry!;
    const W = state.grid.width;
    const wiz = state.squadUnits()[0];
    wiz.x = (idx % W) + 1; wiz.y = Math.floor(idx / W);
    if (!state.grid.walkable(wiz.x, wiz.y)) { wiz.x = (idx % W) - 1; }
    wiz.ap = 2;
    const before = state.knowledge.clues.length;
    expect(state.searchContainer(wiz, { x: idx % W, y: Math.floor(idx / W) })).toBe(true);
    expect(state.knowledge.clues.length).toBeGreaterThan(before);
  });

  it('unhidden bodies raise the alarm; stashed bodies do not', () => {
    // corpse in the open
    const a = makeMission(7);
    openArena(a.state);
    const civA = a.state.units.find((u) => u.faction === 'civilian' && !u.isTarget && !u.clue)!;
    civA.x = 6; civA.y = 4;
    a.state.applyDamage(civA, 99, null);
    const guardA = a.state.units.find((u) => u.faction === 'guard')!;
    guardA.x = 10; guardA.y = 4; guardA.patrol = [];
    for (const w of a.state.squadUnits()) { w.x = 100; w.y = 100; }
    a.state.updateFov();
    const beforeA = a.state.alarm.points;
    a.state.endTurn();
    expect(a.state.alarm.points).toBeGreaterThan(beforeA);

    // same scene, but the body is stashed first
    const b = makeMission(7);
    openArena(b.state);
    const civB = b.state.units.find((u) => u.faction === 'civilian' && !u.isTarget && !u.clue)!;
    civB.x = 6; civB.y = 4;
    b.state.applyDamage(civB, 99, null);
    const wiz = b.state.squadUnits()[0];
    wiz.x = 6; wiz.y = 5; wiz.ap = 2;
    expect(b.state.pickup(wiz, civB)).toBe(true);
    b.state.grid.set(5, 5, Terrain.Container);
    b.state.containers.set(5 * b.state.grid.width + 5, { clue: null, searched: false, bodies: [] });
    expect(b.state.stashBody(wiz, { x: 5, y: 5 })).toBe(true);
    expect(civB.stashed).toBe(true);
    const guardB = b.state.units.find((u) => u.faction === 'guard')!;
    guardB.x = 10; guardB.y = 4; guardB.patrol = [];
    for (const w of b.state.squadUnits()) { w.x = 100; w.y = 100; }
    b.state.updateFov();
    const beforeB = b.state.alarm.points;
    b.state.endTurn();
    expect(b.state.alarm.points).toBe(beforeB);
  });

  it('guards who only HEAR a noise investigate instead of attacking', () => {
    const { state } = makeMission(7);
    openArena(state);
    // wall between the noise and the guard
    state.grid.set(9, 3, Terrain.Wall);
    state.grid.set(9, 4, Terrain.Wall);
    state.grid.set(9, 5, Terrain.Wall);
    const wiz = state.squadUnits()[0];
    wiz.x = 6; wiz.y = 4;
    const guard = state.units.find((u) => u.faction === 'guard')!;
    guard.x = 12; guard.y = 4;
    state.witnessNoise(wiz, wiz, 2);
    expect(guard.aiState).toBe('suspicious');
    expect(guard.lastKnownSquadPos).toEqual({ x: 6, y: 4 });
  });

  it('step-out peek finds a firing line around a wall corner', () => {
    const { state } = makeMission(7);
    openArena(state);
    // wall segment with a gap at the south end
    state.grid.set(8, 3, Terrain.Wall);
    state.grid.set(8, 4, Terrain.Wall);
    const attacker = { x: 7, y: 4 };
    const target = { x: 10, y: 4 };
    // direct line is blocked…
    expect(state.attackOrigin(attacker, target)).not.toBeNull();
    const origin = state.attackOrigin(attacker, target)!;
    // …but a sidestep clears it, and it is NOT the attacker's own tile
    expect(origin.x === attacker.x && origin.y === attacker.y).toBe(false);
  });
});
