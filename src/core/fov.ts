import { TileGrid, Pt } from './grid';

/**
 * Recursive shadowcasting over 8 octants.
 * Returns the set of visible tile indices (y*width+x) within radius.
 */
export function computeFov(grid: TileGrid, origin: Pt, radius: number): Set<number> {
  const visible = new Set<number>();
  const w = grid.width;
  visible.add(origin.y * w + origin.x);

  // Octant transforms: [xx, xy, yx, yy]
  const OCTANTS: [number, number, number, number][] = [
    [1, 0, 0, 1], [0, 1, 1, 0], [0, -1, 1, 0], [-1, 0, 0, 1],
    [-1, 0, 0, -1], [0, -1, -1, 0], [0, 1, -1, 0], [1, 0, 0, -1],
  ];

  const r2 = radius * radius;

  const castLight = (
    row: number,
    startSlope: number,
    endSlope: number,
    xx: number,
    xy: number,
    yx: number,
    yy: number,
  ): void => {
    if (startSlope < endSlope) return;
    let nextStart = startSlope;
    for (let i = row; i <= radius; i++) {
      let blocked = false;
      for (let dx = -i, dy = -i; dx <= 0; dx++) {
        const lSlope = (dx - 0.5) / (dy + 0.5);
        const rSlope = (dx + 0.5) / (dy - 0.5);
        if (startSlope < rSlope) continue;
        if (endSlope > lSlope) break;

        const ax = origin.x + dx * xx + dy * xy;
        const ay = origin.y + dx * yx + dy * yy;
        if (!grid.inBounds(ax, ay)) continue;
        if (dx * dx + dy * dy <= r2) {
          visible.add(ay * w + ax);
        }

        if (blocked) {
          if (grid.opaque(ax, ay)) {
            nextStart = rSlope;
            continue;
          } else {
            blocked = false;
            startSlope = nextStart;
          }
        } else if (grid.opaque(ax, ay) && i < radius) {
          blocked = true;
          castLight(i + 1, startSlope, lSlope, xx, xy, yx, yy);
          nextStart = rSlope;
        }
      }
      if (blocked) break;
    }
  };

  for (const [xx, xy, yx, yy] of OCTANTS) {
    castLight(1, 1.0, 0.0, xx, xy, yx, yy);
  }
  return visible;
}

/** Symmetric-enough LOS check between two tiles: Bresenham, blocked by opaque tiles between endpoints. */
export function hasLos(grid: TileGrid, a: Pt, b: Pt): boolean {
  let x0 = a.x, y0 = a.y;
  const x1 = b.x, y1 = b.y;
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    if (x0 === x1 && y0 === y1) return true;
    // endpoints themselves may be opaque (unit standing in a door)
    if (!(x0 === a.x && y0 === a.y) && grid.opaque(x0, y0)) return false;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
}
