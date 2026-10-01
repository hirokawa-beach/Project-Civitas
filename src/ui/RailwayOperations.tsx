import { useMemo, useState } from 'preact/hooks';
import type { SimulationClient } from '../app/simulationClient';
import type { WorldSnapshot } from '../shared/protocol';
import { FORMATION_TYPES, RAIL_SERVICE_TYPES } from '../railway/operationsTypes';

export function railTime(seconds: number) {
  const s = Math.floor(seconds); return `D${Math.floor(s / 86400) + 1} ${String(Math.floor(s / 3600) % 24).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
export function RailwayOperations({ simulation, snapshot, onCreate }: { simulation: SimulationClient; snapshot: WorldSnapshot; onCreate: () => void }) {
  const rail = snapshot.railway, operations = rail?.operations, runtime = snapshot.railwayRuntime;
  const [name, setName] = useState('City Railway'), [type, setType] = useState('local'), [formation, setFormation] = useState('commuter-2');
  const [depot, setDepot] = useState(''), [stops, setStops] = useState<Array<{ face: string; type: 'stop' | 'pass' }>>([]);
  const [start, setStart] = useState(snapshot.gameClock.gameSeconds + 120), [duration, setDuration] = useState(30), [frequency, setFrequency] = useState(5), [returnService, setReturn] = useState(true);
  const [error, setError] = useState('');
  const execute = async (command: Parameters<SimulationClient['execute']>[0]) => { try { setError(''); const response = await simulation.execute(command); if (!response.ok) setError(response.error ?? 'Railway command rejected.'); else if (command.type === 'create-rail-frequency') onCreate(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } };
  const stationNames = useMemo(() => new Map(rail?.stations.map(s => [s.stationId, s.name])), [rail]);
  const faces = useMemo(() => rail?.stations.flatMap(s => s.platforms.flatMap(p => p.faces.map(f => ({ id: f.platformFaceId, name: `${s.name} · ${p.length}m · ${f.platformFaceId}` })))) ?? [], [rail]);
  const states = useMemo(() => new Map(runtime?.serviceStates.map(s => [s.serviceId, s])), [runtime]);
  const byService = useMemo(() => new Map(operations?.operations.flatMap(o => o.trainServiceIds.map(id => [id, o] as const))), [operations]);
  const services = useMemo(() => new Map(operations?.services.map(s => [s.id, s])), [operations]);
  const activeByService = useMemo(() => new Map(runtime?.activeTrains.map(t => [t.serviceId, t])), [runtime]);
  const depotId = depot || rail?.depots[0]?.id || '';
  return <section aria-label="Railway operations">
    <h3>OPERATIONS / TIMETABLE</h3>
    <p>GameClock: {railTime(snapshot.gameClock.gameSeconds)} · {runtime?.activeTrains.length ?? 0} active trains</p>
    {!(operations?.services.length || operations?.lines.length) ? <details open><summary>CREATE FREQUENCY SERVICE</summary>
      <label>LINE NAME<input aria-label="Rail line name" value={name} onInput={e => setName(e.currentTarget.value)} /></label>
      <label>SERVICE TYPE<select aria-label="Rail service type" value={type} onChange={e => setType(e.currentTarget.value)}>{RAIL_SERVICE_TYPES.map(t => <option value={t.id}>{t.name}</option>)}</select></label>
      <label>FORMATION<select aria-label="Rail formation type" value={formation} onChange={e => setFormation(e.currentTarget.value)}>{FORMATION_TYPES.map(t => <option value={t.id}>{t.name} · {t.length}m · {t.capacity} people</option>)}</select></label>
      <label>DEPOT<select aria-label="Rail operation depot" value={depotId} onChange={e => setDepot(e.currentTarget.value)}><option value="">Choose depot</option>{rail?.depots.map(d => <option value={d.id}>{d.name} · capacity {d.capacity}</option>)}</select></label>
      <p>Select platform faces in travel order. Pass calls have no dwell.</p>
      <label>ADD STOP<select aria-label="Add rail stop" value="" onChange={e => { if (e.currentTarget.value) setStops([...stops, { face: e.currentTarget.value, type: 'stop' }]); }}><option value="">Choose station / face</option>{faces.filter(f => !stops.some(s => s.face === f.id)).map(f => <option value={f.id}>{f.name}</option>)}</select></label>
      <ol>{stops.map((stop, i) => <li>{faces.find(f => f.id === stop.face)?.name}<select aria-label={`Rail stop ${i + 1} type`} value={stop.type} onChange={e => setStops(stops.map((s, j) => j === i ? { ...s, type: e.currentTarget.value as 'stop' | 'pass' } : s))}><option value="stop">Stop</option><option value="pass">Pass</option></select><button onClick={() => setStops(stops.filter((_, j) => i !== j))}>REMOVE</button></li>)}</ol>
      <label>FIRST DEPARTURE (GameClock seconds)<input aria-label="Rail first departure" type="number" min="0" step="1" value={start} onInput={e => setStart(Number(e.currentTarget.value))} /></label>
      <p>{railTime(start)}</p><button onClick={() => setStart(snapshot.gameClock.gameSeconds + 120)}>START IN 2 GAME MINUTES</button>
      <label>SERVICE WINDOW (minutes)<input aria-label="Rail service window" type="number" min="1" value={duration} onInput={e => setDuration(Number(e.currentTarget.value))} /></label>
      <label>HEADWAY (minutes)<input aria-label="Rail headway" type="number" min=".1" step=".1" value={frequency} onInput={e => setFrequency(Number(e.currentTarget.value))} /></label>
      <label><input type="checkbox" checked={returnService} onChange={e => setReturn(e.currentTarget.checked)} /> RETURN / TURNBACK SERVICE</label>
      <button disabled={stops.length < 2 || !depotId} onClick={() => void execute({ type: 'create-rail-frequency', input: { name, color: '#58b0d0', start, end: start + Math.round(duration * 60), frequency: Math.round(frequency * 60), faceIds: stops.map(s => s.face), stopTypes: stops.map(s => s.type), formationTypeId: formation, depotId, serviceTypeId: type, returnService } })}>CREATE TIMETABLE</button>
    </details> : <><p>{operations.lines.map(l => l.name).join(' / ')} · {operations.services.length} services · {operations.formations.length} formations · {operations.operations.length} operations</p>
      <button onClick={() => void execute({ type: 'clear-rail-operations' })}>STOP AND CLEAR TIMETABLE</button><p>Clear the timetable before editing track or Undo/Redo. Track and station data are retained.</p>
    </>}
    {error && <p role="alert">{error}</p>}
    <details open><summary>ACTIVE TRAINS / DELAY</summary>{runtime?.activeTrains.map(train => {
      const service = services.get(train.serviceId), operation = byService.get(train.serviceId);
      const delay = Math.max(train.delay, train.state === 'waiting' && service ? snapshot.gameClock.gameSeconds - service.stopCalls[train.callIndex].departureTime : 0);
      return <div><strong>Train {service?.trainNumber} · {train.state}</strong><p>{train.formationId} · operation {operation?.operationNumber} · {train.faceId} · +{delay}s · {train.onboard.reduce((n, g) => n + g.count, 0)} aboard</p>{train.state === 'dwelling' && <button onClick={() => void execute({ type: 'extend-rail-dwell', formationId: train.formationId, seconds: 30 })}>EXTEND DWELL +30s</button>}</div>;
    })}<p>OD waiting {runtime?.waitingPassengers ?? 0} · arrived {runtime?.arrivedPassengers ?? 0} · left behind {runtime?.leftBehind ?? 0}</p></details>
    <details><summary>SERVICE LIST / STOP CALLS</summary>{operations?.services.slice(0, 100).map(service => {
      const state = states.get(service.id), op = byService.get(service.id), active = activeByService.get(service.id);
      const delay = Math.max(state?.delay ?? 0, state?.status === 'waiting' ? snapshot.gameClock.gameSeconds - (active ? service.stopCalls[active.callIndex].departureTime : service.stopCalls[0].arrivalTime) : 0);
      return <details><summary>Train {service.trainNumber} · {service.serviceTypeId} · {state?.status ?? 'scheduled'} · +{delay}s</summary><p>{service.id} · {service.passengerService ? 'Passenger' : 'Deadhead'} · formation {op?.assignedFormationId} · operation {op?.operationNumber}</p>{service.stopCalls.map(call => <p>{stationNames.get(call.stationId)} · {call.platformFaceId} · {call.stopType}<br />{railTime(call.arrivalTime)} → {railTime(call.departureTime)}{state?.actualCalls[call.sequence]?.arrivalTime !== undefined && <><br />Actual {railTime(state.actualCalls[call.sequence].arrivalTime!)}{state.actualCalls[call.sequence].departureTime !== undefined ? ` → ${railTime(state.actualCalls[call.sequence].departureTime!)}` : ''}</>}</p>)}</details>;
    })}{(operations?.services.length ?? 0) > 100 && <p>Showing the first 100 services.</p>}</details>
  </section>;
}
