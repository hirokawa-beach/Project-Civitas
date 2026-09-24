import { describe, expect, it } from 'vitest';
import { RoadGraph } from '../src/roads/roadGraph';
import { SimulationState } from '../src/simulation/state';
import { TrafficSystem } from '../src/traffic/system';
import { PopulationSystem } from '../src/population/system';
import type { Lot } from '../src/lots/types';
import { DEFAULT_TRANSIT_CONFIG, TransitSystem, TRANSIT_VEHICLE_TYPES } from '../src/transit/system';
import type { TransitLineInput } from '../src/transit/types';
import type { SegmentTraffic, TripEndpoint } from '../src/traffic/types';
import type { RoadSegmentId } from '../src/shared/ids';

const road = () => {
  const graph = new RoadGraph();
  graph.buildRoad({ geometry: { kind: 'straight', points: [{ x: -120, z: 0 }, { x: 120, z: 0 }] }, roadTypeId: 'small' });
  return graph;
};
const input = (stopIds: string[], frequencySeconds = 60): TransitLineInput => ({ name: 'Crosstown', stopIds,
  serviceStartSeconds: 0, serviceEndSeconds: 86_400, frequencySeconds, vehicleTypeId: 'standard', color: '#eac65e' });
const traffic = (segmentId: RoadSegmentId, speed: number): SegmentTraffic[] => [{ segmentId, currentVolume: 0,
  capacity: 20, averageSpeed: speed, congestionRatio: speed < 40 ? 2 : 0, lanes: [] }];
const setup = () => {
  const graph = road(); const transit = new TransitSystem(graph.snapshot());
  const a = transit.placeStop({ x: -60, z: 12 });
  const b = transit.placeStop({ x: 60, z: 12 });
  const line = transit.createLine(input([a.id, b.id]), 0);
  const segmentId = graph.snapshot().segments[0].id;
  const origin: TripEndpoint = { kind: 'building', id: 'home', roadSegmentId: segmentId, position: { x: -60, z: 20 } };
  const destination: TripEndpoint = { kind: 'building', id: 'work', roadSegmentId: segmentId, position: { x: 60, z: 20 } };
  return { graph, transit, a, b, line, segmentId, origin, destination };
};

describe('bus transit foundation', () => {
  it('anchors stops to a road lane and keeps the ordered line separate from its physical route', () => {
    const { transit, a, b, line } = setup();
    expect(a.roadSegmentId).toBe(b.roadSegmentId);
    expect(a.laneId).toBeTruthy();
    expect(a.direction).toBe('forward');
    expect(a.position.z).toBeGreaterThan(8);
    expect(line.stopIds).toEqual([a.id, b.id]);
    expect(transit.routes[0]).toMatchObject({ id: line.routeId, lineId: line.id, stopOffsetsMeters: [0, 120] });
    expect(transit.snapshot().graph.edges).toHaveLength(1);
    expect(() => transit.placeStop({ x: 500, z: 500 })).toThrow(/road/);
  });

  it('generates departures from frequency and advances buses on the road', () => {
    const { transit, segmentId } = setup();
    expect(transit.tick(4, traffic(segmentId, 40))).toBe(false);
    transit.tick(5, traffic(segmentId, 40));
    expect(transit.snapshot().activeVehicles).toBe(1);
    transit.tick(10, traffic(segmentId, 40));
    expect(transit.vehicles[0].progressMeters).toBeGreaterThan(0);
    transit.tick(60, traffic(segmentId, 40));
    expect(transit.vehicles.some((vehicle) => vehicle.departedAtGameSeconds === 60)).toBe(true);
  });

  it('boards and alights aggregate passenger groups, leaving excess demand behind', () => {
    const { transit, a, b, segmentId, origin, destination } = setup();
    expect(transit.offerTrip(origin, destination, 55, 10_000, 0, traffic(segmentId, 40))).toBe(true);
    expect(transit.snapshot().waitingPassengers).toBe(55);
    transit.tick(5, traffic(segmentId, 40));
    expect(transit.vehicles[0].onboard).toEqual([{ destinationStopId: b.id, count: TRANSIT_VEHICLE_TYPES.standard.capacity }]);
    expect(transit.snapshot().stopMetrics.find((item) => item.stopId === a.id)).toMatchObject({ waiting: 15, boarded: 40 });
    transit.tick(120, traffic(segmentId, 40));
    expect(transit.snapshot().stopMetrics.find((item) => item.stopId === b.id)!.alighted).toBeGreaterThanOrEqual(40);
    expect(transit.snapshot().ridership).toBeGreaterThanOrEqual(40);
  });

  it('compares bus generalized cost against car and caches topology rather than individual passengers', () => {
    const { transit, segmentId, origin, destination } = setup();
    expect(transit.offerTrip(origin, destination, 4, 1, 0, traffic(segmentId, 40))).toBe(false);
    expect(transit.offerTrip(origin, destination, 4, 10_000, 0, traffic(segmentId, 40))).toBe(true);
    expect(transit.routeCacheSize).toBe(1);
    expect(transit.waitingGroups).toHaveLength(1);
    expect(transit.waitingGroups[0].count).toBe(4);
  });

  it('supports one shared-stop transfer and applies its penalty to mode choice', () => {
    const graph = road(); const segmentId = graph.snapshot().segments[0].id;
    const make = (penalty: number) => {
      const transit = new TransitSystem(graph.snapshot(), { ...DEFAULT_TRANSIT_CONFIG,
        stopAccessDistanceMeters: 40, transferPenaltyGameSeconds: penalty });
      const first = transit.placeStop({ x: -80, z: 12 });
      const transfer = transit.placeStop({ x: 0, z: 12 });
      const last = transit.placeStop({ x: 80, z: 12 });
      const a = transit.createLine(input([first.id, transfer.id]), 0);
      const b = transit.createLine(input([transfer.id, last.id]), 0);
      const origin: TripEndpoint = { kind: 'building', id: 'home', roadSegmentId: segmentId, position: { x: -80, z: 20 } };
      const destination: TripEndpoint = { kind: 'building', id: 'work', roadSegmentId: segmentId, position: { x: 80, z: 20 } };
      return { transit, transfer, a, b, origin, destination };
    };
    const cheap = make(60);
    expect(cheap.transit.snapshot().graph.transferStopIds).toEqual([cheap.transfer.id]);
    expect(cheap.transit.offerTrip(cheap.origin, cheap.destination, 6, 900, 0, traffic(segmentId, 40))).toBe(true);
    expect(cheap.transit.waitingGroups[0]).toMatchObject({ lineId: cheap.a.id, destinationStopId: cheap.transfer.id,
      transferLineId: cheap.b.id, count: 6 });
    cheap.transit.tick(5, traffic(segmentId, 40));
    cheap.transit.tick(80, traffic(segmentId, 40));
    expect(cheap.transit.waitingGroups.some((group) => group.lineId === cheap.b.id && group.originStopId === cheap.transfer.id)).toBe(true);
    cheap.transit.tick(120, traffic(segmentId, 40));
    expect(cheap.transit.vehicles.some((vehicle) => vehicle.lineId === cheap.b.id && vehicle.onboard.some((item) => item.count === 6))).toBe(true);
    const costly = make(2000);
    expect(costly.transit.offerTrip(costly.origin, costly.destination, 6, 900, 0, traffic(segmentId, 40))).toBe(false);
  });

  it('takes eligible home-to-work trip demand from car generation into aggregated bus queues', () => {
    const { graph, transit, segmentId } = setup();
    const makeLot = (id: string, x: number, zoneType: Lot['zoneType']): Lot => ({
      id: `lot-${id}`, zoneType, zoneCellIds: [],
      roadAccess: { roadSegmentId: segmentId, frontage: [{ x, z: 8 }, { x: x + 8, z: 8 }] },
      widthCells: 1, depthCells: 1, width: 8, depth: 8, position: { x, z: 20 }, rotation: 0,
      corners: [{ x, z: 12 }, { x: x + 8, z: 12 }, { x: x + 8, z: 20 }, { x, z: 20 }],
      averageElevation: 0, minElevation: 0, maxElevation: 0, baseElevation: 0, slope: 0,
      buildable: true, buildingId: `building-${id}`,
    });
    const home = makeLot('home', -60, 'residential');
    const work = makeLot('work', 60, 'commercial');
    const population = new PopulationSystem().snapshot();
    population.totals.employed = 4;
    population.occupancies = [
      { buildingId: home.buildingId!, zoneType: 'residential', active: true,
        householdCapacity: 8, populationCapacity: 32, currentHouseholds: 4, currentPopulation: 10,
        totalJobs: 0, filledJobs: 0, availableJobs: 0, commercialCapacity: 0 },
      { buildingId: work.buildingId!, zoneType: 'commercial', active: true,
        householdCapacity: 0, populationCapacity: 0, currentHouseholds: 0, currentPopulation: 0,
        totalJobs: 8, filledJobs: 4, availableJobs: 4, commercialCapacity: 8 },
    ];
    const trafficSystem = new TrafficSystem(graph.snapshot());
    trafficSystem.setTransitSystem(transit);
    trafficSystem.tick(30, population, [home, work]);
    expect(transit.snapshot().waitingPassengers).toBeGreaterThan(0);
    expect(trafficSystem.trips.every((trip) => trip.origin.id !== home.buildingId || trip.destination.id !== work.buildingId)).toBe(true);
  });

  it('reduces bus progress when road traffic is congested', () => {
    const fast = setup(); const slow = setup();
    fast.transit.tick(5, traffic(fast.segmentId, 40));
    slow.transit.tick(5, traffic(slow.segmentId, 10));
    fast.transit.tick(20, traffic(fast.segmentId, 40));
    slow.transit.tick(20, traffic(slow.segmentId, 10));
    expect(slow.transit.vehicles[0].progressMeters).toBeLessThan(fast.transit.vehicles[0].progressMeters);
  });

  it('reassociates stops after a road split and cleans stops, lines and passengers after demolition', () => {
    const { graph, transit, a, origin, destination, segmentId } = setup();
    transit.offerTrip(origin, destination, 4, 10_000, 0, traffic(segmentId, 40));
    graph.buildRoad({ geometry: { kind: 'straight', points: [{ x: 0, z: -60 }, { x: 0, z: 60 }] }, roadTypeId: 'small' });
    transit.updateGraph(graph.snapshot(), 0);
    expect(transit.stops.find((stop) => stop.id === a.id)).toBeDefined();
    expect(transit.routes).toHaveLength(1);
    transit.updateGraph(new RoadGraph().snapshot(), 0);
    expect(transit.snapshot()).toMatchObject({ stops: [], lines: [], routes: [], waitingPassengers: 0, activeVehicles: 0 });
  });

  it('round-trips active operations and migrates v9 saves to empty transit', () => {
    const { graph, transit, segmentId, origin, destination } = setup();
    transit.offerTrip(origin, destination, 4, 10_000, 0, traffic(segmentId, 40));
    transit.tick(5, traffic(segmentId, 40));
    const restored = new TransitSystem(graph.snapshot());
    restored.restore(JSON.parse(JSON.stringify(transit.save())), 5);
    expect(restored.save()).toEqual(transit.save());
    const state = new SimulationState();
    state.execute({ type: 'build-road', input: { geometry: { kind: 'straight', points: [{ x: -120, z: 0 }, { x: 120, z: 0 }] }, roadTypeId: 'small' } });
    const stop1 = state.execute({ type: 'place-bus-stop', position: { x: -60, z: 12 } });
    const stop2 = state.execute({ type: 'place-bus-stop', position: { x: 60, z: 12 } });
    if (stop1.type !== 'place-bus-stop' || stop2.type !== 'place-bus-stop') throw new Error('Unexpected stop result');
    state.execute({ type: 'create-bus-line', input: input([stop1.stop.id, stop2.stop.id]) });
    const save = state.serialize();
    expect(save.saveVersion).toBe(11);
    const loaded = new SimulationState(); loaded.load(JSON.parse(JSON.stringify(save)));
    expect(loaded.transit.save()).toEqual(state.transit.save());
    const legacy = { ...save, saveVersion: 9 as const, transit: undefined };
    const migrated = new SimulationState(); migrated.load(legacy);
    expect(migrated.transit.stops).toEqual([]);
  });

  it('keeps 100,000 passengers in a single OD group instead of per-person entities', () => {
    const { transit, segmentId, origin, destination } = setup();
    const started = performance.now();
    expect(transit.offerTrip(origin, destination, 100_000, 10_000, 0, traffic(segmentId, 40))).toBe(true);
    transit.tick(5, traffic(segmentId, 40));
    expect(transit.waitingGroups).toHaveLength(1);
    expect(transit.snapshot().waitingPassengers).toBe(99_960);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
