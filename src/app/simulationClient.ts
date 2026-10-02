import type { SaveFile } from '../save/serializer';
import type { UIToWorkerMessage, WorkerToUIMessage, WorldSnapshot, MapOperation } from '../shared/protocol';
import type { MapAsset } from '../maps/mapAsset';
import type { SimulationCommandData, SimulationCommandResult } from '../simulation/commands';
import type { GameSpeed } from '../simulation/gameClock';
import type { TerrainBrushMode, TerrainPreset, Vec2 } from '../world/types';
import type { GeneratedMap } from '../terrain/generator';
import type { AgentDetails } from '../citizens/types';

type SnapshotListener = (snapshot: WorldSnapshot) => void;
type NotificationListener = (message: string, level: 'info' | 'error') => void;
export interface CommandResponse { ok: boolean; result?: SimulationCommandResult; error?: string }

export class SimulationClient {
  private readonly mapRequests = new Map<string, { resolve: (asset?: MapAsset) => void; reject: (error: Error) => void }>();
  mapOperation(operation: MapOperation): Promise<MapAsset | undefined> {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => { this.mapRequests.set(requestId, { resolve, reject }); this.post({ type: 'map-operation', requestId, operation }); });
  }
  private readonly snapshotListeners = new Set<SnapshotListener>();
  private readonly notificationListeners = new Set<NotificationListener>();
  private readonly saveRequests = new Map<string, (save: SaveFile) => void>();
  private readonly commandRequests = new Map<string, (response: CommandResponse) => void>();
  private readonly citizenRequests = new Map<string, (details?: AgentDetails) => void>();
  private readonly loadRequests = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  latestSnapshot?: WorldSnapshot;
  performanceMetrics?: Extract<WorkerToUIMessage, { type: 'performance-update' }>;
  private terrainHeights?: Float32Array;

  constructor(private readonly worker: Worker) {
    worker.onmessage = (event: MessageEvent<WorkerToUIMessage>) => this.onMessage(event.data);
  }

  initialize(generatedMap?: GeneratedMap): void { this.post({ type: 'initialize', generatedMap }); }
  execute(command: SimulationCommandData): Promise<CommandResponse> {
    const requestId = crypto.randomUUID();
    return new Promise((resolve) => {
      this.commandRequests.set(requestId, resolve);
      this.post({ type: 'execute-command', requestId, command });
    });
  }
  undo(): void { this.post({ type: 'undo' }); }
  redo(): void { this.post({ type: 'redo' }); }
  setSpeed(speed: GameSpeed): void { this.post({ type: 'set-speed', speed }); }
  setAgentView(position: Vec2, radius: number, cap: number): void { this.post({ type: 'set-agent-view', position, radius, cap }); }
  inspectCitizen(citizenId: string): Promise<AgentDetails | undefined> {
    const requestId = crypto.randomUUID();
    return new Promise((resolve) => { this.citizenRequests.set(requestId, resolve); this.post({ type: 'inspect-citizen', requestId, citizenId }); });
  }
  load(save: SaveFile): Promise<void> {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      this.loadRequests.set(requestId, { resolve, reject });
      this.post({ type: 'load', requestId, save });
    });
  }
  beginTerrainStroke(point: Vec2, mode: TerrainBrushMode, size: number, strength: number): void { this.post({ type: 'begin-terrain-stroke', point, mode, size, strength }); }
  terrainStroke(points: Vec2[], seconds: number): void { this.post({ type: 'terrain-stroke', points, seconds }); }
  endTerrainStroke(): void { this.post({ type: 'end-terrain-stroke' }); }
  cancelTerrainStroke(): void { this.post({ type: 'cancel-terrain-stroke' }); }
  setTerrainPreset(preset: TerrainPreset): void { this.post({ type: 'set-terrain-preset', preset }); }

  requestSave(): Promise<SaveFile> {
    const requestId = crypto.randomUUID();
    return new Promise((resolve) => {
      this.saveRequests.set(requestId, resolve);
      this.post({ type: 'request-save', requestId });
    });
  }

  subscribe(listener: SnapshotListener): () => void {
    this.snapshotListeners.add(listener);
    if (this.latestSnapshot) listener(this.latestSnapshot);
    return () => this.snapshotListeners.delete(listener);
  }

  onNotification(listener: NotificationListener): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  private post(message: UIToWorkerMessage): void { this.worker.postMessage(message); }

  private onMessage(message: WorkerToUIMessage): void {
    if (message.type === 'rail-runtime-update') {
      if (this.latestSnapshot) { this.latestSnapshot = { ...this.latestSnapshot, railwayRuntime: message.railwayRuntime }; for (const listener of this.snapshotListeners) listener(this.latestSnapshot); }
      return;
    }
    if (message.type === 'map-result') {
      const request = this.mapRequests.get(message.requestId);
      if (message.ok) request?.resolve(message.asset); else request?.reject(new Error(message.error ?? 'Map operation failed.'));
      this.mapRequests.delete(message.requestId);
    } else if (message.type === 'performance-update') {
      this.performanceMetrics = message;
    } else if (message.type === 'load-result') {
      const request = this.loadRequests.get(message.requestId);
      if (message.ok) request?.resolve();
      else request?.reject(new Error(message.error ?? 'Load failed.'));
      this.loadRequests.delete(message.requestId);
    } else if (message.type === 'citizen-details') {
      this.citizenRequests.get(message.requestId)?.(message.details); this.citizenRequests.delete(message.requestId);
    } else if (message.type === 'snapshot') {
      if (message.snapshot.terrainHeightmap) this.terrainHeights = message.snapshot.terrainHeightmap;
      this.latestSnapshot = { ...message.snapshot, terrainHeightmap: this.terrainHeights };
      for (const listener of this.snapshotListeners) listener(this.latestSnapshot);
    } else if (message.type === 'terrain-update') {
      if (!this.latestSnapshot) return;
      if (this.terrainHeights) {
        const columns = message.terrain.width / message.terrain.settings.sampleSpacing + 1;
        for (const patch of message.patches) for (let row = 0; row < patch.rows; row += 1) {
          this.terrainHeights.set(patch.heights.subarray(row * patch.columns, (row + 1) * patch.columns),
            (patch.startRow + row) * columns + patch.startColumn);
        }
      }
      const elevations = new Map(message.zoneElevations.map(({ id, terrainHeight, terrainSuitable }) => [id, { terrainHeight, terrainSuitable }]));
      const lots = new Map(this.latestSnapshot.lots.map((lot) => [lot.id, lot]));
      for (const id of message.removedLotIds) lots.delete(id);
      for (const lot of message.lotUpdates) lots.set(lot.id, lot);
      const buildings = new Map(this.latestSnapshot.buildings.map((building) => [building.id, building]));
      for (const id of message.removedBuildingIds) buildings.delete(id);
      for (const building of message.buildingUpdates) buildings.set(building.id, building);
      this.latestSnapshot = { ...this.latestSnapshot, terrain: message.terrain, terrainRevision: message.terrainRevision,
        terrainUpdatedChunkIds: message.terrainUpdatedChunkIds, terrainPatches: message.patches,
        terrainEditMs: message.terrainEditMs, terrainMessageBytes: message.messageBytes, terrainHeightmap: this.terrainHeights,
        zoningCells: this.latestSnapshot.zoningCells.map((cell) => elevations.has(cell.id) ? { ...cell, ...elevations.get(cell.id) } : cell),
        lotRevision: message.lotRevision, lots: [...lots.values()].sort((a, b) => a.id.localeCompare(b.id)),
        buildings: [...buildings.values()].sort((a, b) => a.id.localeCompare(b.id)), lotReevaluatedCells: message.lotReevaluatedCells };
      for (const listener of this.snapshotListeners) listener(this.latestSnapshot);
    } else if (message.type === 'population-update') {
      if (!this.latestSnapshot) return;
      this.latestSnapshot = { ...this.latestSnapshot, population: message.population };
      for (const listener of this.snapshotListeners) listener(this.latestSnapshot);
    } else if (message.type === 'economy-update') {
      if (!this.latestSnapshot) return;
      this.latestSnapshot = { ...this.latestSnapshot, economy: message.economy };
      for (const listener of this.snapshotListeners) listener(this.latestSnapshot);
    } else if (message.type === 'traffic-update') {
      if (!this.latestSnapshot) return;
      this.latestSnapshot = { ...this.latestSnapshot, traffic: message.traffic };
      for (const listener of this.snapshotListeners) listener(this.latestSnapshot);
    } else if (message.type === 'service-update') {
      if (!this.latestSnapshot) return;
      this.latestSnapshot = { ...this.latestSnapshot, services: message.services };
      for (const listener of this.snapshotListeners) listener(this.latestSnapshot);
    } else if (message.type === 'transit-update') {
      if (!this.latestSnapshot) return;
      this.latestSnapshot = { ...this.latestSnapshot, transit: message.transit };
      for (const listener of this.snapshotListeners) listener(this.latestSnapshot);
    } else if (message.type === 'clock-update') {
      if (!this.latestSnapshot) return;
      this.latestSnapshot = {
        ...this.latestSnapshot,
        revision: message.revision,
        gameClock: message.gameClock,
        simulationTickMs: message.simulationTickMs,
        terrainPatches: undefined,
        terrainHeightmap: this.terrainHeights,
      };
      for (const listener of this.snapshotListeners) listener(this.latestSnapshot);
    } else if (message.type === 'command-result') {
      this.commandRequests.get(message.requestId)?.({ ok: message.ok, result: message.result, error: message.error });
      this.commandRequests.delete(message.requestId);
    } else if (message.type === 'save-data') {
      this.saveRequests.get(message.requestId)?.(message.save);
      this.saveRequests.delete(message.requestId);
    } else {
      for (const listener of this.notificationListeners) listener(message.message, message.level);
    }
  }
}
