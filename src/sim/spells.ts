import type { SpellId } from './types';

export interface SpellDef {
  id: SpellId;
  name: string;
  desc: string;
  mana: number;
  /** AP cost; a spell with endsTurn consumes all remaining AP. */
  ap: number;
  endsTurn: boolean;
  range: number;
  needsLos: boolean;
  /** Alarm points generated when cast (0 = silent). */
  loud: number;
  minDmg?: number;
  maxDmg?: number;
  /** Valid target: tile or unit category. */
  target: 'enemy' | 'unit' | 'ally' | 'tile' | 'self' | 'civilian';
  icon: string;
}

export const SPELLS: Record<SpellId, SpellDef> = {
  firebolt: {
    id: 'firebolt', name: 'Firebolt', icon: '🔥',
    desc: 'Hurl fire at a foe. Loud.',
    mana: 2, ap: 1, endsTurn: true, range: 12, needsLos: true, loud: 3,
    minDmg: 3, maxDmg: 5, target: 'enemy',
  },
  strike: {
    id: 'strike', name: 'Staff Strike', icon: '🪄',
    desc: 'Quiet melee blow with the staff.',
    mana: 0, ap: 1, endsTurn: true, range: 1.5, needsLos: true, loud: 0,
    minDmg: 2, maxDmg: 3, target: 'unit',
  },
  sleep: {
    id: 'sleep', name: 'Sleep', icon: '💤',
    desc: 'Knock a nearby person out cold. Silent. Subdues quest targets for carrying.',
    mana: 3, ap: 1, endsTurn: true, range: 6, needsLos: true, loud: 0,
    target: 'unit',
  },
  blink: {
    id: 'blink', name: 'Blink', icon: '✨',
    desc: 'Teleport to a tile you can see or have explored.',
    mana: 3, ap: 1, endsTurn: false, range: 8, needsLos: false, loud: 0,
    target: 'tile',
  },
  scry: {
    id: 'scry', name: 'Scry', icon: '🔮',
    desc: 'Reveal the city around you and divine the bearing of your quarry. Costly.',
    mana: 6, ap: 2, endsTurn: true, range: 0, needsLos: false, loud: 0,
    target: 'self',
  },
  sunder: {
    id: 'sunder', name: 'Sunder', icon: '💥',
    desc: 'Blow open an adjacent wall, window, or door. Pick your own entry point. Very loud.',
    mana: 5, ap: 1, endsTurn: true, range: 1.5, needsLos: false, loud: 4,
    target: 'tile',
  },
  suppress: {
    id: 'suppress', name: 'Suppress', icon: '🎯',
    desc: 'Pin a foe under a stream of sparks: −30 to their aim, half speed, for 2 turns. Loud.',
    mana: 2, ap: 1, endsTurn: true, range: 12, needsLos: true, loud: 2,
    target: 'enemy',
  },
  stonewall: {
    id: 'stonewall', name: 'Stone Wall', icon: '🧱',
    desc: 'Raise a wall of three stone slabs across open ground.',
    mana: 4, ap: 1, endsTurn: true, range: 6, needsLos: true, loud: 1,
    target: 'tile',
  },
  charm: {
    id: 'charm', name: 'Charm', icon: '💫',
    desc: 'Civilians divulge what they know; guards stand down for 2 turns. Silent.',
    mana: 3, ap: 1, endsTurn: false, range: 5, needsLos: true, loud: 0,
    target: 'unit',
  },
  ward: {
    id: 'ward', name: 'Ward', icon: '🛡️',
    desc: 'Shield an ally against the next 4 damage.',
    mana: 2, ap: 1, endsTurn: false, range: 6, needsLos: true, loud: 0,
    target: 'ally',
  },
  counterspell: {
    id: 'counterspell', name: 'Counterspell', icon: '⚡',
    desc: 'Overwatch stance: lash the first enemy that acts in your sight.',
    mana: 2, ap: 1, endsTurn: true, range: 10, needsLos: false, loud: 0,
    minDmg: 2, maxDmg: 4, target: 'self',
  },
};
