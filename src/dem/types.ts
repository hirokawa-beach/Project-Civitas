import type { MapIdentity } from '../maps/mapAsset';
import type { WorldDimensions } from '../world/metadata';

/** Raster pixel centres: X=a+b*column+c*row, Y=d+e*column+f*row. */
export type Affine = [number, number, number, number, number, number];
export interface DemSource {
  provider: string;
  dataset: string;
  sourceCrs: string;
  horizontalDatum: string;
  verticalDatum: string;
  nominalResolutionMeters: number;
  attribution: string;
  termsUrl: string;
  license: string;
  sourceUrl: string;
  files?: string[];
  tileZoom?: number;
  rasterSpacingMetersAtCenter?: number;
}
export interface DemRaster {
  columns: number;
  rows: number;
  /** NaN represents NoData; Infinity is invalid. Heights are unscaled metres. */
  samples: Float32Array;
  /** PROJ definition/EPSG identifier understood by proj4; XY axis order. */
  crs: string;
  affine: Affine;
  source: DemSource;
}
export interface DemRequest {
  latitude: number;
  longitude: number;
  dimensions: Partial<WorldDimensions>;
  identity: MapIdentity;
  noDataPolicy?: 'reject' | 'renormalize';
}
export interface DemProvenance extends DemSource {
  center: { latitude: number; longitude: number };
  geographicBounds: { west: number; east: number; south: number; north: number };
  resampling: 'bilinear';
  noDataPolicy: 'reject' | 'renormalize';
  interpolatedNoDataSamples: number;
  orientation: 'x-east-z-south';
}
/** Only map creation calls providers. Simulation consumes the resulting Map Asset. */
export interface DemProvider {
  load(request: DemRequest, signal?: AbortSignal, progress?: (message: string) => void): Promise<DemRaster>;
}
