import { describe, expect, it } from 'vitest';
import { RoadGraph } from '../src/roads/roadGraph';
import { CommandHistory, BuildRoadCommand, RemoveRoadCommand } from '../src/simulation/commands';

const straight = (x1: number, z1: number, x2: number, z2: number) => ({
  geometry: { kind: 'straight' as const, points: [{ x: x1, z: z1 }, { x: x2, z: z2 }] },
  roadTypeId: 'small',
});

describe('RoadGraph', () => {
  it('creates a road segment with nodes and lanes', () => {
    const graph = new RoadGraph();
    graph.buildRoad(straight(0, 0, 100, 0));
    expect(graph.nodes.size).toBe(2);
    expect(graph.segments.size).toBe(1);
    expect(graph.lanes.size).toBe(2);
    expect([...graph.segments.values()][0].width).toBe(16);
    expect(() => graph.assertIntegrity()).not.toThrow();
  });

  it('snaps a new road to a nearby node without duplicating it', () => {
    const graph = new RoadGraph();
    graph.buildRoad(straight(0, 0, 100, 0));
    graph.buildRoad(straight(106, 4, 170, 60));
    expect(graph.nodes.size).toBe(3);
    expect(graph.connectedSegments('node-2').length).toBe(2);
  });

  it('does not silently node-snap an explicit free endpoint', () => {
    const graph = new RoadGraph();
    graph.buildRoad(straight(0, 0, 100, 0));
    const before = graph.snapshot();
    expect(() => graph.buildRoad({
      ...straight(106, 4, 170, 60),
      endpointIntents: {
        start: { kind: 'free', position: { x: 106, z: 4 } },
        end: { kind: 'free', position: { x: 170, z: 60 } },
      },
    })).toThrow(/road-footprint-overlap/);
    expect(graph.snapshot()).toEqual(before);
  });

  it('rejects a stale endpoint snap intent without mutating the graph', () => {
    const graph = new RoadGraph();
    graph.buildRoad(straight(0, 0, 100, 0));
    const before = graph.snapshot();
    expect(() => new CommandHistory().execute(new BuildRoadCommand({
      ...straight(50, 0, 50, 80),
      endpointIntents: {
        start: { kind: 'segment', segmentId: 'segment-999', position: { x: 50, z: 0 } },
        end: { kind: 'free', position: { x: 50, z: 80 } },
      },
    }), graph)).toThrow(/changed/);
    expect(graph.snapshot()).toEqual(before);
  });

  it('connects both endpoints when they snap to the same existing segment', () => {
    const graph = new RoadGraph();
    graph.buildRoad(straight(-100, 0, 100, 0));
    const originalLineage = [...graph.segments.values()][0].zoningLineageId;
    graph.buildRoad({
      geometry: {
        kind: 'polyline',
        points: [{ x: -50, z: 0 }, { x: -50, z: 60 }, { x: 50, z: 60 }, { x: 50, z: 0 }],
      },
      roadTypeId: 'small',
      endpointIntents: {
        start: { kind: 'segment', segmentId: 'segment-1', position: { x: -50, z: 0 } },
        end: { kind: 'segment', segmentId: 'segment-1', position: { x: 50, z: 0 } },
      },
    });
    const startJunction = [...graph.nodes.values()].find((node) => Math.abs(node.position.x + 50) < 0.01 && Math.abs(node.position.z) < 0.01);
    const endJunction = [...graph.nodes.values()].find((node) => Math.abs(node.position.x - 50) < 0.01 && Math.abs(node.position.z) < 0.01);
    expect(graph.connectedSegments(startJunction!.id)).toHaveLength(3);
    expect(graph.connectedSegments(endJunction!.id)).toHaveLength(3);
    const originalRoadFragments = [...graph.segments.values()]
      .filter((segment) => segment.zoningLineageId === originalLineage)
      .sort((left, right) => (left.zoningStartOffset ?? 0) - (right.zoningStartOffset ?? 0));
    expect(originalRoadFragments.map((segment) => segment.zoningStartOffset)).toEqual([0, 50, 150]);
    expect(() => graph.assertIntegrity()).not.toThrow();
  });

  it('splits a segment when connecting to its middle', () => {
    const graph = new RoadGraph();
    graph.buildRoad(straight(-100, 0, 100, 0));
    const originalLineage = [...graph.segments.values()][0].zoningLineageId;
    graph.buildRoad(straight(-37, 3, -37, 90));
    expect(graph.segments.size).toBe(3);
    const junction = [...graph.nodes.values()].find((node) => Math.abs(node.position.x + 37) < 0.1 && Math.abs(node.position.z) < 0.1);
    expect(junction).toBeDefined();
    expect(graph.connectedSegments(junction!.id)).toHaveLength(3);
    const originalRoadFragments = [...graph.segments.values()]
      .filter((segment) => segment.zoningLineageId === originalLineage)
      .sort((left, right) => (left.zoningStartOffset ?? 0) - (right.zoningStartOffset ?? 0));
    expect(originalRoadFragments.map((segment) => segment.zoningStartOffset)).toEqual([0, 63]);
    expect(() => graph.assertIntegrity()).not.toThrow();
  });

  it('creates a connected four-way intersection', () => {
    const graph = new RoadGraph();
    graph.buildRoad(straight(-100, 0, 100, 0));
    graph.buildRoad(straight(0, -100, 0, 100));
    expect(graph.segments.size).toBe(4);
    const intersection = [...graph.nodes.values()].find((node) => Math.abs(node.position.x) < 0.1 && Math.abs(node.position.z) < 0.1);
    expect(intersection).toBeDefined();
    expect(graph.connectedSegments(intersection!.id)).toHaveLength(4);
    expect(() => graph.assertIntegrity()).not.toThrow();
  });

  it('rejects a pavement near-miss instead of creating a false intersection', () => {
    const graph = new RoadGraph();
    graph.buildRoad(straight(-100, 0, 100, 0));
    const before = graph.snapshot();
    expect(() => graph.buildRoad(straight(105, -100, 105, 100))).toThrow(/road-footprint-overlap/);
    expect(graph.snapshot()).toEqual(before);
    expect(() => graph.assertIntegrity()).not.toThrow();
  });

  it('removes a road, its lanes, and orphan nodes', () => {
    const graph = new RoadGraph();
    const result = graph.buildRoad(straight(0, 0, 100, 0));
    expect(graph.removeSegment(result.createdSegmentIds[0])).toBe(true);
    expect(graph.nodes.size).toBe(0);
    expect(graph.segments.size).toBe(0);
    expect(graph.lanes.size).toBe(0);
  });

  it('undoes and redoes a build command', () => {
    const graph = new RoadGraph();
    const history = new CommandHistory();
    history.execute(new BuildRoadCommand(straight(0, 0, 100, 0)), graph);
    expect(graph.segments.size).toBe(1);
    expect(history.undo(graph)).toBe(true);
    expect(graph.segments.size).toBe(0);
    expect(history.redo(graph)).toBe(true);
    expect(graph.segments.size).toBe(1);
  });

  it('undoes and redoes road removal with graph identity intact', () => {
    const graph = new RoadGraph();
    const history = new CommandHistory();
    const build = new BuildRoadCommand(straight(0, 0, 100, 0));
    history.execute(build, graph);
    const segmentId = [...graph.segments.keys()][0];
    history.execute(new RemoveRoadCommand(segmentId), graph);
    expect(graph.segments.size).toBe(0);
    history.undo(graph);
    expect(graph.segments.has(segmentId)).toBe(true);
    history.redo(graph);
    expect(graph.segments.size).toBe(0);
  });

  it('rolls back every graph mutation when a command fails', () => {
    const graph = new RoadGraph();
    const history = new CommandHistory();
    graph.buildRoad(straight(-100, 0, 100, 0));
    const before = graph.snapshot();
    expect(() => history.execute(new BuildRoadCommand({
      geometry: { kind: 'straight', points: [{ x: 0, z: 1 }, { x: 0, z: 2 }] },
      roadTypeId: 'small',
    }), graph)).toThrow();
    expect(graph.snapshot()).toEqual(before);
    expect(() => graph.assertIntegrity()).not.toThrow();
  });
});
