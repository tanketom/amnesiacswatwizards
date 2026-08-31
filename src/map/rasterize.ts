/**
 * CityModel -> TileGrid + building index.
 * Streets are the walkable ground; buildings become wall shells with BSP'd
 * interior rooms and street-facing doors. A connectivity pass guarantees every
 * floor tile is reachable from the street network.
 */
import { TileGrid, Terrain, Pt } from '../core/grid';
import { RNG } from '../core/rng';
import { CityModel, DistrictTag, pointInPolygon } from './cityModel';

export interface RoomInfo {
  id: number;
  tiles: number[];
}

export interface BuildingInfo {
  id: number;
  district: DistrictTag;
  districtName: string;
  /** Angle of the building's longest facade edge, in [0, π/2). Partitions align to it. */
  orientation: number;
  floorTiles: number[];
  doorTiles: number[];
  windowTiles: number[];
  centroid: Pt;
  rooms: RoomInfo[];
  sizeClass: 'small' | 'medium' | 'large';
}

export interface RasterCity {
  grid: TileGrid;
  buildings: BuildingInfo[];
  /** Street tiles along road center-lines: patrol routes / door preference. */
  roadTiles: number[];
  model: CityModel;
}

export function rasterizeCity(model: CityModel, seed: number): RasterCity {
  const rng = new RNG(seed);
  const grid = new TileGrid(model.width, model.height);
  const W = grid.width;

  // 1. Ground: everything is street.
  grid.terrain.fill(Terrain.Street);

  // 2. Greens, plazas (paved), then water.
  for (const poly of model.greens) fillPolygon(grid, poly, Terrain.Grass);
  for (const poly of model.plazas) fillPolygon(grid, poly, Terrain.Street);
  for (const poly of model.water) fillPolygon(grid, poly, Terrain.Water);

  // 3. Roads: mark center-lines; carve bridges across water.
  const roadTiles: number[] = [];
  const roadSet = new Set<number>();
  for (const line of model.roads) {
    for (let i = 0; i + 1 < line.length; i++) {
      for (const p of bresenham(line[i], line[i + 1])) {
        if (!grid.inBounds(p.x, p.y)) continue;
        const idx = grid.idx(p.x, p.y);
        if (grid.terrain[idx] === Terrain.Water) grid.terrain[idx] = Terrain.Street; // bridge
        if (!roadSet.has(idx)) {
          roadSet.add(idx);
          roadTiles.push(idx);
        }
      }
    }
  }

  // 4. Buildings.
  const buildings: BuildingInfo[] = [];
  for (const bp of model.buildings) {
    const id = buildings.length;
    const tiles = polygonTiles(grid, bp.points);
    if (tiles.length < 6) continue;
    // skip if it would overwrite water heavily (bad crop edge)
    let waterHits = 0;
    for (const t of tiles) if (grid.terrain[t] === Terrain.Water) waterHits++;
    if (waterHits > tiles.length / 3) continue;

    const tileSet = new Set(tiles);
    const floor: number[] = [];
    for (const t of tiles) {
      const x = t % W;
      const y = Math.floor(t / W);
      const boundary =
        !tileSet.has(t - 1) || !tileSet.has(t + 1) || !tileSet.has(t - W) || !tileSet.has(t + W) ||
        x === 0 || y === 0 || x === W - 1 || y === grid.height - 1;
      grid.terrain[t] = boundary ? Terrain.Wall : Terrain.Floor;
      grid.buildingId[t] = id;
      if (!boundary) floor.push(t);
    }
    if (floor.length === 0) {
      // solid scenery block — keep walls, no building record
      continue;
    }

    const info: BuildingInfo = {
      id,
      district: bp.district,
      districtName: bp.districtName,
      orientation: longestEdgeAngle(bp.points),
      floorTiles: floor,
      doorTiles: [],
      windowTiles: [],
      centroid: centroidOfTiles(floor, W),
      rooms: [],
      sizeClass: floor.length > 90 ? 'large' : floor.length > 30 ? 'medium' : 'small',
    };
    buildings.push(info);
  }

  // 5. Interior walls for genuinely large buildings; small homes stay one room.
  for (const b of buildings) {
    if (b.floorTiles.length > 60) bspPartition(grid, b, rng);
    // recompute floor list (some became walls)
    b.floorTiles = b.floorTiles.filter((t) => grid.terrain[t] === Terrain.Floor);
  }

  // 6. Exterior doors.
  for (const b of buildings) {
    placeExteriorDoors(grid, b, roadSet, rng);
  }

  // 7. Trees / carts as cover on open ground — before the connectivity pass so
  // a cart can never silently seal a doorway or alley.
  for (const p of model.trees) {
    const x = Math.round(p.x);
    const y = Math.round(p.y);
    if (!grid.inBounds(x, y)) continue;
    const t = grid.get(x, y);
    if (t !== Terrain.Street && t !== Terrain.Grass) continue;
    let nearDoor = false;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
      if (grid.get(x + dx, y + dy) === Terrain.Door) nearDoor = true;
    }
    if (!nearDoor) grid.set(x, y, Terrain.Cover);
  }

  // 8. Connectivity: every floor tile reachable from the main street component.
  ensureConnectivity(grid, buildings, rng);

  // 8b. Prune: any floor still sealed off (double walls between row houses)
  // becomes solid wall, so "every floor tile is reachable" holds by construction.
  pruneUnreachable(grid, buildings);
  const kept = buildings.filter((b) => b.floorTiles.length >= 4 && b.doorTiles.length > 0);

  // 9. Rooms: connected floor components per building.
  for (const b of kept) {
    b.rooms = computeRooms(grid, b);
  }

  // 10. Windows in street-facing shell walls: recon and breach points, so a
  // villain's room is never a one-door kill box.
  placeWindows(grid, kept, rng.fork(11));

  return { grid, buildings: kept, roadTiles, model };
}

/** BFS from street; floor tiles never reached become solid wall. */
function pruneUnreachable(grid: TileGrid, buildings: BuildingInfo[]): void {
  const W = grid.width;
  const size = W * grid.height;
  const visited = new Uint8Array(size);
  let seed = -1;
  let best = 0;
  // seed from the largest street component (approx: try a few far-apart seeds)
  const compVisited = new Uint8Array(size);
  for (let s = 0; s < size; s += 7) {
    if (compVisited[s] || grid.terrain[s] !== Terrain.Street) continue;
    let count = 0;
    const q = [s];
    compVisited[s] = 1;
    while (q.length) {
      const t = q.pop()!;
      count++;
      const x = t % W, y = Math.floor(t / W);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx, ny = y + dy;
        if (!grid.inBounds(nx, ny)) continue;
        const nt = ny * W + nx;
        if (!compVisited[nt] && grid.terrain[nt] === Terrain.Street) {
          compVisited[nt] = 1;
          q.push(nt);
        }
      }
    }
    if (count > best) {
      best = count;
      seed = s;
    }
    if (best > size / 3) break;
  }
  if (seed < 0) return;
  const q = [seed];
  visited[seed] = 1;
  while (q.length) {
    const t = q.pop()!;
    const x = t % W, y = Math.floor(t / W);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx, ny = y + dy;
      if (!grid.inBounds(nx, ny)) continue;
      const nt = ny * W + nx;
      if (!visited[nt] && grid.walkable(nx, ny)) {
        visited[nt] = 1;
        q.push(nt);
      }
    }
  }
  for (const b of buildings) {
    const keptFloor: number[] = [];
    for (const f of b.floorTiles) {
      if (grid.terrain[f] === Terrain.Floor && !visited[f]) {
        grid.terrain[f] = Terrain.Wall;
      } else if (grid.terrain[f] === Terrain.Floor) {
        keptFloor.push(f);
      }
    }
    b.floorTiles = keptFloor;
    b.doorTiles = b.doorTiles.filter((d) => grid.terrain[d] === Terrain.Door);
  }
}

// ---------------------------------------------------------------------------

function fillPolygon(grid: TileGrid, poly: Pt[], terrain: Terrain): void {
  if (poly.length < 3) return;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of poly) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  for (let y = Math.max(0, Math.floor(minY)); y <= Math.min(grid.height - 1, Math.ceil(maxY)); y++) {
    for (let x = Math.max(0, Math.floor(minX)); x <= Math.min(grid.width - 1, Math.ceil(maxX)); x++) {
      if (pointInPolygon({ x: x + 0.5, y: y + 0.5 }, poly)) grid.set(x, y, terrain);
    }
  }
}

function polygonTiles(grid: TileGrid, poly: Pt[]): number[] {
  const out: number[] = [];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of poly) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  for (let y = Math.max(0, Math.floor(minY)); y <= Math.min(grid.height - 1, Math.ceil(maxY)); y++) {
    for (let x = Math.max(0, Math.floor(minX)); x <= Math.min(grid.width - 1, Math.ceil(maxX)); x++) {
      if (pointInPolygon({ x: x + 0.5, y: y + 0.5 }, poly)) out.push(grid.idx(x, y));
    }
  }
  return out;
}

function bresenham(a: Pt, b: Pt): Pt[] {
  const pts: Pt[] = [];
  let x0 = Math.round(a.x), y0 = Math.round(a.y);
  const x1 = Math.round(b.x), y1 = Math.round(b.y);
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    pts.push({ x: x0, y: y0 });
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
  return pts;
}

function centroidOfTiles(tiles: number[], w: number): Pt {
  let x = 0, y = 0;
  for (const t of tiles) {
    x += t % w;
    y += Math.floor(t / w);
  }
  return { x: Math.round(x / tiles.length), y: Math.round(y / tiles.length) };
}

/** Angle of the polygon's longest edge, folded into [0, π/2). */
function longestEdgeAngle(points: Pt[]): number {
  let best = 0;
  let bestLen = -1;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const c = points[(i + 1) % points.length];
    const len = (c.x - a.x) ** 2 + (c.y - a.y) ** 2;
    if (len > bestLen) {
      bestLen = len;
      best = Math.atan2(c.y - a.y, c.x - a.x);
    }
  }
  let ang = best % (Math.PI / 2);
  if (ang < 0) ang += Math.PI / 2;
  return ang;
}

/**
 * Split a building's floor with interior walls that follow the building's OWN
 * orientation (a rotated house gets rotated, stair-stepped partitions), never
 * carving rooms smaller than a dozen tiles. Each wall gets a doorway.
 */
function bspPartition(grid: TileGrid, b: BuildingInfo, rng: RNG): void {
  const W = grid.width;
  const theta = b.orientation;
  const ux = Math.cos(theta);
  const uy = Math.sin(theta);
  const vx = -uy;
  const vy = ux;
  const floorSet = new Set(b.floorTiles);

  const split = (tiles: number[], depth: number): void => {
    if (tiles.length <= 55 || depth > 3) return;
    const regionSet = new Set(tiles);
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const t of tiles) {
      const x = t % W;
      const y = Math.floor(t / W);
      const pu = x * ux + y * uy;
      const pv = x * vx + y * vy;
      if (pu < minU) minU = pu;
      if (pu > maxU) maxU = pu;
      if (pv < minV) minV = pv;
      if (pv > maxV) maxV = pv;
    }
    const spanU = maxU - minU;
    const spanV = maxV - minV;
    const alongU = spanU >= spanV; // cut across the longer extent
    const span = alongU ? spanU : spanV;
    if (span < 10) return;
    const cut = (alongU ? minU : minV) + 4 + rng.next() * (span - 8);

    // march along the wall direction from a point on the cut line, collecting tiles
    const wdx = alongU ? vx : ux;
    const wdy = alongU ? vy : uy;
    const midOther = alongU ? (minV + maxV) / 2 : (minU + maxU) / 2;
    const px0 = alongU ? ux * cut + vx * midOther : ux * midOther + vx * cut;
    const py0 = alongU ? uy * cut + vy * midOther : uy * midOther + vy * cut;
    const wallTiles = new Set<number>();
    for (const s of [1, -1] as const) {
      let misses = 0;
      for (let k = 0; k < 90; k++) {
        const x = Math.round(px0 + wdx * s * k * 0.5);
        const y = Math.round(py0 + wdy * s * k * 0.5);
        const t = y * W + x;
        if (regionSet.has(t)) {
          wallTiles.add(t);
          misses = 0;
        } else if (++misses > 4) {
          break;
        }
      }
    }
    if (wallTiles.size < 2) return;

    // the rooms this cut would create — reject sliver rooms outright
    const proj = (t: number) => {
      const x = t % W;
      const y = Math.floor(t / W);
      return alongU ? x * ux + y * uy : x * vx + y * vy;
    };
    const sideA: number[] = [];
    const sideB: number[] = [];
    for (const t of tiles) {
      if (wallTiles.has(t)) continue;
      (proj(t) < cut ? sideA : sideB).push(t);
    }
    if (sideA.length < 12 || sideB.length < 12) return;

    // doorway: a wall tile with clear floor on both sides across the cut
    const cdx = Math.round(alongU ? ux : vx);
    const cdy = Math.round(alongU ? uy : vy);
    const step = cdy * W + cdx;
    const doorCands = [...wallTiles].filter(
      (t) =>
        floorSet.has(t - step) && floorSet.has(t + step) &&
        !wallTiles.has(t - step) && !wallTiles.has(t + step),
    );
    if (doorCands.length === 0) return;
    const door = doorCands[rng.int(0, doorCands.length - 1)];

    for (const t of wallTiles) {
      grid.terrain[t] = t === door ? Terrain.Door : Terrain.Wall;
    }
    split(sideA, depth + 1);
    split(sideB, depth + 1);
  };

  split([...b.floorTiles], 0);
}

function placeExteriorDoors(grid: TileGrid, b: BuildingInfo, roadSet: Set<number>, rng: RNG): void {
  const W = grid.width;
  // candidate wall tiles: building wall with exterior walkable on one 4-side
  // and own interior floor/door on the opposite side.
  type Cand = { t: number; roadDist: number };
  const cands: Cand[] = [];
  const seen = new Set<number>();
  for (const f of b.floorTiles) {
    for (const step of [1, -1, W, -W]) {
      const wallT = f + step;
      if (seen.has(wallT)) continue;
      seen.add(wallT);
      if (grid.terrain[wallT] !== Terrain.Wall || grid.buildingId[wallT] !== b.id) continue;
      const outT = wallT + step;
      const x = outT % W, y = Math.floor(outT / W);
      if (!grid.inBounds(x, y)) continue;
      const ot = grid.terrain[outT];
      if (ot !== Terrain.Street && ot !== Terrain.Grass) continue;
      cands.push({ t: wallT, roadDist: nearestRoadDist(outT, W, roadSet) });
    }
  }
  if (cands.length === 0) return;
  cands.sort((a, c) => a.roadDist - c.roadDist);
  const first = cands[0];
  grid.terrain[first.t] = Terrain.Door;
  b.doorTiles.push(first.t);
  // second door on large buildings, far from the first
  if (b.sizeClass === 'large' && cands.length > 4) {
    const fx = first.t % W, fy = Math.floor(first.t / W);
    const far = cands
      .slice(1)
      .sort((a, c) => tileDist(c.t, fx, fy, W) - tileDist(a.t, fx, fy, W))[0];
    if (far && tileDist(far.t, fx, fy, W) > 6) {
      grid.terrain[far.t] = Terrain.Door;
      b.doorTiles.push(far.t);
    }
  }
  void rng;
}

function nearestRoadDist(t: number, w: number, roadSet: Set<number>): number {
  if (roadSet.size === 0) return 0;
  const x = t % w, y = Math.floor(t / w);
  let best = Infinity;
  // coarse: sample road set (fine for prototype sizes)
  let i = 0;
  for (const r of roadSet) {
    if (++i % 3 !== 0 && roadSet.size > 600) continue;
    const rx = r % w, ry = Math.floor(r / w);
    const d = Math.abs(rx - x) + Math.abs(ry - y);
    if (d < best) best = d;
  }
  return best;
}

function tileDist(t: number, x: number, y: number, w: number): number {
  return Math.abs((t % w) - x) + Math.abs(Math.floor(t / w) - y);
}

/**
 * Guarantee: from the largest street component, every building floor tile is
 * reachable. Carves extra doors where needed (courtyard buildings, sealed
 * BSP rooms, row houses with no street frontage).
 */
function ensureConnectivity(grid: TileGrid, buildings: BuildingInfo[], rng: RNG): void {
  const W = grid.width;
  const H = grid.height;
  const size = W * H;

  const reach = () => {
    // BFS over walkable from largest street component seed
    const visited = new Uint8Array(size);
    // seed: walkable street tile in largest component — approximate by BFS from
    // every unvisited street tile, keep largest.
    let bestComp: number[] = [];
    const compVisited = new Uint8Array(size);
    for (let s = 0; s < size; s++) {
      if (compVisited[s] || grid.terrain[s] !== Terrain.Street) continue;
      const comp: number[] = [];
      const q = [s];
      compVisited[s] = 1;
      while (q.length) {
        const t = q.pop()!;
        comp.push(t);
        const x = t % W, y = Math.floor(t / W);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = x + dx, ny = y + dy;
          if (!grid.inBounds(nx, ny)) continue;
          const nt = ny * W + nx;
          if (!compVisited[nt] && grid.walkable(nx, ny)) {
            compVisited[nt] = 1;
            q.push(nt);
          }
        }
      }
      if (comp.length > bestComp.length) bestComp = comp;
      if (bestComp.length > size / 3) break; // good enough
    }
    for (const t of bestComp) visited[t] = 1;
    return visited;
  };

  for (let pass = 0; pass < 6; pass++) {
    const visited = reach();
    let carved = 0;
    for (const b of buildings) {
      const unreached = b.floorTiles.filter(
        (t) => grid.terrain[t] === Terrain.Floor && !visited[t],
      );
      if (unreached.length === 0) continue;
      // find a wall adjacent to an unreached floor whose other side is reached walkable
      const options: number[] = [];
      for (const f of unreached) {
        for (const step of [1, -1, W, -W]) {
          const wallT = f + step;
          const outT = wallT + step;
          if (outT < 0 || outT >= size) continue;
          if (grid.terrain[wallT] !== Terrain.Wall) continue;
          const ox = outT % W, oy = Math.floor(outT / W);
          if (!grid.inBounds(ox, oy)) continue;
          if (visited[outT] && grid.walkable(ox, oy)) options.push(wallT);
        }
      }
      if (options.length > 0) {
        const doorT = rng.pick(options);
        grid.terrain[doorT] = Terrain.Door;
        if (grid.buildingId[doorT] === b.id) b.doorTiles.push(doorT);
        carved++;
      } else {
        // last resort: knock through any single wall between unreached floor and ANY walkable
        outer: for (const f of unreached) {
          for (const step of [1, -1, W, -W]) {
            const wallT = f + step;
            const outT = wallT + step;
            if (outT < 0 || outT >= size) continue;
            const ox = outT % W, oy = Math.floor(outT / W);
            if (grid.terrain[wallT] === Terrain.Wall && grid.inBounds(ox, oy) && grid.walkable(ox, oy)) {
              grid.terrain[wallT] = Terrain.Door;
              carved++;
              break outer;
            }
          }
        }
      }
    }
    if (carved === 0) break;
  }
}

/** Punch windows into exterior shell walls: ~1 per 5 wall tiles, spaced out, never beside a door. */
function placeWindows(grid: TileGrid, buildings: BuildingInfo[], rng: RNG): void {
  const W = grid.width;
  for (const b of buildings) {
    if (b.floorTiles.length < 5) continue;
    const cands: number[] = [];
    const seen = new Set<number>();
    for (const f of b.floorTiles) {
      for (const step of [1, -1, W, -W]) {
        const wallT = f + step;
        if (seen.has(wallT)) continue;
        seen.add(wallT);
        if (grid.terrain[wallT] !== Terrain.Wall || grid.buildingId[wallT] !== b.id) continue;
        const outT = wallT + step;
        const ox = outT % W;
        const oy = Math.floor(outT / W);
        if (!grid.inBounds(ox, oy)) continue;
        const ot = grid.terrain[outT];
        if (ot !== Terrain.Street && ot !== Terrain.Grass) continue;
        let nearDoor = false;
        for (const s2 of [1, -1, W, -W]) {
          if (grid.terrain[wallT + s2] === Terrain.Door) nearDoor = true;
        }
        if (!nearDoor) cands.push(wallT);
      }
    }
    rng.shuffle(cands);
    const maxWin = Math.max(1, Math.round(cands.length / 5));
    const placed: number[] = [];
    for (const t of cands) {
      if (placed.length >= maxWin) break;
      const tx = t % W;
      const ty = Math.floor(t / W);
      const crowded = placed.some(
        (p) => Math.abs((p % W) - tx) + Math.abs(Math.floor(p / W) - ty) < 3,
      );
      if (crowded) continue;
      grid.terrain[t] = Terrain.Window;
      placed.push(t);
    }
    b.windowTiles = placed;
  }
}

function computeRooms(grid: TileGrid, b: BuildingInfo): RoomInfo[] {
  const W = grid.width;
  const rooms: RoomInfo[] = [];
  const seen = new Set<number>();
  for (const start of b.floorTiles) {
    if (seen.has(start) || grid.terrain[start] !== Terrain.Floor) continue;
    const tiles: number[] = [];
    const q = [start];
    seen.add(start);
    while (q.length) {
      const t = q.pop()!;
      tiles.push(t);
      grid.roomId[t] = rooms.length;
      for (const step of [1, -1, W, -W]) {
        const n = t + step;
        if (!seen.has(n) && grid.terrain[n] === Terrain.Floor && grid.buildingId[n] === b.id) {
          seen.add(n);
          q.push(n);
        }
      }
    }
    rooms.push({ id: rooms.length, tiles });
  }
  return rooms;
}
