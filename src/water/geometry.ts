import earcut from 'earcut';
import type { WaterBody, WaterGeometry, WaterPolygon, WorldDimensions } from '../world/metadata';
import type { Vec2 } from '../world/types';

export const ringArea = (ring: readonly Vec2[]): number => ring.reduce((sum, p, i) => {
  const q = ring[(i + 1) % ring.length]; return sum + p.x * q.z - q.x * p.z;
}, 0) / 2;
export function pointInRing(p: Vec2, ring: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]; const b = ring[j];
    if (distanceToSegment(p, a, b) < 1e-7) return true;
    if ((a.z > p.z) !== (b.z > p.z) && p.x < (b.x - a.x) * (p.z - a.z) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}
export function distanceToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x; const dz = b.z - a.z;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz || 1)));
  return Math.hypot(p.x - a.x - dx * t, p.z - a.z - dz * t);
}
const segmentsIntersect = (a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean => {
  const cross = (p: Vec2, q: Vec2, r: Vec2) => (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
  const abC = cross(a, b, c); const abD = cross(a, b, d); const cdA = cross(c, d, a); const cdB = cross(c, d, b);
  if (abC * abD < 0 && cdA * cdB < 0) return true;
  return distanceToSegment(a, c, d) < 1e-7 || distanceToSegment(b, c, d) < 1e-7 || distanceToSegment(c, a, b) < 1e-7 || distanceToSegment(d, a, b) < 1e-7;
};
export function triangulateWater(p: WaterPolygon) {
  const rings = [p.vertices, ...(p.holes ?? [])]; const points = rings.flat();
  let offset = p.vertices.length;
  const holes = rings.slice(1).map(r => { const start = offset; offset += r.length; return start; });
  return { points, indices: earcut(points.flatMap(v => [v.x, v.z]), holes, 2) };
}
export function validateWaterPolygon(p: WaterPolygon): void {
  const rings = [p.vertices, ...(p.holes ?? [])];
  for (const ring of rings) {
    if (Math.abs(ringArea(ring)) < .01 || ring.some((v, i) => Math.hypot(v.x - ring[(i + 1) % ring.length].x, v.z - ring[(i + 1) % ring.length].z) < 1e-7))
      throw new Error('Water polygon has a zero area or duplicate edge.');
  }
  if (p.holes?.some(h => h.some(v => !pointInRing(v, p.vertices)))) throw new Error('Water polygon hole is outside its boundary.');
  const { points, indices } = triangulateWater(p);
  let area = 0;
  for (let i = 0; i < indices.length; i += 3) area += Math.abs(ringArea([points[indices[i]], points[indices[i + 1]], points[indices[i + 2]]]));
  const expected = Math.abs(ringArea(p.vertices)) - (p.holes ?? []).reduce((sum, h) => sum + Math.abs(ringArea(h)), 0);
  if (expected <= 0 || Math.abs(area - expected) > Math.max(.01, expected * 1e-6)) throw new Error('Water polygon is intersecting or cannot be triangulated.');
}
/** A width profile becomes a fixed shoreline, shared by rendering and all queries. */
export function waterPolygons(geometry: WaterGeometry, world?: WorldDimensions): WaterPolygon[] {
  if (geometry.kind === 'polygon') return [{ vertices: geometry.vertices, holes: geometry.holes }];
  if (geometry.kind === 'multipolygon') return geometry.polygons;
  const left: Vec2[] = []; const right: Vec2[] = [];
  for (let i = 0; i < geometry.path.length; i++) {
    const p = geometry.path[i]; const a = geometry.path[Math.max(0, i - 1)]; const b = geometry.path[Math.min(geometry.path.length - 1, i + 1)];
    const length = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    const x = -(b.z - a.z) / length * geometry.widths[i] / 2; const z = (b.x - a.x) / length * geometry.widths[i] / 2;
    const clip = (q: Vec2): Vec2 => world ? { x: Math.max(-world.worldWidthMeters / 2, Math.min(world.worldWidthMeters / 2, q.x)), z: Math.max(-world.worldDepthMeters / 2, Math.min(world.worldDepthMeters / 2, q.z)) } : q;
    left.push(clip({ x: p.x + x, z: p.z + z })); right.push(clip({ x: p.x - x, z: p.z - z }));
  }
  return [{ vertices: [...left, ...right.reverse()] }];
}
export function withShoreline(body: Omit<WaterBody, 'boundary'>, world?: WorldDimensions): WaterBody {
  return { ...structuredClone(body), boundary: waterPolygons(body.geometry, world).flatMap(p => [p.vertices, ...(p.holes ?? [])]).map(r => [...r, r[0]]) };
}

/** A chunk index is rebuilt only on Water Body edits/world replacement. */
export class Hydrography {
  private readonly buckets = new Map<string, Array<{ body: WaterBody; polygon: WaterPolygon }>>();
  constructor(readonly bodies: readonly WaterBody[], readonly world: WorldDimensions) {
    const size = world.chunkSizeMeters;
    for (const body of bodies) for (const polygon of waterPolygons(body.geometry, world)) {
      const xs = polygon.vertices.map(p => p.x); const zs = polygon.vertices.map(p => p.z);
      for (let z = Math.floor(Math.min(...zs) / size); z <= Math.floor(Math.max(...zs) / size); z++)
        for (let x = Math.floor(Math.min(...xs) / size); x <= Math.floor(Math.max(...xs) / size); x++) {
          const key = `${x}:${z}`; const bucket = this.buckets.get(key) ?? [];
          bucket.push({ body, polygon }); this.buckets.set(key, bucket);
        }
    }
  }
  bodyAt(x: number, z: number): WaterBody | undefined {
    const candidates = this.buckets.get(`${Math.floor(x / this.world.chunkSizeMeters)}:${Math.floor(z / this.world.chunkSizeMeters)}`) ?? [];
    let result: WaterBody | undefined;
    for (const { body, polygon } of candidates) if (pointInRing({ x, z }, polygon.vertices) && !polygon.holes?.some(h => pointInRing({ x, z }, h)))
      if (!result || body.surfaceElevation > result.surfaceElevation || body.surfaceElevation === result.surfaceElevation && body.id < result.id) result = body;
    return result;
  }
  isWaterAt(x: number, z: number): boolean { return !!this.bodyAt(x, z); }
  waterSurfaceAt(x: number, z: number): number | undefined { return this.bodyAt(x, z)?.surfaceElevation; }
  distanceToShoreline(x: number, z: number, radius = this.world.chunkSizeMeters): number {
    const bodies = new Set<WaterBody>(); const size = this.world.chunkSizeMeters;
    for (let iz = Math.floor((z - radius) / size); iz <= Math.floor((z + radius) / size); iz++)
      for (let ix = Math.floor((x - radius) / size); ix <= Math.floor((x + radius) / size); ix++)
        for (const entry of this.buckets.get(`${ix}:${iz}`) ?? []) bodies.add(entry.body);
    let closest = Infinity;
    for (const body of bodies) for (const ring of body.boundary) for (let i = 1; i < ring.length; i++) closest = Math.min(closest, distanceToSegment({ x, z }, ring[i - 1], ring[i]));
    return closest <= radius ? closest : Infinity;
  }
  intersectsSegment(a: Vec2, b: Vec2): boolean {
    if (this.isWaterAt(a.x, a.z) || this.isWaterAt(b.x, b.z)) return true;
    const candidates = new Set<WaterPolygon>(); const size = this.world.chunkSizeMeters;
    for (let z = Math.floor(Math.min(a.z, b.z) / size); z <= Math.floor(Math.max(a.z, b.z) / size); z++)
      for (let x = Math.floor(Math.min(a.x, b.x) / size); x <= Math.floor(Math.max(a.x, b.x) / size); x++)
        for (const entry of this.buckets.get(`${x}:${z}`) ?? []) candidates.add(entry.polygon);
    for (const polygon of candidates) for (const ring of [polygon.vertices, ...(polygon.holes ?? [])])
      for (let i = 0; i < ring.length; i++) if (segmentsIntersect(a, b, ring[i], ring[(i + 1) % ring.length])) return true;
    return false;
  }
}
