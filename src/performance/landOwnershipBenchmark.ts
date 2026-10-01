import { SimulationState } from '../simulation/state';
import { generateMap, presetParameters } from '../terrain/generator';
import { mapAssetFromGenerated } from '../maps/mapAsset';
import { defaultLandOwnership } from '../world/landOwnership';
import { safeTerrainSpacing } from '../world/worldSizing';
import { payloadBytes } from './metrics';

/** Bounded-resolution physical worlds; no synthetic terrain-tile simulation. */
export function runLandOwnershipBenchmarks() {
  const seed = 'land-ownership-foundation';
  return { version: 1, seed, preset: 'flat-plains', scenarios: [1024, 4096, 16384, 32768].map(size => {
    const spacing = safeTerrainSpacing(size, size); let start = performance.now();
    const map = generateMap({ generatorVersion: 1, seed, preset: 'flat-plains', parameters: presetParameters('flat-plains') }, { worldWidthMeters: size, worldDepthMeters: size, terrainSampleSpacingMeters: spacing });
    const generationMs = performance.now() - start;
    const asset = mapAssetFromGenerated(map, { id: `land-${size}`, name: `${size}m`, description: '', author: 'Benchmark' });
    const state = new SimulationState(); start = performance.now(); state.startMapAsset(asset); const loadMs = performance.now() - start;
    state.consumeTerrainUpdate(); start = performance.now();
    state.beginTerrainStroke({ x: 0, z: 0 }, 'raise', 128, 5); state.applyTerrainStroke([{ x: 0, z: 0 }], .1); state.endTerrainStroke();
    const localEditMs = performance.now() - start; const patch = state.consumeTerrainUpdate();
    start = performance.now(); for (let i = 0; i < 100; i++) state.tick(.05); const emptyTick100Ms = performance.now() - start;
    start = performance.now(); const saved = state.serialize(); const serializeMs = performance.now() - start;
    const reload = new SimulationState(); start = performance.now(); reload.load(saved); const reloadMs = performance.now() - start;
    asset.world.landOwnership = defaultLandOwnership(asset.world, 'progressive');
    return { sizeMeters: size, spacingMeters: spacing, grid: [state.terrain.columns, state.terrain.rows], totalTerrainChunks: state.snapshot(false).chunks.length,
      terrainBytes: state.terrain.byteLength, normalSnapshotTerrainBytes: state.snapshot(false).terrainHeightmap?.byteLength ?? 0,
      entireMapOwnedTilesStored: state.landOwnership.save().ownedTiles.length, progressiveStartingTiles: asset.world.landOwnership.startingTiles.length,
      dirtyChunks: patch?.chunkIds.length ?? 0, patchBytes: patch?.messageBytes ?? 0, citySaveBytes: payloadBytes(saved),
      generationMs, loadMs, localEditMs, emptyTick100Ms, serializeMs, reloadMs };
  }) };
}
