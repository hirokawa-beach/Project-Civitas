import { describe, expect, it } from 'vitest';
import { SimulationState } from '../src/simulation/state';
import { FORMATION_TYPES, RAIL_SERVICE_TYPES, type FrequencyInput, type RailTimetable } from '../src/railway/operationsTypes';
import { railwayFixture } from './fixtures/railway';
import { railPose } from '../src/railway/routing';

function input(state: SimulationState, changes: Partial<FrequencyInput> = {}): FrequencyInput {
  return { name: 'Test line', color: '#58b0d0', start: 30, end: 31, frequency: 120,
    faceIds: [...state.railway.stations.values()].map(s => s.platforms[0].faces[0].platformFaceId),
    depotId: [...state.railway.depots.keys()][0], formationTypeId: 'commuter-2', serviceTypeId: 'local', returnService: true, ...changes };
}
const advance = (state: SimulationState, seconds: number) => state.tick((seconds - state.clock.gameSeconds) / 10);
function opposing(state: SimulationState): RailTimetable {
  state.execute({ type: 'create-rail-frequency', input: input(state, { returnService: false }) });
  const save = state.railway.save().operations!;
  state.execute({ type: 'clear-rail-operations' });
  const data: RailTimetable = { lines: save.lines, serviceTypes: structuredClone([...RAIL_SERVICE_TYPES]), formationTypes: structuredClone([...FORMATION_TYPES]), services: save.services, formations: save.formations, operations: save.operations };
  const service = structuredClone(data.services[0]); service.id = 'opposing'; service.trainNumber = '2';
  const [a, b] = service.stopCalls; service.stopCalls = [{ ...b, sequence: 0, arrivalTime: a.arrivalTime, departureTime: a.departureTime }, { ...a, sequence: 1, arrivalTime: b.arrivalTime, departureTime: b.departureTime }];
  service.origin = b.stationId; service.destination = a.stationId; data.services.push(service);
  data.formations.push({ ...data.formations[0], formationId: 'opposing-formation' });
  data.operations.push({ operationId: 'opposing-operation', operationNumber: '2', trainServiceIds: [service.id], assignedFormationId: 'opposing-formation' });
  return data;
}

describe('event-driven railway operations', () => {
  it('requires OD endpoints to belong to the selected line on commands and detached Save Load', () => {
    const state = railwayFixture();
    state.execute({ type: 'build-track', input: { points: [{ x: -200, z: 200 }, { x: 200, z: 200 }], trackTypeId: 'standard' } });
    const track = [...state.railway.segments.values()].find(t => t.points[0].z === 200)!;
    state.execute({ type: 'place-station', trackSegmentId: track.id, offset: 200, name: 'Unserved', template: 'single', length: 80 });
    const stations = [...state.railway.stations.values()], [origin, destination, other] = stations;
    state.execute({ type: 'create-rail-frequency', input: input(state, { faceIds: stations.slice(0, 2).map(s => s.platforms[0].faces[0].platformFaceId) }) });
    const lineId = state.railway.save().operations!.lines[0].id, before = state.railway.save();
    for (const [a, b] of [[other, destination], [origin, other]]) {
      expect(() => state.execute({ type: 'add-rail-passengers', group: { id: 'od', lineId, origin: a.stationId, destination: b.stationId, count: 5 } })).toThrow(/OD group/);
      expect(state.railway.save()).toEqual(before);
    }
    state.execute({ type: 'add-rail-passengers', group: { id: 'od', lineId, origin: origin.stationId, destination: destination.stationId, count: 5 } });
    const good = state.railway.save(), saved = state.serialize(); saved.railway!.operations!.passengers[0].destination = other.stationId;
    expect(() => state.load(saved)).toThrow(/OD group/); expect(state.railway.save()).toEqual(good);
    const loaded = new SimulationState(); loaded.load(state.serialize()); expect(loaded.railway.runtime().waitingPassengers).toBe(5);
  });
  it('reserves the itinerary while occupying only the current platform or active leg, including Save/Load', () => {
    const state = railwayFixture(); state.execute({ type: 'create-rail-frequency', input: input(state) });
    for (const [time, phase] of [[10, 'dwelling'], [30, 'running'], [40, 'running'], [57, 'dwelling'], [77, 'turnback'], [97, 'dwelling'], [117, 'running'], [144, 'dwelling']] as const) {
      advance(state, time); const train = state.railway.runtime().activeTrains[0]; expect(train.state).toBe(phase);
      const occupied = phase === 'running' ? train.leg!.route.resources.filter(id => state.railway.segments.has(id) || state.railway.junctions.has(id))
        : [train.faceId, state.railway.face(train.faceId).face.trackSegmentId];
      expect([...state.railway.blocks.values()].filter(b => b.occupancyOwner === train.formationId).map(b => b.id).sort()).toEqual(occupied.sort());
      for (const id of train.resources) expect(state.railway.blocks.get(id)!.reservationOwner).toBe(train.formationId);
      if (phase === 'dwelling') expect(train.resources.length).toBeGreaterThan(occupied.length);
      const loaded = new SimulationState(); loaded.load(state.serialize()); expect(loaded.railway.save()).toEqual(state.railway.save());
      if (phase === 'running') for (const station of loaded.railway.stations.values()) for (const platform of station.platforms) for (const face of platform.faces) {
        expect(loaded.railway.blocks.get(face.platformFaceId)!.occupancyOwner).toBeNull();
        expect(loaded.railway.blocks.get(face.platformFaceId)!.reservationOwner).toBe(train.formationId);
      }
    }
    advance(state, 200); expect(state.railway.runtime().ownedBlocks).toHaveLength(0);
  });
  it('arrives, dwells, departs and turns back using separate service IDs and one Formation', () => {
    const state = railwayFixture(); state.execute({ type: 'create-rail-frequency', input: input(state) });
    const timetable = state.railway.save().operations!;
    expect(timetable.services).toHaveLength(2); expect(timetable.operations).toHaveLength(1);
    const [outbound, inbound] = timetable.services, id = timetable.formations[0].formationId;
    advance(state, 10); expect(state.railway.runtime().activeTrains[0]).toMatchObject({ formationId: id, serviceId: outbound.id, state: 'dwelling' });
    advance(state, 30); const train = state.railway.runtime().activeTrains[0]; expect(train.state).toBe('running');
    expect(railPose(train.leg!, 30).point.x).toBeCloseTo(-300); expect(railPose(train.leg!, 43.5).point.x).toBeCloseTo(0);
    advance(state, 77); expect(state.railway.runtime().activeTrains[0].state).toBe('turnback');
    advance(state, 97); expect(state.railway.runtime().activeTrains[0]).toMatchObject({ formationId: id, serviceId: inbound.id, state: 'dwelling' });
    advance(state, 200); expect(state.railway.runtime().activeTrains).toHaveLength(0);
    expect(state.railway.runtime().serviceStates.every(s => s.status === 'completed' && s.delay === 0)).toBe(true);
    expect([...state.railway.blocks.values()].every(b => !b.occupancyOwner && !b.reservationOwner)).toBe(true);
  });
  it('waits without polling for opposing single-track reservations and eventually completes', () => {
    const state = railwayFixture(); state.execute({ type: 'set-rail-timetable', timetable: opposing(state) });
    advance(state, 10); expect(state.railway.runtime().activeTrains).toHaveLength(1); expect(state.railway.save().operations!.waits).toHaveLength(1);
    const events = state.railway.processedEvents; advance(state, 20); expect(state.railway.processedEvents).toBe(events);
    advance(state, 500); const runtime = state.railway.runtime(); expect(runtime.activeTrains).toHaveLength(0); expect(runtime.serviceStates).toHaveLength(2);
    expect(runtime.serviceStates.some(s => s.delay > 0)).toBe(true); expect(runtime.serviceStates.every(s => s.status === 'completed')).toBe(true);
  });
  it('propagates an extended dwell to subsequent calls and the return service', () => {
    const state = railwayFixture(); state.execute({ type: 'create-rail-frequency', input: input(state) }); advance(state, 10);
    state.execute({ type: 'extend-rail-dwell', formationId: state.railway.runtime().activeTrains[0].formationId, seconds: 40 });
    advance(state, 50); expect(state.railway.runtime().activeTrains[0].state).toBe('dwelling');
    advance(state, 300); const states = state.railway.runtime().serviceStates;
    expect(states.map(s => s.delay)).toEqual([40, 40]); expect(states[0].actualCalls[0].departureTime).toBe(70);
  });
  it('uses aggregate OD capacity and preserves passengers left behind', () => {
    const state = railwayFixture(); state.execute({ type: 'create-rail-frequency', input: input(state, { returnService: false }) });
    const ops = state.railway.save().operations!, line = ops.lines[0], service = ops.services[0];
    state.execute({ type: 'add-rail-passengers', group: { id: 'od', lineId: line.id, origin: service.origin, destination: service.destination, count: 200 } });
    advance(state, 200); expect(state.railway.runtime()).toMatchObject({ arrivedPassengers: 160, waitingPassengers: 40, leftBehind: 40 });
    const loaded = new SimulationState(); loaded.load(state.serialize()); expect(loaded.railway.runtime().waitingPassengers).toBe(40);
    expect(state.population.snapshot().totals.population).toBe(0);
  });
  it.each(['reverse', 'pass-origin', 'pass-destination', 'deadhead'] as const)('rejects an unserviceable %s OD on commands and detached Save Load', kind => {
    const state = railwayFixture();
    state.execute({ type: 'create-rail-frequency', input: input(state, { returnService: false,
      serviceTypeId: kind === 'deadhead' ? 'deadhead' : 'local',
      stopTypes: kind === 'pass-origin' ? ['pass', 'stop'] : kind === 'pass-destination' ? ['stop', 'pass'] : ['stop', 'stop'] }) });
    const ops = state.railway.save().operations!, service = ops.services[0];
    const group = { id: 'unserved', lineId: service.lineId, origin: kind === 'reverse' ? service.destination : service.origin,
      destination: kind === 'reverse' ? service.origin : service.destination, count: 5 }, before = state.railway.save();
    expect(() => state.execute({ type: 'add-rail-passengers', group })).toThrow(/OD group/); expect(state.railway.save()).toEqual(before);
    const saved = state.serialize(); saved.railway!.operations!.passengers.push(group);
    expect(() => state.load(saved)).toThrow(/OD group/); expect(state.railway.save()).toEqual(before);
  });
  it('keeps passengers for a later passenger service while deadhead runs on the same line', () => {
    const state = railwayFixture(); state.execute({ type: 'create-rail-frequency', input: input(state, { serviceTypeId: 'deadhead', returnService: false }) });
    const data = state.railway.save().operations!; state.execute({ type: 'clear-rail-operations' });
    const passenger = structuredClone(data.services[0]); passenger.id = 'passenger'; passenger.trainNumber = 'P1'; passenger.serviceTypeId = 'local'; passenger.passengerService = true;
    for (const call of passenger.stopCalls) { call.arrivalTime += 300; call.departureTime += 300; }
    data.services.push(passenger); data.formations.push({ ...data.formations[0], formationId: 'passenger-formation' });
    data.operations.push({ operationId: 'passenger-operation', operationNumber: 'P1', trainServiceIds: [passenger.id], assignedFormationId: 'passenger-formation' });
    state.execute({ type: 'set-rail-timetable', timetable: data });
    state.execute({ type: 'add-rail-passengers', group: { id: 'od', lineId: passenger.lineId, origin: passenger.origin, destination: passenger.destination, count: 200 } });
    advance(state, 200); expect(state.railway.runtime()).toMatchObject({ arrivedPassengers: 0, waitingPassengers: 200, leftBehind: 0 });
    const loaded = new SimulationState(); loaded.load(state.serialize()); advance(loaded, 600);
    expect(loaded.railway.runtime()).toMatchObject({ arrivedPassengers: 160, waitingPassengers: 40, leftBehind: 40 });
  });
  it('accepts reverse-direction OD when a separate return passenger service can carry it', () => {
    const state = railwayFixture(); state.execute({ type: 'create-rail-frequency', input: input(state) });
    const service = state.railway.save().operations!.services[1];
    state.execute({ type: 'add-rail-passengers', group: { id: 'return-od', lineId: service.lineId, origin: service.origin, destination: service.destination, count: 5 } });
    const loaded = new SimulationState(); loaded.load(state.serialize()); advance(loaded, 200);
    expect(loaded.railway.runtime()).toMatchObject({ arrivedPassengers: 5, waitingPassengers: 0, leftBehind: 0 });
  });
  it('creates individual frequency services with stable operation assignments and following waits', () => {
    const state = railwayFixture(); state.execute({ type: 'create-rail-frequency', input: input(state, { end: 91, frequency: 30 }) });
    const ops = state.railway.save().operations!; expect(ops.services).toHaveLength(6); expect(ops.formations).toHaveLength(3);
    expect(new Set(ops.operations.flatMap(o => o.trainServiceIds)).size).toBe(6);
    advance(state, 1000); expect(state.railway.runtime().serviceStates).toHaveLength(6); expect(state.railway.runtime().activeTrains).toHaveLength(0);
  });
  it('passes intermediate stations without dwell and respects Formation/platform compatibility', () => {
    const state = railwayFixture(), middle = [...state.railway.segments.values()].find(t => t.points[0].x === -160 && t.points.at(-1)!.x === 160)!;
    state.execute({ type: 'place-station', trackSegmentId: middle.id, offset: 160, length: 40, template: 'single', name: 'Center' });
    const [west, east, center] = [...state.railway.stations.values()], face = (s: typeof west) => s.platforms[0].faces[0].platformFaceId;
    const spec = input(state, { faceIds: [face(west), face(center), face(east)], stopTypes: ['stop', 'pass', 'stop'] });
    state.execute({ type: 'create-rail-frequency', input: { ...spec, formationTypeId: 'commuter-6' } }); advance(state, 500);
    const pass = state.railway.runtime().serviceStates[0].actualCalls[1]; expect(pass.passTime).toBe(pass.arrivalTime); expect(pass.departureTime).toBe(pass.arrivalTime);
    state.execute({ type: 'clear-rail-operations' }); state.clock.restore({ gameSeconds: 0, speed: 1 }); state.railway.setClock(0);
    expect(() => state.execute({ type: 'create-rail-frequency', input: { ...spec, formationTypeId: 'commuter-6', stopTypes: ['stop', 'stop', 'stop'] } })).toThrow(/length/);
  });
  it.each(['origin', 'destination'] as const)('checks formation length at a pass-only %s face on commands and Load', endpoint => {
    const state = railwayFixture(), middle = [...state.railway.segments.values()].find(t => t.points[0].x === -160 && t.points.at(-1)!.x === 160)!;
    state.execute({ type: 'place-station', trackSegmentId: middle.id, offset: 160, length: 40, template: 'single', name: 'Short' });
    const [west, east, short] = [...state.railway.stations.values()], face = (s: typeof west) => s.platforms[0].faces[0].platformFaceId;
    const spec = input(state, { faceIds: endpoint === 'origin' ? [face(short), face(east)] : [face(west), face(short)],
      stopTypes: ['pass', 'pass'], returnService: false }), before = state.railway.save();
    expect(() => state.execute({ type: 'create-rail-frequency', input: { ...spec, formationTypeId: 'commuter-6' } })).toThrow(/length/);
    expect(state.railway.save()).toEqual(before);
    state.execute({ type: 'create-rail-frequency', input: spec }); const good = state.railway.save(), saved = state.serialize();
    saved.railway!.operations!.formations[0].formationTypeId = 'commuter-6';
    expect(() => state.load(saved)).toThrow(/length/); expect(state.railway.save()).toEqual(good);
    const loaded = new SimulationState(); loaded.load(state.serialize()); advance(loaded, 200);
    expect(loaded.railway.runtime().activeTrains).toHaveLength(0); expect(loaded.railway.runtime().serviceStates[0].status).toBe('completed');
  });
  it('rejects duplicated Formation assignments and invalid pass times', () => {
    const state = railwayFixture(), data = opposing(state), duplicate = structuredClone(data);
    duplicate.operations[1].assignedFormationId = duplicate.operations[0].assignedFormationId;
    expect(() => state.execute({ type: 'set-rail-timetable', timetable: duplicate })).toThrow(/unique Formation/);
    data.services[0].stopCalls[0].stopType = 'pass';
    expect(() => state.execute({ type: 'set-rail-timetable', timetable: data })).toThrow(/StopCall/);
  });
  it('rejects unassigned formations and preserves a loadable city/depot', () => {
    const state = railwayFixture(), data = opposing(state), before = state.railway.save();
    data.services = []; data.operations = [];
    expect(() => state.execute({ type: 'set-rail-timetable', timetable: data })).toThrow(/Every Formation/);
    expect(state.railway.save()).toEqual(before);
    state.execute({ type: 'remove-railway', kind: 'depot', id: [...state.railway.depots.keys()][0] });
    const loaded = new SimulationState(); loaded.load(state.serialize()); expect(loaded.railway.depots.size).toBe(0);
  });
  it('protects station references even for a line-only advanced timetable', () => {
    const state = railwayFixture(), data = opposing(state); data.services = []; data.formations = []; data.operations = [];
    state.execute({ type: 'set-rail-timetable', timetable: data });
    expect(() => state.execute({ type: 'remove-railway', kind: 'station', id: data.lines[0].stationIds[0] })).toThrow(/clear/);
    const loaded = new SimulationState(); loaded.load(state.serialize()); expect(loaded.railway.hasOperations).toBe(true);
    state.execute({ type: 'clear-rail-operations' }); state.execute({ type: 'remove-railway', kind: 'station', id: data.lines[0].stationIds[0] });
  });
  it('records late arrival caused by physical travel time rather than teleporting', () => {
    const state = railwayFixture(), data = opposing(state); data.services.splice(1); data.formations.splice(1); data.operations.splice(1);
    data.services[0].stopCalls[1].arrivalTime = 31; data.services[0].stopCalls[1].departureTime = 51;
    state.execute({ type: 'set-rail-timetable', timetable: data }); advance(state, 100);
    expect(state.railway.runtime().serviceStates[0]).toMatchObject({ delay: 26, actualCalls: [{ sequence: 0, arrivalTime: 10, departureTime: 30 }, { sequence: 1, arrivalTime: 57, departureTime: 77 }] });
  });
  it.each([10, 40, 80, 100])('resumes deterministically from second %s including blocks and event queue', seconds => {
    const state = railwayFixture(); state.execute({ type: 'set-rail-timetable', timetable: opposing(state) }); advance(state, seconds);
    const loaded = new SimulationState(); loaded.load(JSON.parse(JSON.stringify(state.serialize())));
    expect(loaded.railway.save()).toEqual(state.railway.save());
    advance(state, 500); advance(loaded, 500); expect(loaded.railway.save()).toEqual(state.railway.save());
  });
  it('resumes canonically when a coarse tick exhausts the due-event budget', () => {
    const state = railwayFixture(), depot = [...state.railway.depots.values()][0];
    state.execute({ type: 'remove-railway', kind: 'depot', id: depot.id });
    state.execute({ type: 'place-depot', name: 'Budget depot', trackSegmentId: depot.connectedTrackId, capacity: 512 });
    state.execute({ type: 'create-rail-frequency', input: input(state, { start: 30, end: 181, frequency: 1 }) }); advance(state, 10000);
    expect(state.railway.processedEvents).toBe(1000);
    expect(state.railway.save().operations!.events.some(e => e.at < state.clock.gameSeconds)).toBe(true);
    const loaded = new SimulationState(); loaded.load(state.serialize());
    for (let i = 0; i < 30; i++) { state.tick(.1); loaded.tick(.1); }
    expect(loaded.railway.save()).toEqual(state.railway.save());
  });
  it('freezes infrastructure during operation without losing the Undo entry or rewinding time', () => {
    const state = railwayFixture(); state.execute({ type: 'create-rail-frequency', input: input(state) }); advance(state, 40);
    expect(() => state.undo()).toThrow(/clear/); expect(state.railway.depots.size).toBe(1);
    state.execute({ type: 'clear-rail-operations' }); state.undo(); expect(state.railway.depots.size).toBe(0);
    const loaded = new SimulationState(); loaded.load(state.serialize()); expect(loaded.clock.gameSeconds).toBe(40);
  });
  it('rejects malformed definitions and corrupt saved routes atomically', () => {
    const state = railwayFixture(); const data = opposing(state), before = state.serialize();
    const bad = structuredClone(data); bad.services[0].stopCalls[0].departureTime = -1;
    expect(() => state.execute({ type: 'set-rail-timetable', timetable: bad })).toThrow(); expect(state.railway.save()).toEqual(before.railway);
    bad.services = structuredClone(data.services); bad.formations[0].formationTypeId = 'narrow-2';
    expect(() => state.execute({ type: 'set-rail-timetable', timetable: bad })).toThrow(/gauge/);
    state.execute({ type: 'set-rail-timetable', timetable: data }); advance(state, 40);
    const corrupt = state.serialize(); corrupt.railway!.operations!.activeTrains[0].leg!.route.length++;
    const live = state.railway.save(); expect(() => state.load(corrupt)).toThrow(/route/); expect(state.railway.save()).toEqual(live);
  });
  it.each([0, 1, 2, 4, 8] as const)('uses GameClock speed %s for movement, with no work while paused', speed => {
    const state = railwayFixture(); state.execute({ type: 'create-rail-frequency', input: input(state) }); advance(state, 30);
    state.setSpeed(speed); const before = state.railway.processedEvents; state.tick(1);
    expect(state.clock.gameSeconds).toBe(30 + 10 * speed); if (!speed) expect(state.railway.processedEvents).toBe(before);
  });
});
