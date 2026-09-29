import type { Lot } from '../lots/types';
import type { BuildingOccupancy } from '../population/types';
import type { RoadGraphSnapshot } from '../roads/types';
import type { SegmentTraffic } from '../traffic/types';
import type { TransitStop, TransitStopMetrics } from '../transit/types';
import type { Vec2 } from '../world/types';
import { buildPedestrianGraph, type PedestrianGraph } from './pedestrianGraph';
import { agentLod, type AgentLod, type VisualAgentProfile } from './agentBudget';

const CELL = 64;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const distanceSquared = (a: Vec2, b: Vec2) => (a.x - b.x) ** 2 + (a.z - b.z) ** 2;
export const visualHash = (value: string): number => {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) { h ^= value.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;
};
const key = (x: number, z: number) => `${x}:${z}`;

export interface CitizenVisual {
  id: string;
  edgeId: string;
  slot: number;
  position: Vec2;
  yaw: number;
  lod: AgentLod;
  variation: number;
}
interface Activity { residential: number; commercial: number; office: number; industrial: number; transit: number; trips: number }
interface EdgeRecord { id: string; roadSegmentId: string; a: Vec2; b: Vec2; length: number; activity: Activity }
const emptyActivity = (): Activity => ({ residential: 0, commercial: 0, office: 0, industrial: 0, transit: 0, trips: 0 });

/** Time factors are visualization only; they never change population or trips. */
export function citizenDensity(activity: Activity, gameSeconds: number): number {
  const hour = (gameSeconds % 86400) / 3600;
  const commute = (hour >= 7 && hour < 9) || (hour >= 17 && hour < 19);
  const day = hour >= 9 && hour < 21;
  const residential = activity.residential * (day ? .7 : 1.15);
  const commercial = activity.commercial * (day ? 1.25 : .25);
  const office = activity.office * (commute ? 1.75 : day ? 1 : .12);
  const industrial = activity.industrial * (day ? .8 : .4);
  const transit = activity.transit * (commute ? 1.9 : day ? 1 : .3);
  const trips = activity.trips * (commute ? 1.3 : day ? 1 : .4);
  return clamp(residential + commercial + office + industrial + transit + trips, 0, 24);
}

/** Spatially indexed sidewalk visuals, derived from building and traffic aggregates. */
export class CitizenSampler {
  graph: PedestrianGraph = { nodes: [], edges: [] };
  private readonly records = new Map<string, EdgeRecord>();
  private readonly cells = new Map<string, EdgeRecord[]>();

  rebuild(roads: RoadGraphSnapshot, lots: readonly Lot[], occupancies: readonly BuildingOccupancy[],
    stops: readonly TransitStop[], stopMetrics: readonly TransitStopMetrics[], traffic: readonly SegmentTraffic[]): void {
    this.graph = buildPedestrianGraph(roads, lots, stops);
    this.records.clear(); this.cells.clear();
    const nodes = new Map(this.graph.nodes.map((node) => [node.id, node]));
    for (const edge of this.graph.edges) {
      if (edge.kind !== 'sidewalk' || !edge.roadSegmentId) continue;
      const a = nodes.get(edge.from)!.point; const b = nodes.get(edge.to)!.point;
      const record = { id: edge.id, roadSegmentId: edge.roadSegmentId, a, b, length: edge.length, activity: emptyActivity() };
      this.records.set(record.id, record);
      const center = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
      const cell = key(Math.floor(center.x / CELL), Math.floor(center.z / CELL));
      const bucket = this.cells.get(cell) ?? []; bucket.push(record); this.cells.set(cell, bucket);
    }
    this.updateActivity(lots, occupancies, stops, stopMetrics, traffic);
  }

  /** Refresh aggregate density without rebuilding the sidewalk graph on every traffic tick. */
  updateActivity(lots: readonly Lot[], occupancies: readonly BuildingOccupancy[], stops: readonly TransitStop[],
    stopMetrics: readonly TransitStopMetrics[], traffic: readonly SegmentTraffic[]): void {
    const byRoad = new Map<string, EdgeRecord[]>();
    for (const record of this.records.values()) {
      record.activity = emptyActivity();
      const list = byRoad.get(record.roadSegmentId) ?? [];
      list.push(record); byRoad.set(record.roadSegmentId, list);
    }
    const addNearby = (roadId: string, position: Vec2, kind: keyof Activity, amount: number) => {
      const nearby = (byRoad.get(roadId) ?? []).map((record) => ({ record,
        distance: Math.sqrt(distanceSquared(position, { x: (record.a.x + record.b.x) / 2, z: (record.a.z + record.b.z) / 2 })) }))
        .filter((item) => item.distance <= 75)
        .sort((a, b) => a.distance - b.distance || a.record.id.localeCompare(b.record.id)).slice(0, 4);
      for (const [index, item] of nearby.entries()) item.record.activity[kind] += amount * (1 - index * .18);
    };
    const lotByBuilding = new Map(lots.filter((lot) => lot.buildingId).map((lot) => [lot.buildingId!, lot]));
    for (const occupancy of occupancies) {
      if (!occupancy.active) continue;
      const lot = lotByBuilding.get(occupancy.buildingId);
      if (!lot) continue;
      const amount = occupancy.zoneType === 'residential' ? occupancy.currentPopulation * .23 : occupancy.filledJobs * .16;
      if (amount > 0) addNearby(lot.roadAccess.roadSegmentId, lot.position, occupancy.zoneType, amount);
    }
    const metrics = new Map(stopMetrics.map((metric) => [metric.stopId, metric]));
    for (const stop of stops) {
      const usage = metrics.get(stop.id);
      if (usage) addNearby(stop.roadSegmentId, stop.position, 'transit',
        Math.min(12, usage.waiting * .3 + (usage.boarded + usage.alighted) * .08));
    }
    for (const segment of traffic) {
      const amount = Math.min(2, segment.currentVolume * .035);
      if (amount > 0) for (const edge of byRoad.get(segment.segmentId) ?? []) edge.activity.trips += amount;
    }
  }

  private slotActive(record: EdgeRecord, slot: number, gameSeconds: number): boolean {
    const density = citizenDensity(record.activity, gameSeconds);
    return slot < Math.floor(density) || (slot === Math.floor(density) && visualHash(`${record.id}:${slot}:presence`) < density % 1);
  }

  pose(edgeId: string, slot: number, gameSeconds: number): { position: Vec2; yaw: number } | undefined {
    const record = this.records.get(edgeId);
    if (!record) return undefined;
    const phase = visualHash(`${edgeId}:${slot}:phase`);
    const velocity = 1.15 + visualHash(`${edgeId}:${slot}:speed`) * .55;
    const progress = (phase + gameSeconds * velocity / Math.max(2, record.length * 2)) % 1;
    const t = 1 - Math.abs(progress * 2 - 1);
    const forward = progress < .5 ? 1 : -1;
    return { position: { x: record.a.x + (record.b.x - record.a.x) * t,
      z: record.a.z + (record.b.z - record.a.z) * t },
      yaw: Math.atan2((record.b.x - record.a.x) * forward, (record.b.z - record.a.z) * forward) };
  }

  select(camera: Vec2, profile: VisualAgentProfile, budget: number, previous: readonly CitizenVisual[],
    gameSeconds: number, population: number): { agents: CitizenVisual[]; culled: number } {
    const cap = Math.max(0, Math.min(budget, population));
    if (cap === 0) return { agents: [], culled: 0 };
    const candidates = new Map<string, { visual: CitizenVisual; distance: number; retained: boolean }>();
    const offer = (record: EdgeRecord, slot: number, retained: boolean) => {
      if (!this.slotActive(record, slot, gameSeconds)) return;
      const pose = this.pose(record.id, slot, gameSeconds)!;
      const meters = Math.sqrt(distanceSquared(pose.position, camera));
      if (meters > (retained ? profile.despawnMeters : profile.spawnMeters)) return;
      const id = `${record.id}:citizen-${slot}`;
      candidates.set(id, { visual: { id, edgeId: record.id, slot, ...pose,
        lod: agentLod(meters, profile), variation: Math.floor(visualHash(`${id}:variation`) * 3) },
        distance: meters, retained });
    };
    for (const prior of previous) {
      const record = this.records.get(prior.edgeId);
      if (record) offer(record, prior.slot, true);
    }
    const minX = Math.floor((camera.x - profile.spawnMeters - CELL) / CELL);
    const maxX = Math.floor((camera.x + profile.spawnMeters + CELL) / CELL);
    const minZ = Math.floor((camera.z - profile.spawnMeters - CELL) / CELL);
    const maxZ = Math.floor((camera.z + profile.spawnMeters + CELL) / CELL);
    for (let x = minX; x <= maxX; x++) for (let z = minZ; z <= maxZ; z++) {
      for (const record of this.cells.get(key(x, z)) ?? []) {
        const density = citizenDensity(record.activity, gameSeconds);
        for (let slot = 0; slot < Math.ceil(density); slot++) {
          const id = `${record.id}:citizen-${slot}`;
          if (!candidates.has(id)) offer(record, slot, false);
        }
      }
    }
    const ordered = [...candidates.values()].sort((a, b) =>
      (a.distance - (a.retained ? 12 : 0)) - (b.distance - (b.retained ? 12 : 0))
      || a.visual.id.localeCompare(b.visual.id));
    return { agents: ordered.slice(0, cap).map((entry) => entry.visual), culled: Math.max(0, ordered.length - cap) };
  }
}
