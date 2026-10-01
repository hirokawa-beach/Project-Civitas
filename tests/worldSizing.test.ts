import { describe, expect, it } from 'vitest';
import { safeTerrainSpacing, safeTerrainSpacings, WORLD_SIZE_OPTIONS, UI_TERRAIN_SAMPLE_BUDGET } from '../src/world/worldSizing';
import { createWorldMetadata } from '../src/world/metadata';
import { generateMap, presetParameters } from '../src/terrain/generator';
import { SimulationState } from '../src/simulation/state';

describe('safe large physical worlds', () => {
  it('offers only constructible grids for every rectangular UI combination, including 16km and 32km', () => {
    expect(WORLD_SIZE_OPTIONS).toContain(32768);
    expect(safeTerrainSpacings(16384, 16384)).not.toContain(4);
    expect(safeTerrainSpacing(16384, 16384, 4)).toBe(16);
    expect(safeTerrainSpacing(32768, 32768, 4)).toBe(32);
    for (const width of WORLD_SIZE_OPTIONS) for (const depth of WORLD_SIZE_OPTIONS) for (const spacing of safeTerrainSpacings(width, depth)) {
      const world = createWorldMetadata({ worldWidthMeters: width, worldDepthMeters: depth, terrainSampleSpacingMeters: spacing });
      expect(world.terrainColumns * world.terrainRows).toBeLessThanOrEqual(UI_TERRAIN_SAMPLE_BUDGET);
    }
    expect(createWorldMetadata({ worldWidthMeters: 65536, worldDepthMeters: 65536, terrainSampleSpacingMeters: 64 }).terrainColumns).toBe(1025);
  });
  for (const size of [16384, 32768]) it(`generates and reloads ${size}m with a bounded grid and local dirty patches`, () => {
    const spacing = safeTerrainSpacing(size, size);
    const map = generateMap({ generatorVersion: 1, seed: 'large-owned-world', preset: 'flat-plains', parameters: presetParameters('flat-plains') }, { worldWidthMeters: size, worldDepthMeters: size, terrainSampleSpacingMeters: spacing });
    expect(map.heights.length).toBe(1025 * 1025);
    const state = new SimulationState(); state.startGeneratedCity(map);
    state.consumeTerrainUpdate();
    state.beginTerrainStroke({ x: 0, z: 0 }, 'raise', 128, 10); state.applyTerrainStroke([{ x: 0, z: 0 }], .2); state.endTerrainStroke();
    const local = state.consumeTerrainUpdate()!; expect(local.chunkIds.length).toBeLessThanOrEqual(4); expect(local.messageBytes).toBeLessThan(50000);
    expect(state.snapshot(false).terrainHeightmap).toBeUndefined(); expect(state.landOwnership.save().ownedTiles).toEqual([]);
    const saved = state.serialize(); const reloaded = new SimulationState(); reloaded.load(saved);
    expect(reloaded.worldMetadata).toEqual(state.worldMetadata); expect(reloaded.terrain.heights).toEqual(state.terrain.heights);
  }, 30000);
});
