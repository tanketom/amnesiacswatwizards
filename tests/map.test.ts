import { describe, it, expect } from 'vitest';
import { generateFallbackCity } from '../src/map/fallbackCity';
import { rasterizeCity } from '../src/map/rasterize';
import { importMfcg } from '../src/map/mfcgImport';
import { Terrain } from '../src/core/grid';
import { RNG } from '../src/core/rng';
import { EventBus } from '../src/core/events';
import { generateQuest } from '../src/sim/quest';
import { Knowledge } from '../src/sim/intel';
import northchurch from './fixtures/northchurch.json';

function reachableFloorFraction(raster: ReturnType<typeof rasterizeCity>): number {
  const { grid, buildings } = raster;
  const W = grid.width;
  const size = W * grid.height;
  // Seed the BFS from the main street network: the exterior side of a kept
  // building's door is guaranteed (by the rasterizer) to touch it.
  let seed = -1;
  outer: for (const b of buildings) {
    for (const d of b.doorTiles) {
      for (const step of [1, -1, W, -W]) {
        const t = d + step;
        if (t >= 0 && t < size && grid.terrain[t] === Terrain.Street) { seed = t; break outer; }
      }
    }
  }
  expect(seed).toBeGreaterThanOrEqual(0);
  const visited = new Uint8Array(size);
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
  let total = 0;
  let reached = 0;
  for (const b of buildings) {
    for (const f of b.floorTiles) {
      if (grid.terrain[f] !== Terrain.Floor) continue;
      total++;
      if (visited[f]) reached++;
    }
  }
  return total === 0 ? 1 : reached / total;
}

describe('fallback city + rasterizer', () => {
  for (const seed of [1, 1337, 987654]) {
    it(`seed ${seed}: buildings have doors and reachable interiors`, () => {
      const city = generateFallbackCity(seed);
      const raster = rasterizeCity(city, seed);
      expect(raster.buildings.length).toBeGreaterThan(20);
      const withDoors = raster.buildings.filter((b) => b.doorTiles.length > 0);
      expect(withDoors.length / raster.buildings.length).toBeGreaterThan(0.9);
      expect(reachableFloorFraction(raster)).toBeGreaterThan(0.98);
    });
  }

  const sameTerrain = (a: Uint8Array, b: Uint8Array) =>
    a.length === b.length && a.every((v, i) => v === b[i]);

  it('is deterministic: same seed -> identical terrain', () => {
    const a = rasterizeCity(generateFallbackCity(555), 555);
    const b = rasterizeCity(generateFallbackCity(555), 555);
    expect(sameTerrain(a.grid.terrain, b.grid.terrain)).toBe(true);
  });

  it('different seeds differ', () => {
    const a = rasterizeCity(generateFallbackCity(1), 1);
    const b = rasterizeCity(generateFallbackCity(2), 2);
    expect(sameTerrain(a.grid.terrain, b.grid.terrain)).toBe(false);
  });

  it('has multiple district tags for quest placement', () => {
    const raster = rasterizeCity(generateFallbackCity(42), 42);
    const tags = new Set(raster.buildings.map((b) => b.district));
    expect(tags.size).toBeGreaterThanOrEqual(4);
  });
});

describe('MFCG import', () => {
  it('parses a synthetic GeoJSON export', () => {
    const gj = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          id: 'buildings',
          geometry: {
            type: 'MultiPolygon',
            coordinates: [
              [[[0, 0], [12, 0], [12, 10], [0, 10], [0, 0]]],
              [[[20, 0], [34, 0], [34, 12], [20, 12], [20, 0]]],
              [[[0, 20], [14, 20], [14, 32], [0, 32], [0, 20]]],
            ],
          },
        },
        {
          type: 'Feature',
          id: 'roads',
          geometry: { type: 'MultiLineString', coordinates: [[[16, -40], [16, 60]]] },
        },
        {
          type: 'Feature',
          id: 'districts',
          properties: { name: 'Market' },
          geometry: {
            type: 'Polygon',
            coordinates: [[[-50, -50], [100, -50], [100, 100], [-50, 100], [-50, -50]]],
          },
        },
      ],
    };
    const model = importMfcg(gj, { width: 60, height: 60, seed: 1 });
    expect(model.buildings.length).toBe(3);
    expect(model.roads.length).toBe(1);
    expect(model.buildings[0].district).toBe('market');
    const raster = rasterizeCity(model, 1);
    expect(raster.buildings.length).toBeGreaterThan(0);
  });

  it('throws on garbage', () => {
    expect(() => importMfcg({ hello: 'world' })).toThrow();
  });
});

describe('Northchurch — real MFCG v0.11 export', () => {
  it('imports all the layers', () => {
    const model = importMfcg(northchurch, { seed: 7, name: 'Northchurch' });
    expect(model.buildings.length).toBeGreaterThan(80);
    expect(model.districts.length).toBe(6);
    expect(model.roads.length).toBeGreaterThan(0);
    expect(model.water.length).toBeGreaterThan(0); // sea + thickened river
    // real quarter names survive for clue text
    expect(model.districts.some((d) => d.label === 'Apple Ring')).toBe(true);
    // heuristic tags provide the gameplay vocabulary
    expect(model.districts.some((d) => d.name === 'market')).toBe(true);
  });

  for (const seed of [7, 4242]) {
    it(`seed ${seed}: rasterizes with reachable interiors and a solvable quest`, () => {
      const model = importMfcg(northchurch, { seed, name: 'Northchurch' });
      const raster = rasterizeCity(model, seed);
      expect(raster.buildings.length).toBeGreaterThan(30);
      expect(reachableFloorFraction(raster)).toBeGreaterThan(0.98);
      const setup = generateQuest(raster, new RNG(seed));
      const k = new Knowledge(raster, setup.quest.targetBuilding, new EventBus());
      for (const clue of setup.quest.chain) k.learnClue(clue);
      expect(k.targetBuildingKnown).toBe(setup.quest.targetBuilding);
    });
  }
});
