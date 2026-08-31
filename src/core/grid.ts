/** Tactical tile grid. 1 tile ~ 1.5m. */

export enum Terrain {
  Street = 0,
  Floor = 1, // building interior
  Wall = 2,
  Door = 3,
  Water = 4,
  Cover = 5, // tree / cart / barrel: walkable-adjacent half cover, blocks movement not sight
  Grass = 6,
  Void = 7, // outside playable crop
  Window = 8, // wall opening: see through always, climb through slowly & loudly
  Container = 9, // chest / cupboard: blocks movement, half cover, searchable, hides bodies
}

export interface Pt {
  x: number;
  y: number;
}

export function key(x: number, y: number): number {
  return y * 4096 + x;
}

export class TileGrid {
  readonly width: number;
  readonly height: number;
  readonly terrain: Uint8Array;
  /** Building id per tile, -1 for none. Shared by walls, floors and doors of that building. */
  readonly buildingId: Int32Array;
  /** Room id per interior tile, -1 outside rooms. */
  readonly roomId: Int32Array;
  /** 1 = this door has been opened (breached doors stay open). */
  readonly doorOpen: Uint8Array;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.terrain = new Uint8Array(width * height).fill(Terrain.Void);
    this.buildingId = new Int32Array(width * height).fill(-1);
    this.roomId = new Int32Array(width * height).fill(-1);
    this.doorOpen = new Uint8Array(width * height);
  }

  /** Shared open-state for doors AND windows (a smashed/opened window stays open). */
  opened(x: number, y: number): boolean {
    return this.inBounds(x, y) && this.doorOpen[this.idx(x, y)] === 1;
  }

  isDoorOpen(x: number, y: number): boolean {
    return this.opened(x, y);
  }

  /** Returns true if this actually opened a closed door. */
  openDoor(x: number, y: number): boolean {
    if (!this.inBounds(x, y)) return false;
    const i = this.idx(x, y);
    if (this.terrain[i] !== Terrain.Door || this.doorOpen[i] === 1) return false;
    this.doorOpen[i] = 1;
    return true;
  }

  /** Returns true if this actually opened (or smashed) an intact window. */
  openWindow(x: number, y: number): boolean {
    if (!this.inBounds(x, y)) return false;
    const i = this.idx(x, y);
    if (this.terrain[i] !== Terrain.Window || this.doorOpen[i] === 1) return false;
    this.doorOpen[i] = 1;
    return true;
  }

  idx(x: number, y: number): number {
    return y * this.width + x;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  get(x: number, y: number): Terrain {
    return this.inBounds(x, y) ? this.terrain[this.idx(x, y)] : Terrain.Void;
  }

  set(x: number, y: number, t: Terrain): void {
    if (this.inBounds(x, y)) this.terrain[this.idx(x, y)] = t;
  }

  /** Can a unit stand here (ignoring occupancy)? */
  walkable(x: number, y: number): boolean {
    const t = this.get(x, y);
    return (
      t === Terrain.Street || t === Terrain.Floor || t === Terrain.Door ||
      t === Terrain.Grass || t === Terrain.Window
    );
  }

  /** Does this tile block line of sight? Open doors and windows do not. */
  opaque(x: number, y: number): boolean {
    const t = this.get(x, y);
    if (t === Terrain.Door) return this.doorOpen[this.idx(x, y)] !== 1;
    return t === Terrain.Wall || t === Terrain.Void;
  }

  /** Cover element on the (dx,dy) side of tile (x,y): 0 none, 1 half (props), 2 full (walls). */
  coverAt(x: number, y: number, dx: number, dy: number): CoverLevel {
    const t = this.get(x + dx, y + dy);
    if (t === Terrain.Door) return this.isDoorOpen(x + dx, y + dy) ? 0 : 2;
    if (t === Terrain.Wall) return 2;
    if (t === Terrain.Cover || t === Terrain.Window || t === Terrain.Container) return 1;
    return 0;
  }

  /**
   * Effective cover for a defender at (x,y) against fire from (fx,fy):
   * the best cover element on the side(s) facing the attacker. An attacker
   * with no cover element between them and the defender is flanking (0).
   */
  coverFrom(x: number, y: number, fx: number, fy: number): CoverLevel {
    const sx = Math.sign(fx - x);
    const sy = Math.sign(fy - y);
    let best: CoverLevel = 0;
    if (sx !== 0) best = Math.max(best, this.coverAt(x, y, sx, 0)) as CoverLevel;
    if (sy !== 0) best = Math.max(best, this.coverAt(x, y, 0, sy)) as CoverLevel;
    return best;
  }
}

export type CoverLevel = 0 | 1 | 2;

/** Aim penalty for a cover level: none, half (-20), full (-40). */
export const COVER_PENALTY: Record<CoverLevel, number> = { 0: 0, 1: 20, 2: 40 };
