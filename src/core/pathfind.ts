import { TileGrid, Terrain, Pt } from './grid';

/** Extra movement cost (scaled x2) for hauling yourself through a window. */
export const WINDOW_CLIMB_COST = 4;

function stepCostInto(grid: TileGrid, x: number, y: number, diagonal: boolean): number {
  const base = diagonal ? 3 : 2; // 1.5 : 1 tiles, scaled x2
  return grid.get(x, y) === Terrain.Window ? base + WINDOW_CLIMB_COST : base;
}

/** Binary min-heap keyed on f-score. */
class Heap {
  private items: number[] = []; // node index
  private scores: number[] = [];

  push(node: number, score: number): void {
    this.items.push(node);
    this.scores.push(score);
    let i = this.items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.scores[p] <= this.scores[i]) break;
      this.swap(i, p);
      i = p;
    }
  }

  pop(): number | undefined {
    if (this.items.length === 0) return undefined;
    const top = this.items[0];
    const lastI = this.items.pop()!;
    const lastS = this.scores.pop()!;
    if (this.items.length > 0) {
      this.items[0] = lastI;
      this.scores[0] = lastS;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < this.items.length && this.scores[l] < this.scores[m]) m = l;
        if (r < this.items.length && this.scores[r] < this.scores[m]) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }

  get size(): number {
    return this.items.length;
  }

  private swap(a: number, b: number): void {
    [this.items[a], this.items[b]] = [this.items[b], this.items[a]];
    [this.scores[a], this.scores[b]] = [this.scores[b], this.scores[a]];
  }
}

const DIRS = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];

export interface PathOptions {
  /** Tiles other units occupy; blocked except the goal itself (so you can path "to" a unit). */
  blocked?: Set<number>;
  maxCost?: number;
}

/**
 * A* on the grid, 8-directional. Diagonal cost 1.5 (scaled x2 internally: 2/3).
 * No corner cutting past walls. Returns tile path excluding start, or null.
 */
export function findPath(
  grid: TileGrid,
  start: Pt,
  goal: Pt,
  opts: PathOptions = {},
): Pt[] | null {
  if (!grid.walkable(goal.x, goal.y)) return null;
  const w = grid.width;
  const startI = start.y * w + start.x;
  const goalI = goal.y * w + goal.x;
  if (startI === goalI) return [];

  const gScore = new Map<number, number>();
  const cameFrom = new Map<number, number>();
  const heap = new Heap();
  gScore.set(startI, 0);
  heap.push(startI, 0);

  const h = (x: number, y: number) => {
    const dx = Math.abs(x - goal.x);
    const dy = Math.abs(y - goal.y);
    return 2 * Math.max(dx, dy) + Math.min(dx, dy); // octile, scaled x2
  };

  const maxCost = (opts.maxCost ?? Infinity) * 2;

  while (heap.size > 0) {
    const cur = heap.pop()!;
    if (cur === goalI) {
      const path: Pt[] = [];
      let n = goalI;
      while (n !== startI) {
        path.push({ x: n % w, y: Math.floor(n / w) });
        n = cameFrom.get(n)!;
      }
      path.reverse();
      return path;
    }
    const cx = cur % w;
    const cy = Math.floor(cur / w);
    const cg = gScore.get(cur)!;

    for (const [dx, dy] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!grid.walkable(nx, ny)) continue;
      const ni = ny * w + nx;
      if (opts.blocked?.has(ni) && ni !== goalI) continue;
      // no diagonal corner cutting
      if (dx !== 0 && dy !== 0) {
        if (!grid.walkable(cx + dx, cy) || !grid.walkable(cx, cy + dy)) continue;
      }
      const ng = cg + stepCostInto(grid, nx, ny, dx !== 0 && dy !== 0);
      if (ng > maxCost) continue;
      if (ng < (gScore.get(ni) ?? Infinity)) {
        gScore.set(ni, ng);
        cameFrom.set(ni, cur);
        heap.push(ni, ng + h(nx, ny));
      }
    }
  }
  return null;
}

/** All tiles reachable within moveCost tiles (orthogonal=1, diagonal=1.5). Returns map tileIndex -> cost. */
export function reachable(
  grid: TileGrid,
  start: Pt,
  moveCost: number,
  blocked?: Set<number>,
): Map<number, number> {
  const w = grid.width;
  const startI = start.y * w + start.x;
  const dist = new Map<number, number>();
  dist.set(startI, 0);
  const heap = new Heap();
  heap.push(startI, 0);
  const max = moveCost * 2;

  while (heap.size > 0) {
    const cur = heap.pop()!;
    const cg = dist.get(cur)!;
    const cx = cur % w;
    const cy = Math.floor(cur / w);
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!grid.walkable(nx, ny)) continue;
      const ni = ny * w + nx;
      if (blocked?.has(ni)) continue;
      if (dx !== 0 && dy !== 0) {
        if (!grid.walkable(cx + dx, cy) || !grid.walkable(cx, cy + dy)) continue;
      }
      const ng = cg + stepCostInto(grid, nx, ny, dx !== 0 && dy !== 0);
      if (ng > max) continue;
      if (ng < (dist.get(ni) ?? Infinity)) {
        dist.set(ni, ng);
        heap.push(ni, ng);
      }
    }
  }
  dist.delete(startI);
  return dist;
}
