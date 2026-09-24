import { useEffect, useMemo, useState } from 'preact/hooks';
import type { GameRuntime } from '../app/gameRuntime';
import type { SimulationClient } from '../app/simulationClient';
import type { ConstructionStatus, RoadMode } from '../roads/constructionController';
import type { SnapSettingKey } from '../roads/snapping';
import { GAME_VERSION } from '../save/serializer';
import { readQuickSave, writeQuickSave } from '../save/saveStore';
import type { WorldSnapshot } from '../shared/protocol';
import type { GameSpeed } from '../simulation/gameClock';
import type { ZoneBrush, ZoneType } from '../zoning/types';
import type { TerrainBrushMode } from '../world/types';
import { SERVICE_TYPES } from '../services/types';
import { SERVICE_DEFINITIONS } from '../services/system';
import type { TransitLine } from '../transit/types';
import { TRANSIT_VEHICLE_TYPES } from '../transit/system';
import type { RoadStructureType } from '../roads/types';

interface AppProps {
  runtime: GameRuntime;
  simulation: SimulationClient;
}

interface Metrics {
  fps: number;
  frameTime: number;
  chunk: { x: number; z: number };
  terrainMeshMs: number;
  terrainFrameMs: number;
  visibleVehicles: number;
}

const formatClock = (seconds: number): string => {
  const day = Math.floor(seconds / 86_400) + 1;
  const time = seconds % 86_400;
  const hours = Math.floor(time / 3600).toString().padStart(2, '0');
  const minutes = Math.floor((time % 3600) / 60).toString().padStart(2, '0');
  return `DAY ${day} · ${hours}:${minutes}`;
};
const money = (amount: number): string => amount.toLocaleString();

const toolLabel = (status: ConstructionStatus): string => {
  if (status.tool === 'demolish') return 'DEMOLISH';
  if (status.tool === 'zone') return `${status.zoneBrush ? status.zoneBrush.toUpperCase() : 'ERASE'} ZONING`;
  if (status.tool === 'terrain') return `${(status.terrainMode ?? 'raise').toUpperCase()} TERRAIN`;
  if (status.tool === 'service') return SERVICE_DEFINITIONS[status.serviceType ?? 'electricity'].buildingName.toUpperCase();
  if (status.tool === 'bus-stop') return 'BUS STOP';
  switch (status.roadMode) {
    case 'straight': return 'STRAIGHT ROAD';
    case 'one-curve': return '1-CURVE ROAD';
    case 'two-curve': return '2-CURVE ROAD';
    case 'continuous': return 'CONTINUOUS CURVE';
  }
};

const ZONE_CONTROLS: ReadonlyArray<{ type: ZoneBrush; short: string; label: string }> = [
  { type: 'residential', short: 'R', label: 'Residential' },
  { type: 'commercial', short: 'C', label: 'Commercial' },
  { type: 'industrial', short: 'I', label: 'Industrial' },
  { type: 'office', short: 'O', label: 'Office' },
  { type: null, short: '×', label: 'Erase' },
];

const SNAP_CONTROLS: ReadonlyArray<{ key: SnapSettingKey; label: string; title: string }> = [
  { key: 'nodes', label: 'NODE', title: 'Snap to road nodes' },
  { key: 'segments', label: 'SEG', title: 'Snap to road segments' },
  { key: 'guidelines', label: 'GUIDE', title: 'Snap to loose endpoint extension guides' },
  { key: 'angles', label: '15°', title: '15 degree angle guide' },
  { key: 'parallel', label: '∥', title: 'Parallel road guide' },
  { key: 'perpendicular', label: '⊥', title: 'Perpendicular road guide' },
  { key: 'distance', label: '8m', title: '8 metre distance guide' },
];

export function App({ runtime, simulation }: AppProps) {
  const [snapshot, setSnapshot] = useState<WorldSnapshot | undefined>(simulation.latestSnapshot);
  const [construction, setConstruction] = useState<ConstructionStatus>();
  const [metrics, setMetrics] = useState<Metrics>({ fps: 0, frameTime: 0, chunk: { x: 2, z: 2 }, terrainMeshMs: 0, terrainFrameMs: 0, visibleVehicles: 0 });
  const [saveBytes, setSaveBytes] = useState(0);
  const [debugVisible, setDebugVisible] = useState(true);
  const [trafficOverlay, setTrafficOverlay] = useState(false);
  const [toast, setToast] = useState<{ message: string; error?: boolean }>();
  const [editingLineId, setEditingLineId] = useState<string>();
  const [lineName, setLineName] = useState('Bus Line 1');
  const [lineStopIds, setLineStopIds] = useState<string[]>([]);
  const [serviceStartHour, setServiceStartHour] = useState(0);
  const [serviceEndHour, setServiceEndHour] = useState(24);
  const [frequencyMinutes, setFrequencyMinutes] = useState(2);
  const [vehicleTypeId, setVehicleTypeId] = useState('standard');
  const [lineColor, setLineColor] = useState('#f2c75c');

  useEffect(() => simulation.subscribe(setSnapshot), [simulation]);
  useEffect(() => runtime.subscribeConstruction(setConstruction), [runtime]);
  useEffect(() => simulation.onNotification((message, level) => setToast({ message, error: level === 'error' })), [simulation]);
  useEffect(() => {
    const timer = window.setInterval(() => setMetrics({
      fps: runtime.renderer.getFps(),
      frameTime: runtime.renderer.getFrameTime(),
      chunk: runtime.renderer.getCurrentChunk(),
      terrainMeshMs: runtime.renderer.getTerrainMeshUpdateMs(),
      terrainFrameMs: runtime.renderer.getTerrainUpdateFrameMs(),
      visibleVehicles: runtime.renderer.getVisibleVehicleCount(),
    }), 350);
    return () => window.clearInterval(timer);
  }, [runtime]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(undefined), 2800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const clock = useMemo(() => formatClock(snapshot?.gameClock.gameSeconds ?? 0), [snapshot?.gameClock.gameSeconds]);
  const zoneCounts = useMemo(() => {
    const counts: Record<ZoneType, number> = { residential: 0, commercial: 0, industrial: 0, office: 0 };
    for (const cell of snapshot?.zoningCells ?? []) if (cell.zoneType && cell.terrainSuitable !== false) counts[cell.zoneType] += 1;
    return counts;
  }, [snapshot?.zoningRevision, snapshot?.terrainRevision]);

  const chooseRoadMode = (mode: RoadMode) => runtime.setRoadMode(mode);
  const save = async () => {
    try {
      const data = await simulation.requestSave();
      setSaveBytes(new Blob([JSON.stringify(data)]).size);
      await writeQuickSave(data);
      setToast({ message: 'City snapshot saved locally.' });
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : 'Save failed.', error: true });
    }
  };
  const load = async () => {
    try {
      const data = await readQuickSave();
      if (!data) return setToast({ message: 'No local save found.', error: true });
      runtime.cancelConstruction();
      simulation.load(data);
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : 'Load failed.', error: true });
    }
  };
  const setSpeed = (speed: GameSpeed) => simulation.setSpeed(speed);
  const editLine = (line: TransitLine) => {
    setEditingLineId(line.id); setLineName(line.name); setLineStopIds([...line.stopIds]);
    setServiceStartHour(line.serviceStartSeconds / 3600); setServiceEndHour(line.serviceEndSeconds / 3600);
    setFrequencyMinutes(line.frequencySeconds / 60); setVehicleTypeId(line.vehicleTypeId); setLineColor(line.color);
  };
  const clearLineEditor = () => {
    setEditingLineId(undefined); setLineName(`Bus Line ${(snapshot?.transit.lines.length ?? 0) + 1}`);
    setLineStopIds([]); setServiceStartHour(0); setServiceEndHour(24);
    setFrequencyMinutes(2); setVehicleTypeId('standard'); setLineColor('#f2c75c');
  };
  const saveLine = async () => {
    const input = { name: lineName, stopIds: lineStopIds, serviceStartSeconds: Math.round(serviceStartHour * 3600),
      serviceEndSeconds: Math.round(serviceEndHour * 3600), frequencySeconds: Math.round(frequencyMinutes * 60),
      vehicleTypeId, color: lineColor };
    const response = await simulation.execute(editingLineId
      ? { type: 'update-bus-line', lineId: editingLineId, input }
      : { type: 'create-bus-line', input });
    if (response.ok) { setToast({ message: editingLineId ? 'Bus line updated.' : 'Bus line created.' }); clearLineEditor(); }
  };

  return (
    <div class="hud-root" aria-label="Project Civitas controls">
      <header class="topbar panel">
        <div class="identity">
          <span class="identity-mark" aria-hidden="true">C</span>
          <div><strong>PROJECT CIVITAS</strong><small>WORLD INFRASTRUCTURE / PROTOTYPE</small></div>
        </div>
        <div class="clock-block">
          <span>{clock}</span>
          <div class="speed-controls" role="group" aria-label="Game speed">
            {([0, 1, 2, 4, 8] as GameSpeed[]).map((speed) => (
              <button class={snapshot?.gameClock.speed === speed ? 'active' : ''} onClick={() => setSpeed(speed)} title={speed === 0 ? 'Pause' : `Speed ×${speed}`}>
                {speed === 0 ? 'Ⅱ' : `×${speed}`}
              </button>
            ))}
          </div>
        </div>
        <div class="file-actions">
          <button onClick={save}>SAVE</button>
          <button onClick={load}>LOAD</button>
        </div>
      </header>

      {snapshot && <aside class="city-stats panel" aria-label="Population and RCIO demand">
        <div class="panel-title">CITY LIFE</div>
        <div class="city-totals">
          <div><strong>{snapshot.population.totals.population.toLocaleString()}</strong><span>POPULATION</span></div>
          <div><strong>{snapshot.population.totals.households.toLocaleString()}</strong><span>HOUSEHOLDS</span></div>
          <div><strong>{snapshot.population.totals.employed.toLocaleString()}</strong><span>EMPLOYED</span></div>
          <div><strong>{snapshot.population.totals.unemployed.toLocaleString()}</strong><span>UNEMPLOYED</span></div>
        </div>
        <div class="city-jobs">AVAILABLE JOBS <strong>{snapshot.population.totals.availableJobs.toLocaleString()}</strong></div>
        <div class="demand-list">
          {(['residential', 'commercial', 'industrial', 'office'] as ZoneType[]).map((zone) => {
            const value = snapshot.population.demand.values[zone];
            const factors = snapshot.population.demand.factors[zone];
            return <div class="demand-row" title={Object.entries(factors).map(([key, points]) => `${key}: ${points >= 0 ? '+' : ''}${points.toFixed(1)}`).join(' · ')}>
              <span>{zone.slice(0, 1).toUpperCase()}</span>
              <div class={`demand-track demand-${zone}`}><i style={{ width: `${value}%` }} /></div>
              <b>{value}</b>
            </div>;
          })}
        </div>
      </aside>}

      {snapshot && <aside class="economy-panel panel" aria-label="City economy">
        <div class="panel-title">CITY FINANCE</div>
        <div class="economy-funds"><span>CURRENT FUNDS</span><strong class={snapshot.economy.funds < 0 ? 'negative' : ''}>{money(snapshot.economy.funds)}</strong></div>
        <div class="economy-summary">
          <span>LAST INCOME <b>+{money(snapshot.economy.lastCycleIncome)}</b></span>
          <span>LAST EXPENSES <b>−{money(snapshot.economy.lastCycleExpenses)}</b></span>
          <span>LAST NET <b class={snapshot.economy.lastCycleNet < 0 ? 'negative' : ''}>{snapshot.economy.lastCycleNet >= 0 ? '+' : ''}{money(snapshot.economy.lastCycleNet)}</b></span>
        </div>
        <details class="economy-details">
          <summary>LAST CYCLE BREAKDOWN</summary>
          {(['residential', 'commercial', 'industrial', 'office'] as ZoneType[]).map((zone) =>
            <div><span>{zone.toUpperCase()} TAX</span><b>{money(snapshot.economy.lastCycleTaxes[zone])}</b></div>)}
          <div><span>ROAD MAINTENANCE</span><b>−{money(snapshot.economy.lastCycleRoadMaintenance)}</b></div>
          <div><span>SERVICE MAINTENANCE</span><b>−{money(snapshot.economy.lastCycleServiceMaintenance)}</b></div>
        </details>
      </aside>}

      {snapshot && <aside class="services-panel panel" aria-label="City services">
        <div class="panel-title">CITY SERVICES <span>{snapshot.services.facilities.length} FACILITIES</span></div>
        <div class="service-metrics">{SERVICE_TYPES.map((type) => {
          const metric = snapshot.services.coverage[type];
          return <div class="service-row" title={`${metric.supplied}/${metric.demand} demand, ${metric.capacity} capacity, ${metric.activeFacilities}/${metric.facilities} road-connected facilities`}>
            <span>{SERVICE_DEFINITIONS[type].label.toUpperCase()}</span><i><em style={{ width: `${metric.percent}%` }} /></i><b>{metric.percent}%</b>
          </div>;
        })}</div>
        <div class="service-maintenance">MAINTENANCE / CYCLE <b>−{money(snapshot.services.maintenancePerCycle)}</b></div>
        {construction?.tool === 'service' && snapshot.services.facilities.length > 0 && <details class="service-list"><summary>MANAGE FACILITIES</summary>
          {snapshot.services.facilities.map((facility) => <div><span>{SERVICE_DEFINITIONS[facility.type].buildingName} · {facility.id}</span><button title={`Remove ${facility.id}`} onClick={() => void simulation.execute({ type: 'remove-service', facilityId: facility.id })}>REMOVE</button></div>)}
        </details>}
      </aside>}

      {snapshot && <aside class="traffic-panel panel" aria-label="Road traffic">
        <div class="panel-title">ROAD TRAFFIC <button class={trafficOverlay ? 'active' : ''}
          aria-pressed={trafficOverlay} onClick={() => setTrafficOverlay(runtime.toggleTrafficOverlay())}>OVERLAY</button></div>
        <div class="traffic-metrics">
          <span>ACTIVE TRIPS <b>{snapshot.traffic.activeTrips}</b></span>
          <span>LOGICAL VEHICLES <b>{snapshot.traffic.logicalVehicles}</b></span>
          <span>VISIBLE VEHICLES <b>{metrics.visibleVehicles}</b></span>
          <span>AVERAGE SPEED <b>{snapshot.traffic.averageRoadSpeed.toFixed(1)} km/h</b></span>
          <span>CONGESTED ROADS <b>{snapshot.traffic.congestedSegmentCount}</b></span>
        </div>
      </aside>}

      {snapshot && <aside class="transit-panel panel" aria-label="Bus transit">
        <div class="panel-title">BUS TRANSIT <span>{snapshot.transit.lines.length} LINES</span></div>
        <div class="transit-totals">
          <span>STOPS <b>{snapshot.transit.stops.length}</b></span>
          <span>WAITING <b>{snapshot.transit.waitingPassengers}</b></span>
          <span>RIDERSHIP <b>{snapshot.transit.ridership}</b></span>
          <span>BUSES <b>{snapshot.transit.activeVehicles}</b></span>
        </div>
        {construction?.tool === 'bus-stop' && <div class="transit-editor">
          <div class="transit-section-title">STOPS · CLICK ROADSIDES TO ADD</div>
          <div class="transit-stop-list">{snapshot.transit.stops.map((stop) => <div class="transit-stop-row">
            <button title={`Add ${stop.name} to line`} onClick={() => setLineStopIds((current) => current.includes(stop.id) ? current : [...current, stop.id])}>+ {stop.name}</button>
            <small>{stop.direction === 'forward' ? '→' : '←'} · {snapshot.transit.stopMetrics.find((item) => item.stopId === stop.id)?.waiting ?? 0} WAIT</small>
            <button title={`Remove ${stop.name}`} onClick={() => void simulation.execute({ type: 'remove-bus-stop', stopId: stop.id })}>×</button>
          </div>)}</div>
          <div class="transit-section-title">{editingLineId ? `EDIT ${editingLineId}` : 'NEW LINE'}</div>
          <label>NAME <input aria-label="Bus line name" value={lineName} maxLength={80} onInput={(event) => setLineName(event.currentTarget.value)} /></label>
          <div class="transit-order">{lineStopIds.map((id, index) => <button title="Remove stop from line order" onClick={() => setLineStopIds((ids) => ids.filter((_, item) => item !== index))}>{index + 1}. {snapshot.transit.stops.find((stop) => stop.id === id)?.name ?? id} ×</button>)}</div>
          <div class="transit-fields">
            <label>START <input aria-label="Service start hour" type="number" min="0" max="23" step="1" value={serviceStartHour} onInput={(event) => setServiceStartHour(Number(event.currentTarget.value))} /></label>
            <label>END <input aria-label="Service end hour" type="number" min="1" max="24" step="1" value={serviceEndHour} onInput={(event) => setServiceEndHour(Number(event.currentTarget.value))} /></label>
            <label>EVERY MIN <input aria-label="Bus frequency minutes" type="number" min="0.5" max="120" step="0.5" value={frequencyMinutes} onInput={(event) => setFrequencyMinutes(Number(event.currentTarget.value))} /></label>
            <label>VEHICLE <select aria-label="Bus vehicle type" value={vehicleTypeId} onChange={(event) => setVehicleTypeId(event.currentTarget.value)}>{Object.values(TRANSIT_VEHICLE_TYPES).map((type) => <option value={type.id}>{type.name} · {type.capacity}</option>)}</select></label>
            <label>COLOR <input aria-label="Bus line color" type="color" value={lineColor} onInput={(event) => setLineColor(event.currentTarget.value)} /></label>
          </div>
          <div class="transit-actions"><button class="active" disabled={lineStopIds.length < 2} onClick={() => void saveLine()}>{editingLineId ? 'UPDATE LINE' : 'CREATE LINE'}</button><button onClick={clearLineEditor}>CLEAR</button></div>
          <div class="transit-section-title">LINES</div>
          {snapshot.transit.lines.map((line) => <div class="transit-line-row">
            <i style={{ background: line.color }} /><span>{line.name} · {line.stopIds.length} stops · {line.frequencySeconds / 60} min</span>
            <button title={`Edit ${line.name}`} onClick={() => editLine(line)}>EDIT</button>
            <button title={`Remove ${line.name}`} onClick={() => void simulation.execute({ type: 'remove-bus-line', lineId: line.id })}>×</button>
          </div>)}
        </div>}
      </aside>}

      {debugVisible && snapshot && (
        <aside class="debug-panel panel">
          <div class="panel-title"><span>LIVE SYSTEMS</span><i /></div>
          <dl>
            <dt>BUILD</dt><dd>v{GAME_VERSION}</dd>
            <dt>RENDERER</dt><dd class="accent">{runtime.renderer.rendererName}</dd>
            <dt>FPS</dt><dd>{metrics.fps.toFixed(0)}</dd>
            <dt>FRAME</dt><dd>{metrics.frameTime.toFixed(2)} ms</dd>
            <dt>SIM TICK</dt><dd>{snapshot.simulationTickMs.toFixed(3)} ms</dd>
            <dt>CLOCK</dt><dd>{snapshot.gameClock.gameSeconds}s</dd>
            <dt>SPEED</dt><dd>×{snapshot.gameClock.speed}</dd>
            <dt>CHUNK</dt><dd>{metrics.chunk.x}, {metrics.chunk.z}</dd>
            <dt>TERRAIN HEIGHT</dt><dd>{(construction?.terrainHeight ?? runtime.renderer.getHeight(0, 0)).toFixed(1)} m</dd>
            <dt>TERRAIN NORMAL</dt><dd>{(() => { const normal = construction?.terrainNormal ?? runtime.renderer.getNormal(0, 0); return `${normal.x.toFixed(2)}, ${normal.y.toFixed(2)}, ${normal.z.toFixed(2)}`; })()}</dd>
            <dt>WATER LEVEL</dt><dd>{snapshot.water.seaLevel.toFixed(1)} m</dd>
            <dt>EDIT / MESH</dt><dd>{snapshot.terrainEditMs.toFixed(2)} / {metrics.terrainMeshMs.toFixed(2)} ms</dd>
            <dt>TERRAIN FRAME</dt><dd>{metrics.terrainFrameMs.toFixed(2)} ms</dd>
            <dt>PATCH / SAVE</dt><dd>{((snapshot.terrainMessageBytes ?? 0) / 1024).toFixed(1)} / {(saveBytes / 1024).toFixed(1)} KiB</dd>
          </dl>
          <div class="debug-rule" />
          <dl>
            <dt>ROAD NODES</dt><dd>{snapshot.roadGraph.nodes.length}</dd>
            <dt>SEGMENTS</dt><dd>{snapshot.roadGraph.segments.length}</dd>
            <dt>G / E / B / T</dt><dd>{(['ground', 'elevated', 'bridge', 'tunnel'] as RoadStructureType[])
              .map((type) => snapshot.roadGraph.segments.filter((segment) => (segment.structureType ?? 'ground') === type).length).join(' / ')}</dd>
            <dt>LANES</dt><dd>{snapshot.roadGraph.lanes.length}</dd>
            <dt>ZONE CELLS</dt><dd>{snapshot.zoningCells.filter((cell) => cell.terrainSuitable !== false).length} / {snapshot.zoningCells.length}</dd>
            <dt>R / C / I / O</dt><dd>{zoneCounts.residential} / {zoneCounts.commercial} / {zoneCounts.industrial} / {zoneCounts.office}</dd>
            <dt>ZONE CHUNKS</dt><dd>{snapshot.zoningUpdatedChunkIds?.length ?? 0}</dd>
            <dt>LOTS / BUILDINGS</dt><dd>{snapshot.lots.length} / {snapshot.buildings.length}</dd>
            <dt>POP / HOUSEHOLDS</dt><dd>{snapshot.population.totals.population} / {snapshot.population.totals.households}</dd>
            <dt>EMPLOYED / UNEMP.</dt><dd>{snapshot.population.totals.employed} / {snapshot.population.totals.unemployed}</dd>
            <dt>JOBS OPEN</dt><dd>{snapshot.population.totals.availableJobs}</dd>
            <dt>FUNDS / NET</dt><dd>{money(snapshot.economy.funds)} / {money(snapshot.economy.lastCycleNet)}</dd>
            <dt>INCOME / EXPENSE</dt><dd>{money(snapshot.economy.totalIncome)} / {money(snapshot.economy.totalExpenses)}</dd>
            <dt>TRIPS / VEHICLES</dt><dd>{snapshot.traffic.activeTrips} / {snapshot.traffic.logicalVehicles}</dd>
            <dt>VISIBLE / LIMIT</dt><dd>{metrics.visibleVehicles} / {snapshot.traffic.maxVisibleVehicles}</dd>
            <dt>AVG SPEED / JAM</dt><dd>{snapshot.traffic.averageRoadSpeed.toFixed(1)} km/h / {snapshot.traffic.congestedSegmentCount}</dd>
            <dt>OUTSIDE LINKS</dt><dd>{snapshot.traffic.outsideConnections.length}</dd>
            <dt>ECONOMY CYCLE</dt><dd>{snapshot.economy.lastEconomyTickGameSeconds} → {snapshot.economy.nextCycleAtGameSeconds}s</dd>
            <dt>SERVICE COST</dt><dd>{money(snapshot.services.maintenancePerCycle)} / cycle</dd>
            <dt>SERVICE LOTS / BUILDINGS</dt><dd>{snapshot.services.facilities.length} / {snapshot.services.facilities.length}</dd>
            <dt>BUS STOPS / LINES</dt><dd>{snapshot.transit.stops.length} / {snapshot.transit.lines.length}</dd>
            <dt>BUS RIDERS / WAITING</dt><dd>{snapshot.transit.ridership} / {snapshot.transit.waitingPassengers}</dd>
            <dt>ACTIVE BUSES / ROUTE CACHE</dt><dd>{snapshot.transit.activeVehicles} / {snapshot.transit.routeCacheSize}</dd>
            {SERVICE_TYPES.map((type) => <>
              <dt>{type.toUpperCase()}</dt><dd>{snapshot.services.coverage[type].supplied} / {snapshot.services.coverage[type].demand} demand · {snapshot.services.coverage[type].capacity} capacity</dd>
            </>)}
            {snapshot.economy.transactions.slice(-5).reverse().map((transaction) => <>
              <dt title={`${transaction.kind} at ${transaction.gameSeconds}s`}>{transaction.kind.replaceAll('_', ' ')}</dt>
              <dd>{transaction.amount >= 0 ? '+' : ''}{money(transaction.amount)}</dd>
            </>)}
            {(['residential', 'commercial', 'industrial', 'office'] as ZoneType[]).map((zone) => <>
              <dt>{zone.slice(0, 1).toUpperCase()} DEMAND</dt><dd title={Object.entries(snapshot.population.demand.factors[zone]).map(([key, points]) => `${key} ${points.toFixed(1)}`).join(', ')}>{snapshot.population.demand.values[zone]} / 100</dd>
            </>)}
            <dt>LOT CELLS RECHECKED</dt><dd>{snapshot.lotReevaluatedCells}</dd>
            {(() => {
              const lot = snapshot.lots.find((candidate) => candidate.id === construction?.hoveredLotId);
              const building = snapshot.buildings.find((candidate) => candidate.id === lot?.buildingId);
              const occupancy = snapshot.population.occupancies.find((candidate) => candidate.buildingId === building?.id);
              return lot ? <>
                <dt>LOT ID</dt><dd title={lot.id}>{lot.id.slice(0, 22)}…</dd>
                <dt>LOT SIZE / ACCESS</dt><dd>{lot.widthCells}×{lot.depthCells} / {lot.roadAccess.roadSegmentId}</dd>
                <dt>SLOPE / BASE</dt><dd>{(lot.slope * 100).toFixed(0)}% / {lot.baseElevation.toFixed(1)} m</dd>
                <dt>BUILDING ID / STATE</dt><dd title={building?.id}>{building ? `${building.id.slice(0, 18)}… / ${building.state}` : 'Unbuildable'}</dd>
                {occupancy && <>
                  <dt>BUILDING POP</dt><dd>{occupancy.currentPopulation} / {occupancy.populationCapacity}</dd>
                  <dt>HOUSEHOLDS</dt><dd>{occupancy.currentHouseholds} / {occupancy.householdCapacity}</dd>
                  <dt>JOBS FILLED / OPEN</dt><dd>{occupancy.filledJobs} / {occupancy.availableJobs}</dd>
                  <dt>JOB CAPACITY</dt><dd>{occupancy.totalJobs}</dd>
                </>}
              </> : null;
            })()}
            <dt>PREVIEW SCAN</dt><dd>{construction?.candidateSegments ?? 0} / {(construction?.analysisMs ?? 0).toFixed(2)} ms</dd>
          </dl>
        </aside>
      )}

      <div class={`construction-readout panel ${construction?.valid ? 'is-valid' : ''} ${construction?.tool === 'service' ? 'service-mode' : ''}`}>
        <div class="mode-tag">{construction ? toolLabel(construction) : 'CONNECTING'}</div>
        <strong>{construction?.prompt ?? 'Starting simulation worker…'}</strong>
        {construction?.tool === 'road' && construction.length > 0 && (
          <div class="readout-data">
            <span>{construction.length.toFixed(1)} m</span>
            <span>{(construction.structureType ?? 'ground').toUpperCase()}</span>
            {(construction.structureType ?? 'ground') !== 'ground' && <span>TARGET {construction.targetElevation} m</span>}
            <span>GRADE {((construction.grade ?? 0) * 100).toFixed(1)}%</span>
            {(construction.structureType ?? 'ground') !== 'ground' && <span>CLEARANCE {(construction.clearance ?? 0).toFixed(1)} m</span>}
            {construction.estimatedCost !== undefined && <span>COST {money(construction.estimatedCost)}</span>}
            {construction.fundsAfterConstruction !== undefined && <span>AFTER {money(construction.fundsAfterConstruction)}</span>}
            {construction.roadMode !== 'straight' && construction.curveRadius > 0 && (
              <span>R MIN {construction.curveRadius.toFixed(1)} m</span>
            )}
            {construction.step && construction.totalSteps && <span>STEP {construction.step}/{construction.totalSteps}</span>}
            <span>SNAP {construction.snap.toUpperCase()}</span>
            <span>{construction.plannedIntersections} JUNCTION{construction.plannedIntersections === 1 ? '' : 'S'}</span>
          </div>
        )}
        {construction?.tool === 'zone' && (
          <div class="readout-data">
            <span>{construction.zoneMode === 'box' ? 'BOX' : 'BRUSH'} {construction.zoneBrush?.toUpperCase() ?? 'ERASE'}</span>
            <span>{construction.selectedZoneCells ?? 0} SELECTED</span>
            {construction.hoveredZoneType && <span>EXISTING {construction.hoveredZoneType.toUpperCase()}</span>}
          </div>
        )}
        {construction?.tool === 'terrain' && (
          <div class="readout-data"><span>{construction.terrainSize} m BRUSH</span><span>{construction.terrainStrength} m/s</span><span>Y {(construction.terrainHeight ?? 0).toFixed(1)} m</span></div>
        )}
      </div>

      <nav class="tool-dock panel" aria-label="Construction tools">
        <div class="tool-group">
          <button class={construction?.tool === 'road' ? 'tool active' : 'tool'} onClick={() => runtime.setTool('road')}>
            <span class="tool-icon road-icon" /><small>ROAD</small>
          </button>
          <button class={construction?.tool === 'demolish' ? 'tool active danger' : 'tool'} onClick={() => runtime.setTool('demolish')}>
            <span class="tool-icon demolish-icon">×</span><small>REMOVE</small>
          </button>
          <button class={construction?.tool === 'zone' ? 'tool active' : 'tool'} onClick={() => runtime.setZoneBrush(construction?.zoneBrush ?? 'residential')}>
            <span class="tool-icon zoning-icon">▦</span><small>ZONING</small>
          </button>
          <button class={construction?.tool === 'terrain' ? 'tool active' : 'tool'} onClick={() => runtime.setTool('terrain')}>
            <span class="tool-icon terrain-icon">⌁</span><small>TERRAIN</small>
          </button>
          <button class={construction?.tool === 'service' ? 'tool active' : 'tool'} onClick={() => runtime.setTool('service')}>
            <span class="tool-icon service-icon">✚</span><small>SERVICES</small>
          </button>
          <button class={construction?.tool === 'bus-stop' ? 'tool active' : 'tool'} onClick={() => runtime.setTool('bus-stop')}>
            <span class="tool-icon bus-icon">▣</span><small>BUS</small>
          </button>
        </div>
        <div class="dock-divider" />
        <div class="mode-group">
          <button class={construction?.roadMode === 'straight' && construction.tool === 'road' ? 'active' : ''} onClick={() => chooseRoadMode('straight')}>STRAIGHT</button>
          <button class={construction?.roadMode === 'one-curve' && construction.tool === 'road' ? 'active' : ''} onClick={() => chooseRoadMode('one-curve')}>1-CURVE</button>
          <button class={construction?.roadMode === 'two-curve' && construction.tool === 'road' ? 'active' : ''} onClick={() => chooseRoadMode('two-curve')}>2-CURVE</button>
          <button class={construction?.roadMode === 'continuous' && construction.tool === 'road' ? 'active' : ''} onClick={() => chooseRoadMode('continuous')}>CONTINUOUS</button>
        </div>
        <div class="dock-divider" />
        <div class="history-group">
          <button onClick={() => runtime.undo()} title="Undo (Ctrl+Z)">↶</button>
          <button onClick={() => runtime.redo()} title="Redo (Ctrl+Y)">↷</button>
          <button class={debugVisible ? 'active' : ''} onClick={() => { setDebugVisible(runtime.toggleDebug()); }}>DEBUG</button>
        </div>
      </nav>

      {construction?.tool === 'road' && (
        <div class="elevation-palette panel" role="group" aria-label="Road elevation mode">
          <span>ELEVATION</span>
          {(['ground', 'elevated', 'bridge', 'tunnel'] as RoadStructureType[]).map((type) =>
            <button class={construction.structureType === type ? 'active' : ''} aria-pressed={construction.structureType === type}
              onClick={() => runtime.setRoadStructure(type)}>{type.toUpperCase()}</button>)}
          {construction.structureType !== 'ground' && <label>OFFSET <input type="number" aria-label="Target elevation offset"
            min="6" max="80" step="1" value={construction.targetElevation ?? 8}
            onChange={(event) => runtime.setRoadTargetElevation(Number(event.currentTarget.value))} />m</label>}
        </div>
      )}

      {construction?.tool === 'road' && (
        <div class="snap-palette panel" role="group" aria-label="Road snapping options">
          <span>SNAP</span>
          {SNAP_CONTROLS.map((control) => (
            <button
              class={construction.snapSettings[control.key] ? 'active' : ''}
              title={control.title}
              aria-pressed={construction.snapSettings[control.key]}
              onClick={() => runtime.toggleSnap(control.key)}
            >{control.label}</button>
          ))}
        </div>
      )}

      {construction?.tool === 'zone' && (
        <div class="zone-palette panel" role="group" aria-label="RCIO zoning brushes">
          <span>RCIO</span>
          {ZONE_CONTROLS.map((control) => (
            <button
              class={`zone-choice zone-${control.type ?? 'erase'} ${construction.zoneBrush === control.type ? 'active' : ''}`}
              title={`${control.label} zoning`}
              aria-pressed={construction.zoneBrush === control.type}
              onClick={() => runtime.setZoneBrush(control.type)}
            ><b>{control.short}</b><small>{control.label}</small></button>
          ))}
          <div class="zone-mode-divider" />
          <button class={construction.zoneMode === 'brush' ? 'zone-mode active' : 'zone-mode'} aria-pressed={construction.zoneMode === 'brush'} title="Paint cells along the drag path" onClick={() => runtime.setZoneMode('brush')}>BRUSH</button>
          <button class={construction.zoneMode === 'box' ? 'zone-mode active' : 'zone-mode'} aria-pressed={construction.zoneMode === 'box'} title="Select cells inside a dragged rectangle" onClick={() => runtime.setZoneMode('box')}>BOX</button>
        </div>
      )}

      {construction?.tool === 'terrain' && (
        <div class="terrain-palette panel" role="group" aria-label="Terrain editing tools">
          {(['raise', 'lower', 'flatten', 'smooth'] as TerrainBrushMode[]).map((mode) => (
            <button class={construction.terrainMode === mode ? 'active' : ''} onClick={() => runtime.setTerrainMode(mode)}>{mode.toUpperCase()}</button>
          ))}
          <label>SIZE <input aria-label="Brush size" type="range" min="8" max="160" step="4" value={construction.terrainSize ?? 48}
            onInput={(event) => runtime.setTerrainBrush(Number(event.currentTarget.value), construction.terrainStrength ?? 12)} />{construction.terrainSize ?? 48} m</label>
          <label>STRENGTH <input aria-label="Brush strength" type="range" min="1" max="40" step="1" value={construction.terrainStrength ?? 12}
            onInput={(event) => runtime.setTerrainBrush(construction.terrainSize ?? 48, Number(event.currentTarget.value))} />{construction.terrainStrength ?? 12}</label>
          <button onClick={() => runtime.setTerrainPreset('flat')}>FLAT</button>
          <button onClick={() => runtime.setTerrainPreset('hills')}>HILLS</button>
          <label>SEA LEVEL <input aria-label="Sea level" type="number" min="-80" max="240" step="1"
            value={snapshot?.water.seaLevel ?? -12}
            onChange={(event) => { void simulation.execute({ type: 'set-water-level', seaLevel: Number(event.currentTarget.value) }); }} />m</label>
        </div>
      )}

      {construction?.tool === 'service' && <div class="service-palette panel" role="group" aria-label="City service facilities">
        {SERVICE_TYPES.map((type) => <button class={construction.serviceType === type ? 'active' : ''}
          aria-pressed={construction.serviceType === type} title={`${SERVICE_DEFINITIONS[type].buildingName}: ${money(SERVICE_DEFINITIONS[type].constructionCost)} construction, ${money(SERVICE_DEFINITIONS[type].maintenancePerCycle)} per cycle`}
          onClick={() => runtime.setServiceType(type)}>{SERVICE_DEFINITIONS[type].buildingName.toUpperCase()}</button>)}
      </div>}

      {construction?.tool === 'zone' && construction.zoneSelectionRect && (
        <div class="zone-selection-rect" style={{
          left: construction.zoneSelectionRect.left,
          top: construction.zoneSelectionRect.top,
          width: construction.zoneSelectionRect.right - construction.zoneSelectionRect.left,
          height: construction.zoneSelectionRect.bottom - construction.zoneSelectionRect.top,
        }} />
      )}

      <div class="control-hint panel">
        <span><kbd>WASD</kbd> MOVE</span><span><kbd>MMB</kbd> ORBIT</span><span><kbd>WHEEL</kbd> ZOOM</span><span><kbd>SHIFT</kbd> FAST</span><span><kbd>RMB</kbd> {construction?.tool === 'terrain' ? 'EXIT TERRAIN' : 'BACK'}</span><span><kbd>ESC</kbd> CANCEL</span>
      </div>
      {toast && <div class={`toast ${toast.error ? 'error' : ''}`}>{toast.message}</div>}
    </div>
  );
}
