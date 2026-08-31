import type { Pt } from '../core/grid';
import type { DistrictTag } from '../map/cityModel';

export type Faction = 'squad' | 'guard' | 'hostile' | 'civilian';

export type SpellId =
  | 'firebolt'
  | 'sleep'
  | 'blink'
  | 'scry'
  | 'stonewall'
  | 'sunder'
  | 'suppress'
  | 'charm'
  | 'ward'
  | 'counterspell'
  | 'strike'; // staff melee, always available

export type AiState = 'idle' | 'patrol' | 'suspicious' | 'combat' | 'flee';

export interface Unit {
  id: number;
  name: string;
  faction: Faction;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  mana: number;
  maxMana: number;
  ap: number;
  move: number;
  spells: SpellId[];
  alive: boolean;
  /** Knocked out (sleep/subdue). Subdued units can be carried. */
  subdued: boolean;
  sleepTurns: number;
  charmedTurns: number;
  wardHp: number;
  overwatch: boolean;
  /** Pinned by suppressing fire: −30 aim, half movement. */
  suppressedTurns: number;
  /** Body hidden inside a container — out of sight, out of the alarm economy. */
  stashed: boolean;
  /** id of unit being carried, or null. */
  carrying: number | null;
  carriedBy: number | null;
  // --- NPC fields
  aiState: AiState;
  patrol: Pt[];
  patrolIdx: number;
  lastKnownSquadPos: Pt | null;
  /** Which commotion this NPC has already investigated (see MissionState.commotionSeq). */
  commotionSeq: number;
  /** For quest NPCs. */
  isTarget: boolean;
  isDecoy: boolean;
  trait: string | null; // "a grey cloak" — identity discrimination
  clue: Clue | null; // carried intel (civilians / informant)
  questioned: boolean;
  reportedCrime: boolean;
  homeBuilding: number | null;
}

export type ClueFilterKind =
  | 'district'
  | 'size'
  | 'quadrant'
  | 'facing'
  | 'exact'
  | 'identity';

export interface ClueFilter {
  kind: ClueFilterKind;
  value: string | number;
}

export interface Clue {
  id: number;
  text: string;
  filter: ClueFilter;
}

export type QuestKind = 'assassinate' | 'extract';

export interface Quest {
  kind: QuestKind;
  targetName: string;
  targetArchetype: string;
  briefing: string;
  targetBuilding: number;
  targetUnitId: number;
  /** All clues in the planted chain (identity clue last, if any). */
  chain: Clue[];
  hasDecoys: boolean;
}

export interface WizardLoadout {
  name: string;
  title: string;
  hp: number;
  mana: number;
  move: number;
  spells: SpellId[];
}

export const WIZARDS: WizardLoadout[] = [
  { name: 'Vex', title: 'Warcaster', hp: 12, mana: 10, move: 6, spells: ['firebolt', 'suppress', 'ward', 'counterspell', 'strike'] },
  { name: 'Issra', title: 'Diviner', hp: 9, mana: 14, move: 6, spells: ['scry', 'firebolt', 'charm', 'strike'] },
  { name: 'Bram', title: 'Shaper', hp: 11, mana: 12, move: 6, spells: ['stonewall', 'sunder', 'firebolt', 'ward', 'strike'] },
  { name: 'Nyx', title: 'Whisper', hp: 9, mana: 12, move: 7, spells: ['sleep', 'blink', 'charm', 'strike'] },
];

let nextUnitId = 1;

export function resetUnitIds(): void {
  nextUnitId = 1;
}

export function makeUnit(partial: Partial<Unit> & { faction: Faction; x: number; y: number }): Unit {
  return {
    id: nextUnitId++,
    name: 'unit',
    hp: 4,
    maxHp: 4,
    mana: 0,
    maxMana: 0,
    ap: 2,
    move: 5,
    spells: [],
    alive: true,
    subdued: false,
    sleepTurns: 0,
    charmedTurns: 0,
    wardHp: 0,
    overwatch: false,
    suppressedTurns: 0,
    stashed: false,
    carrying: null,
    carriedBy: null,
    aiState: 'idle',
    patrol: [],
    patrolIdx: 0,
    lastKnownSquadPos: null,
    commotionSeq: 0,
    isTarget: false,
    isDecoy: false,
    trait: null,
    clue: null,
    questioned: false,
    reportedCrime: false,
    homeBuilding: null,
    ...partial,
  };
}

export interface TargetArchetype {
  key: string;
  displayName: string;
  epithet: string;
  preferredTags: DistrictTag[];
}

export const ARCHETYPES: TargetArchetype[] = [
  { key: 'fence', displayName: 'the Magpie', epithet: 'a fence moving cursed relics', preferredTags: ['docks', 'slum', 'market'] },
  { key: 'scribe', displayName: 'Brother Ossuar', epithet: 'a cult scribe copying forbidden pages', preferredTags: ['temple', 'commons', 'craftsmen'] },
  { key: 'deserter', displayName: 'Captain Hale', epithet: 'a deserter battle-mage selling secrets', preferredTags: ['gate', 'slum', 'docks'] },
  { key: 'alchemist', displayName: 'Mistress Vitriol', epithet: 'an alchemist brewing warplague', preferredTags: ['craftsmen', 'market', 'commons'] },
  { key: 'broker', displayName: 'the Silk Count', epithet: 'a broker of stolen memories', preferredTags: ['patriciate', 'market', 'temple'] },
];

export const TRAITS = ['a grey cloak', 'a crimson hood', 'a brass amulet', 'an ivory cane', 'a raven tattoo'];
