import { describe, expect, it } from 'vitest';
import { RoadGraph } from '../src/roads/roadGraph';
import type { Lot } from '../src/lots/types';
import { PopulationSystem } from '../src/population/system';
import { ServiceSystem, SERVICE_DEFINITIONS, planServicePlacement } from '../src/services/system';
import { SimulationState } from '../src/simulation/state';
import { migrateSave } from '../src/save/serializer';

const addRoad = (graph: RoadGraph, x0: number, x1: number, z = 0) => graph.buildRoad({
  geometry: { kind: 'straight', points: [{ x: x0, z }, { x: x1, z }] }, roadTypeId: 'small',
});
const lot = (id: string, roadSegmentId: Lot['roadAccess']['roadSegmentId'], x: number, z = 10): Lot => ({
  id: `lot-${id}`, zoneType: 'residential', zoneCellIds: [],
  roadAccess: { roadSegmentId, frontage: [{ x, z }, { x: x + 8, z }] },
  widthCells: 1, depthCells: 1, width: 8, depth: 8, position: { x, z }, rotation: 0,
  corners: [{ x, z }, { x: x + 8, z }, { x: x + 8, z: z + 8 }, { x, z: z + 8 }],
  averageElevation: 0, minElevation: 0, maxElevation: 0, baseElevation: 0, slope: 0,
  buildable: true, buildingId: `building-${id}`,
});
const population = (items: readonly Lot[], households = 4, people = 12) => {
  const snapshot = new PopulationSystem().snapshot();
  snapshot.occupancies = items.map((item) => ({ buildingId: item.buildingId!, zoneType: 'residential', active: true,
    householdCapacity: 200, populationCapacity: 600, currentHouseholds: households, currentPopulation: people,
    totalJobs: 0, filledJobs: 0, availableJobs: 0, commercialCapacity: 0 }));
  return snapshot;
};

describe('utilities and city services', () => {
  it('uses the clicked ground point as the service lot center, never the road centerline', () => {
    const graph = new RoadGraph();
    addRoad(graph, -100, 100);
    const services = new ServiceSystem();
    const onRoad = planServicePlacement('fire', { x: 0, z: 0 }, graph.snapshot());
    expect(onRoad.valid).toBe(false);
    expect(() => services.place('fire', { x: 0, z: 0 }, graph.snapshot())).toThrow();
    const tooFar = planServicePlacement('fire', { x: 0, z: 60 }, graph.snapshot());
    expect(tooFar.valid).toBe(false);
    const chosen = { x: 0, z: 19 };
    const preview = planServicePlacement('fire', chosen, graph.snapshot());
    expect(preview.valid).toBe(true);
    expect(preview.facility?.position).toEqual(chosen);
    const placed = services.place('fire', chosen, graph.snapshot());
    expect(placed.position).toEqual(chosen);
    expect(placed.lot.corners).toEqual(preview.facility?.lot.corners);
  });

  it('requires a road, supplies all eight services and reports demand and capacity', () => {
    const graph = new RoadGraph();
    expect(() => new ServiceSystem().place('water', { x: 0, z: 0 }, graph.snapshot())).toThrow(/road/);
    addRoad(graph, -220, 220);
    const building = lot('home', graph.snapshot().segments[0].id, 20);
    const services = new ServiceSystem();
    for (const type of Object.keys(SERVICE_DEFINITIONS) as Array<keyof typeof SERVICE_DEFINITIONS>) {
      const chosen = { x: -180 + services.facilities.length * 45, z: 8 + SERVICE_DEFINITIONS[type].depth / 2 + 2 };
      const placed = services.place(type, chosen, graph.snapshot());
      expect(placed.position).toEqual(chosen);
    }
    for (const facility of services.facilities) {
      expect(facility.building.definitionId).toBe(facility.type);
      expect(facility.building.state).toBe('Operating');
      expect(facility.lot.corners).toHaveLength(4);
      expect(facility.lot.width).toBe(SERVICE_DEFINITIONS[facility.type].width);
      expect(facility.position.z).toBeGreaterThan(graph.snapshot().segments[0].width / 2);
      expect(facility.roadAccessPoint.z).toBe(0);
    }
    services.recalculate(graph.snapshot(), [building], population([building]));
    for (const metric of Object.values(services.snapshot().coverage)) {
      expect(metric.demand).toBeGreaterThan(0);
      expect(metric.supplied).toBeGreaterThan(0);
      expect(metric.capacity).toBeGreaterThan(0);
      expect(metric.activeFacilities).toBe(1);
    }
  });

  it('does not supply disconnected buildings, and preserves a facility after its road is deleted', () => {
    const graph = new RoadGraph();
    addRoad(graph, -100, -20);
    addRoad(graph, 20, 100);
    const target = lot('island', graph.snapshot().segments[1].id, 60);
    const services = new ServiceSystem();
    services.place('electricity', { x: -80, z: 20 }, graph.snapshot());
    services.recalculate(graph.snapshot(), [target], population([target]));
    expect(services.snapshot().coverage.electricity).toMatchObject({ demand: 4, supplied: 0, percent: 0 });
    const empty = new RoadGraph().snapshot();
    services.recalculate(empty, [], population([]));
    expect(services.snapshot().coverage.electricity).toMatchObject({ facilities: 1, activeFacilities: 0, capacity: 0 });
    const restored = new ServiceSystem();
    restored.restore(services.save());
    expect(restored.facilities).toEqual(services.facilities);
  });

  it('caps supply, charges construction and maintenance, and supports undo/redo', () => {
    const state = new SimulationState();
    state.execute({ type: 'build-road', input: {
      geometry: { kind: 'straight', points: [{ x: -100, z: 0 }, { x: 100, z: 0 }] }, roadTypeId: 'small',
    } });
    const before = state.economy.funds;
    state.execute({ type: 'place-service', serviceType: 'water', position: { x: 0, z: 19 } });
    expect(state.services.facilities).toHaveLength(1);
    expect(state.economy.funds).toBe(before - SERVICE_DEFINITIONS.water.constructionCost);
    state.undo();
    expect(state.services.facilities).toHaveLength(0);
    expect(state.economy.funds).toBe(before);
    state.redo();
    expect(state.services.facilities).toHaveLength(1);
    state.economy.tick(600, state.population.snapshot().totals, state.graph.snapshot().segments,
      state.services.snapshot().maintenancePerCycle);
    expect(state.economy.snapshot().lastCycleServiceMaintenance).toBe(SERVICE_DEFINITIONS.water.maintenancePerCycle);
    expect(state.economy.snapshot().transactions.some((entry) => entry.kind === 'SERVICE_MAINTENANCE')).toBe(true);
    const segment = state.graph.snapshot().segments[0];
    const crowded = lot('crowded', segment.id, 20);
    const occupied = population([crowded], 250, 500);
    state.services.recalculate(state.graph.snapshot(), [crowded], occupied);
    expect(state.services.snapshot().coverage.water).toMatchObject({ demand: 250, supplied: 200, capacity: 200, percent: 80 });
  });

  it('reserves a roadside footprint against other facilities, RCIO zoning and new roads', () => {
    const state = new SimulationState();
    state.execute({ type: 'build-road', input: {
      geometry: { kind: 'straight', points: [{ x: -100, z: 0 }, { x: 100, z: 0 }] }, roadTypeId: 'small',
    } });
    state.execute({ type: 'place-service', serviceType: 'fire', position: { x: 0, z: 19 } });
    expect(() => state.execute({ type: 'place-service', serviceType: 'police', position: { x: 4, z: 19 } }))
      .toThrow(/overlaps/);
    const cell = state.snapshot().zoningCells.find((candidate) => state.services.overlapsCell(candidate));
    expect(cell).toBeDefined();
    expect(() => state.execute({ type: 'set-zone', cellIds: [cell!.id], zoneType: 'residential' }))
      .toThrow();
    const roadCount = state.graph.snapshot().segments.length;
    expect(() => state.execute({ type: 'build-road', input: {
      geometry: { kind: 'straight', points: [{ x: 0, z: -50 }, { x: 0, z: 70 }] }, roadTypeId: 'small',
    } })).toThrow(/service building/);
    expect(state.graph.snapshot().segments).toHaveLength(roadCount);
    const facility = state.services.facilities[0];
    const before = state.terrain.getHeight(facility.position.x, facility.position.z);
    state.beginTerrainStroke(facility.position, 'raise', 24, 40);
    state.applyTerrainStroke([facility.position], 0.25);
    state.endTerrainStroke();
    expect(state.terrain.getHeight(facility.position.x, facility.position.z)).toBeCloseTo(before, 5);
  });

  it('round-trips services and migrates v8 saves with empty services', () => {
    const state = new SimulationState();
    state.execute({ type: 'build-road', input: {
      geometry: { kind: 'straight', points: [{ x: -100, z: 0 }, { x: 100, z: 0 }] }, roadTypeId: 'small',
    } });
    state.execute({ type: 'place-service', serviceType: 'fire', position: { x: 0, z: 19 } });
    const saved = state.serialize();
    expect(saved.saveVersion).toBe(11);
    const restored = new SimulationState();
    restored.load(JSON.parse(JSON.stringify(saved)));
    expect(restored.services.facilities).toEqual(state.services.facilities);
    expect(restored.economy.funds).toBe(state.economy.funds);
    const old = { ...saved, saveVersion: 8, services: undefined };
    expect(migrateSave(old).services.facilities).toEqual([]);
    const migrated = new SimulationState();
    migrated.load(JSON.parse(JSON.stringify(old)));
    expect(migrated.services.facilities).toEqual([]);
    expect(migrated.economy.snapshot().lastCycleServiceMaintenance).toBe(0);
    const markerPreview = { ...saved, services: { ...saved.services, facilities: saved.services.facilities.map((facility) => ({
      id: facility.id, type: facility.type, position: facility.roadAccessPoint,
    })) } };
    const upgraded = new SimulationState();
    upgraded.load(JSON.parse(JSON.stringify(markerPreview)));
    expect(upgraded.services.facilities[0].building.definitionId).toBe('fire');
  });
});
