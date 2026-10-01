import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { blankMapAsset, builtInMaps, duplicateMapAsset, mapAssetFromGenerated, mapAssetFromTerrain, validateMapAsset } from '../src/maps/mapAsset';
import { deleteMapAsset, duplicateStoredMap, listUserMaps, readMapAsset, renameMapAsset, saveMapAsset } from '../src/maps/mapStore';
import { generateMap, presetParameters } from '../src/terrain/generator';
import { SimulationState } from '../src/simulation/state';
import { SimulationClient } from '../src/app/simulationClient';
import type { UIToWorkerMessage, WorkerToUIMessage } from '../src/shared/protocol';
import { withShoreline } from '../src/water/geometry';

const identity = { id: 'test-map', name: 'Test World', description: 'A reusable initial world', author: 'Test' };
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); });

describe('Map Assets and library', () => {
  it('converts both current and old 1024m procedural outputs and retains import/georeference metadata', () => {
    const generated = generateMap({ generatorVersion: 1, seed: 'asset', preset: 'coastal', parameters: presetParameters('coastal') });
    for (const map of [generated, { ...generated, world: undefined }]) {
      const asset = mapAssetFromGenerated(map, identity);
      expect(validateMapAsset(asset).valid).toBe(true); expect(asset.world.waterMode).toBe('explicit');
      expect(asset.terrain.heightmap).toEqual(Array.from(generated.heights));
    }
    const asset = blankMapAsset(identity); asset.world.source = { kind: 'dem', uri: 'future-import.tif' };
    asset.world.georeference = { crs: 'EPSG:6676', affineTransform: [0, 1, 0, 0, 0, -1], verticalDatum: 'source datum' };
    const imported = mapAssetFromTerrain(identity, asset.terrain, asset.world);
    expect(imported.world.georeference).toEqual(asset.world.georeference); expect(imported.world.waterBodies).toEqual([]);
    expect(builtInMaps().every(map => validateMapAsset(map).valid)).toBe(true);
  });
  it('round-trips the persistent library, rejects duplicate IDs, and supports duplicate/rename/delete', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory()); const asset = blankMapAsset(identity);
    await saveMapAsset(asset); expect(await readMapAsset(asset.id)).toEqual(asset);
    await expect(saveMapAsset(asset)).rejects.toBeDefined();
    const copy = await duplicateStoredMap(asset); expect(copy.id).not.toBe(asset.id);
    await renameMapAsset(copy.id, 'Renamed World', 'Updated description');
    expect((await readMapAsset(copy.id))?.name).toBe('Renamed World'); expect(await listUserMaps()).toHaveLength(2);
    await deleteMapAsset(copy.id); expect(await listUserMaps()).toHaveLength(1);
    await expect(saveMapAsset({ ...asset, id: 'builtin-immutable' }, true)).rejects.toThrow(/Duplicate/);
    const invalid = duplicateMapAsset(asset); invalid.world.outsideConnections = [];
    await expect(saveMapAsset(invalid)).rejects.toThrow(/Outside Connection/);
    invalid.world.outsideConnections = asset.world.outsideConnections; invalid.terrain.heightmap[0] = NaN;
    await expect(saveMapAsset(invalid)).rejects.toThrow(/heightmap/);
  });
  it('starts an independent city, preserves its developed save, and allows asset edits without changing that city', () => {
    const asset = blankMapAsset(identity, { worldWidthMeters: 4096, worldDepthMeters: 4096, terrainSampleSpacingMeters: 8 });
    const city = new SimulationState(); city.startMapAsset(asset);
    city.execute({ type: 'build-road', input: { roadTypeId: 'small', geometry: { kind: 'straight', points: [{ x: -80, z: 0 }, { x: 80, z: 0 }] } } });
    const citySave = city.serialize(); asset.terrain.heightmap[0] = 100; asset.world.source.name = 'edited';
    const editor = new SimulationState(); editor.startMapAsset(asset, true); editor.setWaterBodies([withShoreline({ id: 'lake', type: 'lake', surfaceElevation: 20,
      geometry: { kind: 'polygon', vertices: [{ x: 200, z: 200 }, { x: 400, z: 200 }, { x: 400, z: 400 }, { x: 200, z: 400 }] } })]);
    const exported = editor.exportMapAsset(identity); expect(exported.world.waterBodies).toHaveLength(1);
    expect(city.terrain.heights[0]).toBe(0); expect(city.worldMetadata.waterBodies).toHaveLength(0);
    const reload = new SimulationState(); reload.load(citySave);
    expect(reload.graph.snapshot()).toEqual(city.graph.snapshot()); expect(reload.terrain.heights).toEqual(city.terrain.heights);
    expect(reload.worldMetadata.worldWidthMeters).toBe(4096);
  });
  it('uses the real Worker for editor load, edits, export and a fresh New Game from the saved asset', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }); vi.stubGlobal('indexedDB', new IDBFactory());
    const messages: WorkerToUIMessage[] = [];
    const worker = { onmessage: null as ((event: MessageEvent<WorkerToUIMessage>) => void) | null,
      postMessage: (data: UIToWorkerMessage) => scope.onmessage!({ data }) };
    const scope = { onmessage: null as ((event: { data: UIToWorkerMessage }) => void) | null,
      postMessage: (data: WorkerToUIMessage) => { messages.push(data); worker.onmessage!({ data } as MessageEvent<WorkerToUIMessage>); } };
    vi.stubGlobal('self', scope); const client = new SimulationClient(worker as unknown as Worker);
    await import('../src/worker/simulation.worker');
    const loaded = client.mapOperation({ kind: 'load', asset: blankMapAsset(identity), editor: true }); vi.advanceTimersByTime(50); await loaded;
    expect(client.latestSnapshot?.gameClock.speed).toBe(0);
    const ownership = client.mapOperation({ kind: 'ownership', settings: { mode: 'progressive', tileSizeMeters: 512, startingTiles: [{ x: 1, z: 1 }] } }); vi.advanceTimersByTime(50); await ownership;
    client.beginTerrainStroke({ x: 0, z: 0 }, 'raise', 40, 10); client.terrainStroke([{ x: 0, z: 0 }], .5); client.endTerrainStroke(); vi.advanceTimersByTime(50);
    const water = client.mapOperation({ kind: 'water', bodies: [withShoreline({ id: 'lake', type: 'lake', surfaceElevation: 20, geometry: { kind: 'polygon', vertices: [{ x: 100, z: 100 }, { x: 200, z: 100 }, { x: 200, z: 200 }, { x: 100, z: 200 }] } })] });
    vi.advanceTimersByTime(50); await water;
    const exported = client.mapOperation({ kind: 'export', identity }); vi.advanceTimersByTime(50); const asset = (await exported)!;
    await saveMapAsset(asset); const stored = (await readMapAsset(asset.id))!;
    const started = client.mapOperation({ kind: 'load', asset: stored, editor: false }); vi.advanceTimersByTime(50); await started;
    expect(client.latestSnapshot?.worldMetadata.waterBodies[0].id).toBe('lake'); expect(client.latestSnapshot?.gameClock.speed).toBe(1);
    expect(client.latestSnapshot?.landOwnership.ownedTiles).toEqual([{ x: 1, z: 1 }]);
    const unlock = client.execute({ type: 'unlock-land', tile: { x: 0, z: 1 } }); vi.advanceTimersByTime(50); expect((await unlock).ok).toBe(true);
    expect(client.latestSnapshot?.landOwnership.ownedTiles).toHaveLength(2);
    expect(client.latestSnapshot?.terrainHeightmap?.[128 * 257 + 128]).toBeGreaterThan(0);
    const editSnapshot = messages.filter((m): m is Extract<WorkerToUIMessage, { type: 'snapshot' }> => m.type === 'snapshot')[1];
    expect(editSnapshot.snapshot.terrainHeightmap).toBeUndefined();
    expect(messages.some(m => m.type === 'terrain-update')).toBe(true);
  });
});
