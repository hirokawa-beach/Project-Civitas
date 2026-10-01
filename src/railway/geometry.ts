import type { Vec2 } from '../world/types';
import { buildCurveGeometry, buildTwoCurveGeometry, buildContinuousCurveGeometry } from '../roads/curveGeometry';
import { distance, subtract, cross, polylineLength, dot } from '../roads/geometry';
import { TRACK_TYPES, type TrackMode } from './types';
import type { LandOwnership } from '../world/landOwnership';

export function trackType(id: string) { const type = TRACK_TYPES.find(t => t.id === id); if (!type) throw new Error('Unknown track type.'); return type; }
export function sampleTrackPath(points: Vec2[]): Vec2[] {
  const result = [{ ...points[0] }];
  for (let i = 1; i < points.length; i++) { const a = points[i - 1], b = points[i], steps = Math.ceil(distance(a, b) / 4); for (let j = 1; j <= steps; j++) result.push({ x: a.x + (b.x - a.x) * j / steps, z: a.z + (b.z - a.z) * j / steps }); }
  return result;
}
export function collinearOverlap(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const u = subtract(b, a), length = distance(a, b); if (!length) return false;
  if (Math.abs(cross(u, subtract(c, a))) / length > .01 || Math.abs(cross(u, subtract(d, a))) / length > .01) return false;
  const p = dot(subtract(c, a), u) / length, q = dot(subtract(d, a), u) / length;
  return Math.min(length, Math.max(p, q)) - Math.max(0, Math.min(p, q)) > .05;
}
export function trackGeometry(mode: TrackMode, anchors: Vec2[]): Vec2[] {
  if (mode === 'straight' && anchors.length === 2) return anchors.map(p => ({ ...p }));
  if (mode === 'one-curve' && anchors.length === 3) return buildCurveGeometry({ start: anchors[0], directionPoint: anchors[1], end: anchors[2], sampleSpacing: 4 }).points;
  if (mode === 'two-curve' && anchors.length === 4) return buildTwoCurveGeometry({ start: anchors[0], firstDirectionPoint: anchors[1], secondDirectionPoint: anchors[2], end: anchors[3], sampleSpacing: 4 }).points;
  if (mode === 'continuous' && anchors.length === 3) return buildContinuousCurveGeometry({ start: anchors[0], initialDirection: subtract(anchors[1], anchors[0]), end: anchors[2], sampleSpacing: 4 }).points;
  throw new Error('Supply the start, direction controls and end for this track mode.');
}
export function validateTrack(points: Vec2[], typeId: string, height: (x: number, z: number) => number,
  ownership: LandOwnership, waterAt: (x: number, z: number) => boolean = () => false, minimumLength = 2): void {
  const type = trackType(typeId);
  if (!Array.isArray(points) || points.length < 2 || points.length > 16384 || points.some(p => !p || !Number.isFinite(p.x) || !Number.isFinite(p.z))
    || polylineLength(points) < minimumLength) throw new Error('Track needs a finite path of at least 2m (split sections must remain nonzero).');
  const permission = ownership.canConstruct({ kind: 'path', points, width: 4 });
  if (!permission.allowed) throw new Error(permission.reason);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], length = distance(a, b);
    if (length < .01) throw new Error('Track contains a duplicate point.');
    // Sample the ground along long straight legs too, not just at user anchors.
    const steps = Math.ceil(length / 4); let previous = height(a.x, a.z);
    for (let j = 0; j <= steps; j++) {
      const x = a.x + (b.x - a.x) * j / steps, z = a.z + (b.z - a.z) * j / steps, h = height(x, z);
      if (!Number.isFinite(h) || waterAt(x, z)) throw new Error('Surface track cannot cross water or missing terrain. Bridges/tunnels are not supported.');
      if (j && Math.abs(h - previous) / (length / steps) > type.maxGrade + 1e-6) throw new Error('Track grade exceeds the track type limit.');
      previous = h;
    }
    if (i < points.length - 1) {
      const c = points[i + 1], ab = distance(a, b), bc = distance(b, c), ac = distance(a, c);
      const area2 = Math.abs(cross(subtract(b, a), subtract(c, a)));
      if (area2 > 1e-8 && ab * bc * ac / (2 * area2) < type.minimumCurveRadius - .1) throw new Error('Track curve is below the minimum radius.');
      if (ac < .01) throw new Error('Track cannot reverse within a segment.');
    }
  }
}

/** Local grid index, shared by construction and camera queries. */
export class TrackIndex {
  private buckets = new Map<string, Set<string>>();
  private segments = new Map<string, { id: string; points: Vec2[] }>();
  rebuild(segments: Iterable<{ id: string; points: Vec2[] }>): void {
    this.buckets.clear(); this.segments.clear();
    for (const segment of segments) {
      this.segments.set(segment.id, segment);
      for (let i = 1; i < segment.points.length; i++) for (const key of this.keys(segment.points[i - 1], segment.points[i])) {
        const bucket = this.buckets.get(key) ?? new Set(); bucket.add(segment.id); this.buckets.set(key, bucket);
      }
    }
  }
  query(a: Vec2, b: Vec2) {
    const ids = new Set<string>(); for (const key of this.keys(a, b)) for (const id of this.buckets.get(key) ?? []) ids.add(id);
    return [...ids].map(id => this.segments.get(id)!);
  }
  private *keys(a: Vec2, b: Vec2) {
    for (let x = Math.floor(Math.min(a.x, b.x) / 128); x <= Math.floor(Math.max(a.x, b.x) / 128); x++)
      for (let z = Math.floor(Math.min(a.z, b.z) / 128); z <= Math.floor(Math.max(a.z, b.z) / 128); z++) yield `${x}:${z}`;
  }
}
