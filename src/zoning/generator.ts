import { pointAtDistance, polylineLength } from '../roads/geometry';
import type { RoadGraphSnapshot, RoadSegment } from '../roads/types';
import type { Vec2 } from '../world/types';
import type { ZoningCell } from './types';

export const ZONING_CELL_SIZE = 8 as const;
export const ZONING_MAX_DEPTH = 6;
const CELL_SIZE = ZONING_CELL_SIZE;
const MAX_DEPTH = ZONING_MAX_DEPTH;
const GEOMETRY_EPSILON = 1e-4;
const SPATIAL_BUCKET_SIZE = CELL_SIZE * 2;
const CELL_HALF_DIAGONAL = CELL_SIZE / Math.SQRT2;
const CELL_CONFLICT_DISTANCE = CELL_SIZE * Math.SQRT2 + GEOMETRY_EPSILON;
const CURVE_CLEARANCE_MARGIN = 0.25;

type CellCorners = ZoningCell['corners'];

interface Bounds2D {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export type ZoningBounds = Bounds2D;

export interface GenerateZoningOptions {
  /**
   * Keeps cells whose centers are within these half-open bounds. Only the
   * candidates and obstacles that can influence that slice are evaluated.
   */
  bounds?: ZoningBounds;
  /** Optional counters used by tests and the debug HUD/profiler. */
  stats?: Partial<ZoningGenerationStats>;
}

export interface ZoningGenerationStats {
  segmentsScanned: number;
  segmentsEvaluated: number;
  candidateColumnsEvaluated: number;
  candidateCentersEvaluated: number;
  validCandidates: number;
  roadPartsIndexed: number;
  junctionsIndexed: number;
  resultCells: number;
}

interface CandidateCell {
  cell: ZoningCell;
  bounds: Bounds2D;
  priority: string;
}

interface RoadSurfacePart {
  start: Vec2;
  end: Vec2;
  halfWidth: number;
  bounds: Bounds2D;
}

interface JunctionClearance {
  center: Vec2;
  radius: number;
  bounds: Bounds2D;
}

interface LineageExtent {
  min: number;
  max: number;
}

interface CandidateColumn {
  /** Stable 8 m index measured from the original road stroke's origin. */
  phaseIndex: number;
  /** Distance from this split segment's start. */
  along: number;
}

const cornersForCell = (center: Vec2, tangent: Vec2, normal: Vec2): CellCorners => {
  const half = CELL_SIZE / 2;
  return [
    { x: center.x - tangent.x * half - normal.x * half, z: center.z - tangent.z * half - normal.z * half },
    { x: center.x + tangent.x * half - normal.x * half, z: center.z + tangent.z * half - normal.z * half },
    { x: center.x + tangent.x * half + normal.x * half, z: center.z + tangent.z * half + normal.z * half },
    { x: center.x - tangent.x * half + normal.x * half, z: center.z - tangent.z * half + normal.z * half },
  ];
};

const boundsForPoints = (points: readonly Vec2[], padding = 0): Bounds2D => ({
  minX: Math.min(...points.map((point) => point.x)) - padding,
  maxX: Math.max(...points.map((point) => point.x)) + padding,
  minZ: Math.min(...points.map((point) => point.z)) - padding,
  maxZ: Math.max(...points.map((point) => point.z)) + padding,
});

const expandBounds = (bounds: Bounds2D, padding: number): Bounds2D => ({
  minX: bounds.minX - padding,
  maxX: bounds.maxX + padding,
  minZ: bounds.minZ - padding,
  maxZ: bounds.maxZ + padding,
});

const boundsOverlap = (a: Bounds2D, b: Bounds2D): boolean =>
  a.minX < b.maxX - GEOMETRY_EPSILON &&
  a.maxX > b.minX + GEOMETRY_EPSILON &&
  a.minZ < b.maxZ - GEOMETRY_EPSILON &&
  a.maxZ > b.minZ + GEOMETRY_EPSILON;

const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.z * b.z;
const cross = (a: Vec2, b: Vec2): number => a.x * b.z - a.z * b.x;
const subtract = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, z: a.z - b.z });
const squaredDistance = (a: Vec2, b: Vec2): number => (a.x - b.x) ** 2 + (a.z - b.z) ** 2;

const projectionRange = (corners: CellCorners, axis: Vec2): [number, number] => {
  let min = dot(corners[0], axis);
  let max = min;
  for (let index = 1; index < corners.length; index += 1) {
    const projection = dot(corners[index], axis);
    min = Math.min(min, projection);
    max = Math.max(max, projection);
  }
  return [min, max];
};

/** Strict SAT overlap: cells that merely share an edge or corner are allowed. */
const cellsOverlap = (a: CellCorners, b: CellCorners): boolean => {
  for (const corners of [a, b]) {
    for (let index = 0; index < corners.length; index += 1) {
      const edge = subtract(corners[(index + 1) % corners.length], corners[index]);
      const axis = { x: -edge.z, z: edge.x };
      const [aMin, aMax] = projectionRange(a, axis);
      const [bMin, bMax] = projectionRange(b, axis);
      if (aMax <= bMin + GEOMETRY_EPSILON || bMax <= aMin + GEOMETRY_EPSILON) return false;
    }
  }
  return true;
};

const orientation = (a: Vec2, b: Vec2, c: Vec2): number =>
  (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);

const pointOnSegment = (point: Vec2, start: Vec2, end: Vec2): boolean =>
  Math.abs(orientation(start, end, point)) <= GEOMETRY_EPSILON &&
  point.x >= Math.min(start.x, end.x) - GEOMETRY_EPSILON &&
  point.x <= Math.max(start.x, end.x) + GEOMETRY_EPSILON &&
  point.z >= Math.min(start.z, end.z) - GEOMETRY_EPSILON &&
  point.z <= Math.max(start.z, end.z) + GEOMETRY_EPSILON;

const segmentsIntersect = (a0: Vec2, a1: Vec2, b0: Vec2, b1: Vec2): boolean => {
  const a = orientation(a0, a1, b0);
  const b = orientation(a0, a1, b1);
  const c = orientation(b0, b1, a0);
  const d = orientation(b0, b1, a1);
  if (((a > GEOMETRY_EPSILON && b < -GEOMETRY_EPSILON) || (a < -GEOMETRY_EPSILON && b > GEOMETRY_EPSILON)) &&
      ((c > GEOMETRY_EPSILON && d < -GEOMETRY_EPSILON) || (c < -GEOMETRY_EPSILON && d > GEOMETRY_EPSILON))) return true;
  return (Math.abs(a) <= GEOMETRY_EPSILON && pointOnSegment(b0, a0, a1)) ||
    (Math.abs(b) <= GEOMETRY_EPSILON && pointOnSegment(b1, a0, a1)) ||
    (Math.abs(c) <= GEOMETRY_EPSILON && pointOnSegment(a0, b0, b1)) ||
    (Math.abs(d) <= GEOMETRY_EPSILON && pointOnSegment(a1, b0, b1));
};

const pointToSegmentSquared = (point: Vec2, start: Vec2, end: Vec2): number => {
  const delta = subtract(end, start);
  const lengthSquared = dot(delta, delta);
  if (lengthSquared <= GEOMETRY_EPSILON) return squaredDistance(point, start);
  const offset = subtract(point, start);
  const t = Math.max(0, Math.min(1, dot(offset, delta) / lengthSquared));
  return squaredDistance(point, { x: start.x + delta.x * t, z: start.z + delta.z * t });
};

const segmentToSegmentSquared = (a0: Vec2, a1: Vec2, b0: Vec2, b1: Vec2): number => {
  if (segmentsIntersect(a0, a1, b0, b1)) return 0;
  return Math.min(
    pointToSegmentSquared(a0, b0, b1),
    pointToSegmentSquared(a1, b0, b1),
    pointToSegmentSquared(b0, a0, a1),
    pointToSegmentSquared(b1, a0, a1),
  );
};

const pointInCell = (point: Vec2, corners: CellCorners): boolean => {
  let sign = 0;
  for (let index = 0; index < corners.length; index += 1) {
    const turn = orientation(corners[index], corners[(index + 1) % corners.length], point);
    if (Math.abs(turn) <= GEOMETRY_EPSILON) continue;
    const currentSign = Math.sign(turn);
    if (sign !== 0 && currentSign !== sign) return false;
    sign = currentSign;
  }
  return true;
};

const pointToCellSquared = (point: Vec2, corners: CellCorners): number => {
  if (pointInCell(point, corners)) return 0;
  let minimum = Number.POSITIVE_INFINITY;
  for (let index = 0; index < corners.length; index += 1) {
    minimum = Math.min(minimum, pointToSegmentSquared(point, corners[index], corners[(index + 1) % corners.length]));
  }
  return minimum;
};

const cellToSegmentSquared = (corners: CellCorners, start: Vec2, end: Vec2): number => {
  if (pointInCell(start, corners) || pointInCell(end, corners)) return 0;
  let minimum = Number.POSITIVE_INFINITY;
  for (let index = 0; index < corners.length; index += 1) {
    minimum = Math.min(minimum, segmentToSegmentSquared(start, end, corners[index], corners[(index + 1) % corners.length]));
  }
  return minimum;
};

const endpointDirection = (segment: RoadSegment, nodeId: string): Vec2 | undefined => {
  const points = segment.geometry.points;
  if (points.length < 2) return undefined;
  const fromStart = segment.startNodeId === nodeId;
  const origin = fromStart ? points[0] : points[points.length - 1];
  for (let offset = 1; offset < points.length; offset += 1) {
    const candidate = fromStart ? points[offset] : points[points.length - 1 - offset];
    const delta = subtract(candidate, origin);
    const length = Math.hypot(delta.x, delta.z);
    if (length > GEOMETRY_EPSILON) return { x: delta.x / length, z: delta.z / length };
  }
  return undefined;
};

const buildJunctionClearances = (graph: RoadGraphSnapshot, queryBounds?: Bounds2D): JunctionClearance[] => {
  const incident = new Map<string, RoadSegment[]>();
  for (const segment of graph.segments) {
    for (const nodeId of [segment.startNodeId, segment.endNodeId]) {
      const segments = incident.get(nodeId) ?? [];
      segments.push(segment);
      incident.set(nodeId, segments);
    }
  }

  const clearances: JunctionClearance[] = [];
  for (const node of graph.nodes) {
    const segments = incident.get(node.id) ?? [];
    if (segments.length < 2) continue;
    const directions = segments
      .map((segment) => endpointDirection(segment, node.id))
      .filter((direction): direction is Vec2 => direction !== undefined);
    const isStraightContinuation = segments.length === 2 && directions.length === 2 && dot(directions[0], directions[1]) < -0.98;
    if (isStraightContinuation) continue;
    const radius = Math.max(CELL_SIZE * 2, ...segments.map((segment) => segment.width));
    const clearance: JunctionClearance = {
      center: node.position,
      radius,
      bounds: {
        minX: node.position.x - radius,
        maxX: node.position.x + radius,
        minZ: node.position.z - radius,
        maxZ: node.position.z + radius,
      },
    };
    if (!queryBounds || boundsOverlap(clearance.bounds, queryBounds)) clearances.push(clearance);
  }
  return clearances;
};

const buildRoadSurfaceParts = (graph: RoadGraphSnapshot, queryBounds?: Bounds2D): RoadSurfacePart[] => {
  const parts: RoadSurfacePart[] = [];
  for (const road of graph.segments) {
    for (let index = 0; index < road.geometry.points.length - 1; index += 1) {
      const start = road.geometry.points[index];
      const end = road.geometry.points[index + 1];
      const part: RoadSurfacePart = {
        start,
        end,
        halfWidth: road.width / 2,
        bounds: boundsForPoints([start, end], road.width / 2),
      };
      if (!queryBounds || boundsOverlap(part.bounds, queryBounds)) parts.push(part);
    }
  }
  return parts;
};

const bucketRange = (bounds: Bounds2D): [number, number, number, number] => [
  Math.floor(bounds.minX / SPATIAL_BUCKET_SIZE),
  Math.floor(bounds.maxX / SPATIAL_BUCKET_SIZE),
  Math.floor(bounds.minZ / SPATIAL_BUCKET_SIZE),
  Math.floor(bounds.maxZ / SPATIAL_BUCKET_SIZE),
];

const bucketKey = (x: number, z: number): string => `${x}:${z}`;

const withinBounds = (center: Vec2, bounds: ZoningBounds): boolean =>
  center.x >= bounds.minX && center.x < bounds.maxX && center.z >= bounds.minZ && center.z < bounds.maxZ;

const withinClosedBounds = (center: Vec2, bounds: Bounds2D): boolean =>
  center.x >= bounds.minX - GEOMETRY_EPSILON && center.x <= bounds.maxX + GEOMETRY_EPSILON
  && center.z >= bounds.minZ - GEOMETRY_EPSILON && center.z <= bounds.maxZ + GEOMETRY_EPSILON;

const clippedParameterRange = (start: Vec2, end: Vec2, bounds: Bounds2D): [number, number] | undefined => {
  let minimum = 0;
  let maximum = 1;
  for (const axis of ['x', 'z'] as const) {
    const delta = end[axis] - start[axis];
    const lower = axis === 'x' ? bounds.minX : bounds.minZ;
    const upper = axis === 'x' ? bounds.maxX : bounds.maxZ;
    if (Math.abs(delta) <= GEOMETRY_EPSILON) {
      if (start[axis] < lower - GEOMETRY_EPSILON || start[axis] > upper + GEOMETRY_EPSILON) return undefined;
      continue;
    }
    let near = (lower - start[axis]) / delta;
    let far = (upper - start[axis]) / delta;
    if (near > far) [near, far] = [far, near];
    minimum = Math.max(minimum, near);
    maximum = Math.min(maximum, far);
    if (minimum > maximum + GEOMETRY_EPSILON) return undefined;
  }
  return [Math.max(0, minimum), Math.min(1, maximum)];
};

/**
 * Returns only the 8 m columns whose source polyline points can yield a center
 * inside `centerBounds`. A long road crossing one chunk therefore costs only
 * the columns around that chunk, rather than every column in the world.
 */
const columnsForSegment = (
  segment: RoadSegment,
  lineageExtent: LineageExtent,
  centerBounds?: Bounds2D,
): CandidateColumn[] => {
  const length = polylineLength(segment.geometry.points);
  if (length < GEOMETRY_EPSILON) return [];
  const startOffset = segment.zoningStartOffset ?? 0;
  const firstPhaseIndex = Math.ceil((lineageExtent.min - GEOMETRY_EPSILON) / CELL_SIZE);
  const lastPhaseIndex = Math.floor((lineageExtent.max - CELL_SIZE + GEOMETRY_EPSILON) / CELL_SIZE);
  if (lastPhaseIndex < firstPhaseIndex) return [];

  const belongsToSegment = (phaseIndex: number): CandidateColumn | undefined => {
    const lineageAlong = CELL_SIZE / 2 + phaseIndex * CELL_SIZE;
    const along = lineageAlong - startOffset;
    // A sample exactly on a split belongs to the preceding segment. That is
    // also how pointAtDistance sampled the unsplit polyline at a vertex.
    if (along <= GEOMETRY_EPSILON || along > length + GEOMETRY_EPSILON) return undefined;
    return { phaseIndex, along: Math.min(length, along) };
  };

  if (!centerBounds) {
    const result: CandidateColumn[] = [];
    for (let phaseIndex = firstPhaseIndex; phaseIndex <= lastPhaseIndex; phaseIndex += 1) {
      const column = belongsToSegment(phaseIndex);
      if (column) result.push(column);
    }
    return result;
  }

  const maximumOffset = segment.width / 2 + CELL_SIZE / 2 + (MAX_DEPTH - 1) * CELL_SIZE;
  const sourceBounds = expandBounds(centerBounds, maximumOffset);
  const phaseIndices = new Set<number>();
  let traversed = 0;
  for (let index = 0; index < segment.geometry.points.length - 1; index += 1) {
    const start = segment.geometry.points[index];
    const end = segment.geometry.points[index + 1];
    const partLength = Math.hypot(end.x - start.x, end.z - start.z);
    const range = clippedParameterRange(start, end, sourceBounds);
    if (range && partLength > GEOMETRY_EPSILON) {
      const from = traversed + range[0] * partLength;
      const to = traversed + range[1] * partLength;
      const first = Math.max(
        firstPhaseIndex,
        Math.ceil((startOffset + from - CELL_SIZE / 2 - GEOMETRY_EPSILON) / CELL_SIZE),
      );
      const last = Math.min(
        lastPhaseIndex,
        Math.floor((startOffset + to - CELL_SIZE / 2 + GEOMETRY_EPSILON) / CELL_SIZE),
      );
      for (let phaseIndex = first; phaseIndex <= last; phaseIndex += 1) phaseIndices.add(phaseIndex);
    }
    traversed += partLength;
  }
  return [...phaseIndices]
    .sort((left, right) => left - right)
    .map(belongsToSegment)
    .filter((column): column is CandidateColumn => column !== undefined);
};

const buildLineageExtents = (segments: readonly RoadSegment[]): Map<RoadSegment['id'], LineageExtent> => {
  const grouped = new Map<string, Array<{ segment: RoadSegment; min: number; max: number }>>();
  for (const segment of segments) {
    const key = segment.zoningLineageId ?? segment.id;
    const start = segment.zoningStartOffset ?? 0;
    const end = start + polylineLength(segment.geometry.points);
    const entries = grouped.get(key) ?? [];
    entries.push({ segment, min: Math.min(start, end), max: Math.max(start, end) });
    grouped.set(key, entries);
  }

  const result = new Map<RoadSegment['id'], LineageExtent>();
  for (const entries of grouped.values()) {
    entries.sort((left, right) => left.min - right.min || left.max - right.max);
    let component: typeof entries = [];
    let componentMax = Number.NEGATIVE_INFINITY;
    const finishComponent = (): void => {
      if (component.length === 0) return;
      const extent = { min: component[0].min, max: componentMax };
      for (const entry of component) result.set(entry.segment.id, extent);
    };
    for (const entry of entries) {
      if (component.length > 0 && entry.min > componentMax + GEOMETRY_EPSILON) {
        finishComponent();
        component = [];
        componentMax = Number.NEGATIVE_INFINITY;
      }
      component.push(entry);
      componentMax = Math.max(componentMax, entry.max);
    }
    finishComponent();
  }
  return result;
};

/**
 * Returns the side facing the local center of curvature. A square whose
 * road-facing edge is tangent to that side puts its corners inside the curved
 * pavement, so concave cells use an offset-strip quadrilateral instead.
 */
const concaveSideAt = (segment: RoadSegment, along: number, length: number): -1 | 1 | undefined => {
  const halfWindow = CELL_SIZE / 2;
  const from = Math.max(0, along - halfWindow);
  const to = Math.min(length, along + halfWindow);
  if (to - from <= GEOMETRY_EPSILON) return undefined;
  const before = pointAtDistance(segment.geometry.points, from).tangent;
  const after = pointAtDistance(segment.geometry.points, to).tangent;
  const turn = Math.atan2(cross(before, after), dot(before, after));
  if (Math.abs(turn) <= GEOMETRY_EPSILON) return undefined;
  return turn > 0 ? 1 : -1;
};

const offsetPoint = (sample: { point: Vec2; tangent: Vec2 }, side: -1 | 1, distance: number): Vec2 => ({
  x: sample.point.x - sample.tangent.z * distance * side,
  z: sample.point.z + sample.tangent.x * distance * side,
});

const concaveCornersForCell = (
  segment: RoadSegment,
  along: number,
  length: number,
  side: -1 | 1,
  depth: number,
): CellCorners | undefined => {
  const half = CELL_SIZE / 2;
  // Split fragments can own a lineage column less than half a cell from their
  // endpoint. Keep the square fallback there; junction clearance normally
  // removes it, while straight degree-two splits retain their exact layout.
  if (along < half || along > length - half) return undefined;
  const start = pointAtDistance(segment.geometry.points, along - half);
  const end = pointAtDistance(segment.geometry.points, along + half);
  const near = segment.width / 2 + depth * CELL_SIZE + CURVE_CLEARANCE_MARGIN;
  const far = near + CELL_SIZE;
  return [
    offsetPoint(start, side, near),
    offsetPoint(end, side, near),
    offsetPoint(end, side, far),
    offsetPoint(start, side, far),
  ];
};

const centerForCorners = (corners: CellCorners): Vec2 => ({
  x: normalizedCoordinate(corners.reduce((sum, corner) => sum + corner.x, 0) / corners.length),
  z: normalizedCoordinate(corners.reduce((sum, corner) => sum + corner.z, 0) / corners.length),
});

const quantized = (value: number): number => Math.round(value * 10_000);
const normalizedCoordinate = (value: number): number => Math.round(value * 1_000_000_000) / 1_000_000_000;

/**
 * IDs describe the cell's world-space footprint instead of its owning road.
 * Replacing/splitting a segment therefore preserves IDs for unchanged cells.
 */
const worldCellId = (center: Vec2, tangent: Vec2): ZoningCell['id'] => {
  const reversed = tangent.x < -GEOMETRY_EPSILON
    || (Math.abs(tangent.x) <= GEOMETRY_EPSILON && tangent.z < 0);
  const canonical = reversed ? { x: -tangent.x, z: -tangent.z } : tangent;
  return `zone-world-${quantized(center.x)}-${quantized(center.z)}-${quantized(canonical.x)}-${quantized(canonical.z)}`;
};

/** Maximum distance at which changing a road can alter a zoning-cell owner chunk. */
export const zoningInfluenceRadius = (roadWidth: number): number =>
  roadWidth + MAX_DEPTH * CELL_SIZE + CELL_CONFLICT_DISTANCE;

/**
 * Greedy overlap resolution can depend on a chain of competing cells. For a
 * bounded rebuild, extend the candidate region until every conflict component
 * touching the requested slice is fully inside it.
 */
const targetConflictReachesEdge = (
  candidates: readonly CandidateCell[], target: Bounds2D, region: Bounds2D,
): boolean => {
  const parents = candidates.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parents[root] !== root) root = parents[root];
    while (parents[index] !== index) {
      const next = parents[index];
      parents[index] = root;
      index = next;
    }
    return root;
  };
  const buckets = new Map<string, number[]>();
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const [minX, maxX, minZ, maxZ] = bucketRange(candidate.bounds);
    const nearby = new Set<number>();
    for (let x = minX; x <= maxX; x += 1) {
      for (let z = minZ; z <= maxZ; z += 1) {
        const key = bucketKey(x, z);
        for (const other of buckets.get(key) ?? []) nearby.add(other);
        const entries = buckets.get(key) ?? [];
        entries.push(index);
        buckets.set(key, entries);
      }
    }
    for (const other of nearby) {
      if (boundsOverlap(candidate.bounds, candidates[other].bounds)
        && cellsOverlap(candidate.cell.corners, candidates[other].cell.corners)) {
        parents[find(index)] = find(other);
      }
    }
  }
  const targetRoots = new Set<number>();
  for (let index = 0; index < candidates.length; index += 1) {
    if (withinBounds(candidates[index].cell.center, target)) targetRoots.add(find(index));
  }
  const margin = CELL_CONFLICT_DISTANCE * 2;
  for (let index = 0; index < candidates.length; index += 1) {
    if (!targetRoots.has(find(index))) continue;
    const center = candidates[index].cell.center;
    if (center.x < region.minX + margin || center.x > region.maxX - margin
      || center.z < region.minZ + margin || center.z > region.maxZ - margin) return true;
  }
  return false;
};

const buildCandidates = (graph: RoadGraphSnapshot, influenceBounds?: Bounds2D): {
  candidates: CandidateCell[]; stats: ZoningGenerationStats;
} => {
  const stats: ZoningGenerationStats = {
    segmentsScanned: graph.segments.length,
    segmentsEvaluated: 0,
    candidateColumnsEvaluated: 0,
    candidateCentersEvaluated: 0,
    validCandidates: 0,
    roadPartsIndexed: 0,
    junctionsIndexed: 0,
    resultCells: 0,
  };
  const candidateFootprintBounds = influenceBounds ? expandBounds(influenceBounds, CELL_HALF_DIAGONAL) : undefined;
  const roadParts = buildRoadSurfaceParts(graph, candidateFootprintBounds);
  const junctions = buildJunctionClearances(graph, candidateFootprintBounds);
  const lineageExtents = buildLineageExtents(graph.segments);
  stats.roadPartsIndexed = roadParts.length;
  stats.junctionsIndexed = junctions.length;
  const candidates: CandidateCell[] = [];

  for (const segment of graph.segments) {
    if (!segment.zoningAllowed) continue;
    const lineageExtent = lineageExtents.get(segment.id)!;
    const columns = columnsForSegment(segment, lineageExtent, influenceBounds);
    if (columns.length === 0) continue;
    const segmentLength = polylineLength(segment.geometry.points);
    stats.segmentsEvaluated += 1;
    stats.candidateColumnsEvaluated += columns.length;
    for (const column of columns) {
      const sample = pointAtDistance(segment.geometry.points, column.along);
      if (Math.hypot(sample.tangent.x, sample.tangent.z) <= GEOMETRY_EPSILON) continue;
      const normal = { x: -sample.tangent.z, z: sample.tangent.x };
      const concaveSide = concaveSideAt(segment, column.along, segmentLength);
      for (const side of [-1, 1] as const) {
        for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
          const offset = segment.width / 2 + CELL_SIZE / 2 + depth * CELL_SIZE;
          let center = {
            x: normalizedCoordinate(sample.point.x + normal.x * offset * side),
            z: normalizedCoordinate(sample.point.z + normal.z * offset * side),
          };
          let corners = cornersForCell(center, sample.tangent, normal);
          if (concaveSide === side) {
            const concaveCorners = concaveCornersForCell(segment, column.along, segmentLength, side, depth);
            if (concaveCorners) {
              corners = concaveCorners;
              center = centerForCorners(corners);
            }
          }
          if (influenceBounds && !withinClosedBounds(center, influenceBounds)) continue;
          stats.candidateCentersEvaluated += 1;
          const cellBounds = boundsForPoints(corners);

          const entersRoad = roadParts.some((road) =>
            boundsOverlap(cellBounds, road.bounds) &&
            cellToSegmentSquared(corners, road.start, road.end) < road.halfWidth ** 2 - GEOMETRY_EPSILON,
          );
          if (entersRoad) continue;

          const entersJunction = junctions.some((junction) =>
            boundsOverlap(cellBounds, junction.bounds) &&
            pointToCellSquared(junction.center, corners) < junction.radius ** 2 - GEOMETRY_EPSILON,
          );
          if (entersJunction) continue;
          const id = worldCellId(center, sample.tangent);
          const cell: ZoningCell = {
            id,
            roadSegmentId: segment.id,
            center,
            corners,
            angle: Math.atan2(sample.tangent.z, sample.tangent.x),
            depth,
            side,
            size: CELL_SIZE,
          };
          candidates.push({
            cell,
            bounds: cellBounds,
            // Concave offset rows have less circumference than the road
            // centerline, so consecutive 8 m columns can overlap. Give a
            // regularly spaced phase class first refusal instead of sorting
            // monotonically by world position; otherwise the local-minimum
            // rule below can erase an entire inward row. Deeper rows need a
            // wider phase because their offset path contracts more strongly.
            priority: `${String(((column.phaseIndex % (depth + 2)) + depth + 2) % (depth + 2)).padStart(2, '0')}|${String(depth).padStart(2, '0')}|${id}|${segment.zoningLineageId ?? segment.id}|${side}|${column.phaseIndex}`,
          });
        }
      }
    }
  }
  stats.validCandidates = candidates.length;
  return { candidates, stats };
};

export const generateZoningCells = (graph: RoadGraphSnapshot, options: GenerateZoningOptions = {}): ZoningCell[] => {
  let region = options.bounds ? expandBounds(options.bounds, CELL_CONFLICT_DISTANCE * 2) : undefined;
  let batch = buildCandidates(graph, region);
  if (options.bounds && region) {
    let padding = CELL_CONFLICT_DISTANCE * 2;
    while (targetConflictReachesEdge(batch.candidates, options.bounds, region)) {
      padding *= 2;
      region = expandBounds(options.bounds, padding);
      batch = buildCandidates(graph, region);
    }
  }
  const { candidates, stats } = batch;

  // Only cells that actually survive may block another cell. Rejected
  // candidates must not leave phantom gaps in otherwise usable frontage.
  // Keep the old priority order: every former local-minimum winner still wins,
  // so existing painted cell IDs remain valid after this coverage fix.
  candidates.sort((left, right) => left.priority.localeCompare(right.priority));
  const precedingBuckets = new Map<string, number[]>();
  const accepted: ZoningCell[] = [];
  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
    const candidate = candidates[candidateIndex];
    const [minBucketX, maxBucketX, minBucketZ, maxBucketZ] = bucketRange(candidate.bounds);
    const nearbyIndices = new Set<number>();
    for (let bucketX = minBucketX; bucketX <= maxBucketX; bucketX += 1) {
      for (let bucketZ = minBucketZ; bucketZ <= maxBucketZ; bucketZ += 1) {
        for (const index of precedingBuckets.get(bucketKey(bucketX, bucketZ)) ?? []) nearbyIndices.add(index);
      }
    }
    const dominated = [...nearbyIndices].some((index) => {
      const other = candidates[index];
      return boundsOverlap(candidate.bounds, other.bounds) && cellsOverlap(candidate.cell.corners, other.cell.corners);
    });
    if (!dominated) {
      for (let bucketX = minBucketX; bucketX <= maxBucketX; bucketX += 1) {
        for (let bucketZ = minBucketZ; bucketZ <= maxBucketZ; bucketZ += 1) {
          const key = bucketKey(bucketX, bucketZ);
          const indices = precedingBuckets.get(key) ?? [];
          indices.push(candidateIndex);
          precedingBuckets.set(key, indices);
        }
      }
      if (!options.bounds || withinBounds(candidate.cell.center, options.bounds)) accepted.push(candidate.cell);
    }
  }
  stats.resultCells = accepted.length;
  if (options.stats) Object.assign(options.stats, stats);
  return accepted;
};
