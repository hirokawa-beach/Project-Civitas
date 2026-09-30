import { describe, expect, it } from 'vitest';
import { CitizenSystem } from '../src/citizens/system';
import { citizenName } from '../src/citizens/identity';
import { pedestrianPose } from '../src/citizens/routing';
import { RoadGraph } from '../src/roads/roadGraph';
import type { Lot } from '../src/lots/types';
import type { Household } from '../src/population/types';
import { PopulationSystem } from '../src/population/system';
import { TrafficSystem } from '../src/traffic/system';
import { TransitSystem } from '../src/transit/system';

function city(size = 16) {
  const graph = new RoadGraph();
  graph.buildRoad({ geometry: { kind: 'straight', points: [{ x: -200, z: 0 }, { x: 200, z: 0 }] }, roadTypeId: 'small' });
  const roads = graph.snapshot();
  const lot = (id: string, x: number, zoneType: Lot['zoneType']): Lot => ({
    id: `lot-${id}`, zoneType, zoneCellIds: [],
    roadAccess: { roadSegmentId: roads.segments[0].id, frontage: [{ x, z: 6 }, { x: x + 8, z: 6 }] },
    widthCells: 1, depthCells: 1, width: 8, depth: 8, position: { x: x + 4, z: 10 }, rotation: 0,
    corners: [{ x, z: 6 }, { x: x + 8, z: 6 }, { x: x + 8, z: 14 }, { x, z: 14 }],
    averageElevation: 0, minElevation: 0, maxElevation: 0, baseElevation: 0, slope: 0, buildable: true, buildingId: `building-${id}`,
  });
  const lots = [lot('home', -140, 'residential'), lot('shop-a', 70, 'commercial'), lot('shop-b', 150, 'commercial')];
  const households: Household[] = Array.from({ length: size }, (_, i) => ({ id: `household-${i + 1}`,
    homeBuildingId: 'building-home', householdSize: 4, employedCount: 2, unemployedCount: 0, state: 'Housed' }));
  const population = new PopulationSystem().snapshot();
  population.totals.population = size * 4;
  population.occupancies = lots.map((item, i) => ({ buildingId: item.buildingId!, zoneType: item.zoneType, active: true,
    householdCapacity: i === 0 ? size : 0, populationCapacity: i === 0 ? size * 4 : 0,
    currentHouseholds: i === 0 ? size : 0, currentPopulation: i === 0 ? size * 4 : 0,
    totalJobs: i > 0 ? size : 0, filledJobs: i > 0 ? size : 0, availableJobs: 0, commercialCapacity: i > 0 ? size : 0 }));
  const sync = (system: CitizenSystem, now = 0) => system.sync(households, population.occupancies, lots, roads, [], now);
  const ready = (system: CitizenSystem, now: number) => {
    const saved = system.save(); for (const person of saved.residents) person.nextDepartureAt = now;
    system.restore(saved); sync(system, now);
  };
  return { roads, lots, households, population, sync, ready };
}

describe('individual citizen journeys', () => {
  it('has one persistent name and identity per household member, and distinct assigned workplaces', () => {
    const fixture = city(); const system = new CitizenSystem(); fixture.sync(system);
    const residents = system.save().residents;
    expect(residents).toHaveLength(fixture.population.totals.population);
    expect(new Set(residents.map((person) => person.id)).size).toBe(residents.length);
    expect(new Set(residents.map((person) => person.name)).size).toBeGreaterThan(20);
    expect(residents.filter((person) => person.workBuildingId)).toHaveLength(32);
    expect(new Set(residents.map((person) => person.workBuildingId))).toEqual(new Set([undefined, 'building-shop-a', 'building-shop-b']));
    fixture.sync(system, 100);
    expect(system.save().residents).toEqual(residents);
    expect(citizenName('household-1', 'citizen-1-0')).toBe(residents[0].name);
  });

  it('walks a real route to an individual destination, dwells and then returns home', () => {
    const fixture = city(); const system = new CitizenSystem(); fixture.sync(system); fixture.ready(system, 8 * 3600);
    system.tick(8 * 3600, () => null, () => false);
    const walkers = system.nearby({ x: 0, z: 0 }, 500, 3000, 8 * 3600);
    expect(walkers).toHaveLength(64);
    expect(new Set(walkers.map((person) => person.destination.id)).size).toBeGreaterThan(2);
    const person = system.get('citizen-1-0')!; const journey = person.journey!;
    expect(journey.destination.id).toBe(person.workBuildingId);
    const arrival = journey.departedAt + journey.length / journey.speed;
    const pose = pedestrianPose(journey.route, journey.length, journey.speed, journey.departedAt, arrival);
    expect(pose.position.x).toBeCloseTo(journey.destination.position.x);
    expect(pose.position.z).toBeCloseTo(journey.destination.position.z);
    system.tick(arrival + .01, () => null, () => false);
    const arrived = system.get(person.id)!;
    expect(arrived.journey).toBeUndefined(); expect(arrived.location.id).toBe(person.workBuildingId);
    system.tick(arrived.nextDepartureAt, () => null, () => false);
    expect(system.get(person.id)?.journey?.destination.id).toBe(person.homeBuildingId);
    expect(system.get(person.id)?.journey?.activity).toBe('returning-home');
  });

  it('changes travel activity with time of day and population, without inventing visual residents', () => {
    const fixture = city(); const morning = new CitizenSystem(); const night = new CitizenSystem();
    fixture.sync(morning); fixture.sync(night); fixture.ready(morning, 8 * 3600); fixture.ready(night, 2 * 3600);
    morning.tick(8 * 3600, () => null, () => false); night.tick(2 * 3600, () => null, () => false);
    expect(morning.save().residents.filter((person) => person.journey?.activity === 'work')).toHaveLength(32);
    expect(night.save().residents.filter((person) => person.journey?.activity === 'work')).toHaveLength(0);
    expect(night.nearby({ x: 0, z: 0 }, 500, 3, 2 * 3600)).toHaveLength(3);
    const smaller = city(1); const smallSystem = new CitizenSystem(); smaller.sync(smallSystem); smaller.ready(smallSystem, 100);
    smallSystem.tick(100, () => null, () => false);
    expect(smallSystem.nearby({ x: 0, z: 0 }, 500, 3000, 100)).toHaveLength(4);
  });

  it('owns one named driver per car and continues while invisible; save/load preserves journeys', () => {
    const fixture = city(); const traffic = new TrafficSystem(fixture.roads);
    traffic.syncCitizens(fixture.households, fixture.population, fixture.lots, 0);
    fixture.ready(traffic.citizens, 8 * 3600);
    traffic.tick(8 * 3600, fixture.population, fixture.lots);
    const cars = traffic.trips;
    expect(cars.length).toBeGreaterThan(10);
    expect(cars.every((trip) => trip.vehicleCount === 1 && trip.driverName && trip.citizenId && trip.vehicleId)).toBe(true);
    expect(new Set(cars.map((trip) => trip.citizenId)).size).toBe(cars.length);
    const walkingIds = new Set(traffic.snapshot().citizenCandidates?.map((person) => person.id));
    expect(cars.every((trip) => !walkingIds.has(trip.citizenId!))).toBe(true);
    traffic.setCitizenView({ x: 1000, z: 1000 }, 20, 10);
    expect(traffic.snapshot().citizenCandidates).toHaveLength(0);
    traffic.tick(8 * 3600 + 5, fixture.population, fixture.lots);
    expect(traffic.trips.find((trip) => trip.id === cars[0].id)!.progressMeters).toBeGreaterThan(0);
    const save = traffic.save(); const restored = new TrafficSystem(fixture.roads);
    restored.restore(save, 8 * 3600 + 5);
    restored.syncCitizens(fixture.households, fixture.population, fixture.lots, 8 * 3600 + 5);
    expect(restored.save()).toEqual(save);
    expect(restored.inspectCitizen(cars[0].citizenId!)).toEqual(traffic.inspectCitizen(cars[0].citizenId!));
    restored.setCitizenView({ x: 0, z: 0 }, 500, 3000);
    expect(restored.snapshot().citizenCandidates!.length).toBeGreaterThan(0);
  });

  it('rejects missing identities and invalid routes, and cancels walking after a road is removed', () => {
    const fixture = city(); const system = new CitizenSystem(); fixture.sync(system); fixture.ready(system, 100);
    system.tick(100, () => null, () => false);
    const incomplete = system.save(); incomplete.residents.pop();
    const restored = new CitizenSystem(); restored.restore(incomplete);
    expect(() => fixture.sync(restored, 100)).toThrow('missing');
    const invalid = system.save(); invalid.residents[0].journey!.length = NaN;
    expect(() => restored.restore(invalid)).toThrow('journey');
    system.sync(fixture.households, fixture.population.occupancies, fixture.lots, new RoadGraph().snapshot(), [], 101);
    expect(system.nearby({ x: 0, z: 0 }, 500, 3000, 101)).toHaveLength(0);
    expect(system.get('citizen-1-0')?.journey).toBeUndefined();
  });

  it('preserves named transit passengers through boarding, save/load and alighting', () => {
    const fixture = city(); const bus = new TransitSystem(fixture.roads);
    const from = bus.placeStop({ x: -136, z: 12 }); const to = bus.placeStop({ x: 154, z: 12 });
    bus.createLine({ name: 'Test', stopIds: [from.id, to.id], serviceStartSeconds: 0, serviceEndSeconds: 86399,
      frequencySeconds: 60, vehicleTypeId: 'standard' }, 0);
    const endpoint = (lot: Lot) => ({ kind: 'building' as const, id: lot.buildingId!, position: lot.position,
      roadSegmentId: lot.roadAccess.roadSegmentId });
    expect(bus.offerTrip(endpoint(fixture.lots[0]), endpoint(fixture.lots[2]), 1, 10000, 0, [], 'citizen-1-0')).toBe(true);
    expect(bus.hasPassenger('citizen-1-0')).toBe(true);
    bus.tick(0, []);
    const loaded = new TransitSystem(fixture.roads); loaded.restore(bus.save(), 0);
    expect(loaded.hasPassenger('citizen-1-0')).toBe(true);
    for (let now = 5; now < 1000 && loaded.hasPassenger('citizen-1-0'); now += 5) loaded.tick(now, []);
    expect(loaded.hasPassenger('citizen-1-0')).toBe(false);
    expect(loaded.snapshot().stopMetrics.find((metric) => metric.stopId === to.id)?.alighted).toBe(1);
  });

  it('retains outside traffic with distinct drivers alongside the resident registry', () => {
    const fixture = city(); const graph = new RoadGraph();
    graph.buildRoad({ geometry: { kind: 'straight', points: [{ x: -512, z: 0 }, { x: 200, z: 0 }] }, roadTypeId: 'small' });
    const road = graph.snapshot();
    for (const lot of fixture.lots) lot.roadAccess.roadSegmentId = road.segments[0].id;
    const traffic = new TrafficSystem(road);
    traffic.syncCitizens(fixture.households, fixture.population, fixture.lots, 0);
    traffic.tick(30, fixture.population, fixture.lots);
    expect(traffic.trips.map((trip) => trip.purpose)).toEqual(['outside-city', 'city-outside']);
    const visitors = traffic.trips.map((trip) => trip.citizenId!);
    expect(new Set(visitors).size).toBe(2);
    expect(traffic.inspectCitizen(visitors[0])?.origin).toBe('都市外');
    traffic.syncCitizens(fixture.households, fixture.population, fixture.lots, 30);
    expect(traffic.trips).toHaveLength(2);
    const saved = traffic.save(); const loaded = new TrafficSystem(road); loaded.restore(saved, 30);
    loaded.syncCitizens(fixture.households, fixture.population, fixture.lots, 30);
    expect(loaded.save()).toEqual(saved);
  });

  it('bounds due work and nearby output for a 100,000-person city', () => {
    const fixture = city(25000); const system = new CitizenSystem(); fixture.sync(system);
    expect(system.count).toBe(100000);
    const started = performance.now(); system.tick(1000, () => null, () => false);
    const elapsed = performance.now() - started;
    const visible = system.nearby({ x: 0, z: 0 }, 500, 30, 1000);
    expect(visible).toHaveLength(30);
    expect(system.nearby({ x: 2000, z: 2000 }, 30, 3000, 1000)).toHaveLength(0);
    expect(elapsed).toBeLessThan(500);
    console.log(`100,000 named citizens: bounded journey tick ${elapsed.toFixed(2)} ms; ${visible.length} nearby candidates`);
  });
});
