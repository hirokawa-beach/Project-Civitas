import { BenchmarkScenario, SCENARIOS, BENCHMARK_SEED } from './scenarios';
import { PerformanceLedger, payloadBytes } from './metrics';
import { CitizenSampler } from '../visual/citizenSampler';
import { VISUAL_AGENT_PROFILES } from '../visual/agentBudget';

export function runSimulationBenchmarks(samples = 32) {
  return { schemaVersion: 1, seed: BENCHMARK_SEED, samples, camera: { x: 0, z: 0, radius: 410 }, profile: 'balanced',
    scenarios: SCENARIOS.map((id) => {
      const setupStart = performance.now(); const scenario = new BenchmarkScenario(id);
      const setupMs = performance.now() - setupStart;
      const ledger = new PerformanceLedger(); const sampler = new CitizenSampler();
      ledger.measure('terrainChunkEditMs', () => {
        scenario.terrain.beginTerrainStroke({ x: 0, z: 0 }, 'raise', 24, 4);
        scenario.terrain.endTerrainStroke(); scenario.terrain.consumeTerrainUpdate();
      });
      // Warm up separately; the sample window and deterministic clock/input are identical across passes.
      for (let i = 0; i < 10; i++) scenario.tick(.05);
      scenario.performance.clear(); scenario.traffic.citizens.performance.clear();
      let rendered = 0; let candidates = 0;
      for (let i = 0; i < samples; i++) {
        scenario.tick(.05);
        if (scenario.roads.segments.length) {
          const road = scenario.roads.segments[i % scenario.roads.segments.length];
          ledger.measure('pathfindingProbeMs', () => scenario.traffic.router.route(
            { kind: 'building', id: 'probe-a', roadSegmentId: road.id, position: road.geometry.points[0] },
            { kind: 'building', id: 'probe-b', roadSegmentId: road.id, position: road.geometry.points[1] },
            new Map(scenario.traffic.segmentStates.map((state) => [state.segmentId, state]))));
        }
        const snapshot = ledger.measure('snapshotMs', () => scenario.snapshot());
        const raw = scenario.traffic.citizens.nearby({ x: 0, z: 0 }, 410, Number.MAX_SAFE_INTEGER, scenario.gameSeconds);
        candidates = raw.length;
        sampler.sync(snapshot.traffic.citizenCandidates ?? []);
        const selected = ledger.measure('citizenSelectionMs', () => sampler.select({ x: 0, z: 0 }, VISUAL_AGENT_PROFILES.balanced,
          VISUAL_AGENT_PROFILES.balanced.maxCitizens, [], scenario.gameSeconds, scenario.traffic.citizens.count));
        rendered = selected.agents.length;
        ledger.measure('citizenPoseMs', () => { for (const person of selected.agents) sampler.pose(person.id, scenario.gameSeconds); });
      }
      const full = scenario.snapshot(true);
      return { id, setupMs, totalIndividualCitizens: scenario.traffic.citizens.count, activeJourneys: scenario.traffic.citizens.activeJourneys,
        cameraCitizens: candidates, selectedCitizens: rendered, logicalVehicles: full.traffic.logicalVehicles, roadSegments: scenario.roads.segments.length,
        snapshotBytes: payloadBytes(full), trafficMessageBytes: payloadBytes(full.traffic),
        citizenStateBytes: payloadBytes(scenario.traffic.citizens.save()),
        timings: { ...scenario.performance.report(), ...scenario.traffic.performanceMetrics, ...ledger.report() } };
    }) };
}
