import { closestPointOnPolyline, polylineLength } from '../roads/geometry';
import type { RoadGraphSnapshot, RoadSegment } from '../roads/types';
import type { RoadNodeId, RoadSegmentId } from '../shared/ids';
import type { TripEndpoint, RouteLeg, SegmentTraffic, TrafficConfig } from './types';

type Direction = RouteLeg['direction'];
interface Edge { to: RoadNodeId; segmentId: RoadSegmentId; direction: Direction; length: number }
interface CacheEntry { route: RouteLeg[] | null; segmentIds: Set<RoadSegmentId>; nodeIds: Set<RoadNodeId> }
interface EndpointOption { nodeId: RoadNodeId; leg?: RouteLeg; cost: number }

const legLength = (leg: RouteLeg): number => Math.abs(leg.toAlong - leg.fromAlong);
const cloneRoute = (route: RouteLeg[] | null): RouteLeg[] | null => route?.map((leg) => ({ ...leg })) ?? null;

/** Directed road routing. Each graph edge exists only if a lane permits its direction. */
export class RoadRouter {
  private graph: RoadGraphSnapshot = { nodes: [], segments: [], lanes: [] };
  private readonly segments = new Map<RoadSegmentId, RoadSegment>();
  private readonly adjacency = new Map<RoadNodeId, Edge[]>();
  private readonly permitted = new Map<RoadSegmentId, Set<Direction>>();
  private readonly cache = new Map<string, CacheEntry>();
  private signatureBySegment = new Map<RoadSegmentId, string>();
  lastInvalidated = 0;
  get cacheSize(): number { return this.cache.size; }
  clearCache(): void { this.cache.clear(); }

  constructor(private readonly config: TrafficConfig) {}

  updateGraph(graph: RoadGraphSnapshot): Set<RoadSegmentId> {
    const laneDirections = new Map<string, string[]>();
    for (const lane of graph.lanes) {
      const directions = laneDirections.get(lane.roadSegmentId) ?? [];
      directions.push(`${lane.id}:${lane.direction}`);
      laneDirections.set(lane.roadSegmentId, directions);
    }
    const nextSignatures = new Map(graph.segments.map((segment) => [segment.id,
      JSON.stringify([segment.startNodeId, segment.endNodeId, segment.geometry.points, segment.speedLimit,
        laneDirections.get(segment.id)?.sort()]) ]));
    const changed = new Set<RoadSegmentId>();
    for (const [id, signature] of this.signatureBySegment) if (nextSignatures.get(id) !== signature) changed.add(id);
    for (const [id, signature] of nextSignatures) if (this.signatureBySegment.get(id) !== signature) changed.add(id);
    const touchedNodes = new Set<RoadNodeId>();
    for (const segment of [...this.graph.segments, ...graph.segments]) if (changed.has(segment.id)) {
      touchedNodes.add(segment.startNodeId);
      touchedNodes.add(segment.endNodeId);
    }
    // A new edge can create a shorter path without touching the old route.
    this.lastInvalidated = changed.size > 0 ? this.cache.size : 0;
    if (changed.size > 0) this.cache.clear();
    this.graph = graph;
    this.signatureBySegment = nextSignatures;
    this.segments.clear();
    this.adjacency.clear();
    this.permitted.clear();
    for (const lane of graph.lanes) {
      const directions = this.permitted.get(lane.roadSegmentId) ?? new Set<Direction>();
      directions.add(lane.direction);
      this.permitted.set(lane.roadSegmentId, directions);
    }
    for (const segment of graph.segments) {
      this.segments.set(segment.id, segment);
      const length = polylineLength(segment.geometry.points);
      if (this.allows(segment.id, 'forward')) this.addEdge(segment.startNodeId, { to: segment.endNodeId,
        segmentId: segment.id, direction: 'forward', length });
      if (this.allows(segment.id, 'backward')) this.addEdge(segment.endNodeId, { to: segment.startNodeId,
        segmentId: segment.id, direction: 'backward', length });
    }
    return changed;
  }

  route(origin: TripEndpoint, destination: TripEndpoint, traffic: ReadonlyMap<RoadSegmentId, SegmentTraffic>): RouteLeg[] | null {
    const key = `${origin.kind}:${origin.id}:${origin.roadSegmentId ?? origin.roadNodeId}:${origin.position.x},${origin.position.z}`
      + `>${destination.kind}:${destination.id}:${destination.roadSegmentId ?? destination.roadNodeId}:${destination.position.x},${destination.position.z}`;
    const cached = this.cache.get(key);
    if (cached) return cloneRoute(cached.route);
    const originOptions = this.originOptions(origin, traffic);
    const destinationOptions = this.destinationOptions(destination, traffic);
    let best: RouteLeg[] | null = null;
    let bestCost = Infinity;
    if (origin.roadSegmentId && origin.roadSegmentId === destination.roadSegmentId) {
      const segment = this.segments.get(origin.roadSegmentId);
      if (segment) {
        const from = closestPointOnPolyline(origin.position, segment.geometry.points).along;
        const to = closestPointOnPolyline(destination.position, segment.geometry.points).along;
        const direction: Direction = to >= from ? 'forward' : 'backward';
        if (Math.abs(to - from) > 0.1 && this.allows(segment.id, direction)) {
          best = [{ segmentId: segment.id, direction, fromAlong: from, toAlong: to }];
          bestCost = this.legCost(best[0], traffic);
        }
      }
    }
    for (const start of originOptions) for (const end of destinationOptions) {
      const middle = this.shortestPath(start.nodeId, end.nodeId, traffic);
      if (!middle) continue;
      const route = [...(start.leg ? [start.leg] : []), ...middle.route, ...(end.leg ? [end.leg] : [])];
      if (route.length === 0) continue;
      const cost = start.cost + middle.cost + end.cost;
      if (cost < bestCost) { best = route; bestCost = cost; }
    }
    const segmentIds = new Set(best?.map((leg) => leg.segmentId) ?? []);
    if (origin.roadSegmentId) segmentIds.add(origin.roadSegmentId);
    if (destination.roadSegmentId) segmentIds.add(destination.roadSegmentId);
    const nodeIds = new Set<RoadNodeId>([...originOptions, ...destinationOptions].map((option) => option.nodeId));
    if (best) for (const leg of best) {
      const segment = this.segments.get(leg.segmentId);
      if (segment) { nodeIds.add(segment.startNodeId); nodeIds.add(segment.endNodeId); }
    }
    this.cache.set(key, { route: cloneRoute(best), segmentIds, nodeIds });
    return cloneRoute(best);
  }

  private allows(segmentId: RoadSegmentId, direction: Direction): boolean {
    return this.permitted.get(segmentId)?.has(direction) === true;
  }

  private addEdge(nodeId: RoadNodeId, edge: Edge): void {
    const edges = this.adjacency.get(nodeId) ?? [];
    edges.push(edge);
    this.adjacency.set(nodeId, edges);
  }

  private endpointOptions(endpoint: TripEndpoint, fromBuilding: boolean,
    traffic: ReadonlyMap<RoadSegmentId, SegmentTraffic>): EndpointOption[] {
    if (endpoint.kind === 'outside') return endpoint.roadNodeId && this.graph.nodes.some((node) => node.id === endpoint.roadNodeId)
      ? [{ nodeId: endpoint.roadNodeId, cost: 0 }] : [];
    const segment = endpoint.roadSegmentId && this.segments.get(endpoint.roadSegmentId);
    if (!segment) return [];
    const length = polylineLength(segment.geometry.points);
    const along = closestPointOnPolyline(endpoint.position, segment.geometry.points).along;
    const options: EndpointOption[] = [];
    const add = (nodeId: RoadNodeId, direction: Direction, fromAlong: number, toAlong: number): void => {
      if (!this.allows(segment.id, direction)) return;
      const leg = Math.abs(toAlong - fromAlong) > 0.1
        ? { segmentId: segment.id, direction, fromAlong, toAlong } : undefined;
      options.push({ nodeId, leg, cost: leg ? this.legCost(leg, traffic) : 0 });
    };
    if (fromBuilding) {
      add(segment.startNodeId, 'backward', along, 0);
      add(segment.endNodeId, 'forward', along, length);
    } else {
      add(segment.startNodeId, 'forward', 0, along);
      add(segment.endNodeId, 'backward', length, along);
    }
    return options;
  }

  private originOptions(endpoint: TripEndpoint, traffic: ReadonlyMap<RoadSegmentId, SegmentTraffic>): EndpointOption[] {
    return this.endpointOptions(endpoint, true, traffic);
  }
  private destinationOptions(endpoint: TripEndpoint, traffic: ReadonlyMap<RoadSegmentId, SegmentTraffic>): EndpointOption[] {
    return this.endpointOptions(endpoint, false, traffic);
  }

  private legCost(leg: RouteLeg, traffic: ReadonlyMap<RoadSegmentId, SegmentTraffic>): number {
    const segment = this.segments.get(leg.segmentId)!;
    const ratio = traffic.get(segment.id)?.congestionRatio ?? 0;
    const metresPerSecond = Math.max(1, segment.speedLimit / 3.6);
    return legLength(leg) / metresPerSecond * (1 + this.config.congestionPenalty * ratio);
  }

  private shortestPath(start: RoadNodeId, end: RoadNodeId,
    traffic: ReadonlyMap<RoadSegmentId, SegmentTraffic>): { route: RouteLeg[]; cost: number } | null {
    if (start === end) return { route: [], cost: 0 };
    const distance = new Map<RoadNodeId, number>([[start, 0]]);
    const previous = new Map<RoadNodeId, { nodeId: RoadNodeId; edge: Edge }>();
    const pending = new Set<RoadNodeId>([start]);
    while (pending.size > 0) {
      let current: RoadNodeId | undefined;
      for (const id of pending) if (!current || distance.get(id)! < distance.get(current)!) current = id;
      if (!current) break;
      pending.delete(current);
      if (current === end) break;
      const intersectionDelay = (this.adjacency.get(current)?.length ?? 0) > 2
        ? this.config.intersectionDelayGameSeconds : 0;
      for (const edge of this.adjacency.get(current) ?? []) {
        const leg: RouteLeg = { segmentId: edge.segmentId, direction: edge.direction,
          fromAlong: edge.direction === 'forward' ? 0 : edge.length,
          toAlong: edge.direction === 'forward' ? edge.length : 0 };
        const candidate = distance.get(current)! + this.legCost(leg, traffic) + intersectionDelay;
        if (candidate >= (distance.get(edge.to) ?? Infinity)) continue;
        distance.set(edge.to, candidate);
        previous.set(edge.to, { nodeId: current, edge });
        pending.add(edge.to);
      }
    }
    if (!distance.has(end)) return null;
    const reversed: RouteLeg[] = [];
    for (let node = end; node !== start;) {
      const step = previous.get(node);
      if (!step) return null;
      reversed.push({ segmentId: step.edge.segmentId, direction: step.edge.direction,
        fromAlong: step.edge.direction === 'forward' ? 0 : step.edge.length,
        toAlong: step.edge.direction === 'forward' ? step.edge.length : 0 });
      node = step.nodeId;
    }
    return { route: reversed.reverse(), cost: distance.get(end)! };
  }
}
