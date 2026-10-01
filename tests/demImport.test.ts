import xml from './fixtures/dem/gsi-jgd2024.xml?raw';
import osakaTile from './fixtures/dem/osaka-gsi-png.json';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { encode } from 'fast-png';
import proj4 from 'proj4';
import { IDBFactory } from 'fake-indexeddb';
import { bilinear, importRegion, importDem, mapAssetFromDem } from '../src/dem/importer';
import { decodeGsiPng, decodeGsiText, gsiTilePlan, gsiTileProvider, rasterFromGsiTiles, gsiSource } from '../src/dem/gsiTiles';
import { decodeGsiGml, gsiGmlProvider, mosaicGsiGml } from '../src/dem/gsiGml';
import type { DemRaster, DemRequest } from '../src/dem/types';
import { SimulationState } from '../src/simulation/state';
import { readMapAsset, saveMapAsset } from '../src/maps/mapStore';
import { Hydrography, withShoreline } from '../src/water/geometry';
import { validateMapAsset } from '../src/maps/mapAsset';

const request: DemRequest = { latitude: 34.69, longitude: 135.5, dimensions: { worldWidthMeters: 64, worldDepthMeters: 128, terrainSampleSpacingMeters: 4 },
  identity: { id: 'dem-fixture', name: 'DEM Test', description: '', author: 'Test' } };
function rasterFor(req = request): DemRaster {
  const { crs, world } = importRegion(req), s = 4, columns = world.worldWidthMeters / s + 1, rows = world.worldDepthMeters / s + 1;
  const samples = new Float32Array(columns * rows);
  for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) samples[y * columns + x] = 1200 + x * s * .01 + y * s * .02;
  return { columns, rows, samples, crs, affine: [-world.worldWidthMeters / 2, s, 0, world.worldDepthMeters / 2, 0, -s],
    source: gsiSource('synthetic offline DEM', 4, crs, 'JGD2024', 'fixture orthometric metres') };
}
function pngTile() {
  const data = new Uint8Array(65536 * 3);
  for (let i = 0; i < 65536; i++) {
    const code = i === 2 ? 8388608 : i === 1 ? 16777216 - 1234 : 12345;
    data[i * 3] = code >> 16; data[i * 3 + 1] = code >> 8; data[i * 3 + 2] = code;
  }
  return encode({ width: 256, height: 256, data, channels: 3, depth: 8 });
}
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
describe('DEM elevation import', () => {
  it('imports the captured Osaka GSI PNG fixture offline into a geographic metric Map Asset', () => {
    const bytes = Uint8Array.from(atob(osakaTile.pngBase64), c => c.charCodeAt(0));
    const raster = rasterFromGsiTiles([{ x: osakaTile.x, y: osakaTile.y, samples: decodeGsiPng(bytes) }], osakaTile.zoom,
      gsiSource('DEM10B', 10, 'EPSG:3857', 'JGD2024', 'GSI orthometric metres / 測地成果2024'));
    const [longitude, latitude] = proj4(raster.crs, 'EPSG:4326', [raster.affine[0] + 128 * raster.affine[1], raster.affine[3] + 128 * raster.affine[5]]);
    const req = { ...request, latitude, longitude, dimensions: { worldWidthMeters: 64, worldDepthMeters: 64, terrainSampleSpacingMeters: 4 } };
    const asset = mapAssetFromDem(raster, req);
    expect(asset.terrain.heightmap.every(Number.isFinite)).toBe(true);
    expect(asset.terrain.heightmap[8 * 17 + 8]).toBeCloseTo(raster.samples[128 * 256 + 128], 4);
    expect(asset.world.waterBodies).toEqual([]); expect(mapAssetFromDem(raster, req)).toEqual(asset);
  });
  it('decodes official signed RGB centimetres and NoData without image colour conversion', () => {
    const decoded = decodeGsiPng(pngTile());
    expect(decoded[0]).toBeCloseTo(123.45, 4); expect(decoded[1]).toBeCloseTo(-12.34, 4); expect(decoded[2]).toBeNaN();
    expect(() => decodeGsiPng(encode({ width: 4096, height: 1, channels: 3, data: new Uint8Array(4096 * 3) }))).toThrow(/256/);
    const bad = pngTile(); bad[40] ^= 255; expect(() => decodeGsiPng(bad)).toThrow();
    const txt = Array.from({ length: 256 }, () => Array.from({ length: 256 }, (_, x) => x === 0 ? 'e' : '-2.5').join(',')).join('\n');
    expect(decodeGsiText(txt)[0]).toBeNaN(); expect(decodeGsiText(txt)[1]).toBe(-2.5);
    expect(() => decodeGsiText('0,NaN')).toThrow();
  });
  it('decodes current/legacy GML axis order, cell centres, omitted leading/trailing tuples and metre elevations', () => {
    for (const year of ['2024', '2011', '2000']) {
      const raster = decodeGsiGml(xml.replaceAll('2024', year), 'FG-GML-523504-DEM10B.xml');
      expect(raster.columns).toBe(4); expect(raster.rows).toBe(3); expect(raster.source.horizontalDatum).toBe(`JGD${year}`);
      expect(raster.affine[0]).toBe(135.125); expect(raster.affine[3]).toBeCloseTo(34 + 5 / 6);
      expect(raster.samples[0]).toBeNaN(); expect(raster.samples[1]).toBe(100); expect(raster.samples[3]).toBeNaN();
      expect(raster.samples[5]).toBe(-2.5); expect(raster.samples[6]).toBe(1200); expect(raster.samples[11]).toBeNaN();
    }
    for (const invalid of [xml.replace('jgd2024', 'unknown'), xml.replace('1 0</gml:startPoint>', '4 0</gml:startPoint>'), xml.replace('+x-y', '-x+y'),
      xml.replace('地表面,100', '地表面,Infinity'), '<!DOCTYPE x><x/>', xml.slice(0, -50)]) expect(() => decodeGsiGml(invalid)).toThrow();
  });
  it('mosaics adjoining GML and tiles across seams, retains missing pixels, rejects mixed datums/overlaps', () => {
    const a = decodeGsiGml(xml), b = structuredClone(a); b.affine[0] += 1; b.source.files = ['east.xml'];
    const mosaic = mosaicGsiGml([a, b]); expect(mosaic.columns).toBe(8); expect(mosaic.samples[5]).toBe(100); expect(mosaic.source.files).toHaveLength(2);
    b.source.sourceCrs = 'fguuid:jgd2011.bl'; expect(() => mosaicGsiGml([a, b])).toThrow(/same dataset/);
    b.source.sourceCrs = a.source.sourceCrs; b.affine[0] = a.affine[0]; b.samples[1] = 999; expect(() => mosaicGsiGml([a, b])).toThrow(/Conflicting/);
    const tiles = rasterFromGsiTiles([{ x: 1, y: 1, samples: new Float32Array(65536).fill(10) }, { x: 2, y: 1, samples: new Float32Array(65536).fill(20) }], 4, a.source);
    expect(bilinear(tiles, 255.5, 100).height).toBe(15);
    expect(() => rasterFromGsiTiles([{ x: 1, y: 1, samples: new Float32Array(2) }], 4, a.source)).toThrow();
  });
  it('bilinearly interpolates slopes, handles zero-weight NoData and rejects uncovered/all-missing cells', () => {
    const raster = rasterFor(); raster.samples.set([0, 10], 0); raster.samples.set([20, 30], raster.columns);
    expect(bilinear(raster, .25, .75).height).toBe(17.5);
    raster.samples[1] = NaN;
    expect(bilinear(raster, 0, 0).height).toBe(0); expect(() => bilinear(raster, .5, .5)).toThrow(/NoData/);
    expect(bilinear(raster, .5, .5, 'renormalize')).toEqual({ height: 50 / 3, filled: true });
    expect(bilinear(raster, -.5, 0).height).toBe(0); expect(() => bilinear(raster, -.51, 0)).toThrow(/outside/);
    raster.samples.fill(NaN); expect(() => bilinear(raster, 0, 0, 'renormalize')).toThrow(/entirely missing/);
  });
  it('uses local metric coordinates, X east/Z south, variable rectangular grids and preserves real heights above 240m', () => {
    for (const spacing of [4, 8, 16]) {
      const req = { ...request, dimensions: { ...request.dimensions, terrainSampleSpacingMeters: spacing } };
      const asset = mapAssetFromDem(rasterFor(req), req), s = asset.world.terrainSampleSpacingMeters;
      expect(asset.world.terrainColumns).toBe(64 / s + 1); expect(asset.world.terrainRows).toBe(128 / s + 1);
      expect(asset.terrain.heightmap[0]).toBeCloseTo(1200, 4); expect(asset.terrain.heightmap.at(-1)).toBeCloseTo(1203.2, 3);
      expect(asset.world.georeference?.affineTransform).toEqual([-32, s, 0, 64, 0, -s]);
      const origin = proj4(asset.world.georeference!.crs, '+proj=longlat +ellps=GRS80 +no_defs', [0, 0]);
      expect(origin[0]).toBeCloseTo(request.longitude, 8); expect(origin[1]).toBeCloseTo(request.latitude, 8);
      const east = proj4(asset.world.georeference!.crs, 'EPSG:4326', [1000, 0]), north = proj4(asset.world.georeference!.crs, 'EPSG:4326', [0, 1000]);
      expect(east[0]).toBeGreaterThan(origin[0]); expect(north[1]).toBeGreaterThan(origin[1]);
      // Independent small-distance metres check: longitude scale at Osaka is ~91.6 km/degree; north ~110.94 km/degree.
      expect((east[0] - origin[0]) * 91600).toBeCloseTo(1000, -1); expect((north[1] - origin[1]) * 110940).toBeCloseTo(1000, -1);
      expect(mapAssetFromDem(rasterFor(req), req)).toEqual(asset);
    }
  });
  it('rejects invalid source/grid/CRS and unsafe map requests before provider IO', async () => {
    const raster = rasterFor(); raster.samples[0] = Infinity; expect(() => mapAssetFromDem(raster, request)).toThrow(/Invalid DEM/);
    raster.samples[0] = 1200; raster.crs = 'UNKNOWN:123'; expect(() => mapAssetFromDem(raster, request)).toThrow();
    const load = vi.fn(); await expect(importDem({ load }, { ...request, latitude: NaN })).rejects.toThrow(/latitude/); expect(load).not.toHaveBeenCalled();
    expect(() => importRegion({ ...request, longitude: 181 })).toThrow();
    expect(() => importRegion({ ...request, longitude: 179.9999 })).toThrow(/boundary/);
    expect(() => importRegion({ ...request, dimensions: { worldWidthMeters: 16384, worldDepthMeters: 16384, terrainSampleSpacingMeters: 4 } })).toThrow(/dimensions/);
    expect(() => importRegion({ ...request, dimensions: { ...request.dimensions, terrainColumns: 257 } })).toThrow(/Output grid/);
    expect(() => decodeGsiGml(xml, 'file.xml', 2)).toThrow(/grid/);
  });
  it('bounds tile IO, uses current PNG endpoints/zoom and distinguishes survey resolution from raster/output', async () => {
    const plan = gsiTilePlan(request, 'DEM10B'); expect(plan.zoom).toBe(14); expect(plan.coordinates.every(t => t.url.includes('/dem_png/') && t.url.endsWith('.png'))).toBe(true);
    const large = gsiTilePlan({ ...request, dimensions: { worldWidthMeters: 32768, worldDepthMeters: 32768, terrainSampleSpacingMeters: 32 } }, 'DEM1A');
    expect(large.zoom).toBeLessThan(17); expect(large.coordinates.length).toBeLessThanOrEqual(64);
    const provider = gsiTileProvider('DEM10B', (async () => new Response(pngTile() as BodyInit)) as typeof fetch);
    const source = await provider.load(request); expect(source.source.nominalResolutionMeters).toBe(10); expect(source.source.rasterSpacingMetersAtCenter).toBeGreaterThan(4);
    await expect(gsiTileProvider('DEM10B', (async () => new Response('', { status: 500 })) as typeof fetch).load(request)).rejects.toThrow(/500/);
    const missing = await gsiTileProvider('DEM5A', (async () => new Response('', { status: 404 })) as typeof fetch).load(request);
    expect(missing.samples.every(Number.isNaN)).toBe(true); expect(() => mapAssetFromDem(missing, request)).toThrow(/NoData/);
    const controller = new AbortController(); controller.abort(); await expect(provider.load(request, controller.signal)).rejects.toBeDefined();
  });
  it('persists source metadata/terrain through Editor, Map Asset and City Save with no external dependency or water inference', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('fetch', vi.fn(() => { throw new Error('offline'); }));
    const raster = rasterFor(); raster.samples.fill(-5);
    const asset = await importDem({ load: async () => raster }, request); expect(validateMapAsset(asset).valid).toBe(true);
    expect(new Hydrography(asset.world.waterBodies, asset.world).isWaterAt(0, 0)).toBe(false);
    const editor = new SimulationState(); editor.startMapAsset(asset, true);
    const lake = withShoreline({ id: 'explicit', type: 'lake', surfaceElevation: 20, geometry: { kind: 'polygon', vertices: [{ x: -10, z: -10 }, { x: 10, z: -10 }, { x: 10, z: 10 }, { x: -10, z: 10 }] } });
    editor.setWaterBodies([lake]); editor.terrain.applyBrush({ mode: 'raise', center: { x: 0, z: 0 }, size: 16, strength: 10, seconds: .5 }, new Map());
    const exported = editor.exportMapAsset(request.identity); expect(exported.world.waterBodies).toEqual([lake]);
    expect(exported.world.demImport).toEqual(asset.world.demImport); await saveMapAsset(exported);
    const stored = (await readMapAsset(asset.id))!; expect(stored).toEqual(exported);
    const city = new SimulationState(); city.startMapAsset(stored); const reloaded = new SimulationState(); reloaded.load(city.serialize());
    expect(reloaded.terrain.state()).toEqual(city.terrain.state()); expect(reloaded.worldMetadata.demImport).toEqual(asset.world.demImport);
    expect(reloaded.worldMetadata.georeference).toEqual(asset.world.georeference); expect(fetch).not.toHaveBeenCalled();
    const invalid = structuredClone(stored); invalid.world.demImport!.termsUrl = 'javascript:alert(1)'; expect(validateMapAsset(invalid).valid).toBe(false);
  });
  it('connects offline GML through the creation Worker and returns the existing Map Asset contract', async () => {
    const messages: { type: string; asset?: ReturnType<typeof mapAssetFromDem>; message?: string }[] = [];
    const scope = { onmessage: null as ((event: { data: unknown }) => Promise<void>) | null, postMessage: (data: typeof messages[number]) => messages.push(data) };
    vi.stubGlobal('self', scope); vi.stubGlobal('fetch', vi.fn(() => { throw new Error('offline'); }));
    await import('../src/dem/import.worker');
    const input = { ...request, latitude: 34.5, noDataPolicy: 'renormalize' as const };
    await scope.onmessage!({ data: { request: input, dataset: 'DEM10B', files: [{ name: 'FG-DEM10B.xml', xml }] } });
    expect(messages.at(-1)?.type).toBe('complete'); expect(messages.at(-1)?.asset?.world.source.kind).toBe('dem'); expect(fetch).not.toHaveBeenCalled();
    const fileProvider = gsiGmlProvider([{ name: 'FG-DEM10B.xml', xml }]); expect((await fileProvider.load(input)).source.dataset).toBe('DEM10B');
  });
});
