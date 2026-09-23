import { describe, expect, it } from 'vitest';
import { validateRoadCandidate } from '../src/roads/validation';
import { sampleQuadraticCurve } from '../src/roads/geometry';
import type { RoadGraphSnapshot } from '../src/roads/types';
import type { Vec2 } from '../src/world/types';

const emptyGraph = (): RoadGraphSnapshot => ({ nodes: [], segments: [], lanes: [] });

const graphWithHorizontalRoad = (): RoadGraphSnapshot => ({
  nodes: [
    { id: 'node-1', position: { x: -100, z: 0 } },
    { id: 'node-2', position: { x: 100, z: 0 } },
  ],
  segments: [{
    id: 'segment-1',
    startNodeId: 'node-1',
    endNodeId: 'node-2',
    geometry: { kind: 'straight', points: [{ x: -100, z: 0 }, { x: 100, z: 0 }] },
    roadTypeId: 'small',
    width: 16,
    speedLimit: 40,
    laneIds: [],
    zoningAllowed: true,
  }],
  lanes: [],
});

const validate = (points: Vec2[], graph = emptyGraph()) => validateRoadCandidate(graph, points);

describe('validateRoadCandidate', () => {
  it('accepts an ordinary road inside the map', () => {
    expect(validate([{ x: -50, z: 40 }, { x: 50, z: 40 }])).toEqual({ valid: true, reasons: [] });
  });

  it('reports map bounds and minimum-length failures', () => {
    const result = validate([{ x: 511, z: 0 }, { x: 513, z: 0 }]);
    expect(result.valid).toBe(false);
    expect(result.reasons).toContain('out-of-bounds');
    expect(result.reasons).toContain('too-short');
  });

  it('rejects a self-crossing candidate', () => {
    const result = validate([
      { x: -40, z: -40 },
      { x: 40, z: 40 },
      { x: -40, z: 40 },
      { x: 40, z: -40 },
    ]);
    expect(result.valid).toBe(false);
    expect(result.reasons).toContain('self-intersection');
  });

  it('rejects a duplicate or pavement-overlapping parallel road', () => {
    const graph = graphWithHorizontalRoad();
    expect(validate([{ x: -60, z: 0 }, { x: 60, z: 0 }], graph).reasons).toContain('parallel-overlap');
    expect(validate([{ x: -60, z: 10 }, { x: 60, z: 10 }], graph).reasons).toContain('parallel-overlap');
  });

  it('allows a parallel road once the paved widths no longer overlap', () => {
    const result = validate([{ x: -60, z: 20 }, { x: 60, z: 20 }], graphWithHorizontalRoad());
    expect(result).toEqual({ valid: true, reasons: [] });
  });

  it('allows a simple transverse crossing', () => {
    const result = validate([{ x: 0, z: -80 }, { x: 0, z: 80 }], graphWithHorizontalRoad());
    expect(result).toEqual({ valid: true, reasons: [] });
  });

  it('rejects pavement overlap when centerlines narrowly miss', () => {
    const result = validate([{ x: 105, z: -80 }, { x: 105, z: 80 }], graphWithHorizontalRoad());
    expect(result.valid).toBe(false);
    expect(result.reasons).toContain('road-footprint-overlap');
  });

  it('allows the neighboring sampled chords around a valid curved crossing', () => {
    const curve = sampleQuadraticCurve({ x: 0, z: -80 }, { x: 30, z: 0 }, { x: 0, z: 80 });
    expect(validate(curve, graphWithHorizontalRoad())).toEqual({ valid: true, reasons: [] });
  });

  it('allows endpoint continuation and a T connection into a segment', () => {
    const graph = graphWithHorizontalRoad();
    expect(validate([{ x: 100, z: 0 }, { x: 180, z: 0 }], graph)).toEqual({ valid: true, reasons: [] });
    expect(validate([{ x: 0, z: 80 }, { x: 0, z: 0 }], graph)).toEqual({ valid: true, reasons: [] });
  });

  it('rejects an extreme reversal at a polyline vertex', () => {
    const result = validate([
      { x: 0, z: 0 },
      { x: 40, z: 0 },
      { x: 5, z: 3 },
    ]);
    expect(result.valid).toBe(false);
    expect(result.reasons).toContain('sharp-turn');
  });

  it('rejects a short, visibly bent leg as a kink', () => {
    const result = validate([
      { x: -40, z: 0 },
      { x: 0, z: 0 },
      { x: 2, z: 2 },
      { x: 40, z: 2 },
    ]);
    expect(result.valid).toBe(false);
    expect(result.reasons).toContain('short-kink');
  });

  it('rejects sub-sample tight curvature from the analytical curve radius', () => {
    const sampled = [{ x: 0, z: 0 }, { x: 100, z: 0 }];
    expect(validateRoadCandidate(emptyGraph(), sampled, {
      minimumCurveRadius: 24,
      analyticalCurveRadius: 1,
    }).reasons).toContain('curve-radius');
    expect(validateRoadCandidate(emptyGraph(), sampled, {
      minimumCurveRadius: 24,
      analyticalCurveRadius: 30,
    }).valid).toBe(true);
  });
});
