import { useEffect, useRef, useState } from 'preact/hooks';
import { generateMap, MAP_PRESETS, presetParameters, type GeneratedMap, type GeneratorParameters, type MapPreset } from '../terrain/generator';
import { TERRAIN_COLUMNS } from '../terrain/heightmap';

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
    const image = context.createImageData(TERRAIN_COLUMNS, TERRAIN_COLUMNS);
    const heights = map.heights; const water = map.metadata.parameters.seaLevel;
    for (let z = 0; z < TERRAIN_COLUMNS; z++) for (let x = 0; x < TERRAIN_COLUMNS; x++) {
      const index = z * TERRAIN_COLUMNS + x; const h = heights[index];
      const east = heights[z * TERRAIN_COLUMNS + Math.min(256, x + 1)];
      const south = heights[Math.min(256, z + 1) * TERRAIN_COLUMNS + x];
      const buildable = h > water && Math.max(Math.abs(east - h), Math.abs(south - h)) < .48;
      const [r, g, b] = mapColor(h, water, buildable);
      image.data.set([r, g, b, 255], index * 4);
    }
    context.putImageData(image, 0, 0);
  }, [map]);
  return <div class="new-game-map"><canvas ref={canvas} width={TERRAIN_COLUMNS} height={TERRAIN_COLUMNS} aria-label="Generated terrain preview: green buildable land, tan shore, blue water" />
    <div class="new-game-legend"><span><i class="land" /> BUILDABLE LAND</span><span><i class="water" /> WATER</span><span><i class="high" /> HIGHLANDS</span></div>
  </div>;
}

export function NewGame({ onStart }: { onStart: (map: GeneratedMap) => void }) {
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
        preset, parameters });
      setMap(result); setError(result.validation.valid ? '' : 'This seed has too little connected buildable land. Try another seed or adjust the terrain.');
    } catch (cause) { setMap(undefined); setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const randomize = () => { setSeed(String(crypto.getRandomValues(new Uint32Array(1))[0])); setMap(undefined); setError(''); };
  return <div class="new-game-screen" aria-label="New city map generator">
    <div class="new-game-header"><span class="identity-mark">C</span><span>PROJECT CIVITAS</span><small>NEW CITY / MAP GENERATOR</small></div>
    <div class="new-game-layout">
      <section class="new-game-controls">
        <p class="new-game-eyebrow">CREATE A WORLD</p>
        <h1>Choose your terrain.</h1>
        <p>Every seed creates a repeatable map. Preview the land before founding your city.</p>
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
      </section>
      <section class="new-game-preview" aria-label="Map preview">
        {map ? <MapPreview map={map} /> : <div class="new-game-placeholder"><span>1024 × 1024 M</span><strong>YOUR MAP AWAITS</strong><p>Generate a preview to inspect land, water and buildable areas.</p></div>}
        {map && <div class="new-game-validation"><div><strong>{Math.round(map.validation.buildableLandRatio * 100)}%</strong><span>BUILDABLE LAND</span></div>
          <div><strong>{Math.round(map.validation.waterRatio * 100)}%</strong><span>WATER</span></div>
          <div><strong>{map.validation.outsideRoadCandidates}</strong><span>EDGE CONNECTIONS</span></div>
          <div><strong>{Math.round(map.validation.largestBuildableAreaRatio * 100)}%</strong><span>CONNECTED AREA</span></div></div>}
        {error && <p class="new-game-error" role="alert">{error}</p>}
        <button class="new-game-start" disabled={!map?.validation.valid} onClick={() => map && onStart(map)}>START CITY →</button>
      </section>
    </div>
  </div>;
}
