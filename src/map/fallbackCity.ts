/**
 * Seeded synthetic city generator, watabou-flavored: perturbed street grid,
 * blocks subdivided into building lots, a plaza, districts by region.
 * Guarantees the game always has a city even with no imported map.
 */
import { RNG } from '../core/rng';
import type { Pt } from '../core/grid';
import { CityModel, BuildingPoly, DistrictTag } from './cityModel';

export function generateFallbackCity(seed: number, width = 120, height = 120): CityModel {
  const rng = new RNG(seed);
  const roads: Pt[][] = [];

  // 1. Street lines: vertical + horizontal with jittered spacing and wobble.
  const xCuts = jitteredCuts(rng, width, 13, 20);
  const yCuts = jitteredCuts(rng, height, 13, 20);

  for (const x of xCuts) {
    const line: Pt[] = [];
    let wob = 0;
    for (let y = 0; y <= height; y += 4) {
      wob += rng.int(-1, 1);
      wob = Math.max(-2, Math.min(2, wob));
      line.push({ x: x + wob, y });
    }
    roads.push(line);
  }
  for (const y of yCuts) {
    const line: Pt[] = [];
    let wob = 0;
    for (let x = 0; x <= width; x += 4) {
      wob += rng.int(-1, 1);
      wob = Math.max(-2, Math.min(2, wob));
      line.push({ x, y: y + wob });
    }
    roads.push(line);
  }

  // 2. Plaza near the center: a block left empty (market).
  const plazaXi = Math.floor(xCuts.length / 2) - 1;
  const plazaYi = Math.floor(yCuts.length / 2) - 1;

  // 3. Districts: coarse regions.
  const districts = assignDistricts(rng, width, height);

  // 4. Blocks between adjacent cuts -> building lots.
  const buildings: BuildingPoly[] = [];
  const trees: Pt[] = [];
  const greens: Pt[][] = [];
  const plazas: Pt[][] = [];
  const xs = [0, ...xCuts, width];
  const ys = [0, ...yCuts, height];

  for (let bi = 0; bi < xs.length - 1; bi++) {
    for (let bj = 0; bj < ys.length - 1; bj++) {
      const x0 = xs[bi] + 2;
      const y0 = ys[bj] + 2;
      const x1 = xs[bi + 1] - 2;
      const y1 = ys[bj + 1] - 2;
      const bw = x1 - x0;
      const bh = y1 - y0;
      if (bw < 5 || bh < 5) continue;

      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      const tag = districtAt(districts, cx, cy, width, height);

      // Plaza block: open space with trees + market stalls (as cover), no buildings.
      if (bi - 1 === plazaXi && bj - 1 === plazaYi) {
        plazas.push(rectPoly(x0, y0, x1, y1));
        for (let t = 0; t < 6; t++) {
          trees.push({ x: rng.int(x0 + 1, x1 - 1), y: rng.int(y0 + 1, y1 - 1) });
        }
        continue;
      }

      // Occasionally leave a green block.
      if (rng.chance(0.06)) {
        greens.push(rectPoly(x0, y0, x1, y1));
        for (let t = 0; t < rng.int(2, 5); t++) {
          trees.push({ x: rng.int(x0, x1), y: rng.int(y0, y1) });
        }
        continue;
      }

      subdivideBlock(rng, x0, y0, x1, y1, tag, buildings);

      // sprinkle carts/barrels near block edges
      if (rng.chance(0.5)) {
        trees.push({ x: rng.int(Math.max(0, x0 - 2), x0 - 1), y: rng.int(y0, y1) });
      }
    }
  }

  return {
    name: `Fallback #${seed.toString(16)}`,
    width,
    height,
    buildings,
    roads,
    water: [],
    greens,
    plazas,
    trees,
    districts,
  };
}

function jitteredCuts(rng: RNG, span: number, minGap: number, maxGap: number): number[] {
  const cuts: number[] = [];
  let pos = rng.int(minGap - 3, maxGap - 3);
  while (pos < span - minGap + 4) {
    cuts.push(pos);
    pos += rng.int(minGap, maxGap);
  }
  return cuts;
}

function rectPoly(x0: number, y0: number, x1: number, y1: number): Pt[] {
  return [
    { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 },
  ];
}

/** Split a block into 2-6 rectangular lots, each becoming a building (with gaps sometimes). */
function subdivideBlock(
  rng: RNG,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  tag: DistrictTag,
  out: BuildingPoly[],
): void {
  type Rect = { x0: number; y0: number; x1: number; y1: number };
  let lots: Rect[] = [{ x0, y0, x1, y1 }];
  const targetLots = tag === 'patriciate' || tag === 'castle' ? 3 : tag === 'slum' ? 8 : 6;

  while (lots.length < targetLots) {
    // split the biggest lot; rowhouses share party walls (no alley between)
    lots.sort((a, b) => area(b) - area(a));
    const lot = lots[0];
    const w = lot.x1 - lot.x0;
    const h = lot.y1 - lot.y0;
    if (w < 7 && h < 7) break;
    lots.shift();
    const alley = rng.chance(0.25) ? 1 : 0;
    if (w >= h) {
      const sx = rng.int(lot.x0 + 3, lot.x1 - 3);
      lots.push({ ...lot, x1: sx - alley }, { ...lot, x0: sx + 1 });
    } else {
      const sy = rng.int(lot.y0 + 3, lot.y1 - 3);
      lots.push({ ...lot, y1: sy - alley }, { ...lot, y0: sy + 1 });
    }
  }

  for (const lot of lots) {
    if (lot.x1 - lot.x0 < 3 || lot.y1 - lot.y0 < 3) continue;
    if (rng.chance(0.08)) continue; // vacant lot / yard
    // slight inset jitter for irregular look
    const ix0 = lot.x0 + (rng.chance(0.3) ? 1 : 0);
    const iy0 = lot.y0 + (rng.chance(0.3) ? 1 : 0);
    const ix1 = lot.x1 - (rng.chance(0.3) ? 1 : 0);
    const iy1 = lot.y1 - (rng.chance(0.3) ? 1 : 0);
    // organic footprint: jittered corners, sometimes a chamfered corner
    const j = () => (rng.next() - 0.5) * 1.3;
    let pts: Pt[] = [
      { x: ix0 + j(), y: iy0 + j() },
      { x: ix1 + j(), y: iy0 + j() },
      { x: ix1 + j(), y: iy1 + j() },
      { x: ix0 + j(), y: iy1 + j() },
    ];
    if (rng.chance(0.3) && ix1 - ix0 > 6 && iy1 - iy0 > 6) {
      const cut = rng.int(2, 3);
      const corner = rng.int(0, 3);
      const chamfered: Pt[] = [];
      pts.forEach((p, i) => {
        if (i === corner) {
          const prev = pts[(i + 3) % 4];
          const next = pts[(i + 1) % 4];
          chamfered.push(
            { x: p.x + Math.sign(prev.x - p.x) * cut, y: p.y + Math.sign(prev.y - p.y) * cut },
            { x: p.x + Math.sign(next.x - p.x) * cut, y: p.y + Math.sign(next.y - p.y) * cut },
          );
        } else {
          chamfered.push(p);
        }
      });
      pts = chamfered;
    }
    out.push({ points: pts, district: tag, districtName: tag });
  }

  function area(r: Rect): number {
    return (r.x1 - r.x0) * (r.y1 - r.y0);
  }
}

function assignDistricts(rng: RNG, width: number, height: number) {
  // 3x3 regions with a shuffled tag layout; center is always market.
  const tags: DistrictTag[] = rng.shuffle([
    'slum', 'docks', 'temple', 'patriciate', 'craftsmen', 'gate', 'commons', 'slum',
  ]);
  const out: { name: DistrictTag; label: string; polygon: Pt[] }[] = [];
  let k = 0;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const tag: DistrictTag = i === 1 && j === 1 ? 'market' : tags[k++];
      out.push({
        name: tag,
        label: tag,
        polygon: [
          { x: (i * width) / 3, y: (j * height) / 3 },
          { x: ((i + 1) * width) / 3, y: (j * height) / 3 },
          { x: ((i + 1) * width) / 3, y: ((j + 1) * height) / 3 },
          { x: (i * width) / 3, y: ((j + 1) * height) / 3 },
        ],
      });
    }
  }
  return out;
}

function districtAt(
  districts: { name: DistrictTag; label: string; polygon: Pt[] }[],
  x: number,
  y: number,
  width: number,
  height: number,
): DistrictTag {
  const i = Math.min(2, Math.floor((x / width) * 3));
  const j = Math.min(2, Math.floor((y / height) * 3));
  return districts[i * 3 + j]?.name ?? 'commons';
}
