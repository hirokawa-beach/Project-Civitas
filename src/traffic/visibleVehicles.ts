import { pointAtDistance } from '../roads/geometry';
import type { RoadSegment } from '../roads/types';
import type { Vec2 } from '../world/types';
import type { VisibleVehicleCandidate } from './types';

/** Rendering-only selection; traffic state is never inferred from meshes. */
export function selectVisibleVehicles(candidates: readonly VisibleVehicleCandidate[], segments: readonly RoadSegment[],
  cameraTarget: Vec2, radius: number, cap: number): VisibleVehicleCandidate[] {
  if (cap <= 0 || radius <= 0) return [];
  const byId = new Map(segments.map((segment) => [segment.id, segment]));
  const radiusSquared = radius * radius;
  const visible: Array<{ candidate: VisibleVehicleCandidate; distanceSquared: number }> = [];
  for (const candidate of candidates) {
    const segment = byId.get(candidate.segmentId);
    if (!segment) continue;
    const { point } = pointAtDistance(segment.geometry.points, candidate.along);
    const distanceSquared = (point.x - cameraTarget.x) ** 2 + (point.z - cameraTarget.z) ** 2;
    if (distanceSquared <= radiusSquared) visible.push({ candidate, distanceSquared });
  }
  visible.sort((a, b) => a.distanceSquared - b.distanceSquared || a.candidate.tripId.localeCompare(b.candidate.tripId));
  return visible.slice(0, cap).map(({ candidate }) => candidate);
}
