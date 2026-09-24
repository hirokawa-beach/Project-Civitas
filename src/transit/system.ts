import { closestPointOnPolyline, distance, pointAtDistance, polylineLength } from '../roads/geometry';
import type { RoadGraphSnapshot, RoadSegment } from '../roads/types';
import { RoadRouter } from '../traffic/routing';
import { DEFAULT_TRAFFIC_CONFIG } from '../traffic/system';
import type { RouteLeg, SegmentTraffic, TripEndpoint } from '../traffic/types';
import type { Vec2 } from '../world/types';
import { HALF_WORLD_SIZE } from '../world/types';
import type { TransitGraph, TransitLine, TransitLineInput, TransitRoute, TransitSaveState, TransitServiceConfig,
  TransitSnapshot, TransitStop, TransitStopMetrics, TransitVehicle, TransitVehicleType, TransitWaitingGroup } from './types';

export const TRANSIT_VEHICLE_TYPES: Record<string, TransitVehicleType> = {
  standard: { id: 'standard', name: 'Standard bus', capacity: 40, maxSpeedKmH: 40, assetPath: null },
  minibus: { id: 'minibus', name: 'Minibus', capacity: 20, maxSpeedKmH: 40, assetPath: null },
};

export const DEFAULT_TRANSIT_CONFIG: TransitServiceConfig = {
  version: 1, operationIntervalGameSeconds: 5, stopAccessDistanceMeters: 96,
  walkingSpeedMetersPerSecond: 1.4, parkingPenaltyGameSeconds: 300,
  transferPenaltyGameSeconds: 180, maxActiveVehicles: 64, maxDeparturesPerTick: 32,
};

const DAY = 86_400;
const legLength = (leg: RouteLeg): number => Math.abs(leg.toAlong - leg.fromAlong);
const finite = (value: number): boolean => Number.isFinite(value) && value >= 0;
const safePositive = (value: number): boolean => Number.isSafeInteger(value) && value > 0;
const colorValid = (color: string): boolean => /^#[0-9a-fA-F]{6}$/.test(color);

interface PassengerCandidate { lineId: string; originStopId: string; destinationStopId: string; rideMeters: number; walkMeters: number;
  transferLineId?: string; transferStopId?: string }

export interface BusStopPlacement { stop?: TransitStop; valid: boolean; reason?: string }

/** Shared preview/authority geometry: the click chooses a road and side, then the stop snaps to its lane. */
export const planBusStopPlacement = (click: Vec2, graph: RoadGraphSnapshot,
  existing: readonly TransitStop[] = [], id = 'stop-preview', name?: string): BusStopPlacement => {
  const invalid = (reason: string): BusStopPlacement => ({ valid: false, reason });
  if (!Number.isFinite(click.x) || !Number.isFinite(click.z)) return invalid('Invalid bus stop position.');
  let best: { segment: RoadSegment; along: number; distance: number } | undefined;
  for (const segment of graph.segments) {
    const projection = closestPointOnPolyline(click, segment.geometry.points);
    if (!best || projection.distance < best.distance) best = { segment, along: projection.along, distance: projection.distance };
  }
  if (!best || best.distance > 18) return invalid('Place bus stops beside an existing road.');
  const { point, tangent } = pointAtDistance(best.segment.geometry.points, best.along);
  const side = tangent.x * (click.z - point.z) - tangent.z * (click.x - point.x);
  const direction = side < 0 ? 'backward' : 'forward';
  const lane = graph.lanes.find((item) => item.roadSegmentId === best.segment.id && item.direction === direction);
  if (!lane) return invalid('No bus-compatible lane in that direction.');
  const position = { x: point.x - tangent.z * (best.segment.width / 2 + 2) * (direction === 'forward' ? 1 : -1),
    z: point.z + tangent.x * (best.segment.width / 2 + 2) * (direction === 'forward' ? 1 : -1) };
  if (Math.abs(position.x) > HALF_WORLD_SIZE || Math.abs(position.z) > HALF_WORLD_SIZE)
    return invalid('Bus stop is outside the map.');
  if (existing.some((stop) => distance(stop.position, position) < 8)) return invalid('Another bus stop is too close.');
  const stop: TransitStop = { id, name: name?.trim() || `Stop ${id.slice(5)}`, position,
    roadSegmentId: best.segment.id, laneId: lane.id, direction, along: best.along,
    lineageId: best.segment.zoningLineageId,
    lineageAlong: best.segment.zoningLineageId ? (best.segment.zoningStartOffset ?? 0) + best.along : undefined };
  return { stop, valid: true };
};

/** Worker-authoritative, aggregate bus operation. Rendering never owns stops, buses or passengers. */
export class TransitSystem {
  private graph: RoadGraphSnapshot;
  private readonly router = new RoadRouter(DEFAULT_TRAFFIC_CONFIG);
  private stopsById = new Map<string, TransitStop>();
  private linesById = new Map<string, TransitLine>();
  private routesById = new Map<string, TransitRoute>();
  private vehiclesById = new Map<string, TransitVehicle>();
  private waitingById = new Map<string, TransitWaitingGroup>();
  private metricsByStop = new Map<string, TransitStopMetrics>();
  private nextDepartures = new Map<string, number>();
  private passengerRouteCache = new Map<string, PassengerCandidate[]>();
  private transitGraph: TransitGraph = { stopIds: [], edges: [], transferStopIds: [] };
  private nextStopSerial = 1;
  private nextLineSerial = 1;
  private nextVehicleSerial = 1;
  private nextGroupSerial = 1;
  private nextOperationAtGameSeconds: number;
  private lastOperationAtGameSeconds: number;
  private ridership = 0;
  revision = 0;

  constructor(graph: RoadGraphSnapshot, readonly config: TransitServiceConfig = DEFAULT_TRANSIT_CONFIG, gameSeconds = 0) {
    this.graph = structuredClone(graph);
    this.router.updateGraph(this.graph);
    this.lastOperationAtGameSeconds = gameSeconds;
    this.nextOperationAtGameSeconds = gameSeconds + config.operationIntervalGameSeconds;
  }

  get stops(): TransitStop[] { return [...this.stopsById.values()].map((stop) => structuredClone(stop)); }
  get lines(): TransitLine[] { return [...this.linesById.values()].map((line) => structuredClone(line)); }
  get routes(): TransitRoute[] { return [...this.routesById.values()].map((route) => structuredClone(route)); }
  get vehicles(): TransitVehicle[] { return [...this.vehiclesById.values()].map((vehicle) => structuredClone(vehicle)); }
  get waitingGroups(): TransitWaitingGroup[] { return [...this.waitingById.values()].map((group) => structuredClone(group)); }
  get routeCacheSize(): number { return this.passengerRouteCache.size; }

  placeStop(click: Vec2, name?: string): TransitStop {
    const plan = planBusStopPlacement(click, this.graph, this.stops, `stop-${this.nextStopSerial}`, name);
    if (!plan.valid || !plan.stop) throw new Error(plan.reason ?? 'Invalid bus stop position.');
    const stop = plan.stop;
    this.nextStopSerial += 1;
    this.stopsById.set(stop.id, stop);
    this.metricsByStop.set(stop.id, { stopId: stop.id, waiting: 0, boarded: 0, alighted: 0 });
    this.rebuildTransitGraph();
    this.revision += 1;
    return structuredClone(stop);
  }

  removeStop(id: string): void {
    if (!this.stopsById.delete(id)) throw new Error('Bus stop no longer exists.');
    this.metricsByStop.delete(id);
    for (const line of this.lines) if (line.stopIds.includes(id)) this.removeLine(line.id);
    this.rebuildTransitGraph();
    this.revision += 1;
  }

  createLine(input: TransitLineInput, gameSeconds: number): TransitLine {
    this.validateLineInput(input);
    const id = `line-${this.nextLineSerial}`;
    const line: TransitLine = { ...input, id, name: input.name.trim(), stopIds: [...input.stopIds], routeId: `route-${id}`,
      color: input.color ?? '#f2c75c' };
    const route = this.buildRoute(line);
    if (!route) throw new Error('Stops cannot be connected in their selected lane directions.');
    this.nextLineSerial += 1;
    this.linesById.set(id, line);
    this.routesById.set(route.id, route);
    this.nextDepartures.set(id, this.nextDeparture(line, gameSeconds));
    this.rebuildTransitGraph();
    this.revision += 1;
    return structuredClone(line);
  }

  updateLine(id: string, input: TransitLineInput, gameSeconds: number): TransitLine {
    if (!this.linesById.has(id)) throw new Error('Bus line no longer exists.');
    this.validateLineInput(input);
    const line: TransitLine = { ...input, id, name: input.name.trim(), stopIds: [...input.stopIds], routeId: `route-${id}`,
      color: input.color ?? '#f2c75c' };
    const route = this.buildRoute(line);
    if (!route) throw new Error('Stops cannot be connected in their selected lane directions.');
    this.linesById.set(id, line);
    this.routesById.set(route.id, route);
    this.nextDepartures.set(id, this.nextDeparture(line, gameSeconds));
    for (const vehicle of this.vehiclesById.values()) if (vehicle.lineId === id) this.vehiclesById.delete(vehicle.id);
    for (const group of this.waitingById.values()) if (group.lineId === id) this.waitingById.delete(group.id);
    this.rebuildTransitGraph();
    this.revision += 1;
    return structuredClone(line);
  }

  removeLine(id: string): void {
    if (!this.linesById.delete(id)) throw new Error('Bus line no longer exists.');
    this.routesById.delete(`route-${id}`);
    this.nextDepartures.delete(id);
    for (const vehicle of this.vehiclesById.values()) if (vehicle.lineId === id) this.vehiclesById.delete(vehicle.id);
    for (const group of this.waitingById.values()) if (group.lineId === id) this.waitingById.delete(group.id);
    this.rebuildTransitGraph();
    this.revision += 1;
  }

  /** Preserve a stop through a logical road split using stable road lineage; remove invalid references on demolition. */
  updateGraph(graph: RoadGraphSnapshot, gameSeconds: number): void {
    this.router.updateGraph(graph);
    this.graph = structuredClone(graph);
    const byId = new Map(graph.segments.map((segment) => [segment.id, segment]));
    let changed = false;
    for (const stop of this.stops) {
      let segment = byId.get(stop.roadSegmentId);
      if (!segment && stop.lineageId && stop.lineageAlong !== undefined) segment = graph.segments.find((candidate) =>
        candidate.zoningLineageId === stop.lineageId
        && stop.lineageAlong! >= (candidate.zoningStartOffset ?? 0) - 0.1
        && stop.lineageAlong! <= (candidate.zoningStartOffset ?? 0) + polylineLength(candidate.geometry.points) + 0.1);
      if (!segment) { this.stopsById.delete(stop.id); this.metricsByStop.delete(stop.id); changed = true; continue; }
      const lane = graph.lanes.find((item) => item.roadSegmentId === segment!.id && item.direction === stop.direction);
      if (!lane) { this.stopsById.delete(stop.id); this.metricsByStop.delete(stop.id); changed = true; continue; }
      const along = stop.lineageId && segment.zoningLineageId === stop.lineageId && stop.lineageAlong !== undefined
        ? Math.max(0, Math.min(polylineLength(segment.geometry.points), stop.lineageAlong - (segment.zoningStartOffset ?? 0)))
        : closestPointOnPolyline(stop.position, segment.geometry.points).along;
      const { point, tangent } = pointAtDistance(segment.geometry.points, along);
      const side = stop.direction === 'forward' ? 1 : -1;
      const next: TransitStop = { ...stop, roadSegmentId: segment.id, laneId: lane.id, along,
        position: { x: point.x - tangent.z * (segment.width / 2 + 2) * side,
          z: point.z + tangent.x * (segment.width / 2 + 2) * side } };
      if (JSON.stringify(next) !== JSON.stringify(stop)) changed = true;
      this.stopsById.set(stop.id, next);
    }
    for (const line of this.lines) {
      if (line.stopIds.some((id) => !this.stopsById.has(id))) { this.removeLine(line.id); changed = true; continue; }
      const route = this.buildRoute(line);
      if (route) this.routesById.set(route.id, route);
      else { this.removeLine(line.id); changed = true; }
    }
    if (changed) this.revision += 1;
    this.rebuildTransitGraph();
    for (const line of this.lines) if (!this.nextDepartures.has(line.id)) this.nextDepartures.set(line.id, this.nextDeparture(line, gameSeconds));
  }

  /** Direct-line mode choice. A cache holds topology candidates, not per-passenger paths or mutable waiting time. */
  offerTrip(origin: TripEndpoint, destination: TripEndpoint, count: number, carCostSeconds: number,
    gameSeconds: number, traffic: readonly SegmentTraffic[]): boolean {
    if (origin.kind !== 'building' || destination.kind !== 'building' || count <= 0) return false;
    const key = `${origin.id}>${destination.id}`;
    let candidates = this.passengerRouteCache.get(key);
    if (!candidates) {
      candidates = [];
      const origins = this.stops.filter((stop) => distance(stop.position, origin.position) <= this.config.stopAccessDistanceMeters);
      const destinations = this.stops.filter((stop) => distance(stop.position, destination.position) <= this.config.stopAccessDistanceMeters);
      for (const line of this.lines) {
        const route = this.routesById.get(line.routeId);
        if (!route) continue;
        for (const from of origins) for (const to of destinations) {
          const a = line.stopIds.indexOf(from.id); const b = line.stopIds.indexOf(to.id);
          if (a < 0 || b <= a) continue;
          candidates.push({ lineId: line.id, originStopId: from.id, destinationStopId: to.id,
            rideMeters: route.stopOffsetsMeters[b] - route.stopOffsetsMeters[a],
            walkMeters: distance(origin.position, from.position) + distance(to.position, destination.position) });
        }
      }
      // One shared-stop transfer is enough for this foundation. Deeper transfer search belongs to later transit work.
      for (const first of this.lines) for (const second of this.lines) {
        if (first.id === second.id) continue;
        const firstRoute = this.routesById.get(first.routeId); const secondRoute = this.routesById.get(second.routeId);
        if (!firstRoute || !secondRoute) continue;
        for (const from of origins) for (const to of destinations) {
          const start = first.stopIds.indexOf(from.id); const end = second.stopIds.indexOf(to.id);
          if (start < 0 || end < 0) continue;
          for (const transferId of first.stopIds) {
            const firstTransfer = first.stopIds.indexOf(transferId);
            const secondTransfer = second.stopIds.indexOf(transferId);
            if (firstTransfer <= start || secondTransfer < 0 || secondTransfer >= end) continue;
            candidates.push({ lineId: first.id, originStopId: from.id, destinationStopId: to.id,
              transferLineId: second.id, transferStopId: transferId,
              rideMeters: firstRoute.stopOffsetsMeters[firstTransfer] - firstRoute.stopOffsetsMeters[start]
                + secondRoute.stopOffsetsMeters[end] - secondRoute.stopOffsetsMeters[secondTransfer],
              walkMeters: distance(origin.position, from.position) + distance(to.position, destination.position) });
          }
        }
      }
      this.passengerRouteCache.set(key, candidates);
    }
    const byTraffic = new Map(traffic.map((item) => [item.segmentId, item]));
    let best: PassengerCandidate | undefined;
    let bestCost = Infinity;
    for (const candidate of candidates) {
      const line = this.linesById.get(candidate.lineId);
      const route = line && this.routesById.get(line.routeId);
      if (!line || !route) continue;
      const next = this.nextDepartures.get(line.id) ?? this.nextDeparture(line, gameSeconds);
      if (next - gameSeconds > line.frequencySeconds * 2) continue;
      const rideLegs = route.legs;
      const speed = rideLegs.length > 0 ? rideLegs.reduce((sum, leg) => sum + (byTraffic.get(leg.segmentId)?.averageSpeed ?? 35), 0) / rideLegs.length : 35;
      const cost = candidate.walkMeters / this.config.walkingSpeedMetersPerSecond
        + Math.max(0, next - gameSeconds) + candidate.rideMeters / Math.max(1, speed / 3.6) / DEFAULT_TRAFFIC_CONFIG.vehicleSpeedScale
        + (candidate.transferLineId ? this.config.transferPenaltyGameSeconds
          + (this.linesById.get(candidate.transferLineId)?.frequencySeconds ?? 0) / 2 : 0);
      if (cost < bestCost) { bestCost = cost; best = candidate; }
    }
    if (!best || bestCost >= carCostSeconds) return false;
    const id = `passenger-group-${this.nextGroupSerial++}`;
    this.waitingById.set(id, { id, lineId: best.lineId, originStopId: best.originStopId,
      destinationStopId: best.transferStopId ?? best.destinationStopId,
      transferLineId: best.transferLineId,
      finalStopId: best.transferStopId ? best.destinationStopId : undefined,
      count: Math.max(1, Math.floor(count)), requestedAtGameSeconds: gameSeconds });
    this.revision += 1;
    return true;
  }

  isDue(gameSeconds: number): boolean { return gameSeconds >= this.nextOperationAtGameSeconds; }

  tick(gameSeconds: number, traffic: readonly SegmentTraffic[]): boolean {
    if (!this.isDue(gameSeconds)) return false;
    const elapsed = Math.max(0, gameSeconds - this.lastOperationAtGameSeconds);
    this.lastOperationAtGameSeconds = gameSeconds;
    this.nextOperationAtGameSeconds = gameSeconds + this.config.operationIntervalGameSeconds;
    const fresh = new Set<string>();
    let remainingDepartures = this.config.maxDeparturesPerTick;
    for (const line of this.linesById.values()) {
      let next = this.nextDepartures.get(line.id) ?? this.nextDeparture(line, gameSeconds);
      while (next <= gameSeconds && remainingDepartures > 0) {
        if (this.routesById.has(line.routeId) && this.vehiclesById.size < this.config.maxActiveVehicles) {
          const id = `bus-${this.nextVehicleSerial++}`;
          const vehicle: TransitVehicle = { id, lineId: line.id, routeId: line.routeId, vehicleTypeId: line.vehicleTypeId,
            departedAtGameSeconds: next, progressMeters: 0, nextStopIndex: 1, onboard: [] };
          this.vehiclesById.set(id, vehicle);
          this.exchangePassengers(vehicle, line.stopIds[0]);
          fresh.add(id);
        }
        next = this.nextDeparture(line, next + 0.01);
        remainingDepartures -= 1;
      }
      if (next <= gameSeconds) next = this.nextDeparture(line, gameSeconds + 0.01);
      this.nextDepartures.set(line.id, next);
    }
    const states = new Map(traffic.map((item) => [item.segmentId, item]));
    for (const vehicle of this.vehiclesById.values()) {
      if (fresh.has(vehicle.id)) continue;
      const line = this.linesById.get(vehicle.lineId);
      const route = this.routesById.get(vehicle.routeId);
      if (!line || !route) { this.vehiclesById.delete(vehicle.id); continue; }
      let remaining = vehicle.progressMeters;
      const current = route.legs.find((leg) => { if (remaining <= legLength(leg)) return true; remaining -= legLength(leg); return false; });
      const segmentSpeed = current ? states.get(current.segmentId)?.averageSpeed : undefined;
      const type = TRANSIT_VEHICLE_TYPES[vehicle.vehicleTypeId];
      const speed = Math.min(type.maxSpeedKmH, segmentSpeed ?? type.maxSpeedKmH);
      const advanced = vehicle.progressMeters + speed / 3.6 * DEFAULT_TRAFFIC_CONFIG.vehicleSpeedScale * elapsed;
      while (vehicle.nextStopIndex < line.stopIds.length && advanced >= route.stopOffsetsMeters[vehicle.nextStopIndex]) {
        this.exchangePassengers(vehicle, line.stopIds[vehicle.nextStopIndex]);
        vehicle.nextStopIndex += 1;
      }
      vehicle.progressMeters = Math.min(route.lengthMeters, advanced);
      if (vehicle.progressMeters >= route.lengthMeters) this.vehiclesById.delete(vehicle.id);
    }
    this.revision += 1;
    return true;
  }

  snapshot(): TransitSnapshot {
    const stopMetrics = this.stops.map((stop) => ({ ...(this.metricsByStop.get(stop.id) ?? { stopId: stop.id, waiting: 0, boarded: 0, alighted: 0 }), waiting: 0 }));
    const byId = new Map(stopMetrics.map((item) => [item.stopId, item]));
    for (const group of this.waitingById.values()) { const metric = byId.get(group.originStopId); if (metric) metric.waiting += group.count; }
    return { revision: this.revision, stops: this.stops, lines: this.lines, routes: this.routes, vehicles: this.vehicles,
      stopMetrics, activeVehicles: this.vehiclesById.size,
      waitingPassengers: [...this.waitingById.values()].reduce((sum, group) => sum + group.count, 0),
      ridership: this.ridership, routeCacheSize: this.passengerRouteCache.size, graph: structuredClone(this.transitGraph) };
  }

  save(): TransitSaveState {
    return { config: structuredClone(this.config), stops: this.stops, lines: this.lines, vehicles: this.vehicles,
      waitingGroups: this.waitingGroups, stopMetrics: this.snapshot().stopMetrics, nextStopSerial: this.nextStopSerial,
      nextLineSerial: this.nextLineSerial, nextVehicleSerial: this.nextVehicleSerial, nextGroupSerial: this.nextGroupSerial,
      nextDepartures: [...this.nextDepartures].map(([lineId, gameSeconds]) => ({ lineId, gameSeconds })),
      nextOperationAtGameSeconds: this.nextOperationAtGameSeconds,
      lastOperationAtGameSeconds: this.lastOperationAtGameSeconds, ridership: this.ridership };
  }

  restore(saved: TransitSaveState, gameSeconds: number): void {
    if (!saved || JSON.stringify(saved.config) !== JSON.stringify(this.config)
      || !Array.isArray(saved.stops) || !Array.isArray(saved.lines) || !Array.isArray(saved.vehicles)
      || !Array.isArray(saved.waitingGroups) || !Array.isArray(saved.stopMetrics) || !Array.isArray(saved.nextDepartures)
      || !safePositive(saved.nextStopSerial) || !safePositive(saved.nextLineSerial)
      || !safePositive(saved.nextVehicleSerial) || !safePositive(saved.nextGroupSerial)
      || !finite(saved.nextOperationAtGameSeconds) || !finite(saved.lastOperationAtGameSeconds)
      || !finite(saved.ridership) || saved.lastOperationAtGameSeconds > gameSeconds)
      throw new Error('Save contains invalid transit data.');
    const stops = new Map<string, TransitStop>();
    for (const stop of saved.stops) {
      if (!stop || typeof stop.id !== 'string' || stops.has(stop.id) || !this.graph.segments.some((s) => s.id === stop.roadSegmentId)
        || !this.graph.lanes.some((lane) => lane.id === stop.laneId && lane.roadSegmentId === stop.roadSegmentId && lane.direction === stop.direction)
        || !finite(stop.along) || !Number.isFinite(stop.position?.x) || !Number.isFinite(stop.position?.z))
        throw new Error('Save contains invalid transit stop.');
      stops.set(stop.id, structuredClone(stop));
    }
    this.stopsById = stops;
    const lines = new Map<string, TransitLine>(); const routes = new Map<string, TransitRoute>();
    for (const line of saved.lines) {
      if (!line || typeof line.id !== 'string' || lines.has(line.id)) throw new Error('Save contains invalid transit line.');
      this.validateLineInput(line);
      const route = this.buildRoute(line);
      if (!route) throw new Error('Save contains an unreachable transit line.');
      lines.set(line.id, structuredClone(line)); routes.set(route.id, route);
    }
    this.linesById = lines; this.routesById = routes;
    const vehicles = new Map<string, TransitVehicle>();
    for (const vehicle of saved.vehicles) {
      if (!vehicle || typeof vehicle.id !== 'string' || vehicles.has(vehicle.id)
        || !lines.has(vehicle.lineId) || !routes.has(vehicle.routeId)
        || !finite(vehicle.progressMeters) || vehicle.progressMeters > routes.get(vehicle.routeId)!.lengthMeters
        || !Number.isSafeInteger(vehicle.nextStopIndex) || !Array.isArray(vehicle.onboard)
        || vehicle.onboard.some((item) => !stops.has(item.destinationStopId) || !finite(item.count)
          || (item.transferLineId && (!lines.has(item.transferLineId) || !item.finalStopId || !stops.has(item.finalStopId)))))
        throw new Error('Save contains invalid transit vehicle.');
      vehicles.set(vehicle.id, structuredClone(vehicle));
    }
    const waiting = new Map<string, TransitWaitingGroup>();
    for (const group of saved.waitingGroups) {
      if (!group || typeof group.id !== 'string' || waiting.has(group.id) || !lines.has(group.lineId)
        || !stops.has(group.originStopId) || !stops.has(group.destinationStopId)
        || !safePositive(group.count) || !finite(group.requestedAtGameSeconds)
        || (group.transferLineId && (!lines.has(group.transferLineId) || !group.finalStopId || !stops.has(group.finalStopId))))
        throw new Error('Save contains invalid transit passenger group.');
      waiting.set(group.id, structuredClone(group));
    }
    const metrics = new Map<string, TransitStopMetrics>();
    for (const metric of saved.stopMetrics) {
      if (!metric || !stops.has(metric.stopId) || metrics.has(metric.stopId)
        || !finite(metric.boarded) || !finite(metric.alighted)) throw new Error('Save contains invalid transit stop metrics.');
      metrics.set(metric.stopId, { ...metric, waiting: 0 });
    }
    const departures = new Map<string, number>();
    for (const item of saved.nextDepartures) {
      if (!item || !lines.has(item.lineId) || departures.has(item.lineId) || !finite(item.gameSeconds))
        throw new Error('Save contains invalid bus departures.');
      departures.set(item.lineId, item.gameSeconds);
    }
    this.vehiclesById = vehicles; this.waitingById = waiting; this.metricsByStop = metrics;
    this.nextDepartures = departures;
    this.nextStopSerial = saved.nextStopSerial; this.nextLineSerial = saved.nextLineSerial;
    this.nextVehicleSerial = saved.nextVehicleSerial; this.nextGroupSerial = saved.nextGroupSerial;
    this.nextOperationAtGameSeconds = saved.nextOperationAtGameSeconds;
    this.lastOperationAtGameSeconds = saved.lastOperationAtGameSeconds;
    this.ridership = saved.ridership;
    this.rebuildTransitGraph();
    this.revision += 1;
  }

  private validateLineInput(input: TransitLineInput): void {
    if (!input || !input.name?.trim() || input.name.length > 80 || !Array.isArray(input.stopIds)
      || input.stopIds.length < 2 || input.stopIds.length > 64 || new Set(input.stopIds).size !== input.stopIds.length
      || input.stopIds.some((id) => !this.stopsById.has(id))
      || !Number.isSafeInteger(input.serviceStartSeconds) || input.serviceStartSeconds < 0 || input.serviceStartSeconds >= DAY
      || !Number.isSafeInteger(input.serviceEndSeconds) || input.serviceEndSeconds <= input.serviceStartSeconds || input.serviceEndSeconds > DAY
      || !Number.isSafeInteger(input.frequencySeconds) || input.frequencySeconds < 30 || input.frequencySeconds > 7200
      || !TRANSIT_VEHICLE_TYPES[input.vehicleTypeId]
      || (input.color !== undefined && !colorValid(input.color))) throw new Error('Invalid bus line settings or stop order.');
  }

  private buildRoute(line: TransitLine): TransitRoute | undefined {
    const legs: RouteLeg[] = []; const offsets = [0];
    for (let index = 1; index < line.stopIds.length; index += 1) {
      const from = this.stopsById.get(line.stopIds[index - 1]); const to = this.stopsById.get(line.stopIds[index]);
      if (!from || !to) return undefined;
      const route = this.router.route({ kind: 'building', id: from.id, position: from.position, roadSegmentId: from.roadSegmentId },
        { kind: 'building', id: to.id, position: to.position, roadSegmentId: to.roadSegmentId }, new Map());
      if (!route || route.length === 0 || route[0].direction !== from.direction || route[route.length - 1].direction !== to.direction)
        return undefined;
      const length = route.reduce((sum, leg) => sum + legLength(leg), 0);
      if (length < 1) return undefined;
      legs.push(...route); offsets.push(offsets[offsets.length - 1] + length);
    }
    return { id: line.routeId, lineId: line.id, legs, stopOffsetsMeters: offsets, lengthMeters: offsets[offsets.length - 1] };
  }

  private nextDeparture(line: TransitLine, after: number): number {
    const day = Math.floor(after / DAY);
    const todayStart = day * DAY + line.serviceStartSeconds;
    const todayEnd = day * DAY + line.serviceEndSeconds;
    if (after <= todayStart) return todayStart;
    const offset = Math.ceil((after - todayStart) / line.frequencySeconds);
    const candidate = todayStart + offset * line.frequencySeconds;
    return candidate <= todayEnd ? candidate : (day + 1) * DAY + line.serviceStartSeconds;
  }

  private exchangePassengers(vehicle: TransitVehicle, stopId: string): void {
    const metric = this.metricsByStop.get(stopId);
    if (!metric) return;
    for (const passenger of vehicle.onboard) if (passenger.destinationStopId === stopId) {
      metric.alighted += passenger.count;
      if (passenger.transferLineId && passenger.finalStopId) {
        const id = `passenger-group-${this.nextGroupSerial++}`;
        this.waitingById.set(id, { id, lineId: passenger.transferLineId, originStopId: stopId,
          destinationStopId: passenger.finalStopId, count: passenger.count,
          requestedAtGameSeconds: this.lastOperationAtGameSeconds });
      }
    }
    vehicle.onboard = vehicle.onboard.filter((passenger) => passenger.destinationStopId !== stopId);
    const line = this.linesById.get(vehicle.lineId)!;
    const capacity = TRANSIT_VEHICLE_TYPES[vehicle.vehicleTypeId].capacity;
    let available = capacity - vehicle.onboard.reduce((sum, item) => sum + item.count, 0);
    if (available <= 0) return;
    const stopIndex = line.stopIds.indexOf(stopId);
    for (const group of this.waitingById.values()) {
      if (available <= 0) break;
      if (group.lineId !== vehicle.lineId || group.originStopId !== stopId
        || line.stopIds.indexOf(group.destinationStopId) <= stopIndex) continue;
      const count = Math.min(group.count, available);
      group.count -= count; available -= count;
      const onboard = vehicle.onboard.find((item) => item.destinationStopId === group.destinationStopId
        && item.transferLineId === group.transferLineId && item.finalStopId === group.finalStopId);
      if (onboard) onboard.count += count;
      else vehicle.onboard.push({ destinationStopId: group.destinationStopId, count,
        ...(group.transferLineId ? { transferLineId: group.transferLineId, finalStopId: group.finalStopId } : {}) });
      metric.boarded += count; this.ridership += count;
      if (group.count === 0) this.waitingById.delete(group.id);
    }
  }

  private rebuildTransitGraph(): void {
    const edges: TransitGraph['edges'] = [];
    const stopLines = new Map<string, Set<string>>();
    for (const line of this.linesById.values()) {
      const route = this.routesById.get(line.routeId);
      if (!route) continue;
      for (let index = 0; index < line.stopIds.length; index += 1) {
        const set = stopLines.get(line.stopIds[index]) ?? new Set<string>(); set.add(line.id); stopLines.set(line.stopIds[index], set);
        if (index + 1 < line.stopIds.length) edges.push({ fromStopId: line.stopIds[index], toStopId: line.stopIds[index + 1],
          lineId: line.id, routeMeters: route.stopOffsetsMeters[index + 1] - route.stopOffsetsMeters[index] });
      }
    }
    this.transitGraph = { stopIds: [...this.stopsById.keys()], edges,
      transferStopIds: [...stopLines].filter(([, lines]) => lines.size > 1).map(([id]) => id) };
    this.passengerRouteCache.clear();
  }
}
