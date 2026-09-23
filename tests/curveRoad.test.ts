import { describe, expect, it } from 'vitest';
import { buildCurveGeometry } from '../src/roads/curveGeometry';
import { normalize, subtract } from '../src/roads/geometry';
import { RoadGraph } from '../src/roads/roadGraph';
import type { BuildRoadInput, RoadEndpointIntent } from '../src/roads/types';
import { deserializeWorld, serializeWorld } from '../src/save/serializer';
import { BuildRoadCommand, CommandHistory } from '../src/simulation/commands';
import type { Vec2 } from '../src/world/types';
import { generateZoningCells } from '../src/zoning/generator';

const straight = (start: Vec2, end: Vec2): BuildRoadInput => ({
  geometry: { kind: 'straight', points: [start, end] },
  roadTypeId: 'small',
});

const curve = (
  start: Vec2,
  directionPoint: Vec2,
  end: Vec2,
  options: {
    startTangent?: Vec2;
    endTangent?: Vec2;
    startIntent?: RoadEndpointIntent;
    endIntent?: RoadEndpointIntent;
  } = {},
): BuildRoadInput => ({
  geometry: {
    kind: 'curve',
    points: buildCurveGeometry({
      start,
      directionPoint,
      end,
      startTangent: options.startTangent,
      endTangent: options.endTangent,
    }).points,
  },
  roadTypeId: 'small',
  endpointIntents: options.startIntent && options.endIntent
    ? { start: options.startIntent, end: options.endIntent }
    : undefined,
});

describe('curve roads', () => {
  it('builds a curve from terrain and persists the sampled centerline', () => {
    const graph = new RoadGraph();
    graph.buildRoad(curve({ x: -80, z: -40 }, { x: -20, z: -40 }, { x: 80, z: 50 }));
    const segment = [...graph.segments.values()][0];

    expect(segment.geometry.kind).toBe('curve');
    expect(segment.geometry.points.length).toBeGreaterThan(12);
    expect(() => graph.assertIntegrity()).not.toThrow();
  });

  it('continues from a RoadNode with tangent continuity', () => {
    const graph = new RoadGraph();
    graph.buildRoad(straight({ x: -120, z: 0 }, { x: 0, z: 0 }));
    const input = curve(
      { x: 0, z: 0 },
      { x: 45, z: 0 },
      { x: 110, z: 70 },
      {
        startTangent: { x: 1, z: 0 },
        startIntent: { kind: 'node', nodeId: 'node-2', position: { x: 0, z: 0 } },
        endIntent: { kind: 'free', position: { x: 110, z: 70 } },
      },
    );
    const result = graph.buildRoad(input);
    const built = graph.segments.get(result.createdSegmentIds[0])!;
    const sampledTangent = normalize(subtract(built.geometry.points[1], built.geometry.points[0]));

    expect(result.startNodeId).toBe('node-2');
    expect(sampledTangent.x).toBeGreaterThan(0.995);
    expect(Math.abs(sampledTangent.z)).toBeLessThan(0.08);
  });

  it('starts from and splits the middle of a RoadSegment', () => {
    const graph = new RoadGraph();
    graph.buildRoad(straight({ x: -160, z: 0 }, { x: 160, z: 0 }));
    graph.buildRoad(curve(
      { x: 0, z: 0 },
      { x: 38, z: 0 },
      { x: 105, z: 85 },
      {
        startTangent: { x: 1, z: 0 },
        startIntent: { kind: 'segment', segmentId: 'segment-1', position: { x: 0, z: 0 } },
        endIntent: { kind: 'free', position: { x: 105, z: 85 } },
      },
    ));

    const junction = [...graph.nodes.values()].find((node) => Math.hypot(node.position.x, node.position.z) < 0.1)!;
    expect(graph.connectedSegments(junction.id)).toHaveLength(3);
  });

  it('snaps a curve end into a segment and preserves the target lineage', () => {
    const graph = new RoadGraph();
    graph.buildRoad(straight({ x: -140, z: 100 }, { x: 140, z: 100 }));
    const lineage = [...graph.segments.values()][0].zoningLineageId;
    graph.buildRoad(curve(
      { x: -100, z: -20 },
      { x: -35, z: -20 },
      { x: 0, z: 100 },
      {
        endTangent: { x: 1, z: 0 },
        startIntent: { kind: 'free', position: { x: -100, z: -20 } },
        endIntent: { kind: 'segment', segmentId: 'segment-1', position: { x: 0, z: 100 } },
      },
    ));

    const targetFragments = [...graph.segments.values()].filter((segment) => segment.zoningLineageId === lineage);
    expect(targetFragments).toHaveLength(2);
    expect(new Set(targetFragments.map((segment) => segment.zoningLineageId))).toEqual(new Set([lineage]));
    expect(targetFragments.map((segment) => segment.zoningStartOffset).sort((a, b) => a! - b!)).toEqual([0, 140]);
  });

  it('creates graph intersections when a curve crosses a straight road', () => {
    const graph = new RoadGraph();
    graph.buildRoad(straight({ x: -140, z: 0 }, { x: 140, z: 0 }));
    graph.buildRoad(curve({ x: -100, z: -100 }, { x: -20, z: -100 }, { x: 100, z: 100 }));

    expect([...graph.nodes.values()].some((node) => graph.connectedSegments(node.id).length >= 4)).toBe(true);
    expect(() => graph.assertIntegrity()).not.toThrow();
  });

  it('creates graph intersections when two curves cross', () => {
    const graph = new RoadGraph();
    graph.buildRoad(curve({ x: -120, z: -80 }, { x: -40, z: -120 }, { x: 120, z: 80 }));
    graph.buildRoad(curve({ x: -120, z: 80 }, { x: -40, z: 120 }, { x: 120, z: -80 }));

    expect([...graph.nodes.values()].some((node) => graph.connectedSegments(node.id).length >= 4)).toBe(true);
    expect(() => graph.assertIntegrity()).not.toThrow();
  });

  it('carries the end tangent into continuous curve construction', () => {
    const graph = new RoadGraph();
    const firstResult = graph.buildRoad(curve({ x: -130, z: -60 }, { x: -70, z: -60 }, { x: 0, z: 0 }));
    const first = graph.segments.get(firstResult.createdSegmentIds.at(-1)!)!;
    const firstEndTangent = normalize(subtract(first.geometry.points.at(-1)!, first.geometry.points.at(-2)!));
    const directionPoint = { x: firstResult.endPosition.x + firstEndTangent.x * 45, z: firstResult.endPosition.z + firstEndTangent.z * 45 };
    const secondEnd = { x: directionPoint.x + 85, z: directionPoint.z + 55 };
    const secondResult = graph.buildRoad(curve(
      firstResult.endPosition,
      directionPoint,
      secondEnd,
      {
        startTangent: firstEndTangent,
        startIntent: { kind: 'node', nodeId: firstResult.endNodeId, position: firstResult.endPosition },
        endIntent: { kind: 'free', position: secondEnd },
      },
    ));
    const second = graph.segments.get(secondResult.createdSegmentIds[0])!;
    const secondStartTangent = normalize(subtract(second.geometry.points[1], second.geometry.points[0]));

    expect(firstEndTangent.x * secondStartTangent.x + firstEndTangent.z * secondStartTangent.z).toBeGreaterThan(0.995);
  });

  it('rejects a curve below the road type minimum radius', () => {
    const graph = new RoadGraph();
    const before = graph.snapshot();

    expect(() => graph.buildRoad(curve({ x: 0, z: 0 }, { x: 7, z: 0 }, { x: 10, z: 12 }))).toThrow(/curve-radius/);
    expect(graph.snapshot()).toEqual(before);
  });

  it('undoes and redoes a curve including its sampled geometry', () => {
    const graph = new RoadGraph();
    const history = new CommandHistory();
    history.execute(new BuildRoadCommand(curve({ x: -80, z: -40 }, { x: -20, z: -40 }, { x: 80, z: 50 })), graph);
    const built = graph.snapshot();

    expect(history.undo(graph)).toBe(true);
    expect(graph.segments.size).toBe(0);
    expect(history.redo(graph)).toBe(true);
    expect(graph.snapshot()).toEqual(built);
  });

  it('round-trips curve geometry and produces stable zoning cells', () => {
    const graph = new RoadGraph();
    graph.buildRoad(curve({ x: -100, z: -50 }, { x: -25, z: -60 }, { x: 110, z: 65 }));
    const beforeGraph = graph.snapshot();
    const beforeCells = generateZoningCells(beforeGraph);
    const save = serializeWorld({
      terrain: { width: 1024, depth: 1024, baseHeight: 0 },
      roadGraph: beforeGraph,
      gameClock: { gameSeconds: 600, speed: 2 },
      zoningAssignments: [],
    });
    const loaded = deserializeWorld(JSON.parse(JSON.stringify(save)));
    const afterCells = generateZoningCells(loaded.roadGraph);

    expect(loaded.roadGraph).toEqual(beforeGraph);
    expect(afterCells).toEqual(beforeCells);
  });
});
