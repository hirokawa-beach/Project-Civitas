import { useEffect, useMemo, useState } from 'preact/hooks';
import { DemAttribution } from './DemAttribution';
import { builtInMaps, duplicateMapAsset, validateMapAsset, type MapAsset } from '../maps/mapAsset';
import { listUserMaps, deleteMapAsset, duplicateStoredMap, renameMapAsset } from '../maps/mapStore';
import { defaultLandOwnership, type LandOwnershipMode } from '../world/landOwnership';

export function MapLibrary({ onSelect, onEdit }: { onSelect: (asset: MapAsset) => void; onEdit: (asset: MapAsset) => void }) {
  const [maps, setMaps] = useState<MapAsset[]>([]); const [selected, setSelected] = useState<string>();
  const [error, setError] = useState(''); const [name, setName] = useState(''); const [description, setDescription] = useState('');
  const [mode, setMode] = useState<LandOwnershipMode>('entire-map');
  const refresh = async () => { setMaps([...builtInMaps(), ...await listUserMaps()]); };
  useEffect(() => { void refresh().catch(e => setError(String(e))); }, []);
  const asset = maps.find(map => map.id === selected); const builtin = !!asset?.id.startsWith('builtin-');
  const validation = useMemo(() => asset ? validateMapAsset(asset) : undefined, [asset]);
  const act = async (action: () => Promise<unknown>) => { try { setError(''); await action(); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } };
  return <section class="map-library" aria-label="Map Library">
    <div class="map-library-list">{maps.map(map => <button class={`map-library-card ${selected === map.id ? 'active' : ''}`} aria-pressed={selected === map.id}
      onClick={() => { setSelected(map.id); setName(map.name); setDescription(map.description); setMode(map.world.landOwnership?.mode ?? 'entire-map'); }}>
      <small>{map.id.startsWith('builtin-') ? 'BUILT-IN MAP' : 'YOUR MAP'}</small><strong>{map.name}</strong><p>{map.description}</p>
      <span>{map.world.worldWidthMeters} × {map.world.worldDepthMeters} m · {map.world.terrainSampleSpacingMeters} m terrain · {map.world.waterBodies.length} water bodies</span>
    </button>)}</div>
    <div class="map-library-detail">{asset ? <>
      <h2>{asset.name}</h2><p>{asset.description}</p><p>Author: {asset.author || 'Local creator'} · Source: {asset.world.source.kind}</p>
      <DemAttribution world={asset.world} />
      <p>Grid {asset.world.terrainColumns} × {asset.world.terrainRows} · Chunks {asset.world.chunkSizeMeters} m · {asset.world.outsideConnections.length} outside entries</p>
      <label>LAND OWNERSHIP<select aria-label="Library New Game ownership mode" value={mode} onChange={e => setMode(e.currentTarget.value as LandOwnershipMode)}><option value="entire-map">Entire Map</option><option value="progressive">Progressive</option></select></label>
      <button class="new-game-start" disabled={!validation?.valid} onClick={() => { const copy = structuredClone(asset); if (copy.world.landOwnership?.mode !== mode) copy.world.landOwnership = defaultLandOwnership(copy.world, mode, copy.world.landOwnership?.tileSizeMeters); onSelect(copy); }}>START CITY FROM THIS MAP →</button>
      <button onClick={() => onEdit(builtin ? duplicateMapAsset(asset) : asset)}>{builtin ? 'DUPLICATE & EDIT MAP' : 'EDIT MAP'}</button>
      <button onClick={() => void act(() => duplicateStoredMap(asset))}>DUPLICATE</button>
      {!builtin && <>
        <label>MAP NAME<input aria-label="Library map name" value={name} maxLength={120} onInput={e => setName(e.currentTarget.value)} /></label>
        <label>DESCRIPTION<textarea aria-label="Library description" value={description} maxLength={4000} onInput={e => setDescription(e.currentTarget.value)} /></label>
        <button onClick={() => void act(() => renameMapAsset(asset.id, name, description))}>RENAME / UPDATE DESCRIPTION</button>
        <button onClick={() => void act(async () => { await deleteMapAsset(asset.id); setSelected(undefined); })}>DELETE MAP</button>
      </>}
    </> : <><h2>Choose a starting world.</h2><p>Select a built-in map or one of your saved Map Assets. Each new city receives its own copy of the world.</p></>}</div>
    {error && <p role="alert" class="new-game-error">{error}</p>}
  </section>;
}
