import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { GameRenderer } from '../renderer/gameRenderer';
import type { WorldSnapshot } from '../shared/protocol';
import type { GameSpeed } from '../simulation/gameClock';
import { SCENARIOS, BENCHMARK_SEED, type ScenarioId } from './scenarios';
import { downloadReport } from './download';
import type { TimingSummary } from './metrics';
import { pedestrianPose } from '../citizens/routing';

const worker = new Worker(new URL('./benchmark.worker.ts', import.meta.url), { type: 'module' });
function Benchmark() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<GameRenderer>();
  const latest = useRef<{ snapshot: WorldSnapshot; performance: Record<string, TimingSummary>; messageBytes: number }>();
  const [scenario, setScenario] = useState<ScenarioId>('camera-6000');
  const [backend, setBackend] = useState('');
  const [report, setReport] = useState<Record<string, unknown>>();
  const [status, setStatus] = useState('Loading benchmark');
  const [results, setResults] = useState<Record<string, unknown>[]>([]);
  const running = useRef(false);
  const scenarioRef = useRef<ScenarioId>(scenario);
  useEffect(() => {
    let active = true;
    GameRenderer.create(canvas.current!).then((view) => {
      if (!active) { view.dispose(); return; }
      renderer.current = view; view.setDebugVisible(false); setBackend(view.rendererName);
      worker.onmessage = (event) => { latest.current = event.data; view.updateSnapshot(event.data.snapshot); };
      worker.postMessage({ type: 'scenario', id: scenarioRef.current }); setStatus('Ready');
    }).catch((error) => setStatus(String(error)));
    const interval = setInterval(() => {
      const view = renderer.current; const snapshot = latest.current?.snapshot;
      if (!view || !snapshot) return;
      worker.postMessage({ type: 'camera', ...view.getAgentView() });
      const metrics = view.getPerformanceMetrics(); const agents = view.getVisualAgentMetrics();
      const citizen = snapshot.traffic.citizenCandidates?.[0];
      setReport({ scenario: scenarioRef.current, seed: BENCHMARK_SEED, renderer: view.rendererName,
        gameSeconds: snapshot.gameClock.gameSeconds, gameSpeed: snapshot.gameClock.speed,
        sampleCitizen: citizen && { id: citizen.id, name: citizen.name, state: citizen.state,
          position: citizen.stationaryPosition ?? pedestrianPose(citizen.route, citizen.length, citizen.speed,
            citizen.departedAt, snapshot.gameClock.gameSeconds).position },
        environment: { userAgent: navigator.userAgent, viewport: [innerWidth, innerHeight], devicePixelRatio },
        fps: view.getFps(), frameMs: view.getFrameTime(), individualCitizens: snapshot.traffic.individualCitizens,
        activeJourneys: snapshot.traffic.activeCitizenJourneys, cameraCitizens: snapshot.traffic.cameraCitizenCount,
        renderedCitizens: agents.visibleCitizens, logicalVehicles: snapshot.traffic.logicalVehicles, renderedVehicles: agents.visibleVehicles,
        lod: { near: agents.near, mid: agents.mid, far: agents.far }, workerTimings: latest.current?.performance,
        messageBytes: latest.current?.messageBytes, rendererMetrics: metrics,
        heapBytes: (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null });
    }, 500);
    return () => { active = false; clearInterval(interval); renderer.current?.dispose(); worker.terminate(); };
  }, []);
  const select = (id: ScenarioId) => { scenarioRef.current = id; setScenario(id); latest.current = undefined; renderer.current?.performance.clear(); worker.postMessage({ type: 'scenario', id }); };
  const collect = async () => {
    if (running.current) return; running.current = true;
    const collected: Record<string, unknown>[] = [];
    for (const id of SCENARIOS) {
      select(id); setStatus(`Warming up ${id}`);
      await new Promise((resolve) => setTimeout(resolve, 3500));
      renderer.current?.performance.clear(); setStatus(`Measuring ${id}`);
      await new Promise((resolve) => setTimeout(resolve, 4000));
      // Read the report from the current DOM-visible UI through the same sampler callback.
      const view = renderer.current!; const data = latest.current!;
      const agents = view.getVisualAgentMetrics();
      collected.push({ id, seed: BENCHMARK_SEED, environment: { userAgent: navigator.userAgent, viewport: [innerWidth, innerHeight], devicePixelRatio },
        fps: view.getFps(), frameMs: view.getFrameTime(),
        renderedCitizens: agents.visibleCitizens, cameraCitizens: data.snapshot.traffic.cameraCitizenCount,
        individualCitizens: data.snapshot.traffic.individualCitizens, activeJourneys: data.snapshot.traffic.activeCitizenJourneys,
        lod: { near: agents.near, mid: agents.mid, far: agents.far }, renderer: view.rendererName,
        timings: view.getPerformanceMetrics(), workerTimings: data.performance, messageBytes: data.messageBytes,
        heapBytes: (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null });
      setResults([...collected]);
    }
    setStatus('Benchmark complete'); running.current = false;
  };
  return <main style="height:100vh;background:#101a18;color:#e9eee8;font:12px monospace">
    <canvas ref={canvas} aria-label="Benchmark city" style="width:100%;height:100%;display:block" />
    <section style="position:absolute;left:12px;top:12px;max-height:95vh;overflow:auto;background:#101a18ee;padding:16px;width:370px">
      <h1>Performance & Crowd Benchmark</h1><p>{status} · {backend}</p>
      <label>Scenario <select aria-label="Benchmark scenario" value={scenario} onChange={(e) => select(e.currentTarget.value as ScenarioId)}>{SCENARIOS.map((id) => <option>{id}</option>)}</select></label>
      <p><a href="?renderer=webgl2">WebGL2</a> · <a href="?renderer=webgpu">WebGPU (fallback shown in HUD)</a></p>
      <p>{([0, 1, 2, 4, 8] as GameSpeed[]).map((speed) => <button onClick={() => worker.postMessage({ type: 'speed', speed })}>{speed ? `×${speed}` : 'Pause'}</button>)}</p>
      <button onClick={collect}>RUN ALL SCENARIOS</button>
      <button onClick={() => downloadReport({ schemaVersion: 1, environment: { userAgent: navigator.userAgent, viewport: [innerWidth, innerHeight], devicePixelRatio }, results, current: report }, 'civitas-browser-benchmark.json')}>EXPORT JSON</button>
      <pre aria-label="Live benchmark metrics" style="white-space:pre-wrap">{JSON.stringify(report, null, 2)}</pre>
      <details><summary>Collected results ({results.length})</summary><pre aria-label="Benchmark results">{JSON.stringify(results)}</pre></details>
    </section>
    <aside style="position:absolute;right:12px;bottom:12px;background:#101a18;padding:12px">WASD move · middle mouse orbit · wheel zoom. Isolated fixtures; no city save changes.</aside>
  </main>;
}
render(<Benchmark />, document.getElementById('benchmark')!);
