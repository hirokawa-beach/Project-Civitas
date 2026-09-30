import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { GameRuntime } from './app/gameRuntime';
import { SimulationClient } from './app/simulationClient';
import { App } from './ui/App';
import { NewGame } from './ui/NewGame';
import type { GeneratedMap } from './terrain/generator';
import { readQuickSave } from './save/saveStore';
import './ui/styles.css';

const simulation = new SimulationClient(new Worker(new URL('./worker/simulation.worker.ts', import.meta.url), { type: 'module' }));

function Bootstrap() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [runtime, setRuntime] = useState<GameRuntime>();
  const [failure, setFailure] = useState<string>();
  const [startup, setStartup] = useState<{ kind: 'new'; map: GeneratedMap } | { kind: 'load' }>();

  const loadExisting = async () => {
    const save = await readQuickSave();
    if (!save) throw new Error('No local save found. Create a new city to get started.');
    await simulation.load(save);
    setStartup({ kind: 'load' });
  };

  useEffect(() => {
    if (!canvasRef.current || !startup) return;
    let active = true;
    GameRuntime.create(canvasRef.current, simulation)
      .then((created) => {
        if (!active) { created.construction.dispose(); created.renderer.dispose(); return; }
        setRuntime(created);
        if (startup.kind === 'new') simulation.initialize(startup.map);
      })
      .catch((error: unknown) => setFailure(error instanceof Error ? error.message : String(error)));
    return () => { active = false; };
  }, [startup]);

  return (
    <main class="game-shell">
      <canvas ref={canvasRef} id="game-canvas" aria-label="Project Civitas 3D city view" />
      {!startup && <NewGame onStart={(map) => setStartup({ kind: 'new', map })} onLoad={loadExisting} />}
      {startup && !runtime && !failure && <div class="boot-screen"><span class="boot-mark">C</span><p>INITIALIZING CIVITAS</p><div class="boot-line" /></div>}
      {failure && <div class="boot-screen error"><p>RENDERER STARTUP FAILED</p><pre>{failure}</pre></div>}
      {runtime && <App runtime={runtime} simulation={simulation} />}
    </main>
  );
}

render(<Bootstrap />, document.getElementById('app')!);
