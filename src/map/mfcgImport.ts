/**
 * Importer for watabou Medieval Fantasy City Generator JSON / GeoJSON exports.
 *
 * Real MFCG exports (verified against v0.11.x) are a FeatureCollection whose
 * features carry a top-level `id` naming the layer, and often hold bare
 * geometry (no `geometry` wrapper): buildings/prisms (MultiPolygon), roads &
 * planks (GeometryCollection of LineStrings with `width`), rivers (LineStrings
 * with `width`), water (MultiPolygon), squares (paved plazas), greens/fields,
 * trees (MultiPoint), districts (GeometryCollection of Polygons with a `name`
 * like "Apple Ring"), plus `values`/`earth`/`walls` which we ignore.
 * We parse tolerantly, scale world units -> tiles, and crop a playable window.
 */
import type { Pt } from '../core/grid';
import { RNG } from '../core/rng';
import {
  CityModel, BuildingPoly, DistrictTag, tagFromName, pointInPolygon, polygonCentroid,
} from './cityModel';

interface RawLayers {
  buildings: Pt[][];
  roads: { pts: Pt[]; width: number }[];
  rivers: { pts: Pt[]; width: number }[];
  water: Pt[][];
  greens: Pt[][];
  plazas: Pt[][];
  trees: Pt[];
  districts: { label: string; polygon: Pt[] }[];
}

export function importMfcg(
  json: unknown,
  opts: { width?: number; height?: number; seed?: number; name?: string } = {},
): CityModel {
  const width = opts.width ?? 120;
  const height = opts.height ?? 120;
  const raw: RawLayers = {
    buildings: [], roads: [], rivers: [], water: [], greens: [], plazas: [], trees: [], districts: [],
  };

  collectFeatures(json, raw, '');
  if (raw.buildings.length === 0) {
    throw new Error('No buildings found in imported JSON – is this an MFCG export?');
  }

  // Scale so the median building is ~6.5 tiles across, whatever the units.
  const span = medianBuildingSpan(raw.buildings);
  const scale = span > 0 ? 6.5 / span : 1;
  const s = scaleLayers(raw, scale);

  // Crop: window that maximizes building density.
  const centroids = s.buildings.map(polygonCentroid);
  const center = pickCropCenter(centroids, width, height, opts.seed ?? 1);
  const ox = center.x - width / 2;
  const oy = center.y - height / 2;
  const shift = (p: Pt): Pt => ({ x: p.x - ox, y: p.y - oy });

  // Districts: keep real labels, assign gameplay tags heuristically.
  const shiftedDistricts = s.districts.map((d) => ({ label: d.label, polygon: d.polygon.map(shift) }));
  const water = s.water.map((poly) => poly.map(shift));
  for (const r of s.rivers) {
    water.push(thickenLine(r.pts.map(shift), Math.max(1.2, r.width / 2)));
  }
  const districts = assignDistrictTags(shiftedDistricts, water, width, height, opts.seed ?? 1);

  const districtOf = (p: Pt): { name: DistrictTag; label: string } => {
    for (const d of districts) {
      if (d.polygon.length >= 3 && pointInPolygon(p, d.polygon)) return d;
    }
    return { name: 'commons', label: 'the outskirts' };
  };

  const buildings: BuildingPoly[] = [];
  for (const poly of s.buildings) {
    const pts = poly.map(shift);
    const bc = polygonCentroid(pts);
    if (bc.x < -8 || bc.y < -8 || bc.x > width + 8 || bc.y > height + 8) continue;
    const d = districtOf(bc);
    buildings.push({ points: pts, district: d.name, districtName: d.label });
  }

  return {
    name: opts.name ?? 'Imported city',
    width,
    height,
    buildings,
    roads: s.roads.map((r) => r.pts.map(shift)),
    water,
    greens: s.greens.map((poly) => poly.map(shift)),
    plazas: s.plazas.map((poly) => poly.map(shift)),
    trees: s.trees.map(shift).filter((p) => p.x >= 0 && p.y >= 0 && p.x < width && p.y < height),
    districts,
  };
}

/**
 * MFCG district names are flavor ("Apple Ring"), not types — derive gameplay
 * tags from geography: center = market, waterfront = docks, edges = gate/slum,
 * the rest from a seeded shuffle. Labels are preserved for clue text.
 */
function assignDistrictTags(
  districts: { label: string; polygon: Pt[] }[],
  water: Pt[][],
  width: number,
  height: number,
  seed: number,
): { name: DistrictTag; label: string; polygon: Pt[] }[] {
  const rng = new RNG(seed).fork(9);
  const center = { x: width / 2, y: height / 2 };
  const waterPts = water.flat();

  const scored = districts.map((d) => {
    const c = polygonCentroid(d.polygon);
    const centerDist = Math.hypot(c.x - center.x, c.y - center.y);
    let waterDist = Infinity;
    for (const w of waterPts) {
      const dd = Math.hypot(w.x - c.x, w.y - c.y);
      if (dd < waterDist) waterDist = dd;
    }
    return { d, c, centerDist, waterDist };
  });

  const out: { name: DistrictTag; label: string; polygon: Pt[] }[] = [];
  const taken = new Set<number>();
  const claim = (idx: number, tag: DistrictTag) => {
    taken.add(idx);
    out.push({ name: tag, label: districts[idx].label, polygon: districts[idx].polygon });
  };

  // semantic names win outright
  scored.forEach((sc, i) => {
    const byName = tagFromName(sc.d.label);
    if (byName !== 'commons') claim(i, byName);
  });
  // market: nearest the crop center
  const byCenter = scored.map((sc, i) => ({ sc, i })).filter(({ i }) => !taken.has(i))
    .sort((a, b) => a.sc.centerDist - b.sc.centerDist);
  if (byCenter.length > 0) claim(byCenter[0].i, 'market');
  // docks: closest to water, if water is anywhere near
  const byWater = scored.map((sc, i) => ({ sc, i })).filter(({ i }) => !taken.has(i))
    .sort((a, b) => a.sc.waterDist - b.sc.waterDist);
  if (byWater.length > 0 && byWater[0].sc.waterDist < Math.max(width, height)) {
    claim(byWater[0].i, 'docks');
  }
  // the rest: seeded variety
  const rest: DistrictTag[] = rng.shuffle(['slum', 'temple', 'patriciate', 'craftsmen', 'gate', 'commons', 'slum', 'commons']);
  let k = 0;
  scored.forEach((_, i) => {
    if (!taken.has(i)) claim(i, rest[k++ % rest.length]);
  });
  return out;
}

function scaleLayers(raw: RawLayers, s: number): RawLayers {
  const sp = (p: Pt): Pt => ({ x: p.x * s, y: p.y * s });
  return {
    buildings: raw.buildings.map((poly) => poly.map(sp)),
    roads: raw.roads.map((r) => ({ pts: r.pts.map(sp), width: r.width * s })),
    rivers: raw.rivers.map((r) => ({ pts: r.pts.map(sp), width: r.width * s })),
    water: raw.water.map((l) => l.map(sp)),
    greens: raw.greens.map((l) => l.map(sp)),
    plazas: raw.plazas.map((l) => l.map(sp)),
    trees: raw.trees.map(sp),
    districts: raw.districts.map((d) => ({ label: d.label, polygon: d.polygon.map(sp) })),
  };
}

function medianBuildingSpan(buildings: Pt[][]): number {
  const spans = buildings
    .map((poly) => {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const p of poly) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      }
      return Math.max(maxX - minX, maxY - minY);
    })
    .sort((a, b) => a - b);
  return spans.length ? spans[Math.floor(spans.length / 2)] : 0;
}

function pickCropCenter(centroids: Pt[], w: number, h: number, seed: number): Pt {
  if (centroids.length === 0) return { x: w / 2, y: h / 2 };
  const rng = new RNG(seed);
  const candidates = rng.shuffle([...centroids]).slice(0, 60);
  let best = candidates[0];
  let bestScore = -1;
  for (const c of candidates) {
    let score = 0;
    for (const o of centroids) {
      if (Math.abs(o.x - c.x) < w / 2 && Math.abs(o.y - c.y) < h / 2) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Tolerant GeoJSON-ish traversal

function collectFeatures(node: unknown, out: RawLayers, layerHint: string): void {
  if (node == null || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;

  if (Array.isArray(obj.features)) {
    for (const f of obj.features) collectFeatures(f, out, layerHint);
    return;
  }

  const hint = layerName(obj) || layerHint;
  // features may hold bare geometry (MFCG) or a nested `geometry` (GeoJSON)
  const geom = (obj.geometry as Record<string, unknown> | undefined) ?? obj;
  const gtype = typeof geom.type === 'string' ? (geom.type as string) : '';

  if (gtype === 'GeometryCollection' && Array.isArray(geom.geometries)) {
    for (const g of geom.geometries) collectFeatures(g, out, hint);
    return;
  }
  if (obj.geometry && gtype === '') {
    collectFeatures(obj.geometry, out, hint);
    return;
  }

  const coords = geom.coordinates;
  if (!Array.isArray(coords) || hint === '') return;

  switch (gtype) {
    case 'Polygon':
      addPoly(hint, ringToPts(coords[0]), out, obj, geom);
      break;
    case 'MultiPolygon':
      for (const poly of coords) addPoly(hint, ringToPts((poly as unknown[])[0]), out, obj, geom);
      break;
    case 'LineString':
      addLine(hint, ringToPts(coords), out, geom);
      break;
    case 'MultiLineString':
      for (const line of coords) addLine(hint, ringToPts(line), out, geom);
      break;
    case 'Point':
      addPoint(hint, ringToPts([coords])[0], out);
      break;
    case 'MultiPoint':
      for (const p of ringToPts(coords)) addPoint(hint, p, out);
      break;
  }
}

function layerName(obj: Record<string, unknown>): string {
  const props = (obj.properties as Record<string, unknown> | undefined) ?? {};
  const cand = [obj.id, props.type, props.id, props.layer]
    .find((v) => typeof v === 'string');
  return typeof cand === 'string' ? cand.toLowerCase() : '';
}

function ringToPts(ring: unknown): Pt[] {
  if (!Array.isArray(ring)) return [];
  const pts: Pt[] = [];
  for (const c of ring) {
    if (Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number') {
      pts.push({ x: c[0], y: c[1] });
    }
  }
  return pts;
}

function addPoly(
  layer: string,
  pts: Pt[],
  out: RawLayers,
  obj: Record<string, unknown>,
  geom: Record<string, unknown>,
): void {
  if (pts.length < 3) return;
  if (layer.includes('building') || layer.includes('prism')) out.buildings.push(pts);
  else if (layer.includes('water') || layer.includes('river') || layer.includes('sea')) out.water.push(pts);
  else if (layer.includes('square') || layer.includes('plaza')) out.plazas.push(pts);
  else if (layer.includes('green') || layer.includes('field') || layer.includes('park')) out.greens.push(pts);
  else if (layer.includes('district') || layer.includes('ward')) {
    const props = (obj.properties as Record<string, unknown> | undefined) ?? {};
    const name = [geom.name, props.name, props.title, props.ward]
      .find((v) => typeof v === 'string') as string | undefined;
    out.districts.push({ label: name ?? 'the old town', polygon: pts });
  } else if (layer.includes('road') || layer.includes('street')) {
    out.roads.push({ pts, width: 2 });
  }
  // 'earth', 'walls', 'values' etc: ignored
}

function addLine(layer: string, pts: Pt[], out: RawLayers, geom: Record<string, unknown>): void {
  if (pts.length < 2) return;
  const width = typeof geom.width === 'number' ? (geom.width as number) : 2;
  if (layer.includes('road') || layer.includes('street') || layer.includes('plank')) {
    out.roads.push({ pts, width });
  } else if (layer.includes('river')) {
    out.rivers.push({ pts, width });
  } else if (layer.includes('water')) {
    out.rivers.push({ pts, width });
  }
}

function addPoint(layer: string, p: Pt, out: RawLayers): void {
  if (layer.includes('tree')) out.trees.push(p);
}

/** Turn a river polyline into a rough polygon by offsetting perpendicular. */
function thickenLine(pts: Pt[], halfWidth: number): Pt[] {
  const left: Pt[] = [];
  const right: Pt[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    left.push({ x: pts[i].x + nx * halfWidth, y: pts[i].y + ny * halfWidth });
    right.push({ x: pts[i].x - nx * halfWidth, y: pts[i].y - ny * halfWidth });
  }
  return [...left, ...right.reverse()];
}
