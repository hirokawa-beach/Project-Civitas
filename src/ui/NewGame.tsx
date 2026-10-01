import { Hydrography } from '../water/geometry';
import { MapLibrary } from './MapLibrary';
import { DemImport } from './DemImport';
import { blankMapAsset, mapAssetFromGenerated, type MapAsset } from '../maps/mapAsset';
import { useEffect, useRef, useState } from 'preact/hooks';
import { generateMap, MAP_PRESETS, presetParameters, type GeneratedMap, type GeneratorParameters, type MapPreset } from '../terrain/generator';
import { createWorldMetadata } from '../world/metadata';
import { safeTerrainSpacing, safeTerrainSpacings, WORLD_SIZE_OPTIONS } from '../world/worldSizing';
import { defaultLandOwnership, type LandOwnershipMode } from '../world/landOwnership';

const mapColor = (height: number, water: number, buildable: boolean): [number, number, number] => {
  if (height <= water) return [29, 91, 119];
  if (height < water + 4) return [194, 180, 132];
  if (height > 90) return [148, 148, 140];
  if (height > 50) return [109, 128, 105];
  return buildable ? [120, 161, 117] : [91, 136, 94];
};

function MapPreview({ map }: { map: GeneratedMap }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const context = canvas.current?.getContext('2d');
    if (!context) return;
    const world = map.world ?? createWorldMetadata();
    const side = 257; const image = context.createImageData(side, side);
    const heights = map.heights; const water = map.metadata.parameters.seaLevel;
    const hydro = world.waterMode === 'explicit' ? new Hydrography(world.waterBodies, world) : undefined;
    for (let z = 0; z < side; z++) for (let x = 0; x < side; x++) {
      const sx = Math.round(x * (world.terrainColumns - 1) / (side - 1)); const sz = Math.round(z * (world.terrainRows - 1) / (side - 1));
      const index = sz * world.terrainColumns + sx; const h = heights[index];
      const east = heights[sz * world.terrainColumns + Math.min(world.terrainColumns - 1, sx + 1)];
      const south = heights[Math.min(world.terrainRows - 1, sz + 1) * world.terrainColumns + sx];
      const buildable = h > water && Math.max(Math.abs(east - h), Math.abs(south - h)) < .48;
      const wet = hydro ? hydro.isWaterAt(sx * world.terrainSampleSpacingMeters - world.worldWidthMeters / 2, sz * world.terrainSampleSpacingMeters - world.worldDepthMeters / 2) : h <= water;
      const [r, g, b] = wet ? [29, 91, 119] : mapColor(h, Number.NEGATIVE_INFINITY, buildable);
      image.data.set([r, g, b, 255], (z * side + x) * 4);
    }
    context.putImageData(image, 0, 0);
  }, [map]);
  return <div class="new-game-map"><canvas ref={canvas} width={257} height={257} aria-label="Generated terrain preview: green buildable land, tan shore, blue water" />
    <div class="new-game-legend"><span><i class="land" /> BUILDABLE LAND</span><span><i class="water" /> WATER</span><span><i class="high" /> HIGHLANDS</span></div>
  </div>;
}

export function NewGame({ onStart, onLoad, onAssetStart, onEdit, initialTab = 'generator' }: { onStart: (map: GeneratedMap) => void; onLoad: () => Promise<void>; onAssetStart: (asset: MapAsset) => void; onEdit: (asset: MapAsset) => void; initialTab?: 'generator' | 'library' }) {
  const [tab, setTab] = useState<'generator' | 'library' | 'dem'>(initialTab);
  const identity = () => ({ id: crypto.randomUUID(), name: 'Untitled Map', description: '', author: 'Local creator' });
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const load = async () => {
    if (loading) return;
    setLoading(true); setLoadError('');
    try { await onLoad(); }
    catch (cause) { setLoadError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); }
  };
  const [width, setWidth] = useState(1024); const [depth, setDepth] = useState(1024); const [spacing, setSpacing] = useState(4);
  const [ownershipMode, setOwnershipMode] = useState<LandOwnershipMode>('entire-map');
  const withOwnership = (generated: GeneratedMap): GeneratedMap => {
    const world = structuredClone(generated.world ?? createWorldMetadata()); world.landOwnership = defaultLandOwnership(world, ownershipMode);
    return { ...generated, world };
  };
  const resize = (nextWidth: number, nextDepth: number) => { setWidth(nextWidth); setDepth(nextDepth); setSpacing(safeTerrainSpacing(nextWidth, nextDepth, spacing)); setMap(undefined); setError(''); };
  const [preset, setPreset] = useState<MapPreset>('flat-plains');
  const [seed, setSeed] = useState('civitas-1');
  const [parameters, setParameters] = useState<GeneratorParameters>(presetParameters('flat-plains'));
  const [map, setMap] = useState<GeneratedMap>();
  const [error, setError] = useState('');
  const selectPreset = (next: MapPreset) => { setPreset(next); setParameters(presetParameters(next)); setMap(undefined); setError(''); };
  const setParameter = <K extends keyof GeneratorParameters>(key: K, value: GeneratorParameters[K]) => {
    setParameters((current) => ({ ...current, [key]: value })); setMap(undefined); setError('');
  };
  const generate = () => {
    try {
      const result = generateMap({ generatorVersion: 1, seed: /^-?\d+(?:\.\d+)?$/.test(seed) ? Number(seed) : seed,
        preset, parameters }, { worldWidthMeters: width, worldDepthMeters: depth, terrainSampleSpacingMeters: spacing });
      setMap(result); setError(result.validation.valid ? '' : 'This seed has too little connected buildable land. Try another seed or adjust the terrain.');
    } catch (cause) { setMap(undefined); setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const randomize = () => { setSeed(String(crypto.getRandomValues(new Uint32Array(1))[0])); setMap(undefined); setError(''); };
  return <div class="new-game-screen" aria-label="New city map generator">
    <div class="new-game-header"><span class="identity-mark">C</span><span>PROJECT CIVITAS</span><small>NEW CITY / MAP GENERATOR</small></div>
    <div class="startup-actions"><span aria-current="page">NEW CITY</span>
      <button disabled={loading} onClick={load}>{loading ? 'LOADING CITY…' : 'LOAD EXISTING CITY'}</button></div>
    {loadError && <p class="startup-load-error" role="alert">{loadError}</p>}
    <nav class="map-source-tabs"><button aria-pressed={tab === 'generator'} onClick={() => setTab('generator')}>CREATE MAP / GENERATOR</button><button aria-pressed={tab === 'library'} onClick={() => setTab('library')}>MAP LIBRARY</button><button aria-pressed={tab === 'dem'} onClick={() => setTab('dem')}>DEM IMPORT</button></nav>
    {tab === 'library' ? <MapLibrary onSelect={onAssetStart} onEdit={onEdit} /> : tab === 'dem' ? <DemImport onEdit={onEdit} /> : <div class="new-game-layout">
      <section class="new-game-controls">
        <p class="new-game-eyebrow">CREATE A WORLD</p>
        <h1>Choose your terrain.</h1>
        <p>Every seed creates a repeatable map. Preview the land before founding your city.</p>
        <div class="new-game-dimensions">
          <label>WIDTH (METRES)<select aria-label="World width" value={width} onChange={e => resize(Number(e.currentTarget.value), depth)}>
            {WORLD_SIZE_OPTIONS.map(size => <option value={size}>{size}</option>)}</select></label>
          <label>DEPTH (METRES)<select aria-label="World depth" value={depth} onChange={e => resize(width, Number(e.currentTarget.value))}>
            {WORLD_SIZE_OPTIONS.map(size => <option value={size}>{size}</option>)}</select></label>
          <label>TERRAIN SAMPLE (METRES)<select aria-label="Terrain sample spacing" value={spacing} onChange={e => { setSpacing(Number(e.currentTarget.value)); setMap(undefined); }}>
            {safeTerrainSpacings(width, depth).map(size => <option value={size}>{size}</option>)}</select></label>
        </div>
        <label>LAND OWNERSHIP<select aria-label="New Game land ownership mode" value={ownershipMode} onChange={e => setOwnershipMode(e.currentTarget.value as LandOwnershipMode)}><option value="entire-map">Entire Map</option><option value="progressive">Progressive — unlock land tiles</option></select></label>
        <p>{ownershipMode === 'progressive' ? 'Start with one 1024m land tile. Customize the Starting Area in the Map Editor.' : 'Build anywhere within the physical world. Distant terrain remains at camera-local detail.'}</p>
        <label>PRESET<select aria-label="Map preset" value={preset} onChange={(event) => selectPreset(event.currentTarget.value as MapPreset)}>
          {(Object.keys(MAP_PRESETS) as MapPreset[]).map((key) => <option value={key}>{MAP_PRESETS[key].label}</option>)}</select></label>
        <div class="new-game-seed"><label>SEED<input aria-label="Map seed" value={seed} maxLength={128} onInput={(event) => { setSeed(event.currentTarget.value); setMap(undefined); }} /></label>
          <button onClick={randomize}>RANDOMIZE</button></div>
        <div class="new-game-sliders">
          {([['roughness', 'TERRAIN ROUGHNESS'], ['mountainAmount', 'MOUNTAINS'], ['waterAmount', 'WATER']] as const).map(([key, label]) =>
            <label>{label}<span>{Math.round(parameters[key] * 100)}%</span><input aria-label={label} type="range" min="0" max="1" step="0.01" value={parameters[key]}
              onInput={(event) => setParameter(key, Number(event.currentTarget.value))} /></label>)}
          <label>RIVER COUNT<span>{parameters.riverCount}</span><input aria-label="RIVER COUNT" type="range" min="0" max="4" step="1" value={parameters.riverCount}
            onInput={(event) => setParameter('riverCount', Number(event.currentTarget.value))} /></label>
        </div>
        <details class="new-game-advanced"><summary>ADVANCED PARAMETERS</summary>
          <label>HILL SCALE<input aria-label="Hill scale" type="number" min="60" max="400" value={parameters.hillScale} onInput={(event) => setParameter('hillScale', Number(event.currentTarget.value))} /></label>
          <label>SEA LEVEL<input aria-label="Sea level" type="number" min="-80" max="80" value={parameters.seaLevel} onInput={(event) => setParameter('seaLevel', Number(event.currentTarget.value))} /></label>
          <label>RIVER WIDTH<input aria-label="River width" type="number" min="8" max="80" value={parameters.riverWidth} onInput={(event) => setParameter('riverWidth', Number(event.currentTarget.value))} /></label>
          <label>COAST DIRECTION<select aria-label="Coast direction" value={parameters.coastDirection} onChange={(event) => setParameter('coastDirection', event.currentTarget.value as GeneratorParameters['coastDirection'])}>
            {(['north', 'east', 'south', 'west'] as const).map((direction) => <option value={direction}>{direction.toUpperCase()}</option>)}</select></label>
          {([['coastBias', 'COAST BIAS'], ['coastIrregularity', 'COAST IRREGULARITY'], ['smoothing', 'SMOOTHING'], ['flatness', 'FLATNESS']] as const).map(([key, label]) =>
            <label>{label}<input aria-label={label} type="range" min="0" max="1" step="0.01" value={parameters[key]}
              onInput={(event) => setParameter(key, Number(event.currentTarget.value))} /></label>)}
        </details>
        <button class="new-game-generate" onClick={generate}>GENERATE PREVIEW</button>
        <button onClick={() => { try { const asset = blankMapAsset(identity(), { worldWidthMeters: width, worldDepthMeters: depth, terrainSampleSpacingMeters: spacing }); asset.world.landOwnership = defaultLandOwnership(asset.world, ownershipMode); onEdit(asset); } catch (e) { setError(String(e)); } }}>CREATE BLANK / FLAT MAP</button>
      </section>
      <section class="new-game-preview" aria-label="Map preview">
        {map ? <MapPreview map={map} /> : <div class="new-game-placeholder"><span>{width} × {depth} M</span><strong>YOUR MAP AWAITS</strong><p>Generate a preview to inspect land, water and buildable areas.</p></div>}
        {map && <div class="new-game-validation"><div><strong>{Math.round(map.validation.buildableLandRatio * 100)}%</strong><span>BUILDABLE LAND</span></div>
          <div><strong>{Math.round(map.validation.waterRatio * 100)}%</strong><span>WATER</span></div>
          <div><strong>{map.validation.outsideRoadCandidates}</strong><span>EDGE CONNECTIONS</span></div>
          <div><strong>{Math.round(map.validation.largestBuildableAreaRatio * 100)}%</strong><span>CONNECTED AREA</span></div></div>}
        {error && <p class="new-game-error" role="alert">{error}</p>}
        <button disabled={!map} onClick={() => { try { if (map) onEdit(mapAssetFromGenerated(withOwnership(map), { ...identity(), name: `${MAP_PRESETS[map.metadata.preset].label} Map` })); } catch (e) { setError(String(e)); } }}>EDIT & SAVE AS MAP ASSET</button>
        <button class="new-game-start" disabled={loading || !map?.validation.valid} onClick={() => map && onStart(withOwnership(map))}>START CITY →</button>
      </section>
    </div>}
  </div>;
}
