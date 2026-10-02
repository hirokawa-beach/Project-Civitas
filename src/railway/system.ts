import { RailwayInfrastructure } from './infrastructure';
import type { RailCommandData, RailwaySave } from './types';
import { MinQueue } from './queue';
import { railRoute } from './routing';
import { trackType } from './geometry';
import { FORMATION_TYPES, RAIL_SERVICE_TYPES, type RailTimetable, type RailOperationsSave, type RailEvent, type RailWait, type ActiveRailTrain, type RailServiceProgress, type RailRuntimeSnapshot, type FrequencyInput, type RailOperationCommand, type TrainService, type Formation, type FormationType, type Operation, type RailPassengerGroup, type StopCall, type RailRoute } from './operationsTypes';

export const TURNBACK_SECONDS = 20;
const integer = (n: number) => Number.isSafeInteger(n) && n >= 0;
const emptyTimetable = (): RailTimetable => ({ lines: [], serviceTypes: structuredClone([...RAIL_SERVICE_TYPES]), formationTypes: structuredClone([...FORMATION_TYPES]), services: [], formations: [], operations: [] });
const eventKey = (event: RailEvent) => `${event.operationId}:${event.serviceIndex}:${event.callIndex}:${event.type}`;

export class RailwaySystem extends RailwayInfrastructure {
  private timetable = emptyTimetable();
  private events = new MinQueue<RailEvent>((a, b) => a.at < b.at || a.at === b.at && a.id < b.id);
  private nextEventId = 1;
  private now = 0;
  private waits = new Map<string, RailWait>();
  private waitersByResource = new Map<string, Set<string>>();
  private trains = new Map<string, ActiveRailTrain>();
  private progress = new Map<string, RailServiceProgress>();
  private services = new Map<string, TrainService>();
  private lineStations = new Map<string, Set<string>>();
  private passengerCalls = new Map<string, Map<string, { first: number; last: number }>>();
  private passengerOrigins = new Map<string, Map<string, string[]>>();
  private formations = new Map<string, Formation>();
  private formationTypes = new Map<string, FormationType>();
  private operations = new Map<string, Operation>();
  private routes = new Map<string, RailRoute>();
  private passengers = new Map<string, RailPassengerGroup>();
  private passengersByOrigin = new Map<string, Set<string>>();
  private waitingPassengers = 0;
  private arrivedPassengers = 0;
  private leftBehind = 0;
  processedEvents = 0;
  get hasOperations() { return this.services.size > 0 || this.timetable.lines.length > 0; }
  override mutate(command: RailCommandData): string[] {
    if (this.hasOperations) throw new Error('Stop and clear railway operations before changing infrastructure.');
    if ([...this.blocks.values()].some(b => b.occupancyOwner || b.reservationOwner)) throw new Error('Release occupied/reserved railway resources before editing.');
    return super.mutate(command);
  }
  override assertEditable() { if (this.hasOperations) throw new Error('Stop and clear railway operations before Undo/Redo of infrastructure.'); super.assertEditable(); }
  override restoreConstruction(save: RailwaySave) { this.assertEditable(); super.restore(save); this.routes.clear(); }
  setClock(now: number) { this.now = now; }
  override save(): RailwaySave {
    return { ...super.save(), operations: { ...structuredClone(this.timetable), version: 1, now: this.now, nextEventId: this.nextEventId,
      events: structuredClone(this.events.values()), waits: structuredClone([...this.waits.values()]), activeTrains: structuredClone([...this.trains.values()]),
      serviceStates: structuredClone([...this.progress.values()]), passengers: structuredClone([...this.passengers.values()]), arrivedPassengers: this.arrivedPassengers,
      leftBehind: this.leftBehind, processedEvents: this.processedEvents } };
  }
  override restore(save: RailwaySave): void {
    super.restore(save); this.reset();
    if (!save.operations) return;
    const data = save.operations;
    if (data.version !== 1 || !integer(data.now) || !integer(data.nextEventId) || data.nextEventId < 1
      || !integer(data.arrivedPassengers) || !integer(data.leftBehind) || !integer(data.processedEvents)) throw new Error('Invalid saved rail operations.');
    this.validateTimetable(data, data.now, true); this.timetable = structuredClone({ lines: data.lines, serviceTypes: data.serviceTypes, formationTypes: data.formationTypes, services: data.services, formations: data.formations, operations: data.operations }); this.indexTimetable();
    this.now = data.now; this.nextEventId = data.nextEventId; this.processedEvents = data.processedEvents; this.arrivedPassengers = data.arrivedPassengers; this.leftBehind = data.leftBehind;
    if (![data.events, data.waits, data.activeTrains, data.serviceStates, data.passengers].every(Array.isArray)
      || data.events.length + data.waits.length > 10000 || data.activeTrains.length > this.formations.size || data.passengers.length > 100000) throw new Error('Invalid rail runtime collection.');
    const eventIds = new Set<number>();
    const validateEvent = (event: RailEvent) => {
      const op = this.operations.get(event.operationId), service = op && this.services.get(op.trainServiceIds[event.serviceIndex]);
      if (!event || !integer(event.id) || event.id < 1 || event.id >= data.nextEventId || eventIds.has(event.id) || !integer(event.at)
        || !['activate', 'departure', 'arrival', 'dwell-complete', 'route-request'].includes(event.type) || !service || !integer(event.serviceIndex)
        || !integer(event.callIndex) || event.callIndex >= service.stopCalls.length) throw new Error('Invalid saved rail event.'); eventIds.add(event.id);
    };
    for (const event of data.events) { validateEvent(event); this.events.push(structuredClone(event)); }
    for (const wait of data.waits) { validateEvent(wait.event); if (wait.key !== eventKey(wait.event) || !wait.resources.length || wait.resources.some(id => !this.blocks.has(id)) || this.waits.has(wait.key)) throw new Error('Invalid rail resource wait.'); this.registerWait(structuredClone(wait)); }
    for (const train of data.activeTrains) {
      const op = this.operations.get(train.operationId), service = this.services.get(train.serviceId), formation = this.formations.get(train.formationId);
      if (!op || op.assignedFormationId !== train.formationId || !op.trainServiceIds.includes(train.serviceId) || !service || !formation
        || this.trains.has(train.formationId) || !integer(train.callIndex) || train.callIndex >= service.stopCalls.length || !integer(train.delay)
        || !integer(train.dwellUntil) || !['waiting', 'dwelling', 'running', 'turnback'].includes(train.state)
        || !this.blocks.has(train.faceId) || !Array.isArray(train.resources) || !train.resources.length || train.resources.some(id => !this.blocks.has(id))
        || !Array.isArray(train.onboard) || train.onboard.some(g => !this.stations.has(g.destination) || !integer(g.count) || g.count === 0)
        || train.onboard.reduce((sum, g) => sum + g.count, 0) > this.formationTypes.get(formation.formationTypeId)!.capacity) throw new Error('Invalid active rail train.');
      if (train.state === 'running') {
        if (!train.leg || !integer(train.leg.startAt) || !integer(train.leg.endAt) || train.leg.endAt <= train.leg.startAt || train.callIndex < 1) throw new Error('Invalid saved train motion.');
        const route = this.route(service.stopCalls[train.callIndex - 1].platformFaceId, service.stopCalls[train.callIndex].platformFaceId, formation.formationTypeId);
        if (JSON.stringify(train.leg.route) !== JSON.stringify(route) || train.leg.endAt - train.leg.startAt < route.duration) throw new Error('Saved train route disagrees with Track Graph.');
      } else if (train.leg) throw new Error('Stationary train has a moving leg.');
      this.trains.set(train.formationId, structuredClone(train));
    }
    for (const state of data.serviceStates) {
      const service = this.services.get(state.serviceId);
      if (!service || this.progress.has(state.serviceId) || !integer(state.delay) || !['waiting', 'dwelling', 'running', 'turnback', 'completed'].includes(state.status)
        || !Array.isArray(state.actualCalls) || state.actualCalls.length > service.stopCalls.length
        || state.actualCalls.some((call, i) => call.sequence !== i || [call.arrivalTime, call.departureTime, call.passTime].some(time => time !== undefined && (!integer(time) || time > data.now)))) throw new Error('Invalid saved rail progress.');
      this.progress.set(state.serviceId, structuredClone(state));
    }
    const waitingActivationFormations = new Set([...data.events, ...data.waits.map(w => w.event)].filter(e => e.type === 'activate').map(e => this.operations.get(e.operationId)!.assignedFormationId));
    for (const formation of this.formations.values()) {
      const train = this.trains.get(formation.formationId);
      if (train && (formation.currentServiceId !== train.serviceId || formation.currentFaceId !== train.faceId || formation.state !== (train.state === 'dwelling' ? 'waiting' : train.state))) throw new Error('Formation state disagrees with its active train.');
      if (!train && formation.state !== 'depot' && !waitingActivationFormations.has(formation.formationId)) throw new Error('Formation lacks an operation event.');
    }
    const resourcesByTrain = new Map([...this.trains].map(([id, train]) => [id, new Set(train.resources)]));
    for (const block of this.blocks.values()) for (const owner of [block.occupancyOwner, block.reservationOwner]) if (owner) {
      if (!resourcesByTrain.get(owner)?.has(block.id)) throw new Error('Rail resource has an orphaned owner.');
    }
    for (const train of this.trains.values()) if (train.resources.some(id => { const block = this.blocks.get(id)!; return block.occupancyOwner !== train.formationId && block.reservationOwner !== train.formationId; })) throw new Error('Train is missing its block ownership.');
    for (const group of data.passengers) this.addPassengers(group);
    this.revision++;
  }
  executeOperation(command: RailOperationCommand, now: number): string[] {
    if (!integer(now)) throw new Error('Invalid railway clock.'); this.now = now;
    if (command.type === 'clear-rail-operations') {
      for (const train of this.trains.values()) super.release(train.formationId, train.resources);
      this.reset(); this.now = now; this.revision++; this.networkRevision++; return [];
    }
    if (command.type === 'extend-rail-dwell') {
      const train = this.trains.get(command.formationId);
      if (!train || train.state !== 'dwelling' || !integer(command.seconds) || command.seconds < 1 || command.seconds > 3600) throw new Error('Choose a dwelling train and 1–3600 seconds.');
      train.dwellUntil = Math.max(now, train.dwellUntil) + command.seconds; this.revision++; return [train.serviceId];
    }
    if (command.type === 'add-rail-passengers') { this.addPassengers(command.group); this.revision++; return [command.group.id]; }
    if (this.hasOperations) throw new Error('Stop and clear the existing timetable before creating another. Advanced data can contain multiple lines.');
    const before = this.save();
    try {
      const timetable = command.type === 'create-rail-frequency' ? this.frequency(command.input, now) : structuredClone(command.timetable);
      this.validateTimetable(timetable, now); this.timetable = timetable; this.indexTimetable();
      for (const operation of timetable.operations) { const service = this.services.get(operation.trainServiceIds[0])!; this.schedule('activate', service.stopCalls[0].arrivalTime, operation.operationId, 0, 0); }
      this.revision++; this.networkRevision++; return timetable.services.map(s => s.id);
    } catch (error) { this.restore(before); throw error; }
  }
  advance(now: number): void {
    this.now = now;
    let count = 0;
    while (this.events.peek() && this.events.peek().at <= now && count++ < 1000) {
      const event = this.events.pop()!; this.process(event); this.processedEvents++; this.revision++;
    }
  }
  runtime(): RailRuntimeSnapshot {
    const trains = structuredClone([...this.trains.values()]), states = structuredClone([...this.progress.values()]), stateById = new Map(states.map(s => [s.serviceId, s]));
    for (const train of trains) if (train.state === 'waiting') {
      train.delay = Math.max(train.delay, this.now - this.services.get(train.serviceId)!.stopCalls[train.callIndex].departureTime);
      const state = stateById.get(train.serviceId); if (state) state.delay = Math.max(state.delay, train.delay);
    }
    for (const wait of this.waits.values()) if (wait.event.type === 'activate') { const op = this.operations.get(wait.event.operationId)!, service = this.services.get(op.trainServiceIds[wait.event.serviceIndex])!, state = stateById.get(service.id); if (state) state.delay = Math.max(state.delay, this.now - service.stopCalls[0].arrivalTime); }
    const resources = new Set(trains.flatMap(t => t.resources));
    return { revision: this.revision, gameSeconds: this.now, activeTrains: trains, serviceStates: states,
      ownedBlocks: [...resources].map(id => structuredClone(this.blocks.get(id)!)), waitingPassengers: this.waitingPassengers,
      arrivedPassengers: this.arrivedPassengers, leftBehind: this.leftBehind, processedEvents: this.processedEvents, nextEventAt: this.events.peek()?.at };
  }
  private reset() {
    this.timetable = emptyTimetable(); this.events.clear(); this.nextEventId = 1; this.waits.clear(); this.waitersByResource.clear(); this.trains.clear(); this.progress.clear(); this.routes.clear();
    this.passengers.clear(); this.passengersByOrigin.clear(); this.waitingPassengers = 0; this.arrivedPassengers = 0; this.leftBehind = 0; this.processedEvents = 0; this.indexTimetable();
  }
  private indexTimetable() {
    this.lineStations = new Map(this.timetable.lines.map(line => [line.id, new Set(line.stationIds)]));
    this.services = new Map(this.timetable.services.map(s => [s.id, s])); this.formations = new Map(this.timetable.formations.map(f => [f.formationId, f]));
    this.formationTypes = new Map(this.timetable.formationTypes.map(t => [t.id, t])); this.operations = new Map(this.timetable.operations.map(o => [o.operationId, o]));
    this.passengerCalls.clear(); this.passengerOrigins.clear();
    // Index stopping calls once, without expanding every origin/destination pair.
    for (const service of this.services.values()) if (service.passengerService) {
      const calls = new Map<string, { first: number; last: number }>();
      for (const call of service.stopCalls) if (call.stopType === 'stop') {
        const previous = calls.get(call.stationId); calls.set(call.stationId, { first: previous?.first ?? call.sequence, last: call.sequence });
      }
      this.passengerCalls.set(service.id, calls);
      const origins = this.passengerOrigins.get(service.lineId) ?? new Map<string, string[]>();
      for (const station of calls.keys()) { const ids = origins.get(station) ?? []; ids.push(service.id); origins.set(station, ids); }
      this.passengerOrigins.set(service.lineId, origins);
    }
  }
  private route(from: string, to: string, formationTypeId: string): RailRoute {
    const key = `${from}|${to}|${formationTypeId}`, cached = this.routes.get(key); if (cached) return cached;
    const route = railRoute(this, from, to, this.formationTypes.get(formationTypeId)!); this.routes.set(key, route); return route;
  }
  private validateTimetable(data: RailTimetable, now: number, restoring = false) {
    const collection = <T>(items: T[], id: (item: T) => string, maximum: number) => {
      if (!Array.isArray(items) || items.length > maximum) throw new Error('Rail timetable exceeds the collection budget.'); const map = new Map<string, T>();
      for (const item of items) { const key = id(item); if (typeof key !== 'string' || !key.trim() || key.length > 128 || map.has(key)) throw new Error('Invalid or duplicate rail timetable ID.'); map.set(key, item); } return map;
    };
    const lines = collection(data.lines, l => l.id, 100), serviceTypes = collection(data.serviceTypes, s => s.id, 100), types = collection(data.formationTypes, t => t.id, 100), formations = collection(data.formations, f => f.formationId, 512), services = collection(data.services, s => s.id, 5000);
    const lineStations = new Map([...lines].map(([id, line]) => [id, new Set(line.stationIds)]));
    collection(data.operations, o => o.operationId, 512);
    for (const line of lines.values()) if (!line.name?.trim() || !/^#[\da-f]{6}$/i.test(line.color) || !Array.isArray(line.stationIds) || line.stationIds.some(id => !this.stations.has(id))) throw new Error('Invalid rail line.');
    for (const type of serviceTypes.values()) if (!type.name?.trim() || !['local', 'rapid', 'express', 'limited-express', 'deadhead', 'other'].includes(type.kind)) throw new Error('Invalid rail service type.');
    for (const type of types.values()) if (!type.name?.trim() || !integer(type.cars) || type.cars < 1 || type.cars > 32 || !Number.isFinite(type.length) || type.length < 5 || type.length > 800
      || !integer(type.capacity) || type.capacity < 1 || type.capacity > 10000 || !Number.isFinite(type.maxSpeed) || type.maxSpeed < 1 || type.maxSpeed > 350 || ![1.435, 1.067].includes(type.gauge)) throw new Error('Invalid FormationType.');
    const depotCounts = new Map<string, number>();
    for (const f of formations.values()) {
      if (!types.has(f.formationTypeId) || !this.depots.has(f.depotId) || !['depot', 'waiting', 'running', 'turnback'].includes(f.state) || !restoring && (f.state !== 'depot' || f.currentFaceId || f.currentServiceId)) throw new Error('Invalid Formation.');
      const depot = this.depots.get(f.depotId)!, type = types.get(f.formationTypeId)!;
      if (trackType(this.requireTrack(depot.connectedTrackId).trackTypeId).gauge !== type.gauge) throw new Error('Formation gauge does not match its depot track.');
      const n = (depotCounts.get(f.depotId) ?? 0) + 1; depotCounts.set(f.depotId, n); if (n > depot.capacity) throw new Error('Formation count exceeds depot capacity.');
    }
    let calls = 0; const assignedServices = new Set<string>(), assignedFormations = new Set<string>();
    // Validate with a cache per unique face pair/type, not a graph search for every generated train.
    const routes = new Map<string, RailRoute>();
    for (const op of data.operations) {
      const formation = formations.get(op.assignedFormationId), type = formation && types.get(formation.formationTypeId);
      if (!formation || !type || !op.operationNumber?.trim() || assignedFormations.has(formation.formationId) || !Array.isArray(op.trainServiceIds) || !op.trainServiceIds.length) throw new Error('One Operation must own one unique Formation.');
      assignedFormations.add(formation.formationId); let previous: TrainService | undefined;
      for (const serviceId of op.trainServiceIds) {
        const s = services.get(serviceId); if (!s || assignedServices.has(serviceId)) throw new Error('TrainService needs exactly one Operation.'); assignedServices.add(serviceId);
        const line = lines.get(s.lineId), serviceType = serviceTypes.get(s.serviceTypeId);
        if (!line || !serviceType || !s.trainNumber?.trim() || typeof s.passengerService !== 'boolean' || serviceType.kind === 'deadhead' && s.passengerService
          || !Array.isArray(s.stopCalls) || s.stopCalls.length < 2 || s.stopCalls.length > 100 || (calls += s.stopCalls.length) > 50000
          || s.origin !== s.stopCalls[0].stationId || s.destination !== s.stopCalls.at(-1)!.stationId) throw new Error('Invalid TrainService.');
        for (let i = 0; i < s.stopCalls.length; i++) {
          const call = s.stopCalls[i], face = this.face(call.platformFaceId), prev = s.stopCalls[i - 1];
          if (call.sequence !== i || face.station.stationId !== call.stationId || !lineStations.get(s.lineId)!.has(call.stationId) || !integer(call.arrivalTime) || !integer(call.departureTime)
            || call.departureTime < call.arrivalTime || !['stop', 'pass'].includes(call.stopType) || call.stopType === 'pass' && call.arrivalTime !== call.departureTime
            || prev && call.arrivalTime < prev.departureTime || !restoring && i === 0 && call.arrivalTime < now
            || (call.stopType === 'stop' || i === 0 || i === s.stopCalls.length - 1) && !this.fitsPlatform(call.platformFaceId, type.length)) throw new Error('Invalid StopCall timing, station or platform length.');
          if (prev) { if (prev.platformFaceId === call.platformFaceId) throw new Error('Consecutive StopCalls need distinct platform faces.'); const key = `${prev.platformFaceId}|${call.platformFaceId}|${type.id}`; if (!routes.has(key)) routes.set(key, railRoute(this, prev.platformFaceId, call.platformFaceId, type)); }
        }
        if (previous && (previous.stopCalls.at(-1)!.platformFaceId !== s.stopCalls[0].platformFaceId || s.stopCalls[0].arrivalTime < previous.stopCalls.at(-1)!.departureTime + TURNBACK_SECONDS)) throw new Error('Operation continuity requires the same face and at least 20s turnback between separate TrainServices.');
        previous = s;
      }
    }
    if (assignedServices.size !== services.size || services.size && !data.operations.length) throw new Error('Every TrainService must be assigned to an Operation.');
    if (assignedFormations.size !== formations.size) throw new Error('Every Formation must be assigned to an Operation.');
  }
  private frequency(input: FrequencyInput, now: number): RailTimetable {
    if (!input.name?.trim() || !integer(input.start) || !integer(input.end) || !integer(input.frequency) || input.frequency < 1 || input.end <= input.start
      || input.start < now + 20 || !Array.isArray(input.faceIds) || input.faceIds.length < 2 || input.faceIds.length > 100
      || input.stopTypes && (input.stopTypes.length !== input.faceIds.length || input.stopTypes.some(t => !['stop', 'pass'].includes(t)))
      || typeof input.returnService !== 'boolean' || Math.ceil((input.end - input.start) / input.frequency) * (input.returnService ? 2 : 1) > 5000) throw new Error('Choose future service times, frequency and 2–100 stops within the 5,000-service budget.');
    const type = FORMATION_TYPES.find(t => t.id === input.formationTypeId); if (!type || !this.depots.has(input.depotId) || !RAIL_SERVICE_TYPES.some(t => t.id === input.serviceTypeId)) throw new Error('Choose a FormationType, depot and service type.');
    this.formationTypes = new Map(FORMATION_TYPES.map(t => [t.id, t]));
    const faces = input.faceIds.map(id => this.face(id)), lineId = this.id('rail-line'), line = { id: lineId, name: input.name.trim(), color: input.color, stationIds: [...new Set(faces.map(f => f.station.stationId))] };
    const callsFor = (ids: string[], stopTypes: Array<'stop' | 'pass'>, departure: number): StopCall[] => {
      let next = departure; return ids.map((id, i) => { const face = this.face(id), dwell = stopTypes[i] === 'pass' ? 0 : 20;
        const arrivalTime = i === 0 ? departure - dwell : next + this.route(ids[i - 1], id, type.id).duration;
        const call = { stationId: face.station.stationId, platformFaceId: id, arrivalTime, departureTime: i === 0 ? departure : arrivalTime + dwell, stopType: stopTypes[i], sequence: i }; next = call.departureTime; return call; });
    };
    const stopTypes = input.stopTypes ?? input.faceIds.map(() => 'stop' as const), first = callsFor(input.faceIds, stopTypes, input.start);
    const reverseIds = [...input.faceIds].reverse(), reverseTypes = [...stopTypes].reverse();
    const reverseStart = first.at(-1)!.departureTime + TURNBACK_SECONDS + (reverseTypes[0] === 'stop' ? 20 : 0);
    const reverse = input.returnService ? callsFor(reverseIds, reverseTypes, reverseStart) : undefined;
    // Repeated services in one Operation must return to its next origin; one-way frequency uses separate formations.
    const cycle = (reverse?.at(-1)!.departureTime ?? first.at(-1)!.departureTime) + TURNBACK_SECONDS - first[0].arrivalTime;
    const departures = Math.ceil((input.end - input.start) / input.frequency), pool = input.returnService ? Math.min(departures, Math.max(1, Math.ceil(cycle / input.frequency))) : departures;
    if (pool > this.depots.get(input.depotId)!.capacity || pool > 512) throw new Error('Depot lacks capacity for this frequency. Increase headway, shorten service hours, or choose return service.');
    const data = emptyTimetable(); data.lines = [line];
    for (let i = 0; i < pool; i++) { const formationId = this.id('formation'); data.formations.push({ formationId, formationTypeId: type.id, depotId: input.depotId, state: 'depot' }); data.operations.push({ operationId: this.id('operation'), operationNumber: `${i + 1}`, assignedFormationId: formationId, trainServiceIds: [] }); }
    for (let i = 0; i < departures; i++) {
      const operation = data.operations[i % pool], shift = i * input.frequency;
      for (const [j, calls] of [first, reverse].entries()) if (calls) {
        const id = this.id('train-service'), stopCalls = calls.map(c => ({ ...c, arrivalTime: c.arrivalTime + shift, departureTime: c.departureTime + shift }));
        data.services.push({ id, trainNumber: `${i + 1}${j ? 'R' : ''}`, lineId, serviceTypeId: input.serviceTypeId, passengerService: input.serviceTypeId !== 'deadhead', origin: stopCalls[0].stationId, destination: stopCalls.at(-1)!.stationId, stopCalls }); operation.trainServiceIds.push(id);
      }
    }
    return data;
  }
  private schedule(type: RailEvent['type'], at: number, operationId: string, serviceIndex: number, callIndex: number) {
    this.events.push({ id: this.nextEventId++, type, at, operationId, serviceIndex, callIndex });
  }
  private registerWait(wait: RailWait) { this.waits.set(wait.key, wait); for (const id of wait.resources) { const keys = this.waitersByResource.get(id) ?? new Set(); keys.add(wait.key); this.waitersByResource.set(id, keys); } }
  private wait(event: RailEvent, resources: string[]) {
    const key = eventKey(event); if (this.waits.has(key)) return;
    const blocked = resources.filter(id => { const b = this.blocks.get(id)!; const owner = this.operations.get(event.operationId)!.assignedFormationId; return b.occupancyOwner && b.occupancyOwner !== owner || b.reservationOwner && b.reservationOwner !== owner; });
    this.registerWait({ key, event, resources: blocked });
  }
  private releaseResources(owner: string, resources: string[], at: number) {
    super.release(owner, resources); const wake = new Set<string>(); for (const id of resources) for (const key of this.waitersByResource.get(id) ?? []) wake.add(key);
    for (const key of [...wake].sort()) { const wait = this.waits.get(key); if (!wait) continue; this.waits.delete(key); for (const id of wait.resources) { const keys = this.waitersByResource.get(id); keys?.delete(key); if (!keys?.size) this.waitersByResource.delete(id); } this.schedule(wait.event.type, at, wait.event.operationId, wait.event.serviceIndex, wait.event.callIndex); }
  }
  private occupyCurrent(train: ActiveRailTrain, resources: string[]) {
    if (!this.occupy(train.formationId, resources)) throw new Error('Reserved current train resources were lost.');
    // Retain the service-wide reservation, but clear physical occupancy behind
    // the train and on future legs. Work is bounded to this train's itinerary.
    const current = new Set(resources);
    for (const id of train.resources) {
      const block = this.blocks.get(id)!;
      if (!current.has(id) && block.occupancyOwner === train.formationId) block.occupancyOwner = null;
    }
  }
  private process(event: RailEvent) {
    const op = this.operations.get(event.operationId)!; const service = this.services.get(op.trainServiceIds[event.serviceIndex])!, formation = this.formations.get(op.assignedFormationId)!, call = service.stopCalls[event.callIndex];
    let train = this.trains.get(formation.formationId), state = this.progress.get(service.id);
    if (event.type === 'activate') {
      if (!state) { state = { serviceId: service.id, status: 'waiting', delay: 0, actualCalls: [] }; this.progress.set(service.id, state); }
      // Conservative service-wide reservation avoids an opposing train parking
      // at an intermediate stop and deadlocking both ends of a single track.
      const resources = [...new Set([call.platformFaceId, this.face(call.platformFaceId).face.trackSegmentId,
        ...service.stopCalls.slice(1).flatMap((next, i) => this.route(service.stopCalls[i].platformFaceId, next.platformFaceId, formation.formationTypeId).resources)])];
      if (!this.reserve(formation.formationId, resources)) { if (!train) { formation.state = 'waiting'; formation.currentServiceId = service.id; } this.wait(event, resources); return; }
      train = { formationId: formation.formationId, operationId: op.operationId, serviceId: service.id, callIndex: 0, state: 'dwelling', delay: Math.max(0, event.at - call.arrivalTime), faceId: call.platformFaceId, resources, onboard: train?.onboard ?? [], dwellUntil: 0 };
      this.trains.set(formation.formationId, train); formation.currentServiceId = service.id; formation.currentFaceId = call.platformFaceId;
      this.arrive(event, train, state); return;
    }
    if (!train || train.serviceId !== service.id || train.callIndex !== event.callIndex) return;
    state = this.progress.get(service.id)!;
    if (event.type === 'arrival') { this.arrive(event, train, state); return; }
    if (event.type === 'dwell-complete') {
      if (event.at < train.dwellUntil) { this.schedule('dwell-complete', train.dwellUntil, op.operationId, event.serviceIndex, event.callIndex); return; }
      this.schedule('departure', event.at, op.operationId, event.serviceIndex, event.callIndex); return;
    }
    if (event.type === 'departure') {
      if (event.callIndex === service.stopCalls.length - 1) { this.departPassengers(train, service, call); state.actualCalls[event.callIndex].departureTime = event.at; state.status = 'completed'; this.finish(event, train); return; }
      train.state = 'waiting'; formation.state = 'waiting'; state.status = 'waiting'; this.schedule('route-request', event.at, op.operationId, event.serviceIndex, event.callIndex); return;
    }
    const target = service.stopCalls[event.callIndex + 1], route = this.route(call.platformFaceId, target.platformFaceId, formation.formationTypeId);
    if (!this.reserve(formation.formationId, route.resources)) { this.wait(event, route.resources); return; }
    this.departPassengers(train, service, call);
    train.delay = Math.max(train.delay, event.at - call.departureTime); state.delay = train.delay; state.status = 'running'; state.actualCalls[event.callIndex].departureTime = event.at;
    train.leg = { route, startAt: event.at, endAt: Math.max(target.arrivalTime + train.delay, event.at + route.duration) };
    train.delay = Math.max(train.delay, train.leg.endAt - target.arrivalTime); state.delay = train.delay;
    this.occupyCurrent(train, route.resources.filter(id => id !== call.platformFaceId && id !== target.platformFaceId));
    train.callIndex++; train.state = 'running'; formation.state = 'running';
    this.schedule('arrival', train.leg.endAt, op.operationId, event.serviceIndex, train.callIndex);
  }
  private arrive(event: RailEvent, train: ActiveRailTrain, state: RailServiceProgress) {
    const op = this.operations.get(event.operationId)!, service = this.services.get(train.serviceId)!, call = service.stopCalls[event.callIndex], formation = this.formations.get(train.formationId)!;
    const resources = [call.platformFaceId, this.face(call.platformFaceId).face.trackSegmentId];
    this.occupyCurrent(train, resources);
    train.faceId = call.platformFaceId; train.leg = undefined; formation.currentFaceId = call.platformFaceId; formation.state = 'waiting';
    train.delay = Math.max(train.delay, event.at - call.arrivalTime); state.delay = train.delay;
    state.actualCalls.push({ sequence: event.callIndex, arrivalTime: event.at, ...(call.stopType === 'pass' ? { passTime: event.at } : {}) });
    if (call.stopType === 'stop') { let alighted = 0; train.onboard = train.onboard.filter(group => { if (group.destination === call.stationId) { alighted += group.count; return false; } return true; }); this.arrivedPassengers += alighted; }
    train.state = 'dwelling'; state.status = 'dwelling';
    const dwell = call.stopType === 'pass' ? 0 : call.departureTime - call.arrivalTime;
    train.dwellUntil = Math.max(call.departureTime + train.delay, event.at + dwell);
    this.schedule('dwell-complete', train.dwellUntil, op.operationId, event.serviceIndex, event.callIndex);
  }
  private finish(event: RailEvent, train: ActiveRailTrain) {
    const op = this.operations.get(event.operationId)!, formation = this.formations.get(train.formationId)!, next = this.services.get(op.trainServiceIds[event.serviceIndex + 1]);
    if (next) {
      const retained = [train.faceId, this.face(train.faceId).face.trackSegmentId];
      this.releaseResources(train.formationId, train.resources.filter(id => !retained.includes(id)), event.at); train.resources = retained;
      train.state = 'turnback'; formation.state = 'turnback'; this.schedule('activate', Math.max(next.stopCalls[0].arrivalTime, event.at + TURNBACK_SECONDS), op.operationId, event.serviceIndex + 1, 0);
    }
    else { this.releaseResources(train.formationId, train.resources, event.at); this.trains.delete(train.formationId); formation.state = 'depot'; formation.currentServiceId = undefined; formation.currentFaceId = undefined; }
  }
  private addPassengers(group: RailPassengerGroup) {
    const stations = this.lineStations.get(group?.lineId);
    if (!group || !group.id?.trim() || this.passengers.has(group.id) || this.passengers.size >= 100000 || !stations?.has(group.origin) || !stations.has(group.destination)
      || !this.stations.has(group.origin) || !this.stations.has(group.destination) || group.origin === group.destination || !integer(group.count) || group.count < 1 || group.count > 1000000
      || !this.passengerOrigins.get(group.lineId)?.get(group.origin)?.some(id => {
        const calls = this.passengerCalls.get(id)!, destination = calls.get(group.destination);
        return destination !== undefined && calls.get(group.origin)!.first < destination.last;
      })) throw new Error('Invalid rail passenger OD group.');
    this.passengers.set(group.id, structuredClone(group)); const ids = this.passengersByOrigin.get(group.origin) ?? new Set(); ids.add(group.id); this.passengersByOrigin.set(group.origin, ids); this.waitingPassengers += group.count;
  }
  private departPassengers(train: ActiveRailTrain, service: TrainService, call: StopCall) {
    if (!service.passengerService || call.stopType !== 'stop') return;
    const formation = this.formations.get(train.formationId)!, capacity = this.formationTypes.get(formation.formationTypeId)!.capacity;
    let remaining = capacity - train.onboard.reduce((n, g) => n + g.count, 0), denied = 0;
    const destinations = new Set(service.stopCalls.slice(train.callIndex + 1).filter(c => c.stopType === 'stop').map(c => c.stationId));
    for (const id of this.passengersByOrigin.get(call.stationId) ?? []) {
      const group = this.passengers.get(id)!; if (group.lineId !== service.lineId || !destinations.has(group.destination)) continue;
      const count = Math.min(remaining, group.count); if (count) { const onboard = train.onboard.find(g => g.destination === group.destination); if (onboard) onboard.count += count; else train.onboard.push({ destination: group.destination, count }); group.count -= count; remaining -= count; this.waitingPassengers -= count; }
      denied += group.count; if (!group.count) { this.passengers.delete(id); this.passengersByOrigin.get(call.stationId)!.delete(id); }
    }
    this.leftBehind += denied;
  }
}
