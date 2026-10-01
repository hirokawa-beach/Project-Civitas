import { MapEditor } from './ui/MapEditor';
import { mapAssetFromGenerated, type MapAsset } from './maps/mapAsset';
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
  const [showLibrary, setShowLibrary] = useState(false);
  const [runtime, setRuntime] = useState<GameRuntime>();
  const [failure, setFailure] = useState<string>();
  const [startup, setStartup] = useState<{ kind: 'map'; asset: MapAsset; editor: boolean } | { kind: 'load' }>();

  const loadExisting = async () => {
    const save = await readQuickSave();
    if (!save) throw new Error('No local save found. Create a new city to get started.');
    await simulation.load(save);
    setStartup({ kind: 'load' });
  };

  useEffect(() => {
    if (!canvasRef.current || !startup) return;
    let active = true; let current: GameRuntime | undefined; setRuntime(undefined); setFailure(undefined);
    GameRuntime.create(canvasRef.current, simulation)
      .then((created) => {
        if (!active) { created.dispose(); return; }
        current = created; setRuntime(created);
        if (startup.kind === 'map') void simulation.mapOperation({ kind: 'load', asset: startup.asset, editor: startup.editor }).catch(error => setFailure(String(error)));
      })
      .catch((error: unknown) => setFailure(error instanceof Error ? error.message : String(error)));
    return () => { active = false; current?.dispose(); };
  }, [startup]);

  return (
    <main class="game-shell">
      <canvas ref={canvasRef} id="game-canvas" aria-label="Project Civitas 3D city view" />
      {!startup && <NewGame initialTab={showLibrary ? 'library' : 'generator'} onStart={(map) => setStartup({ kind: 'map', asset: mapAssetFromGenerated(map, { id: crypto.randomUUID(), name: 'Generated city world', description: '', author: 'Local creator' }), editor: false })} onLoad={loadExisting} onAssetStart={asset => setStartup({ kind: 'map', asset, editor: false })} onEdit={asset => setStartup({ kind: 'map', asset, editor: true })} />}
      {startup && !runtime && !failure && <div class="boot-screen"><span class="boot-mark">C</span><p>INITIALIZING CIVITAS</p><div class="boot-line" /></div>}
      {failure && <div class="boot-screen error"><p>RENDERER STARTUP FAILED</p><pre>{failure}</pre></div>}
      {startup && runtime && (startup.kind === 'map' && startup.editor ? <MapEditor runtime={runtime} simulation={simulation} asset={startup.asset} onBack={() => { setShowLibrary(true); setRuntime(undefined); setStartup(undefined); }} /> : <App runtime={runtime} simulation={simulation} />)}
    </main>
  );
}

render(<Bootstrap />, document.getElementById('app')!);
