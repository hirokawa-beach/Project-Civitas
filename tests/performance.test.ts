import { describe, expect, it } from 'vitest';
import { BenchmarkScenario, SCENARIOS } from '../src/performance/scenarios';
import { PerformanceLedger, payloadBytes, summarize } from '../src/performance/metrics';

describe('performance regression foundation', () => {
  it('reports bounded mean/p95/max samples and estimates binary payloads without JSON expansion', () => {
    expect(summarize([1, 2, 3, 4, 100])).toEqual({ samples: 5, mean: 22, p95: 100, max: 100 });
    const ledger = new PerformanceLedger();
    for (let i = 0; i < 1000; i++) ledger.record('tick', i);
    expect(ledger.report().tick.samples).toBe(240);
    expect(ledger.measure('work', () => 7)).toBe(7);
    expect(ledger.report().work.samples).toBe(1);
    expect(payloadBytes(new Float32Array(100))).toBe(400);
    expect(payloadBytes('市民')).toBe(6);
  });
  it('repeats the same identities and exact journey inputs for the same scenario/seed', () => {
    const a = new BenchmarkScenario('camera-6000'); const b = new BenchmarkScenario('camera-6000');
    expect(a.roads).toEqual(b.roads);
    expect(a.traffic.citizens.save()).toEqual(b.traffic.citizens.save());
    expect(new BenchmarkScenario('camera-6000', 'other').traffic.citizens.save()).not.toEqual(a.traffic.citizens.save());
  }, 30000); // Full 6000-person save equality is a correctness check, not a timing gate.
  it.each(SCENARIOS)('creates expected size and measures %s using real individual citizens', (id) => {
    const scenario = new BenchmarkScenario(id);
    const expected = id === 'population-10k' ? 10000 : id === 'population-50k' ? 50000 : id === 'population-100k' ? 100000
      : ['camera-6000', 'commercial-crowd', 'transit-hotspot'].includes(id) ? 6000 : 0;
    expect(scenario.population.snapshot().totals.population).toBe(expected);
    expect(scenario.traffic.citizens.count).toBe(expected);
    if (id.startsWith('roads-')) expect(scenario.roads.segments).toHaveLength(Number(id.slice(6)));
    const candidates = scenario.traffic.citizens.nearby({ x: 0, z: 0 }, 410, Infinity, scenario.gameSeconds);
    if (id === 'camera-6000') expect(candidates.length).toBeGreaterThanOrEqual(5000);
    for (const citizen of candidates.slice(0, 20)) expect(scenario.traffic.citizens.get(citizen.id)?.name).toBe(citizen.name);
    scenario.tick(.05); scenario.snapshot();
    expect(scenario.performance.report().simulationTickMs.samples).toBe(1);
    expect(scenario.traffic.citizens.performance.report().citizenQueryMs.samples).toBeGreaterThan(0);
  }, 30000);
});
