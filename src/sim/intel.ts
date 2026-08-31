/**
 * What the squad KNOWS. The target exists concretely in the sim from turn one;
 * this models the shrinking candidate set the player is reasoning over.
 */
import type { Pt } from '../core/grid';
import type { RasterCity, BuildingInfo } from '../map/rasterize';
import { buildingAttrs, questableBuildings, BuildingAttrs } from '../map/cityIndex';
import type { Clue } from './types';
import type { EventBus } from '../core/events';

type Predicate = (b: BuildingInfo, attrs: BuildingAttrs) => boolean;

interface AppliedFilter {
  label: string;
  pred: Predicate;
}

export class Knowledge {
  readonly baseCandidates: BuildingInfo[];
  private attrs = new Map<number, BuildingAttrs>();
  private filters: AppliedFilter[] = [];
  readonly clues: Clue[] = [];
  identityKnown = false;
  identityTrait: string | null = null;
  candidates: Set<number>;

  constructor(
    private raster: RasterCity,
    private targetBuilding: number,
    private bus: EventBus,
  ) {
    this.baseCandidates = questableBuildings(raster);
    for (const b of this.baseCandidates) this.attrs.set(b.id, buildingAttrs(raster, b));
    this.candidates = new Set(this.baseCandidates.map((b) => b.id));
  }

  get targetBuildingKnown(): number | null {
    return this.candidates.size === 1 ? [...this.candidates][0] : null;
  }

  learnClue(clue: Clue): boolean {
    if (this.clues.some((c) => c.id === clue.id)) return false;
    this.clues.push(clue);
    if (clue.filter.kind === 'identity') {
      this.identityKnown = true;
      this.identityTrait = String(clue.filter.value);
    } else {
      const f = clue.filter;
      this.filters.push({
        label: clue.text,
        pred: (b, a) => {
          switch (f.kind) {
            case 'district': return a.district === f.value;
            case 'size': return a.size === f.value;
            case 'quadrant': return a.quadrant === f.value;
            case 'facing': return a.facing === f.value;
            case 'exact': return b.id === f.value;
            default: return true;
          }
        },
      });
    }
    this.recompute();
    this.bus.emit('clueFound', { text: clue.text, source: 'clue' });
    this.bus.emit('candidatesNarrowed', { count: this.candidates.size });
    return true;
  }

  /** Scry: keep candidates within a bearing cone toward the true target. */
  applyScry(from: Pt): { bearing: string } {
    const tb = this.raster.buildings.find((b) => b.id === this.targetBuilding)!;
    const dx = tb.centroid.x - from.x;
    const dy = tb.centroid.y - from.y;
    const trueAngle = Math.atan2(dy, dx);
    const cone = Math.PI / 5; // ±36°
    this.filters.push({
      label: 'Scried bearing',
      pred: (b) => {
        if (b.id === this.targetBuilding) return true;
        const a = Math.atan2(b.centroid.y - from.y, b.centroid.x - from.x);
        let diff = Math.abs(a - trueAngle);
        if (diff > Math.PI) diff = 2 * Math.PI - diff;
        const dist = Math.hypot(b.centroid.x - from.x, b.centroid.y - from.y);
        return diff <= cone || dist < 8;
      },
    });
    this.recompute();
    this.bus.emit('candidatesNarrowed', { count: this.candidates.size });
    return { bearing: bearingName(trueAngle) };
  }

  private recompute(): void {
    const next = new Set<number>();
    for (const b of this.baseCandidates) {
      const a = this.attrs.get(b.id)!;
      if (this.filters.every((f) => f.pred(b, a))) next.add(b.id);
    }
    // Safety: the target building must always survive filtering.
    next.add(this.targetBuilding);
    this.candidates = next;
  }
}

export function bearingName(angle: number): string {
  const dirs = ['east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'north', 'north-east'];
  const idx = Math.round(((angle + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8;
  return dirs[idx];
}
