import { pointAtDistance } from '../roads/geometry';
import type { RoadSegment } from '../roads/types';
import type { Vec2 } from '../world/types';
import type { VisibleVehicleCandidate } from './types';

/** Rendering-only selection; traffic state is never inferred from meshes. */
export function selectVisibleVehicles(candidates: readonly VisibleVehicleCandidate[], segments: readonly RoadSegment[],
  cameraTarget: Vec2, radius: number, cap: number, previousIds: ReadonlySet<string> = new Set(),
  despawnRadius = radius): VisibleVehicleCandidate[] {
  if (cap <= 0 || radius <= 0) return [];
  const byId = new Map(segments.map((segment) => [segment.id, segment]));
  const radiusSquared = radius * radius;
  const visible: Array<{ candidate: VisibleVehicleCandidate; distanceSquared: number; retained: boolean }> = [];
  for (const candidate of candidates) {
    const segment = byId.get(candidate.segmentId);
    if (!segment) continue;
    const { point } = pointAtDistance(segment.geometry.points, candidate.along);
    const distanceSquared = (point.x - cameraTarget.x) ** 2 + (point.z - cameraTarget.z) ** 2;
    const retained = previousIds.has(candidate.vehicleId ?? candidate.tripId);
    if (distanceSquared <= (retained ? despawnRadius * despawnRadius : radiusSquared))
      visible.push({ candidate, distanceSquared, retained });
  }
  visible.sort((a, b) => (a.distanceSquared - (a.retained ? 144 : 0))
    - (b.distanceSquared - (b.retained ? 144 : 0))
    || (a.candidate.vehicleId ?? a.candidate.tripId).localeCompare(b.candidate.vehicleId ?? b.candidate.tripId));
  // A trip batch can put many logical vehicles onto the same short road.
  // Render representatives with room for their low-poly bodies, preserving
  // the simulation count and the candidates' logical positions.
  const occupied = new Map<string, number>();
  const selected: VisibleVehicleCandidate[] = [];
  for (const { candidate } of visible) {
    const lane = `${candidate.segmentId}:${candidate.direction}`;
    const bucket = Math.floor(candidate.along / 5);
    let blocked = false;
    for (let neighbor = bucket - 1; neighbor <= bucket + 1; neighbor++) {
      const along = occupied.get(`${lane}:${neighbor}`);
      if (along !== undefined && Math.abs(along - candidate.along) < 4.5) { blocked = true; break; }
    }
    if (blocked) continue;
    occupied.set(`${lane}:${bucket}`, candidate.along);
    selected.push(candidate);
    if (selected.length >= cap) break;
  }
  return selected;
}
