/// <reference lib="webworker" />
import type { UIToWorkerMessage, WorkerToUIMessage } from '../shared/protocol';
import { SimulationState } from '../simulation/state';
import { payloadBytes } from '../performance/metrics';

const workerScope: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;
const simulation = new SimulationState();
const pending: UIToWorkerMessage[] = [];
let initialized = false;
let previousTime = performance.now();
let sentPopulationRevision = -1;
let sentEconomyRevision = -1;
let sentTrafficRevision = -1;
let sentServiceRevision = -1;
let sentTransitRevision = -1;
let sentRailRevision = -1;

let messageSampleAt = 0;
let messageBytes = 0;
let snapshotBytes = 0;
const post = (message: WorkerToUIMessage): void => {
  // Sample at most once per second and on full snapshots; instrumentation stays bounded.
  if (message.type === 'snapshot' || (message.type !== 'performance-update' && performance.now() >= messageSampleAt)) {
    messageBytes = payloadBytes(message); messageSampleAt = performance.now() + 1000;
    if (message.type === 'snapshot') snapshotBytes = messageBytes;
  }
  workerScope.postMessage(message);
};
let metricsAt = 0;
const notify = (message: string, level: 'info' | 'error' = 'info'): void => post({ type: 'notification', message, level });

workerScope.onmessage = (event: MessageEvent<UIToWorkerMessage>) => {
  pending.push(event.data);
};

const processMessage = (message: UIToWorkerMessage): 'initial' | 'full' | 'terrain' | 'none' => {
  switch (message.type) {
    case 'map-operation':
      try {
        const op = message.operation; let asset;
        if (op.kind === 'load') { simulation.startMapAsset(op.asset, op.editor); initialized = true; }
        else if (op.kind === 'water') simulation.setWaterBodies(op.bodies);
        else if (op.kind === 'outside') simulation.setOutsideConnections(op.connections);
        else if (op.kind === 'ownership') simulation.setLandOwnershipSettings(op.settings);
        else asset = simulation.exportMapAsset(op.identity);
        post({ type: 'map-result', requestId: message.requestId, ok: true, asset });
        return op.kind === 'load' ? 'initial' : op.kind === 'export' ? 'none' : 'full';
      } catch (error) {
        post({ type: 'map-result', requestId: message.requestId, ok: false, error: error instanceof Error ? error.message : String(error) });
        return 'none';
      }
    case 'initialize':
      if (message.generatedMap) simulation.startGeneratedCity(message.generatedMap);
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
    case 'set-agent-view':
      simulation.traffic.setCitizenView(message.position, message.radius, message.cap);
      return 'none';
    case 'inspect-citizen':
      post({ type: 'citizen-details', requestId: message.requestId, details: simulation.traffic.inspectCitizen(message.citizenId) });
      return 'none';
    case 'request-save':
      post({ type: 'save-data', requestId: message.requestId, save: simulation.serialize() });
      return 'none';
    case 'load':
      try {
        simulation.load(message.save);
        initialized = true;
        post({ type: 'load-result', requestId: message.requestId, ok: true });
        notify('Save loaded.');
        return 'initial';
      } catch (error) {
        post({ type: 'load-result', requestId: message.requestId, ok: false,
          error: error instanceof Error ? error.message : String(error) });
        return 'none';
      }
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
    if (initialized) needsFullSnapshot ||= simulation.tick(deltaSeconds);
    if (initialized) {
      if (now >= metricsAt) {
        workerScope.postMessage({ type: 'performance-update', timings: { ...simulation.performance.report(), ...simulation.traffic.performanceMetrics }, messageBytes, snapshotBytes } satisfies WorkerToUIMessage);
        metricsAt = now + 1000;
      }
      if (needsFullSnapshot) {
        post({ type: 'snapshot', snapshot: simulation.snapshot(includeTerrainHeightmap || needsTerrainUpdate) });
        sentPopulationRevision = simulation.population.revision;
        sentEconomyRevision = simulation.economy.revision;
        sentTrafficRevision = simulation.traffic.revision;
        sentServiceRevision = simulation.services.revision;
        sentTransitRevision = simulation.transit.revision;
        sentRailRevision = simulation.railway.revision;
        simulation.consumeTerrainUpdate();
        simulation.lots.takeDelta();
      } else {
        if (simulation.railway.revision !== sentRailRevision) { post({ type: 'rail-runtime-update', railwayRuntime: simulation.railway.runtime() }); sentRailRevision = simulation.railway.revision; }
        if (needsTerrainUpdate) {
          const update = simulation.consumeTerrainUpdate();
          if (update) post({ type: 'terrain-update', terrain: simulation.terrain.metadata(), terrainRevision: update.terrainRevision,
            terrainUpdatedChunkIds: update.chunkIds, patches: update.patches, zoneElevations: update.zoneElevations,
            lotRevision: update.lotRevision, lotUpdates: update.lotUpdates, removedLotIds: update.removedLotIds,
            buildingUpdates: update.buildingUpdates, removedBuildingIds: update.removedBuildingIds,
            lotReevaluatedCells: update.lotReevaluatedCells,
            terrainEditMs: update.terrainEditMs, messageBytes: update.messageBytes });
        }
        if (simulation.population.revision !== sentPopulationRevision) {
          post({ type: 'population-update', population: simulation.populationUpdate() });
          sentPopulationRevision = simulation.population.revision;
        }
        if (simulation.economy.revision !== sentEconomyRevision) {
          post({ type: 'economy-update', economy: simulation.economyUpdate() });
          sentEconomyRevision = simulation.economy.revision;
        }
        if (simulation.traffic.revision !== sentTrafficRevision) {
          post({ type: 'traffic-update', traffic: simulation.trafficUpdate() });
          sentTrafficRevision = simulation.traffic.revision;
        }
        if (simulation.services.revision !== sentServiceRevision) {
          post({ type: 'service-update', services: simulation.serviceUpdate() });
          sentServiceRevision = simulation.services.revision;
        }
        if (simulation.transit.revision !== sentTransitRevision) {
          post({ type: 'transit-update', transit: simulation.transitUpdate() });
          sentTransitRevision = simulation.transit.revision;
        }
        post({ type: 'clock-update', ...simulation.clockUpdate() });
      }
    }
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error), 'error');
  }
}, 50);
