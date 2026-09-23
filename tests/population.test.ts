import { describe, expect, it } from 'vitest';
import { PopulationSystem } from '../src/population/system';
import { calculateDemand } from '../src/population/demand';
import type { Household, PopulationTotals } from '../src/population/types';
import { LotSystem, MIN_GROWTH_DEMAND } from '../src/lots/system';
import type { Building, Lot } from '../src/lots/types';
import { SimulationState } from '../src/simulation/state';
import type { ZoneType, ZoningCell } from '../src/zoning/types';

const synthetic = (index: number, zoneType: ZoneType, widthCells = 4, depthCells = 4): { lot: Lot; building: Building } => {
  const id = `lot-synthetic-${index}` as const;
  const x = index * 40;
  const lot: Lot = {
    id, zoneType, zoneCellIds: Array.from({ length: widthCells * depthCells }, (_, cell) => `zone-${index}-${cell}` as const),
    roadAccess: { roadSegmentId: 'segment-1', frontage: [{ x, z: 0 }, { x: x + widthCells * 8, z: 0 }] },
    widthCells, depthCells, width: widthCells * 8, depth: depthCells * 8,
    position: { x: x + widthCells * 4, z: depthCells * 4 }, rotation: 0,
    corners: [{ x, z: 0 }, { x: x + widthCells * 8, z: 0 },
      { x: x + widthCells * 8, z: depthCells * 8 }, { x, z: depthCells * 8 }],
    averageElevation: 0, minElevation: 0, maxElevation: 0, baseElevation: 0, slope: 0, buildable: true,
    buildingId: `building-${id}`,
  };
  return { lot, building: { id: `building-${id}`, lotId: id,
    definitionId: `prototype-${zoneType}-${widthCells}x${depthCells}`,
    state: 'Occupied', stateEnteredAt: 0, nextTransitionAt: null } };
};

const emptyTotals = (): PopulationTotals => ({
  population: 0, households: 0, employed: 0, unemployed: 0, laborForce: 0,
  totalJobs: 0, availableJobs: 0, residentialCapacity: 0, commercialCapacity: 0,
  jobsByZone: { commercial: 0, industrial: 0, office: 0 },
  availableJobsByZone: { commercial: 0, industrial: 0, office: 0 },
  emptyBuildingsByZone: { commercial: 0, industrial: 0, office: 0 },
  occupiedBuildingsByZone: { commercial: 0, industrial: 0, office: 0 },
});

describe('population, employment, and demand', () => {
  it('moves households into occupied homes gradually and respects residential capacity', () => {
    const { lot, building } = synthetic(1, 'residential', 1, 1);
    const system = new PopulationSystem();
    system.syncBuildings([building], [lot], 0);
    expect(system.population.occupancies[0]).toMatchObject({ householdCapacity: 2, populationCapacity: 8, currentHouseholds: 0 });
    expect(system.tick(29)).toBe(false);
    system.tick(30);
    expect(system.population.totals.households).toBe(1);
    expect(system.households[0]).toMatchObject({ homeBuildingId: building.id, state: 'Housed', employedCount: 0 });
    system.tick(60);
    system.tick(90);
    expect(system.population.totals.households).toBe(2);
    expect(system.population.totals.population).toBeGreaterThan(2);
    expect(system.population.totals.population).toBeLessThanOrEqual(8);
  });

  it('creates C/I/O job capacity and assigns workers without commute paths', () => {
    const pairs = [synthetic(1, 'residential', 2, 2), synthetic(2, 'commercial', 1, 1),
      synthetic(3, 'industrial', 1, 1), synthetic(4, 'office', 1, 1)];
    const system = new PopulationSystem();
    system.syncBuildings(pairs.map(({ building }) => building), pairs.map(({ lot }) => lot), 0);
    system.tick(30);
    system.tick(45);
    const snapshot = system.population;
    expect(snapshot.totals.totalJobs).toBe(12);
    expect(snapshot.totals.employed).toBeGreaterThan(0);
    expect(snapshot.totals.unemployed).toBe(0);
    expect(snapshot.totals.availableJobs).toBe(snapshot.totals.totalJobs - snapshot.totals.employed);
    expect(snapshot.occupancies.filter((item) => item.totalJobs > 0).map((item) => item.totalJobs)).toEqual([3, 4, 5]);
  });

  it('changes each RCIO demand for its stated city inputs', () => {
    const base = emptyTotals();
    const initial = calculateDemand(base, 0);
    const residential = emptyTotals();
    residential.residentialCapacity = 100;
    expect(calculateDemand(residential, 60).values.residential).toBeLessThan(initial.values.residential);
    residential.households = 100;
    residential.laborForce = 100;
    residential.unemployed = 100;
    expect(calculateDemand(residential, 60).values.residential).toBeLessThan(initial.values.residential);
    residential.availableJobs = 100;
    expect(calculateDemand(residential, 60).values.residential).toBeGreaterThan(calculateDemand({ ...residential, availableJobs: 0 }, 60).values.residential);

    const city = emptyTotals();
    city.population = 500;
    city.laborForce = 200;
    expect(calculateDemand(city, 60).values.commercial).toBeGreaterThan(initial.values.commercial);
    expect(calculateDemand(city, 60).values.industrial).toBeGreaterThan(initial.values.industrial);
    expect(calculateDemand(city, 60).values.office).toBeGreaterThan(initial.values.office);
    city.commercialCapacity = 1000;
    city.jobsByZone = { commercial: 100, industrial: 100, office: 100 };
    city.availableJobsByZone = { commercial: 100, industrial: 100, office: 100 };
    city.emptyBuildingsByZone = { commercial: 2, industrial: 2, office: 2 };
    city.occupiedBuildingsByZone = { commercial: 2, industrial: 2, office: 2 };
    const oversupplied = calculateDemand(city, 60);
    expect(oversupplied.values.commercial).toBeLessThan(calculateDemand({ ...city, commercialCapacity: 0,
      availableJobsByZone: { ...city.availableJobsByZone, commercial: 0 },
      emptyBuildingsByZone: { ...city.emptyBuildingsByZone, commercial: 0 } }, 60).values.commercial);
    expect(oversupplied.values.industrial).toBeLessThan(calculateDemand({ ...city,
      availableJobsByZone: { ...city.availableJobsByZone, industrial: 0 },
      emptyBuildingsByZone: { ...city.emptyBuildingsByZone, industrial: 0 } }, 60).values.industrial);
    expect(oversupplied.values.office).toBeLessThan(calculateDemand({ ...city,
      availableJobsByZone: { ...city.availableJobsByZone, office: 0 },
      emptyBuildingsByZone: { ...city.emptyBuildingsByZone, office: 0 } }, 60).values.office);
    expect(Object.values(oversupplied.values).every((value) => value >= 0 && value <= 100)).toBe(true);
  });

  it('blocks only new growth when demand is below threshold', () => {
    const cell: ZoningCell = { id: 'zone-one', roadSegmentId: 'segment-1', center: { x: 4, z: 12 },
      corners: [{ x: 0, z: 8 }, { x: 8, z: 8 }, { x: 8, z: 16 }, { x: 0, z: 16 }],
      angle: 0, depth: 0, side: 1, size: 8, zoneType: 'office', terrainSuitable: true };
    const lots = new LotSystem();
    lots.reconcile([cell], () => 0, 0);
    expect(MIN_GROWTH_DEMAND).toBeGreaterThan(0);
    expect(lots.advance(10, { residential: 100, commercial: 100, industrial: 100, office: 0 })).toBe(false);
    expect(lots.buildings[0].state).toBe('Empty');
    expect(lots.advance(20, { residential: 100, commercial: 100, industrial: 100, office: 100 })).toBe(true);
    expect(lots.buildings[0].state).toBe('Planned');
    expect(lots.advance(80, { residential: 0, commercial: 0, industrial: 0, office: 0 })).toBe(true);
    expect(lots.buildings[0].state).toBe('Occupied');
  });

  it('cleans up removed homes and jobs, then restores households for an undo-like reappearance', () => {
    const home = synthetic(1, 'residential', 1, 1);
    const work = synthetic(2, 'commercial', 1, 1);
    const system = new PopulationSystem();
    system.syncBuildings([home.building, work.building], [home.lot, work.lot], 0);
    system.tick(30);
    system.tick(45);
    const before = system.households;
    expect(before[0].employedCount).toBeGreaterThan(0);
    system.syncBuildings([work.building], [work.lot], 46);
    expect(system.households).toHaveLength(0);
    expect(system.population.totals.population).toBe(0);
    system.syncBuildings([home.building, work.building], [home.lot, work.lot], 47);
    expect(system.households).toEqual(before);
    system.syncBuildings([home.building], [home.lot], 48);
    expect(system.population.totals.employed).toBe(0);
    expect(system.population.totals.unemployed).toBeGreaterThan(0);
  });

  it('round-trips households, jobs, timers, demand, and migrates a v5 city', () => {
    const state = new SimulationState();
    state.execute({ type: 'build-road', input: { geometry: { kind: 'straight', points: [{ x: -80, z: 0 }, { x: 80, z: 0 }] }, roadTypeId: 'small' } });
    const frontage = state.snapshot().zoningCells.filter((cell) => cell.depth === 0);
    state.execute({ type: 'set-zone', cellIds: [frontage[0].id], zoneType: 'residential' });
    state.execute({ type: 'set-zone', cellIds: [frontage.at(-1)!.id], zoneType: 'commercial' });
    state.tick(7);
    expect(state.population.households.length).toBeGreaterThan(0);
    const saved = JSON.parse(JSON.stringify(state.serialize()));
    const restored = new SimulationState();
    restored.load(saved);
    expect(restored.population.households).toEqual(state.population.households);
    expect(restored.snapshot().population.totals).toEqual(state.snapshot().population.totals);
    expect(restored.snapshot().population.occupancies).toEqual(state.snapshot().population.occupancies);
    expect(restored.snapshot().population.demand).toEqual(state.snapshot().population.demand);
    expect(restored.serialize().population).toEqual(state.serialize().population);
    const legacy = { ...saved, saveVersion: 5 };
    delete legacy.population;
    const migrated = new SimulationState();
    migrated.load(legacy);
    expect(migrated.snapshot().buildings).toEqual(state.snapshot().buildings);
    expect(migrated.population.households).toHaveLength(0);
  });

  it('keeps household references consistent through zoning and road undo/redo', () => {
    const state = new SimulationState();
    state.execute({ type: 'build-road', input: { geometry: { kind: 'straight', points: [{ x: -80, z: 0 }, { x: 80, z: 0 }] }, roadTypeId: 'small' } });
    const cellId = state.snapshot().zoningCells.find((cell) => cell.depth === 0)!.id;
    state.execute({ type: 'set-zone', cellIds: [cellId], zoneType: 'residential' });
    state.tick(7);
    const household = state.population.households[0];
    expect(household).toBeDefined();
    state.execute({ type: 'set-zone', cellIds: [cellId], zoneType: null });
    expect(state.population.households).toHaveLength(0);
    expect(state.undo()).toBe(true);
    expect(state.population.households).toEqual([household]);
    expect(state.redo()).toBe(true);
    expect(state.population.households).toHaveLength(0);
    expect(state.undo()).toBe(true);
    const roadId = state.snapshot().roadGraph.segments[0].id;
    state.execute({ type: 'remove-road', segmentId: roadId });
    expect(state.population.households).toHaveLength(0);
    expect(state.undo()).toBe(true);
    expect(state.population.households).toEqual([household]);
  });

  it('removes unsafe terrain households and restores them on terrain undo', () => {
    const state = new SimulationState();
    state.execute({ type: 'build-road', input: { geometry: { kind: 'straight', points: [{ x: -160, z: 0 }, { x: 160, z: 0 }] }, roadTypeId: 'small' } });
    state.execute({ type: 'set-zone', cellIds: state.snapshot().zoningCells.map((cell) => cell.id), zoneType: 'residential' });
    state.tick(7);
    const lot = state.snapshot().lots.find((item) => item.buildingId && item.position.z > 15 && Math.abs(item.position.x) < 40)!;
    const household = state.population.households.find((item) => item.homeBuildingId === lot.buildingId);
    expect(household).toBeDefined();
    state.beginTerrainStroke(lot.position, 'raise', 24, 50);
    state.applyTerrainStroke([lot.position], 0.25);
    state.endTerrainStroke();
    expect(state.population.households.some((item) => item.homeBuildingId === lot.buildingId)).toBe(false);
    expect(state.undo()).toBe(true);
    expect(state.population.households.find((item) => item.homeBuildingId === lot.buildingId)).toEqual(household);
  });

  it('rejects orphan households without replacing the live city', () => {
    const state = new SimulationState();
    const before = state.snapshot().population;
    const save = state.serialize();
    save.population.households.push({ id: 'household-1', homeBuildingId: 'building-missing',
      householdSize: 3, employedCount: 0, unemployedCount: 1, state: 'Housed' });
    save.population.nextHouseholdSerial = 2;
    expect(() => state.load(save)).toThrow(/invalid households/);
    expect(state.snapshot().population).toEqual(before);
  });
});

describe('population aggregation performance', () => {
  it('keeps matching near-linear from 1,000 through 100,000 residents', () => {
    const times: number[] = [];
    for (const target of [1_000, 10_000, 50_000, 100_000]) {
      const householdCount = Math.ceil(target / 3);
      const residentialCount = Math.ceil(householdCount / 32);
      const officeCount = Math.ceil(householdCount / 80);
      const pairs = [
        ...Array.from({ length: residentialCount }, (_, index) => synthetic(index + 1, 'residential')),
        ...Array.from({ length: officeCount }, (_, index) => synthetic(residentialCount + index + 1, 'office')),
      ];
      const buildings = pairs.map(({ building }) => building);
      const lots = pairs.map(({ lot }) => lot);
      const seed = new PopulationSystem();
      seed.syncBuildings(buildings, lots, 0);
      const save = seed.save();
      const households: Household[] = [];
      for (let index = 0; index < householdCount; index += 1) {
        const occupancy = save.occupancies[Math.floor(index / 32)];
        occupancy.currentHouseholds += 1;
        occupancy.currentPopulation += 3;
        households.push({ id: `household-${index + 1}`, homeBuildingId: occupancy.buildingId,
          householdSize: 3, employedCount: 0, unemployedCount: 1, state: 'Housed' });
      }
      save.households = households;
      save.nextHouseholdSerial = householdCount + 1;
      save.nextMoveInAt = 1_000;
      const system = new PopulationSystem();
      system.restore(save, buildings, lots, 0);
      const started = performance.now();
      system.tick(45);
      const elapsed = performance.now() - started;
      times.push(elapsed);
      expect(system.population.totals.population).toBeGreaterThanOrEqual(target);
      expect(system.population.totals.employed).toBe(householdCount);
      expect(elapsed).toBeLessThan(3_000);
      console.info(`${target.toLocaleString()} population: ${elapsed.toFixed(1)} ms matching tick; ${householdCount.toLocaleString()} households`);
    }
    expect(times[2]).toBeLessThan(Math.max(1_500, times[1] * 20));
    expect(times[3]).toBeLessThan(Math.max(3_000, times[2] * 5));
  }, 30_000);
});
