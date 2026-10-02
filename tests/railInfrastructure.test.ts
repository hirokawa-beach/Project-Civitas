import { describe, expect, it } from 'vitest';
import { SimulationState } from '../src/simulation/state';
import { RailwayInfrastructure } from '../src/railway/infrastructure';
import { trackGeometry, TrackEdgeIndex } from '../src/railway/geometry';
import { LandOwnership, defaultLandOwnership } from '../src/world/landOwnership';
import { createWorldMetadata } from '../src/world/metadata';
import type { StationTemplate, TrackMode } from '../src/railway/types';
import { railwayFixture } from './fixtures/railway';

describe('Railway Infrastructure authority', () => {
  it('rejects inconsistent station track references and malformed footprints before replacing the live city', () => {
    const state = railwayFixture('island'), before = state.railway.save();
    for (const kind of ['wrong-track', 'duplicate-track', 'triangle', 'skew-platform']) {
      const saved = state.serialize(), station = saved.railway!.stations[0];
      if (kind === 'wrong-track') station.connectedTrackIds[0] = saved.railway!.segments.find(track => !station.connectedTrackIds.includes(track.id))!.id;
      else if (kind === 'duplicate-track') station.connectedTrackIds[1] = station.connectedTrackIds[0];
      else if (kind === 'triangle') station.boundary.pop();
      else station.platforms[0].outline[2].x += 1;
      expect(() => state.load(saved)).toThrow(/station|platform/i); expect(state.railway.save()).toEqual(before);
    }
  });
  it.each(['single', 'double', 'island', 'depot'] as const)('rejects steep/missing terrain across a %s footprint even with a valid centerline', kind => {
    const rail = new RailwayInfrastructure();
    rail.mutate({ type: 'build-track', input: { points: [{ x: -400, z: 0 }, { x: 400, z: 0 }], trackTypeId: 'standard' } });
    const id = [...rail.segments.keys()][0], before = rail.save();
    const command = kind === 'depot' ? { type: 'place-depot' as const, trackSegmentId: id, offset: 400, name: 'Slope', capacity: 8 }
      : { type: 'place-station' as const, trackSegmentId: id, offset: 400, name: 'Slope', template: kind, length: 120 };
    for (const bank of [10, NaN]) {
      rail.height = (_x, z) => z < -2 ? bank : 0;
      expect(() => rail.mutate(command)).toThrow(/grade|missing terrain/); expect(rail.save()).toEqual(before);
    }
    rail.height = (_x, z) => z * .01; expect(rail.mutate(command)).toHaveLength(1);
  });
  it('protects the complete depot footprint through brushes, presets, Load and demolition Undo/Redo', () => {
    const state = new SimulationState();
    state.execute({ type: 'build-track', input: { points: [{ x: -100, z: 0 }, { x: 100, z: 0 }], trackTypeId: 'standard' } });
    state.execute({ type: 'place-depot', trackSegmentId: [...state.railway.segments.keys()][0], offset: 100, name: 'Protected', capacity: 8 });
    const supported = [{ x: -12, z: -8 }, { x: 12, z: 8 }, { x: 0, z: 8 }];
    for (const mode of ['raise', 'lower', 'flatten', 'smooth'] as const) {
      state.beginTerrainStroke({ x: 0, z: 8 }, mode, 96, 40); state.applyTerrainStroke([{ x: 0, z: 8 }], .25); state.endTerrainStroke();
      for (const p of supported) expect(state.terrain.getHeight(p.x, p.z)).toBe(0);
    }
    state.setTerrainPreset('hills'); for (const p of supported) expect(state.terrain.getHeight(p.x, p.z)).toBe(0);
    const loaded = new SimulationState(); loaded.load(state.serialize());
    loaded.beginTerrainStroke({ x: 0, z: 8 }, 'raise', 96, 40); loaded.endTerrainStroke();
    for (const p of supported) expect(loaded.terrain.getHeight(p.x, p.z)).toBe(0);
    const depot = [...loaded.railway.depots.keys()][0]; loaded.execute({ type: 'remove-railway', kind: 'depot', id: depot });
    loaded.undo(); expect(loaded.railway.depots.has(depot)).toBe(true); loaded.redo(); expect(loaded.railway.depots.has(depot)).toBe(false);
    loaded.beginTerrainStroke({ x: 0, z: 8 }, 'raise', 48, 40); loaded.endTerrainStroke(); expect(loaded.terrain.getHeight(0, 8)).toBeGreaterThan(0);
  });
  it.each(['single', 'double', 'island'] as StationTemplate[])('protects %s station boundary support vertices outside the narrow track mask', template => {
    const state = new SimulationState();
    state.execute({ type: 'build-track', input: { points: [{ x: -480, z: 1.3 }, { x: 480, z: 1.3 }], trackTypeId: 'standard' } });
    state.execute({ type: 'place-station', trackSegmentId: [...state.railway.segments.keys()][0], offset: 180.3, name: 'Protected', template, length: 120 });
    for (const p of [...state.railway.stations.values()][0].boundary) for (const x of [Math.floor(p.x / 4) * 4, Math.ceil(p.x / 4) * 4]) for (const z of [Math.floor(p.z / 4) * 4, Math.ceil(p.z / 4) * 4]) {
      state.beginTerrainStroke({ x, z }, 'raise', 48, 40); state.endTerrainStroke(); expect(state.terrain.getHeight(x, z)).toBe(0);
    }
  });
  it.each([
    [{ x: -300, z: -300 }, { x: 300, z: 300 }, { x: -300, z: 300 }, { x: 300, z: -300 }],
    [{ x: -300, z: 0 }, { x: 300, z: 0 }, { x: 300, z: 300 }, { x: -300, z: 300 }, { x: -300, z: 0 }, { x: 0, z: 0 }],
  ].map(points => ({ points })))('rejects a self-crossing/touching alignment before changing any existing graph state (%#)', ({ points }) => {
    const rail = new RailwayInfrastructure();
    rail.mutate({ type: 'build-track', input: { points: [{ x: -400, z: -450 }, { x: 400, z: -450 }], trackTypeId: 'standard' } });
    const before = rail.save();
    expect(() => rail.mutate({ type: 'build-track', input: { points, trackTypeId: 'standard' } })).toThrow(/self-crosses|overlaps itself/);
    expect(rail.save()).toEqual(before);
  });
  it('accepts a 16km densely sampled simple alignment with local self-intersection queries', () => {
    const rail = new RailwayInfrastructure();
    rail.ownership = new LandOwnership(createWorldMetadata({ worldWidthMeters: 32768, worldDepthMeters: 32768, terrainSampleSpacingMeters: 64 }));
    const points = Array.from({ length: 4001 }, (_, i) => ({ x: i * 4 - 8000, z: 0 }));
    rail.mutate({ type: 'build-track', input: { points, trackTypeId: 'standard' } });
    expect([...rail.segments.values()][0].length).toBe(16000);
  });
  it('validates depot offsets at their actual footprint and preserves placement through Save/Undo', () => {
    const state = new SimulationState();
    state.execute({ type: 'build-track', input: { points: [{ x: -400, z: 0 }, { x: 400, z: 0 }], trackTypeId: 'standard' } });
    const id = [...state.railway.segments.keys()][0];
    state.execute({ type: 'place-depot', trackSegmentId: id, offset: 100, name: 'Clicked depot', capacity: 8 });
    const saved = state.railway.save(); expect(saved.depots[0].position).toEqual({ x: -300, z: 0 });
    const loaded = new SimulationState(); loaded.load(state.serialize()); expect(loaded.railway.save()).toEqual(saved);
    state.undo(); expect(state.railway.depots.size).toBe(0); state.redo(); expect(state.railway.save()).toEqual(saved);
    for (const offset of [NaN, Infinity, -1, 801]) {
      expect(() => state.execute({ type: 'place-depot', trackSegmentId: id, offset, name: 'Invalid depot', capacity: 8 })).toThrow(/offset/);
      expect(state.railway.save()).toEqual(saved);
    }
    state.railway.waterAt = (x, z) => Math.abs(x - 300) < 3 && Math.abs(z - 4) < 1;
    expect(() => state.execute({ type: 'place-depot', trackSegmentId: id, offset: 700, name: 'Wet click', capacity: 8 })).toThrow(/water/);
    expect(state.railway.save()).toEqual(saved);
  });
  it.each(['double', 'island'] as StationTemplate[])('rejects %s generated parallel/platform/approach collisions with existing tracks', template => {
    for (const points of [
      [{ x: -100, z: 6 }, { x: 100, z: 6 }],
      [{ x: 0, z: 2 }, { x: 0, z: 20 }],
      [{ x: -100, z: 2 }, { x: -100, z: 20 }],
    ]) {
      const rail = new RailwayInfrastructure(); rail.mutate({ type: 'build-track', input: { points, trackTypeId: 'standard' } });
      const ids = rail.mutate({ type: 'build-track', input: { points: [{ x: -400, z: 0 }, { x: 400, z: 0 }], trackTypeId: 'standard' } }), before = rail.save();
      expect(() => rail.mutate({ type: 'place-station', name: 'Collision', trackSegmentId: ids[0], offset: 400, length: 120, template })).toThrow(/overlaps|collides/);
      expect(rail.save()).toEqual(before);
    }
  });
  it('rejects a depot footprint containing water even when the connected track and all corners are dry', () => {
    const rail = new RailwayInfrastructure(); rail.mutate({ type: 'build-track', input: { points: [{ x: -100, z: 0 }, { x: 100, z: 0 }], trackTypeId: 'standard' } });
    const id = [...rail.segments.keys()][0], before = rail.save(); rail.waterAt = (x, z) => Math.abs(x) < 3 && Math.abs(z - 4) < 1;
    expect(rail.depotOutline({ x: 0, z: 0 }).some(p => rail.waterAt(p.x, p.z))).toBe(false);
    expect(() => rail.mutate({ type: 'place-depot', trackSegmentId: id, name: 'Wet depot', capacity: 8 })).toThrow(/water/);
    expect(rail.save()).toEqual(before);
  });
  it.each(['double', 'island'] as StationTemplate[])('rejects %s parallel track crossing side water or steep terrain atomically', template => {
    const rail = new RailwayInfrastructure(); rail.mutate({ type: 'build-track', input: { points: [{ x: -400, z: 0 }, { x: 400, z: 0 }], trackTypeId: 'standard' } });
    const before = rail.save(), track = [...rail.segments.values()][0];
    const command = { type: 'place-station' as const, name: 'Side validation', trackSegmentId: track.id, offset: 400, length: 120, template };
    // Existing centerline, platform/boundary corners and both approaches stay valid.
    rail.waterAt = (x, z) => Math.abs(x) < 10 && Math.abs(z - 6) < 1;
    expect(() => rail.mutate(command)).toThrow(/water/); expect(rail.save()).toEqual(before);
    rail.waterAt = () => false; rail.height = (x, z) => Math.abs(x) < 10 && Math.abs(z - 6) < 1 ? 10 : 0;
    expect(() => rail.mutate(command)).toThrow(/grade/); expect(rail.save()).toEqual(before);
  });
  it('bounds intersection candidates locally on a 16km sampled track', () => {
    const index = new TrackEdgeIndex(), points = Array.from({ length: 4001 }, (_, i) => ({ x: i * 4 - 8000, z: 0 }));
    index.rebuild([{ id: 'long-track', points }]);
    let queries = 0, candidates = 0;
    for (let x = -8000; x < 8000; x += 4) { queries++; candidates += index.query({ x, z: 2 }, { x: x + 4, z: 2 }).length; }
    expect(candidates / queries).toBeLessThan(70);
    expect(index.query({ x: -1, z: -4 }, { x: 1, z: 4 }).every(e => Math.abs(e.points[0].x) <= 132)).toBe(true);
  });
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
  it('loads existing infrastructure after water elevation changes without weakening new-construction validation', () => {
    const state = railwayFixture(); state.water.setSeaLevel(20);
    const loaded = new SimulationState(); loaded.load(state.serialize()); expect(loaded.railway.save()).toEqual(state.railway.save());
    expect(() => loaded.execute({ type: 'build-track', input: { points: [{ x: -100, z: 200 }, { x: 100, z: 200 }], trackTypeId: 'standard' } })).toThrow(/water/);
  });
});
