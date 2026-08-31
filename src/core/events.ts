/** Minimal typed event bus decoupling the headless sim from rendering/UI. */

import type { Pt } from './grid';

export interface SimEvents {
  unitMoved: { unitId: number; path: Pt[] };
  unitDamaged: { unitId: number; amount: number; hp: number };
  unitDied: { unitId: number };
  unitSubdued: { unitId: number };
  spellCast: { casterId: number; spell: string; target: Pt };
  spellMissed: { casterId: number; spell: string; target: Pt };
  attackResolved: { attackerId: number; targetId: number; hit: boolean; damage: number; chance: number };
  alarmChanged: { level: number; reason: string };
  clueFound: { text: string; source: string };
  candidatesNarrowed: { count: number };
  turnStarted: { faction: string; turn: number };
  fovChanged: Record<string, never>;
  terrainChanged: { tiles: Pt[] };
  windowSmashed: { x: number; y: number };
  noiseMade: { x: number; y: number; radius: number; points: number };
  questUpdated: { text: string };
  missionEnded: { victory: boolean; summary: string };
  log: { text: string; kind?: 'info' | 'combat' | 'clue' | 'alarm' | 'system' };
  reactionTriggered: { unitId: number; targetId: number };
  unitSpotted: { unitId: number };
  carryChanged: { carrierId: number; carrying: boolean };
}

type Handler<T> = (payload: T) => void;

export class EventBus {
  private handlers = new Map<keyof SimEvents, Set<Handler<unknown>>>();

  on<K extends keyof SimEvents>(event: K, fn: Handler<SimEvents[K]>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(fn as Handler<unknown>);
    return () => set!.delete(fn as Handler<unknown>);
  }

  emit<K extends keyof SimEvents>(event: K, payload: SimEvents[K]): void {
    const set = this.handlers.get(event);
    if (set) for (const fn of set) fn(payload);
  }
}
