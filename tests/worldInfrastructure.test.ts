import { describe, expect, it } from 'vitest';
import { RoadGraph } from '../src/roads/roadGraph';
import { profileRoadElevation, roadHeightAt } from '../src/roads/elevation';
import { getRoadType } from '../src/roads/roadTypes';
import { migrateSave } from '../src/save/serializer';
import { SimulationState } from '../src/simulation/state';
import { StaticWater } from '../src/water/staticWater';
import type { Vec2 } from '../src/world/types';

const flat = (_x: number, _z: number) => 0;
const horizontal = (z = 0): Vec2[] => [{ x: -150, z }, { x: 150, z }];
const vertical = (x = 0): Vec2[] => [{ x, z: -150 }, { x, z: 150 }];
const build = (graph: RoadGraph, points: Vec2[], structureType: 'ground' | 'elevated' | 'bridge' | 'tunnel',
  height: (x: number, z: number) => number = flat, waterLevel = -12) => graph.buildRoad({ geometry: { kind: 'straight', points }, roadTypeId: 'small',
  structureType, targetElevation: structureType === 'ground' ? 0 : 8 }, height, waterLevel);

describe('static water and structured roads', () => {
  it('keeps ground roads following terrain and records a 3D centerline', () => {
    const graph = new RoadGraph();
    const height = (x: number) => x * 0.05 + 10;
    const result = build(graph, horizontal(), 'ground', height);
    const segment = graph.segments.get(result.createdSegmentIds[0])!;
    expect(segment.geometry.centerline!.length).toBeGreaterThan(10);
    expect(roadHeightAt(segment.geometry, { x: 0, z: 0 })).toBeCloseTo(10, 2);
    expect(segment.zoningAllowed).toBe(true);
  });

  it('creates elevated ramps with configurable grade, clearance and no zoning', () => {
    const graph = new RoadGraph();
    const result = build(graph, horizontal(), 'elevated');
    const segment = graph.segments.get(result.createdSegmentIds[0])!;
    expect(segment.geometry.centerline![0].y).toBeCloseTo(0);
    expect(roadHeightAt(segment.geometry, { x: 0, z: 0 })).toBeCloseTo(8);
    expect(segment.geometry.centerline!.at(-1)!.y).toBeCloseTo(0);
    expect(segment.zoningAllowed).toBe(false);
    expect(segment.structureType).toBe('elevated');
    expect(getRoadType('small').minimumVerticalClearance).toBe(6);
  });

  it('rejects short transitions, excessive grade and insufficient clearance', () => {
    const graph = new RoadGraph();
    expect(() => build(graph, [{ x: -40, z: 0 }, { x: 40, z: 0 }], 'elevated')).toThrow(/short-transition/);
    expect(graph.segments.size).toBe(0);
    const hill = (x: number) => Math.abs(x) < 25 ? 13 : 0;
    const profile = profileRoadElevation(horizontal(), 'elevated', 8, hill, getRoadType('small'));
    expect(profile.valid).toBe(false);
    expect(profile.reason).toBe('insufficient-clearance');
    const steep = profileRoadElevation(horizontal(), 'ground', 0, (x) => x * 0.2, getRoadType('small'));
    expect(steep.reason).toBe('steep-grade');
  });

  it('crosses the same X/Z at different elevations without a shared junction', () => {
    const graph = new RoadGraph();
    build(graph, horizontal(), 'ground');
    const raised = build(graph, vertical(), 'elevated');
    expect(raised.intersectionNodeIds).toEqual([]);
    expect(graph.segments.size).toBe(2);
    expect(graph.nodes.size).toBe(4);
    expect([...graph.segments.values()].map((segment) => roadHeightAt(segment.geometry, { x: 0, z: 0 })).sort()).toEqual([0, 8]);
    expect(() => graph.assertIntegrity()).not.toThrow();
  });

  it('rejects a crossing through a ramp with too little vertical clearance', () => {
    const graph = new RoadGraph();
    build(graph, horizontal(), 'elevated');
    expect(() => build(graph, vertical(-125), 'ground')).toThrow(/vertical-clearance/);
    expect(graph.segments.size).toBe(1);
  });

  it('spans a static water-filled lowland with a bridge', () => {
    const water = new StaticWater({ version: 1, seaLevel: 0 });
    const terrain = { getHeight: (x: number, _z: number) => Math.abs(x) < 30 ? -10 : 0 };
    expect(water.isWaterAt(0, 0, terrain)).toBe(true);
    expect(water.isWaterAt(100, 0, terrain)).toBe(false);
    const graph = new RoadGraph();
    const result = build(graph, horizontal(), 'bridge', (x) => terrain.getHeight(x, 0), water.seaLevel);
    const bridge = graph.segments.get(result.createdSegmentIds[0])!;
    expect(roadHeightAt(bridge.geometry, { x: 0, z: 0 })).toBeGreaterThan(water.seaLevel + 6);
    expect(bridge.zoningAllowed).toBe(false);
  });

  it('places a tunnel below terrain and retains entry transitions', () => {
    const graph = new RoadGraph();
    const result = build(graph, horizontal(), 'tunnel');
    const tunnel = graph.segments.get(result.createdSegmentIds[0])!;
    expect(roadHeightAt(tunnel.geometry, { x: 0, z: 0 })).toBeCloseTo(-8);
    expect(tunnel.geometry.centerline![0].y).toBeCloseTo(0);
    expect(tunnel.geometry.centerline!.at(-1)!.y).toBeCloseTo(0);
    expect(tunnel.zoningAllowed).toBe(false);
  });

  it('preserves 3D geometry when an existing road is split', () => {
    const graph = new RoadGraph();
    const height = (x: number) => x * 0.04;
    build(graph, horizontal(), 'ground', height);
    graph.buildRoad({ geometry: { kind: 'straight', points: [{ x: 0, z: -150 }, { x: 0, z: 0 }] },
      roadTypeId: 'small' }, height);
    expect(graph.segments.size).toBe(3);
    const split = [...graph.segments.values()].filter((segment) => Math.abs(segment.geometry.points[0].z) < 0.01
      && Math.abs(segment.geometry.points.at(-1)!.z) < 0.01);
    expect(split).toHaveLength(2);
    expect(roadHeightAt(split[0].geometry, { x: -100, z: 0 })).toBeCloseTo(-4);
    expect(roadHeightAt(split[1].geometry, { x: 100, z: 0 })).toBeCloseTo(4);
  });

  it('keeps elevated geometry fixed when terrain beneath it is edited', () => {
    const state = new SimulationState();
    state.execute({ type: 'build-road', input: { geometry: { kind: 'straight', points: horizontal() },
      roadTypeId: 'small', structureType: 'bridge', targetElevation: 8 } });
    const before = state.graph.snapshot().segments[0].geometry.centerline;
    state.beginTerrainStroke({ x: 0, z: 0 }, 'raise', 40, 12);
    state.endTerrainStroke();
    expect(state.terrain.getHeight(0, 0)).toBeGreaterThan(0);
    expect(state.graph.snapshot().segments[0].geometry.centerline).toEqual(before);
  });

  it('saves water and 3D roads, migrates v10, and supports water undo/redo', () => {
    const state = new SimulationState();
    state.execute({ type: 'set-water-level', seaLevel: 2 });
    expect(state.water.seaLevel).toBe(2);
    state.undo(); expect(state.water.seaLevel).toBe(-12);
    state.redo(); expect(state.water.seaLevel).toBe(2);
    state.execute({ type: 'build-road', input: { geometry: { kind: 'straight', points: horizontal() },
      roadTypeId: 'small', structureType: 'bridge', targetElevation: 8 } });
    const saved = state.serialize();
    expect(saved.saveVersion).toBe(11);
    const loaded = new SimulationState(); loaded.load(JSON.parse(JSON.stringify(saved)));
    expect(loaded.water.seaLevel).toBe(2);
    expect(loaded.graph.snapshot().segments[0].geometry.centerline).toEqual(state.graph.snapshot().segments[0].geometry.centerline);
    const old = structuredClone(saved) as unknown as Record<string, unknown>;
    old.saveVersion = 10; delete old.water;
    const migrated = migrateSave(old);
    expect(migrated.water.seaLevel).toBe(-12);
    expect(migrated.roadGraph.segments[0].geometry.centerline!.length).toBeGreaterThan(2);
    const corrupt = structuredClone(saved);
    corrupt.roadGraph.segments[0].geometry.centerline![0].y = Number.NaN;
    expect(() => loaded.load(corrupt)).toThrow(/centerline/);
    expect(loaded.graph.snapshot().segments[0].geometry.centerline).toEqual(state.graph.snapshot().segments[0].geometry.centerline);
  });

  it('does not create RCIO cells along elevated roads', () => {
    const state = new SimulationState();
    state.execute({ type: 'build-road', input: { geometry: { kind: 'straight', points: horizontal() },
      roadTypeId: 'small', structureType: 'elevated', targetElevation: 8 } });
    expect(state.snapshot().zoningCells).toHaveLength(0);
  });
});
