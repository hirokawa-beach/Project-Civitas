import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { GameRuntime } from './app/gameRuntime';
import { SimulationClient } from './app/simulationClient';
import { App } from './ui/App';
import './ui/styles.css';

const simulation = new SimulationClient(new Worker(new URL('./worker/simulation.worker.ts', import.meta.url), { type: 'module' }));

function Bootstrap() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [runtime, setRuntime] = useState<GameRuntime>();
  const [failure, setFailure] = useState<string>();

  useEffect(() => {
    if (!canvasRef.current) return;
    let active = true;
    GameRuntime.create(canvasRef.current, simulation)
      .then((created) => {
        if (!active) return;
        setRuntime(created);
        simulation.initialize();
      })
      .catch((error: unknown) => setFailure(error instanceof Error ? error.message : String(error)));
    return () => { active = false; };
  }, []);

  return (
    <main class="game-shell">
      <canvas ref={canvasRef} id="game-canvas" aria-label="Project Civitas 3D city view" />
      {!runtime && !failure && <div class="boot-screen"><span class="boot-mark">C</span><p>INITIALIZING CIVITAS</p><div class="boot-line" /></div>}
      {failure && <div class="boot-screen error"><p>RENDERER STARTUP FAILED</p><pre>{failure}</pre></div>}
      {runtime && <App runtime={runtime} simulation={simulation} />}
    </main>
  );
}

render(<Bootstrap />, document.getElementById('app')!);
