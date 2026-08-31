import type { Pt } from '../core/grid';

/** District flavor tags — the quest generator's placement vocabulary. */
export type DistrictTag =
  | 'market'
  | 'slum'
  | 'docks'
  | 'temple'
  | 'patriciate'
  | 'craftsmen'
  | 'castle'
  | 'gate'
  | 'commons';

export const ALL_TAGS: DistrictTag[] = [
  'market', 'slum', 'docks', 'temple', 'patriciate', 'craftsmen', 'castle', 'gate', 'commons',
];

export interface BuildingPoly {
  /** Closed polygon in tile coordinates (last->first edge implied). */
  points: Pt[];
  district: DistrictTag;
  /** Display name of the quarter ("Apple Ring"); equals the tag for generated cities. */
  districtName: string;
}

/** Abstract city in tile coordinates, ready to rasterize. */
export interface CityModel {
  name: string;
  width: number;
  height: number;
  buildings: BuildingPoly[];
  /** Street center-lines (used for door orientation and patrol routes). */
  roads: Pt[][];
  /** Water polygons. */
  water: Pt[][];
  /** Grass / park / field polygons. */
  greens: Pt[][];
  /** Paved open squares (walkable street terrain). */
  plazas: Pt[][];
  trees: Pt[];
  districts: { name: DistrictTag; label: string; polygon: Pt[] }[];
}

/** How a quarter is referred to in clue text. */
export function districtDisplay(tag: DistrictTag, label: string): string {
  return label === tag ? `the ${tag} quarter` : label;
}

export function polygonCentroid(points: Pt[]): Pt {
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p.x;
    y += p.y;
  }
  return { x: x / points.length, y: y / points.length };
}

export function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    if (yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Map a free-form ward/district name from an MFCG export to our tag vocabulary. */
export function tagFromName(name: string): DistrictTag {
  const n = name.toLowerCase();
  if (n.includes('market') || n.includes('merchant') || n.includes('trade')) return 'market';
  if (n.includes('slum') || n.includes('shanty') || n.includes('poor')) return 'slum';
  if (n.includes('dock') || n.includes('port') || n.includes('harbor') || n.includes('harbour') || n.includes('fish')) return 'docks';
  if (n.includes('temple') || n.includes('cathedral') || n.includes('church') || n.includes('holy')) return 'temple';
  if (n.includes('patric') || n.includes('noble') || n.includes('rich') || n.includes('mansion')) return 'patriciate';
  if (n.includes('craft') || n.includes('smith') || n.includes('tann') || n.includes('artisan') || n.includes('guild')) return 'craftsmen';
  if (n.includes('castle') || n.includes('keep') || n.includes('citadel') || n.includes('fort')) return 'castle';
  if (n.includes('gate')) return 'gate';
  return 'commons';
}
