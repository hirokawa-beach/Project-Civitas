import type { Vec2 } from '../world/types';
import { cross, distance, normalize, subtract } from './geometry';

const CURVE_EPSILON = 1e-6;

export interface CurveGeometryInput {
  start: Vec2;
  directionPoint: Vec2;
  end: Vec2;
  startTangent?: Vec2;
  endTangent?: Vec2;
  sampleSpacing?: number;
}

export interface CurveGeometryResult {
  points: Vec2[];
  startTangent: Vec2;
  endTangent: Vec2;
  minimumRadius: number;
  startControl: Vec2;
  endControl: Vec2;
  method?: 'one-curve' | 'two-curve' | 'continuous-arc';
  exceedsHalfTurn?: boolean;
}

export interface TwoCurveGeometryInput {
  start: Vec2;
  firstDirectionPoint: Vec2;
  secondDirectionPoint: Vec2;
  end: Vec2;
  startTangent?: Vec2;
  endTangent?: Vec2;
  sampleSpacing?: number;
}

export interface ContinuousCurveGeometryInput {
  start: Vec2;
  initialDirection: Vec2;
  end: Vec2;
  sampleSpacing?: number;
}

const addScaled = (point: Vec2, direction: Vec2, amount: number): Vec2 => ({
  x: point.x + direction.x * amount,
  z: point.z + direction.z * amount,
});

const cubicPoint = (start: Vec2, first: Vec2, second: Vec2, end: Vec2, t: number): Vec2 => {
  const inverse = 1 - t;
  const a = inverse ** 3;
  const b = 3 * inverse * inverse * t;
  const c = 3 * inverse * t * t;
  const d = t ** 3;
  return {
    x: start.x * a + first.x * b + second.x * c + end.x * d,
    z: start.z * a + first.z * b + second.z * c + end.z * d,
  };
};

const cubicDerivative = (start: Vec2, first: Vec2, second: Vec2, end: Vec2, t: number): Vec2 => {
  const inverse = 1 - t;
  return {
    x: 3 * inverse * inverse * (first.x - start.x)
      + 6 * inverse * t * (second.x - first.x)
      + 3 * t * t * (end.x - second.x),
    z: 3 * inverse * inverse * (first.z - start.z)
      + 6 * inverse * t * (second.z - first.z)
      + 3 * t * t * (end.z - second.z),
  };
};

const cubicSecondDerivative = (start: Vec2, first: Vec2, second: Vec2, end: Vec2, t: number): Vec2 => ({
  x: 6 * (1 - t) * (second.x - 2 * first.x + start.x)
    + 6 * t * (end.x - 2 * second.x + first.x),
  z: 6 * (1 - t) * (second.z - 2 * first.z + start.z)
    + 6 * t * (end.z - 2 * second.z + first.z),
});

const minimumBezierRadius = (start: Vec2, first: Vec2, second: Vec2, end: Vec2): number => {
  let minimum = Number.POSITIVE_INFINITY;
  for (let index = 0; index <= 96; index += 1) {
    const t = index / 96;
    const firstDerivative = cubicDerivative(start, first, second, end, t);
    const secondDerivative = cubicSecondDerivative(start, first, second, end, t);
    const speed = Math.hypot(firstDerivative.x, firstDerivative.z);
    if (speed <= CURVE_EPSILON) return 0;
    const numerator = Math.abs(cross(firstDerivative, secondDerivative));
    if (numerator <= CURVE_EPSILON) continue;
    minimum = Math.min(minimum, speed ** 3 / numerator);
  }
  return minimum;
};

/**
 * Builds a cubic centerline. The direction point controls the first tangent
 * length and general bend, but is intentionally not forced onto the curve.
 */
export const buildCurveGeometry = (input: CurveGeometryInput): CurveGeometryResult => {
  const chord = Math.max(CURVE_EPSILON, distance(input.start, input.end));
  const directionOffset = subtract(input.directionPoint, input.start);
  const directionDistance = Math.max(CURVE_EPSILON, Math.hypot(directionOffset.x, directionOffset.z));
  const fallbackDirection = normalize(subtract(input.end, input.start));
  const startTangent = normalize(input.startTangent ?? directionOffset);
  const resolvedStartTangent = Math.hypot(startTangent.x, startTangent.z) > CURVE_EPSILON
    ? startTangent
    : fallbackDirection;

  const freeEndDirection = normalize(subtract(input.end, input.directionPoint));
  const requestedEndTangent = normalize(input.endTangent ?? freeEndDirection);
  const endTangent = Math.hypot(requestedEndTangent.x, requestedEndTangent.z) > CURVE_EPSILON
    ? requestedEndTangent
    : fallbackDirection;

  const maximumHandle = Math.max(6, chord * 1.25);
  const startHandleLength = Math.min(maximumHandle, Math.max(2, directionDistance));
  const directionToEnd = distance(input.directionPoint, input.end);
  const endToDirection = normalize(subtract(input.directionPoint, input.end));
  const directionPointIsEndTangentApex = input.endTangent
    && Math.abs(cross(endToDirection, endTangent)) < 0.02
    && endToDirection.x * endTangent.x + endToDirection.z * endTangent.z < 0;
  const naturalEndHandle = input.endTangent
    ? directionPointIsEndTangentApex
      ? Math.max(4, Math.min(directionToEnd, maximumHandle))
      : Math.max(4, Math.min(startHandleLength * 0.8, chord * 0.75))
    : Math.max(3, Math.min(directionToEnd * 0.5, chord * 0.75));
  const endHandleLength = Math.min(maximumHandle, naturalEndHandle);
  const startControl = addScaled(input.start, resolvedStartTangent, startHandleLength);
  const endControl = addScaled(input.end, endTangent, -endHandleLength);

  const controlLength = distance(input.start, startControl)
    + distance(startControl, endControl)
    + distance(endControl, input.end);
  const sampleSpacing = Math.max(1.5, input.sampleSpacing ?? 4);
  const steps = Math.max(12, Math.min(192, Math.ceil(controlLength / sampleSpacing)));
  const points = Array.from({ length: steps + 1 }, (_, index) =>
    cubicPoint(input.start, startControl, endControl, input.end, index / steps));

  return {
    points,
    startTangent: resolvedStartTangent,
    endTangent,
    minimumRadius: minimumBezierRadius(input.start, startControl, endControl, input.end),
    startControl,
    endControl,
    method: 'one-curve',
  };
};

const sampleCubic = (
  start: Vec2,
  first: Vec2,
  second: Vec2,
  end: Vec2,
  sampleSpacing: number,
  includeStart = true,
): Vec2[] => {
  const controlLength = distance(start, first) + distance(first, second) + distance(second, end);
  const steps = Math.max(8, Math.min(128, Math.ceil(controlLength / sampleSpacing)));
  return Array.from({ length: steps + (includeStart ? 1 : 0) }, (_, index) => {
    const step = index + (includeStart ? 0 : 1);
    return cubicPoint(start, first, second, end, step / steps);
  });
};

/**
 * Road-agnostic two-curve construction geometry. The two user points set the
 * available tangent lengths and the transition region; neither is a mandatory
 * pass-through point. Two cubic spans share a position and tangent at the join.
 */
export const buildTwoCurveGeometry = (input: TwoCurveGeometryInput): CurveGeometryResult => {
  const chordDirection = normalize(subtract(input.end, input.start));
  const startDirection = normalize(input.startTangent ?? subtract(input.firstDirectionPoint, input.start));
  const endDirection = normalize(input.endTangent ?? subtract(input.end, input.secondDirectionPoint));
  const resolvedStart = Math.hypot(startDirection.x, startDirection.z) > CURVE_EPSILON ? startDirection : chordDirection;
  const resolvedEnd = Math.hypot(endDirection.x, endDirection.z) > CURVE_EPSILON ? endDirection : chordDirection;
  const join = {
    x: (input.firstDirectionPoint.x + input.secondDirectionPoint.x) / 2,
    z: (input.firstDirectionPoint.z + input.secondDirectionPoint.z) / 2,
  };
  const bridgeDirection = normalize(subtract(input.secondDirectionPoint, input.firstDirectionPoint));
  const joinDirection = Math.hypot(bridgeDirection.x, bridgeDirection.z) > CURVE_EPSILON ? bridgeDirection : chordDirection;
  const firstSpan = Math.max(2, distance(input.start, join));
  const secondSpan = Math.max(2, distance(join, input.end));
  const startHandle = Math.min(distance(input.start, input.firstDirectionPoint), firstSpan * 0.72);
  const endHandle = Math.min(distance(input.secondDirectionPoint, input.end), secondSpan * 0.72);
  const joinHandle = Math.max(2, Math.min(firstSpan, secondSpan) * 0.32);
  const startControl = addScaled(input.start, resolvedStart, Math.max(2, startHandle));
  const firstJoinControl = addScaled(join, joinDirection, -joinHandle);
  const secondJoinControl = addScaled(join, joinDirection, joinHandle);
  const endControl = addScaled(input.end, resolvedEnd, -Math.max(2, endHandle));
  const spacing = Math.max(1.5, input.sampleSpacing ?? 4);
  const points = [
    ...sampleCubic(input.start, startControl, firstJoinControl, join, spacing),
    ...sampleCubic(join, secondJoinControl, endControl, input.end, spacing, false),
  ];

  return {
    points,
    startTangent: resolvedStart,
    endTangent: resolvedEnd,
    minimumRadius: Math.min(
      minimumBezierRadius(input.start, startControl, firstJoinControl, join),
      minimumBezierRadius(join, secondJoinControl, endControl, input.end),
    ),
    startControl,
    endControl,
    method: 'two-curve',
  };
};

/**
 * Builds the circular arc defined by a start position, initial direction and
 * endpoint. Direction magnitude is deliberately ignored so first-click distance
 * cannot change the resulting curve.
 */
export const buildContinuousCurveGeometry = (input: ContinuousCurveGeometryInput): CurveGeometryResult => {
  const tangent = normalize(input.initialDirection);
  const chord = subtract(input.end, input.start);
  const chordLength = Math.hypot(chord.x, chord.z);
  const resolvedTangent = Math.hypot(tangent.x, tangent.z) > CURVE_EPSILON
    ? tangent
    : normalize(chord);
  const normal = { x: -resolvedTangent.z, z: resolvedTangent.x };
  const normalOffset = chord.x * normal.x + chord.z * normal.z;
  if (chordLength <= CURVE_EPSILON || Math.abs(normalOffset) <= 0.05) {
    const steps = Math.max(2, Math.ceil(chordLength / Math.max(1.5, input.sampleSpacing ?? 4)));
    const points = Array.from({ length: steps + 1 }, (_, index) => ({
      x: input.start.x + chord.x * index / steps,
      z: input.start.z + chord.z * index / steps,
    }));
    return {
      points,
      startTangent: resolvedTangent,
      endTangent: normalize(chord),
      minimumRadius: Number.POSITIVE_INFINITY,
      startControl: addScaled(input.start, resolvedTangent, Math.min(24, chordLength / 3)),
      endControl: addScaled(input.end, normalize(chord), -Math.min(24, chordLength / 3)),
      method: 'continuous-arc',
      exceedsHalfTurn: dotProduct(chord, resolvedTangent) < 0,
    };
  }

  const signedRadius = chordLength ** 2 / (2 * normalOffset);
  const radius = Math.abs(signedRadius);
  const center = addScaled(input.start, normal, signedRadius);
  const startAngle = Math.atan2(input.start.z - center.z, input.start.x - center.x);
  const endAngle = Math.atan2(input.end.z - center.z, input.end.x - center.x);
  let sweep = endAngle - startAngle;
  if (signedRadius > 0) while (sweep < 0) sweep += Math.PI * 2;
  else while (sweep > 0) sweep -= Math.PI * 2;
  const exceedsHalfTurn = Math.abs(sweep) > Math.PI + 0.001;
  const arcLength = radius * Math.abs(sweep);
  const steps = Math.max(12, Math.min(192, Math.ceil(arcLength / Math.max(1.5, input.sampleSpacing ?? 4))));
  const points = Array.from({ length: steps + 1 }, (_, index) => {
    const angle = startAngle + sweep * index / steps;
    return { x: center.x + Math.cos(angle) * radius, z: center.z + Math.sin(angle) * radius };
  });
  points[0] = { ...input.start };
  points[points.length - 1] = { ...input.end };
  const endTangent = normalize(subtract(points.at(-1)!, points.at(-2)!));
  const handleLength = Math.min(radius * 0.55, Math.max(4, arcLength / 3));
  return {
    points,
    startTangent: resolvedTangent,
    endTangent,
    minimumRadius: radius,
    startControl: addScaled(input.start, resolvedTangent, handleLength),
    endControl: addScaled(input.end, endTangent, -handleLength),
    method: 'continuous-arc',
    exceedsHalfTurn,
  };
};

export const isOneCurveSuitable = (
  start: Vec2,
  end: Vec2,
  startTangent?: Vec2,
  endTangent?: Vec2,
  lateralTolerance = 12,
): boolean => {
  if (!startTangent || !endTangent) return true;
  const chord = subtract(end, start);
  const length = Math.hypot(chord.x, chord.z);
  if (length <= CURVE_EPSILON) return false;
  const first = normalize(startTangent);
  const last = normalize(endTangent);
  const lateralOffset = Math.abs(cross(chord, first));
  if (dotProduct(first, last) > 0.94 && lateralOffset > lateralTolerance) return false;
  return dotProduct(first, last) > -0.82;
};

const dotProduct = (first: Vec2, second: Vec2): number => first.x * second.x + first.z * second.z;

/** Approximate curvature radius for an arbitrary persisted polyline. */
export const minimumPolylineRadius = (points: readonly Vec2[]): number => {
  let minimum = Number.POSITIVE_INFINITY;
  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const next = points[index + 1];
    const a = distance(previous, current);
    const b = distance(current, next);
    const c = distance(previous, next);
    if (a <= CURVE_EPSILON || b <= CURVE_EPSILON || c <= CURVE_EPSILON) return 0;
    const doubleArea = Math.abs(cross(subtract(current, previous), subtract(next, previous)));
    if (doubleArea <= CURVE_EPSILON) continue;
    minimum = Math.min(minimum, (a * b * c) / (2 * doubleArea));
  }
  return minimum;
};
