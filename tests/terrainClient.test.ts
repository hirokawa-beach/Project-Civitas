import { describe, expect, it } from 'vitest';
import { SimulationClient } from '../src/app/simulationClient';
import { SimulationState } from '../src/simulation/state';
import type { WorkerToUIMessage, WorldSnapshot } from '../src/shared/protocol';

describe('terrain snapshot delivery', () => {
  it('delivers population updates without resending roads or terrain', () => {
    const fakeWorker = { onmessage: null as ((event: MessageEvent<WorkerToUIMessage>) => void) | null, postMessage: () => {} };
    const client = new SimulationClient(fakeWorker as unknown as Worker);
    const state = new SimulationState();
    state.execute({ type: 'build-road', input: { geometry: { kind: 'straight', points: [{ x: -80, z: 0 }, { x: 80, z: 0 }] }, roadTypeId: 'small' } });
    const cellId = state.snapshot().zoningCells.find((cell) => cell.depth === 0)!.id;
    state.execute({ type: 'set-zone', cellIds: [cellId], zoneType: 'residential' });
    state.tick(7);
    fakeWorker.onmessage!({ data: { type: 'snapshot', snapshot: state.snapshot() } } as MessageEvent<WorkerToUIMessage>);
    const originalGraph = client.latestSnapshot?.roadGraph;
    const before = client.latestSnapshot!.population.totals.households;
    state.tick(3);
    fakeWorker.onmessage!({ data: { type: 'population-update', population: state.populationUpdate() } } as MessageEvent<WorkerToUIMessage>);
    expect(client.latestSnapshot?.population.totals.households).toBe(before + 1);
    expect(client.latestSnapshot?.roadGraph).toBe(originalGraph);
  });

  it('keeps an updated full heightmap for a renderer that subscribes late', () => {
    const fakeWorker = { onmessage: null as ((event: MessageEvent<WorkerToUIMessage>) => void) | null, postMessage: () => {} };
    const client = new SimulationClient(fakeWorker as unknown as Worker);
    const state = new SimulationState();
    fakeWorker.onmessage!({ data: { type: 'snapshot', snapshot: state.snapshot() } } as MessageEvent<WorkerToUIMessage>);

    state.beginTerrainStroke({ x: 0, z: 0 }, 'raise', 48, 12);
    state.endTerrainStroke();
    const update = state.consumeTerrainUpdate()!;
    fakeWorker.onmessage!({ data: { type: 'terrain-update', terrain: state.terrain.metadata(), terrainRevision: state.snapshot(false).terrainRevision,
      terrainUpdatedChunkIds: update.chunkIds, patches: update.patches, zoneElevations: update.zoneElevations,
      lotRevision: update.lotRevision, lotUpdates: update.lotUpdates, removedLotIds: update.removedLotIds,
      buildingUpdates: update.buildingUpdates, removedBuildingIds: update.removedBuildingIds, lotReevaluatedCells: update.lotReevaluatedCells,
      terrainEditMs: update.terrainEditMs, messageBytes: update.messageBytes } } as MessageEvent<WorkerToUIMessage>);
    fakeWorker.onmessage!({ data: { type: 'clock-update', ...state.clockUpdate() } } as MessageEvent<WorkerToUIMessage>);

    let lateSnapshot: WorldSnapshot | undefined;
    client.subscribe((snapshot) => { lateSnapshot = snapshot; });
    expect(lateSnapshot?.terrainHeightmap?.[128 * 257 + 128]).toBeGreaterThan(0);
    expect(lateSnapshot?.terrainPatches).toBeUndefined();
  });

  it('updates zone visibility after a live terrain stroke and restores it after undo', () => {
    const fakeWorker = { onmessage: null as ((event: MessageEvent<WorkerToUIMessage>) => void) | null, postMessage: () => {} };
    const client = new SimulationClient(fakeWorker as unknown as Worker);
    const state = new SimulationState();
    state.execute({ type: 'build-road', input: { geometry: { kind: 'straight', points: [{ x: -100, z: 0 }, { x: 100, z: 0 }] }, roadTypeId: 'small' } });
    const cell = state.snapshot().zoningCells.find((candidate) => candidate.center.z > 28 && Math.abs(candidate.center.x) < 20)!;
    fakeWorker.onmessage!({ data: { type: 'snapshot', snapshot: state.snapshot() } } as MessageEvent<WorkerToUIMessage>);
    expect(client.latestSnapshot?.zoningCells.find((candidate) => candidate.id === cell.id)?.terrainSuitable).toBe(true);

    const deliverTerrain = () => {
      const update = state.consumeTerrainUpdate()!;
      fakeWorker.onmessage!({ data: { type: 'terrain-update', terrain: state.terrain.metadata(), terrainRevision: update.terrainRevision,
        terrainUpdatedChunkIds: update.chunkIds, patches: update.patches, zoneElevations: update.zoneElevations,
        lotRevision: update.lotRevision, lotUpdates: update.lotUpdates, removedLotIds: update.removedLotIds,
        buildingUpdates: update.buildingUpdates, removedBuildingIds: update.removedBuildingIds, lotReevaluatedCells: update.lotReevaluatedCells,
        terrainEditMs: update.terrainEditMs, messageBytes: update.messageBytes } } as MessageEvent<WorkerToUIMessage>);
    };
    state.beginTerrainStroke(cell.center, 'raise', 24, 50);
    state.applyTerrainStroke([cell.center], 0.25);
    state.endTerrainStroke();
    deliverTerrain();
    expect(client.latestSnapshot?.zoningCells.find((candidate) => candidate.id === cell.id)?.terrainSuitable).toBe(false);
    expect(state.undo()).toBe(true);
    deliverTerrain();
    expect(client.latestSnapshot?.zoningCells.find((candidate) => candidate.id === cell.id)?.terrainSuitable).toBe(true);
  });

  it('delivers local lot and building changes with terrain patches', () => {
    const fakeWorker = { onmessage: null as ((event: MessageEvent<WorkerToUIMessage>) => void) | null, postMessage: () => {} };
    const client = new SimulationClient(fakeWorker as unknown as Worker);
    const state = new SimulationState();
    state.execute({ type: 'build-road', input: { geometry: { kind: 'straight', points: [{ x: -100, z: 0 }, { x: 100, z: 0 }] }, roadTypeId: 'small' } });
    state.execute({ type: 'set-zone', cellIds: state.snapshot().zoningCells.map((cell) => cell.id), zoneType: 'residential' });
    const lot = state.snapshot().lots.find((candidate) => candidate.position.z > 15 && candidate.buildingId)!;
    expect(lot).toBeDefined();
    fakeWorker.onmessage!({ data: { type: 'snapshot', snapshot: state.snapshot() } } as MessageEvent<WorkerToUIMessage>);
    state.lots.takeDelta();
    state.beginTerrainStroke(lot.position, 'raise', 24, 50);
    state.applyTerrainStroke([lot.position], 0.25);
    state.endTerrainStroke();
    const update = state.consumeTerrainUpdate()!;
    expect(update.lotReevaluatedCells).toBeLessThan(state.snapshot().zoningCells.length);
    fakeWorker.onmessage!({ data: { type: 'terrain-update', terrain: state.terrain.metadata(), terrainRevision: update.terrainRevision,
      terrainUpdatedChunkIds: update.chunkIds, patches: update.patches, zoneElevations: update.zoneElevations,
      lotRevision: update.lotRevision, lotUpdates: update.lotUpdates, removedLotIds: update.removedLotIds,
      buildingUpdates: update.buildingUpdates, removedBuildingIds: update.removedBuildingIds,
      lotReevaluatedCells: update.lotReevaluatedCells, terrainEditMs: update.terrainEditMs, messageBytes: update.messageBytes } } as MessageEvent<WorkerToUIMessage>);
    expect(client.latestSnapshot?.lots).toEqual(state.snapshot().lots);
    expect(client.latestSnapshot?.buildings).toEqual(state.snapshot().buildings);
  });
});
