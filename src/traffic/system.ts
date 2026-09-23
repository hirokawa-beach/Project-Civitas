import { polylineLength } from '../roads/geometry';
import type { RoadGraphSnapshot, RoadSegment } from '../roads/types';
import type { RoadSegmentId } from '../shared/ids';
import type { Lot } from '../lots/types';
import type { BuildingOccupancy, PopulationSnapshot } from '../population/types';
import { HALF_WORLD_SIZE } from '../world/types';
import { RoadRouter } from './routing';
import type { LaneTraffic, LogicalTrip, OutsideConnection, RouteLeg, SegmentTraffic, TrafficConfig,
  TrafficSaveState, TrafficSnapshot, TripEndpoint, TripPurpose, VisibleVehicleCandidate } from './types';

export const DEFAULT_TRAFFIC_CONFIG: TrafficConfig = {
  version: 1,
  generationIntervalGameSeconds: 30,
  trafficIntervalGameSeconds: 5,
  capacityPerLane: 20,
  congestionPenalty: 0.3,
  minimumSpeedFactor: 0.25,
  intersectionDelayGameSeconds: 3,
  maxActiveTrips: 128,
  maxNewTripsPerGeneration: 32,
  maxVisibleVehicles: 40,
  visibleRadiusMeters: 220,
  vehicleSpeedScale: 0.12,
};

const legLength = (leg: RouteLeg): number => Math.abs(leg.toAlong - leg.fromAlong);
const totalRouteLength = (route: readonly RouteLeg[]): number => route.reduce((sum, leg) => sum + legLength(leg), 0);
const finiteNonnegative = (value: number): boolean => Number.isFinite(value) && value >= 0;
const integer = (value: number): boolean => Number.isSafeInteger(value);

/** Worker-authoritative macro traffic. One logical trip can represent several vehicles. */
export class TrafficSystem {
  readonly router: RoadRouter;
  private graph: RoadGraphSnapshot;
  private readonly tripsById = new Map<string, LogicalTrip>();
  private outsideConnections: OutsideConnection[] = [];
  private segmentTraffic = new Map<RoadSegmentId, SegmentTraffic>();
  private segmentById = new Map<RoadSegmentId, RoadSegment>();
  private nextTripSerial = 1;
  private nextGenerationAtGameSeconds: number;
  private nextTrafficAtGameSeconds: number;
  private generatorCursor = 0;
  private averageRoadSpeed = 0;
  private congestedSegmentCount = 0;
  revision = 0;

  constructor(graph: RoadGraphSnapshot, readonly config: TrafficConfig = DEFAULT_TRAFFIC_CONFIG, startGameSeconds = 0) {
    this.graph = structuredClone(graph);
    this.segmentById = new Map(this.graph.segments.map((segment) => [segment.id, segment]));
    this.router = new RoadRouter(config);
    this.router.updateGraph(this.graph);
    this.outsideConnections = this.deriveOutsideConnections();
    this.nextGenerationAtGameSeconds = startGameSeconds + config.generationIntervalGameSeconds;
    this.nextTrafficAtGameSeconds = startGameSeconds + config.trafficIntervalGameSeconds;
    this.rebuildTraffic();
  }

  get trips(): LogicalTrip[] { return [...this.tripsById.values()].map((trip) => structuredClone(trip)); }
  get outside(): OutsideConnection[] { return structuredClone(this.outsideConnections); }
  get segmentStates(): SegmentTraffic[] { return [...this.segmentTraffic.values()].map((item) => structuredClone(item)); }
  isDue(gameSeconds: number): boolean {
    return gameSeconds >= this.nextGenerationAtGameSeconds || gameSeconds >= this.nextTrafficAtGameSeconds;
  }

  updateGraph(graph: RoadGraphSnapshot): void {
    const changed = this.router.updateGraph(graph);
    if (changed.size === 0) return;
    this.graph = structuredClone(graph);
    this.segmentById = new Map(this.graph.segments.map((segment) => [segment.id, segment]));
    this.outsideConnections = this.deriveOutsideConnections();
    const validOutside = new Set(this.outsideConnections.map((connection) => connection.id));
    for (const trip of this.tripsById.values()) {
      if ((trip.origin.kind === 'outside' && !validOutside.has(trip.origin.id))
        || (trip.destination.kind === 'outside' && !validOutside.has(trip.destination.id))) {
        this.tripsById.delete(trip.id);
        continue;
      }
      const route = this.router.route(trip.origin, trip.destination, this.segmentTraffic);
      trip.route = route ?? [];
      trip.routeState = route ? 'routed' : 'unreachable';
      trip.progressMeters = 0;
    }
    this.rebuildTraffic();
    this.revision += 1;
  }

  reconcileLots(lots: readonly Lot[]): void {
    const byBuilding = new Map<string, Lot>(lots.filter((lot) => lot.buildingId).map((lot) => [lot.buildingId!, lot]));
    let changed = false;
    for (const [id, trip] of this.tripsById) {
      let reroute = false;
      const originLot = trip.origin.kind === 'building' ? byBuilding.get(trip.origin.id) : undefined;
      const destinationLot = trip.destination.kind === 'building' ? byBuilding.get(trip.destination.id) : undefined;
      if ((trip.origin.kind === 'building' && !originLot) || (trip.destination.kind === 'building' && !destinationLot)) {
        this.tripsById.delete(id);
        changed = true;
        continue;
      }
      const homeAtOrigin = trip.purpose === 'home-work' || trip.purpose === 'home-commercial';
      const homeAtDestination = trip.purpose === 'work-home' || trip.purpose === 'commercial-home';
      if ((homeAtOrigin && originLot?.zoneType !== 'residential')
        || (homeAtDestination && destinationLot?.zoneType !== 'residential')
        || (trip.purpose === 'home-work' && destinationLot?.zoneType === 'residential')
        || (trip.purpose === 'work-home' && originLot?.zoneType === 'residential')
        || (trip.purpose === 'home-commercial' && destinationLot?.zoneType !== 'commercial')
        || (trip.purpose === 'commercial-home' && originLot?.zoneType !== 'commercial')) {
        this.tripsById.delete(id);
        changed = true;
        continue;
      }
      for (const endpoint of [trip.origin, trip.destination]) if (endpoint.kind === 'building') {
        const lot = byBuilding.get(endpoint.id)!;
        if (endpoint.roadSegmentId !== lot.roadAccess.roadSegmentId
          || endpoint.position.x !== lot.position.x || endpoint.position.z !== lot.position.z) {
          endpoint.roadSegmentId = lot.roadAccess.roadSegmentId;
          endpoint.position = { ...lot.position };
          reroute = true;
        }
      }
      if (reroute) {
        const route = this.router.route(trip.origin, trip.destination, this.segmentTraffic);
        trip.route = route ?? [];
        trip.routeState = route ? 'routed' : 'unreachable';
        trip.progressMeters = 0;
        changed = true;
      }
    }
    if (changed) { this.rebuildTraffic(); this.revision += 1; }
  }

  /** Called every worker frame, but scans trips and roads only on due GameClock intervals. */
  tick(gameSeconds: number, population: PopulationSnapshot, lots: readonly Lot[]): boolean {
    if (gameSeconds < this.nextGenerationAtGameSeconds && gameSeconds < this.nextTrafficAtGameSeconds) return false;
    let changed = false;
    if (gameSeconds >= this.nextTrafficAtGameSeconds) {
      const elapsed = Math.min(this.config.generationIntervalGameSeconds,
        gameSeconds - (this.nextTrafficAtGameSeconds - this.config.trafficIntervalGameSeconds));
      this.advanceTrips(elapsed);
      this.nextTrafficAtGameSeconds = gameSeconds + this.config.trafficIntervalGameSeconds;
      changed = true;
    }
    if (gameSeconds >= this.nextGenerationAtGameSeconds) {
      this.router.clearCache(); // Congestion costs change between generation intervals.
      this.generateTrips(gameSeconds, population, lots);
      this.nextGenerationAtGameSeconds = gameSeconds + this.config.generationIntervalGameSeconds;
      changed = true;
    }
    if (changed) {
      this.rebuildTraffic();
      this.revision += 1;
    }
    return changed;
  }

  snapshot(): TrafficSnapshot {
    const visibleCandidates: VisibleVehicleCandidate[] = [];
    let logicalVehicles = 0;
    let activeTrips = 0;
    for (const trip of this.tripsById.values()) {
      if (trip.routeState !== 'routed') continue;
      activeTrips += 1;
      logicalVehicles += trip.vehicleCount;
      let remaining = trip.progressMeters;
      for (const leg of trip.route) {
        const length = legLength(leg);
        if (remaining > length) { remaining -= length; continue; }
        const along = leg.fromAlong + (leg.direction === 'forward' ? remaining : -remaining);
        visibleCandidates.push({ tripId: trip.id, segmentId: leg.segmentId, direction: leg.direction, along });
        break;
      }
    }
    return {
      revision: this.revision, sampleIntervalGameSeconds: this.config.trafficIntervalGameSeconds,
      activeTrips, logicalVehicles, averageRoadSpeed: this.averageRoadSpeed,
      congestedSegmentCount: this.congestedSegmentCount, outsideConnections: this.outside,
      segments: this.segmentStates, visibleCandidates,
      maxVisibleVehicles: this.config.maxVisibleVehicles, visibleRadiusMeters: this.config.visibleRadiusMeters,
    };
  }

  save(): TrafficSaveState {
    return {
      config: structuredClone(this.config), outsideConnections: this.outside, trips: this.trips,
      nextTripSerial: this.nextTripSerial, nextGenerationAtGameSeconds: this.nextGenerationAtGameSeconds,
      nextTrafficAtGameSeconds: this.nextTrafficAtGameSeconds, generatorCursor: this.generatorCursor,
    };
  }

  restore(saved: TrafficSaveState, gameSeconds: number): void {
    if (!saved || saved.config?.version !== 1
      || !integer(saved.nextTripSerial) || saved.nextTripSerial < 1
      || !finiteNonnegative(saved.nextGenerationAtGameSeconds) || !finiteNonnegative(saved.nextTrafficAtGameSeconds)
      || !integer(saved.generatorCursor) || saved.generatorCursor < 0
      || !Array.isArray(saved.trips) || saved.trips.length > this.config.maxActiveTrips
      || !Array.isArray(saved.outsideConnections)
      || JSON.stringify(saved.config) !== JSON.stringify(this.config)
      || JSON.stringify(saved.outsideConnections) !== JSON.stringify(this.outsideConnections)) {
      throw new Error('Save contains invalid traffic data.');
    }
    const seen = new Set<string>();
    this.tripsById.clear();
    for (const trip of saved.trips) {
      if (!trip || typeof trip.id !== 'string' || seen.has(trip.id)
        || !['home-work', 'work-home', 'home-commercial', 'commercial-home', 'outside-city', 'city-outside'].includes(trip.purpose)
        || trip.mode !== 'car' || !['routed', 'unreachable'].includes(trip.routeState)
        || !integer(trip.vehicleCount) || trip.vehicleCount < 1 || trip.vehicleCount > 8
        || !finiteNonnegative(trip.departureGameSeconds) || trip.departureGameSeconds > gameSeconds
        || !finiteNonnegative(trip.progressMeters) || !Array.isArray(trip.route)
        || trip.route.some((leg) => !this.graph.segments.some((segment) => segment.id === leg.segmentId)
          || !finiteNonnegative(leg.fromAlong) || !finiteNonnegative(leg.toAlong)
          || !['forward', 'backward'].includes(leg.direction))) throw new Error('Save contains invalid traffic trip.');
      seen.add(trip.id);
      this.tripsById.set(trip.id, structuredClone(trip));
    }
    this.nextTripSerial = saved.nextTripSerial;
    this.nextGenerationAtGameSeconds = saved.nextGenerationAtGameSeconds;
    this.nextTrafficAtGameSeconds = saved.nextTrafficAtGameSeconds;
    this.generatorCursor = saved.generatorCursor;
    this.rebuildTraffic();
    this.revision += 1;
  }

  private deriveOutsideConnections(): OutsideConnection[] {
    const connected = new Set(this.graph.segments.flatMap((segment) => [segment.startNodeId, segment.endNodeId]));
    return this.graph.nodes.filter((node) => connected.has(node.id)
      && (Math.abs(Math.abs(node.position.x) - HALF_WORLD_SIZE) <= 2
        || Math.abs(Math.abs(node.position.z) - HALF_WORLD_SIZE) <= 2))
      .map((node) => ({ id: `outside-${node.id}`, nodeId: node.id, position: { ...node.position } }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  private generateTrips(gameSeconds: number, population: PopulationSnapshot, lots: readonly Lot[]): void {
    const remainingSlots = Math.min(this.config.maxNewTripsPerGeneration, this.config.maxActiveTrips - this.tripsById.size);
    if (remainingSlots <= 0) return;
    const lotByBuilding = new Map(lots.filter((lot) => lot.buildingId).map((lot) => [lot.buildingId!, lot]));
    const endpoint = (occupancy: BuildingOccupancy): TripEndpoint | undefined => {
      const lot = lotByBuilding.get(occupancy.buildingId);
      return lot ? { kind: 'building', id: occupancy.buildingId, roadSegmentId: lot.roadAccess.roadSegmentId,
        position: { ...lot.position } } : undefined;
    };
    const homes = population.occupancies.filter((item) => item.active && item.zoneType === 'residential'
      && item.currentHouseholds > 0 && lotByBuilding.has(item.buildingId));
    const workplaces = population.occupancies.filter((item) => item.active && item.zoneType !== 'residential'
      && item.filledJobs > 0 && lotByBuilding.has(item.buildingId));
    const shops = population.occupancies.filter((item) => item.active && item.zoneType === 'commercial'
      && lotByBuilding.has(item.buildingId));
    let added = 0;
    const add = (origin: TripEndpoint, destination: TripEndpoint, purpose: TripPurpose, count: number): void => {
      if (added >= remainingSlots || origin.id === destination.id) return;
      const route = this.router.route(origin, destination, this.segmentTraffic);
      const trip: LogicalTrip = { id: `trip-${this.nextTripSerial++}`,
        origin: structuredClone(origin), destination: structuredClone(destination), purpose,
        departureGameSeconds: gameSeconds, mode: 'car', routeState: route ? 'routed' : 'unreachable',
        route: route ?? [], progressMeters: 0, vehicleCount: Math.min(8, Math.max(1, count)) };
      this.tripsById.set(trip.id, trip);
      added += 1;
    };
    const takeHomes = Math.min(homes.length, Math.ceil(remainingSlots / 4));
    for (let index = 0; index < takeHomes && added < remainingSlots; index += 1) {
      const home = homes[(this.generatorCursor + index) % homes.length];
      const homeEndpoint = endpoint(home)!;
      const count = Math.ceil(home.currentHouseholds / 2);
      if (workplaces.length > 0 && population.totals.employed > 0) {
        const workEndpoint = endpoint(workplaces[(this.generatorCursor + index) % workplaces.length])!;
        add(homeEndpoint, workEndpoint, 'home-work', count);
        add(workEndpoint, homeEndpoint, 'work-home', count);
      }
      if (shops.length > 0) {
        const shopEndpoint = endpoint(shops[(this.generatorCursor + index) % shops.length])!;
        add(homeEndpoint, shopEndpoint, 'home-commercial', count);
        add(shopEndpoint, homeEndpoint, 'commercial-home', count);
      }
    }
    if (homes.length > 0) this.generatorCursor = (this.generatorCursor + takeHomes) % homes.length;
    const city = homes[0] ?? workplaces[0] ?? shops[0];
    if (city && this.outsideConnections.length > 0 && added < remainingSlots) {
      const cityEndpoint = endpoint(city)!;
      const outside = this.outsideConnections[0];
      const outsideEndpoint: TripEndpoint = { kind: 'outside', id: outside.id, roadNodeId: outside.nodeId,
        position: { ...outside.position } };
      add(outsideEndpoint, cityEndpoint, 'outside-city', 1);
      add(cityEndpoint, outsideEndpoint, 'city-outside', 1);
    }
  }

  private advanceTrips(elapsedGameSeconds: number): void {
    for (const [id, trip] of this.tripsById) {
      if (trip.routeState === 'unreachable') { this.tripsById.delete(id); continue; }
      let remaining = trip.progressMeters;
      let currentSegment: RoadSegment | undefined;
      for (const leg of trip.route) {
        if (remaining <= legLength(leg)) {
          currentSegment = this.segmentById.get(leg.segmentId);
          break;
        }
        remaining -= legLength(leg);
      }
      const speed = this.segmentTraffic.get(currentSegment?.id ?? trip.route[0]?.segmentId)?.averageSpeed
        ?? currentSegment?.speedLimit ?? 30;
      trip.progressMeters += speed / 3.6 * this.config.vehicleSpeedScale * elapsedGameSeconds;
      if (trip.progressMeters >= totalRouteLength(trip.route)) this.tripsById.delete(id);
    }
  }

  private rebuildTraffic(): void {
    const next = new Map<RoadSegmentId, SegmentTraffic>();
    const lanesBySegment = new Map<RoadSegmentId, typeof this.graph.lanes>();
    for (const lane of this.graph.lanes) {
      const list = lanesBySegment.get(lane.roadSegmentId) ?? [];
      list.push(lane);
      lanesBySegment.set(lane.roadSegmentId, list);
    }
    for (const segment of this.graph.segments) {
      const lanes: LaneTraffic[] = (lanesBySegment.get(segment.id) ?? []).map((lane) => ({
        laneId: lane.id, direction: lane.direction, currentVolume: 0,
        capacity: this.config.capacityPerLane, averageSpeed: segment.speedLimit, congestionRatio: 0,
      }));
      next.set(segment.id, { segmentId: segment.id, currentVolume: 0,
        capacity: lanes.length * this.config.capacityPerLane,
        averageSpeed: segment.speedLimit, congestionRatio: 0, lanes });
    }
    for (const trip of this.tripsById.values()) if (trip.routeState === 'routed') {
      let remaining = trip.progressMeters;
      for (const leg of trip.route) {
        const length = legLength(leg);
        if (remaining > length) { remaining -= length; continue; }
        const state = next.get(leg.segmentId);
        if (!state) break;
        const lanes = state.lanes.filter((lane) => lane.direction === leg.direction);
        if (lanes.length === 0) break;
        state.currentVolume += trip.vehicleCount;
        for (const lane of lanes) lane.currentVolume += trip.vehicleCount / lanes.length;
        break;
      }
    }
    let weightedSpeed = 0;
    let totalLength = 0;
    let congested = 0;
    for (const segment of this.graph.segments) {
      const state = next.get(segment.id)!;
      state.congestionRatio = state.capacity > 0 ? state.currentVolume / state.capacity : 0;
      state.averageSpeed = segment.speedLimit * Math.max(this.config.minimumSpeedFactor,
        1 - this.config.congestionPenalty * state.congestionRatio ** 2);
      if (state.congestionRatio >= 1) congested += 1;
      for (const lane of state.lanes) {
        lane.congestionRatio = lane.capacity > 0 ? lane.currentVolume / lane.capacity : 0;
        lane.averageSpeed = segment.speedLimit * Math.max(this.config.minimumSpeedFactor,
          1 - this.config.congestionPenalty * lane.congestionRatio ** 2);
      }
      const length = polylineLength(segment.geometry.points);
      weightedSpeed += state.averageSpeed * length;
      totalLength += length;
    }
    this.segmentTraffic = next;
    this.averageRoadSpeed = totalLength > 0 ? weightedSpeed / totalLength : 0;
    this.congestedSegmentCount = congested;
  }
}
