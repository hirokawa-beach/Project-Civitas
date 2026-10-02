import { useEffect, useState } from 'preact/hooks';
import type { GameRuntime } from '../app/gameRuntime';
import type { SimulationClient } from '../app/simulationClient';
import type { WorldSnapshot } from '../shared/protocol';
import { TRACK_TYPES, type TrackMode, type StationTemplate } from '../railway/types';
import { RailwayOperations } from './RailwayOperations';

export function RailwayPanel({ runtime, simulation, snapshot, onClose }: { runtime: GameRuntime; simulation: SimulationClient; snapshot: WorldSnapshot; onClose: () => void }) {
  const rail = runtime.railConstruction, state = snapshot.railway;
  const [status, setStatus] = useState(rail.status), [mode, setMode] = useState(rail.trackMode), [typeId, setTypeId] = useState(rail.trackTypeId);
  const [template, setTemplate] = useState<StationTemplate>(rail.template), [length, setLength] = useState(rail.length), [name, setName] = useState(rail.name), [capacity, setCapacity] = useState(rail.capacity);
  useEffect(() => rail.subscribe(setStatus), [rail]);
  useEffect(() => () => runtime.endRailConstruction(), [runtime]);
  const activate = (tool: typeof rail.mode) => { rail.mode = tool; rail.trackMode = mode; rail.trackTypeId = typeId; rail.template = template; rail.length = length; rail.name = name; rail.capacity = capacity; runtime.setTool('railway'); rail.setEnabled(true); };
  return <aside class="railway-panel panel" aria-label="Railway control">
    <header><h2>Railway</h2><button onClick={onClose}>CLOSE</button></header>
    <p>Independent Track Graph · surface track only</p>
    <label>TRACK TYPE<select aria-label="Rail track type" value={typeId} onChange={e => { setTypeId(e.currentTarget.value); rail.trackTypeId = e.currentTarget.value; rail.cancel(); }}>{TRACK_TYPES.map(t => <option value={t.id}>{t.name} · {t.speedLimit} km/h · R≥{t.minimumCurveRadius}m</option>)}</select></label>
    <label>TRACK MODE<select aria-label="Rail track mode" value={mode} onChange={e => { const next = e.currentTarget.value as TrackMode; setMode(next); rail.trackMode = next; rail.cancel(); }}><option value="straight">Straight</option><option value="one-curve">1-Curve</option><option value="two-curve">2-Curve</option><option value="continuous">Continuous curve</option></select></label>
    <button onClick={() => activate('track')}>BUILD TRACK</button><button onClick={() => activate('demolish')}>REMOVE TRACK</button><button onClick={() => rail.cancel()}>CANCEL POINTS</button>
    <p role="status">{status}</p>
    <details open><summary>STATIONS / DEPOTS</summary>
      <label>NAME<input aria-label="Rail station or depot name" value={name} onInput={e => { setName(e.currentTarget.value); rail.name = e.currentTarget.value; }} /></label>
      <label>TEMPLATE<select aria-label="Rail station template" value={template} onChange={e => { setTemplate(e.currentTarget.value as StationTemplate); rail.template = e.currentTarget.value as StationTemplate; }}><option value="single">1 platform / 1 track</option><option value="double">2 platforms / 2 tracks</option><option value="island">Island: 1 platform / 2 tracks</option></select></label>
      <label>PLATFORM LENGTH (m)<input aria-label="Rail platform length" type="number" min="20" max="400" value={length} onInput={e => { setLength(Number(e.currentTarget.value)); rail.length = Number(e.currentTarget.value); }} /></label>
      <button onClick={() => activate('station')}>PLACE STATION ON TRACK</button><p>Click a straight track; allow 80m approach space on both ends of the platform.</p>
      <label>DEPOT CAPACITY<input aria-label="Rail depot capacity" type="number" min="1" max="1000" value={capacity} onInput={e => { setCapacity(Number(e.currentTarget.value)); rail.capacity = Number(e.currentTarget.value); }} /></label>
      <button onClick={() => activate('depot')}>PLACE DEPOT ON TRACK</button>
    </details>
    <RailwayOperations simulation={simulation} snapshot={snapshot} onCreate={() => runtime.endRailConstruction()} />
    <details><summary>TRACK GRAPH / PLATFORMS / BLOCKS</summary>
      <p>{state?.nodes.length ?? 0} nodes · {state?.segments.length ?? 0} tracks · {state?.junctions.length ?? 0} junctions</p>
      {state?.stations.map(station => <div><strong>{station.name} · {station.stationId}</strong>{station.platforms.map(platform => <p>{platform.platformId} · {platform.length}m · {platform.faces.map(face => `${face.platformFaceId}: ${face.trackSegmentId} (${face.side}, ${face.direction})`).join(' / ')}</p>)}<button onClick={() => void simulation.execute({ type: 'remove-railway', kind: 'station', id: station.stationId })}>REMOVE {station.name}</button></div>)}
      {state?.depots.map(depot => <p>{depot.name} · {depot.id} · {depot.connectedTrackId} · capacity {depot.capacity} <button onClick={() => void simulation.execute({ type: 'remove-railway', kind: 'depot', id: depot.id })}>REMOVE DEPOT</button></p>)}
      {state?.junctions.slice(0, 50).map(junction => <label>{junction.id}<select aria-label={`Switch ${junction.id}`} value={junction.selectedRoute?.join('|') ?? ''} onChange={e => void simulation.execute({ type: 'set-rail-switch', junctionId: junction.id, route: e.currentTarget.value ? e.currentTarget.value.split('|') as [string, string] : null })}><option value="">Automatic connectivity</option>{junction.segmentIds.flatMap((a, i) => junction.segmentIds.slice(i + 1).map(b => <option value={`${a}|${b}`}>{a} ↔ {b}</option>))}</select></label>)}
      {(snapshot.railwayRuntime?.ownedBlocks.length ? snapshot.railwayRuntime.ownedBlocks : state?.blocks.slice(0, 50))?.slice(0, 50).map(block => <p>{block.id} · occupied {block.occupancyOwner ?? '—'} · reserved {block.reservationOwner ?? '—'}</p>)}
    </details>
  </aside>;
}
