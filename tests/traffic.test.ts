import { describe, expect, it } from 'vitest';
import { RoadGraph } from '../src/roads/roadGraph';
import type { Lot } from '../src/lots/types';
import { PopulationSystem } from '../src/population/system';
import { SimulationState } from '../src/simulation/state';
import { RoadRouter } from '../src/traffic/routing';
import { DEFAULT_TRAFFIC_CONFIG, TrafficSystem } from '../src/traffic/system';
import type { TripEndpoint } from '../src/traffic/types';
import { selectVisibleVehicles } from '../src/traffic/visibleVehicles';

const line = (a: number, b: number, z = 0) => ({
  geometry: { kind: 'straight' as const, points: [{ x: a, z }, { x: b, z }] }, roadTypeId: 'small',
});
const road = () => {
  const graph = new RoadGraph();
  graph.buildRoad(line(-100, 100));
  return graph;
};
const lot = (id: string, segmentId: Lot['roadAccess']['roadSegmentId'], x: number): Lot => ({
  id: `lot-${id}`, zoneType: 'residential', zoneCellIds: [],
  roadAccess: { roadSegmentId: segmentId, frontage: [{ x, z: 3 }, { x: x + 8, z: 3 }] },
  widthCells: 1, depthCells: 1, width: 8, depth: 8, position: { x, z: 10 }, rotation: 0,
  corners: [{ x, z: 4 }, { x: x + 8, z: 4 }, { x: x + 8, z: 12 }, { x, z: 12 }],
  averageElevation: 0, minElevation: 0, maxElevation: 0, baseElevation: 0, slope: 0,
  buildable: true, buildingId: `building-${id}`,
});
const populated = (homes: readonly Lot[], jobs: readonly Lot[]) => {
  const snapshot = new PopulationSystem().snapshot();
  snapshot.totals.employed = homes.length * 4;
  snapshot.totals.population = homes.length * 10;
  snapshot.occupancies = [
    ...homes.map((item) => ({ buildingId: item.buildingId!, zoneType: 'residential' as const, active: true,
      householdCapacity: 8, populationCapacity: 32, currentHouseholds: 4, currentPopulation: 10,
      totalJobs: 0, filledJobs: 0, availableJobs: 0, commercialCapacity: 0 })),
    ...jobs.map((item) => ({ buildingId: item.buildingId!, zoneType: 'commercial' as const, active: true,
      householdCapacity: 0, populationCapacity: 0, currentHouseholds: 0, currentPopulation: 0,
      totalJobs: 8, filledJobs: 4, availableJobs: 4, commercialCapacity: 8 })),
  ];
  return snapshot;
};

describe('road traffic', () => {
  it('routes directed trips and invalidates its route cache on graph changes', () => {
    const graph = road();
    const router = new RoadRouter(DEFAULT_TRAFFIC_CONFIG);
    router.updateGraph(graph.snapshot());
    const segmentId = graph.snapshot().segments[0].id;
    const origin: TripEndpoint = { kind: 'building', id: 'a', roadSegmentId: segmentId, position: { x: -70, z: 10 } };
    const destination: TripEndpoint = { kind: 'building', id: 'b', roadSegmentId: segmentId, position: { x: 70, z: 10 } };
    expect(router.route(origin, destination, new Map())?.map((leg) => leg.direction)).toEqual(['forward']);
    expect(router.cacheSize).toBe(1);
    const graph2 = new RoadGraph();
    expect(router.updateGraph(graph2.snapshot()).size).toBe(1);
    expect(router.lastInvalidated).toBe(1);
    expect(router.route(origin, destination, new Map())).toBeNull();
  });

  it('generates home/work/shop round trips as aggregate logical vehicles and advances by GameClock', () => {
    const graph = road();
    const id = graph.snapshot().segments[0].id;
    const home = lot('home', id, -70);
    const shop = lot('shop', id, 70);
    const system = new TrafficSystem(graph.snapshot());
    expect(system.tick(4, populated([home], [shop]), [home, shop])).toBe(false);
    expect(system.tick(30, populated([home], [shop]), [home, shop])).toBe(true);
    expect(new Set(system.trips.map((trip) => trip.purpose))).toEqual(new Set([
      'home-work', 'work-home', 'home-commercial', 'commercial-home',
    ]));
    expect(system.snapshot().logicalVehicles).toBe(8);
    expect(system.segmentStates[0].currentVolume).toBe(8);
    expect(system.segmentStates[0].lanes.reduce((sum, lane) => sum + lane.currentVolume, 0)).toBe(8);
    const initial = system.trips[0].progressMeters;
    system.tick(35, populated([home], [shop]), [home, shop]);
    expect(system.trips[0].progressMeters).toBeGreaterThan(initial);
  });

  it('derives outside connections from boundary nodes and creates outside-to-city trips', () => {
    const graph = new RoadGraph();
    graph.buildRoad(line(-512, -100));
    const id = graph.snapshot().segments[0].id;
    const home = lot('home', id, -200);
    const system = new TrafficSystem(graph.snapshot());
    expect(system.outside).toHaveLength(1);
    system.tick(30, populated([home], []), [home]);
    expect(system.trips.map((trip) => trip.purpose)).toEqual(['outside-city', 'city-outside']);
    expect(system.trips.every((trip) => trip.routeState === 'routed')).toBe(true);
  });

  it('reduces segment and lane speed under volume and clears trips after road deletion', () => {
    const graph = road();
    const id = graph.snapshot().segments[0].id;
    const homes = Array.from({ length: 16 }, (_, i) => lot(`home-${i}`, id, -70 + i));
    const shop = lot('shop', id, 70);
    const system = new TrafficSystem(graph.snapshot());
    system.tick(30, populated(homes, [shop]), [...homes, shop]);
    expect(system.segmentStates[0].congestionRatio).toBeGreaterThan(1);
    expect(system.segmentStates[0].averageSpeed).toBeLessThan(graph.snapshot().segments[0].speedLimit);
    expect(system.segmentStates[0].lanes.some((lane) => lane.averageSpeed < graph.snapshot().segments[0].speedLimit)).toBe(true);
    system.updateGraph(new RoadGraph().snapshot());
    system.reconcileLots([]);
    expect(system.snapshot().activeTrips).toBe(0);
  });

  it('reroutes active trips after an intersection splits the same road', () => {
    const graph = road();
    const oldId = graph.snapshot().segments[0].id;
    const home = lot('home', oldId, -70);
    const shop = lot('shop', oldId, 70);
    shop.zoneType = 'commercial';
    const system = new TrafficSystem(graph.snapshot());
    system.tick(30, populated([home], [shop]), [home, shop]);
    graph.buildRoad({ geometry: { kind: 'straight', points: [{ x: 0, z: -70 }, { x: 0, z: 70 }] }, roadTypeId: 'small' });
    const segments = graph.snapshot().segments;
    home.roadAccess.roadSegmentId = segments.find((segment) => segment.geometry.points.some((point) => point.x < -50))!.id;
    shop.roadAccess.roadSegmentId = segments.find((segment) => segment.geometry.points.some((point) => point.x > 50))!.id;
    system.updateGraph(graph.snapshot());
    system.reconcileLots([home, shop]);
    expect(system.trips.every((trip) => trip.routeState === 'routed')).toBe(true);
    expect(system.trips[0].route.length).toBeGreaterThan(1);
    expect(system.segmentStates.filter((segment) => segment.currentVolume > 0)).toHaveLength(2);
  });

  it('does not route against the only permitted one-way lane', () => {
    const graph = road().snapshot();
    graph.lanes = graph.lanes.filter((lane) => lane.direction === 'forward');
    const router = new RoadRouter(DEFAULT_TRAFFIC_CONFIG);
    router.updateGraph(graph);
    const roadSegmentId = graph.segments[0].id;
    const left: TripEndpoint = { kind: 'building', id: 'left', roadSegmentId, position: { x: -60, z: 4 } };
    const right: TripEndpoint = { kind: 'building', id: 'right', roadSegmentId, position: { x: 60, z: 4 } };
    expect(router.route(left, right, new Map())).not.toBeNull();
    expect(router.route(right, left, new Map())).toBeNull();
  });

  it('drops obsolete trips when a zoned building changes use or is removed', () => {
    const graph = road();
    const id = graph.snapshot().segments[0].id;
    const home = lot('home', id, -70);
    const shop = lot('shop', id, 70);
    shop.zoneType = 'commercial';
    const system = new TrafficSystem(graph.snapshot());
    system.tick(30, populated([home], [shop]), [home, shop]);
    expect(system.snapshot().activeTrips).toBe(4);
    shop.zoneType = 'industrial';
    system.reconcileLots([home, shop]);
    expect(system.trips.map((trip) => trip.purpose)).toEqual(['home-work', 'work-home']);
    system.reconcileLots([shop]);
    expect(system.snapshot().activeTrips).toBe(0);
  });

  it('keeps only camera-near vehicle meshes up to the configured cap', () => {
    const graph = road();
    const id = graph.snapshot().segments[0].id;
    const candidates = Array.from({ length: 100 }, (_, i) => ({ tripId: `trip-${i}`, segmentId: id,
      direction: 'forward' as const, along: i * 2 }));
    expect(selectVisibleVehicles(candidates, graph.snapshot().segments, { x: 0, z: 0 }, 220, 40)).toHaveLength(40);
    expect(selectVisibleVehicles(candidates, graph.snapshot().segments, { x: 500, z: 0 }, 20, 40)).toHaveLength(0);
  });

  it('round-trips active traffic and migrates an older save without losing roads', () => {
    const state = new SimulationState();
    state.execute({ type: 'build-road', input: line(-100, 100) });
    const id = state.snapshot().roadGraph.segments[0].id;
    const home = lot('home', id, -70);
    const shop = lot('shop', id, 70);
    state.traffic.tick(30, populated([home], [shop]), [home, shop]);
    const save = state.serialize();
    expect(save.saveVersion).toBe(9);
    expect(save.traffic.trips).toHaveLength(4);
    const restored = new TrafficSystem(state.graph.snapshot());
    restored.restore(save.traffic, 30);
    expect(restored.save()).toEqual(save.traffic);
    const older = { ...save, saveVersion: 7 as const, traffic: undefined };
    const migrated = new SimulationState();
    migrated.load(older);
    expect(migrated.snapshot().roadGraph.segments).toHaveLength(1);
    expect(migrated.traffic.trips).toHaveLength(0);
  });

  it.each([1_000, 10_000, 50_000, 100_000])('ticks %i-person equivalent without per-citizen iteration', (people) => {
    const graph = road();
    const id = graph.snapshot().segments[0].id;
    const buildingCount = Math.ceil(people / 100);
    const homes = Array.from({ length: buildingCount }, (_, i) => lot(`home-${i}`, id, -70 + i % 50));
    const shop = lot('shop', id, 70);
    const population = populated(homes, [shop]);
    population.totals.population = people;
    const system = new TrafficSystem(graph.snapshot());
    const started = performance.now();
    system.tick(30, population, [...homes, shop]);
    const elapsed = performance.now() - started;
    console.log(`${people.toLocaleString()} population equivalent traffic tick: ${elapsed.toFixed(2)} ms; ${system.snapshot().activeTrips} trip batches`);
    expect(system.snapshot().activeTrips).toBeLessThanOrEqual(DEFAULT_TRAFFIC_CONFIG.maxActiveTrips);
    expect(elapsed).toBeLessThan(500);
  });
});
