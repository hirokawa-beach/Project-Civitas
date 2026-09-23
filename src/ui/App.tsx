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
}

const formatClock = (seconds: number): string => {
  const day = Math.floor(seconds / 86_400) + 1;
  const time = seconds % 86_400;
  const hours = Math.floor(time / 3600).toString().padStart(2, '0');
  const minutes = Math.floor((time % 3600) / 60).toString().padStart(2, '0');
  return `DAY ${day} · ${hours}:${minutes}`;
};

const toolLabel = (status: ConstructionStatus): string => {
  if (status.tool === 'demolish') return 'DEMOLISH';
  if (status.tool === 'zone') return `${status.zoneBrush ? status.zoneBrush.toUpperCase() : 'ERASE'} ZONING`;
  if (status.tool === 'terrain') return `${(status.terrainMode ?? 'raise').toUpperCase()} TERRAIN`;
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
  const [metrics, setMetrics] = useState<Metrics>({ fps: 0, frameTime: 0, chunk: { x: 2, z: 2 }, terrainMeshMs: 0, terrainFrameMs: 0 });
  const [saveBytes, setSaveBytes] = useState(0);
  const [debugVisible, setDebugVisible] = useState(true);
  const [toast, setToast] = useState<{ message: string; error?: boolean }>();

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

  return (
    <div class="hud-root" aria-label="Project Civitas controls">
      <header class="topbar panel">
        <div class="identity">
          <span class="identity-mark" aria-hidden="true">C</span>
          <div><strong>PROJECT CIVITAS</strong><small>POPULATION + DEMAND / PROTOTYPE</small></div>
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
            <dt>EDIT / MESH</dt><dd>{snapshot.terrainEditMs.toFixed(2)} / {metrics.terrainMeshMs.toFixed(2)} ms</dd>
            <dt>TERRAIN FRAME</dt><dd>{metrics.terrainFrameMs.toFixed(2)} ms</dd>
            <dt>PATCH / SAVE</dt><dd>{((snapshot.terrainMessageBytes ?? 0) / 1024).toFixed(1)} / {(saveBytes / 1024).toFixed(1)} KiB</dd>
          </dl>
          <div class="debug-rule" />
          <dl>
            <dt>ROAD NODES</dt><dd>{snapshot.roadGraph.nodes.length}</dd>
            <dt>SEGMENTS</dt><dd>{snapshot.roadGraph.segments.length}</dd>
            <dt>LANES</dt><dd>{snapshot.roadGraph.lanes.length}</dd>
            <dt>ZONE CELLS</dt><dd>{snapshot.zoningCells.filter((cell) => cell.terrainSuitable !== false).length} / {snapshot.zoningCells.length}</dd>
            <dt>R / C / I / O</dt><dd>{zoneCounts.residential} / {zoneCounts.commercial} / {zoneCounts.industrial} / {zoneCounts.office}</dd>
            <dt>ZONE CHUNKS</dt><dd>{snapshot.zoningUpdatedChunkIds?.length ?? 0}</dd>
            <dt>LOTS / BUILDINGS</dt><dd>{snapshot.lots.length} / {snapshot.buildings.length}</dd>
            <dt>POP / HOUSEHOLDS</dt><dd>{snapshot.population.totals.population} / {snapshot.population.totals.households}</dd>
            <dt>EMPLOYED / UNEMP.</dt><dd>{snapshot.population.totals.employed} / {snapshot.population.totals.unemployed}</dd>
            <dt>JOBS OPEN</dt><dd>{snapshot.population.totals.availableJobs}</dd>
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

      <div class={`construction-readout panel ${construction?.valid ? 'is-valid' : ''}`}>
        <div class="mode-tag">{construction ? toolLabel(construction) : 'CONNECTING'}</div>
        <strong>{construction?.prompt ?? 'Starting simulation worker…'}</strong>
        {construction?.tool === 'road' && construction.length > 0 && (
          <div class="readout-data">
            <span>{construction.length.toFixed(1)} m</span>
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
        </div>
      )}

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
