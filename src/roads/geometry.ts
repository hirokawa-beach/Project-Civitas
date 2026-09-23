import type { Vec2 } from '../world/types';

export const EPSILON = 0.05;

export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, z: a.z + b.z });
export const subtract = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, z: a.z - b.z });
export const scale = (point: Vec2, amount: number): Vec2 => ({ x: point.x * amount, z: point.z * amount });
export const distanceSquared = (a: Vec2, b: Vec2): number => (a.x - b.x) ** 2 + (a.z - b.z) ** 2;
export const distance = (a: Vec2, b: Vec2): number => Math.sqrt(distanceSquared(a, b));
export const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
export const cross = (a: Vec2, b: Vec2): number => a.x * b.z - a.z * b.x;
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.z * b.z;
export const normalize = (value: Vec2): Vec2 => {
  const length = Math.hypot(value.x, value.z);
  return length <= EPSILON ? { x: 0, z: 0 } : { x: value.x / length, z: value.z / length };
};

export const polylineLength = (points: readonly Vec2[]): number => {
  let result = 0;
  for (let index = 1; index < points.length; index += 1) result += distance(points[index - 1], points[index]);
  return result;
};

export interface PolylineProjection {
  point: Vec2;
  distance: number;
  segmentIndex: number;
  t: number;
  along: number;
}

export const closestPointOnPolyline = (point: Vec2, points: readonly Vec2[]): PolylineProjection => {
  let best: PolylineProjection = { point: points[0], distance: Number.POSITIVE_INFINITY, segmentIndex: 0, t: 0, along: 0 };
  let traversed = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    const delta = subtract(end, start);
    const lengthSquared = dot(delta, delta);
    const t = lengthSquared <= EPSILON ? 0 : Math.max(0, Math.min(1, dot(subtract(point, start), delta) / lengthSquared));
    const projected = lerp(start, end, t);
    const projectedDistance = distance(point, projected);
    if (projectedDistance < best.distance) {
      best = { point: projected, distance: projectedDistance, segmentIndex: index, t, along: traversed + distance(start, projected) };
    }
    traversed += distance(start, end);
  }
  return best;
};

export const pointAtDistance = (points: readonly Vec2[], along: number): { point: Vec2; tangent: Vec2 } => {
  let remaining = Math.max(0, along);
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    const length = distance(start, end);
    if (remaining <= length || index === points.length - 2) {
      return { point: lerp(start, end, length <= EPSILON ? 0 : remaining / length), tangent: normalize(subtract(end, start)) };
    }
    remaining -= length;
  }
  return { point: points.at(-1) ?? { x: 0, z: 0 }, tangent: { x: 1, z: 0 } };
};

export const slicePolyline = (points: readonly Vec2[], from: number, to: number): Vec2[] => {
  const start = pointAtDistance(points, from).point;
  const end = pointAtDistance(points, to).point;
  const result: Vec2[] = [start];
  let traversed = 0;
  for (let index = 1; index < points.length - 1; index += 1) {
    traversed += distance(points[index - 1], points[index]);
    if (traversed > from + EPSILON && traversed < to - EPSILON) result.push({ ...points[index] });
  }
  result.push(end);
  return result;
};

export const splitPolyline = (points: readonly Vec2[], projection: PolylineProjection): [Vec2[], Vec2[]] => {
  const junction = { ...projection.point };
  return [
    [...points.slice(0, projection.segmentIndex + 1).map((point) => ({ ...point })), junction],
    [junction, ...points.slice(projection.segmentIndex + 1).map((point) => ({ ...point }))],
  ];
};

export interface SegmentIntersection {
  point: Vec2;
  aT: number;
  bT: number;
}

const INTERSECTION_PARAMETER_EPSILON = 1e-7;
const PARALLEL_SINE_EPSILON = 1e-7;

export const segmentIntersection = (a0: Vec2, a1: Vec2, b0: Vec2, b1: Vec2): SegmentIntersection | null => {
  const r = subtract(a1, a0);
  const s = subtract(b1, b0);
  const denominator = cross(r, s);
  const lengthProduct = Math.hypot(r.x, r.z) * Math.hypot(s.x, s.z);
  if (lengthProduct <= EPSILON || Math.abs(denominator) / lengthProduct <= PARALLEL_SINE_EPSILON) return null;
  const offset = subtract(b0, a0);
  const aT = cross(offset, s) / denominator;
  const bT = cross(offset, r) / denominator;
  if (
    aT < -INTERSECTION_PARAMETER_EPSILON
    || aT > 1 + INTERSECTION_PARAMETER_EPSILON
    || bT < -INTERSECTION_PARAMETER_EPSILON
    || bT > 1 + INTERSECTION_PARAMETER_EPSILON
  ) return null;
  return { point: lerp(a0, a1, Math.max(0, Math.min(1, aT))), aT, bT };
};

export const sampleQuadraticCurve = (start: Vec2, control: Vec2, end: Vec2, steps?: number): Vec2[] => {
  const estimated = distance(start, control) + distance(control, end);
  const count = steps ?? Math.max(8, Math.ceil(estimated / 6));
  return Array.from({ length: count + 1 }, (_, index) => {
    const t = index / count;
    const inverse = 1 - t;
    return {
      x: inverse * inverse * start.x + 2 * inverse * t * control.x + t * t * end.x,
      z: inverse * inverse * start.z + 2 * inverse * t * control.z + t * t * end.z,
    };
  });
};
