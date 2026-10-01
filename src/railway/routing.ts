import { slicePolyline, distance } from '../roads/geometry';
import type { Vec2 } from '../world/types';
import type { RailwayInfrastructure } from './infrastructure';
import { trackType } from './geometry';
import { MinQueue } from './queue';
import type { RailRoute, RailRouteSection, FormationType } from './operationsTypes';

const cumulativePaths = new WeakMap<readonly Vec2[], Float64Array>();
/** Build once per immutable path; O(log samples) pose lookup for long-world tracks. */
export function sampleRailPath(points: readonly Vec2[], along: number) {
  let cumulative = cumulativePaths.get(points);
  if (!cumulative) { cumulative = new Float64Array(points.length); for (let i = 1; i < points.length; i++) cumulative[i] = cumulative[i - 1] + distance(points[i - 1], points[i]); cumulativePaths.set(points, cumulative); }
  let low = 1, high = points.length - 1;
  while (low < high) { const mid = (low + high) >>> 1; if (cumulative[mid] < along) low = mid + 1; else high = mid; }
  const a = points[Math.max(0, low - 1)], b = points[low] ?? a, length = distance(a, b) || 1;
  const t = (along - (cumulative[low - 1] ?? 0)) / length;
  return { point: { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t }, tangent: { x: (b.x - a.x) / length, z: (b.z - a.z) / length } };
}

/** Dijkstra over (node, incoming track), so switch direction remains authoritative. */
export function railRoute(rail: RailwayInfrastructure, fromFace: string, toFace: string, formation: FormationType): RailRoute {
  const from = rail.face(fromFace).face, to = rail.face(toFace).face, a = rail.requireTrack(from.trackSegmentId), b = rail.requireTrack(to.trackSegmentId);
  if ([a, b].some(t => trackType(t.trackTypeId).gauge !== formation.gauge)) throw new Error('Formation gauge is incompatible with the track.');
  type Part = { segmentId: string; from: number; to: number };
  const allowed = (direction: typeof from.direction, forward: boolean) => direction === 'both' || direction === (forward ? 'forward' : 'reverse');
  const seconds = (segmentId: string, length: number) => length / (Math.min(formation.maxSpeed, trackType(rail.requireTrack(segmentId).trackTypeId).speedLimit) / 3.6);
  const adjacency = new Map<string, string[]>();
  // This query runs on construction/timetable/route events, never on render frames or idle ticks.
  for (const track of rail.segments.values()) if (trackType(track.trackTypeId).gauge === formation.gauge)
    for (const node of [track.startNodeId, track.endNodeId]) { const ids = adjacency.get(node) ?? []; ids.push(track.id); adjacency.set(node, ids); }
  let parts: Part[] | undefined, junctionIds: string[] = [];
  if (a.id === b.id && allowed(from.direction, to.offset >= from.offset) && allowed(to.direction, to.offset >= from.offset)) parts = [{ segmentId: a.id, from: from.offset, to: to.offset }];
  else {
    type Entry = { key: string; node: string; incoming: string; cost: number };
    const queue = new MinQueue<Entry>((x, y) => x.cost < y.cost || x.cost === y.cost && x.key < y.key), costs = new Map<string, number>();
    const previous = new Map<string, { key?: string; part: Part; junction?: string }>();
    for (const [node, offset] of [[a.startNodeId, 0], [a.endNodeId, a.length]] as const) if (allowed(from.direction, offset >= from.offset)) {
      const key = `${node}|${a.id}`, cost = seconds(a.id, Math.abs(offset - from.offset)); costs.set(key, cost); previous.set(key, { part: { segmentId: a.id, from: from.offset, to: offset } }); queue.push({ key, node, incoming: a.id, cost });
    }
    let best = Infinity, target: { key: string; part: Part; junction?: string } | undefined;
    while (queue.size) {
      const entry = queue.pop()!; if (entry.cost !== costs.get(entry.key) || entry.cost > best) continue;
      const junction = `junction-${entry.node.split('-').at(-1)}`;
      const targetOffset = entry.node === b.startNodeId ? 0 : entry.node === b.endNodeId ? b.length : undefined;
      if (targetOffset !== undefined && allowed(to.direction, to.offset >= targetOffset) && rail.junctionAllows(entry.node, entry.incoming, b.id)) {
        const cost = entry.cost + seconds(b.id, Math.abs(to.offset - targetOffset));
        if (cost < best) { best = cost; target = { key: entry.key, part: { segmentId: b.id, from: targetOffset, to: to.offset }, junction: rail.junctions.has(junction) ? junction : undefined }; }
      }
      for (const id of adjacency.get(entry.node) ?? []) {
        if (id === entry.incoming || id === a.id || id === b.id || !rail.junctionAllows(entry.node, entry.incoming, id)) continue;
        const track = rail.requireTrack(id), forward = entry.node === track.startNodeId, node = forward ? track.endNodeId : track.startNodeId;
        const key = `${node}|${id}`, cost = entry.cost + seconds(id, track.length);
        if (cost >= (costs.get(key) ?? Infinity)) continue;
        costs.set(key, cost); previous.set(key, { key: entry.key, part: { segmentId: id, from: forward ? 0 : track.length, to: forward ? track.length : 0 }, junction: rail.junctions.has(junction) ? junction : undefined }); queue.push({ key, node, incoming: id, cost });
      }
    }
    if (target) {
      parts = [target.part]; if (target.junction) junctionIds.push(target.junction);
      let key: string | undefined = target.key;
      while (key) { const step: { key?: string; part: Part; junction?: string } = previous.get(key)!; parts.unshift(step.part); if (step.junction) junctionIds.push(step.junction); key = step.key; }
    }
  }
  if (!parts) throw new Error('No connected rail route respecting gauge and switches.');
  const points: Vec2[] = [], sections: RailRouteSection[] = []; let length = 0, duration = 0;
  for (const part of parts) {
    const track = rail.requireTrack(part.segmentId), span = Math.abs(part.to - part.from), time = seconds(part.segmentId, span);
    const local = slicePolyline(track.points, Math.min(part.from, part.to), Math.max(part.from, part.to)); if (part.to < part.from) local.reverse();
    for (const p of local) if (!points.length || distance(points.at(-1)!, p) > .001) points.push(p);
    sections.push({ ...part, startDistance: length, length: span, duration: time }); length += span; duration += time;
  }
  if (points.length < 2) points.push({ ...points[0] });
  return { points, sections, length, duration: Math.max(1, Math.ceil(duration - 1e-9)), resources: [...new Set([...parts.map(p => p.segmentId), ...junctionIds, fromFace, toFace])] };
}

export function railPose(leg: import('./operationsTypes').RailLeg, gameSeconds: number) {
  const route = leg.route, rawDuration = route.sections.reduce((sum, section) => sum + section.duration, 0);
  let elapsed = Math.max(0, Math.min(1, (gameSeconds - leg.startAt) / Math.max(1, leg.endAt - leg.startAt))) * rawDuration, along = 0;
  for (const section of route.sections) { if (elapsed <= section.duration) { along = section.startDistance + section.length * (section.duration ? elapsed / section.duration : 0); break; } elapsed -= section.duration; along = section.startDistance + section.length; }
  return { ...sampleRailPath(route.points, along), along };
}
