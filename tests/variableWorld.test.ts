import { describe, expect, it, vi } from 'vitest';
import { SimulationState } from '../src/simulation/state';
import { generateMap, presetParameters } from '../src/terrain/generator';
import { createChunks, groupByChunk, worldToChunk } from '../src/world/types';
import { createWorldMetadata } from '../src/world/metadata';
import { HeightmapTerrain } from '../src/terrain/heightmap';

describe('variable worlds', () => {
  it('partitions 5000 camera/world cells once as chunk count grows', () => {
    const world = createWorldMetadata({ worldWidthMeters: 4096, worldDepthMeters: 4096 });
    const cells = Array.from({ length: 5000 }, (_, i) => ({ x: -2000 + i % 100 * 40, z: -2000 + Math.floor(i / 100) * 80 }));
    let reads = 0; const grouped = groupByChunk(cells, cell => { reads++; return cell; }, world);
    expect(reads).toBe(cells.length); expect(grouped.size).toBeGreaterThan(200);
    expect([...grouped.values()].reduce((sum, local) => sum + local.length, 0)).toBe(5000);
  });
  for (const width of [1024, 4096]) it(`generates, constructs at the ${width}m boundary, saves and loads exactly`, () => {
    const map = generateMap({ generatorVersion: 1, seed: 'variable-world', preset: 'flat-plains', parameters: presetParameters('flat-plains') },
      { worldWidthMeters: width, worldDepthMeters: width, terrainSampleSpacingMeters: 8 });
    const state = new SimulationState(); state.startGeneratedCity(map);
    state.execute({ type: 'build-road', input: { roadTypeId: 'small', geometry: { kind: 'polyline', points: [{ x: width / 2 - 100, z: 0 }, { x: width / 2, z: 0 }] } } });
    expect(state.traffic.snapshot().outsideConnections).toHaveLength(1);
    expect(() => state.execute({ type: 'build-road', input: { roadTypeId: 'small', geometry: { kind: 'polyline', points: [{ x: width / 2, z: 0 }, { x: width / 2 + 40, z: 0 }] } } })).toThrow();
    const saved = state.serialize(); const reloaded = new SimulationState(); reloaded.load(saved);
    expect(reloaded.worldMetadata).toEqual(state.worldMetadata);
    expect(reloaded.terrain.heights).toEqual(state.terrain.heights);
    expect(reloaded.graph.snapshot()).toEqual(state.graph.snapshot());
    expect(reloaded.snapshot(false).terrainHeightmap).toBeUndefined();
    expect(reloaded.snapshot(false).chunks).toHaveLength((width / 256) ** 2);
  });

  it('supports rectangular grids, partial edge chunks and local smoothing patches', () => {
    const world = createWorldMetadata({ worldWidthMeters: 4096, worldDepthMeters: 1104, terrainSampleSpacingMeters: 8 });
    const terrain = HeightmapTerrain.fromBuffer({ width: 4096, depth: 1104, baseHeight: 0, terrainVersion: 1,
      settings: { sampleSpacing: 8, minHeight: -80, maxHeight: 240, preset: 'flat' } }, new Float32Array(world.terrainColumns * world.terrainRows));
    expect(createChunks(world)).toHaveLength(80);
    expect(worldToChunk({ x: 2048, z: 552 }, world)).toEqual({ x: 15, z: 4 });
    const edge = terrain.patchForChunk('chunk-15-4'); expect(edge.rows).toBe(11); expect(edge.columns).toBe(33);
    const copy = vi.spyOn(terrain, 'cloneHeights');
    const chunks = terrain.applyBrush({ mode: 'raise', center: { x: 1800, z: 440 }, size: 40, strength: 5, seconds: .1 }, new Map());
    terrain.applyBrush({ mode: 'smooth', center: { x: 1800, z: 440 }, size: 40, strength: 5, seconds: .1 }, new Map());
    expect(copy).not.toHaveBeenCalled(); expect(chunks.length).toBeLessThanOrEqual(4);
    expect(terrain.getHeight(1800, 440)).toBeGreaterThan(0);
    expect(terrain.patchForChunk(chunks[0]).heights.byteLength).toBeLessThan(terrain.byteLength / 20);
  });
});
