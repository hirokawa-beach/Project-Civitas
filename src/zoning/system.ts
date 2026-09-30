import type { RoadGraphSnapshot, RoadSegment } from '../roads/types';
import type { ChunkDescriptor } from '../world/types';
import { createChunks, worldToChunk, LEGACY_CHUNK_WORLD, type ChunkWorld } from '../world/types';
import { generateZoningCells, zoningInfluenceRadius, type ZoningBounds } from './generator';
import type { ZoningCell } from './types';



const segmentSignature = (segment: RoadSegment): string => JSON.stringify([
  segment.geometry.points,
  segment.width,
  segment.zoningAllowed,
  segment.zoningLineageId,
  segment.zoningStartOffset,
]);

const chunkId = (x: number, z: number): ChunkDescriptor['id'] => `chunk-${x}-${z}`;

const chunkRangeForSegment = (segment: RoadSegment, halo: number, world: ChunkWorld): Array<{ x: number; z: number }> => {
  const points = segment.geometry.points;
  const minX = Math.min(...points.map((point) => point.x)) - halo;
  const maxX = Math.max(...points.map((point) => point.x)) + halo;
  const minZ = Math.min(...points.map((point) => point.z)) - halo;
  const maxZ = Math.max(...points.map((point) => point.z)) + halo;
  if (maxX < -world.worldWidthMeters / 2 || minX >= world.worldWidthMeters / 2 || maxZ < -world.worldDepthMeters / 2 || minZ >= world.worldDepthMeters / 2) return [];
  const fromX = Math.max(0, Math.floor((minX + world.worldWidthMeters / 2) / world.chunkSizeMeters));
  const toX = Math.min(Math.ceil(world.worldWidthMeters / world.chunkSizeMeters) - 1, Math.floor((maxX + world.worldWidthMeters / 2) / world.chunkSizeMeters));
  const fromZ = Math.max(0, Math.floor((minZ + world.worldDepthMeters / 2) / world.chunkSizeMeters));
  const toZ = Math.min(Math.ceil(world.worldDepthMeters / world.chunkSizeMeters) - 1, Math.floor((maxZ + world.worldDepthMeters / 2) / world.chunkSizeMeters));
  const chunks: Array<{ x: number; z: number }> = [];
  for (let x = fromX; x <= toX; x += 1) {
    for (let z = fromZ; z <= toZ; z += 1) chunks.push({ x, z });
  }
  return chunks;
};

const boundsForChunk = (coordinate: { x: number; z: number }, world: ChunkWorld): ZoningBounds => ({
  minX: -world.worldWidthMeters / 2 + coordinate.x * world.chunkSizeMeters,
  maxX: -world.worldWidthMeters / 2 + (coordinate.x + 1) * world.chunkSizeMeters,
  minZ: -world.worldDepthMeters / 2 + coordinate.z * world.chunkSizeMeters,
  maxZ: -world.worldDepthMeters / 2 + (coordinate.z + 1) * world.chunkSizeMeters,
});

export class ZoningSystem {
  constructor(public world: ChunkWorld = LEGACY_CHUNK_WORLD) {}
  setWorld(world: ChunkWorld): void { this.world = world; this.initialized = false; this.previousSegments.clear(); this.cells = []; }
  private previousSegments = new Map<RoadSegment['id'], RoadSegment>();
  private cells: ZoningCell[] = [];
  private initialized = false;
  private updatedChunkIds: ChunkDescriptor['id'][] = [];

  update(graph: RoadGraphSnapshot): ZoningCell[] {
    const currentSegments = new Map(graph.segments.map((segment) => [segment.id, segment]));
    if (!this.initialized) {
      this.cells = generateZoningCells(graph, { bounds: { minX: -this.world.worldWidthMeters / 2, maxX: this.world.worldWidthMeters / 2, minZ: -this.world.worldDepthMeters / 2, maxZ: this.world.worldDepthMeters / 2 } });
      this.previousSegments = new Map(graph.segments.map((segment) => [segment.id, structuredClone(segment)]));
      this.updatedChunkIds = graph.segments.length === 0
        ? []
        : createChunks(this.world).map(chunk => chunk.id);
      this.initialized = true;
      return structuredClone(this.cells);
    }

    const changedSegments: RoadSegment[] = [];
    const ids = new Set([...this.previousSegments.keys(), ...currentSegments.keys()]);
    for (const id of ids) {
      const previous = this.previousSegments.get(id);
      const current = currentSegments.get(id);
      if (!previous || !current || segmentSignature(previous) !== segmentSignature(current)) {
        if (previous) changedSegments.push(previous);
        if (current) changedSegments.push(current);
      }
    }
    if (changedSegments.length === 0) {
      this.updatedChunkIds = [];
      return structuredClone(this.cells);
    }

    const maximumRoadWidth = Math.max(0, ...changedSegments.map((segment) => segment.width), ...graph.segments.map((segment) => segment.width));
    const halo = zoningInfluenceRadius(maximumRoadWidth);
    const dirtyCoordinates = new Map<string, { x: number; z: number }>();
    for (const segment of changedSegments) {
      for (const coordinate of chunkRangeForSegment(segment, halo, this.world)) dirtyCoordinates.set(`${coordinate.x}:${coordinate.z}`, coordinate);
    }
    const coordinates = [...dirtyCoordinates.values()];
    const retained = this.cells.filter(cell => { const c = worldToChunk(cell.center, this.world); return !dirtyCoordinates.has(`${c.x}:${c.z}`); });
    const regenerated = coordinates.flatMap((coordinate) => generateZoningCells(graph, { bounds: boundsForChunk(coordinate, this.world) }));
    this.cells = [...retained, ...regenerated].sort((left, right) => left.id.localeCompare(right.id));
    this.previousSegments = new Map(graph.segments.map((segment) => [segment.id, structuredClone(segment)]));
    this.updatedChunkIds = coordinates
      .sort((left, right) => left.z - right.z || left.x - right.x)
      .map((coordinate) => chunkId(coordinate.x, coordinate.z));
    return structuredClone(this.cells);
  }

  getUpdatedChunkIds(): ChunkDescriptor['id'][] {
    return [...this.updatedChunkIds];
  }
}
