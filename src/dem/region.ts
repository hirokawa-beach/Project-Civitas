import proj4 from 'proj4';
import { createWorldMetadata } from '../world/metadata';
import type { DemRequest } from './types';

export const GEOGRAPHIC_GRS80 = '+proj=longlat +ellps=GRS80 +no_defs';
export function importRegion(request: DemRequest) {
  const { latitude: lat, longitude: lon } = request;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 80 || Math.abs(lon) > 180)
    throw new Error('Enter a finite latitude between -80 and 80 and longitude between -180 and 180.');
  if (request.noDataPolicy && !['reject', 'renormalize'].includes(request.noDataPolicy)) throw new Error('Invalid NoData policy.');
  const world = createWorldMetadata(request.dimensions);
  for (const key of ['terrainColumns', 'terrainRows'] as const) {
    if (request.dimensions[key] !== undefined && request.dimensions[key] !== world[key]) throw new Error('Output grid dimensions disagree with width/depth/sample spacing.');
  }
  // Local transverse Mercator, k=1 at the centre. Projected metres, not Web Mercator metres.
  const crs = `+proj=tmerc +lat_0=${lat} +lon_0=${lon} +k=1 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs`;
  const geographic = proj4(crs, GEOGRAPHIC_GRS80);
  const outline: [number, number][] = [];
  let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
  const w = world.worldWidthMeters / 2, d = world.worldDepthMeters / 2;
  // Walk the perimeter in order. The map and acquisition use the same projected footprint.
  for (const [a, b] of [[[-w, d], [w, d]], [[w, d], [w, -d]], [[w, -d], [-w, -d]], [[-w, -d], [-w, d]]]) {
    for (let i = 0; i <= 16; i++) {
      const p = [a[0] + (b[0] - a[0]) * i / 16, a[1] + (b[1] - a[1]) * i / 16];
      const [lng, latitude] = geographic.forward(p);
      if (![lng, latitude].every(Number.isFinite) || Math.abs(lng - lon) > 1 || Math.abs(latitude) > 85)
        throw new Error('This region crosses an unsupported projection/antimeridian boundary.');
      west = Math.min(west, lng); east = Math.max(east, lng); south = Math.min(south, latitude); north = Math.max(north, latitude);
      outline.push([latitude, lng]);
    }
  }
  return { world, crs, bounds: { west, east, south, north }, outline };
}
