/// <reference lib="webworker" />
import type { UIToWorkerMessage, WorkerToUIMessage } from '../shared/protocol';
import { SimulationState } from '../simulation/state';

const workerScope: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;
const simulation = new SimulationState();
const pending: UIToWorkerMessage[] = [];
let initialized = false;
let previousTime = performance.now();

const post = (message: WorkerToUIMessage): void => workerScope.postMessage(message);
const notify = (message: string, level: 'info' | 'error' = 'info'): void => post({ type: 'notification', message, level });

workerScope.onmessage = (event: MessageEvent<UIToWorkerMessage>) => {
  pending.push(event.data);
};

const processMessage = (message: UIToWorkerMessage): 'initial' | 'full' | 'terrain' | 'none' => {
  switch (message.type) {
    case 'initialize':
      initialized = true;
      return 'initial';
    case 'execute-command':
      try {
        const result = simulation.execute(message.command);
        post({ type: 'command-result', requestId: message.requestId, ok: true, result });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        post({ type: 'command-result', requestId: message.requestId, ok: false, error: detail });
        notify(detail, 'error');
      }
      return 'full';
    case 'undo':
      if (!simulation.undo()) {
        notify('Nothing to undo.');
        return 'none';
      }
      return simulation.history.lastDomain === 'terrain' ? 'terrain' : 'full';
    case 'redo':
      if (!simulation.redo()) {
        notify('Nothing to redo.');
        return 'none';
      }
      return simulation.history.lastDomain === 'terrain' ? 'terrain' : 'full';
    case 'set-speed':
      simulation.setSpeed(message.speed);
      return 'none';
    case 'request-save':
      post({ type: 'save-data', requestId: message.requestId, save: simulation.serialize() });
      return 'none';
    case 'load':
      simulation.load(message.save);
      notify('Save loaded.');
      return 'initial';
    case 'begin-terrain-stroke':
      simulation.beginTerrainStroke(message.point, message.mode, message.size, message.strength);
      return 'terrain';
    case 'terrain-stroke':
      simulation.applyTerrainStroke(message.points, message.seconds);
      return 'terrain';
    case 'end-terrain-stroke':
      simulation.endTerrainStroke();
      return 'none';
    case 'cancel-terrain-stroke':
      simulation.cancelTerrainStroke();
      return 'terrain';
    case 'set-terrain-preset':
      simulation.setTerrainPreset(message.preset);
      return 'terrain';
  }
};

setInterval(() => {
  const now = performance.now();
  const deltaSeconds = Math.min(0.25, (now - previousTime) / 1000);
  previousTime = now;
  try {
    let needsFullSnapshot = false;
    let includeTerrainHeightmap = false;
    let needsTerrainUpdate = false;
    while (pending.length > 0) {
      const result = processMessage(pending.shift()!);
      needsFullSnapshot ||= result === 'full';
      if (result === 'initial') { needsFullSnapshot = true; includeTerrainHeightmap = true; }
      needsTerrainUpdate ||= result === 'terrain';
    }
    needsFullSnapshot ||= simulation.tick(deltaSeconds);
    if (initialized) {
      if (needsFullSnapshot) {
        post({ type: 'snapshot', snapshot: simulation.snapshot(includeTerrainHeightmap || needsTerrainUpdate) });
        simulation.consumeTerrainUpdate();
        simulation.lots.takeDelta();
      } else {
        if (needsTerrainUpdate) {
          const update = simulation.consumeTerrainUpdate();
          if (update) post({ type: 'terrain-update', terrain: simulation.terrain.metadata(), terrainRevision: update.terrainRevision,
            terrainUpdatedChunkIds: update.chunkIds, patches: update.patches, zoneElevations: update.zoneElevations,
            lotRevision: update.lotRevision, lotUpdates: update.lotUpdates, removedLotIds: update.removedLotIds,
            buildingUpdates: update.buildingUpdates, removedBuildingIds: update.removedBuildingIds,
            lotReevaluatedCells: update.lotReevaluatedCells,
            terrainEditMs: update.terrainEditMs, messageBytes: update.messageBytes });
        }
        post({ type: 'clock-update', ...simulation.clockUpdate() });
      }
    }
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error), 'error');
  }
}, 50);
