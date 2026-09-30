import { useEffect, useState } from 'preact/hooks';
import type { GameRuntime } from '../app/gameRuntime';
import type { SimulationClient } from '../app/simulationClient';
import { validateMapAsset, suggestOutsideConnections, type MapAsset, type MapAssetValidation } from '../maps/mapAsset';
import { saveMapAsset } from '../maps/mapStore';
import type { MapOutsideConnection, WaterBody, WaterGeometry } from '../world/metadata';
import type { TerrainBrushMode, Vec2 } from '../world/types';
import { HeightmapTerrain } from '../terrain/heightmap';

const parsePoints = (text: string): Vec2[] => text.trim() ? text.trim().split(/\n+/).map(line => {
  const values = line.trim().split(/[,\s]+/).map(Number);
  if (values.length !== 2 || !values.every(Number.isFinite)) throw new Error('Enter one x, z pair in metres per line.');
  return { x: values[0], z: values[1] };
}) : [];
const formatPoints = (points: readonly Vec2[]) => points.map(p => `${p.x}, ${p.z}`).join('\n');

export function MapEditor({ runtime, simulation, asset, onBack }: { runtime: GameRuntime; simulation: SimulationClient; asset: MapAsset; onBack: () => void }) {
  const [snapshot, setSnapshot] = useState(simulation.latestSnapshot);
  const [tab, setTab] = useState<'terrain' | 'water' | 'outside' | 'validate'>('terrain');
  const [name, setName] = useState(asset.name); const [description, setDescription] = useState(asset.description);
  const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  const [validation, setValidation] = useState<MapAssetValidation>();
  const [brush, setBrush] = useState<TerrainBrushMode>('raise'); const [size, setSize] = useState(40); const [strength, setStrength] = useState(5);
  const [bodyId, setBodyId] = useState(''); const [waterType, setWaterType] = useState<WaterBody['type']>('lake');
  const [geometryKind, setGeometryKind] = useState<'polygon' | 'river'>('polygon');
  const [elevation, setElevation] = useState(0); const [riverWidth, setRiverWidth] = useState(24);
  const [points, setPoints] = useState(''); const [polygonIndex, setPolygonIndex] = useState(0); const [geometryEdited, setGeometryEdited] = useState(false);
  const [connectionId, setConnectionId] = useState(''); const [connectionType, setConnectionType] = useState<MapOutsideConnection['type']>('road');
  const [connectionPosition, setConnectionPosition] = useState<Vec2>({ x: -asset.world.worldWidthMeters / 2, z: 0 });
  useEffect(() => setValidation(undefined), [snapshot?.terrainRevision, snapshot?.water.revision, name, description]);
  const [perf, setPerf] = useState('');
  useEffect(() => simulation.subscribe(setSnapshot), [simulation]);
  useEffect(() => {
    runtime.construction.setEditorMode(true); runtime.setTerrainMode('raise');
    const timer = setInterval(() => setPerf(`${runtime.renderer.getFps().toFixed(0)} FPS · ${runtime.renderer.getFrameTime().toFixed(1)} ms/frame · ${runtime.renderer.getTerrainMeshCount()} local terrain chunks`), 1000);
    return () => { clearInterval(timer); runtime.renderer.setMapGeometryPreview(); };
  }, [runtime]);
  useEffect(() => { if (tab === 'terrain') { runtime.setTerrainMode(brush); runtime.setTerrainBrush(size, strength); } else runtime.setTool('inspect'); }, [tab, brush, size, strength, runtime]);
  useEffect(() => {
    const canvas = document.getElementById('game-canvas')!;
    const click = (event: PointerEvent) => {
      if (event.button !== 0 || (tab !== 'water' && tab !== 'outside')) return;
      const p = runtime.renderer.pickGround(event.clientX, event.clientY); if (!p) return;
      event.preventDefault(); event.stopImmediatePropagation();
      const q = { x: Math.round(p.x), z: Math.round(p.z) };
      if (tab === 'water') { setPoints(current => `${current}${current.trim() ? '\n' : ''}${q.x}, ${q.z}`); setGeometryEdited(true); }
      else {
        const world = simulation.latestSnapshot!.worldMetadata; const w = world.worldWidthMeters / 2; const d = world.worldDepthMeters / 2;
        const edges = [{ x: -w, z: q.z }, { x: w, z: q.z }, { x: q.x, z: -d }, { x: q.x, z: d }];
        edges.sort((a, b) => Math.hypot(a.x - q.x, a.z - q.z) - Math.hypot(b.x - q.x, b.z - q.z)); setConnectionPosition(edges[0]);
      }
    };
    canvas.addEventListener('pointerdown', click, true); return () => canvas.removeEventListener('pointerdown', click, true);
  }, [tab, runtime, simulation]);
  useEffect(() => {
    try { runtime.renderer.setMapGeometryPreview(tab === 'water' ? parsePoints(points) : undefined, geometryKind === 'polygon'); }
    catch { runtime.renderer.setMapGeometryPreview(); }
  }, [points, tab, geometryKind, runtime]);
  const run = async (action: () => Promise<unknown>) => {
    if (busy) return; setBusy(true); setMessage('');
    try { await action(); } catch (e) { setMessage(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const identity = () => ({ id: asset.id, name: name.trim(), description, author: asset.author });
  const exportAsset = async () => (await simulation.mapOperation({ kind: 'export', identity: identity() }))!;
  const selectBody = (id: string, index = 0) => {
    const body = simulation.latestSnapshot?.worldMetadata.waterBodies.find(b => b.id === id); setBodyId(id); setPolygonIndex(index); setGeometryEdited(false);
    if (!body) { setPoints(''); setWaterType('lake'); setGeometryKind('polygon'); setElevation(0); return; }
    setWaterType(body.type); setElevation(body.surfaceElevation); setGeometryKind(body.geometry.kind === 'river' ? 'river' : 'polygon');
    if (body.geometry.kind === 'river') { setPoints(formatPoints(body.geometry.path)); setRiverWidth(body.geometry.widths[0]); }
    else setPoints(formatPoints(body.geometry.kind === 'polygon' ? body.geometry.vertices : body.geometry.polygons[index].vertices));
  };
  const applyWater = async () => {
    const current = simulation.latestSnapshot!.worldMetadata.waterBodies; const old = current.find(b => b.id === bodyId); const vertices = parsePoints(points);
    let geometry: WaterGeometry;
    if (geometryKind === 'river') geometry = { kind: 'river', path: vertices, widths: vertices.map((_, i) => old?.geometry.kind === 'river' && !geometryEdited ? old.geometry.widths[i] : riverWidth) };
    else if (old?.geometry.kind === 'multipolygon') geometry = { ...old.geometry, polygons: old.geometry.polygons.map((p, i) => i === polygonIndex ? { ...p, vertices } : p) };
    else geometry = { kind: 'polygon', vertices, holes: old?.geometry.kind === 'polygon' ? old.geometry.holes : undefined };
    const body: WaterBody = { ...old, id: bodyId || `water-${crypto.randomUUID().slice(0, 8)}`, type: waterType, surfaceElevation: elevation, geometry, boundary: [] };
    await simulation.mapOperation({ kind: 'water', bodies: [...current.filter(b => b.id !== body.id), body] });
    setBodyId(body.id); setValidation(undefined); setMessage('Water Body saved to the working map.');
  };
  const currentBody = snapshot?.worldMetadata.waterBodies.find(b => b.id === bodyId);
  return <div class="map-editor" aria-label="Map Editor">
    <header class="map-editor-header panel"><div><strong>MAP EDITOR</strong><span>{snapshot?.worldMetadata.worldWidthMeters} × {snapshot?.worldMetadata.worldDepthMeters} m · {perf}</span></div>
      <button onClick={onBack}>BACK TO MAP LIBRARY</button></header>
    <aside class="map-editor-sidebar panel">
      <label>MAP NAME<input aria-label="Map asset name" value={name} maxLength={120} onInput={e => { setName(e.currentTarget.value); setValidation(undefined); }} /></label>
      <label>DESCRIPTION<textarea aria-label="Map description" value={description} maxLength={4000} onInput={e => setDescription(e.currentTarget.value)} /></label>
      <nav>{(['terrain', 'water', 'outside', 'validate'] as const).map(key => <button aria-pressed={tab === key} onClick={() => setTab(key)}>{key === 'outside' ? 'CONNECTIONS' : key.toUpperCase()}</button>)}</nav>
      {tab === 'terrain' && <section><h2>Sculpt the terrain.</h2><p>Drag on the map to edit. Water boundaries stay fixed.</p>
        <div class="map-editor-tools">{(['raise', 'lower', 'flatten', 'smooth'] as const).map(mode => <button aria-pressed={brush === mode} onClick={() => setBrush(mode)}>{mode.toUpperCase()}</button>)}</div>
        <label>BRUSH SIZE (m)<input aria-label="Editor brush size" type="range" min="8" max="256" value={size} onInput={e => setSize(Number(e.currentTarget.value))} /><output>{size}</output></label>
        <label>STRENGTH<input aria-label="Editor brush strength" type="range" min="1" max="50" value={strength} onInput={e => setStrength(Number(e.currentTarget.value))} /><output>{strength}</output></label>
        <button onClick={() => runtime.undo()}>UNDO TERRAIN</button><button onClick={() => runtime.redo()}>REDO TERRAIN</button>
      </section>}
      {tab === 'water' && <section><h2>Water Bodies</h2><p>Select a body to edit, or draw a new polygon/path by clicking terrain. Replace vertices in metres below.</p>
        <select aria-label="Select Water Body" value={bodyId} onChange={e => selectBody(e.currentTarget.value)}><option value="">NEW WATER BODY</option>
          {snapshot?.worldMetadata.waterBodies.map(b => <option value={b.id}>{b.type} · {b.id} · {b.surfaceElevation} m</option>)}</select>
        <button onClick={() => selectBody('')}>NEW WATER BODY</button>
        <button onClick={() => { try { const vertices = parsePoints(points); if (vertices.length) runtime.renderer.focusMapPosition(vertices[Math.floor(vertices.length / 2)]); } catch (e) { setMessage(String(e)); } }}>FOCUS WATER DRAWING</button>
        {currentBody?.geometry.kind === 'multipolygon' && <label>POLYGON<select aria-label="Water polygon" value={polygonIndex} onChange={e => selectBody(bodyId, Number(e.currentTarget.value))}>{currentBody.geometry.polygons.map((_, i) => <option value={i}>{i + 1}</option>)}</select></label>}
        <label>TYPE<select aria-label="Water type" value={waterType} onChange={e => { setWaterType(e.currentTarget.value as WaterBody['type']); if (e.currentTarget.value === 'river') setGeometryKind('river'); }}>{['ocean', 'sea', 'river', 'lake', 'reservoir'].map(type => <option value={type}>{type}</option>)}</select></label>
        <label>GEOMETRY<select aria-label="Water geometry" value={geometryKind} onChange={e => { setGeometryKind(e.currentTarget.value as 'polygon' | 'river'); setGeometryEdited(true); }}><option value="polygon">Polygon</option><option value="river">River path + width</option></select></label>
        <label>SURFACE ELEVATION (m)<input aria-label="Water surface elevation" type="number" value={elevation} onInput={e => setElevation(Number(e.currentTarget.value))} /></label>
        {geometryKind === 'river' && <label>WIDTH (m)<input aria-label="River width" type="number" min="1" max="4096" value={riverWidth} onInput={e => { setRiverWidth(Number(e.currentTarget.value)); setGeometryEdited(true); }} /></label>}
        <label>VERTICES / PATH · x, z (m)<textarea class="map-points" aria-label="Water vertices" value={points} onInput={e => { setPoints(e.currentTarget.value); setGeometryEdited(true); }} /></label>
        <button onClick={() => { setPoints(''); setGeometryEdited(true); }}>CLEAR DRAWING</button><button disabled={busy} onClick={() => void run(applyWater)}>APPLY WATER BODY</button>
        {bodyId && <button disabled={busy} onClick={() => void run(async () => { await simulation.mapOperation({ kind: 'water', bodies: simulation.latestSnapshot!.worldMetadata.waterBodies.filter(b => b.id !== bodyId) }); selectBody(''); setValidation(undefined); })}>DELETE WATER BODY</button>}
      </section>}
      {tab === 'outside' && <section><h2>Outside Connections</h2><p>Click terrain to snap an entry to the nearest map edge. Road entries need dry, gently sloped land.</p>
        <select aria-label="Select Outside Connection" value={connectionId} onChange={e => { const id = e.currentTarget.value; setConnectionId(id); const c = snapshot?.worldMetadata.outsideConnections.find(c => c.id === id); if (c) { setConnectionType(c.type); setConnectionPosition(c.position); } }}><option value="">NEW CONNECTION</option>{snapshot?.worldMetadata.outsideConnections.map(c => <option value={c.id}>{c.type} · {c.id}</option>)}</select>
        <label>TYPE<select aria-label="Outside connection type" value={connectionType} onChange={e => setConnectionType(e.currentTarget.value as MapOutsideConnection['type'])}>{['road', 'rail', 'shipping'].map(type => <option value={type}>{type}</option>)}</select></label>
        {connectionType !== 'road' && <p>Stored for future transport support. Include a usable road entry to start a city.</p>}
        <label>X (m)<input aria-label="Outside X" type="number" value={connectionPosition.x} onInput={e => setConnectionPosition({ ...connectionPosition, x: Number(e.currentTarget.value) })} /></label>
        <label>Z (m)<input aria-label="Outside Z" type="number" value={connectionPosition.z} onInput={e => setConnectionPosition({ ...connectionPosition, z: Number(e.currentTarget.value) })} /></label>
        <button onClick={() => runtime.renderer.focusMapPosition(connectionPosition)}>FOCUS CONNECTION</button>
        <button disabled={busy} onClick={() => void run(async () => { const id = connectionId || `entry-${crypto.randomUUID().slice(0, 8)}`;
          await simulation.mapOperation({ kind: 'outside', connections: [...simulation.latestSnapshot!.worldMetadata.outsideConnections.filter(c => c.id !== id), { id, type: connectionType, position: connectionPosition }] }); setConnectionId(id); setValidation(undefined); setMessage('Outside Connection applied.'); })}>APPLY CONNECTION</button>
        {connectionId && <button onClick={() => void run(async () => { await simulation.mapOperation({ kind: 'outside', connections: simulation.latestSnapshot!.worldMetadata.outsideConnections.filter(c => c.id !== connectionId) }); setConnectionId(''); setValidation(undefined); })}>DELETE CONNECTION</button>}
        <button onClick={() => void run(async () => { const draft = await exportAsset(); await simulation.mapOperation({ kind: 'outside', connections: suggestOutsideConnections(draft.world, new HeightmapTerrain(draft.terrain)) }); setValidation(undefined); })}>SUGGEST ROAD ENTRIES</button>
      </section>}
      {tab === 'validate' && <section><h2>Validate & save.</h2><p>This asset stores the initial world. City saves contain their own independent world copy.</p>
        <button disabled={busy} onClick={() => void run(async () => { setValidation(validateMapAsset(await exportAsset())); })}>VALIDATE MAP</button>
        {validation && <div role="status"><strong>{validation.valid ? 'READY TO START A CITY' : 'MAP NEEDS ATTENTION'}</strong><p>{validation.usableOutsideConnections} usable road entries</p>{[...validation.errors, ...validation.warnings].map(text => <p>{text}</p>)}</div>}
        <button class="new-game-start" disabled={busy} onClick={() => void run(async () => { const saved = await exportAsset(); const result = validateMapAsset(saved); setValidation(result); if (!result.valid) throw new Error(result.errors.join(' '));
          await saveMapAsset(saved, true); setMessage('Map Asset saved. It is available in the Map Library.'); })}>SAVE AS MAP ASSET</button>
      </section>}
      {message && <p class="map-editor-message" role="status">{message}</p>}
      <p class="map-editor-help">WASD / arrows: pan · Wheel: zoom · Middle drag: orbit</p>
    </aside>
  </div>;
}
