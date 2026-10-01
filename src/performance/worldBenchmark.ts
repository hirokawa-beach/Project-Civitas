import { SimulationState } from '../simulation/state';
import { generateMap, presetParameters } from '../terrain/generator';
import { mapAssetFromGenerated } from '../maps/mapAsset';
import { payloadBytes } from './metrics';

/** Same local brush and 1,000 hydrography queries on deterministic 1km/4km worlds. */
export function runWorldBenchmarks() {
  return { version: 1, seed: 'world-foundation-benchmark', scenarios: [1024, 4096].map(size => {
    let start = performance.now();
    const map = generateMap({ generatorVersion: 1, seed: 'world-foundation-benchmark', preset: 'coastal', parameters: presetParameters('coastal') },
      { worldWidthMeters: size, worldDepthMeters: size, terrainSampleSpacingMeters: 8 });
    const generationMs = performance.now() - start;
    const asset = mapAssetFromGenerated(map, { id: `world-${size}`, name: `${size}m`, description: '', author: 'Benchmark' });
    const state = new SimulationState(); start = performance.now(); state.startMapAsset(asset);
    const initialLoadMs = performance.now() - start;
    state.consumeTerrainUpdate(); start = performance.now();
    state.beginTerrainStroke({ x: 0, z: 0 }, 'raise', 40, 5); state.applyTerrainStroke([{ x: 0, z: 0 }], .1); state.endTerrainStroke();
    const localEditMs = performance.now() - start; const delta = state.consumeTerrainUpdate();
    start = performance.now(); for (let i = 0; i < 1000; i++) state.water.isWaterAt((i % 50 - 25) * 4, (Math.floor(i / 50) - 10) * 4, state.terrain);
    const waterQuery1000Ms = performance.now() - start;
    start = performance.now(); const save = state.serialize(); const citySaveMs = performance.now() - start;
    const reload = new SimulationState(); start = performance.now(); reload.load(save); const reloadMs = performance.now() - start;
    return { sizeMeters: size, sampleSpacingMeters: 8, grid: [state.terrain.columns, state.terrain.rows],
      totalChunks: state.snapshot(false).chunks.length, terrainBytes: state.terrain.byteLength,
      normalSnapshotTerrainBytes: state.snapshot(false).terrainHeightmap?.byteLength ?? 0,
      patchBytes: delta?.messageBytes ?? 0, dirtyChunks: delta?.chunkIds.length ?? 0,
      assetBytes: payloadBytes(asset), citySaveBytes: payloadBytes(save), waterBodies: state.worldMetadata.waterBodies.length,
      generationMs, initialLoadMs, localEditMs, waterQuery1000Ms, citySaveMs, reloadMs };
  }) };
}
