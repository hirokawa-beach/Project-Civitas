import type { RoadGraphSnapshot, RoadNode, RoadSegment } from './types';
import type { Vec2 } from '../world/types';

const DEFAULT_BUCKET_SIZE = 64;

interface Bounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

const boundsForPoints = (points: readonly Vec2[], padding: number): Bounds => ({
  minX: Math.min(...points.map((point) => point.x)) - padding,
  maxX: Math.max(...points.map((point) => point.x)) + padding,
  minZ: Math.min(...points.map((point) => point.z)) - padding,
  maxZ: Math.max(...points.map((point) => point.z)) + padding,
});

export class RoadSpatialIndex {
  private readonly nodeBuckets = new Map<string, RoadNode[]>();
  private readonly segmentBuckets = new Map<string, RoadSegment[]>();
  private nodeOrder = new Map<RoadNode['id'], number>();
  private segmentOrder = new Map<RoadSegment['id'], number>();

  constructor(private readonly bucketSize = DEFAULT_BUCKET_SIZE) {}

  rebuild(graph: RoadGraphSnapshot): void {
    this.nodeBuckets.clear();
    this.segmentBuckets.clear();
    this.nodeOrder = new Map(graph.nodes.map((node, index) => [node.id, index]));
    this.segmentOrder = new Map(graph.segments.map((segment, index) => [segment.id, index]));
    for (const node of graph.nodes) this.addToBuckets(this.nodeBuckets, boundsForPoints([node.position], 0), node);
    for (const segment of graph.segments) {
      this.addToBuckets(this.segmentBuckets, boundsForPoints(segment.geometry.points, segment.width / 2), segment);
    }
  }

  query(points: readonly Vec2[], padding: number): RoadGraphSnapshot {
    if (points.length === 0) return { nodes: [], segments: [], lanes: [] };
    const bounds = boundsForPoints(points, padding);
    const nodes = this.collect(this.nodeBuckets, bounds)
      .sort((left, right) => (this.nodeOrder.get(left.id) ?? 0) - (this.nodeOrder.get(right.id) ?? 0));
    const segments = this.collect(this.segmentBuckets, bounds)
      .sort((left, right) => (this.segmentOrder.get(left.id) ?? 0) - (this.segmentOrder.get(right.id) ?? 0));
    return { nodes, segments, lanes: [] };
  }

  private addToBuckets<T>(buckets: Map<string, T[]>, bounds: Bounds, value: T): void {
    const [minX, maxX, minZ, maxZ] = this.bucketRange(bounds);
    for (let x = minX; x <= maxX; x += 1) {
      for (let z = minZ; z <= maxZ; z += 1) {
        const key = `${x}:${z}`;
        const values = buckets.get(key) ?? [];
        values.push(value);
        buckets.set(key, values);
      }
    }
  }

  private collect<T extends { id: string }>(buckets: Map<string, T[]>, bounds: Bounds): T[] {
    const [minX, maxX, minZ, maxZ] = this.bucketRange(bounds);
    const values = new Map<string, T>();
    for (let x = minX; x <= maxX; x += 1) {
      for (let z = minZ; z <= maxZ; z += 1) {
        for (const value of buckets.get(`${x}:${z}`) ?? []) values.set(value.id, value);
      }
    }
    return [...values.values()];
  }

  private bucketRange(bounds: Bounds): [number, number, number, number] {
    return [
      Math.floor(bounds.minX / this.bucketSize),
      Math.floor(bounds.maxX / this.bucketSize),
      Math.floor(bounds.minZ / this.bucketSize),
      Math.floor(bounds.maxZ / this.bucketSize),
    ];
  }
}
