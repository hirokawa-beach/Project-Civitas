import type { Lot } from '../lots/types';
import type { BuildingOccupancy, Household } from '../population/types';
import type { RoadGraphSnapshot } from '../roads/types';
import type { TransitStop } from '../transit/types';
import type { Vec2 } from '../world/types';
import { buildPedestrianGraph, type PedestrianGraph } from '../visual/pedestrianGraph';
import { buildingLabel, citizenName, stableHash } from './identity';
import { PedestrianRouter, pedestrianPose, polylineLength } from './routing';
import type { Citizen, CitizenCandidate, CitizenJourney, CitizenPlace, CitizenSaveState } from './types';
import { PerformanceLedger } from '../performance/metrics';

const CELL = 64;
const cellKey = (x: number, z: number) => `${x}:${z}`;
interface Event { at: number; id: string }
class EventQueue {
  private items: Event[] = [];
  clear(): void { this.items = []; }
  peek(): Event | undefined { return this.items[0]; }
  push(event: Event): void {
    const items = this.items; items.push(event); let index = items.length - 1;
    while (index > 0) { const parent = (index - 1) >> 1;
      if (items[parent].at <= event.at) break;
      items[index] = items[parent]; index = parent;
    }
    items[index] = event;
  }
  pop(): Event | undefined {
    const first = this.items[0]; const tail = this.items.pop();
    if (!this.items.length || !tail) return first;
    let index = 0;
    while (index * 2 + 1 < this.items.length) {
      let child = index * 2 + 1;
      if (child + 1 < this.items.length && this.items[child + 1].at < this.items[child].at) child++;
      if (this.items[child].at >= tail.at) break;
      this.items[index] = this.items[child]; index = child;
    }
    this.items[index] = tail; return first;
  }
}

/** Individual identities and journeys live in the worker. Only nearby walkers cross to the renderer. */
export class CitizenSystem {
  readonly performance = new PerformanceLedger();
  lastQueryCount = 0;
  get activeJourneys(): number { return this.cellsByWalker.size - this.dwellers.size + this.drivers.size; }
  get pathfindingPerformance() { return this.router.performance.report(); }
  private residents = new Map<string, Citizen>();
  private buildings = new Map<string, CitizenPlace>();
  private shops: CitizenPlace[] = [];
  private strolls: CitizenPlace[] = [];
  private strollsByHome = new Map<string, CitizenPlace[]>();
  private graph: PedestrianGraph = { nodes: [], edges: [] };
  private graphSignature = '';
  private readonly router = new PedestrianRouter();
  private readonly events = new EventQueue();
  private readonly walkersByCell = new Map<string, Set<string>>();
  private readonly cellsByWalker = new Map<string, string[]>();
  private readonly drivers = new Set<string>();
  private readonly visualCandidates = new Map<string, CitizenCandidate>();
  private readonly visualRoutes = new Map<string, CitizenCandidate['route']>();
  private readonly transitVisuals = new Map<string, CitizenCandidate>();
  private readonly dwellers = new Set<string>();
  routeToStop(citizen: Citizen, stop: TransitStop): Vec2[] | null {
    return this.router.route(citizen.journey?.origin.nodeId ?? citizen.location.nodeId, `stop:${stop.id}`);
  }
  transitCandidate(id: string, stop: TransitStop, requestedAt: number, readyAt: number | undefined, now: number): CitizenCandidate | undefined {
    const citizen = this.residents.get(id); const journey = citizen?.journey;
    if (!citizen || journey?.mode !== 'transit') return;
    const key = `${id}:${stop.id}:${requestedAt}`;
    let candidate = this.transitVisuals.get(key);
    if (!candidate) {
      const route = readyAt !== undefined ? this.routeToStop(citizen, stop) : null;
      const destination = { id: stop.id, label: stop.name, nodeId: `stop:${stop.id}`, position: { ...stop.position } };
      candidate = { id, name: citizen.name, homeBuildingId: citizen.homeBuildingId, workBuildingId: citizen.workBuildingId,
        activity: journey.activity, origin: structuredClone(journey.origin), destination,
        route: route ? structuredClone(route) : [{ ...stop.position }, { ...stop.position }],
        length: route ? polylineLength(route) : 0, speed: journey.speed, departedAt: requestedAt, state: 'transit-access' };
      if (this.transitVisuals.size >= Math.max(4096, this.drivers.size * 2)) this.transitVisuals.clear();
      this.transitVisuals.set(key, candidate);
    }
    if (readyAt !== undefined && now < readyAt && candidate.length > 0) return candidate;
    // Stable worker-derived stop queue positions belonging to actual waiting passenger identities.
    return { ...candidate, state: 'waiting', stationaryPosition: {
      x: stop.position.x + (stableHash(`queue-x:${stop.id}:${id}`) - .5) * 32,
      z: stop.position.z + 2 + stableHash(`queue-z:${id}:${stop.id}`) * 12,
    } };
  }
  alight(id: string, stop: TransitStop, at: number): void {
    const citizen = this.residents.get(id); const journey = citizen?.journey;
    if (!citizen || journey?.mode !== 'transit') return;
    const route = this.router.route(`stop:${stop.id}`, journey.destination.nodeId);
    if (!route || polylineLength(route) < .01) { this.drivers.delete(id); this.arrive(citizen, at); return; }
    citizen.journey = { ...journey, mode: 'walk', tripId: undefined,
      origin: { id: stop.id, label: stop.name, nodeId: `stop:${stop.id}`, position: { ...stop.position } },
      route, length: polylineLength(route), departedAt: at };
    this.drivers.delete(id); this.indexWalker(citizen);
    this.visualCandidates.get(id)!.state = 'alighting';
    this.events.push({ id, at: at + citizen.journey.length / citizen.journey.speed });
  }
  private restored = false;
  get count(): number { return this.residents.size; }
  has(id: string): boolean { return this.residents.has(id); }
  get(id: string): Citizen | undefined { const resident = this.residents.get(id); return resident && structuredClone(resident); }
  save(): CitizenSaveState { return { version: 1, residents: [...this.residents.values()].map((resident) => structuredClone(resident)) }; }

  sync(households: readonly Household[], occupancies: readonly BuildingOccupancy[], lots: readonly Lot[],
    roads: RoadGraphSnapshot, stops: readonly TransitStop[], now: number): void {
    this.buildings = new Map(lots.filter((lot) => lot.buildingId).map((lot) => [lot.buildingId!, {
      id: lot.buildingId!, buildingId: lot.buildingId!, label: buildingLabel(lot.buildingId!, lot.zoneType),
      position: { x: (lot.roadAccess.frontage[0].x + lot.roadAccess.frontage[1].x) / 2,
        z: (lot.roadAccess.frontage[0].z + lot.roadAccess.frontage[1].z) / 2 }, nodeId: `building:${lot.buildingId}`,
    }]));
    const signature = JSON.stringify([roads.segments, lots.map((lot) => [lot.buildingId, lot.roadAccess]), stops]);
    const graphChanged = signature !== this.graphSignature;
    if (graphChanged) {
      this.graphSignature = signature;
      this.graph = buildPedestrianGraph(roads, lots, stops); this.router.update(this.graph);
      this.strolls = this.graph.nodes.filter((node) => node.kind === 'sidewalk').map((node) => ({
        id: node.id, label: '近所の散歩先', position: node.point, nodeId: node.id,
      }));
      this.strollsByHome.clear();
    }
    this.shops = occupancies.filter((item) => item.active && item.zoneType === 'commercial')
      .map((item) => this.buildings.get(item.buildingId)).filter((place): place is CitizenPlace => !!place);
    const jobs = occupancies.filter((item) => item.active && item.zoneType !== 'residential' && item.filledJobs > 0);
    let jobIndex = 0; let assignedAtJob = 0;
    const nodeIds = new Set(this.graph.nodes.map((node) => node.id));
    const activeIds = new Set<string>();
    for (const household of households) for (let member = 0; member < household.householdSize; member++) {
      const id = `citizen-${household.id.slice('household-'.length)}-${member}`;
      const home = this.buildings.get(household.homeBuildingId);
      if (!home) continue;
      activeIds.add(id);
      let resident = this.residents.get(id);
      if (this.restored && !resident) throw new Error('Save is missing a citizen.');
      if (!resident) resident = { id, name: citizenName(household.id, id), householdId: household.id, member,
        homeBuildingId: household.homeBuildingId, location: structuredClone(home), activity: 'home',
        nextDepartureAt: now + 20 + stableHash(`${id}:departure`) * 400, journeysCompleted: 0 };
      if (this.restored && (resident.householdId !== household.id || resident.member !== member
        || resident.homeBuildingId !== household.homeBuildingId)) throw new Error('Save contains inconsistent citizen identity.');
      if (this.restored && (resident.journey && (resident.journey.departedAt > now
        || !nodeIds.has(resident.journey.origin.nodeId) || !nodeIds.has(resident.journey.destination.nodeId))))
        throw new Error('Save contains inconsistent citizen journey.');
      resident.homeBuildingId = household.homeBuildingId;
      resident.workBuildingId = undefined;
      if (member < household.employedCount && jobs[jobIndex]) {
        resident.workBuildingId = jobs[jobIndex].buildingId;
        if (++assignedAtJob >= jobs[jobIndex].filledJobs) { jobIndex++; assignedAtJob = 0; }
      }
      if (resident.journey?.destination.buildingId && !this.buildings.has(resident.journey.destination.buildingId)) {
        resident.journey = undefined; resident.location = structuredClone(home); resident.activity = 'home';
        resident.nextDepartureAt = now + 60;
      }
      if (graphChanged && resident.journey?.mode === 'walk' && !this.restored) {
        const route = this.router.route(resident.journey.origin.nodeId, resident.journey.destination.nodeId);
        if (!route) {
          resident.journey = undefined; resident.location = structuredClone(home); resident.activity = 'home';
          resident.nextDepartureAt = now + 60;
        } else if (JSON.stringify(route) !== JSON.stringify(resident.journey.route)) {
          resident.journey.route = route; resident.journey.length = polylineLength(route); resident.journey.departedAt = now;
        }
      }
      if (!resident.journey && (resident.location.buildingId
        ? !this.buildings.has(resident.location.buildingId) : !nodeIds.has(resident.location.nodeId))) {
        resident.location = structuredClone(home); resident.activity = 'home';
      }
      this.residents.set(id, resident);
    }
    if (this.restored && [...this.residents.keys()].some((id) => !activeIds.has(id)))
      throw new Error('Save contains orphan citizens.');
    for (const [id, resident] of this.residents) if (!activeIds.has(id)) {
      this.residents.delete(id);
    }
    this.restored = false;
    this.events.clear(); this.walkersByCell.clear(); this.cellsByWalker.clear(); this.drivers.clear();
    this.visualCandidates.clear(); this.visualRoutes.clear(); this.transitVisuals.clear();
    this.dwellers.clear();
    for (const resident of this.residents.values()) {
      if (resident.journey && resident.journey.mode !== 'walk') this.drivers.add(resident.id);
      else if (resident.journey) {
        this.indexWalker(resident); this.events.push({ id: resident.id, at: resident.journey.departedAt + resident.journey.length / resident.journey.speed });
      } else { this.events.push({ id: resident.id, at: resident.nextDepartureAt }); this.indexDweller(resident); }
    }
  }

  tick(now: number, createCar: (citizen: Citizen, origin: CitizenPlace, destination: CitizenPlace) => string | null,
    carExists: (tripId: string) => boolean): void {
    this.performance.measure('citizenEventsMs', () => this.processEvents(now, createCar, carExists));
  }
  private processEvents(now: number, createCar: (citizen: Citizen, origin: CitizenPlace, destination: CitizenPlace) => string | null,
    carExists: (tripId: string) => boolean): void {
    for (const id of this.drivers) {
      const citizen = this.residents.get(id);
      if (!citizen?.journey?.tripId || !carExists(citizen.journey.tripId)) {
        this.drivers.delete(id); if (citizen?.journey) this.arrive(citizen, now);
      }
    }
    // Bound departures per worker tick; the event queue avoids scanning the whole population each frame.
    let processed = 0;
    while (this.events.peek() && this.events.peek()!.at <= now && processed++ < 256) {
      const event = this.events.pop()!; const citizen = this.residents.get(event.id);
      if (!citizen) continue;
      if (citizen.journey) { this.arrive(citizen, now); continue; }
      if (this.dwellers.has(citizen.id)) this.removeWalker(citizen.id);
      const destination = this.chooseDestination(citizen, now);
      if (!destination) { this.schedule(citizen, now + 120); continue; }
      const walkingRoute = this.router.route(citizen.location.nodeId, destination.place.nodeId);
      // A bridge can connect roads without providing a sidewalk connection.
      // Its car trip still follows the authoritative road route; this fallback is never drawn as a walk.
      const route = walkingRoute ?? [{ ...citizen.location.position }, { ...destination.place.position }];
      const length = polylineLength(route);
      const journey: CitizenJourney = { mode: 'walk', origin: structuredClone(citizen.location), destination: structuredClone(destination.place),
        activity: destination.activity, departedAt: now, route, length, speed: 1.05 + stableHash(`${citizen.id}:speed`) * .5 };
      if ((!walkingRoute || length > 75) && citizen.location.buildingId && destination.place.buildingId
        && (!walkingRoute || stableHash(`${citizen.id}:mode`) < .55)) {
        const tripId = createCar(citizen, citizen.location, destination.place);
        if (tripId) { journey.mode = tripId.startsWith('transit:') ? 'transit' : 'car'; journey.tripId = tripId; this.drivers.add(citizen.id); }
      }
      if (!walkingRoute && journey.mode === 'walk') { this.schedule(citizen, now + 120); continue; }
      citizen.journey = journey; citizen.activity = destination.activity;
      if (journey.mode === 'walk') {
        this.indexWalker(citizen); this.events.push({ id: citizen.id, at: now + length / journey.speed });
      }
    }
  }

  private chooseDestination(citizen: Citizen, now: number): { place: CitizenPlace; activity: CitizenJourney['activity'] } | undefined {
    const home = this.buildings.get(citizen.homeBuildingId);
    if (!home) return;
    if (citizen.location.id !== home.id) return { place: home, activity: 'returning-home' };
    const hour = now % 86400 / 3600;
    const work = citizen.workBuildingId && this.buildings.get(citizen.workBuildingId);
    if (work && hour >= 7 && hour < 17) return { place: work, activity: 'work' };
    const seed = stableHash(`${citizen.id}:${citizen.journeysCompleted}:destination`);
    if (this.shops.length && seed < .75) return { place: this.shops[Math.floor(seed / .75 * this.shops.length)], activity: 'shopping' };
    let nearby = this.strollsByHome.get(home.id);
    if (!nearby) {
      nearby = this.strolls.filter((place) => {
        const distance = Math.hypot(place.position.x - home.position.x, place.position.z - home.position.z);
        return distance > 15 && distance < 180;
      });
      this.strollsByHome.set(home.id, nearby);
    }
    if (nearby.length) return { place: nearby[Math.floor(seed * nearby.length)], activity: 'stroll' };
  }

  private schedule(citizen: Citizen, at: number): void {
    citizen.nextDepartureAt = at; this.events.push({ id: citizen.id, at });
  }
  private arrive(citizen: Citizen, now: number): void {
    const journey = citizen.journey!;
    citizen.location = structuredClone(journey.destination);
    citizen.activity = journey.activity === 'returning-home' ? 'home' : journey.activity;
    citizen.journey = undefined; citizen.journeysCompleted++;
    this.removeWalker(citizen.id);
    const dwell = citizen.activity === 'work' ? 900 : citizen.activity === 'shopping' ? 120 : citizen.activity === 'home' ? 180 : 30;
    this.schedule(citizen, now + dwell + stableHash(`${citizen.id}:${citizen.journeysCompleted}:dwell`) * dwell);
    this.indexDweller(citizen);
  }
  private indexDweller(citizen: Citizen): void {
    // Only actual outdoor dwell states, never occupants inside homes/shops.
    if (citizen.journey || citizen.location.buildingId || citizen.activity !== 'stroll') return;
    const point = citizen.location.position; const key = cellKey(Math.floor(point.x / CELL), Math.floor(point.z / CELL));
    const ids = this.walkersByCell.get(key) ?? new Set<string>(); ids.add(citizen.id); this.walkersByCell.set(key, ids);
    this.cellsByWalker.set(citizen.id, [key]); this.dwellers.add(citizen.id);
    this.visualCandidates.set(citizen.id, { id: citizen.id, name: citizen.name, homeBuildingId: citizen.homeBuildingId,
      workBuildingId: citizen.workBuildingId, activity: citizen.activity, origin: structuredClone(citizen.location), destination: structuredClone(citizen.location),
      route: [{ ...point }, { ...point }], length: 0, speed: 1, departedAt: 0, state: 'visiting', stationaryPosition: { ...point } });
  }
  private indexWalker(citizen: Citizen): void {
    const route = citizen.journey!.route; const keys = new Set<string>();
    // Detach immutable transport data once per journey, share equal routes across people.
    // postMessage still clones it across the Worker boundary; no renderer owns this state.
    const signature = JSON.stringify(route);
    let visualRoute = this.visualRoutes.get(signature);
    if (!visualRoute) {
      visualRoute = structuredClone(route);
      for (const point of visualRoute) Object.freeze(point); Object.freeze(visualRoute);
      if (this.visualRoutes.size >= 4096) this.visualRoutes.clear();
      this.visualRoutes.set(signature, visualRoute);
    }
    const { route: _, ...journey } = citizen.journey!;
    this.visualCandidates.set(citizen.id, { id: citizen.id, name: citizen.name,
      homeBuildingId: citizen.homeBuildingId, workBuildingId: citizen.workBuildingId,
      ...structuredClone(journey), route: visualRoute, state: 'walking' });
    for (let i = 1; i < route.length; i++) {
      const a = route[i - 1]; const b = route[i]; const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / (CELL / 2)));
      for (let step = 0; step <= steps; step++) keys.add(cellKey(Math.floor((a.x + (b.x - a.x) * step / steps) / CELL),
        Math.floor((a.z + (b.z - a.z) * step / steps) / CELL)));
    }
    this.cellsByWalker.set(citizen.id, [...keys]);
    for (const key of keys) { const ids = this.walkersByCell.get(key) ?? new Set<string>(); ids.add(citizen.id); this.walkersByCell.set(key, ids); }
  }
  private removeWalker(id: string): void {
    this.visualCandidates.delete(id);
    this.dwellers.delete(id);
    for (const key of this.cellsByWalker.get(id) ?? []) { const ids = this.walkersByCell.get(key); ids?.delete(id); if (!ids?.size) this.walkersByCell.delete(key); }
    this.cellsByWalker.delete(id);
  }

  nearby(camera: Vec2, radius: number, cap: number, now: number): CitizenCandidate[] {
    return this.performance.measure('citizenQueryMs', () => this.query(camera, radius, cap, now));
  }
  private query(camera: Vec2, radius: number, cap: number, now: number): CitizenCandidate[] {
    const ids = new Set<string>();
    for (let x = Math.floor((camera.x - radius) / CELL); x <= Math.floor((camera.x + radius) / CELL); x++)
      for (let z = Math.floor((camera.z - radius) / CELL); z <= Math.floor((camera.z + radius) / CELL); z++)
        for (const id of this.walkersByCell.get(cellKey(x, z)) ?? []) ids.add(id);
    const nearby: Array<{ citizen: Citizen; distance: number }> = [];
    for (const id of ids) {
      const citizen = this.residents.get(id)!; const candidate = this.visualCandidates.get(id)!;
      const pose = candidate.stationaryPosition ? { position: candidate.stationaryPosition, arrived: false }
        : pedestrianPose(candidate.route, candidate.length, candidate.speed, candidate.departedAt, now);
      const distance = Math.hypot(pose.position.x - camera.x, pose.position.z - camera.z);
      if (!pose.arrived && distance <= radius) nearby.push({ citizen, distance });
    }
    if (nearby.length > cap) nearby.sort((a, b) => a.distance - b.distance || a.citizen.id.localeCompare(b.citizen.id));
    this.lastQueryCount = nearby.length;
    return nearby.slice(0, cap).map(({ citizen }) => this.visualCandidates.get(citizen.id)!);
  }

  restore(saved: CitizenSaveState): void {
    if (saved?.version !== 1 || !Array.isArray(saved.residents)) throw new Error('Save contains invalid citizens.');
    this.residents.clear();
    const activities = ['home', 'work', 'shopping', 'stroll', 'returning-home'];
    const validPlace = (place: CitizenPlace) => place && typeof place.id === 'string' && typeof place.nodeId === 'string'
      && typeof place.label === 'string' && Number.isFinite(place.position?.x) && Number.isFinite(place.position?.z);
    for (const citizen of saved.residents) {
      const journey = citizen?.journey;
      if (!citizen || typeof citizen.id !== 'string' || this.residents.has(citizen.id)
        || typeof citizen.name !== 'string' || !citizen.name.trim() || citizen.name.length > 80
        || typeof citizen.householdId !== 'string' || typeof citizen.homeBuildingId !== 'string'
        || !activities.includes(citizen.activity)
        || !Number.isSafeInteger(citizen.member) || citizen.member < 0 || citizen.member > 3
        || !Number.isFinite(citizen.nextDepartureAt) || citizen.nextDepartureAt < 0
        || !Number.isSafeInteger(citizen.journeysCompleted) || citizen.journeysCompleted < 0 || !validPlace(citizen.location)
        || (journey && (!activities.includes(journey.activity) || !['walk', 'car', 'transit'].includes(journey.mode) || !validPlace(journey.origin) || !validPlace(journey.destination)
          || !Array.isArray(journey.route) || journey.route.length < 2 || journey.route.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.z))
          || !Number.isFinite(journey.departedAt) || journey.departedAt < 0 || !Number.isFinite(journey.speed) || journey.speed <= 0
          || !Number.isFinite(journey.length) || Math.abs(journey.length - polylineLength(journey.route)) > .01
          || (journey.mode !== 'walk' && typeof journey.tripId !== 'string')))) throw new Error('Save contains invalid citizen journey.');
      this.residents.set(citizen.id, structuredClone(citizen));
    }
    this.restored = true;
  }
}
