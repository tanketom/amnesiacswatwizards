/**
 * MissionState: the headless, deterministic heart of a mission.
 * Rendering/UI subscribe to the EventBus; nothing in here touches Pixi or DOM.
 */
import { TileGrid, Terrain, Pt, CoverLevel, COVER_PENALTY } from '../core/grid';
import { RNG } from '../core/rng';
import { EventBus } from '../core/events';
import { computeFov, hasLos } from '../core/fov';
import { findPath, reachable, WINDOW_CLIMB_COST } from '../core/pathfind';
import type { RasterCity } from '../map/rasterize';
import { Unit, makeUnit, resetUnitIds, WIZARDS, SpellId, QuestKind, Quest } from './types';
import { SPELLS } from './spells';
import { Alarm } from './alarm';
import { Knowledge } from './intel';
import { generateQuest } from './quest';
import { runNpcPhase } from './ai';

export type Phase = 'player' | 'npc' | 'ended';

export class MissionState {
  readonly grid: TileGrid;
  readonly raster: RasterCity;
  readonly bus: EventBus;
  readonly rng: RNG;
  readonly units: Unit[] = [];
  readonly quest: Quest;
  readonly knowledge: Knowledge;
  readonly alarm: Alarm;

  explored: Uint8Array;
  visible = new Set<number>();
  turn = 1;
  phase: Phase = 'player';
  victory: boolean | null = null;
  private regroupAnnounced = false;
  /** Latest loud event: hostiles with a cold trail investigate it. */
  lastCommotion: Pt | null = null;
  commotionSeq = 0;
  /** Chests & cupboards by tile index: searchable, and they swallow bodies. */
  containers = new Map<number, { clue: import('./types').Clue | null; searched: boolean; bodies: number[] }>();
  civiliansKilled = 0;
  dropPoint: Pt;
  /** Extraction = the anchor stone at the drop point. */
  extractionRadius = 2;

  constructor(raster: RasterCity, seed: number, bus: EventBus, questKind?: QuestKind) {
    this.raster = raster;
    this.grid = raster.grid;
    this.bus = bus;
    this.rng = new RNG(seed).fork(77);
    this.explored = new Uint8Array(this.grid.width * this.grid.height);
    this.alarm = new Alarm(bus);
    this.alarm.onLevelUp = (l) => this.spawnReinforcements(l);

    resetUnitIds();

    // Quest first (places target/bodyguards/decoys).
    const setup = generateQuest(raster, this.rng.fork(1), questKind);
    this.quest = setup.quest;
    this.knowledge = new Knowledge(raster, this.quest.targetBuilding, bus);

    // Drop point: street tile near the map edge, far from the target building.
    this.dropPoint = this.pickDropPoint();

    // Squad.
    const squadTiles = this.openTilesAround(this.dropPoint, 8);
    WIZARDS.forEach((w, i) => {
      const p = squadTiles[i % squadTiles.length];
      this.units.push(
        makeUnit({
          faction: 'squad',
          x: p.x,
          y: p.y,
          name: w.name,
          hp: w.hp,
          maxHp: w.hp,
          mana: w.mana,
          maxMana: w.mana,
          move: w.move,
          spells: [...w.spells],
        }),
      );
    });

    // Quest NPCs (need fresh ids after squad — regenerate with same rng fork is
    // wrong; instead re-key them here).
    for (const npc of setup.npcs) {
      this.units.push({ ...npc, id: this.nextId() });
      if (npc.isTarget) {
        this.quest.targetUnitId = this.units[this.units.length - 1].id;
      }
    }

    // Guards on patrol.
    this.spawnPatrols(6);

    // Civilians + clue carriers.
    this.spawnCivilians(setup.clueCarriers);

    // Furniture: containers to loot for clues — and to hide bodies in.
    this.placeContainers();

    this.updateFov();
    bus.emit('questUpdated', { text: this.quest.briefing });
    bus.emit('log', { text: this.quest.briefing, kind: 'system' });
    bus.emit('candidatesNarrowed', { count: this.knowledge.candidates.size });
  }

  private idCounter = 1000;
  private nextId(): number {
    return this.idCounter++;
  }

  // ------------------------------------------------------------------ setup

  private pickDropPoint(): Pt {
    const W = this.grid.width;
    const tb = this.raster.buildings.find((b) => b.id === this.quest.targetBuilding)!;
    const roadTiles = this.raster.roadTiles.filter((t) => this.grid.terrain[t] === Terrain.Street);
    const pool = roadTiles.length > 0 ? roadTiles : this.allStreetTiles();
    let best: number = pool[0];
    let bestScore = -Infinity;
    const rng = this.rng.fork(2);
    for (let i = 0; i < 60; i++) {
      const t = pool[rng.int(0, pool.length - 1)];
      const x = t % W;
      const y = Math.floor(t / W);
      const edgeDist = Math.min(x, y, this.grid.width - x, this.grid.height - y);
      const targetDist = Math.abs(x - tb.centroid.x) + Math.abs(y - tb.centroid.y);
      const open = this.openTilesAround({ x, y }, 8).length;
      if (open < 6) continue;
      const score = targetDist - edgeDist * 0.5;
      if (score > bestScore) {
        bestScore = score;
        best = t;
      }
    }
    return { x: best % W, y: Math.floor(best / W) };
  }

  private allStreetTiles(): number[] {
    const out: number[] = [];
    for (let t = 0; t < this.grid.terrain.length; t++) {
      if (this.grid.terrain[t] === Terrain.Street) out.push(t);
    }
    return out;
  }

  private openTilesAround(p: Pt, count: number): Pt[] {
    const out: Pt[] = [];
    const occ = this.occupied();
    for (let r = 0; r <= 4 && out.length < count; r++) {
      for (let dy = -r; dy <= r && out.length < count; dy++) {
        for (let dx = -r; dx <= r && out.length < count; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = p.x + dx;
          const y = p.y + dy;
          const idx = y * this.grid.width + x;
          if (this.grid.walkable(x, y) && !occ.has(idx) && !out.some((o) => o.x === x && o.y === y)) {
            out.push({ x, y });
          }
        }
      }
    }
    return out.length > 0 ? out : [p];
  }

  private spawnPatrols(count: number): void {
    const rng = this.rng.fork(3);
    const W = this.grid.width;
    const roads = this.raster.roadTiles.filter((t) => this.grid.walkable(t % W, Math.floor(t / W)));
    if (roads.length === 0) return;
    for (let i = 0; i < count; i++) {
      const start = roads[rng.int(0, roads.length - 1)];
      const patrol: Pt[] = [];
      for (let k = 0; k < 3; k++) {
        const t = roads[rng.int(0, roads.length - 1)];
        patrol.push({ x: t % W, y: Math.floor(t / W) });
      }
      const p = { x: start % W, y: Math.floor(start / W) };
      const spot = this.openTilesAround(p, 1)[0];
      this.units.push(
        makeUnit({
          id: this.nextId(),
          faction: 'guard',
          x: spot.x,
          y: spot.y,
          name: 'City Guard',
          hp: 7,
          maxHp: 7,
          move: 5,
          aiState: 'patrol',
          patrol,
        }),
      );
    }
  }

  private spawnCivilians(carriers: { clue: import('./types').Clue; nearBuilding: number | null }[]): void {
    const rng = this.rng.fork(4);
    const W = this.grid.width;
    const streets = this.allStreetTiles();
    const tb = this.raster.buildings.find((b) => b.id === this.quest.targetBuilding)!;

    const placeCiv = (near: Pt | null, clue: import('./types').Clue | null): void => {
      let tile: number;
      if (near) {
        const nearby = streets.filter((t) => {
          const d = Math.abs((t % W) - near.x) + Math.abs(Math.floor(t / W) - near.y);
          return d > 4 && d < 22;
        });
        tile = nearby.length > 0 ? nearby[rng.int(0, nearby.length - 1)] : streets[rng.int(0, streets.length - 1)];
      } else {
        tile = streets[rng.int(0, streets.length - 1)];
      }
      const p = this.openTilesAround({ x: tile % W, y: Math.floor(tile / W) }, 1)[0];
      this.units.push(
        makeUnit({
          id: this.nextId(),
          faction: 'civilian',
          x: p.x,
          y: p.y,
          name: rng.pick(CIV_NAMES),
          hp: 3,
          maxHp: 3,
          move: 5,
          aiState: 'idle',
          clue,
        }),
      );
    };

    // Clue carriers: early clues near drop, late clues near the target.
    carriers.forEach((c, i) => {
      const frac = carriers.length <= 1 ? 0.5 : i / (carriers.length - 1);
      const near = c.nearBuilding !== null
        ? tb.centroid
        : {
            x: Math.round(this.dropPoint.x + (tb.centroid.x - this.dropPoint.x) * frac),
            y: Math.round(this.dropPoint.y + (tb.centroid.y - this.dropPoint.y) * frac),
          };
      placeCiv(near, c.clue);
    });

    // Background civilians.
    for (let i = 0; i < 18; i++) placeCiv(null, null);
  }

  /**
   * Chests/cupboards along interior walls: 1–3 per building, never where they
   * would seal a room off (verified by re-checking floor connectivity).
   */
  private placeContainers(): void {
    const rng = this.rng.fork(12);
    const grid = this.grid;
    const W = grid.width;
    const occ = this.occupied();
    for (const b of this.raster.buildings) {
      if (b.floorTiles.length < 8 || b.doorTiles.length === 0) continue;
      const want = b.sizeClass === 'large' ? 3 : b.sizeClass === 'medium' ? 2 : 1;
      const cands = b.floorTiles.filter((t) => {
        if (occ.has(t)) return false;
        let byWall = false;
        let byDoor = false;
        for (const step of [1, -1, W, -W]) {
          if (grid.terrain[t + step] === Terrain.Wall) byWall = true;
          if (grid.terrain[t + step] === Terrain.Door || grid.terrain[t + step] === Terrain.Window) byDoor = true;
        }
        return byWall && !byDoor;
      });
      rng.shuffle(cands);
      let placed = 0;
      for (const t of cands) {
        if (placed >= want) break;
        grid.terrain[t] = Terrain.Container;
        if (!this.buildingStillConnected(b)) {
          grid.terrain[t] = Terrain.Floor; // would have sealed a room — revert
          continue;
        }
        b.floorTiles = b.floorTiles.filter((f) => f !== t);
        const clue = rng.chance(0.3) ? rng.pick(this.quest.chain) : null;
        this.containers.set(t, { clue, searched: false, bodies: [] });
        placed++;
      }
    }
  }

  private buildingStillConnected(b: import('../map/rasterize').BuildingInfo): boolean {
    const grid = this.grid;
    const W = grid.width;
    const target = b.floorTiles.filter((t) => grid.terrain[t] === Terrain.Floor);
    if (target.length === 0) return true;
    const start = target[0];
    const seen = new Set<number>([start]);
    const q = [start];
    while (q.length) {
      const t = q.pop()!;
      for (const step of [1, -1, W, -W]) {
        const n = t + step;
        if (seen.has(n)) continue;
        const terr = grid.terrain[n];
        if ((terr === Terrain.Floor || terr === Terrain.Door) && grid.buildingId[n] === b.id) {
          seen.add(n);
          q.push(n);
        }
      }
    }
    return target.every((t) => seen.has(t));
  }

  private spawnReinforcements(level: number): void {
    if (this.phase === 'ended') return;
    const squad = this.squadUnits();
    if (squad.length === 0) return;
    const cx = Math.round(squad.reduce((s, u) => s + u.x, 0) / squad.length);
    const cy = Math.round(squad.reduce((s, u) => s + u.y, 0) / squad.length);
    const rng = this.rng.fork(100 + level);
    const W = this.grid.width;

    // entry point: street tile near map edge closest to squad
    const edgeTiles = this.allStreetTiles().filter((t) => {
      const x = t % W, y = Math.floor(t / W);
      return x < 3 || y < 3 || x > this.grid.width - 4 || y > this.grid.height - 4;
    });
    if (edgeTiles.length === 0) return;
    edgeTiles.sort((a, b) => {
      const da = Math.abs((a % W) - cx) + Math.abs(Math.floor(a / W) - cy);
      const db = Math.abs((b % W) - cx) + Math.abs(Math.floor(b / W) - cy);
      return da - db;
    });
    const entry = edgeTiles[rng.int(0, Math.min(10, edgeTiles.length - 1))];
    const ep = { x: entry % W, y: Math.floor(entry / W) };
    const spots = this.openTilesAround(ep, 4);

    if (level >= 4) {
      const p = spots[0];
      this.units.push(
        makeUnit({
          id: this.nextId(),
          faction: 'hostile',
          x: p.x, y: p.y,
          name: 'Rival Adept',
          hp: 10, maxHp: 10, mana: 20, maxMana: 20, move: 6,
          spells: ['firebolt', 'blink'],
          aiState: 'combat',
          lastKnownSquadPos: { x: cx, y: cy },
        }),
      );
      this.bus.emit('log', { text: 'A rival adept has taken the field.', kind: 'alarm' });
    }
    const guards = level >= 2 ? 2 : 1;
    for (let i = 0; i < guards; i++) {
      const p = spots[(i + 1) % spots.length];
      this.units.push(
        makeUnit({
          id: this.nextId(),
          faction: 'guard',
          x: p.x, y: p.y,
          name: 'Guard Reinforcement',
          hp: 7, maxHp: 7, move: 5,
          aiState: 'combat',
          lastKnownSquadPos: { x: cx, y: cy },
        }),
      );
    }
    this.bus.emit('log', { text: `Reinforcements converge on the district (alarm ${level}).`, kind: 'alarm' });
  }

  // ------------------------------------------------------------------ queries

  squadUnits(): Unit[] {
    return this.units.filter((u) => u.faction === 'squad' && u.alive && !u.subdued);
  }

  unitById(id: number): Unit | undefined {
    return this.units.find((u) => u.id === id);
  }

  unitAt(x: number, y: number): Unit | undefined {
    return this.units.find((u) => u.alive && u.carriedBy === null && u.x === x && u.y === y);
  }

  occupied(except?: Unit): Set<number> {
    const s = new Set<number>();
    for (const u of this.units) {
      if (!u.alive || u.carriedBy !== null || u === except) continue;
      s.add(u.y * this.grid.width + u.x);
    }
    return s;
  }

  isVisibleToSquad(u: Unit): boolean {
    return this.visible.has(u.y * this.grid.width + u.x);
  }

  targetUnit(): Unit {
    return this.unitById(this.quest.targetUnitId)!;
  }

  objectiveComplete(): boolean {
    const t = this.targetUnit();
    if (this.quest.kind === 'assassinate') return !t.alive;
    // extract: target subdued and inside the extraction zone (carried there or dropped there)
    if (!t.subdued || !t.alive) return false;
    const pos = t.carriedBy !== null ? this.unitById(t.carriedBy)! : t;
    return this.inExtractionZone(pos.x, pos.y);
  }

  inExtractionZone(x: number, y: number): boolean {
    return (
      Math.abs(x - this.dropPoint.x) <= this.extractionRadius &&
      Math.abs(y - this.dropPoint.y) <= this.extractionRadius
    );
  }

  updateFov(): void {
    this.visible = new Set();
    for (const u of this.squadUnits()) {
      const fov = computeFov(this.grid, u, 12);
      for (const t of fov) {
        this.visible.add(t);
        this.explored[t] = 1;
      }
    }
    this.bus.emit('fovChanged', {});
  }

  moveOptions(u: Unit): Map<number, number> {
    const budget = u.ap * this.effectiveMove(u);
    return reachable(this.grid, u, budget, this.occupied(u));
  }

  effectiveMove(u: Unit): number {
    return u.carrying !== null ? Math.max(2, Math.floor(u.move / 2)) : u.move;
  }

  // ------------------------------------------------------------------ actions

  tryMove(u: Unit, dest: Pt): boolean {
    if (this.phase !== 'player' || u.faction !== 'squad' || u.ap <= 0) return false;
    const occ = this.occupied(u);
    if (occ.has(dest.y * this.grid.width + dest.x)) return false;
    const path = findPath(this.grid, u, dest, { blocked: occ, maxCost: u.ap * this.effectiveMove(u) });
    if (!path || path.length === 0) return false;
    let cost = 0;
    let prev: Pt = u;
    for (const p of path) {
      cost += p.x !== prev.x && p.y !== prev.y ? 3 : 2;
      if (this.grid.get(p.x, p.y) === Terrain.Window) cost += WINDOW_CLIMB_COST;
      prev = p;
    }
    const apCost = Math.ceil(cost / (this.effectiveMove(u) * 2));
    if (apCost > u.ap) return false;
    u.ap -= apCost;
    u.x = dest.x;
    u.y = dest.y;
    u.overwatch = false;
    this.bus.emit('unitMoved', { unitId: u.id, path });
    this.traverseEffects(u, path);
    this.updateFov();
    this.afterPlayerAction();
    return true;
  }

  /**
   * Side effects of walking a path: doors swing open; INTACT windows shatter
   * loudly, while a window opened beforehand is climbed in silence.
   */
  traverseEffects(u: Unit, path: Pt[]): void {
    const opened: Pt[] = [];
    for (const p of path) {
      if (this.grid.openDoor(p.x, p.y)) opened.push(p);
      if (this.grid.openWindow(p.x, p.y)) {
        opened.push(p);
        this.bus.emit('windowSmashed', { x: p.x, y: p.y });
        if (u.faction === 'squad') {
          this.bus.emit('log', { text: `${u.name} smashes through the window – glass everywhere.`, kind: 'combat' });
          this.witnessNoise(u, p, 2);
        }
      }
    }
    if (opened.length > 0) {
      this.bus.emit('terrainChanged', { tiles: opened });
      this.updateFov(); // an opening door changes what everyone can see
    }
  }

  /**
   * Rally: every wizard with AP moves toward the clicked point at once,
   * forming up on the nearest open tiles (paths truncated to their AP budget).
   */
  rallyTo(dest: Pt): boolean {
    if (this.phase !== 'player') return false;
    if (!this.grid.walkable(dest.x, dest.y)) return false;
    const spots = this.openTilesAround(dest, 8);
    const claimed = new Set<number>();
    const wizards = this.squadUnits()
      .filter((u) => u.ap > 0)
      .sort((a, b) => Math.hypot(a.x - dest.x, a.y - dest.y) - Math.hypot(b.x - dest.x, b.y - dest.y));
    let moved = 0;
    for (const u of wizards) {
      const spot = spots.find(
        (s) => !claimed.has(s.y * this.grid.width + s.x) && !(s.x === u.x && s.y === u.y),
      );
      if (!spot) break;
      const occ = this.occupied(u);
      const path = findPath(this.grid, u, spot, { blocked: occ, maxCost: 70 });
      if (!path || path.length === 0) {
        claimed.add(spot.y * this.grid.width + spot.x);
        continue;
      }
      // walk the path as far as this wizard's AP allows, ending on a free tile
      const budget = u.ap * this.effectiveMove(u) * 2;
      let cost = 0;
      let endIdx = -1;
      let prev: Pt = u;
      for (let i = 0; i < path.length; i++) {
        const p = path[i];
        cost += p.x !== prev.x && p.y !== prev.y ? 3 : 2;
        if (this.grid.get(p.x, p.y) === Terrain.Window) cost += WINDOW_CLIMB_COST;
        if (cost > budget) break;
        if (!occ.has(p.y * this.grid.width + p.x)) endIdx = i;
        prev = p;
      }
      if (endIdx < 0) continue;
      const walked = path.slice(0, endIdx + 1);
      let usedCost = 0;
      prev = u;
      for (const p of walked) {
        usedCost += p.x !== prev.x && p.y !== prev.y ? 3 : 2;
        if (this.grid.get(p.x, p.y) === Terrain.Window) usedCost += WINDOW_CLIMB_COST;
        prev = p;
      }
      const end = walked[walked.length - 1];
      u.ap -= Math.min(u.ap, Math.ceil(usedCost / (this.effectiveMove(u) * 2)));
      u.x = end.x;
      u.y = end.y;
      u.overwatch = false;
      claimed.add(end.y * this.grid.width + end.x);
      claimed.add(spot.y * this.grid.width + spot.x);
      this.bus.emit('unitMoved', { unitId: u.id, path: walked });
      this.traverseEffects(u, walked);
      moved++;
    }
    if (moved > 0) {
      this.updateFov();
      this.afterPlayerAction();
    }
    return moved > 0;
  }

  /** Free action: ease open an adjacent closed door or unlatch an intact window. */
  openAdjacentPortal(u: Unit, tile: Pt): boolean {
    if (this.phase !== 'player' || u.faction !== 'squad' || !u.alive) return false;
    if (Math.max(Math.abs(tile.x - u.x), Math.abs(tile.y - u.y)) > 1) return false;
    if (this.grid.openDoor(tile.x, tile.y)) {
      this.bus.emit('log', { text: `${u.name} eases the door open.`, kind: 'info' });
    } else if (this.grid.openWindow(tile.x, tile.y)) {
      this.bus.emit('log', { text: `${u.name} unlatches the window without a sound.`, kind: 'info' });
    } else {
      return false;
    }
    this.bus.emit('terrainChanged', { tiles: [tile] });
    this.updateFov();
    this.afterPlayerAction();
    return true;
  }

  canCast(u: Unit, spellId: SpellId): string | null {
    const s = SPELLS[spellId];
    if (!u.spells.includes(spellId)) return 'unknown spell';
    if (u.ap < s.ap) return 'no AP';
    if (u.mana < s.mana) return 'no mana';
    if (u.carrying !== null) return 'carrying';
    return null;
  }

  castSpell(u: Unit, spellId: SpellId, target: Pt): boolean {
    if (this.phase !== 'player' || u.faction !== 'squad') return false;
    if (this.canCast(u, spellId) !== null) return false;
    const s = SPELLS[spellId];
    const dist = Math.hypot(target.x - u.x, target.y - u.y);
    if (s.range > 0 && dist > s.range) return false;
    const targetUnit = this.unitAt(target.x, target.y);

    if (s.needsLos && dist > 1.6) {
      // unit-targeted spells may be loosed from a step-out peek around cover
      const losOk = targetUnit
        ? this.attackOrigin(u, targetUnit) !== null
        : hasLos(this.grid, u, target);
      if (!losOk) return false;
    }

    let ok = false;
    switch (spellId) {
      case 'firebolt':
      case 'strike': {
        if (!targetUnit || targetUnit.faction === 'squad') return false;
        this.resolveAttack(u, targetUnit, s.minDmg!, s.maxDmg!, spellId);
        ok = true;
        break;
      }
      case 'sleep': {
        if (!targetUnit || targetUnit.faction === 'squad') return false;
        if (targetUnit.faction === 'civilian') {
          targetUnit.subdued = true;
          targetUnit.aiState = 'idle';
          this.bus.emit('unitSubdued', { unitId: targetUnit.id });
          this.bus.emit('log', { text: `${targetUnit.name} slumps, sound asleep.`, kind: 'combat' });
          if (targetUnit.isDecoy) this.bus.emit('log', { text: 'A lookalike. The real one is still out there – or in here.', kind: 'clue' });
        } else {
          targetUnit.sleepTurns = 3;
          this.bus.emit('log', { text: `${targetUnit.name} falls asleep (3 turns).`, kind: 'combat' });
        }
        ok = true;
        break;
      }
      case 'blink': {
        const idx = target.y * this.grid.width + target.x;
        if (!this.grid.walkable(target.x, target.y)) return false;
        if (this.occupied(u).has(idx)) return false;
        if (!this.explored[idx]) return false;
        u.x = target.x;
        u.y = target.y;
        this.bus.emit('unitMoved', { unitId: u.id, path: [target] });
        this.updateFov();
        ok = true;
        break;
      }
      case 'scry': {
        // reveal a wide circle as "explored" and narrow candidates by bearing
        const R = 14;
        for (let dy = -R; dy <= R; dy++) {
          for (let dx = -R; dx <= R; dx++) {
            if (dx * dx + dy * dy > R * R) continue;
            const x = u.x + dx;
            const y = u.y + dy;
            if (this.grid.inBounds(x, y)) this.explored[y * this.grid.width + x] = 1;
          }
        }
        const { bearing } = this.knowledge.applyScry(u);
        this.bus.emit('log', {
          text: `${u.name} scries: the quarry lies to the ${bearing}. The nearby streets etch themselves into memory.`,
          kind: 'clue',
        });
        this.bus.emit('fovChanged', {});
        ok = true;
        break;
      }
      case 'sunder': {
        const terr = this.grid.get(target.x, target.y);
        if (terr !== Terrain.Wall && terr !== Terrain.Window && terr !== Terrain.Door) return false;
        this.grid.set(target.x, target.y, Terrain.Floor);
        this.bus.emit('terrainChanged', { tiles: [target] });
        this.bus.emit('log', { text: 'The wall detonates inward – a new door where none was meant to be.', kind: 'combat' });
        this.updateFov();
        ok = true;
        break;
      }
      case 'suppress': {
        if (!targetUnit || targetUnit.faction === 'squad' || targetUnit.faction === 'civilian') return false;
        targetUnit.suppressedTurns = 2;
        this.bus.emit('log', { text: `${targetUnit.name} is pinned under a stream of sparks (−30 aim, half speed).`, kind: 'combat' });
        ok = true;
        break;
      }
      case 'stonewall': {
        const dx = target.x - u.x;
        const dy = target.y - u.y;
        // wall runs perpendicular to the cast direction
        const horizontal = Math.abs(dy) >= Math.abs(dx);
        const tiles: Pt[] = [];
        for (let k = -1; k <= 1; k++) {
          tiles.push(horizontal ? { x: target.x + k, y: target.y } : { x: target.x, y: target.y + k });
        }
        const occ = this.occupied();
        const placed: Pt[] = [];
        for (const t of tiles) {
          const idx = t.y * this.grid.width + t.x;
          if (!this.grid.inBounds(t.x, t.y)) continue;
          const terr = this.grid.get(t.x, t.y);
          if ((terr === Terrain.Street || terr === Terrain.Grass || terr === Terrain.Floor) && !occ.has(idx)) {
            this.grid.set(t.x, t.y, Terrain.Wall);
            placed.push(t);
          }
        }
        if (placed.length === 0) return false;
        this.bus.emit('terrainChanged', { tiles: placed });
        this.bus.emit('log', { text: 'Stone slabs erupt from the ground.', kind: 'combat' });
        this.updateFov();
        ok = true;
        break;
      }
      case 'charm': {
        if (!targetUnit || targetUnit.faction === 'squad') return false;
        if (targetUnit.faction === 'civilian') {
          this.extractClue(targetUnit, true);
        } else {
          targetUnit.charmedTurns = 2;
          this.bus.emit('log', { text: `${targetUnit.name}'s eyes glaze over. They forget you were here.`, kind: 'combat' });
        }
        ok = true;
        break;
      }
      case 'ward': {
        const ally = targetUnit && targetUnit.faction === 'squad' ? targetUnit : u;
        ally.wardHp = 4;
        this.bus.emit('log', { text: `A shimmering ward settles over ${ally.name}.`, kind: 'combat' });
        ok = true;
        break;
      }
      case 'counterspell': {
        u.overwatch = true;
        this.bus.emit('log', { text: `${u.name} holds a counterspell, watching.`, kind: 'combat' });
        ok = true;
        break;
      }
    }

    if (!ok) return false;
    u.mana -= s.mana;
    u.ap = s.endsTurn ? 0 : Math.max(0, u.ap - s.ap);
    this.bus.emit('spellCast', { casterId: u.id, spell: spellId, target });
    if (s.loud > 0) this.witnessNoise(u, target, s.loud);
    this.afterPlayerAction();
    return true;
  }

  /** Question an adjacent calm civilian (1 AP, silent). */
  question(u: Unit, civ: Unit): boolean {
    if (this.phase !== 'player' || u.ap < 1) return false;
    if (civ.faction !== 'civilian' || !civ.alive || civ.subdued) return false;
    if (Math.max(Math.abs(civ.x - u.x), Math.abs(civ.y - u.y)) > 1) return false;
    if (civ.aiState === 'flee') {
      this.bus.emit('log', { text: `${civ.name} is too panicked to talk. (Charm would work.)`, kind: 'info' });
      u.ap -= 1;
      this.afterPlayerAction();
      return true;
    }
    u.ap -= 1;
    this.extractClue(civ, false);
    this.afterPlayerAction();
    return true;
  }

  private extractClue(civ: Unit, charmed: boolean): void {
    if (civ.isTarget) {
      this.bus.emit('log', { text: `"${civ.name}"? They just smile thinly. Something is off about this one.`, kind: 'clue' });
      return;
    }
    if (civ.clue && !civ.questioned) {
      civ.questioned = true;
      const learned = this.knowledge.learnClue(civ.clue);
      const prefix = charmed ? `${civ.name} (charmed): ` : `${civ.name}: `;
      this.bus.emit('log', {
        text: prefix + `"${civ.clue.text}"` + (learned ? '' : ' (already known)'),
        kind: 'clue',
      });
    } else {
      civ.questioned = true;
      this.bus.emit('log', {
        text: `${civ.name} shrugs: "Never heard of them. Strange folk about tonight, though."`,
        kind: 'info',
      });
    }
  }

  /** Pick up an adjacent sleeping person or body (extraction, or hiding the evidence). */
  pickup(u: Unit, target: Unit): boolean {
    if (this.phase !== 'player' || u.ap < 1 || u.carrying !== null) return false;
    const carriable = ((target.subdued && target.alive) || !target.alive) && !target.stashed;
    if (!carriable || target.carriedBy !== null) return false;
    if (Math.max(Math.abs(target.x - u.x), Math.abs(target.y - u.y)) > 1) return false;
    u.ap -= 1;
    u.carrying = target.id;
    target.carriedBy = u.id;
    this.bus.emit('carryChanged', { carrierId: u.id, carrying: true });
    this.bus.emit('log', { text: `${u.name} hoists ${target.name} over a shoulder. Move is halved; no casting.`, kind: 'info' });
    this.afterPlayerAction();
    return true;
  }

  /** Slide a mirror under an adjacent closed door: glimpse the room beyond. Free. */
  peekDoor(u: Unit, tile: Pt): boolean {
    if (this.phase !== 'player' || u.faction !== 'squad' || !u.alive) return false;
    if (Math.max(Math.abs(tile.x - u.x), Math.abs(tile.y - u.y)) > 1) return false;
    if (this.grid.get(tile.x, tile.y) !== Terrain.Door || this.grid.isDoorOpen(tile.x, tile.y)) return false;
    const fov = computeFov(this.grid, tile, 9);
    let figures = 0;
    for (const t of fov) {
      this.explored[t] = 1;
      this.visible.add(t);
    }
    for (const n of this.units) {
      if (n.alive && n.faction !== 'squad' && n.carriedBy === null && !n.stashed &&
        fov.has(n.y * this.grid.width + n.x)) figures++;
    }
    this.bus.emit('fovChanged', {});
    this.bus.emit('log', {
      text: figures > 0
        ? `${u.name} slides a mirror under the door: ${figures} figure${figures > 1 ? 's' : ''} beyond.`
        : `${u.name} slides a mirror under the door: the room beyond looks empty.`,
      kind: 'clue',
    });
    return true;
  }

  /**
   * Coordinated breach: kick the door (1 AP) — every wizard stacked within 3
   * tiles who still has AP immediately unloads on the nearest visible hostile.
   */
  breach(u: Unit, tile: Pt): boolean {
    if (this.phase !== 'player' || u.faction !== 'squad' || !u.alive || u.ap < 1) return false;
    if (Math.max(Math.abs(tile.x - u.x), Math.abs(tile.y - u.y)) > 1) return false;
    if (!this.grid.openDoor(tile.x, tile.y)) return false;
    u.ap -= 1;
    this.bus.emit('terrainChanged', { tiles: [tile] });
    this.updateFov();
    this.bus.emit('log', { text: 'BREACH! The door slams open.', kind: 'combat' });
    for (const w of this.squadUnits()) {
      if (w.ap <= 0 || w.carrying !== null) continue;
      if (Math.max(Math.abs(w.x - tile.x), Math.abs(w.y - tile.y)) > 3) continue;
      const foes = this.units
        .filter((e) => e.alive && !e.subdued && (e.faction === 'guard' || e.faction === 'hostile'))
        .filter((e) => this.isVisibleToSquad(e) && this.hitChance(w, e) !== null)
        .sort((a, b) => Math.hypot(a.x - w.x, a.y - w.y) - Math.hypot(b.x - w.x, b.y - w.y));
      const foe = foes[0];
      if (!foe) continue;
      const dist = Math.hypot(foe.x - w.x, foe.y - w.y);
      if (w.spells.includes('firebolt') && w.mana >= SPELLS.firebolt.mana && dist <= SPELLS.firebolt.range) {
        this.castSpell(w, 'firebolt', { x: foe.x, y: foe.y });
      } else if (dist <= 1.6) {
        this.castSpell(w, 'strike', { x: foe.x, y: foe.y });
      }
    }
    this.afterPlayerAction();
    return true;
  }

  /** Rifle an adjacent chest/cupboard (1 AP): sometimes it holds intel. */
  searchContainer(u: Unit, tile: Pt): boolean {
    if (this.phase !== 'player' || u.faction !== 'squad' || !u.alive || u.ap < 1) return false;
    if (Math.max(Math.abs(tile.x - u.x), Math.abs(tile.y - u.y)) > 1) return false;
    const c = this.containers.get(tile.y * this.grid.width + tile.x);
    if (!c) return false;
    if (c.searched) {
      this.bus.emit('log', { text: 'Already rifled through – nothing new.', kind: 'info' });
      return false;
    }
    u.ap -= 1;
    c.searched = true;
    if (c.clue) {
      const learned = this.knowledge.learnClue(c.clue);
      this.bus.emit('log', {
        text: `Among the linens, a letter: "${c.clue.text}"${learned ? '' : ' (already known)'}`,
        kind: 'clue',
      });
    } else {
      this.bus.emit('log', { text: `${u.name} rifles the chest: moth-eaten robes and old crockery.`, kind: 'info' });
    }
    this.afterPlayerAction();
    return true;
  }

  /** Fold a carried body into an adjacent container (1 AP): out of sight, out of the alarm. */
  stashBody(u: Unit, tile: Pt): boolean {
    if (this.phase !== 'player' || u.faction !== 'squad' || !u.alive || u.ap < 1) return false;
    if (u.carrying === null) return false;
    if (Math.max(Math.abs(tile.x - u.x), Math.abs(tile.y - u.y)) > 1) return false;
    const c = this.containers.get(tile.y * this.grid.width + tile.x);
    if (!c) return false;
    const body = this.unitById(u.carrying)!;
    if (body.isTarget && this.quest.kind === 'extract') {
      this.bus.emit('log', { text: 'That one goes home with you, not into a cupboard.', kind: 'info' });
      return false;
    }
    u.ap -= 1;
    body.stashed = true;
    body.carriedBy = null;
    body.x = tile.x;
    body.y = tile.y;
    u.carrying = null;
    c.bodies.push(body.id);
    this.bus.emit('carryChanged', { carrierId: u.id, carrying: false });
    this.bus.emit('log', { text: `${u.name} folds ${body.name} into the ${c.bodies.length > 1 ? 'increasingly crowded ' : ''}chest.`, kind: 'info' });
    this.afterPlayerAction();
    return true;
  }

  dropCarried(u: Unit): boolean {
    if (u.carrying === null) return false;
    const t = this.unitById(u.carrying)!;
    const spot = this.openTilesAround(u, 2).find((p) => !(p.x === u.x && p.y === u.y)) ?? u;
    t.x = spot.x;
    t.y = spot.y;
    t.carriedBy = null;
    u.carrying = null;
    this.bus.emit('carryChanged', { carrierId: u.id, carrying: false });
    this.afterPlayerAction();
    return true;
  }

  endTurn(): void {
    if (this.phase !== 'player') return;
    this.phase = 'npc';
    this.bus.emit('turnStarted', { faction: 'npc', turn: this.turn });
    runNpcPhase(this);
    if ((this.phase as Phase) === 'ended') return;
    // upkeep
    for (const u of this.units) {
      if (!u.alive) continue;
      if (u.suppressedTurns > 0) u.suppressedTurns--;
      if (u.faction === 'squad') {
        u.ap = 2;
        u.mana = Math.min(u.maxMana, u.mana + 1);
        u.overwatch = u.overwatch && true; // persists until they act
      } else {
        if (u.sleepTurns > 0) u.sleepTurns--;
        if (u.charmedTurns > 0) u.charmedTurns--;
      }
    }
    this.turn++;
    this.phase = 'player';
    this.bus.emit('turnStarted', { faction: 'player', turn: this.turn });
    this.checkEnd();
  }

  // ------------------------------------------------------------------ combat

  /**
   * Where an attack from `u` against `target` is actually loosed from: the
   * caster's own tile, or a step-out "peek" around their cover — an adjacent
   * free tile with a sight line. Null = no clear shot at all.
   */
  attackOrigin(u: Pt, target: Pt): Pt | null {
    if (hasLos(this.grid, u, target)) return { x: u.x, y: u.y };
    const occ = this.occupied(this.unitAt(u.x, u.y));
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = u.x + dx;
      const ny = u.y + dy;
      if (!this.grid.walkable(nx, ny)) continue;
      if (occ.has(ny * this.grid.width + nx)) continue;
      if (hasLos(this.grid, { x: nx, y: ny }, target)) return { x: nx, y: ny };
    }
    return null;
  }

  /** Preview/resolve numbers for an attack; null when there is no sight line. */
  hitChance(
    attacker: Unit,
    defender: Unit,
  ): { chance: number; cover: CoverLevel; origin: Pt } | null {
    const origin = this.attackOrigin(attacker, defender);
    if (!origin) return null;
    if (defender.sleepTurns > 0 || defender.subdued) return { chance: 100, cover: 0, origin };
    const cover = this.grid.coverFrom(defender.x, defender.y, origin.x, origin.y);
    let chance = Math.max(20, Math.min(95, 85 - COVER_PENALTY[cover]));
    if (attacker.suppressedTurns > 0) chance = Math.max(5, chance - 30);
    return { chance, cover, origin };
  }

  resolveAttack(attacker: Unit, defender: Unit, minDmg: number, maxDmg: number, spell: string): void {
    const hc = this.hitChance(attacker, defender);
    const chance = hc ? hc.chance : 50; // blind shot fallback; AI checks first
    const roll = this.rng.int(1, 100);
    const hit = roll <= chance;
    let dmg = 0;
    if (hit) {
      dmg = this.rng.int(minDmg, maxDmg);
      this.applyDamage(defender, dmg, attacker);
    }
    this.bus.emit('attackResolved', {
      attackerId: attacker.id, targetId: defender.id, hit, damage: dmg, chance,
    });
    if (!hit) {
      this.bus.emit('log', { text: `${attacker.name}'s ${spell} misses ${defender.name} (${chance}%).`, kind: 'combat' });
    }
  }

  applyDamage(u: Unit, amount: number, source: Unit | null): void {
    let dmg = amount;
    if (u.wardHp > 0) {
      const absorbed = Math.min(u.wardHp, dmg);
      u.wardHp -= absorbed;
      dmg -= absorbed;
    }
    u.hp -= dmg;
    this.bus.emit('unitDamaged', { unitId: u.id, amount: dmg, hp: u.hp });
    this.bus.emit('log', {
      text: `${source ? source.name + ' hits ' : ''}${u.name} for ${dmg}.${u.wardHp > 0 ? ' (warded)' : ''}`,
      kind: 'combat',
    });
    if (u.hp <= 0) {
      u.alive = false;
      if (u.carrying !== null) {
        const carried = this.unitById(u.carrying);
        if (carried) {
          carried.carriedBy = null;
          carried.x = u.x;
          carried.y = u.y;
        }
        u.carrying = null;
      }
      this.bus.emit('unitDied', { unitId: u.id });
      this.bus.emit('log', { text: `${u.name} is down.`, kind: 'combat' });
      if (u.isDecoy && source?.faction === 'squad') {
        this.alarm.add(6, 'an innocent lookalike murdered');
        this.bus.emit('log', { text: 'That was a lookalike. The city will not forgive this quietly.', kind: 'alarm' });
      }
      if (u.faction === 'civilian' && !u.isTarget && source?.faction === 'squad') {
        this.civiliansKilled++;
        if (!u.isDecoy) this.alarm.add(4, 'a civilian killed');
      }
      // witnesses see the body drop
      if (source?.faction === 'squad') this.witnessNoise(source, u, 2);
      this.checkEnd();
    }
  }

  /** NPCs near a loud event: guards engage, civilians flee & report. */
  witnessNoise(caster: Unit, at: Pt, points: number): void {
    this.lastCommotion = { x: at.x, y: at.y };
    this.commotionSeq++;
    // how far the sound carries (the ring the player sees)
    this.bus.emit('noiseMade', { x: at.x, y: at.y, radius: 11, points });
    let witnessed = false;
    for (const npc of this.units) {
      if (!npc.alive || npc.faction === 'squad' || npc.subdued || npc.sleepTurns > 0) continue;
      const d = Math.hypot(npc.x - at.x, npc.y - at.y);
      if (d > 11) continue;
      const saw = hasLos(this.grid, npc, at);
      if (!saw && d > 8) continue; // walls muffle, but not much
      witnessed = true;
      if (npc.faction === 'hostile') {
        // professionals: any disturbance and the blades come out
        if (npc.charmedTurns <= 0) {
          npc.aiState = 'combat';
          npc.lastKnownSquadPos = { x: caster.x, y: caster.y };
        }
      } else if (npc.faction === 'guard') {
        if (npc.charmedTurns > 0) continue;
        if (saw) {
          npc.aiState = 'combat';
          npc.lastKnownSquadPos = { x: caster.x, y: caster.y };
        } else if (npc.aiState !== 'combat') {
          // heard something through a wall: investigate, don't shoot yet
          npc.aiState = 'suspicious';
          npc.lastKnownSquadPos = { x: at.x, y: at.y };
        }
      } else if (npc.faction === 'civilian' && !npc.isTarget) {
        npc.aiState = 'flee';
        npc.lastKnownSquadPos = { x: at.x, y: at.y };
        if (!npc.reportedCrime) {
          npc.reportedCrime = true;
          this.alarm.add(1, 'a witness raises the cry');
        }
      } else if (npc.isTarget) {
        npc.aiState = 'flee';
        npc.lastKnownSquadPos = { x: at.x, y: at.y };
      }
    }
    if (witnessed) this.alarm.add(points, 'loud magic in the streets');
  }

  // ------------------------------------------------------------------ end conditions

  afterPlayerAction(): void {
    this.checkEnd();
  }

  checkEnd(): void {
    if (this.phase === 'ended') return;
    const squad = this.squadUnits();
    if (squad.length === 0) {
      this.finish(false, 'The squad is wiped out. The city keeps its secrets.');
      return;
    }
    const t = this.targetUnit();
    if (this.quest.kind === 'extract' && !t.alive) {
      this.finish(false, `${this.quest.targetName} is dead – the extraction contract is void.`);
      return;
    }
    if (!this.regroupAnnounced) {
      const done =
        this.quest.kind === 'assassinate' ? !t.alive : t.subdued && t.alive;
      if (done) {
        this.regroupAnnounced = true;
        this.bus.emit('log', {
          text:
            this.quest.kind === 'assassinate'
              ? 'The contract is fulfilled – regroup at the anchor stone (blue circle).'
              : `You have ${this.quest.targetName} – carry them to the anchor stone (blue circle).`,
          kind: 'system',
        });
      }
    }
    if (this.objectiveComplete()) {
      const allHome = squad.every((u) => this.inExtractionZone(u.x, u.y));
      if (allHome) {
        this.finish(true, this.quest.kind === 'assassinate'
          ? `${this.quest.targetName} is dealt with. The portal takes you home.`
          : `${this.quest.targetName} is delivered, still snoring. Contract complete.`);
      }
    }
  }

  private finish(victory: boolean, summary: string): void {
    this.phase = 'ended';
    this.victory = victory;
    let verdict = '';
    if (victory) {
      const v =
        this.civiliansKilled === 0 && this.alarm.level <= 1 ? 'Ghost – the city never knew you were there.'
        : this.civiliansKilled === 0 ? 'Clean hands, loud exit.'
        : this.civiliansKilled <= 1 ? 'Collateral. The guild will dock your fee.'
        : 'Butcher. Expect no more contracts here.';
      verdict = ` Verdict: ${v}`;
    }
    this.bus.emit('missionEnded', { victory, summary: summary + verdict });
  }
}

const CIV_NAMES = [
  'Marla', 'Old Tobb', 'Fenwick', 'Grieta', 'Sallow Jon', 'Petra', 'Dunny', 'Iska',
  'Mother Hebb', 'Corvin', 'Lame Ezzie', 'Tamsin', 'Brick', 'Ulla', 'Weaver Tom', 'Nissa',
];
