import { describe, expect, it } from 'vitest';
import { SimulationState } from '../src/simulation/state';
import { RailwayInfrastructure } from '../src/railway/infrastructure';
import { trackGeometry } from '../src/railway/geometry';
import { LandOwnership, defaultLandOwnership } from '../src/world/landOwnership';
import { createWorldMetadata } from '../src/world/metadata';
import type { StationTemplate, TrackMode } from '../src/railway/types';

export function railwayFixture(template: StationTemplate = 'single') {
  const state = new SimulationState();
  state.execute({ type: 'build-track', input: { points: [{ x: -480, z: 0 }, { x: 480, z: 0 }], trackTypeId: 'standard' } });
  const first = [...state.railway.segments.values()][0];
  state.execute({ type: 'place-station', trackSegmentId: first.id, offset: 180, length: 120, template, name: 'West' });
  const last = [...state.railway.segments.values()].find(t => t.points.at(-1)!.x === 480)!;
  state.execute({ type: 'place-station', trackSegmentId: last.id, offset: 460, length: 120, template: 'single', name: 'East' });
  const depotTrack = [...state.railway.segments.values()].find(t => t.points[0].x === -480)!;
  state.execute({ type: 'place-depot', trackSegmentId: depotTrack.id, capacity: 8, name: 'West Depot' });
  return state;
}

describe('Railway Infrastructure authority', () => {
  it('keeps road/track graphs independent and creates snapped branch connectivity/switch direction', () => {
    const state = new SimulationState();
    state.execute({ type: 'build-track', input: { points: [{ x: -200, z: 0 }, { x: 200, z: 0 }], trackTypeId: 'standard' } });
    state.execute({ type: 'build-track', input: { points: [{ x: 0, z: -200 }, { x: 0, z: 3 }], trackTypeId: 'standard' } });
    expect(state.graph.segments.size).toBe(0); expect(state.railway.segments.size).toBe(3);
    const junction = [...state.railway.junctions.values()][0]; expect(junction.segmentIds.length).toBe(3);
    const [a, b, c] = junction.segmentIds;
    state.execute({ type: 'set-rail-switch', junctionId: junction.id, route: [a, b] });
    expect(state.railway.junctionAllows(junction.nodeId, a, b)).toBe(true);
    expect(state.railway.junctionAllows(junction.nodeId, a, c)).toBe(false);
    expect(() => state.execute({ type: 'set-rail-switch', junctionId: junction.id, route: [a, 'road-1'] })).toThrow();
  });
  it.each(['straight', 'one-curve', 'two-curve', 'continuous'] as TrackMode[])('constructs %s track using the shared pure geometry', mode => {
    const anchors = mode === 'straight' ? [{ x: -300, z: 0 }, { x: 300, z: 0 }]
      : mode === 'two-curve' ? [{ x: -300, z: 0 }, { x: -100, z: -120 }, { x: 100, z: 120 }, { x: 300, z: 0 }]
      : [{ x: -200, z: -200 }, { x: 100, z: -200 }, { x: 200, z: 200 }];
    const rail = new RailwayInfrastructure(); rail.mutate({ type: 'build-track', input: { points: trackGeometry(mode, anchors), trackTypeId: 'narrow' } });
    expect(rail.segments.size).toBe(1); expect([...rail.segments.values()][0].length).toBeGreaterThan(300);
  });
  it.each(['single', 'double', 'island'] as StationTemplate[])('places %s station with actual platforms/faces and generated tracks/junctions', template => {
    const state = railwayFixture(template), station = [...state.railway.stations.values()][0];
    expect(station.platforms.length).toBe(template === 'double' ? 2 : 1);
    expect(station.platforms.flatMap(p => p.faces).length).toBe(template === 'single' ? 1 : 2);
    for (const platform of station.platforms) for (const face of platform.faces) {
      expect(state.railway.requireTrack(face.trackSegmentId).length).toBeCloseTo(120);
      expect(state.railway.fitsPlatform(face.platformFaceId, 120)).toBe(true); expect(state.railway.fitsPlatform(face.platformFaceId, 121)).toBe(false);
    }
    expect(state.railway.depots.size).toBe(1); expect(state.railway.junctions.size).toBe(template === 'single' ? 0 : 2);
    const loaded = new SimulationState(); loaded.load(state.serialize()); expect(loaded.railway.save()).toEqual(state.railway.save());
  });
  it('reserves/occupies tracks, junctions and faces atomically and detects conflicting owners', () => {
    const rail = railwayFixture('island').railway, ids = [...rail.blocks.keys()].slice(0, 3);
    expect(rail.reserve('A', [ids[0]])).toBe(true); expect(rail.reserve('B', ids)).toBe(false);
    expect(rail.blocks.get(ids[1])!.reservationOwner).toBeNull();
    expect(rail.occupy('A', ids)).toBe(true); expect(rail.occupy('B', [ids[2]])).toBe(false);
    expect(() => rail.mutate({ type: 'remove-railway', kind: 'track', id: ids[0] })).toThrow(/occupied/);
    rail.release('A'); expect(rail.reserve('B', ids)).toBe(true);
  });
  it('validates grade between anchors, tight curves, water, ownership and rejects invalid commands atomically', () => {
    const rail = new RailwayInfrastructure(), command = { type: 'build-track' as const, input: { points: [{ x: -100, z: 0 }, { x: 100, z: 0 }], trackTypeId: 'standard' } };
    const before = rail.save(); rail.height = x => Math.abs(x) < 10 ? 20 : 0;
    expect(() => rail.mutate(command)).toThrow(/grade/); expect(rail.save()).toEqual(before);
    rail.height = () => 0; rail.waterAt = x => Math.abs(x) < 3; expect(() => rail.mutate(command)).toThrow(/water/);
    rail.waterAt = () => false; expect(() => rail.mutate({ ...command, input: { ...command.input, points: [{ x: 0, z: 0 }, { x: 4, z: 0 }, { x: 4, z: 4 }] } })).toThrow(/radius/);
    const world = createWorldMetadata({ worldWidthMeters: 4096, worldDepthMeters: 4096 });
    rail.ownership = new LandOwnership(world, defaultLandOwnership(world, 'progressive'));
    expect(() => rail.mutate(command)).toThrow(/Unlock/);
    expect(rail.save()).toEqual(before);
    rail.ownership = new LandOwnership(world); rail.mutate(command); expect(rail.segments.size).toBe(1);
  });
  it('supports construction/demolition Undo/Redo in the shared history and protects track terrain', () => {
    const state = railwayFixture('island'), initial = state.railway.save(), depot = [...state.railway.depots.keys()][0];
    state.execute({ type: 'remove-railway', kind: 'depot', id: depot }); expect(state.railway.depots.size).toBe(0);
    state.undo(); expect(state.railway.save()).toEqual(initial); state.redo(); expect(state.railway.depots.size).toBe(0);
    state.undo(); const height = state.terrain.getHeight(0, 0); state.beginTerrainStroke({ x: 0, z: 0 }, 'raise', 40, 20); state.endTerrainStroke();
    expect(state.terrain.getHeight(0, 0)).toBe(height);
    state.undo(); state.undo(); expect(state.railway.depots.size).toBe(0); state.redo(); expect(state.railway.depots.size).toBe(1);
  });
  it('loads existing saves without railway and rejects corrupt track/face references without replacing live state', () => {
    const state = railwayFixture(), saved = state.serialize(), before = state.railway.save();
    saved.railway!.stations[0].platforms[0].faces[0].trackSegmentId = 'missing';
    expect(() => state.load(saved)).toThrow(); expect(state.railway.save()).toEqual(before);
    delete saved.railway; state.load(saved); expect(state.railway.segments.size).toBe(0); expect(state.railway.stations.size).toBe(0);
  });
});
