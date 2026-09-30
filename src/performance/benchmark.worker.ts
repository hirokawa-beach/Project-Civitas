import { BenchmarkScenario, type ScenarioId } from './scenarios';
import { payloadBytes } from './metrics';
import type { GameSpeed } from '../simulation/gameClock';
import type { Vec2 } from '../world/types';
let scenario: BenchmarkScenario | undefined;
let lastTime = performance.now();
let full = true;
let worldEpoch = 0;
self.onmessage = (event: MessageEvent<{ type: 'scenario'; id: ScenarioId } | { type: 'speed'; speed: GameSpeed }
  | { type: 'camera'; position: Vec2; radius: number; cap: number }>) => {
  const message = event.data;
  if (message.type === 'scenario') { scenario = new BenchmarkScenario(message.id); full = true; worldEpoch += 1000000; }
  else if (message.type === 'speed' && scenario) scenario.speed = message.speed;
  else if (message.type === 'camera' && scenario) scenario.traffic.setCitizenView(message.position, message.radius, message.cap);
};
setInterval(() => {
  const now = performance.now(); const delta = Math.min(.25, (now - lastTime) / 1000); lastTime = now;
  if (!scenario) return;
  scenario.tick(delta);
  // Match normal traffic cadence; do not send an unchanged crowd at render frequency.
  if (!full && Math.floor(scenario.gameSeconds) % 5 !== 0 && scenario.speed) return;
  const snapshot = scenario.snapshot(full); full = false;
  snapshot.roadRevision += worldEpoch; snapshot.terrainRevision += worldEpoch; snapshot.zoningRevision += worldEpoch;
  snapshot.lotRevision += worldEpoch; snapshot.water.revision += worldEpoch;
  snapshot.traffic.revision += worldEpoch; snapshot.population.revision += worldEpoch;
  snapshot.services.revision += worldEpoch; snapshot.transit.revision += worldEpoch;
  self.postMessage({ snapshot, performance: { ...scenario.performance.report(), ...scenario.traffic.performanceMetrics },
    messageBytes: payloadBytes(snapshot) });
}, 100);
