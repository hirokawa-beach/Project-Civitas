import { SimulationState } from '../simulation/state';
import { PopulationSystem } from '../population/system';
import { TrafficSystem } from '../traffic/system';
import { TransitSystem } from '../transit/system';
import { EconomySystem } from '../economy/system';
import { PedestrianRouter, polylineLength } from '../citizens/routing';
import { buildPedestrianGraph } from '../visual/pedestrianGraph';
import { stableHash } from '../citizens/identity';
import type { Building, Lot } from '../lots/types';
import type { RoadGraphSnapshot } from '../roads/types';
import type { WorldSnapshot } from '../shared/protocol';
import type { GameSpeed } from '../simulation/gameClock';
import { PerformanceLedger } from './metrics';

export const SCENARIOS = ['empty', 'roads-100', 'roads-1000', 'population-10k', 'population-50k', 'population-100k',
  'commercial-crowd', 'transit-hotspot', 'camera-6000'] as const;
export type ScenarioId = typeof SCENARIOS[number];
export const BENCHMARK_SEED = 'civitas-performance-v1';

/** Isolated, synthetic stress city. Capacity comes from real building definitions;
 * identities/journeys from CitizenSystem. Layout need not satisfy gameplay zoning placement.
 * It never reads/writes the user's city/save and runs in the benchmark Worker only. */
export class BenchmarkScenario {
  readonly performance = new PerformanceLedger();
  readonly population = new PopulationSystem();
  readonly roads: RoadGraphSnapshot = { nodes: [], segments: [], lanes: [] };
  readonly lots: Lot[] = [];
  readonly buildings: Building[] = [];
  readonly traffic: TrafficSystem;
  readonly transit: TransitSystem;
  readonly economy = new EconomySystem();
  readonly terrain = new SimulationState();
  gameSeconds = 8 * 3600;
  speed: GameSpeed = 1;
  private revision = 1;
  private world = new SimulationState().snapshot();

  constructor(readonly id: ScenarioId, readonly seed = BENCHMARK_SEED) {
    const target = id === 'population-10k' ? 10_000 : id === 'population-50k' ? 50_000
      : id === 'population-100k' ? 100_000 : ['commercial-crowd', 'transit-hotspot', 'camera-6000'].includes(id) ? 6000 : 0;
    const count = id === 'roads-100' ? 100 : id === 'roads-1000' ? 1000 : target ? 10 : 0;
    // Direct deterministic graph construction excludes the editor's road validation from tick timings.
    for (let i = 0; i < count; i++) {
      const z = count > 10 ? -480 + Math.floor(i / 20) * 19 : -360 + i * 80;
      const x = count > 10 ? -480 + (i % 20) * 48 : -440;
      const end = count > 10 ? x + 40 : 440;
      const segmentId = `segment-${i + 1}` as const; const a = `node-${i * 2 + 1}` as const; const b = `node-${i * 2 + 2}` as const;
      const forward = `lane-${i * 2 + 1}` as const; const backward = `lane-${i * 2 + 2}` as const;
      this.roads.nodes.push({ id: a, position: { x, z } }, { id: b, position: { x: end, z } });
      this.roads.segments.push({ id: segmentId, startNodeId: a, endNodeId: b, geometry: { kind: 'straight', points: [{ x, z }, { x: end, z }] },
        roadTypeId: 'small', width: 12, speedLimit: 40, laneIds: [forward, backward], zoningAllowed: true });
      this.roads.lanes.push({ id: forward, roadSegmentId: segmentId, direction: 'forward', index: 0 },
        { id: backward, roadSegmentId: segmentId, direction: 'backward', index: 1 });
    }
    this.transit = new TransitSystem(this.roads, undefined, this.gameSeconds);
    this.traffic = new TrafficSystem(this.roads, undefined, this.gameSeconds);
    this.traffic.setTransitSystem(this.transit);
    if (target) {
      const homes = Math.ceil(target / 128);
      const hotspot = !id.startsWith('population-');
      for (let i = 0; i < homes + 10; i++) {
        const residential = i < homes;
        const roadIndex = residential ? (hotspot ? 4 + (i % 2) : i % 10) : i - homes;
        const x = residential ? -280 + (Math.floor(i / 10) % 18) * 24 : 180;
        const z = this.roads.nodes[roadIndex * 2].position.z + 8;
        const lotId = `lot-benchmark-${i}` as const; const buildingId = `building-${lotId}` as const;
        const zoneType = residential ? 'residential' : 'commercial';
        this.lots.push({ id: lotId, buildingId, zoneType, zoneCellIds: [], widthCells: 4, depthCells: 4, width: 32, depth: 32,
          position: { x: x + 16, z: z + 16 }, rotation: 0, corners: [{ x, z }, { x: x + 32, z }, { x: x + 32, z: z + 32 }, { x, z: z + 32 }],
          roadAccess: { roadSegmentId: this.roads.segments[roadIndex].id, frontage: [{ x, z }, { x: x + 32, z }] },
          averageElevation: 0, minElevation: 0, maxElevation: 0, baseElevation: 0, slope: 0, buildable: true });
        this.buildings.push({ id: buildingId, lotId, definitionId: `prototype-${zoneType}-4x4`, state: 'Occupied', stateEnteredAt: 0, nextTransitionAt: null });
      }
      this.population.syncBuildings(this.buildings, this.lots, this.gameSeconds);
      const saved = this.population.save();
      let remaining = target;
      for (let i = 0; remaining > 0; i++) {
        const occupancy = saved.occupancies[Math.floor(i / 32)]; const size = Math.min(4, remaining);
        saved.households.push({ id: `household-${i + 1}`, homeBuildingId: occupancy.buildingId, householdSize: size,
          employedCount: 0, unemployedCount: Math.max(1, Math.floor(size / 2)), state: 'Housed' });
        occupancy.currentHouseholds++; occupancy.currentPopulation += size; remaining -= size;
      }
      saved.nextHouseholdSerial = saved.households.length + 1;
      saved.nextMoveInAt = this.gameSeconds + 86400;
      this.population.restore(saved, this.buildings, this.lots, this.gameSeconds);
      this.traffic.syncCitizens(this.population.households, this.population.snapshot(), this.lots, this.gameSeconds);
      const residents = this.traffic.citizens.save();
      const lotsByBuilding = new Map(this.lots.map((lot) => [lot.buildingId!, lot]));
      const router = new PedestrianRouter(); router.update(buildPedestrianGraph(this.roads, this.lots, []));
      for (let i = 0; i < residents.residents.length; i++) {
        const person = residents.residents[i]; person.nextDepartureAt = this.gameSeconds + 86400;
        if (!hotspot && i % 10 !== 0) continue;
        const home = lotsByBuilding.get(person.homeBuildingId)!;
        const shop = this.lots[homes + Number(home.roadAccess.roadSegmentId.slice(8)) - 1];
        const destination = { id: shop.buildingId!, buildingId: shop.buildingId!, label: 'Benchmark commercial destination',
          position: { x: shop.position.x, z: shop.roadAccess.frontage[0].z }, nodeId: `building:${shop.buildingId}` };
        const route = router.route(person.location.nodeId, destination.nodeId)!;
        const speed = 1.05 + stableHash(`${seed}:${person.id}:speed`) * .5;
        person.journey = { mode: 'walk', origin: structuredClone(person.location), destination, route: structuredClone(route), length: polylineLength(route), speed,
          departedAt: this.gameSeconds - stableHash(`${seed}:${person.id}:departure`) * Math.min(90, polylineLength(route) / speed * .7), activity: 'shopping' };
        person.activity = 'shopping';
      }
      this.traffic.citizens.restore(residents);
      this.traffic.syncCitizens(this.population.households, this.population.snapshot(), this.lots, this.gameSeconds);
      if (id === 'transit-hotspot') {
        const originStop = this.transit.placeStop({ x: 30, z: -40 }, 'Central benchmark stop');
        const destinationStop = this.transit.placeStop({ x: 320, z: -40 }, 'Commercial district');
        const line = this.transit.createLine({ name: 'Benchmark shuttle', stopIds: [originStop.id, destinationStop.id],
          serviceStartSeconds: 0, serviceEndSeconds: 86400, frequencySeconds: 300, vehicleTypeId: 'standard' }, this.gameSeconds);
        const transitSave = this.transit.save();
        const people = this.traffic.citizens.save();
        for (const person of people.residents) {
          if (transitSave.waitingGroups.length >= 1500) break;
          if (lotsByBuilding.get(person.homeBuildingId)!.roadAccess.roadSegmentId !== 'segment-5') continue;
          person.journey!.mode = 'transit'; person.journey!.tripId = `transit:${person.id}`;
          transitSave.waitingGroups.push({ id: `passenger-group-${transitSave.waitingGroups.length + 1}`, citizenId: person.id,
            lineId: line.id, originStopId: originStop.id, destinationStopId: destinationStop.id, count: 1,
            requestedAtGameSeconds: this.gameSeconds - 60 });
        }
        transitSave.nextGroupSerial = transitSave.waitingGroups.length + 1;
        this.transit.restore(transitSave, this.gameSeconds);
        this.traffic.citizens.restore(people);
        this.traffic.syncCitizens(this.population.households, this.population.snapshot(), this.lots, this.gameSeconds);
      }
    }
    this.traffic.setCitizenView({ x: 0, z: 0 }, 410, 3000);
    this.world.terrainHeightmap!.fill(0);
  }

  tick(realSeconds: number): void {
    this.performance.measure('simulationTickMs', () => {
      this.gameSeconds += realSeconds * this.speed * 10;
      if (!this.speed) return;
      this.performance.measure('populationMs', () => this.population.tick(this.gameSeconds));
      this.performance.measure('economyMs', () => this.economy.tick(this.gameSeconds, this.population.snapshot().totals, this.roads.segments, 0));
      this.performance.measure('trafficMs', () => this.traffic.tick(this.gameSeconds, this.population.snapshot(), this.lots));
      this.performance.measure('transitMs', () => this.transit.tick(this.gameSeconds, this.traffic.segmentStates));
    });
    this.revision++;
  }
  snapshot(full = false): WorldSnapshot {
    return { ...this.world, revision: this.revision, roadRevision: 1, lotRevision: 1, population: this.population.snapshot(),
      roadGraph: this.roads, lots: this.lots, buildings: this.buildings, traffic: this.traffic.snapshot(), transit: this.transit.snapshot(), economy: this.economy.snapshot(),
      gameClock: { gameSeconds: this.gameSeconds, speed: this.speed }, simulationTickMs: this.performance.report().simulationTickMs?.mean ?? 0,
      terrainHeightmap: full ? this.world.terrainHeightmap : undefined };
  }
}
