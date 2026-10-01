import { build } from 'vite';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

await build({ configFile: false, logLevel: 'error', build: { ssr: 'src/dem/index.ts', outDir: '.dem-validation-run', minify: false } });
const { importDem, gsiTileProvider, gsiTilePlan, mapAssetFromDem } = await import(pathToFileURL(resolve('.dem-validation-run/index.js')).href);
await mkdir('.dem-validation-cache', { recursive: true });
const files = new Map();
const cachedFetch = async (url, options) => {
  const name = url.split('/').slice(-4).join('-'), path = resolve('.dem-validation-cache', name);
  let bytes;
  try { bytes = await readFile(path); }
  catch {
    if (process.argv.includes('--offline')) throw new Error(`Missing offline tile ${name}`);
    const response = await fetch(url, options); if (!response.ok) throw new Error(`GSI ${response.status}: ${url}`);
    bytes = Buffer.from(await response.arrayBuffer()); await writeFile(path, bytes);
  }
  files.set(url, { url, filename: name, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
  return new Response(bytes);
};
const places = [
  { name: 'Osaka Plain', latitude: 34.69, longitude: 135.50, width: 1024, depth: 1024, spacing: 4 },
  { name: 'Kobe / Rokko foothills', latitude: 34.74, longitude: 135.23, width: 4096, depth: 4096, spacing: 8 },
  { name: 'Kyoto Basin', latitude: 35, longitude: 135.75, width: 4096, depth: 4096, spacing: 16 },
];
const scenarios = [];
for (const place of places) {
  const request = { latitude: place.latitude, longitude: place.longitude,
    dimensions: { worldWidthMeters: place.width, worldDepthMeters: place.depth, terrainSampleSpacingMeters: place.spacing },
    identity: { id: `dem-validation-${scenarios.length}`, name: place.name, description: 'GSI DEM10B validation', author: 'Project Civitas' } };
  const provider = gsiTileProvider('DEM10B', cachedFetch), start = performance.now();
  const asset = await importDem(provider, request), elapsed = performance.now() - start;
  let min = Infinity, max = -Infinity; for (const v of asset.terrain.heightmap) { if (!Number.isFinite(v)) throw new Error('Non-finite DEM output'); min = Math.min(min, v); max = Math.max(max, v); }
  // Retained source raster can reconstruct the exact same Map Asset without a network provider.
  const raster = await provider.load(request), offline = mapAssetFromDem(raster, request);
  if (JSON.stringify(offline) !== JSON.stringify(asset)) throw new Error('Offline DEM import was not deterministic');
  const roundtrip = JSON.parse(JSON.stringify(asset));
  if (JSON.stringify(roundtrip) !== JSON.stringify(asset) || asset.world.waterBodies.length) throw new Error('Asset roundtrip/water authority mismatch');
  scenarios.push({ ...place, dataset: 'DEM10B', zoom: asset.world.demImport.tileZoom, columns: asset.world.terrainColumns, rows: asset.world.terrainRows,
    sourceNominalResolutionMeters: 10, rasterSpacingMetersAtCenter: asset.world.demImport.rasterSpacingMetersAtCenter,
    outputRangeMeters: { min, max }, noDataOutput: 0, waterBodies: asset.world.waterBodies.length,
    bounds: asset.world.demImport.geographicBounds, outsideConnections: asset.world.outsideConnections.length,
    importMillisecondsIncludingFetch: Number(elapsed.toFixed(2)), terrainBytesFloat32: asset.terrain.heightmap.length * 4,
    assetJsonBytes: Buffer.byteLength(JSON.stringify(asset)), deterministicOffline: true, metadataRoundtrip: true,
    tileCount: gsiTilePlan(request, 'DEM10B').coordinates.length });
}
await mkdir('benchmarks', { recursive: true });
await writeFile(process.argv.includes('--offline') ? 'benchmarks/dem-import-offline.json' : 'benchmarks/dem-import.json', JSON.stringify({ capturedAt: new Date().toISOString(), runtime: process.version, sourceMode: process.argv.includes('--offline') ? 'cached offline files' : 'current GSI PNG (cached on disk after acquisition)',
  terms: 'https://www.gsi.go.jp/kikakuchousei/kikakuchousei40182.html', attribution: 'GSI DEM processed by Project Civitas: projection and bilinear resampling.', scenarios, tiles: [...files.values()] }, null, 2) + '\n');
console.table(scenarios.map(({ name, width, spacing, columns, rows, outputRangeMeters, tileCount, importMillisecondsIncludingFetch }) => ({ name, width, spacing, columns, rows, min: outputRangeMeters.min, max: outputRangeMeters.max, tileCount, milliseconds: importMillisecondsIncludingFetch })));
