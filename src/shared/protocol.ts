import type { RoadGraphSnapshot } from '../roads/types';
import type { SaveFile } from '../save/serializer';
import type { GameSpeed, GameClockSnapshot } from '../simulation/gameClock';
import type { SimulationCommandData, SimulationCommandResult } from '../simulation/commands';
import type { ZoningCell } from '../zoning/types';
import type { Building, Lot, LotId } from '../lots/types';
import type { PopulationSnapshot } from '../population/types';
import type { EconomySnapshot } from '../economy/types';
import type { ChunkDescriptor, TerrainBrushMode, TerrainMetadata, TerrainPatch, TerrainPreset, Vec2 } from '../world/types';

export interface WorldSnapshot {
  revision: number;
  roadRevision: number;
  zoningRevision: number;
  terrainRevision: number;
  terrain: TerrainMetadata;
  terrainHeightmap?: Float32Array;
  terrainPatches?: TerrainPatch[];
  terrainMessageBytes?: number;
  terrainUpdatedChunkIds: ChunkDescriptor['id'][];
  terrainEditMs: number;
  chunks: ChunkDescriptor[];
  roadGraph: RoadGraphSnapshot;
  zoningCells: ZoningCell[];
  lotRevision: number;
  lots: Lot[];
  buildings: Building[];
  population: PopulationSnapshot;
  economy: EconomySnapshot;
  lotReevaluatedCells: number;
  zoningUpdatedChunkIds: ChunkDescriptor['id'][];
  gameClock: GameClockSnapshot;
  simulationTickMs: number;
}

export type UIToWorkerMessage =
  | { type: 'initialize' }
  | { type: 'execute-command'; requestId: string; command: SimulationCommandData }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'set-speed'; speed: GameSpeed }
  | { type: 'request-save'; requestId: string }
  | { type: 'load'; save: SaveFile }
  | { type: 'begin-terrain-stroke'; point: Vec2; mode: TerrainBrushMode; size: number; strength: number }
  | { type: 'terrain-stroke'; points: Vec2[]; seconds: number }
  | { type: 'end-terrain-stroke' }
  | { type: 'cancel-terrain-stroke' }
  | { type: 'set-terrain-preset'; preset: TerrainPreset };

export type WorkerToUIMessage =
  | { type: 'snapshot'; snapshot: WorldSnapshot }
  | { type: 'clock-update'; revision: number; gameClock: GameClockSnapshot; simulationTickMs: number }
  | { type: 'population-update'; population: PopulationSnapshot }
  | { type: 'economy-update'; economy: EconomySnapshot }
  | { type: 'command-result'; requestId: string; ok: boolean; result?: SimulationCommandResult; error?: string }
  | { type: 'save-data'; requestId: string; save: SaveFile }
  | { type: 'notification'; level: 'info' | 'error'; message: string }
  | { type: 'terrain-update'; terrain: TerrainMetadata; terrainRevision: number; terrainUpdatedChunkIds: ChunkDescriptor['id'][]; patches: TerrainPatch[]; zoneElevations: Array<{ id: string; terrainHeight: number; terrainSuitable: boolean }>; lotRevision: number; lotUpdates: Lot[]; removedLotIds: LotId[]; buildingUpdates: Building[]; removedBuildingIds: Building['id'][]; lotReevaluatedCells: number; terrainEditMs: number; messageBytes: number };
