/** NPC turn logic: guards, bodyguards, the rival adept, civilians, the target. */
import type { Pt } from '../core/grid';
import { hasLos } from '../core/fov';
import { findPath, reachable } from '../core/pathfind';
import type { MissionState } from './game';
import type { Unit } from './types';
import { SPELLS } from './spells';

const GUARD_SIGHT = 9;
const GUARD_RANGE = 8;

export function runNpcPhase(state: MissionState): void {
  for (const u of [...state.units]) {
    if (state.phase === 'ended') return;
    if (!u.alive || u.faction === 'squad' || u.subdued || u.carriedBy !== null) continue;
    if (u.sleepTurns > 0) continue;

    if (u.isTarget) {
      actTarget(state, u);
    } else if (u.faction === 'civilian') {
      actCivilian(state, u);
    } else if (u.charmedTurns > 0) {
      continue; // charmed: stands down entirely
    } else if (u.faction === 'guard') {
      actGuard(state, u);
    } else if (u.faction === 'hostile') {
      actHostile(state, u);
    }
  }
}

function nearestVisibleSquad(state: MissionState, u: Unit, range: number): Unit | null {
  let best: Unit | null = null;
  let bestD = Infinity;
  for (const s of state.squadUnits()) {
    const d = Math.hypot(s.x - u.x, s.y - u.y);
    if (d <= range && d < bestD && hasLos(state.grid, u, s)) {
      best = s;
      bestD = d;
    }
  }
  return best;
}

/** Move along a path one step at a time; squad overwatch may interrupt. Returns true if interrupted. */
function stepPath(state: MissionState, u: Unit, path: Pt[], maxSteps: number): boolean {
  let steps = 0;
  let interrupted = false;
  for (const p of path) {
    if (steps >= maxSteps) break;
    u.x = p.x;
    u.y = p.y;
    steps++;
    if (checkOverwatch(state, u)) {
      interrupted = true;
      break;
    }
  }
  if (steps > 0) {
    const walked = path.slice(0, steps);
    state.bus.emit('unitMoved', { unitId: u.id, path: walked });
    state.traverseEffects(u, walked); // NPCs shove doors open as they chase
  }
  return interrupted;
}

/** Guards notice unhidden corpses and wizards hauling bodies through the streets. */
function spotEvidence(state: MissionState, u: Unit, seen: Unit | null): void {
  // a wizard carrying a limp body is not a subtle sight
  if (seen && seen.carrying !== null && !u.reportedCrime) {
    u.reportedCrime = true;
    state.alarm.add(2, 'a body being carried through the streets');
    state.bus.emit('log', { text: `${u.name}: "What in the hells are they carrying?!"`, kind: 'alarm' });
    if (state.alarm.level >= 1) {
      u.aiState = 'combat';
      u.lastKnownSquadPos = { x: seen.x, y: seen.y };
    }
  }
  // corpses left in the open
  for (const d of state.units) {
    if (d.alive || d.stashed || d.carriedBy !== null || d.reportedCrime) continue;
    if (d.faction === 'squad') continue; // fallen wizards worry no one but you
    const dist = Math.hypot(d.x - u.x, d.y - u.y);
    if (dist > 7 || !hasLos(state.grid, u, d)) continue;
    d.reportedCrime = true;
    state.alarm.add(2, 'a body discovered');
    state.bus.emit('log', { text: `${u.name} finds ${d.name} dead. The cry goes up.`, kind: 'alarm' });
    if (u.aiState !== 'combat') {
      u.aiState = 'suspicious';
      u.lastKnownSquadPos = { x: d.x, y: d.y };
    }
  }
}

/** With no target in sight and a cold trail, investigate the latest commotion once. */
function adoptCommotion(state: MissionState, u: Unit): void {
  if (u.lastKnownSquadPos || !state.lastCommotion) return;
  if (u.commotionSeq >= state.commotionSeq) return;
  const d = Math.hypot(state.lastCommotion.x - u.x, state.lastCommotion.y - u.y);
  if (d > 30) return;
  u.commotionSeq = state.commotionSeq;
  u.lastKnownSquadPos = { ...state.lastCommotion };
}

function checkOverwatch(state: MissionState, npc: Unit): boolean {
  if (npc.faction === 'civilian') return false;
  for (const w of state.squadUnits()) {
    if (!w.overwatch) continue;
    const d = Math.hypot(w.x - npc.x, w.y - npc.y);
    if (d <= SPELLS.counterspell.range && hasLos(state.grid, w, npc)) {
      w.overwatch = false;
      state.bus.emit('reactionTriggered', { unitId: w.id, targetId: npc.id });
      state.bus.emit('log', { text: `${w.name}'s counterspell lashes out at ${npc.name}!`, kind: 'combat' });
      state.resolveAttack(w, npc, SPELLS.counterspell.minDmg!, SPELLS.counterspell.maxDmg!, 'counterspell');
      return true;
    }
  }
  return false;
}

/**
 * Best tile (within one move) to shoot `target` from: needs a sight line and
 * range, prefers cover facing the target, mild preference for keeping distance.
 * Returns the current tile when standing pat is already best.
 */
function chooseAttackTile(state: MissionState, u: Unit, target: Unit, range: number): Pt | null {
  const grid = state.grid;
  const score = (x: number, y: number): number => {
    const d = Math.hypot(target.x - x, target.y - y);
    if (d > range || d < 1) return -1000 + Math.max(0, 40 - d); // still walk closer
    if (!hasLos(grid, { x, y }, target)) return -500;
    return 20 + grid.coverFrom(x, y, target.x, target.y) * 6 + d * 0.3;
  };
  const mv = u.suppressedTurns > 0 ? Math.max(2, Math.ceil(u.move / 2)) : u.move;
  let best: Pt = { x: u.x, y: u.y };
  let bestScore = score(u.x, u.y) + 1.5; // inertia: don't shuffle for a wash
  for (const [idx] of reachable(grid, u, mv, state.occupied(u))) {
    const x = idx % grid.width;
    const y = Math.floor(idx / grid.width);
    const s = score(x, y);
    if (s > bestScore) {
      bestScore = s;
      best = { x, y };
    }
  }
  return best;
}

function moveTowards(state: MissionState, u: Unit, dest: Pt, tiles: number): boolean {
  const occ = state.occupied(u);
  // path to dest or nearest open neighbor
  let path = findPath(state.grid, u, dest, { blocked: occ, maxCost: 60 });
  if (!path) {
    // try neighbors of dest
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const alt = { x: dest.x + dx, y: dest.y + dy };
      if (!state.grid.walkable(alt.x, alt.y)) continue;
      path = findPath(state.grid, u, alt, { blocked: occ, maxCost: 60 });
      if (path) break;
    }
  }
  if (!path || path.length === 0) return false;
  return stepPath(state, u, path, tiles);
}

function actGuard(state: MissionState, u: Unit): void {
  const seen = nearestVisibleSquad(state, u, GUARD_SIGHT);
  const mv = u.suppressedTurns > 0 ? Math.max(2, Math.ceil(u.move / 2)) : u.move;

  // any guard may stumble on the evidence: unhidden bodies, or a wizard hauling one
  spotEvidence(state, u, seen);

  if (u.aiState !== 'combat') {
    // peaceful: only turns hostile once the alarm is up and they spot the squad
    if (seen && state.alarm.level >= 1) {
      u.aiState = 'combat';
      u.lastKnownSquadPos = { x: seen.x, y: seen.y };
      state.bus.emit('log', { text: `${u.name} levels a crossbow: "There! The outlanders!"`, kind: 'alarm' });
    } else if (u.aiState === 'suspicious') {
      // heard something: walk to the noise, poke around, then shrug it off
      const lk = u.lastKnownSquadPos;
      if (!lk || Math.abs(lk.x - u.x) + Math.abs(lk.y - u.y) <= 1) {
        u.lastKnownSquadPos = null;
        u.aiState = u.patrol.length > 0 ? 'patrol' : 'idle';
      } else {
        moveTowards(state, u, lk, mv);
      }
      return;
    } else {
      // patrol
      if (u.patrol.length > 0) {
        const wp = u.patrol[u.patrolIdx % u.patrol.length];
        if (Math.abs(wp.x - u.x) + Math.abs(wp.y - u.y) <= 2) {
          u.patrolIdx++;
        } else {
          moveTowards(state, u, wp, mv);
        }
      }
      return;
    }
  }

  // combat
  const target = seen ?? nearestVisibleSquad(state, u, GUARD_SIGHT + 3);
  if (target) {
    u.lastKnownSquadPos = { x: target.x, y: target.y };
    const d = Math.hypot(target.x - u.x, target.y - u.y);
    if (d <= 1.6) {
      if (!checkOverwatch(state, u)) state.resolveAttack(u, target, 2, 4, 'sword');
      return;
    }
    // seek a firing position with cover before shooting
    const spot = chooseAttackTile(state, u, target, GUARD_RANGE);
    if (spot && (spot.x !== u.x || spot.y !== u.y)) {
      const path = findPath(state.grid, u, spot, { blocked: state.occupied(u), maxCost: mv + 2 });
      if (path && stepPath(state, u, path, mv)) return; // overwatch interrupt
      if (state.phase === 'ended') return;
    }
    const d2 = Math.hypot(target.x - u.x, target.y - u.y);
    if (d2 <= GUARD_RANGE && state.attackOrigin(u, target)) {
      if (!checkOverwatch(state, u)) state.resolveAttack(u, target, 2, 3, 'crossbow');
    }
    return;
  }
  // lost them: chase the last known position, then the latest commotion
  adoptCommotion(state, u);
  if (u.lastKnownSquadPos) {
    const lk = u.lastKnownSquadPos;
    if (Math.abs(lk.x - u.x) + Math.abs(lk.y - u.y) <= 1) {
      u.lastKnownSquadPos = null;
      adoptCommotion(state, u);
      if (!u.lastKnownSquadPos) u.aiState = u.patrol.length > 0 ? 'patrol' : 'idle';
    } else {
      moveTowards(state, u, lk, u.move);
    }
  }
}

function actHostile(state: MissionState, u: Unit): void {
  const sight = u.name === 'Rival Adept' ? 11 : GUARD_SIGHT;
  const seen = nearestVisibleSquad(state, u, sight);
  if (u.aiState !== 'combat') {
    if (seen) {
      u.aiState = 'combat';
      u.lastKnownSquadPos = { x: seen.x, y: seen.y };
      state.bus.emit('log', { text: `${u.name} draws steel!`, kind: 'alarm' });
    } else {
      return; // stands watch
    }
  }

  const target = seen;
  if (u.name === 'Rival Adept') {
    if (target) {
      u.lastKnownSquadPos = { x: target.x, y: target.y };
      // low hp: blink away
      if (u.hp <= 4 && u.mana >= 3) {
        const away = {
          x: Math.max(1, Math.min(state.grid.width - 2, u.x + Math.sign(u.x - target.x) * 6)),
          y: Math.max(1, Math.min(state.grid.height - 2, u.y + Math.sign(u.y - target.y) * 6)),
        };
        if (state.grid.walkable(away.x, away.y) && !state.occupied(u).has(away.y * state.grid.width + away.x)) {
          u.mana -= 3;
          u.x = away.x;
          u.y = away.y;
          state.bus.emit('unitMoved', { unitId: u.id, path: [away] });
          return;
        }
      }
      const d = Math.hypot(target.x - u.x, target.y - u.y);
      if (d <= 10 && u.mana >= 2 && state.attackOrigin(u, target)) {
        if (!checkOverwatch(state, u)) {
          u.mana -= 2;
          state.resolveAttack(u, target, 3, 4, 'firebolt');
          state.bus.emit('spellCast', { casterId: u.id, spell: 'firebolt', target: { x: target.x, y: target.y } });
        }
        return;
      }
    }
    if (u.lastKnownSquadPos) moveTowards(state, u, u.lastKnownSquadPos, u.move);
    return;
  }

  // bodyguard: rush to melee
  const mv = u.suppressedTurns > 0 ? Math.max(2, Math.ceil(u.move / 2)) : u.move;
  if (target) {
    u.lastKnownSquadPos = { x: target.x, y: target.y };
    const d = Math.hypot(target.x - u.x, target.y - u.y);
    if (d <= 1.6) {
      if (!checkOverwatch(state, u)) state.resolveAttack(u, target, 2, 4, 'blade');
      return;
    }
    const interrupted = moveTowards(state, u, target, mv + 2);
    if (interrupted || state.phase === 'ended') return;
    if (Math.hypot(target.x - u.x, target.y - u.y) <= 1.6) {
      state.resolveAttack(u, target, 2, 4, 'blade');
    }
  } else {
    // hunt: last known position first, then the latest commotion,
    // and failing that fall back to guarding the doorway of home
    adoptCommotion(state, u);
    if (u.lastKnownSquadPos) {
      const lk = u.lastKnownSquadPos;
      if (Math.abs(lk.x - u.x) + Math.abs(lk.y - u.y) <= 1) u.lastKnownSquadPos = null;
      else moveTowards(state, u, lk, mv);
    } else if (u.homeBuilding !== null) {
      const b = state.raster.buildings.find((bb) => bb.id === u.homeBuilding);
      const door = b?.doorTiles[0];
      if (door !== undefined) {
        const W = state.grid.width;
        const dp = { x: door % W, y: Math.floor(door / W) };
        if (Math.abs(dp.x - u.x) + Math.abs(dp.y - u.y) > 1) moveTowards(state, u, dp, mv);
      }
    }
  }
}

function actCivilian(state: MissionState, u: Unit): void {
  if (u.aiState === 'flee' && u.lastKnownSquadPos) {
    const threat = u.lastKnownSquadPos;
    const d = Math.hypot(threat.x - u.x, threat.y - u.y);
    if (d > 16) {
      u.aiState = 'idle';
      u.lastKnownSquadPos = null;
      return;
    }
    // run directly away
    const dest = {
      x: Math.max(1, Math.min(state.grid.width - 2, Math.round(u.x + ((u.x - threat.x) / (d || 1)) * 8))),
      y: Math.max(1, Math.min(state.grid.height - 2, Math.round(u.y + ((u.y - threat.y) / (d || 1)) * 8))),
    };
    moveTowards(state, u, dest, u.move * 2);
    return;
  }
  // idle wander
  const rng = state.rng;
  if (rng.chance(0.35)) {
    const dest = { x: u.x + rng.int(-3, 3), y: u.y + rng.int(-3, 3) };
    if (state.grid.walkable(dest.x, dest.y)) moveTowards(state, u, dest, 3);
  }
}

/** The quest target: hides in the deepest part of home; flees within the building. */
function actTarget(state: MissionState, u: Unit): void {
  if (u.aiState !== 'flee') return; // calm: stays put
  const threat = u.lastKnownSquadPos;
  if (!threat || u.homeBuilding === null) return;
  const b = state.raster.buildings.find((bb) => bb.id === u.homeBuilding);
  if (!b) return;
  // farthest floor tile of home building from the threat
  const W = state.grid.width;
  let best: Pt | null = null;
  let bestD = -1;
  const occ = state.occupied(u);
  for (const t of b.floorTiles) {
    if (occ.has(t)) continue;
    const x = t % W;
    const y = Math.floor(t / W);
    const d = Math.abs(x - threat.x) + Math.abs(y - threat.y);
    if (d > bestD) {
      bestD = d;
      best = { x, y };
    }
  }
  if (best && (best.x !== u.x || best.y !== u.y)) {
    moveTowards(state, u, best, u.move);
  }
}
