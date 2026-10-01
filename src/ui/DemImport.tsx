import { useEffect, useRef, useState } from 'preact/hooks';
import type { MapAsset } from '../maps/mapAsset';
import { GSI_DATASETS, type GsiDataset } from '../dem/gsiCatalog';
import type { DemImportMessage } from '../dem/import.worker';
import { safeTerrainSpacing, safeTerrainSpacings, WORLD_SIZE_OPTIONS } from '../world/worldSizing';
import { DemAttribution } from './DemAttribution';

const PLACES = [
  { name: 'Osaka Plain', latitude: 34.69, longitude: 135.50 },
  { name: 'Kobe / Rokko foothills', latitude: 34.74, longitude: 135.23 },
  { name: 'Kyoto Basin', latitude: 35, longitude: 135.75 },
];
function ElevationPreview({ asset }: { asset: MapAsset }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const context = canvas.current?.getContext('2d'); if (!context) return;
    const { terrainColumns: columns, terrainRows: rows } = asset.world, values = asset.terrain.heightmap;
    let min = Infinity, max = -Infinity; for (const v of values) { min = Math.min(min, v); max = Math.max(max, v); }
    const image = context.createImageData(512, 512);
    for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) {
      const h = values[Math.round(y * (rows - 1) / 511) * columns + Math.round(x * (columns - 1) / 511)];
      const t = (h - min) / Math.max(1, max - min);
      image.data.set([75 + t * 135, 104 + t * 104, 68 + t * 136, 255], (y * 512 + x) * 4);
    }
    context.putImageData(image, 0, 0);
  }, [asset]);
  return <div class="new-game-map" style={{ aspectRatio: `${asset.world.worldWidthMeters} / ${asset.world.worldDepthMeters}` }}><canvas ref={canvas} width="512" height="512" aria-label="DEM elevation preview: north at top, east at right; no water inferred" /></div>;
}
export function DemImport({ onEdit }: { onEdit: (asset: MapAsset) => void }) {
  const [latitude, setLatitude] = useState(34.69), [longitude, setLongitude] = useState(135.50);
  const [width, setWidth] = useState(1024), [depth, setDepth] = useState(1024), [spacing, setSpacing] = useState(4);
  const [dataset, setDataset] = useState<GsiDataset>('DEM10B'), [source, setSource] = useState('online');
  const [files, setFiles] = useState<File[]>([]), [partial, setPartial] = useState(false);
  const [asset, setAsset] = useState<MapAsset>(), [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
  const worker = useRef<Worker>(), generation = useRef(0);
  useEffect(() => { setAsset(undefined); setMessage(''); setError(''); }, [latitude, longitude, width, depth, spacing, dataset, source, files, partial]);
  useEffect(() => () => { generation.current++; worker.current?.terminate(); }, []);
  const cancel = () => { generation.current++; worker.current?.terminate(); worker.current = undefined; setBusy(false); setMessage('Import cancelled.'); };
  const resize = (w: number, d: number) => { setWidth(w); setDepth(d); setSpacing(safeTerrainSpacing(w, d, spacing)); };
  const start = async () => {
    const id = ++generation.current; setAsset(undefined); setBusy(true); setError(''); setMessage('Preparing DEM import…');
    try {
      if (source === 'file' && (!files.length || files.length > 256 || files.some(f => f.size > 32 * 1024 * 1024) || files.reduce((n, f) => n + f.size, 0) > 64 * 1024 * 1024))
        throw new Error('Select unzipped GML/XML files: up to 32 MiB per file, 64 MiB total.');
      const input: DemImportMessage = { dataset, request: { latitude, longitude, dimensions: { worldWidthMeters: width, worldDepthMeters: depth, terrainSampleSpacingMeters: spacing },
        noDataPolicy: partial ? 'renormalize' : 'reject', identity: { id: crypto.randomUUID(), name: 'Imported DEM Map', description: '', author: 'Local creator' } },
        files: source === 'file' ? await Promise.all(files.map(async f => ({ name: f.name, xml: await f.text() }))) : undefined };
      if (id !== generation.current) return;
      const importer = new Worker(new URL('../dem/import.worker.ts', import.meta.url), { type: 'module' }); worker.current = importer;
      const finish = () => { importer.terminate(); worker.current = undefined; setBusy(false); };
      importer.onmessage = ({ data }) => {
        if (id !== generation.current) return;
        if (data.type === 'progress') setMessage(data.message);
        else if (data.type === 'complete') { setAsset(data.asset); setMessage('Terrain imported. Review the elevation, then open the Map Editor.'); finish(); }
        else if (data.type === 'error') { setError(data.message); setMessage(''); finish(); }
      };
      importer.onerror = () => { if (id === generation.current) { setError('DEM import worker failed. Try a smaller region or local files.'); setMessage(''); finish(); } };
      importer.postMessage(input);
    } catch (cause) { if (id === generation.current) { setError(cause instanceof Error ? cause.message : String(cause)); setMessage(''); setBusy(false); } }
  };
  let min = Infinity, max = -Infinity; if (asset) for (const height of asset.terrain.heightmap) { min = Math.min(min, height); max = Math.max(max, height); }
  return <div class="new-game-layout">
    <section class="new-game-controls"><h1>Import real terrain.</h1><p>Elevation only. Add Water Bodies and review Outside Connections in the Map Editor.</p>
      <fieldset disabled={busy} class="dem-controls">
        <label>SOURCE<select aria-label="DEM source" value={source} onChange={e => setSource(e.currentTarget.value)}><option value="online">GSI PNG elevation tiles</option><option value="file">Local GSI GML / XML files</option></select></label>
        <label>EXAMPLE LOCATION<select aria-label="DEM example location" onChange={e => { const place = PLACES[Number(e.currentTarget.value)]; setLatitude(place.latitude); setLongitude(place.longitude); }}>
          {PLACES.map((place, i) => <option value={i}>{place.name}</option>)}</select></label>
        <label>LATITUDE<input aria-label="DEM latitude" type="number" step="0.00001" min="-80" max="80" value={latitude} onInput={e => setLatitude(Number(e.currentTarget.value))} /></label>
        <label>LONGITUDE<input aria-label="DEM longitude" type="number" step="0.00001" min="-180" max="180" value={longitude} onInput={e => setLongitude(Number(e.currentTarget.value))} /></label>
        <div class="new-game-dimensions"><label>WIDTH (m)<select aria-label="DEM width" value={width} onChange={e => resize(Number(e.currentTarget.value), depth)}>{WORLD_SIZE_OPTIONS.map(size => <option value={size}>{size}</option>)}</select></label>
          <label>DEPTH (m)<select aria-label="DEM depth" value={depth} onChange={e => resize(width, Number(e.currentTarget.value))}>{WORLD_SIZE_OPTIONS.map(size => <option value={size}>{size}</option>)}</select></label>
          <label>SAMPLE (m)<select aria-label="DEM sample spacing" value={spacing} onChange={e => setSpacing(Number(e.currentTarget.value))}>{safeTerrainSpacings(width, depth).map(size => <option value={size}>{size}</option>)}</select></label></div>
        {source === 'online' ? <><label>DATASET<select aria-label="DEM dataset" value={dataset} onChange={e => setDataset(e.currentTarget.value as GsiDataset)}>{Object.keys(GSI_DATASETS).map(key => <option value={key}>{key}</option>)}</select></label>
          <p>DEM10B has nationwide coverage. Finer datasets have limited coverage. Tile resolution and output spacing are recorded separately; finer output does not create new survey detail.</p></> : <><label>UNZIPPED DEM FILES<input aria-label="DEM local files" type="file" accept=".xml,.gml" multiple onChange={e => setFiles(Array.from(e.currentTarget.files ?? []))} /></label>
          <p>Download from GSI and unzip first. Adjacent files must share dataset, datum and resolution. The imported terrain can be used entirely offline.</p></>}
        <label><input aria-label="Interpolate partial NoData cells" type="checkbox" checked={partial} onChange={e => setPartial(e.currentTarget.checked)} /> INTERPOLATE PARTIAL NODATA CELLS</label>
        <p>Missing corners may be interpolated from valid neighbours. Entirely missing cells are rejected; no elevation or water is invented for them.</p>
        <button class="new-game-generate" onClick={() => void start()}>IMPORT & PREVIEW</button>
      </fieldset>{busy && <button onClick={cancel}>CANCEL IMPORT</button>}
    </section>
    <section class="new-game-preview" aria-label="DEM preview">
      {asset ? <><ElevationPreview asset={asset} /><p>{asset.world.terrainColumns} × {asset.world.terrainRows} samples · {min.toFixed(2)}–{max.toFixed(2)} m elevation · X east, Z south</p><DemAttribution world={asset.world} /></> : <div class="new-game-placeholder"><strong>REAL-WORLD ELEVATION</strong><p>Select a region or local files to preview its terrain.</p></div>}
      {message && <p role="status">{message}</p>}{error && <p class="new-game-error" role="alert">{error}</p>}
      <button disabled={!asset || busy} class="new-game-start" onClick={() => asset && onEdit(asset)}>OPEN MAP EDITOR →</button>
    </section>
  </div>;
}
