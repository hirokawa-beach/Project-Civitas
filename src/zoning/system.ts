import type { RoadGraphSnapshot, RoadSegment } from '../roads/types';
import type { ChunkDescriptor } from '../world/types';
import { CHUNK_SIZE, HALF_WORLD_SIZE, WORLD_SIZE } from '../world/types';
import { generateZoningCells, zoningInfluenceRadius, type ZoningBounds } from './generator';
import type { ZoningCell } from './types';

const CHUNK_COUNT = WORLD_SIZE / CHUNK_SIZE;

const segmentSignature = (segment: RoadSegment): string => JSON.stringify([
  segment.geometry.points,
  segment.width,
  segment.zoningAllowed,
  segment.zoningLineageId,
  segment.zoningStartOffset,
]);

const chunkId = (x: number, z: number): ChunkDescriptor['id'] => `chunk-${x}-${z}`;

const chunkRangeForSegment = (segment: RoadSegment, halo: number): Array<{ x: number; z: number }> => {
  const points = segment.geometry.points;
  const minX = Math.min(...points.map((point) => point.x)) - halo;
  const maxX = Math.max(...points.map((point) => point.x)) + halo;
  const minZ = Math.min(...points.map((point) => point.z)) - halo;
  const maxZ = Math.max(...points.map((point) => point.z)) + halo;
  if (maxX < -HALF_WORLD_SIZE || minX >= HALF_WORLD_SIZE || maxZ < -HALF_WORLD_SIZE || minZ >= HALF_WORLD_SIZE) return [];
  const fromX = Math.max(0, Math.floor((minX + HALF_WORLD_SIZE) / CHUNK_SIZE));
  const toX = Math.min(CHUNK_COUNT - 1, Math.floor((maxX + HALF_WORLD_SIZE) / CHUNK_SIZE));
  const fromZ = Math.max(0, Math.floor((minZ + HALF_WORLD_SIZE) / CHUNK_SIZE));
  const toZ = Math.min(CHUNK_COUNT - 1, Math.floor((maxZ + HALF_WORLD_SIZE) / CHUNK_SIZE));
  const chunks: Array<{ x: number; z: number }> = [];
  for (let x = fromX; x <= toX; x += 1) {
    for (let z = fromZ; z <= toZ; z += 1) chunks.push({ x, z });
  }
  return chunks;
};

const boundsForChunk = (coordinate: { x: number; z: number }): ZoningBounds => ({
  minX: -HALF_WORLD_SIZE + coordinate.x * CHUNK_SIZE,
  maxX: -HALF_WORLD_SIZE + (coordinate.x + 1) * CHUNK_SIZE,
  minZ: -HALF_WORLD_SIZE + coordinate.z * CHUNK_SIZE,
  maxZ: -HALF_WORLD_SIZE + (coordinate.z + 1) * CHUNK_SIZE,
});

const withinBounds = (cell: ZoningCell, bounds: ZoningBounds): boolean =>
  cell.center.x >= bounds.minX && cell.center.x < bounds.maxX
  && cell.center.z >= bounds.minZ && cell.center.z < bounds.maxZ;

export class ZoningSystem {
  private previousSegments = new Map<RoadSegment['id'], RoadSegment>();
  private cells: ZoningCell[] = [];
  private initialized = false;
  private updatedChunkIds: ChunkDescriptor['id'][] = [];

  update(graph: RoadGraphSnapshot): ZoningCell[] {
    const currentSegments = new Map(graph.segments.map((segment) => [segment.id, segment]));
    if (!this.initialized) {
      this.cells = generateZoningCells(graph);
      this.previousSegments = new Map(graph.segments.map((segment) => [segment.id, structuredClone(segment)]));
      this.updatedChunkIds = graph.segments.length === 0
        ? []
        : Array.from({ length: CHUNK_COUNT * CHUNK_COUNT }, (_, index) => chunkId(index % CHUNK_COUNT, Math.floor(index / CHUNK_COUNT)));
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
      for (const coordinate of chunkRangeForSegment(segment, halo)) dirtyCoordinates.set(`${coordinate.x}:${coordinate.z}`, coordinate);
    }
    const coordinates = [...dirtyCoordinates.values()];
    const dirtyBounds = coordinates.map(boundsForChunk);
    const retained = this.cells.filter((cell) => !dirtyBounds.some((bounds) => withinBounds(cell, bounds)));
    const regenerated = coordinates.flatMap((coordinate) => generateZoningCells(graph, { bounds: boundsForChunk(coordinate) }));
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
