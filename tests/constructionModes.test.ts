import { describe, expect, it } from 'vitest';
import {
  requiredControlPointsForMode,
  stepBackControlPoints,
  type RoadMode,
} from '../src/roads/constructionController';
import { buildContinuousCurveGeometry, buildCurveGeometry, buildTwoCurveGeometry } from '../src/roads/curveGeometry';
import { dot, normalize, subtract } from '../src/roads/geometry';
import { RoadGraph } from '../src/roads/roadGraph';
import { deserializeWorld, serializeWorld } from '../src/save/serializer';
import { BuildRoadCommand, CommandHistory } from '../src/simulation/commands';
import { generateZoningCells } from '../src/zoning/generator';

describe('road construction modes', () => {
  it('joins two existing road endpoints with one continuous tangent on each side', () => {
    const graph = new RoadGraph();
    const first = graph.buildRoad({
      geometry: { kind: 'straight', points: [{ x: -140, z: 0 }, { x: 0, z: 0 }] }, roadTypeId: 'small',
    });
    const second = graph.buildRoad({
      geometry: { kind: 'straight', points: [{ x: 100, z: 100 }, { x: 100, z: 240 }] }, roadTypeId: 'small',
    });
    const curve = buildCurveGeometry({
      start: first.endPosition, directionPoint: { x: 100, z: 0 }, end: second.startPosition,
      startTangent: { x: 1, z: 0 }, endTangent: { x: 0, z: 1 },
    });
    const joined = graph.buildRoad({
      geometry: { kind: 'curve', points: curve.points }, roadTypeId: 'small',
      endpointIntents: {
        start: { kind: 'node', nodeId: first.endNodeId, position: first.endPosition },
        end: { kind: 'node', nodeId: second.startNodeId, position: second.startPosition },
      },
    });
    const built = graph.segments.get(joined.createdSegmentIds[0])!;

    expect(graph.connectedSegments(first.endNodeId)).toHaveLength(2);
    expect(graph.connectedSegments(second.startNodeId)).toHaveLength(2);
    expect(dot(normalize(subtract(built.geometry.points[1], built.geometry.points[0])), { x: 1, z: 0 })).toBeGreaterThan(0.995);
    expect(dot(normalize(subtract(built.geometry.points.at(-1)!, built.geometry.points.at(-2)!)), { x: 0, z: 1 })).toBeGreaterThan(0.995);
  });

  it('creates and persists a two-curve parallel offset connection', () => {
    const geometry = buildTwoCurveGeometry({
      start: { x: -120, z: -40 },
      firstDirectionPoint: { x: -75, z: -40 },
      secondDirectionPoint: { x: 75, z: 40 },
      end: { x: 120, z: 40 },
      startTangent: { x: 1, z: 0 },
      endTangent: { x: 1, z: 0 },
    });
    const graph = new RoadGraph();
    const result = graph.buildRoad({ geometry: { kind: 'curve', points: geometry.points }, roadTypeId: 'small' });
    const segment = graph.segments.get(result.createdSegmentIds[0])!;
    const startTangent = normalize(subtract(segment.geometry.points[1], segment.geometry.points[0]));
    const endTangent = normalize(subtract(segment.geometry.points.at(-1)!, segment.geometry.points.at(-2)!));

    expect(geometry.method).toBe('two-curve');
    expect(dot(startTangent, { x: 1, z: 0 })).toBeGreaterThan(0.995);
    expect(dot(endTangent, { x: 1, z: 0 })).toBeGreaterThan(0.995);
    expect(() => graph.assertIntegrity()).not.toThrow();
  });

  it('joins parallel offset road endpoints with an S-shaped two-curve', () => {
    const graph = new RoadGraph();
    const first = graph.buildRoad({
      geometry: { kind: 'straight', points: [{ x: -140, z: 0 }, { x: 0, z: 0 }] }, roadTypeId: 'small',
    });
    const second = graph.buildRoad({
      geometry: { kind: 'straight', points: [{ x: 120, z: 50 }, { x: 260, z: 50 }] }, roadTypeId: 'small',
    });
    const curve = buildTwoCurveGeometry({
      start: first.endPosition, firstDirectionPoint: { x: 40, z: 0 },
      secondDirectionPoint: { x: 80, z: 50 }, end: second.startPosition,
      startTangent: { x: 1, z: 0 }, endTangent: { x: 1, z: 0 },
    });
    const joined = graph.buildRoad({
      geometry: { kind: 'curve', points: curve.points }, roadTypeId: 'small',
      endpointIntents: {
        start: { kind: 'node', nodeId: first.endNodeId, position: first.endPosition },
        end: { kind: 'node', nodeId: second.startNodeId, position: second.startPosition },
      },
    });

    expect(joined.intersectionNodeIds).toHaveLength(0);
    expect(graph.connectedSegments(first.endNodeId)).toHaveLength(2);
    expect(graph.connectedSegments(second.startNodeId)).toHaveLength(2);
    expect(curve.minimumRadius).toBeGreaterThan(24);
  });

  it('creates a half-circle continuous curve independent of direction-click distance', () => {
    const near = buildContinuousCurveGeometry({
      start: { x: 0, z: -60 }, initialDirection: { x: 8, z: 0 }, end: { x: 0, z: 60 },
    });
    const far = buildContinuousCurveGeometry({
      start: { x: 0, z: -60 }, initialDirection: { x: 80, z: 0 }, end: { x: 0, z: 60 },
    });
    const graph = new RoadGraph();
    graph.buildRoad({ geometry: { kind: 'curve', points: near.points }, roadTypeId: 'small' });

    expect(near.points).toEqual(far.points);
    expect(near.minimumRadius).toBeCloseTo(60, 5);
    expect(near.exceedsHalfTurn).toBe(false);
    expect(() => graph.assertIntegrity()).not.toThrow();
  });

  it('undoes, redoes, serializes, and preserves zoning for two-curve geometry', () => {
    const geometry = buildTwoCurveGeometry({
      start: { x: -140, z: -50 },
      firstDirectionPoint: { x: -90, z: -50 },
      secondDirectionPoint: { x: 90, z: 50 },
      end: { x: 140, z: 50 },
      startTangent: { x: 1, z: 0 },
      endTangent: { x: 1, z: 0 },
    });
    const graph = new RoadGraph();
    const history = new CommandHistory();
    history.execute(new BuildRoadCommand({ geometry: { kind: 'curve', points: geometry.points }, roadTypeId: 'small' }), graph);
    const built = graph.snapshot();
    const zones = generateZoningCells(built);

    expect(history.undo(graph)).toBe(true);
    expect(history.redo(graph)).toBe(true);
    expect(graph.snapshot()).toEqual(built);

    const loaded = deserializeWorld(JSON.parse(JSON.stringify(serializeWorld({
      terrain: { width: 1024, depth: 1024, baseHeight: 0 },
      roadGraph: built,
      gameClock: { gameSeconds: 0, speed: 1 },
      zoningAssignments: [],
    }))));
    expect(loaded.roadGraph).toEqual(built);
    expect(generateZoningCells(loaded.roadGraph)).toEqual(zones);
  });

  it('backs out one control point at every multi-click construction step', () => {
    const modes: Array<[RoadMode, number]> = [
      ['straight', 0], ['one-curve', 1], ['two-curve', 2], ['continuous', 1],
    ];
    for (const [mode, count] of modes) expect(requiredControlPointsForMode(mode)).toBe(count);

    const controls = [{ x: 20, z: 0 }, { x: 60, z: 30 }];
    expect(stepBackControlPoints(controls)).toEqual([{ x: 20, z: 0 }]);
    expect(stepBackControlPoints(stepBackControlPoints(controls))).toEqual([]);
    expect(stepBackControlPoints([])).toEqual([]);
  });
});
