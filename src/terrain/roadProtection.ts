import type { RoadSegment } from '../roads/types';
import { createWorldMetadata, type WorldDimensions } from '../world/metadata';
import type { ServiceFacility } from '../services/types';

// Keep the vertices used to interpolate the road surface fixed as well as the
// road itself. Fade edits in beyond the shoulder to avoid a hard terrain step.

const SHOULDER_FADE = 12;
const clampIndex = (value: number, limit: number): number => Math.max(0, Math.min(limit - 1, value));

export function buildRoadTerrainProtection(roads: readonly Pick<RoadSegment, 'geometry' | 'width'>[], world: WorldDimensions = createWorldMetadata()): Float32Array {
  const editWeights = new Float32Array(world.terrainColumns * world.terrainRows);
  editWeights.fill(1);
  for (const road of roads) {
    const hardRadius = road.width / 2 + world.terrainSampleSpacingMeters;
    const outerRadius = hardRadius + SHOULDER_FADE;
    const points = road.geometry.points;
    for (let leg = 1; leg < points.length; leg += 1) {
      const a = points[leg - 1];
      const b = points[leg];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const lengthSquared = dx * dx + dz * dz;
      if (lengthSquared === 0) continue;
      const left = clampIndex(Math.floor((Math.min(a.x, b.x) - outerRadius + world.worldWidthMeters / 2) / world.terrainSampleSpacingMeters), world.terrainColumns);
      const right = clampIndex(Math.ceil((Math.max(a.x, b.x) + outerRadius + world.worldWidthMeters / 2) / world.terrainSampleSpacingMeters), world.terrainColumns);
      const top = clampIndex(Math.floor((Math.min(a.z, b.z) - outerRadius + world.worldDepthMeters / 2) / world.terrainSampleSpacingMeters), world.terrainRows);
      const bottom = clampIndex(Math.ceil((Math.max(a.z, b.z) + outerRadius + world.worldDepthMeters / 2) / world.terrainSampleSpacingMeters), world.terrainRows);
      for (let row = top; row <= bottom; row += 1) {
        const z = row * world.terrainSampleSpacingMeters - world.worldDepthMeters / 2;
        for (let column = left; column <= right; column += 1) {
          const x = column * world.terrainSampleSpacingMeters - world.worldWidthMeters / 2;
          const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / lengthSquared));
          const distance = Math.hypot(x - a.x - t * dx, z - a.z - t * dz);
          if (distance >= outerRadius) continue;
          const shoulder = Math.max(0, (distance - hardRadius) / SHOULDER_FADE);
          const weight = shoulder * shoulder * (3 - 2 * shoulder);
          const index = row * world.terrainColumns + column;
          editWeights[index] = Math.min(editWeights[index], weight);
        }
      }
    }
  }
  return editWeights;
}

/** Keep built service lots level while terrain brushes fade in beyond their edges. */
export function protectServiceLots(weights: Float32Array, facilities: readonly ServiceFacility[], world: WorldDimensions = createWorldMetadata()): void {
  for (const facility of facilities) {
    const { corners, width, depth } = facility.lot;
    const origin = corners[0];
    const ux = (corners[1].x - origin.x) / width; const uz = (corners[1].z - origin.z) / width;
    const vx = (corners[3].x - origin.x) / depth; const vz = (corners[3].z - origin.z) / depth;
    const left = clampIndex(Math.floor((Math.min(...corners.map((point) => point.x)) - 16 + world.worldWidthMeters / 2) / world.terrainSampleSpacingMeters), world.terrainColumns);
    const right = clampIndex(Math.ceil((Math.max(...corners.map((point) => point.x)) + 16 + world.worldWidthMeters / 2) / world.terrainSampleSpacingMeters), world.terrainColumns);
    const top = clampIndex(Math.floor((Math.min(...corners.map((point) => point.z)) - 16 + world.worldDepthMeters / 2) / world.terrainSampleSpacingMeters), world.terrainRows);
    const bottom = clampIndex(Math.ceil((Math.max(...corners.map((point) => point.z)) + 16 + world.worldDepthMeters / 2) / world.terrainSampleSpacingMeters), world.terrainRows);
    for (let row = top; row <= bottom; row += 1) for (let column = left; column <= right; column += 1) {
      const x = column * world.terrainSampleSpacingMeters - world.worldWidthMeters / 2 - origin.x;
      const z = row * world.terrainSampleSpacingMeters - world.worldDepthMeters / 2 - origin.z;
      const along = x * ux + z * uz;
      const across = x * vx + z * vz;
      const outside = Math.hypot(Math.max(0, -along, along - width), Math.max(0, -across, across - depth));
      if (outside >= 16) continue;
      const fade = Math.max(0, (outside - 4) / 12);
      const smooth = fade * fade * (3 - 2 * fade);
      const index = row * world.terrainColumns + column;
      weights[index] = Math.min(weights[index], smooth);
    }
  }
}
