import proj4 from 'proj4';
import { GEOGRAPHIC_GRS80, importRegion } from './region';
import { safeTerrainSpacing } from '../world/worldSizing';

export interface DemArea {
  latitude: number;
  longitude: number;
  width: number;
  depth: number;
  spacing: number;
}
export interface GeographicPoint { lat: number; lng: number }

export function areaRegion(area: DemArea) {
  return importRegion({ latitude: area.latitude, longitude: area.longitude,
    dimensions: { worldWidthMeters: area.width, worldDepthMeters: area.depth, terrainSampleSpacingMeters: area.spacing },
    identity: { id: 'selection', name: 'Selection', description: '', author: '' } });
}

/** Geographic corner clicks become local metric dimensions, never Web Mercator metres. */
export function areaFromCorners(a: GeographicPoint, b: GeographicPoint, preferredSpacing = 4): DemArea {
  if (![a.lat, a.lng, b.lat, b.lng].every(Number.isFinite)
    || Math.max(Math.abs(a.lat), Math.abs(b.lat)) > 80 || Math.max(Math.abs(a.lng), Math.abs(b.lng)) > 180
    || Math.abs(a.lng - b.lng) > 1) throw new Error('Choose a local area away from the antimeridian, between latitudes -80 and 80.');
  const latitude = (a.lat + b.lat) / 2, longitude = (a.lng + b.lng) / 2;
  const { crs } = areaRegion({ latitude, longitude, width: 64, depth: 64, spacing: 4 });
  const transform = proj4(GEOGRAPHIC_GRS80, crs);
  const p = transform.forward([a.lng, a.lat]), q = transform.forward([b.lng, b.lat]);
  const width = Math.max(64, Math.round(Math.abs(p[0] - q[0]) / 64) * 64);
  const depth = Math.max(64, Math.round(Math.abs(p[1] - q[1]) / 64) * 64);
  if (width > 32768 || depth > 32768) throw new Error('Select a smaller area: width and depth must be at most 32,768 m.');
  const area = { latitude, longitude, width, depth, spacing: safeTerrainSpacing(width, depth, preferredSpacing) };
  areaRegion(area); // Validate the adjusted footprint before changing any UI state.
  return area;
}
