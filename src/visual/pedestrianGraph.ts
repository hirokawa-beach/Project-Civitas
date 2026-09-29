import { pointAtDistance, polylineLength } from '../roads/geometry';
import type { RoadGraphSnapshot, RoadSegment } from '../roads/types';
import type { Lot } from '../lots/types';
import type { TransitStop } from '../transit/types';
import type { Vec2 } from '../world/types';

export type PedestrianNodeKind = 'sidewalk' | 'building-access' | 'transit-stop';
export type PedestrianEdgeKind = 'sidewalk' | 'crossing' | 'access' | 'transit-access';
export interface PedestrianNode { id: string; point: Vec2; kind: PedestrianNodeKind }
export interface PedestrianEdge { id: string; from: string; to: string; kind: PedestrianEdgeKind; roadSegmentId?: string; length: number }
export interface PedestrianGraph { nodes: PedestrianNode[]; edges: PedestrianEdge[] }

const length = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.z - b.z);
const midpoint = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 });
const sidewalkPoint = (road: RoadSegment, along: number, side: number): Vec2 => {
  const { point, tangent } = pointAtDistance(road.geometry.points, along);
  const offset = (road.width / 2 + 2.4) * side;
  return { x: point.x - tangent.z * offset, z: point.z + tangent.x * offset };
};

/** Derived graph only. Roads, lots and transit stops remain the authorities. */
export function buildPedestrianGraph(roads: RoadGraphSnapshot, lots: readonly Lot[], stops: readonly TransitStop[]): PedestrianGraph {
  const nodes: PedestrianNode[] = []; const edges: PedestrianEdge[] = [];
  const byRoad = new Map<string, PedestrianNode[]>();
  const terminals = new Map<string, PedestrianNode[]>();
  const addNode = (node: PedestrianNode) => { nodes.push(node); };
  const addEdge = (from: PedestrianNode, to: PedestrianNode, kind: PedestrianEdgeKind, id: string, roadSegmentId?: string) => {
    edges.push({ id, from: from.id, to: to.id, kind, roadSegmentId, length: length(from.point, to.point) });
  };
  for (const road of roads.segments) {
    if ((road.structureType ?? 'ground') !== 'ground') continue;
    const meters = polylineLength(road.geometry.points);
    const steps = Math.max(1, Math.ceil(meters / 20));
    const local: PedestrianNode[] = [];
    for (const side of [-1, 1]) {
      let prior: PedestrianNode | undefined;
      for (let step = 0; step <= steps; step++) {
        const node = { id: `walk:${road.id}:${side}:${step}`, point: sidewalkPoint(road, meters * step / steps, side), kind: 'sidewalk' as const };
        addNode(node); local.push(node);
        if (prior) addEdge(prior, node, 'sidewalk', `sidewalk:${road.id}:${side}:${step - 1}`, road.id);
        if (step === 0 || step === steps) {
          const roadNodeId = step === 0 ? road.startNodeId : road.endNodeId;
          const list = terminals.get(roadNodeId) ?? []; list.push(node); terminals.set(roadNodeId, list);
        }
        prior = node;
      }
    }
    byRoad.set(road.id, local);
  }
  for (const [junction, adjacent] of terminals) {
    for (let i = 0; i < adjacent.length; i++) for (let j = i + 1; j < adjacent.length; j++) {
      if (length(adjacent[i].point, adjacent[j].point) <= 35)
        addEdge(adjacent[i], adjacent[j], 'crossing', `crossing:${junction}:${i}:${j}`);
    }
  }
  const connect = (id: string, point: Vec2, roadId: string, kind: PedestrianNodeKind, edgeKind: PedestrianEdgeKind) => {
    const candidates = byRoad.get(roadId);
    if (!candidates?.length) return;
    let closest = candidates[0]; let best = length(point, closest.point);
    for (const candidate of candidates) {
      const distance = length(point, candidate.point);
      if (distance < best) { best = distance; closest = candidate; }
    }
    const node = { id, point, kind }; addNode(node);
    addEdge(node, closest, edgeKind, `${edgeKind}:${id}`, roadId);
  };
  for (const lot of lots) if (lot.buildingId) connect(`building:${lot.buildingId}`,
    midpoint(...lot.roadAccess.frontage), lot.roadAccess.roadSegmentId, 'building-access', 'access');
  for (const stop of stops) connect(`stop:${stop.id}`, stop.position, stop.roadSegmentId, 'transit-stop', 'transit-access');
  return { nodes, edges };
}
