import { closestPointOnPolyline, distance, polylineLength } from '../roads/geometry';
import type { RoadGraphSnapshot, RoadSegment } from '../roads/types';
import type { Lot } from '../lots/types';
import type { PopulationSnapshot, BuildingOccupancy } from '../population/types';
import type { Vec2 } from '../world/types';
import { SERVICE_TYPES, type ServiceCoverage, type ServiceDefinition, type ServiceFacility, type ServiceSaveState, type ServiceSnapshot, type ServiceType } from './types';

export const SERVICE_DEFINITIONS: Record<ServiceType, ServiceDefinition> = {
  electricity: { type: 'electricity', label: 'Electricity', capacity: 200, rangeMeters: Infinity, maintenancePerCycle: 45, constructionCost: 1200 },
  water: { type: 'water', label: 'Water', capacity: 200, rangeMeters: Infinity, maintenancePerCycle: 40, constructionCost: 1000 },
  garbage: { type: 'garbage', label: 'Garbage', capacity: 160, rangeMeters: 700, maintenancePerCycle: 35, constructionCost: 900 },
  fire: { type: 'fire', label: 'Fire', capacity: 180, rangeMeters: 450, maintenancePerCycle: 55, constructionCost: 1400 },
  police: { type: 'police', label: 'Police', capacity: 180, rangeMeters: 450, maintenancePerCycle: 55, constructionCost: 1400 },
  healthcare: { type: 'healthcare', label: 'Healthcare', capacity: 160, rangeMeters: 500, maintenancePerCycle: 65, constructionCost: 1700 },
  education: { type: 'education', label: 'Education', capacity: 180, rangeMeters: 500, maintenancePerCycle: 50, constructionCost: 1300 },
  parks: { type: 'parks', label: 'Parks', capacity: 240, rangeMeters: 300, maintenancePerCycle: 20, constructionCost: 600 },
};

interface Anchor { segment: RoadSegment; along: number; distance: number }

const nearestRoad = (point: Vec2, roads: readonly RoadSegment[]): Anchor | undefined => {
  let best: Anchor | undefined;
  for (const segment of roads) {
    const projection = closestPointOnPolyline(point, segment.geometry.points);
    if (!best || projection.distance < best.distance) best = { segment, along: projection.along, distance: projection.distance };
  }
  return best && best.distance <= 16 ? best : undefined;
};

const roadDistances = (source: Anchor, graph: RoadGraphSnapshot): Map<string, number> => {
  const distances = new Map<string, number>();
  const length = polylineLength(source.segment.geometry.points);
  distances.set(source.segment.startNodeId, source.along);
  distances.set(source.segment.endNodeId, length - source.along);
  const visited = new Set<string>();
  const adjacency = new Map<string, Array<{ to: string; length: number }>>();
  for (const segment of graph.segments) {
    const weight = polylineLength(segment.geometry.points);
    const start = adjacency.get(segment.startNodeId) ?? [];
    start.push({ to: segment.endNodeId, length: weight });
    adjacency.set(segment.startNodeId, start);
    const end = adjacency.get(segment.endNodeId) ?? [];
    end.push({ to: segment.startNodeId, length: weight });
    adjacency.set(segment.endNodeId, end);
  }
  while (true) {
    let current: string | undefined;
    let minimum = Infinity;
    for (const [id, value] of distances) if (!visited.has(id) && value < minimum) { current = id; minimum = value; }
    if (!current) break;
    visited.add(current);
    for (const edge of adjacency.get(current) ?? []) {
      const candidate = minimum + edge.length;
      if (candidate < (distances.get(edge.to) ?? Infinity)) distances.set(edge.to, candidate);
    }
  }
  return distances;
};

const networkDistance = (source: Anchor, target: Anchor, nodes: Map<string, number>): number => {
  const length = polylineLength(target.segment.geometry.points);
  const viaStart = (nodes.get(target.segment.startNodeId) ?? Infinity) + target.along;
  const viaEnd = (nodes.get(target.segment.endNodeId) ?? Infinity) + length - target.along;
  return Math.min(viaStart, viaEnd, source.segment.id === target.segment.id ? Math.abs(source.along - target.along) : Infinity);
};

const demandFor = (type: ServiceType, occupancy: BuildingOccupancy): number => {
  if (!occupancy.active) return 0;
  if (occupancy.zoneType === 'residential') {
    if (type === 'education') return Math.ceil(occupancy.currentPopulation * 0.25);
    if (type === 'electricity' || type === 'water' || type === 'garbage') return occupancy.currentHouseholds;
    return occupancy.currentPopulation;
  }
  if (type === 'education' || type === 'parks') return 0;
  return occupancy.filledJobs;
};

const emptyCoverage = (): ServiceCoverage => ({ demand: 0, supplied: 0, percent: 0, capacity: 0, facilities: 0, activeFacilities: 0 });

/** Worker-authoritative, aggregate road-network supply. No pipe or wire micromanagement. */
export class ServiceSystem {
  private facilitiesById = new Map<string, ServiceFacility>();
  private nextFacilitySerial = 1;
  private current: ServiceSnapshot = { revision: 0, facilities: [], coverage: Object.fromEntries(SERVICE_TYPES.map((type) => [type, emptyCoverage()])) as Record<ServiceType, ServiceCoverage>, buildingCoverage: {}, maintenancePerCycle: 0 };
  revision = 0;

  get facilities(): ServiceFacility[] { return [...this.facilitiesById.values()].map((facility) => structuredClone(facility)); }
  snapshot(): ServiceSnapshot { return structuredClone(this.current); }
  save(): ServiceSaveState { return { facilities: this.facilities, nextFacilitySerial: this.nextFacilitySerial }; }

  place(type: ServiceType, position: Vec2, graph: RoadGraphSnapshot): ServiceFacility {
    if (!SERVICE_TYPES.includes(type) || !Number.isFinite(position.x) || !Number.isFinite(position.z)) throw new Error('Invalid service placement.');
    const anchor = nearestRoad(position, graph.segments);
    if (!anchor) throw new Error('Place the service within 16 m of a road.');
    if (this.facilities.some((facility) => distance(facility.position, position) < 18)) throw new Error('Too close to another service facility.');
    while (this.facilitiesById.has(`service-${this.nextFacilitySerial}`)) this.nextFacilitySerial += 1;
    const facility = { id: `service-${this.nextFacilitySerial++}`, type, position: { ...position } };
    this.facilitiesById.set(facility.id, facility);
    this.revision += 1;
    return structuredClone(facility);
  }

  remove(id: string): ServiceFacility {
    const facility = this.facilitiesById.get(id);
    if (!facility) throw new Error('Service facility no longer exists.');
    this.facilitiesById.delete(id);
    this.revision += 1;
    return structuredClone(facility);
  }

  addExisting(facility: ServiceFacility): void {
    if (this.facilitiesById.has(facility.id)) throw new Error('Service facility already exists.');
    this.facilitiesById.set(facility.id, structuredClone(facility));
    this.revision += 1;
  }

  restore(saved: ServiceSaveState): void {
    if (!saved || !Array.isArray(saved.facilities) || !Number.isSafeInteger(saved.nextFacilitySerial) || saved.nextFacilitySerial < 1) throw new Error('Save contains invalid service data.');
    const ids = new Set<string>();
    for (const facility of saved.facilities) {
      if (!facility || typeof facility.id !== 'string' || ids.has(facility.id) || !SERVICE_TYPES.includes(facility.type)
        || !Number.isFinite(facility.position?.x) || !Number.isFinite(facility.position?.z)) throw new Error('Save contains invalid service data.');
      ids.add(facility.id);
    }
    this.facilitiesById = new Map(saved.facilities.map((facility) => [facility.id, structuredClone(facility)]));
    this.nextFacilitySerial = saved.nextFacilitySerial;
    this.revision += 1;
  }

  recalculate(graph: RoadGraphSnapshot, lots: readonly Lot[], population: PopulationSnapshot): void {
    const lotsByBuilding = new Map(lots.filter((lot) => lot.buildingId).map((lot) => [lot.buildingId!, lot]));
    const segments = new Map(graph.segments.map((segment) => [segment.id, segment]));
    const targets = population.occupancies.flatMap((occupancy) => {
      const lot = lotsByBuilding.get(occupancy.buildingId);
      const segment = lot && segments.get(lot.roadAccess.roadSegmentId);
      if (!lot || !segment) return [];
      const projection = closestPointOnPolyline(lot.position, segment.geometry.points);
      return [{ occupancy, anchor: { segment, along: projection.along, distance: projection.distance } }];
    }).sort((a, b) => a.occupancy.buildingId.localeCompare(b.occupancy.buildingId));
    const coverage = Object.fromEntries(SERVICE_TYPES.map((type) => [type, emptyCoverage()])) as Record<ServiceType, ServiceCoverage>;
    const buildingCoverage: ServiceSnapshot['buildingCoverage'] = {};
    const sources = this.facilities.map((facility) => ({ facility, anchor: nearestRoad(facility.position, graph.segments) }));
    for (const type of SERVICE_TYPES) {
      const metric = coverage[type];
      const definition = SERVICE_DEFINITIONS[type];
      const typeSources = sources.filter((source) => source.facility.type === type);
      metric.facilities = typeSources.length;
      metric.activeFacilities = typeSources.filter((source) => source.anchor).length;
      metric.capacity = metric.activeFacilities * definition.capacity;
      const remaining = new Map(typeSources.map((source) => [source.facility.id, definition.capacity]));
      const routes = typeSources.flatMap((source) => source.anchor ? [{ ...source, distances: roadDistances(source.anchor, graph) }] : []);
      for (const target of targets) {
        const demand = demandFor(type, target.occupancy);
        if (demand <= 0) continue;
        metric.demand += demand;
        let needed = demand;
        const options = routes.map((route) => ({ id: route.facility.id,
          distance: networkDistance(route.anchor!, target.anchor, route.distances) }))
          .filter((route) => Number.isFinite(route.distance) && route.distance <= definition.rangeMeters)
          .sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));
        for (const option of options) {
          const available = remaining.get(option.id) ?? 0;
          const supplied = Math.min(available, needed);
          remaining.set(option.id, available - supplied);
          needed -= supplied;
          if (needed === 0) break;
        }
        metric.supplied += demand - needed;
        (buildingCoverage[target.occupancy.buildingId] ??= {})[type] = Math.round(100 * (demand - needed) / demand);
      }
      metric.percent = metric.demand > 0 ? Math.round(100 * metric.supplied / metric.demand) : metric.activeFacilities > 0 ? 100 : 0;
    }
    const maintenancePerCycle = sources.filter((source) => source.anchor).reduce((sum, source) => sum + SERVICE_DEFINITIONS[source.facility.type].maintenancePerCycle, 0);
    this.revision += 1;
    this.current = { revision: this.revision, facilities: this.facilities, coverage, buildingCoverage, maintenancePerCycle };
  }
}
