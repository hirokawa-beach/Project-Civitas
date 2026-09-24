import { closestPointOnPolyline, distance, pointAtDistance, polylineLength } from '../roads/geometry';
import type { RoadGraphSnapshot, RoadSegment } from '../roads/types';
import type { Lot } from '../lots/types';
import type { ZoningCell } from '../zoning/types';
import type { PopulationSnapshot, BuildingOccupancy } from '../population/types';
import type { Vec2 } from '../world/types';
import { HALF_WORLD_SIZE } from '../world/types';
import { SERVICE_TYPES, type ServiceCoverage, type ServiceDefinition, type ServiceFacility, type ServiceSaveState, type ServiceSnapshot, type ServiceType } from './types';

export const SERVICE_DEFINITIONS: Record<ServiceType, ServiceDefinition> = {
  electricity: { type: 'electricity', label: 'Electricity', buildingName: 'Power plant', width: 24, depth: 20, height: 16, assetPath: null, capacity: 200, rangeMeters: Infinity, maintenancePerCycle: 45, constructionCost: 1200 },
  water: { type: 'water', label: 'Water', buildingName: 'Pumping station', width: 20, depth: 18, height: 9, assetPath: null, capacity: 200, rangeMeters: Infinity, maintenancePerCycle: 40, constructionCost: 1000 },
  garbage: { type: 'garbage', label: 'Garbage', buildingName: 'Waste facility', width: 28, depth: 24, height: 8, assetPath: null, capacity: 160, rangeMeters: 700, maintenancePerCycle: 35, constructionCost: 900 },
  fire: { type: 'fire', label: 'Fire', buildingName: 'Fire station', width: 20, depth: 18, height: 10, assetPath: null, capacity: 180, rangeMeters: 450, maintenancePerCycle: 55, constructionCost: 1400 },
  police: { type: 'police', label: 'Police', buildingName: 'Police station', width: 20, depth: 18, height: 10, assetPath: null, capacity: 180, rangeMeters: 450, maintenancePerCycle: 55, constructionCost: 1400 },
  healthcare: { type: 'healthcare', label: 'Healthcare', buildingName: 'Hospital', width: 26, depth: 22, height: 18, assetPath: null, capacity: 160, rangeMeters: 500, maintenancePerCycle: 65, constructionCost: 1700 },
  education: { type: 'education', label: 'Education', buildingName: 'School', width: 26, depth: 22, height: 12, assetPath: null, capacity: 180, rangeMeters: 500, maintenancePerCycle: 50, constructionCost: 1300 },
  parks: { type: 'parks', label: 'Parks', buildingName: 'Public park', width: 28, depth: 28, height: 0, assetPath: null, capacity: 240, rangeMeters: 300, maintenancePerCycle: 20, constructionCost: 600 },
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

const overlaps = (a: readonly Vec2[], b: readonly Vec2[]): boolean => {
  for (const polygon of [a, b]) for (let index = 0; index < polygon.length; index += 1) {
    const start = polygon[index];
    const end = polygon[(index + 1) % polygon.length];
    const axis = { x: end.z - start.z, z: start.x - end.x };
    const projection = (point: Vec2) => point.x * axis.x + point.z * axis.z;
    const aa = a.map(projection); const bb = b.map(projection);
    if (Math.max(...aa) <= Math.min(...bb) + 0.05 || Math.max(...bb) <= Math.min(...aa) + 0.05) return false;
  }
  return true;
};

const roadFootprint = (start: Vec2, end: Vec2, width: number): [Vec2, Vec2, Vec2, Vec2] => {
  const length = distance(start, end) || 1;
  const x = -(end.z - start.z) * width / (2 * length);
  const z = (end.x - start.x) * width / (2 * length);
  return [{ x: start.x + x, z: start.z + z }, { x: end.x + x, z: end.z + z },
    { x: end.x - x, z: end.z - z }, { x: start.x - x, z: start.z - z }];
};

const makeServiceBuilding = (id: string, type: ServiceType, click: Vec2, graph: RoadGraphSnapshot,
  getHeight: (x: number, z: number) => number): ServiceFacility => {
  const anchor = nearestRoad(click, graph.segments);
  if (!anchor) throw new Error('Place the service within 16 m of a road.');
  const definition = SERVICE_DEFINITIONS[type];
  const access = pointAtDistance(anchor.segment.geometry.points, anchor.along);
  const tangent = access.tangent;
  const cross = tangent.x * (click.z - access.point.z) - tangent.z * (click.x - access.point.x);
  const side = cross < 0 ? -1 : 1;
  const normal = { x: -tangent.z * side, z: tangent.x * side };
  const setback = anchor.segment.width / 2 + definition.depth / 2 + 2;
  const position = { x: access.point.x + normal.x * setback, z: access.point.z + normal.z * setback };
  const halfWidth = definition.width / 2;
  const halfDepth = definition.depth / 2;
  const corner = (along: number, out: number): Vec2 => ({ x: position.x + tangent.x * along + normal.x * out,
    z: position.z + tangent.z * along + normal.z * out });
  const corners: ServiceFacility['lot']['corners'] = [corner(-halfWidth, -halfDepth), corner(halfWidth, -halfDepth),
    corner(halfWidth, halfDepth), corner(-halfWidth, halfDepth)];
  if (corners.some((point) => Math.abs(point.x) > HALF_WORLD_SIZE || Math.abs(point.z) > HALF_WORLD_SIZE)) {
    throw new Error('Service building would extend outside the map.');
  }
  const heights = [...corners, position].map((point) => getHeight(point.x, point.z));
  const minHeight = Math.min(...heights); const maxHeight = Math.max(...heights);
  const slope = (maxHeight - minHeight) / Math.min(definition.width, definition.depth);
  if (slope > 0.2) throw new Error('Terrain is too steep for this service building.');
  return { id, type, position, roadAccessPoint: access.point,
    lot: { id: `service-lot-${id}`, width: definition.width, depth: definition.depth,
      rotation: Math.atan2(tangent.z, tangent.x), corners, baseElevation: maxHeight, slope },
    building: { id: `service-building-${id}`, definitionId: type, state: 'Operating' } };
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

/** Worker-authoritative service buildings and aggregate road-network supply. */
export class ServiceSystem {
  private facilitiesById = new Map<string, ServiceFacility>();
  private nextFacilitySerial = 1;
  private current: ServiceSnapshot = { revision: 0, facilities: [], coverage: Object.fromEntries(SERVICE_TYPES.map((type) => [type, emptyCoverage()])) as Record<ServiceType, ServiceCoverage>, buildingCoverage: {}, maintenancePerCycle: 0 };
  revision = 0;

  get facilities(): ServiceFacility[] { return [...this.facilitiesById.values()].map((facility) => structuredClone(facility)); }
  snapshot(): ServiceSnapshot { return structuredClone(this.current); }
  save(): ServiceSaveState { return { facilities: this.facilities, nextFacilitySerial: this.nextFacilitySerial }; }

  place(type: ServiceType, position: Vec2, graph: RoadGraphSnapshot,
    lots: readonly Lot[] = [], cells: readonly ZoningCell[] = [], getHeight: (x: number, z: number) => number = () => 0): ServiceFacility {
    if (!SERVICE_TYPES.includes(type) || !Number.isFinite(position.x) || !Number.isFinite(position.z)) throw new Error('Invalid service placement.');
    while (this.facilitiesById.has(`service-${this.nextFacilitySerial}`)) this.nextFacilitySerial += 1;
    const facility = makeServiceBuilding(`service-${this.nextFacilitySerial}`, type, position, graph, getHeight);
    const footprint = facility.lot.corners;
    if (this.facilities.some((other) => overlaps(footprint, other.lot.corners))
      || lots.some((lot) => overlaps(footprint, lot.corners))
      || cells.some((cell) => cell.zoneType && overlaps(footprint, cell.corners))) {
      throw new Error('Service building overlaps another lot or zoned area.');
    }
    for (const segment of graph.segments) for (let index = 1; index < segment.geometry.points.length; index += 1) {
      if (overlaps(footprint, roadFootprint(segment.geometry.points[index - 1], segment.geometry.points[index], segment.width))) {
        throw new Error('Service building overlaps a road.');
      }
    }
    this.nextFacilitySerial += 1;
    this.facilitiesById.set(facility.id, facility);
    this.revision += 1;
    return structuredClone(facility);
  }

  overlapsCell(cell: ZoningCell): boolean { return this.facilities.some((facility) => overlaps(facility.lot.corners, cell.corners)); }

  intersectsRoads(roads: readonly RoadSegment[]): boolean {
    return roads.some((segment) => segment.geometry.points.slice(1).some((end, index) => {
      const strip = roadFootprint(segment.geometry.points[index], end, segment.width);
      return this.facilities.some((facility) => overlaps(facility.lot.corners, strip));
    }));
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

  restore(saved: ServiceSaveState, graph?: RoadGraphSnapshot, getHeight: (x: number, z: number) => number = () => 0): void {
    if (!saved || !Array.isArray(saved.facilities) || !Number.isSafeInteger(saved.nextFacilitySerial) || saved.nextFacilitySerial < 1) throw new Error('Save contains invalid service data.');
    const ids = new Set<string>();
    const facilities: ServiceFacility[] = [];
    for (const raw of saved.facilities) {
      if (!raw || typeof raw.id !== 'string' || ids.has(raw.id) || !SERVICE_TYPES.includes(raw.type)
        || !Number.isFinite(raw.position?.x) || !Number.isFinite(raw.position?.z)) throw new Error('Save contains invalid service data.');
      // Early v9 previews stored a point marker. Upgrade it into a roadside lot and building.
      const facility = raw.lot && raw.building && raw.roadAccessPoint ? raw
        : graph ? makeServiceBuilding(raw.id, raw.type, raw.position, graph, getHeight)
          : undefined;
      if (!facility || facility.building.definitionId !== facility.type || facility.building.state !== 'Operating'
        || !Number.isFinite(facility.roadAccessPoint.x) || !Number.isFinite(facility.roadAccessPoint.z)
        || !Number.isFinite(facility.lot.width) || facility.lot.width <= 0
        || !Number.isFinite(facility.lot.depth) || facility.lot.depth <= 0
        || !Number.isFinite(facility.lot.baseElevation) || !Number.isFinite(facility.lot.slope)
        || !Array.isArray(facility.lot.corners) || facility.lot.corners.length !== 4
        || facility.lot.corners.some((corner) => !Number.isFinite(corner.x) || !Number.isFinite(corner.z))) {
        throw new Error('Save contains invalid service data.');
      }
      ids.add(facility.id);
      facilities.push(structuredClone(facility));
    }
    this.facilitiesById = new Map(facilities.map((facility) => [facility.id, facility]));
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
    const sources = this.facilities.map((facility) => ({ facility, anchor: nearestRoad(facility.roadAccessPoint, graph.segments) }));
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
