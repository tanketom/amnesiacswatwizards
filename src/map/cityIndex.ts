/** Semantic attributes of buildings — the vocabulary clues filter on. */
import { Terrain } from '../core/grid';
import type { RasterCity, BuildingInfo } from './rasterize';

export interface BuildingAttrs {
  /** Unique quarter key used by clue filters (the display label). */
  district: string;
  size: 'small' | 'medium' | 'large';
  quadrant: 'north-west' | 'north-east' | 'south-west' | 'south-east';
  facing: 'north' | 'south' | 'east' | 'west';
}

export function buildingAttrs(raster: RasterCity, b: BuildingInfo): BuildingAttrs {
  const { grid } = raster;
  const west = b.centroid.x < grid.width / 2;
  const north = b.centroid.y < grid.height / 2;
  const quadrant = `${north ? 'north' : 'south'}-${west ? 'west' : 'east'}` as BuildingAttrs['quadrant'];

  let facing: BuildingAttrs['facing'] = 'south';
  if (b.doorTiles.length > 0) {
    const d = b.doorTiles[0];
    const W = grid.width;
    const x = d % W;
    const y = Math.floor(d / W);
    // exterior side = walkable non-building neighbor
    const sides: [number, number, BuildingAttrs['facing']][] = [
      [0, -1, 'north'], [0, 1, 'south'], [1, 0, 'east'], [-1, 0, 'west'],
    ];
    for (const [dx, dy, f] of sides) {
      const t = grid.get(x + dx, y + dy);
      if ((t === Terrain.Street || t === Terrain.Grass) && grid.buildingId[(y + dy) * W + (x + dx)] === -1) {
        facing = f;
        break;
      }
    }
  }
  return { district: b.districtName, size: b.sizeClass, quadrant, facing };
}

/** Buildings big enough to matter for quests. */
export function questableBuildings(raster: RasterCity): BuildingInfo[] {
  return raster.buildings.filter((b) => b.floorTiles.length >= 9 && b.doorTiles.length > 0);
}
