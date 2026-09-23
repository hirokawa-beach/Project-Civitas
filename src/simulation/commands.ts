import type { RoadSegmentId, ZoningCellId } from '../shared/ids';
import { RoadGraph, type BuildRoadResult } from '../roads/roadGraph';
import type { BuildRoadInput, RoadGraphSnapshot } from '../roads/types';
import type { ZoneBrush, ZoneType } from '../zoning/types';
import type { ChunkDescriptor, TerrainPreset } from '../world/types';
import { HeightmapTerrain } from '../terrain/heightmap';
import { exceedsTerrainGrade } from '../roads/validation';

export type SimulationCommandData =
  | { type: 'build-road'; input: BuildRoadInput }
  | { type: 'remove-road'; segmentId: RoadSegmentId }
  | { type: 'set-zone'; cellIds: ZoningCellId[]; zoneType: ZoneBrush };

export type SimulationCommandResult =
  | ({ type: 'build-road' } & BuildRoadResult)
  | { type: 'remove-road'; segmentId: RoadSegmentId }
  | { type: 'set-zone'; cellIds: ZoningCellId[]; zoneType: ZoneBrush }
  | { type: 'edit-terrain'; chunkIds: ChunkDescriptor['id'][] }
  | { type: 'set-terrain-preset'; preset: TerrainPreset };

export interface TerrainEditBounds { minX: number; maxX: number; minZ: number; maxZ: number }

export interface SimulationCommand {
  readonly label: string;
  readonly domain: 'road' | 'zone' | 'terrain';
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
  constructor(private readonly input: BuildRoadInput, assignments?: Map<ZoningCellId, ZoneType>, private readonly terrainHeight?: (x: number, z: number) => number) { super(assignments); }
  protected apply(graph: RoadGraph): SimulationCommandResult {
    const result = graph.buildRoad(this.input);
    if (this.terrainHeight && result.createdSegmentIds.some((id) => {
      const segment = graph.segments.get(id);
      return segment && exceedsTerrainGrade(segment.geometry.points, this.terrainHeight!);
    })) throw new Error('Road grade is too steep for surface placement.');
    return { type: 'build-road', ...result };
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

export const commandFromData = (data: SimulationCommandData, assignments: Map<ZoningCellId, ZoneType>, terrainHeight?: (x: number, z: number) => number): SimulationCommand => {
  switch (data.type) {
    case 'build-road': return new BuildRoadCommand(data.input, assignments, terrainHeight);
    case 'remove-road': return new RemoveRoadCommand(data.segmentId, assignments);
    case 'set-zone': return new SetZoneCommand(data.cellIds, data.zoneType, assignments);
  }
};
