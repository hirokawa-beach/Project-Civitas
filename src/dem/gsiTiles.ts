import { decode } from 'fast-png';
import proj4 from 'proj4';
import { GEOGRAPHIC_GRS80, importRegion } from './importer';
import type { DemProvider, DemRaster, DemRequest, DemSource } from './types';
import { GSI_DATASETS, type GsiDataset } from './gsiCatalog';
export { GSI_DATASETS, type GsiDataset } from './gsiCatalog';
export const GSI_TERMS = 'https://www.gsi.go.jp/kikakuchousei/kikakuchousei40182.html';
const CIRCUMFERENCE = 2 * Math.PI * 6378137;
export function gsiSource(dataset: string, resolution: number, sourceCrs: string, horizontalDatum: string, verticalDatum: string): DemSource {
  return { provider: 'Geospatial Information Authority of Japan', dataset, nominalResolutionMeters: resolution,
    sourceCrs, horizontalDatum, verticalDatum, attribution: '国土地理院の数値標高モデルを座標変換・再標本化して作成（Project Civitas）。',
    termsUrl: GSI_TERMS, license: 'PDL 1.0; GSI terms including applicable Survey Act requirements', sourceUrl: 'https://maps.gsi.go.jp/development/ichiran.html' };
}
/** Decode numeric RGB bytes, never a canvas/color-managed image. Check size before inflation. */
export function decodeGsiPng(bytes: Uint8Array): Float32Array {
  if (bytes.byteLength < 33 || bytes.byteLength > 2 * 1024 * 1024) throw new Error('Invalid GSI PNG size.');
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (header.getUint32(16) !== 256 || header.getUint32(20) !== 256 || bytes[24] !== 8 || ![2, 6].includes(bytes[25]))
    throw new Error('GSI elevation PNG must contain 256×256 8-bit RGB/RGBA pixels.');
  const png = decode(bytes, { checkCrc: true });
  const heights = new Float32Array(256 * 256);
  for (let i = 0; i < heights.length; i++) {
    const offset = i * png.channels;
    const value = png.data[offset] * 65536 + png.data[offset + 1] * 256 + png.data[offset + 2];
    heights[i] = value === 8388608 || (png.channels === 4 && png.data[offset + 3] === 0) ? NaN : (value > 8388608 ? value - 16777216 : value) * .01;
  }
  return heights;
}
/** Archived TXT input is supported offline only: GSI stopped updating TXT in October 2024. */
export function decodeGsiText(text: string): Float32Array {
  const rows = text.trim().split(/\r?\n/);
  if (rows.length !== 256) throw new Error('Invalid GSI TXT row count.');
  const result = new Float32Array(65536);
  rows.forEach((row, y) => {
    const values = row.split(','); if (values.length !== 256) throw new Error('Invalid GSI TXT column count.');
    values.forEach((value, x) => {
      const number = value === 'e' ? NaN : Number(value);
      if (value !== 'e' && (!value.trim() || !Number.isFinite(number))) throw new Error('Invalid GSI TXT elevation.');
      result[y * 256 + x] = number;
    });
  }); return result;
}
export interface GsiTile { x: number; y: number; samples: Float32Array }
/** Offline tile API. A single mosaic makes cross-tile bilinear interpolation continuous. */
export function rasterFromGsiTiles(tiles: GsiTile[], zoom: number, source: DemSource): DemRaster {
  if (!tiles.length || tiles.length > 256 || !Number.isInteger(zoom) || zoom < 1 || zoom > 17) throw new Error('Invalid GSI tile set.');
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  const ids = new Set<string>();
  for (const tile of tiles) {
    const id = `${tile.x}/${tile.y}`;
    if (![tile.x, tile.y].every(v => Number.isInteger(v) && v >= 0 && v < 2 ** zoom) || tile.samples.length !== 65536 || ids.has(id)) throw new Error('Invalid/duplicate GSI tile.');
    ids.add(id); left = Math.min(left, tile.x); right = Math.max(right, tile.x); top = Math.min(top, tile.y); bottom = Math.max(bottom, tile.y);
  }
  const columns = (right - left + 1) * 256, rows = (bottom - top + 1) * 256;
  if (columns * rows > 16777216) throw new Error('DEM source mosaic exceeds the import memory budget.');
  const samples = new Float32Array(columns * rows); samples.fill(NaN);
  for (const tile of tiles) for (let y = 0; y < 256; y++) samples.set(tile.samples.subarray(y * 256, (y + 1) * 256), ((tile.y - top) * 256 + y) * columns + (tile.x - left) * 256);
  const pixel = CIRCUMFERENCE / (2 ** zoom * 256);
  return { columns, rows, samples, crs: 'EPSG:3857', affine: [-CIRCUMFERENCE / 2 + (left * 256 + .5) * pixel, pixel, 0,
    CIRCUMFERENCE / 2 - (top * 256 + .5) * pixel, 0, -pixel], source: { ...source, tileZoom: zoom } };
}
export function gsiTilePlan(request: DemRequest, dataset: GsiDataset) {
  if (!Object.hasOwn(GSI_DATASETS, dataset)) throw new Error('Unsupported GSI dataset.');
  const { world, bounds } = importRegion(request), spec = GSI_DATASETS[dataset];
  const zoom = Math.max(1, Math.min(spec.maxZoom, Math.ceil(Math.log2(CIRCUMFERENCE * Math.cos(request.latitude * Math.PI / 180) / (256 * world.terrainSampleSpacingMeters)))));
  const projection = proj4(GEOGRAPHIC_GRS80, 'EPSG:3857'), pixel = CIRCUMFERENCE / (2 ** zoom * 256);
  const [minX, maxY] = projection.forward([bounds.west, bounds.north]), [maxX, minY] = projection.forward([bounds.east, bounds.south]);
  const left = Math.floor(((minX + CIRCUMFERENCE / 2) / pixel - 1) / 256), right = Math.floor(((maxX + CIRCUMFERENCE / 2) / pixel + 1) / 256);
  const top = Math.floor(((CIRCUMFERENCE / 2 - maxY) / pixel - 1) / 256), bottom = Math.floor(((CIRCUMFERENCE / 2 - minY) / pixel + 1) / 256);
  if (left < 0 || top < 0 || right >= 2 ** zoom || bottom >= 2 ** zoom || (right - left + 1) * (bottom - top + 1) > 64)
    throw new Error('Selected DEM source needs too many tiles. Use a coarser terrain spacing.');
  const coordinates = [];
  for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) coordinates.push({ x, y, url: `https://cyberjapandata.gsi.go.jp/xyz/${spec.path}/${zoom}/${x}/${y}.png` });
  return { zoom, coordinates, rasterSpacingMetersAtCenter: pixel * Math.cos(request.latitude * Math.PI / 180) };
}
export function gsiTileProvider(dataset: GsiDataset, fetcher: typeof fetch = fetch): DemProvider {
  return { async load(request, signal, progress) {
    const plan = gsiTilePlan(request, dataset), tiles: GsiTile[] = new Array(plan.coordinates.length);
    let next = 0, done = 0;
    await Promise.all(Array.from({ length: Math.min(4, tiles.length) }, async () => {
      for (;;) {
        signal?.throwIfAborted(); const i = next++; if (i >= tiles.length) break;
        const coordinate = plan.coordinates[i];
        const timeout = AbortSignal.timeout(30000), requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
        let response: Response;
        try { response = await fetcher(coordinate.url, { signal: requestSignal }); }
        catch { requestSignal.throwIfAborted(); throw new Error('Could not fetch GSI DEM tiles. Check connectivity and retry, or import downloaded GML files.'); }
        if (!response.ok && response.status !== 404) throw new Error(`GSI DEM request failed (${response.status}). Try again or use downloaded GML files.`);
        let samples: Float32Array;
        if (response.status === 404) { samples = new Float32Array(65536); samples.fill(NaN); }
        else {
          const length = Number(response.headers.get('content-length'));
          if (length > 2 * 1024 * 1024) throw new Error('GSI PNG exceeds the file budget.');
          samples = decodeGsiPng(new Uint8Array(await response.arrayBuffer()));
        }
        tiles[i] = { x: coordinate.x, y: coordinate.y, samples };
        progress?.(`Loading ${dataset}: ${++done}/${tiles.length} tiles`);
      }
    }));
    const source = gsiSource(dataset, GSI_DATASETS[dataset].resolution, 'EPSG:3857 (GSI XYZ)', 'JGD2024 geographic values in Web Mercator tiles', 'GSI published orthometric elevation; 測地成果2024 (PNG update 2026-03-31); local island reference levels may differ');
    source.rasterSpacingMetersAtCenter = plan.rasterSpacingMetersAtCenter;
    return rasterFromGsiTiles(tiles, plan.zoom, source);
  } };
}
