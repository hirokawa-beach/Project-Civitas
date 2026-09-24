import { HALF_WORLD_SIZE, type Vec2 } from '../world/types';
import { minimumPolylineRadius } from './curveGeometry';
import { distance, dot, polylineLength, segmentIntersection, subtract } from './geometry';
import { roadHeightAt } from './elevation';
import type { Vec3 } from '../terrain/heightmap';
import type { RoadGraphSnapshot } from './types';
import type { RoadStructureType } from './types';

export const ROAD_VALIDATION_REASON = {
  insufficientPoints: 'insufficient-points',
  invalidGeometry: 'invalid-geometry',
  outOfBounds: 'out-of-bounds',
  tooShort: 'too-short',
  selfIntersection: 'self-intersection',
  parallelOverlap: 'parallel-overlap',
  roadFootprintOverlap: 'road-footprint-overlap',
  sharpTurn: 'sharp-turn',
  shortKink: 'short-kink',
  curveRadius: 'curve-radius',
  steepGrade: 'steep-grade',
  verticalClearance: 'vertical-clearance',
} as const;

export type RoadValidationReason = (typeof ROAD_VALIDATION_REASON)[keyof typeof ROAD_VALIDATION_REASON];

export interface RoadValidationResult {
  valid: boolean;
  reasons: RoadValidationReason[];
}

export interface RoadValidationOptions {
  /** Inclusive center-line boundary. */
  halfWorldSize?: number;
  minimumLength?: number;
  candidateWidth?: number;
  /** Directions closer than this angle are considered nearly parallel. */
  nearParallelAngleDegrees?: number;
  /** Minimum projected run which must overlap before a parallel road is rejected. */
  minimumParallelOverlap?: number;
  /** Maximum direction change allowed at a single polyline vertex. */
  maximumTurnAngleDegrees?: number;
  /** A bend with a shorter adjoining leg than this is considered a kink. */
  minimumBendLegLength?: number;
  /** Ignore tiny direction changes when detecting short kinks. */
  minimumKinkAngleDegrees?: number;
  /** Zero disables curvature-radius validation. */
  minimumCurveRadius?: number;
  /** Radius measured from the source curve, before it is sampled into a polyline. */
  analyticalCurveRadius?: number;
  /** Height in metres at a world X/Z point; omitted for planar validation. */
  terrainHeight?: (x: number, z: number) => number;
  maximumGrade?: number;
  candidateCenterline?: readonly Vec3[];
  candidateStructureType?: RoadStructureType;
  minimumVerticalClearance?: number;
}

export const DEFAULT_ROAD_VALIDATION_OPTIONS = {
  halfWorldSize: HALF_WORLD_SIZE,
  minimumLength: 4,
  candidateWidth: 16,
  nearParallelAngleDegrees: 12,
  minimumParallelOverlap: 4,
  maximumTurnAngleDegrees: 135,
  minimumBendLegLength: 4,
  minimumKinkAngleDegrees: 20,
  minimumCurveRadius: 0,
  analyticalCurveRadius: Number.POSITIVE_INFINITY,
  maximumGrade: 0.12,
  minimumVerticalClearance: 6,
} as const satisfies Required<Omit<RoadValidationOptions, 'terrainHeight' | 'candidateCenterline' | 'candidateStructureType'>>;

const GEOMETRY_EPSILON = 1e-6;

interface LineSegment {
  start: Vec2;
  end: Vec2;
  length: number;
}

const isFinitePoint = (point: Vec2): boolean => Number.isFinite(point.x) && Number.isFinite(point.z);

const toSegments = (points: readonly Vec2[]): LineSegment[] => {
  const segments: LineSegment[] = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    segments.push({ start: points[index], end: points[index + 1], length: distance(points[index], points[index + 1]) });
  }
  return segments;
};

/** Samples each surface-road leg at heightmap resolution, including snapped endpoints. */
export const exceedsTerrainGrade = (
  points: readonly Vec2[], terrainHeight: (x: number, z: number) => number, maximumGrade = 0.12,
): boolean => {
  for (const segment of toSegments(points)) {
    if (segment.length <= GEOMETRY_EPSILON) continue;
    const steps = Math.max(1, Math.ceil(segment.length / 4));
    let previous = terrainHeight(segment.start.x, segment.start.z);
    for (let step = 1; step <= steps; step += 1) {
      const t = step / steps;
      const next = terrainHeight(segment.start.x + (segment.end.x - segment.start.x) * t, segment.start.z + (segment.end.z - segment.start.z) * t);
      if (!Number.isFinite(next) || !Number.isFinite(previous)
        || Math.abs(next - previous) / (segment.length / steps) > maximumGrade) return true;
      previous = next;
    }
  }
  return false;
};

const cross = (a: Vec2, b: Vec2): number => a.x * b.z - a.z * b.x;

const pointSegmentDistance = (point: Vec2, segment: LineSegment): number => {
  if (segment.length <= GEOMETRY_EPSILON) return distance(point, segment.start);
  const delta = subtract(segment.end, segment.start);
  const offset = subtract(point, segment.start);
  const t = Math.max(0, Math.min(1, dot(offset, delta) / (segment.length * segment.length)));
  return distance(point, {
    x: segment.start.x + delta.x * t,
    z: segment.start.z + delta.z * t,
  });
};

const segmentsIntersect = (a: LineSegment, b: LineSegment): boolean => {
  if (a.length <= GEOMETRY_EPSILON || b.length <= GEOMETRY_EPSILON) {
    return Math.min(
      pointSegmentDistance(a.start, b),
      pointSegmentDistance(b.start, a),
    ) <= GEOMETRY_EPSILON;
  }

  const r = subtract(a.end, a.start);
  const s = subtract(b.end, b.start);
  const offset = subtract(b.start, a.start);
  const denominator = cross(r, s);
  const scale = Math.max(1, a.length * b.length);

  if (Math.abs(denominator) > GEOMETRY_EPSILON * scale) {
    const aT = cross(offset, s) / denominator;
    const bT = cross(offset, r) / denominator;
    return aT >= -GEOMETRY_EPSILON
      && aT <= 1 + GEOMETRY_EPSILON
      && bT >= -GEOMETRY_EPSILON
      && bT <= 1 + GEOMETRY_EPSILON;
  }

  // Parallel lines only intersect when they are collinear and their projections overlap.
  if (Math.abs(cross(offset, r)) > GEOMETRY_EPSILON * Math.max(1, a.length)) return false;
  const direction = { x: r.x / a.length, z: r.z / a.length };
  const b0 = dot(subtract(b.start, a.start), direction);
  const b1 = dot(subtract(b.end, a.start), direction);
  return Math.min(a.length, Math.max(b0, b1)) >= Math.max(0, Math.min(b0, b1)) - GEOMETRY_EPSILON;
};

const segmentDistance = (a: LineSegment, b: LineSegment): number => {
  if (segmentsIntersect(a, b)) return 0;
  return Math.min(
    pointSegmentDistance(a.start, b),
    pointSegmentDistance(a.end, b),
    pointSegmentDistance(b.start, a),
    pointSegmentDistance(b.end, a),
  );
};

const hasSelfIntersection = (segments: readonly LineSegment[]): boolean => {
  for (let left = 0; left < segments.length; left += 1) {
    for (let right = left + 2; right < segments.length; right += 1) {
      // Consecutive legs intentionally meet at their shared polyline vertex. Every
      // other contact (including a closed loop touching its start) is self-crossing.
      if (segmentsIntersect(segments[left], segments[right])) return true;
    }
  }
  return false;
};

const projectedOverlap = (a: LineSegment, b: LineSegment): number => {
  if (a.length <= GEOMETRY_EPSILON) return 0;
  const axis = {
    x: (a.end.x - a.start.x) / a.length,
    z: (a.end.z - a.start.z) / a.length,
  };
  const b0 = dot(subtract(b.start, a.start), axis);
  const b1 = dot(subtract(b.end, a.start), axis);
  return Math.max(0, Math.min(a.length, Math.max(b0, b1)) - Math.max(0, Math.min(b0, b1)));
};

const isNearlyParallel = (a: LineSegment, b: LineSegment, angleDegrees: number): boolean => {
  if (a.length <= GEOMETRY_EPSILON || b.length <= GEOMETRY_EPSILON) return false;
  const aDirection = { x: (a.end.x - a.start.x) / a.length, z: (a.end.z - a.start.z) / a.length };
  const bDirection = { x: (b.end.x - b.start.x) / b.length, z: (b.end.z - b.start.z) / b.length };
  return Math.abs(dot(aDirection, bDirection)) >= Math.cos(angleDegrees * Math.PI / 180);
};

const hasParallelOverlap = (
  candidateSegments: readonly LineSegment[],
  snapshot: RoadGraphSnapshot,
  options: Required<Omit<RoadValidationOptions, 'terrainHeight' | 'candidateCenterline' | 'candidateStructureType'>>,
  separated: (road: RoadGraphSnapshot['segments'][number], point: Vec2) => boolean,
): boolean => {
  for (const candidate of candidateSegments) {
    if (candidate.length <= GEOMETRY_EPSILON) continue;
    for (const road of snapshot.segments) {
      const clearance = Math.max(0, (options.candidateWidth + road.width) / 2 - GEOMETRY_EPSILON);
      for (const existing of toSegments(road.geometry.points)) {
        if (!isNearlyParallel(candidate, existing, options.nearParallelAngleDegrees)) continue;
        if (projectedOverlap(candidate, existing) + GEOMETRY_EPSILON < options.minimumParallelOverlap) continue;
        if (separated(road, { x: (candidate.start.x + candidate.end.x) / 2, z: (candidate.start.z + candidate.end.z) / 2 })) continue;
        if (segmentDistance(candidate, existing) < clearance) return true;
      }
    }
  }
  return false;
};

const hasRoadFootprintOverlapWithoutCenterlineContact = (
  candidateSegments: readonly LineSegment[],
  snapshot: RoadGraphSnapshot,
  options: Required<Omit<RoadValidationOptions, 'terrainHeight' | 'candidateCenterline' | 'candidateStructureType'>>,
  separated: (road: RoadGraphSnapshot['segments'][number], point: Vec2) => boolean,
): boolean => {
  for (const candidate of candidateSegments) {
    for (const road of snapshot.segments) {
      const clearance = (options.candidateWidth + road.width) / 2;
      const existingSegments = toSegments(road.geometry.points);
      const junctionEnvelopes: Array<{ point: Vec2; radius: number }> = [];
      for (const candidatePart of candidateSegments) {
        for (const existingPart of existingSegments) {
          const intersection = segmentIntersection(candidatePart.start, candidatePart.end, existingPart.start, existingPart.end);
          if (!intersection) continue;
          if (separated(road, intersection.point)) continue;
          const candidateDirection = subtract(candidatePart.end, candidatePart.start);
          const existingDirection = subtract(existingPart.end, existingPart.start);
          const sine = Math.abs(cross(candidateDirection, existingDirection))
            / Math.max(GEOMETRY_EPSILON, candidatePart.length * existingPart.length);
          junctionEnvelopes.push({
            point: intersection.point,
            radius: Math.min(80, clearance + clearance / Math.max(0.2, sine)),
          });
        }
      }
      for (const existing of existingSegments) {
        if (segmentsIntersect(candidate, existing)) continue;
        if (separated(road, { x: (candidate.start.x + candidate.end.x) / 2, z: (candidate.start.z + candidate.end.z) / 2 })) continue;
        if (segmentDistance(candidate, existing) >= clearance - GEOMETRY_EPSILON) continue;
        const insideJunction = junctionEnvelopes.some((junction) =>
          pointSegmentDistance(junction.point, candidate) <= junction.radius
          && pointSegmentDistance(junction.point, existing) <= junction.radius,
        );
        if (!insideJunction) return true;
      }
    }
  }
  return false;
};

const bendAngleDegrees = (previous: LineSegment, next: LineSegment): number => {
  if (previous.length <= GEOMETRY_EPSILON || next.length <= GEOMETRY_EPSILON) return 180;
  const previousDirection = {
    x: (previous.end.x - previous.start.x) / previous.length,
    z: (previous.end.z - previous.start.z) / previous.length,
  };
  const nextDirection = {
    x: (next.end.x - next.start.x) / next.length,
    z: (next.end.z - next.start.z) / next.length,
  };
  const cosine = Math.max(-1, Math.min(1, dot(previousDirection, nextDirection)));
  return Math.acos(cosine) * 180 / Math.PI;
};

/**
 * Validates a sampled candidate center-line without mutating the graph or points.
 * Ordinary transverse crossings and zero-length endpoint contacts are accepted;
 * RoadGraph can turn those contacts into junctions when the road is committed.
 */
export const validateRoadCandidate = (
  snapshot: RoadGraphSnapshot,
  points: readonly Vec2[],
  overrides: RoadValidationOptions = {},
): RoadValidationResult => {
  const options = { ...DEFAULT_ROAD_VALIDATION_OPTIONS, ...overrides };
  const candidateGeometry = { kind: 'polyline' as const, points: [...points],
    centerline: overrides.candidateCenterline ? [...overrides.candidateCenterline] : undefined };
  const separated = (road: RoadGraphSnapshot['segments'][number], point: Vec2): boolean =>
    !!overrides.candidateCenterline && Math.abs(roadHeightAt(candidateGeometry, point, overrides.terrainHeight)
      - roadHeightAt(road.geometry, point, overrides.terrainHeight)) >= options.minimumVerticalClearance;
  const reasons: RoadValidationReason[] = [];
  const addReason = (reason: RoadValidationReason): void => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };

  if (points.length < 2) addReason(ROAD_VALIDATION_REASON.insufficientPoints);
  if (points.some((point) => !isFinitePoint(point))) addReason(ROAD_VALIDATION_REASON.invalidGeometry);

  const finiteGeometry = points.length >= 2 && points.every(isFinitePoint);
  if (finiteGeometry) {
    if (points.some((point) => Math.abs(point.x) > options.halfWorldSize || Math.abs(point.z) > options.halfWorldSize)) {
      addReason(ROAD_VALIDATION_REASON.outOfBounds);
    }

    if (polylineLength(points) < options.minimumLength) addReason(ROAD_VALIDATION_REASON.tooShort);
    if (
      options.minimumCurveRadius > 0
      && Math.min(minimumPolylineRadius(points), options.analyticalCurveRadius) + GEOMETRY_EPSILON < options.minimumCurveRadius
    ) addReason(ROAD_VALIDATION_REASON.curveRadius);

    const candidateSegments = toSegments(points);
    const collisionSegments = overrides.candidateCenterline
      && (overrides.candidateStructureType && overrides.candidateStructureType !== 'ground'
        || snapshot.segments.some((road) => (road.structureType ?? 'ground') !== 'ground'))
      ? toSegments(overrides.candidateCenterline) : candidateSegments;
    if (overrides.candidateCenterline) for (const road of snapshot.segments) {
      for (const candidate of collisionSegments) for (const existing of toSegments(road.geometry.points)) {
        const crossing = segmentIntersection(candidate.start, candidate.end, existing.start, existing.end);
        if (!crossing) continue;
        const gap = Math.abs(roadHeightAt(candidateGeometry, crossing.point, overrides.terrainHeight)
          - roadHeightAt(road.geometry, crossing.point, overrides.terrainHeight));
        if (gap > 1.5 && gap < options.minimumVerticalClearance) addReason(ROAD_VALIDATION_REASON.verticalClearance);
      }
    }
    if (options.terrainHeight && exceedsTerrainGrade(points, options.terrainHeight, options.maximumGrade)) addReason(ROAD_VALIDATION_REASON.steepGrade);
    if (hasSelfIntersection(candidateSegments)) addReason(ROAD_VALIDATION_REASON.selfIntersection);
    if (hasParallelOverlap(collisionSegments, snapshot, options, separated)) addReason(ROAD_VALIDATION_REASON.parallelOverlap);
    if (hasRoadFootprintOverlapWithoutCenterlineContact(collisionSegments, snapshot, options, separated)) {
      addReason(ROAD_VALIDATION_REASON.roadFootprintOverlap);
    }

    for (let index = 0; index < candidateSegments.length - 1; index += 1) {
      const previous = candidateSegments[index];
      const next = candidateSegments[index + 1];
      const angle = bendAngleDegrees(previous, next);
      if (angle > options.maximumTurnAngleDegrees) addReason(ROAD_VALIDATION_REASON.sharpTurn);
      if (
        angle >= options.minimumKinkAngleDegrees
        && Math.min(previous.length, next.length) < options.minimumBendLegLength
      ) {
        addReason(ROAD_VALIDATION_REASON.shortKink);
      }
    }
  }

  return { valid: reasons.length === 0, reasons };
};
