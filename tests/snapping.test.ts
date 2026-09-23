import { describe, expect, it } from 'vitest';
import { RoadGraph } from '../src/roads/roadGraph';
import { DEFAULT_SNAP_SETTINGS, resolveConstructionSnap } from '../src/roads/snapping';

const emptyGraph = new RoadGraph().snapshot();

describe('construction guides', () => {
  it('snaps near a 15 degree increment', () => {
    const result = resolveConstructionSnap({
      raw: { x: 100, z: 4 }, start: { x: 0, z: 0 }, graph: emptyGraph, settings: DEFAULT_SNAP_SETTINGS,
    });
    expect(result.type).toBe('angle');
    expect(Math.abs(result.position.z)).toBeLessThan(0.01);
  });

  it('quantizes length to 8 metre modules', () => {
    const result = resolveConstructionSnap({
      raw: { x: 31.5, z: 4 }, start: { x: 0, z: 0 }, graph: emptyGraph,
      settings: { ...DEFAULT_SNAP_SETTINGS, angles: false, parallel: false, perpendicular: false },
    });
    expect(result.type).toBe('distance');
    expect(Math.hypot(result.position.x, result.position.z)).toBeCloseTo(32, 5);
  });

  it('supports disabling node snapping independently', () => {
    const graph = new RoadGraph();
    graph.buildRoad({ geometry: { kind: 'straight', points: [{ x: 0, z: 0 }, { x: 100, z: 0 }] }, roadTypeId: 'small' });
    const result = resolveConstructionSnap({
      raw: { x: 3, z: 2 }, graph: graph.snapshot(), settings: { ...DEFAULT_SNAP_SETTINGS, nodes: false, segments: false },
    });
    expect(result.type).toBe('none');
    expect(result.position).toEqual({ x: 3, z: 2 });
  });

  it('finds a parallel guide from a nearby road', () => {
    const graph = new RoadGraph();
    graph.buildRoad({ geometry: { kind: 'straight', points: [{ x: -100, z: 0 }, { x: 100, z: 0 }] }, roadTypeId: 'small' });
    const result = resolveConstructionSnap({
      raw: { x: 81, z: 53 }, start: { x: 0, z: 50 }, graph: graph.snapshot(),
      settings: { ...DEFAULT_SNAP_SETTINGS, angles: false, distance: false },
    });
    expect(result.type).toBe('parallel');
    expect(result.position.z).toBeCloseTo(50, 5);
  });

  it('prefers a curve tangent continuation when close', () => {
    const result = resolveConstructionSnap({
      raw: { x: 41, z: 4 }, start: { x: 0, z: 0 }, graph: emptyGraph,
      settings: { ...DEFAULT_SNAP_SETTINGS, angles: false, distance: false }, tangentHint: { x: 1, z: 0 },
    });
    expect(result.type).toBe('tangent');
    expect(result.position.z).toBeCloseTo(0, 5);
  });

  it('keeps an endpoint snap until the pointer leaves a wider release radius', () => {
    const graph = new RoadGraph();
    graph.buildRoad({ geometry: { kind: 'straight', points: [{ x: 0, z: 0 }, { x: 100, z: 0 }] }, roadTypeId: 'small' });
    const previousSnap = resolveConstructionSnap({
      raw: { x: 2, z: 1 }, graph: graph.snapshot(), settings: DEFAULT_SNAP_SETTINGS,
    });
    const retained = resolveConstructionSnap({
      raw: { x: 16, z: 0 }, graph: graph.snapshot(), settings: DEFAULT_SNAP_SETTINGS, previousSnap,
    });

    expect(previousSnap.type).toBe('node');
    expect(retained.type).toBe('node');
    expect(retained.position).toEqual({ x: 0, z: 0 });
  });

  it('uses hysteresis to avoid angle-snap flicker at the threshold', () => {
    const first = resolveConstructionSnap({
      raw: { x: 40, z: 2 }, start: { x: 0, z: 0 }, graph: emptyGraph,
      settings: { ...DEFAULT_SNAP_SETTINGS, distance: false },
    });
    const radians = 7 * Math.PI / 180;
    const retained = resolveConstructionSnap({
      raw: { x: Math.cos(radians) * 40, z: Math.sin(radians) * 40 },
      start: { x: 0, z: 0 }, graph: emptyGraph,
      settings: { ...DEFAULT_SNAP_SETTINGS, distance: false }, previousSnap: first,
    });

    expect(first.type).toBe('angle');
    expect(retained.type).toBe('angle');
    expect(retained.position.z).toBeCloseTo(0, 5);
  });

  it('snaps to the outward extension guide of a loose road endpoint', () => {
    const graph = new RoadGraph();
    graph.buildRoad({ geometry: { kind: 'straight', points: [{ x: 0, z: 0 }, { x: 100, z: 0 }] }, roadTypeId: 'small' });
    const result = resolveConstructionSnap({
      raw: { x: 140, z: 4 }, start: { x: 20, z: 60 }, graph: graph.snapshot(), settings: DEFAULT_SNAP_SETTINGS,
    });

    expect(result.type).toBe('tangent');
    expect(result.position).toEqual({ x: 140, z: 0 });
    expect(result.guides[0]).toMatchObject({ from: { x: 100, z: 0 }, label: 'END GUIDE' });
  });

  it('does not use an endpoint guide behind the loose endpoint', () => {
    const graph = new RoadGraph();
    graph.buildRoad({ geometry: { kind: 'straight', points: [{ x: 0, z: 0 }, { x: 100, z: 0 }] }, roadTypeId: 'small' });
    const result = resolveConstructionSnap({
      raw: { x: 60, z: 12 }, start: { x: 20, z: 60 }, graph: graph.snapshot(),
      settings: { ...DEFAULT_SNAP_SETTINGS, segments: false, angles: false, parallel: false, perpendicular: false, distance: false },
    });

    expect(result.type).toBe('none');
  });

  it('allows endpoint extension guides to be disabled', () => {
    const graph = new RoadGraph();
    graph.buildRoad({ geometry: { kind: 'straight', points: [{ x: 0, z: 0 }, { x: 100, z: 0 }] }, roadTypeId: 'small' });
    const result = resolveConstructionSnap({
      raw: { x: 140, z: 4 }, start: { x: 20, z: 60 }, graph: graph.snapshot(),
      settings: { ...DEFAULT_SNAP_SETTINGS, guidelines: false, angles: false, parallel: false, perpendicular: false, distance: false },
    });

    expect(result.type).toBe('none');
  });

  it('retains an endpoint guideline through small pointer jitter', () => {
    const graph = new RoadGraph();
    graph.buildRoad({ geometry: { kind: 'straight', points: [{ x: 0, z: 0 }, { x: 100, z: 0 }] }, roadTypeId: 'small' });
    const first = resolveConstructionSnap({
      raw: { x: 140, z: 6.5 }, start: { x: 20, z: 60 }, graph: graph.snapshot(), settings: DEFAULT_SNAP_SETTINGS,
    });
    const retained = resolveConstructionSnap({
      raw: { x: 142, z: 9 }, start: { x: 20, z: 60 }, graph: graph.snapshot(),
      settings: DEFAULT_SNAP_SETTINGS, previousSnap: first,
    });

    expect(first.guides[0]?.label).toBe('END GUIDE');
    expect(retained.type).toBe('tangent');
    expect(retained.guides[0]?.label).toBe('END GUIDE');
    expect(retained.position.z).toBeCloseTo(0, 5);
  });
});
