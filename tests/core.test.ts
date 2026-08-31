import { describe, it, expect } from 'vitest';
import { RNG, hashSeed } from '../src/core/rng';
import { TileGrid, Terrain } from '../src/core/grid';
import { findPath, reachable } from '../src/core/pathfind';
import { computeFov, hasLos } from '../src/core/fov';

describe('RNG', () => {
  it('is deterministic for the same seed', () => {
    const a = new RNG(42);
    const b = new RNG(42);
    for (let i = 0; i < 100; i++) expect(a.next()).toBe(b.next());
  });
  it('int stays within bounds', () => {
    const r = new RNG(7);
    for (let i = 0; i < 1000; i++) {
      const v = r.int(3, 9);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(9);
    }
  });
  it('hashSeed is stable', () => {
    expect(hashSeed('gloomhaven')).toBe(hashSeed('gloomhaven'));
    expect(hashSeed('a')).not.toBe(hashSeed('b'));
  });
});

function makeGrid(rows: string[]): TileGrid {
  const g = new TileGrid(rows[0].length, rows.length);
  for (let y = 0; y < rows.length; y++) {
    for (let x = 0; x < rows[0].length; x++) {
      g.set(x, y, rows[y][x] === '#' ? Terrain.Wall : Terrain.Street);
    }
  }
  return g;
}

describe('pathfind', () => {
  it('routes around walls', () => {
    const g = makeGrid([
      '.....',
      '.###.',
      '.#...',
      '.#.#.',
      '.....',
    ]);
    const path = findPath(g, { x: 0, y: 0 }, { x: 2, y: 2 });
    expect(path).not.toBeNull();
    const last = path![path!.length - 1];
    expect(last).toEqual({ x: 2, y: 2 });
    for (const p of path!) expect(g.walkable(p.x, p.y)).toBe(true);
  });

  it('returns null when goal is sealed', () => {
    const g = makeGrid([
      '.....',
      '.###.',
      '.#.#.',
      '.###.',
      '.....',
    ]);
    expect(findPath(g, { x: 0, y: 0 }, { x: 2, y: 2 })).toBeNull();
  });

  it('does not cut corners diagonally', () => {
    const g = makeGrid([
      '.#.',
      '#..',
      '...',
    ]);
    const path = findPath(g, { x: 0, y: 0 }, { x: 2, y: 0 });
    expect(path).toBeNull(); // only route would cut the corner at (1,1)... actually (0,0)->(1,1) cuts both walls
  });

  it('reachable respects move budget', () => {
    const g = makeGrid(['.'.repeat(20)]);
    const r = reachable(g, { x: 0, y: 0 }, 5);
    expect(r.has(5)).toBe(true);
    expect(r.has(6)).toBe(false);
  });
});

describe('fov', () => {
  it('walls block vision', () => {
    const g = makeGrid([
      '.......',
      '...#...',
      '.......',
    ]);
    const vis = computeFov(g, { x: 1, y: 1 }, 10);
    expect(vis.has(1 * 7 + 3)).toBe(true); // the wall itself is visible
    expect(vis.has(1 * 7 + 6)).toBe(false); // behind the wall is not
  });
  it('open field is fully visible within radius', () => {
    const g = makeGrid(['.....', '.....', '.....']);
    const vis = computeFov(g, { x: 2, y: 1 }, 2);
    expect(vis.has(1 * 5 + 0)).toBe(true);
    expect(vis.has(1 * 5 + 4)).toBe(true);
  });
  it('hasLos agrees on simple cases', () => {
    const g = makeGrid([
      '.....',
      '..#..',
      '.....',
    ]);
    expect(hasLos(g, { x: 0, y: 1 }, { x: 4, y: 1 })).toBe(false);
    expect(hasLos(g, { x: 0, y: 0 }, { x: 4, y: 0 })).toBe(true);
  });
});
