import { describe, expect, it } from 'vitest';
import proj4 from 'proj4';
import { areaFromCorners, areaRegion } from '../src/dem/mapSelection';
import { GEOGRAPHIC_GRS80, importRegion } from '../src/dem/importer';
import { UI_TERRAIN_SAMPLE_BUDGET } from '../src/world/worldSizing';

describe('DEM visual area selection', () => {
  it('draws the exact metre footprint used by acquisition at Osaka, Rokko and Kyoto', () => {
    for (const [latitude, longitude, width, depth] of [[34.69, 135.5, 1024, 1024], [34.74, 135.23, 4096, 2048], [35, 135.75, 32768, 16384]]) {
      const area = { latitude, longitude, width, depth, spacing: 64 };
      const selection = areaRegion(area), transform = proj4(GEOGRAPHIC_GRS80, selection.crs);
      const corners = [0, 17, 34, 51].map(i => transform.forward([selection.outline[i][1], selection.outline[i][0]]));
      expect(corners[0][0]).toBeCloseTo(-width / 2, 4); expect(corners[0][1]).toBeCloseTo(depth / 2, 4);
      expect(corners[2][0]).toBeCloseTo(width / 2, 4); expect(corners[2][1]).toBeCloseTo(-depth / 2, 4);
      const importer = importRegion({ latitude, longitude, dimensions: selection.world, identity: { id: 'test', name: 'test', author: '', description: '' } });
      expect(selection.bounds).toEqual(importer.bounds);
      expect(Math.min(...selection.outline.map(p => p[1]))).toBe(selection.bounds.west);
      expect(Math.max(...selection.outline.map(p => p[0]))).toBe(selection.bounds.north);
    }
  });
  it('converts corner clicks into physical metres and safe rectangular grids in either click order', () => {
    const first = { lat: 34.700, lng: 135.490 }, second = { lat: 34.680, lng: 135.510 };
    const area = areaFromCorners(first, second);
    expect(area.latitude).toBeCloseTo(34.69); expect(area.longitude).toBeCloseTo(135.5);
    expect(area.width).toBe(1856); expect(area.depth).toBe(2240);
    expect(areaFromCorners(second, first)).toEqual(area);
    const large = areaFromCorners({ lat: 34.82, lng: 135.35 }, { lat: 34.56, lng: 135.65 }, 4);
    const { world } = areaRegion(large);
    expect(large.spacing).toBe(32);
    expect(world.terrainColumns * world.terrainRows).toBeLessThanOrEqual(UI_TERRAIN_SAMPLE_BUDGET);
    expect(Number.isInteger(world.terrainColumns)).toBe(true);
    expect(Number.isInteger(world.terrainRows)).toBe(true);
  });
  it('rounds tiny selections to a valid minimum and rejects unsupported areas without silently clipping', () => {
    expect(areaFromCorners({ lat: 35, lng: 135 }, { lat: 35, lng: 135 })).toMatchObject({ width: 64, depth: 64 });
    for (const [a, b] of [
      [{ lat: NaN, lng: 135 }, { lat: 35, lng: 135 }],
      [{ lat: 81, lng: 135 }, { lat: 80, lng: 135 }],
      [{ lat: 35, lng: 179.9 }, { lat: 35.1, lng: -179.9 }],
      [{ lat: 34, lng: 135 }, { lat: 35, lng: 135.5 }],
    ]) expect(() => areaFromCorners(a, b)).toThrow();
  });
});
