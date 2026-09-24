import type { RoadSegmentId, ZoningCellId } from '../shared/ids';
import { RoadGraph, type BuildRoadResult } from '../roads/roadGraph';
import type { BuildRoadInput, RoadGraphSnapshot } from '../roads/types';
import type { ZoneBrush, ZoneType } from '../zoning/types';
import type { ChunkDescriptor, TerrainPreset } from '../world/types';
import { HeightmapTerrain } from '../terrain/heightmap';
import { exceedsTerrainGrade } from '../roads/validation';
import { polylineLength } from '../roads/geometry';
import { getRoadType } from '../roads/roadTypes';
import type { EconomySystem } from '../economy/system';
import type { ServiceSystem } from '../services/system';
import { SERVICE_DEFINITIONS } from '../services/system';
import type { ServiceFacility, ServiceType } from '../services/types';
import type { Vec2 } from '../world/types';
import type { Lot } from '../lots/types';
import type { ZoningCell } from '../zoning/types';
import type { TransitSystem } from '../transit/system';
import type { TransitLineInput, TransitSaveState, TransitStop, TransitLine } from '../transit/types';
import type { StaticWater } from '../water/staticWater';

export type SimulationCommandData =
  | { type: 'build-road'; input: BuildRoadInput }
  | { type: 'remove-road'; segmentId: RoadSegmentId }
  | { type: 'set-zone'; cellIds: ZoningCellId[]; zoneType: ZoneBrush }
  | { type: 'place-service'; serviceType: ServiceType; position: Vec2 }
  | { type: 'remove-service'; facilityId: string }
  | { type: 'place-bus-stop'; position: Vec2; name?: string }
  | { type: 'remove-bus-stop'; stopId: string }
  | { type: 'create-bus-line'; input: TransitLineInput }
  | { type: 'update-bus-line'; lineId: string; input: TransitLineInput }
  | { type: 'remove-bus-line'; lineId: string }
  | { type: 'set-water-level'; seaLevel: number };

export type SimulationCommandResult =
  | ({ type: 'build-road' } & BuildRoadResult)
  | { type: 'remove-road'; segmentId: RoadSegmentId }
  | { type: 'set-zone'; cellIds: ZoningCellId[]; zoneType: ZoneBrush }
  | { type: 'edit-terrain'; chunkIds: ChunkDescriptor['id'][] }
  | { type: 'set-terrain-preset'; preset: TerrainPreset }
  | { type: 'place-service'; facility: ServiceFacility }
  | { type: 'remove-service'; facilityId: string }
  | { type: 'place-bus-stop'; stop: TransitStop }
  | { type: 'remove-bus-stop'; stopId: string }
  | { type: 'create-bus-line'; line: TransitLine }
  | { type: 'update-bus-line'; line: TransitLine }
  | { type: 'remove-bus-line'; lineId: string }
  | { type: 'set-water-level'; seaLevel: number };

export interface TerrainEditBounds { minX: number; maxX: number; minZ: number; maxZ: number }

export interface SimulationCommand {
  readonly label: string;
  readonly domain: 'road' | 'zone' | 'terrain' | 'service' | 'transit' | 'water';
  readonly affectedCellIds?: readonly ZoningCellId[];
  readonly affectedChunkIds?: readonly ChunkDescriptor['id'][];
  readonly affectedTerrainBounds?: TerrainEditBounds;
  finalize?(): void;
  execute(graph: RoadGraph): SimulationCommandResult;
  undo(graph: RoadGraph): void;
  redo(graph: RoadGraph): SimulationCommandResult;
}

abstract class SnapshotCommand implements SimulationCommand {
  abstract readonly label: string;
  readonly domain = 'road' as const;
  protected before?: RoadGraphSnapshot;
  protected after?: RoadGraphSnapshot;
  protected result?: SimulationCommandResult;
  private beforeZones?: Map<ZoningCellId, ZoneType>;
  private afterZones?: Map<ZoningCellId, ZoneType>;

  constructor(protected readonly zoneAssignments?: Map<ZoningCellId, ZoneType>) {}

  execute(graph: RoadGraph): SimulationCommandResult {
    this.before = graph.snapshot();
    if (this.zoneAssignments) this.beforeZones = new Map(this.zoneAssignments);
    try {
      this.result = this.apply(graph);
      this.after = graph.snapshot();
    } catch (error) {
      graph.restore(this.before);
      this.after = undefined;
      this.result = undefined;
      throw error;
    }
    return this.result;
  }

  finalize(): void {
    if (this.zoneAssignments) this.afterZones = new Map(this.zoneAssignments);
  }

  undo(graph: RoadGraph): void {
    if (!this.before) throw new Error(`Command ${this.label} has not executed.`);
    graph.restore(this.before);
    this.restoreZones(this.beforeZones);
  }

  redo(graph: RoadGraph): SimulationCommandResult {
    if (!this.after || !this.result) throw new Error(`Command ${this.label} has not executed.`);
    graph.restore(this.after);
    this.restoreZones(this.afterZones);
    return this.result;
  }

  private restoreZones(snapshot?: Map<ZoningCellId, ZoneType>): void {
    if (!this.zoneAssignments || !snapshot) return;
    this.zoneAssignments.clear();
    for (const [id, zone] of snapshot) this.zoneAssignments.set(id, zone);
  }

  protected abstract apply(graph: RoadGraph): SimulationCommandResult;
}

export class BuildRoadCommand extends SnapshotCommand {
  readonly label = 'Build road';
  private paidCost = 0;
  constructor(private readonly input: BuildRoadInput, assignments?: Map<ZoningCellId, ZoneType>,
    private readonly terrainHeight?: (x: number, z: number) => number,
    private readonly economy?: EconomySystem, private readonly gameSeconds?: () => number,
    private readonly services?: ServiceSystem, private readonly water?: StaticWater) { super(assignments); }
  protected apply(graph: RoadGraph): SimulationCommandResult {
    const result = graph.buildRoad(this.input, this.terrainHeight, this.water?.seaLevel);
    if ((this.input.structureType ?? 'ground') === 'ground' && this.terrainHeight && result.createdSegmentIds.some((id) => {
      const segment = graph.segments.get(id);
      return segment && exceedsTerrainGrade(segment.geometry.points, this.terrainHeight!);
    })) throw new Error('Road grade is too steep for surface placement.');
    if (this.services && this.services.intersectsRoads(result.createdSegmentIds.map((id) => graph.segments.get(id)!).filter(Boolean))) {
      throw new Error('Road overlaps an existing service building.');
    }
    if (this.economy) {
      const actualLength = result.createdSegmentIds.reduce((sum, id) => sum + polylineLength(graph.segments.get(id)!.geometry.points), 0);
      const cost = Math.round(actualLength * getRoadType(this.input.roadTypeId).constructionCostPerMeter);
      this.economy.chargeRoad(cost, this.gameSeconds?.() ?? 0);
      this.paidCost = cost;
    }
    return { type: 'build-road', ...result };
  }

  undo(graph: RoadGraph): void {
    super.undo(graph);
    if (this.economy) this.economy.refundRoad(this.paidCost, this.gameSeconds?.() ?? 0);
  }

  redo(graph: RoadGraph): SimulationCommandResult {
    const result = super.redo(graph);
    if (this.economy) this.economy.chargeRoad(this.paidCost, this.gameSeconds?.() ?? 0, true);
    return result;
  }
}

export class RemoveRoadCommand extends SnapshotCommand {
  readonly label = 'Remove road';
  constructor(private readonly segmentId: RoadSegmentId, assignments?: Map<ZoningCellId, ZoneType>) { super(assignments); }
  protected apply(graph: RoadGraph): SimulationCommandResult {
    if (!graph.removeSegment(this.segmentId)) throw new Error(`Road ${this.segmentId} no longer exists.`);
    return { type: 'remove-road', segmentId: this.segmentId };
  }
}

export class SetZoneCommand implements SimulationCommand {
  readonly label = 'Set zone';
  readonly domain = 'zone' as const;
  private before?: Map<ZoningCellId, ZoneType | undefined>;

  constructor(
    readonly affectedCellIds: ZoningCellId[],
    private readonly zoneType: ZoneBrush,
    private readonly assignments: Map<ZoningCellId, ZoneType>,
  ) {}

  execute(_graph: RoadGraph): SimulationCommandResult {
    this.before = new Map(this.affectedCellIds.map((id) => [id, this.assignments.get(id)]));
    this.apply();
    return { type: 'set-zone', cellIds: [...this.affectedCellIds], zoneType: this.zoneType };
  }

  undo(_graph: RoadGraph): void {
    if (!this.before) throw new Error('Set zone command has not executed.');
    for (const [id, previous] of this.before) {
      if (previous === undefined) this.assignments.delete(id);
      else this.assignments.set(id, previous);
    }
  }

  redo(_graph: RoadGraph): SimulationCommandResult {
    if (!this.before) throw new Error('Set zone command has not executed.');
    this.apply();
    return { type: 'set-zone', cellIds: [...this.affectedCellIds], zoneType: this.zoneType };
  }

  private apply(): void {
    for (const id of this.affectedCellIds) {
      if (this.zoneType === null) this.assignments.delete(id);
      else this.assignments.set(id, this.zoneType);
    }
  }
}

/** A live drag has already changed the authoritative heightmap before it enters history. */
export class AppliedTerrainStrokeCommand implements SimulationCommand {
  readonly label = 'Edit terrain';
  readonly domain = 'terrain' as const;
  constructor(
    private readonly terrain: HeightmapTerrain,
    private readonly before: ReadonlyMap<number, number>,
    private readonly after: ReadonlyMap<number, number>,
    readonly affectedChunkIds: readonly ChunkDescriptor['id'][],
    readonly affectedTerrainBounds?: TerrainEditBounds,
  ) {}
  execute(_graph: RoadGraph): SimulationCommandResult { return { type: 'edit-terrain', chunkIds: [...this.affectedChunkIds] }; }
  undo(_graph: RoadGraph): void { this.terrain.applyValues(this.before); }
  redo(_graph: RoadGraph): SimulationCommandResult {
    this.terrain.applyValues(this.after);
    return { type: 'edit-terrain', chunkIds: [...this.affectedChunkIds] };
  }
}

export class TerrainPresetCommand implements SimulationCommand {
  readonly label = 'Set terrain preset';
  readonly domain = 'terrain' as const;
  readonly affectedChunkIds: readonly ChunkDescriptor['id'][] =
    Array.from({ length: 16 }, (_, index) => `chunk-${index % 4}-${Math.floor(index / 4)}` as const);
  constructor(
    private readonly terrain: HeightmapTerrain,
    private readonly before: Float32Array,
    private readonly beforePreset: TerrainPreset,
    private readonly after: Float32Array,
    private readonly afterPreset: TerrainPreset,
  ) {}
  execute(_graph: RoadGraph): SimulationCommandResult { return { type: 'set-terrain-preset', preset: this.afterPreset }; }
  undo(_graph: RoadGraph): void { this.terrain.replaceHeights(this.before, this.beforePreset); }
  redo(_graph: RoadGraph): SimulationCommandResult {
    this.terrain.replaceHeights(this.after, this.afterPreset);
    return { type: 'set-terrain-preset', preset: this.afterPreset };
  }
}

export class PlaceServiceCommand implements SimulationCommand {
  readonly label = 'Place service';
  readonly domain = 'service' as const;
  private facility?: ServiceFacility;
  private readonly cost: number;
  constructor(private readonly type: ServiceType, private readonly position: Vec2,
    private readonly services: ServiceSystem, private readonly economy: EconomySystem,
    private readonly gameSeconds: () => number, private readonly lots: () => readonly Lot[],
    private readonly cells: () => readonly ZoningCell[], private readonly terrainHeight: (x: number, z: number) => number) {
    this.cost = SERVICE_DEFINITIONS[type]?.constructionCost ?? NaN;
  }
  execute(graph: RoadGraph): SimulationCommandResult {
    if (!Number.isFinite(this.cost) || !this.economy.canAfford(this.cost)) throw new Error('Not enough funds.');
    this.facility = this.services.place(this.type, this.position, graph.snapshot(), this.lots(), this.cells(), this.terrainHeight);
    this.economy.chargeService(this.cost, this.gameSeconds());
    return { type: 'place-service', facility: this.facility };
  }
  undo(): void {
    if (!this.facility) throw new Error('Service placement was not executed.');
    this.services.remove(this.facility.id);
    this.economy.refundService(this.cost, this.gameSeconds());
  }
  redo(): SimulationCommandResult {
    if (!this.facility) throw new Error('Service placement was not executed.');
    this.services.addExisting(this.facility);
    this.economy.chargeService(this.cost, this.gameSeconds(), true);
    return { type: 'place-service', facility: this.facility };
  }
}

export class RemoveServiceCommand implements SimulationCommand {
  readonly label = 'Remove service';
  readonly domain = 'service' as const;
  private removed?: ServiceFacility;
  constructor(private readonly id: string, private readonly services: ServiceSystem) {}
  execute(): SimulationCommandResult {
    this.removed = this.services.remove(this.id);
    return { type: 'remove-service', facilityId: this.id };
  }
  undo(): void {
    if (!this.removed) throw new Error('Service removal was not executed.');
    this.services.addExisting(this.removed);
  }
  redo(): SimulationCommandResult {
    this.services.remove(this.id);
    return { type: 'remove-service', facilityId: this.id };
  }
}

export class TransitCommand implements SimulationCommand {
  readonly domain = 'transit' as const;
  readonly label: string;
  private before?: TransitSaveState;
  private after?: TransitSaveState;
  private result?: SimulationCommandResult;
  constructor(private readonly data: Extract<SimulationCommandData, { type: 'place-bus-stop' | 'remove-bus-stop' | 'create-bus-line' | 'update-bus-line' | 'remove-bus-line' }>,
    private readonly transit: TransitSystem, private readonly gameSeconds: () => number) {
    this.label = data.type;
  }
  execute(): SimulationCommandResult {
    this.before = this.transit.save();
    try {
      switch (this.data.type) {
        case 'place-bus-stop': this.result = { type: 'place-bus-stop', stop: this.transit.placeStop(this.data.position, this.data.name) }; break;
        case 'remove-bus-stop': this.transit.removeStop(this.data.stopId); this.result = { type: 'remove-bus-stop', stopId: this.data.stopId }; break;
        case 'create-bus-line': this.result = { type: 'create-bus-line', line: this.transit.createLine(this.data.input, this.gameSeconds()) }; break;
        case 'update-bus-line': this.result = { type: 'update-bus-line', line: this.transit.updateLine(this.data.lineId, this.data.input, this.gameSeconds()) }; break;
        case 'remove-bus-line': this.transit.removeLine(this.data.lineId); this.result = { type: 'remove-bus-line', lineId: this.data.lineId }; break;
      }
      this.after = this.transit.save();
      return this.result;
    } catch (error) {
      this.transit.restore(this.before, this.gameSeconds());
      throw error;
    }
  }
  undo(): void {
    if (!this.before) throw new Error('Transit command was not executed.');
    this.transit.restore(this.before, this.gameSeconds());
  }
  redo(): SimulationCommandResult {
    if (!this.after || !this.result) throw new Error('Transit command was not executed.');
    this.transit.restore(this.after, this.gameSeconds());
    return this.result;
  }
}

export class SetWaterLevelCommand implements SimulationCommand {
  readonly label = 'Set water level';
  readonly domain = 'water' as const;
  private before?: number;
  constructor(private readonly water: StaticWater, private readonly seaLevel: number) {}
  execute(): SimulationCommandResult {
    this.before = this.water.seaLevel;
    this.water.setSeaLevel(this.seaLevel);
    return { type: 'set-water-level', seaLevel: this.seaLevel };
  }
  undo(): void {
    if (this.before === undefined) throw new Error('Water command was not executed.');
    this.water.setSeaLevel(this.before);
  }
  redo(): SimulationCommandResult { return this.execute(); }
}

export class CommandHistory {
  private readonly undoStack: SimulationCommand[] = [];
  private readonly redoStack: SimulationCommand[] = [];
  lastDomain?: SimulationCommand['domain'];
  lastAffectedCellIds: readonly ZoningCellId[] = [];
  lastAffectedChunkIds: readonly ChunkDescriptor['id'][] = [];
  lastTerrainBounds?: TerrainEditBounds;
  private lastCommand?: SimulationCommand;

  execute(command: SimulationCommand, graph: RoadGraph): SimulationCommandResult {
    const result = command.execute(graph);
    this.lastDomain = command.domain;
    this.lastAffectedCellIds = command.affectedCellIds ?? [];
    this.lastAffectedChunkIds = command.affectedChunkIds ?? [];
    this.lastTerrainBounds = command.affectedTerrainBounds;
    this.lastCommand = command;
    this.undoStack.push(command);
    this.redoStack.length = 0;
    return result;
  }

  finalizeLastRoadCommand(): void {
    if (this.lastDomain === 'road') this.lastCommand?.finalize?.();
  }

  undo(graph: RoadGraph): boolean {
    const command = this.undoStack.pop();
    if (!command) return false;
    command.undo(graph);
    this.lastDomain = command.domain;
    this.lastAffectedCellIds = command.affectedCellIds ?? [];
    this.lastAffectedChunkIds = command.affectedChunkIds ?? [];
    this.lastTerrainBounds = command.affectedTerrainBounds;
    this.lastCommand = command;
    this.redoStack.push(command);
    return true;
  }

  redo(graph: RoadGraph): boolean {
    const command = this.redoStack.pop();
    if (!command) return false;
    command.redo(graph);
    this.lastDomain = command.domain;
    this.lastAffectedCellIds = command.affectedCellIds ?? [];
    this.lastAffectedChunkIds = command.affectedChunkIds ?? [];
    this.lastTerrainBounds = command.affectedTerrainBounds;
    this.lastCommand = command;
    this.undoStack.push(command);
    return true;
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.lastDomain = undefined;
    this.lastAffectedCellIds = [];
    this.lastAffectedChunkIds = [];
    this.lastTerrainBounds = undefined;
    this.lastCommand = undefined;
  }
}

export const commandFromData = (data: SimulationCommandData, assignments: Map<ZoningCellId, ZoneType>,
  terrainHeight?: (x: number, z: number) => number, economy?: EconomySystem, gameSeconds?: () => number,
  services?: ServiceSystem, lots?: () => readonly Lot[], cells?: () => readonly ZoningCell[], transit?: TransitSystem,
  water?: StaticWater): SimulationCommand => {
  switch (data.type) {
    case 'build-road': return new BuildRoadCommand(data.input, assignments, terrainHeight, economy, gameSeconds, services, water);
    case 'remove-road': return new RemoveRoadCommand(data.segmentId, assignments);
    case 'set-zone': return new SetZoneCommand(data.cellIds, data.zoneType, assignments);
    case 'place-service':
      if (!services || !economy || !gameSeconds || !lots || !cells || !terrainHeight) throw new Error('Service system is unavailable.');
      return new PlaceServiceCommand(data.serviceType, data.position, services, economy, gameSeconds, lots, cells, terrainHeight);
    case 'remove-service':
      if (!services) throw new Error('Service system is unavailable.');
      return new RemoveServiceCommand(data.facilityId, services);
    case 'place-bus-stop':
    case 'remove-bus-stop':
    case 'create-bus-line':
    case 'update-bus-line':
    case 'remove-bus-line':
      if (!transit || !gameSeconds) throw new Error('Transit system is unavailable.');
      return new TransitCommand(data, transit, gameSeconds);
    case 'set-water-level':
      if (!water) throw new Error('Water system is unavailable.');
      return new SetWaterLevelCommand(water, data.seaLevel);
  }
};
