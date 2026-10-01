import { useEffect, useMemo, useState } from 'preact/hooks';
import type { WorldSnapshot } from '../shared/protocol';
import type { GameRuntime } from '../app/gameRuntime';
import type { SimulationClient } from '../app/simulationClient';
import { landTileBounds, validateLandTiles } from '../world/landOwnership';

export function LandOwnershipPanel({ snapshot, runtime, simulation, onClose }: { snapshot: WorldSnapshot; runtime: GameRuntime; simulation: SimulationClient; onClose: () => void }) {
  const first = snapshot.landOwnership.ownedTiles[0] ?? { x: 0, z: 0 };
  const [x, setX] = useState(first.x); const [z, setZ] = useState(first.z); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  const land = snapshot.landOwnership;
  const columns = Math.ceil(snapshot.worldMetadata.worldWidthMeters / land.tileSizeMeters); const rows = Math.ceil(snapshot.worldMetadata.worldDepthMeters / land.tileSizeMeters);
  const neighbors = useMemo(() => {
    const owned = new Set(land.ownedTiles.map(tile => `${tile.x}:${tile.z}`)); const candidates = new Map<string, { x: number; z: number }>();
    for (const tile of land.ownedTiles) for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const next = { x: tile.x + dx, z: tile.z + dz }; const key = `${next.x}:${next.z}`;
      if (next.x >= 0 && next.x < columns && next.z >= 0 && next.z < rows && !owned.has(key)) candidates.set(key, next);
    }
    return [...candidates.values()];
  }, [land, columns, rows]);
  useEffect(() => { runtime.cancelConstruction(); runtime.renderer.setLandOverlayEnabled(true); return () => runtime.renderer.setLandOverlayEnabled(false); }, [runtime]);
  const focus = () => { try { validateLandTiles([{ x, z }], snapshot.worldMetadata, land.tileSizeMeters); const box = landTileBounds({ x, z }, snapshot.worldMetadata, land.tileSizeMeters); runtime.renderer.focusMapPosition({ x: (box.minX + box.maxX) / 2, z: (box.minZ + box.maxZ) / 2 }); } catch (error) { setMessage(String(error)); } };
  const unlock = async () => { setBusy(true); try { const response = await simulation.execute({ type: 'unlock-land', tile: { x, z } }); setMessage(response.ok ? `Tile ${x}, ${z} unlocked.` : 'Unlock an unowned tile sharing an edge with your owned area.'); } catch (error) { setMessage(String(error)); } finally { setBusy(false); } };
  return <aside class="land-panel panel" aria-label="Land ownership">
    <header><h2>Land ownership</h2><button onClick={onClose}>CLOSE LAND</button></header>
    <p>Physical world: {snapshot.worldMetadata.worldWidthMeters} × {snapshot.worldMetadata.worldDepthMeters} m</p>
    <p>{land.mode === 'entire-map' ? 'Entire Map — all land is buildable.' : `Progressive — ${land.ownedTiles.length} of ${columns * rows} land tiles owned.`}</p>
    <p>Land tile: {land.tileSizeMeters}m · Terrain chunk: {snapshot.worldMetadata.chunkSizeMeters}m</p>
    <p>Green: owned · Amber: locked. Nearby outlines follow the camera.</p>
    {land.mode === 'progressive' && <>
      <label>ADJACENT TILE<select aria-label="Adjacent land tile" value={`${x}:${z}`} onChange={e => { const pair = e.currentTarget.value.split(':').map(Number); setX(pair[0]); setZ(pair[1]); }}><option value={`${x}:${z}`}>{x}, {z}</option>{neighbors.filter(t => t.x !== x || t.z !== z).map(tile => <option value={`${tile.x}:${tile.z}`}>{tile.x}, {tile.z}</option>)}</select></label>
      <p>Unlock tiles sharing an edge with your owned area. Unlocks are permanent and currently free.</p>
    </>}
    <label>TILE X<input aria-label="Unlock tile X" type="number" min="0" max={columns - 1} value={x} onInput={e => setX(Number(e.currentTarget.value))} /></label>
    <label>TILE Z<input aria-label="Unlock tile Z" type="number" min="0" max={rows - 1} value={z} onInput={e => setZ(Number(e.currentTarget.value))} /></label>
    <button onClick={focus}>FOCUS LAND TILE</button>{land.mode === 'progressive' && <button disabled={busy} onClick={() => void unlock()}>UNLOCK TILE</button>}
    {message && <p role="status">{message}</p>}
  </aside>;
}
