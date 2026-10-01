import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { GEOGRAPHIC_GRS80, validateRaster } from './importer';
import { gsiSource } from './gsiTiles';
import type { DemProvider, DemRaster } from './types';

type Node = Record<string, unknown>;
function nodes(value: unknown, name: string): Node[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(v => nodes(v, name));
  const result: Node[] = [];
  for (const [key, child] of Object.entries(value)) {
    if (key === name) result.push(...(Array.isArray(child) ? child : [child]).filter(v => v && typeof v === 'object') as Node[]);
    else result.push(...nodes(child, name));
  }
  return result;
}
function one(value: unknown, name: string): Node {
  const found = nodes(value, name); if (found.length !== 1) throw new Error(`GSI GML requires one ${name} per DEM file.`); return found[0];
}
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : value && typeof value === 'object' ? text((value as Node)['#text']) : '';
function pair(value: unknown): [number, number] {
  const s = text(value), parts = s.split(/\s+/).map(Number);
  if (!s || parts.length !== 2 || !parts.every(Number.isFinite)) throw new Error('Invalid GSI GML coordinate.');
  return [parts[0], parts[1]];
}
/** Unzipped UTF-8 JPGIS/GML, current schema 5.1/file spec 5.3 and legacy geographic JGD files. */
export function decodeGsiGml(xml: string, filename = 'local-dem.xml', sampleBudget = 16777216): DemRaster {
  if (xml.length > 32 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true)
    throw new Error('Invalid GML XML, entities/DOCTYPE, or file larger than 32 MiB.');
  const document = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false, processEntities: false }).parse(xml);
  const dem = one(document, 'DEM'), envelope = one(dem, 'Envelope'), grid = one(dem, 'Grid'), extent = one(grid, 'GridEnvelope');
  const sourceCrs = text(envelope['@_srsName']);
  const datum = /^fguuid:jgd(2000|2011|2024)\.bl$/i.exec(sourceCrs)?.[1];
  if (!datum) throw new Error(`Unsupported GSI GML CRS: ${sourceCrs || '(missing)'}. Expected fguuid:jgd2000/2011/2024.bl (latitude, longitude).`);
  const [south, west] = pair(envelope.lowerCorner), [north, east] = pair(envelope.upperCorner);
  const low = pair(extent.low), high = pair(extent.high);
  const columns = high[0] - low[0] + 1, rows = high[1] - low[1] + 1;
  if (![...low, ...high].every(Number.isInteger) || low.some(v => v !== 0) || columns < 2 || rows < 2 || columns * rows > Math.min(16777216, sampleBudget)
    || south >= north || west >= east || south < -90 || north > 90 || west < -180 || east > 180) throw new Error('Invalid GSI GML extent/grid.');
  const fn = one(dem, 'GridFunction'), sequence = fn.sequenceRule;
  const order = sequence && typeof sequence === 'object' ? text((sequence as Node)['@_order']) : '';
  if (text(sequence) !== 'Linear' || order.replace(/\s+/g, '').replace(/[−–]/g, '-') !== '+x-y') throw new Error('Unsupported GML grid sequence: expected Linear +x-y.');
  const start = pair(fn.startPoint);
  if (!start.every(Number.isInteger) || start[0] < 0 || start[0] >= columns || start[1] < 0 || start[1] >= rows) throw new Error('Invalid GML startPoint.');
  const tuples = text(one(dem, 'DataBlock').tupleList);
  const values = tuples ? tuples.split(/\s+/) : [];
  const offset = start[1] * columns + start[0];
  if (offset + values.length > columns * rows) throw new Error('GML tuple list exceeds its grid.');
  const samples = new Float32Array(columns * rows); samples.fill(NaN);
  values.forEach((tuple, i) => {
    const parts = tuple.split(','), value = Number(parts[1]);
    if (parts.length !== 2 || !parts[0] || !parts[1]?.trim() || !Number.isFinite(value)) throw new Error('Invalid GML DEM tuple.');
    if (parts[0] !== 'データなし' && value !== -9999) samples[offset + i] = value;
  });
  const type = text(dem.type), resolution = Number(/^(1|5|10)m/.exec(type)?.[1]);
  if (!resolution) throw new Error('Unsupported/missing GML DEM type.');
  const dataset = /DEM(?:1A|5[ABC]|10[AB])/.exec(filename)?.[0] ?? type;
  const source = gsiSource(dataset, resolution, sourceCrs, `JGD${datum}`, `GSI published orthometric elevation / JGD${datum} label; retained as supplied (no vertical datum conversion; local island reference levels may differ)`);
  source.sourceUrl = 'https://service.gsi.go.jp/kiban/app/help/'; source.files = [filename];
  const dx = (east - west) / columns, dy = (north - south) / rows;
  const raster: DemRaster = { columns, rows, samples, crs: GEOGRAPHIC_GRS80, affine: [west + dx / 2, dx, 0, north - dy / 2, 0, -dy], source };
  validateRaster(raster); return raster;
}

/** Adjacent files share a source grid. Reject mixed datums/resolutions instead of losing their provenance. */
export function mosaicGsiGml(rasters: DemRaster[]): DemRaster {
  if (!rasters.length || rasters.length > 256) throw new Error('Select 1–256 unzipped GSI DEM files.');
  if (rasters.reduce((n, raster) => n + raster.samples.length, 0) > 16777216) throw new Error('GML input exceeds the source sample budget.');
  const first = rasters[0]; validateRaster(first);
  const positions: { raster: DemRaster; x: number; y: number }[] = []; let left = 0, top = 0, right = first.columns, bottom = first.rows;
  for (const raster of rasters) {
    validateRaster(raster);
    const x = (raster.affine[0] - first.affine[0]) / first.affine[1], y = (raster.affine[3] - first.affine[3]) / first.affine[5];
    if (raster.source.dataset !== first.source.dataset || raster.source.sourceCrs !== first.source.sourceCrs || raster.source.verticalDatum !== first.source.verticalDatum
      || Math.abs(raster.affine[1] / first.affine[1] - 1) > 1e-7 || Math.abs(raster.affine[5] / first.affine[5] - 1) > 1e-7
      || raster.affine[2] !== 0 || raster.affine[4] !== 0 || Math.abs(x - Math.round(x)) > 1e-5 || Math.abs(y - Math.round(y)) > 1e-5)
      throw new Error('GML files must use the same dataset, datum and aligned resolution. Import different datasets separately.');
    const col = Math.round(x), row = Math.round(y); positions.push({ raster, x: col, y: row });
    left = Math.min(left, col); top = Math.min(top, row); right = Math.max(right, col + raster.columns); bottom = Math.max(bottom, row + raster.rows);
  }
  const columns = right - left, rows = bottom - top;
  if (columns * rows > 16777216) throw new Error('GML mosaic exceeds the import memory budget. Select fewer files/coarser source data.');
  const samples = new Float32Array(columns * rows); samples.fill(NaN);
  for (const { raster, x, y } of positions) for (let row = 0; row < raster.rows; row++) for (let col = 0; col < raster.columns; col++) {
    const index = (row + y - top) * columns + col + x - left, v = raster.samples[row * raster.columns + col];
    if (Number.isFinite(samples[index]) && Number.isFinite(v) && samples[index] !== v) throw new Error('Conflicting overlapping GML elevations.');
    if (Number.isFinite(v)) samples[index] = v;
  }
  return { ...first, columns, rows, samples, affine: [first.affine[0] + left * first.affine[1], first.affine[1], 0, first.affine[3] + top * first.affine[5], 0, first.affine[5]],
    source: { ...first.source, files: rasters.flatMap(r => r.source.files ?? []) } };
}
export function gsiGmlProvider(files: { name: string; xml: string }[]): DemProvider {
  return { async load(_request, signal, progress) {
    signal?.throwIfAborted(); progress?.('Decoding local GSI GML files…');
    if (files.reduce((sum, f) => sum + f.xml.length, 0) > 64 * 1024 * 1024) throw new Error('GML files exceed the 64 MiB import budget.');
    const rasters: DemRaster[] = []; let remaining = 16777216;
    for (const file of files) {
      const raster = decodeGsiGml(file.xml, file.name, remaining); remaining -= raster.samples.length; rasters.push(raster);
    }
    return mosaicGsiGml(rasters);
  } };
}
