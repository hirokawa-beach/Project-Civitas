import { describe, expect, it } from 'vitest';
import {
  buildContinuousCurveGeometry,
  buildCurveGeometry,
  buildTwoCurveGeometry,
  isOneCurveSuitable,
  minimumPolylineRadius,
} from '../src/roads/curveGeometry';
import { dot, normalize, subtract } from '../src/roads/geometry';

describe('curve geometry', () => {
  it('uses the direction point as a tangent handle rather than a required pass-through point', () => {
    const directionPoint = { x: 40, z: 0 };
    const curve = buildCurveGeometry({
      start: { x: 0, z: 0 },
      directionPoint,
      end: { x: 90, z: 45 },
    });

    expect(curve.points[0]).toEqual({ x: 0, z: 0 });
    expect(curve.points.at(-1)).toEqual({ x: 90, z: 45 });
    expect(Math.min(...curve.points.slice(1, -1).map((point) => Math.hypot(point.x - 40, point.z)))).toBeGreaterThan(0.5);
  });

  it('honors explicit start and end tangents', () => {
    const startTangent = normalize({ x: 1, z: 0 });
    const endTangent = normalize({ x: 0, z: 1 });
    const curve = buildCurveGeometry({
      start: { x: 0, z: 0 },
      directionPoint: { x: 0, z: 45 },
      end: { x: 80, z: 60 },
      startTangent,
      endTangent,
    });
    const sampledStart = normalize(subtract(curve.points[1], curve.points[0]));
    const sampledEnd = normalize(subtract(curve.points.at(-1)!, curve.points.at(-2)!));

    expect(dot(sampledStart, startTangent)).toBeGreaterThan(0.995);
    expect(dot(sampledEnd, endTangent)).toBeGreaterThan(0.995);
  });

  it('uses the tangent intersection as the shared construction apex', () => {
    const curve = buildCurveGeometry({
      start: { x: 0, z: 0 },
      directionPoint: { x: 50, z: 0 },
      end: { x: 50, z: 50 },
      startTangent: { x: 1, z: 0 },
      endTangent: { x: 0, z: 1 },
    });

    expect(curve.startControl).toEqual({ x: 50, z: 0 });
    expect(curve.endControl).toEqual({ x: 50, z: 0 });
  });

  it('reports tight curves below the small-road minimum radius', () => {
    const broad = buildCurveGeometry({
      start: { x: 0, z: 0 },
      directionPoint: { x: 50, z: 0 },
      end: { x: 110, z: 55 },
    });
    const tight = buildCurveGeometry({
      start: { x: 0, z: 0 },
      directionPoint: { x: 7, z: 0 },
      end: { x: 10, z: 12 },
    });

    expect(broad.minimumRadius).toBeGreaterThan(24);
    expect(tight.minimumRadius).toBeLessThan(24);
    expect(minimumPolylineRadius(tight.points)).toBeLessThan(24);
  });

  it('creates a smooth two-curve connection between parallel offset roads', () => {
    const curve = buildTwoCurveGeometry({
      start: { x: 0, z: 0 },
      firstDirectionPoint: { x: 40, z: 0 },
      secondDirectionPoint: { x: 80, z: 50 },
      end: { x: 120, z: 50 },
      startTangent: { x: 1, z: 0 },
      endTangent: { x: 1, z: 0 },
    });
    const sampledStart = normalize(subtract(curve.points[1], curve.points[0]));
    const sampledEnd = normalize(subtract(curve.points.at(-1)!, curve.points.at(-2)!));

    expect(curve.method).toBe('two-curve');
    expect(curve.points[0]).toEqual({ x: 0, z: 0 });
    expect(curve.points.at(-1)).toEqual({ x: 120, z: 50 });
    expect(dot(sampledStart, { x: 1, z: 0 })).toBeGreaterThan(0.995);
    expect(dot(sampledEnd, { x: 1, z: 0 })).toBeGreaterThan(0.995);
    expect(curve.minimumRadius).toBeGreaterThan(24);
    expect(Math.min(...curve.points.map((point) => point.z))).toBeGreaterThanOrEqual(-0.01);
    expect(Math.max(...curve.points.map((point) => point.z))).toBeLessThanOrEqual(50.01);
  });

  it('treats first-click distance as irrelevant in continuous curve mode', () => {
    const near = buildContinuousCurveGeometry({
      start: { x: 0, z: 0 }, initialDirection: { x: 10, z: 0 }, end: { x: 0, z: 60 },
    });
    const far = buildContinuousCurveGeometry({
      start: { x: 0, z: 0 }, initialDirection: { x: 100, z: 0 }, end: { x: 0, z: 60 },
    });

    expect(near.points).toEqual(far.points);
    expect(near.minimumRadius).toBeCloseTo(30, 5);
    expect(near.exceedsHalfTurn).toBe(false);
  });

  it('flags continuous arcs that would exceed a half turn', () => {
    const curve = buildContinuousCurveGeometry({
      start: { x: 0, z: 0 }, initialDirection: { x: 1, z: 0 }, end: { x: -30, z: 20 },
    });
    expect(curve.exceedsHalfTurn).toBe(true);
  });

  it('rejects a collinear endpoint behind the initial direction', () => {
    const curve = buildContinuousCurveGeometry({
      start: { x: 0, z: 0 }, initialDirection: { x: 1, z: 0 }, end: { x: -60, z: 0 },
    });
    expect(curve.exceedsHalfTurn).toBe(true);
  });

  it('recommends two-curve for parallel lateral offsets', () => {
    expect(isOneCurveSuitable(
      { x: 0, z: 0 }, { x: 120, z: 50 }, { x: 1, z: 0 }, { x: 1, z: 0 },
    )).toBe(false);
    expect(isOneCurveSuitable(
      { x: 0, z: 0 }, { x: 120, z: 0 }, { x: 1, z: 0 }, { x: 1, z: 0 },
    )).toBe(true);
  });
});
