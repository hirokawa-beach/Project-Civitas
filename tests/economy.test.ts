import { describe, expect, it } from 'vitest';
import { EconomySystem, DEFAULT_ECONOMY_CONFIG, roadConstructionCost, roadMaintenanceCost } from '../src/economy/system';
import type { PopulationTotals } from '../src/population/types';
import { polylineLength } from '../src/roads/geometry';
import { RoadGraph } from '../src/roads/roadGraph';
import { SimulationState } from '../src/simulation/state';

const emptyTotals = (): PopulationTotals => ({
  population: 0, households: 0, employed: 0, unemployed: 0, laborForce: 0,
  totalJobs: 0, availableJobs: 0, residentialCapacity: 0, commercialCapacity: 0,
  jobsByZone: { commercial: 0, industrial: 0, office: 0 },
  availableJobsByZone: { commercial: 0, industrial: 0, office: 0 },
  emptyBuildingsByZone: { commercial: 0, industrial: 0, office: 0 },
  occupiedBuildingsByZone: { commercial: 0, industrial: 0, office: 0 },
});
const straight = (x0: number, z0: number, x1: number, z1: number) => ({
  geometry: { kind: 'straight' as const, points: [{ x: x0, z: z0 }, { x: x1, z: z1 }] }, roadTypeId: 'small',
});

describe('basic city economy', () => {
  it('starts with configured integer funds and waits for the 600-second cycle', () => {
    const economy = new EconomySystem();
    expect(economy.funds).toBe(250_000);
    expect(economy.snapshot()).toMatchObject({ totalIncome: 0, totalExpenses: 0,
      nextCycleAtGameSeconds: 600, lastEconomyTickGameSeconds: 0 });
    expect(economy.tick(599, emptyTotals(), [])).toBe(false);
    expect(economy.funds).toBe(250_000);
  });

  it('taxes occupied households and only filled C/I/O jobs at configured rates', () => {
    const totals = emptyTotals();
    totals.households = 7;
    totals.jobsByZone = { commercial: 8, industrial: 10, office: 5 };
    totals.availableJobsByZone = { commercial: 5, industrial: 6, office: 3 };
    const economy = new EconomySystem();
    economy.tick(600, totals, []);
    expect(economy.snapshot().lastCycleTaxes).toEqual({ residential: 70, commercial: 36, industrial: 40, office: 28 });
    expect(economy.snapshot()).toMatchObject({ lastCycleIncome: 174, lastCycleExpenses: 0,
      lastCycleNet: 174, funds: 250_174, totalIncome: 174 });
    expect(economy.snapshot().transactions.map((entry) => entry.kind)).toEqual([
      'TAX_RESIDENTIAL', 'TAX_COMMERCIAL', 'TAX_INDUSTRIAL', 'TAX_OFFICE',
    ]);
  });

  it('does not tax empty job capacity', () => {
    const totals = emptyTotals();
    totals.jobsByZone.commercial = 10;
    totals.jobsByZone.industrial = 10;
    totals.jobsByZone.office = 10;
    totals.availableJobsByZone = { ...totals.jobsByZone };
    const economy = new EconomySystem();
    economy.tick(600, totals, []);
    expect(economy.snapshot().lastCycleIncome).toBe(0);
  });

  it('uses real curve length for construction and maintenance costs', () => {
    const curve = [{ x: -50, z: 0 }, { x: -20, z: 30 }, { x: 20, z: 30 }, { x: 50, z: 0 }];
    const chord = 100;
    expect(polylineLength(curve)).toBeGreaterThan(chord);
    expect(roadConstructionCost(curve, 'small')).toBe(Math.round(polylineLength(curve) * 20));
    const graph = new RoadGraph();
    graph.buildRoad({ geometry: { kind: 'curve', points: curve }, roadTypeId: 'small' });
    expect(roadMaintenanceCost(graph.snapshot().segments)).toBe(Math.round(polylineLength(curve)));
  });

  it('does not double-charge maintenance when an intersection splits a road', () => {
    const graph = new RoadGraph();
    graph.buildRoad(straight(-100, 0, 100, 0));
    graph.buildRoad(straight(0, -100, 0, 100));
    expect(graph.snapshot().segments.length).toBeGreaterThan(2);
    expect(roadMaintenanceCost(graph.snapshot().segments)).toBe(400);
    const economy = new EconomySystem();
    economy.tick(600, emptyTotals(), graph.snapshot().segments);
    expect(economy.snapshot()).toMatchObject({ lastCycleExpenses: 400, lastCycleRoadMaintenance: 400, funds: 249_600 });
  });

  it('charges only the new road once when its intersections split existing segments', () => {
    const state = new SimulationState();
    state.execute({ type: 'build-road', input: straight(-100, 0, 100, 0) });
    const before = state.economy.funds;
    state.execute({ type: 'build-road', input: straight(0, -100, 0, 100) });
    expect(state.economy.funds).toBe(before - 4_000);
    expect(state.economy.snapshot().transactions.filter((entry) => entry.kind === 'ROAD_CONSTRUCTION')).toHaveLength(2);
  });

  it('charges a built road once and exactly refunds/reapplies its cost on undo/redo', () => {
    const state = new SimulationState();
    const cost = roadConstructionCost(straight(-50, 0, 50, 0).geometry.points, 'small');
    state.execute({ type: 'build-road', input: straight(-50, 0, 50, 0) });
    expect(state.economy.funds).toBe(250_000 - cost);
    expect(state.graph.segments.size).toBe(1);
    expect(state.undo()).toBe(true);
    expect(state.economy.funds).toBe(250_000);
    expect(state.graph.segments.size).toBe(0);
    expect(state.redo()).toBe(true);
    expect(state.economy.funds).toBe(250_000 - cost);
    expect(state.graph.segments.size).toBe(1);
    expect(state.economy.snapshot().totalExpenses).toBe(cost);
  });

  it('rejects an unaffordable build without changing the graph or funds', () => {
    const state = new SimulationState();
    const low = { ...state.economy.save(), funds: 100 };
    state.economy.restore(low, 0);
    expect(() => state.execute({ type: 'build-road', input: straight(-50, 0, 50, 0) })).toThrow('Not enough funds');
    expect(state.graph.segments.size).toBe(0);
    expect(state.economy.funds).toBe(100);
  });

  it('replays an already-valid road command even if funds became insufficient before redo', () => {
    const state = new SimulationState();
    state.execute({ type: 'build-road', input: straight(-50, 0, 50, 0) });
    state.undo();
    state.economy.restore({ ...state.economy.save(), funds: 0 }, 0);
    expect(state.redo()).toBe(true);
    expect(state.graph.segments.size).toBe(1);
    expect(state.economy.funds).toBe(-2_000);
  });

  it('never refunds a demolished road or charges it twice on undo', () => {
    const state = new SimulationState();
    state.execute({ type: 'build-road', input: straight(-50, 0, 50, 0) });
    const funds = state.economy.funds;
    const segmentId = state.snapshot().roadGraph.segments[0].id;
    state.execute({ type: 'remove-road', segmentId });
    expect(state.economy.funds).toBe(funds);
    state.undo();
    expect(state.economy.funds).toBe(funds);
    state.redo();
    expect(state.economy.funds).toBe(funds);
  });

  it('allows negative funds after maintenance without deleting existing roads or buildings', () => {
    const graph = new RoadGraph();
    graph.buildRoad(straight(-50, 0, 50, 0));
    const economy = new EconomySystem({ ...DEFAULT_ECONOMY_CONFIG, initialFunds: 0 });
    economy.tick(600, emptyTotals(), graph.snapshot().segments);
    expect(economy.funds).toBe(-100);
    expect(economy.canAfford(1)).toBe(false);
    expect(graph.snapshot().segments).toHaveLength(1);
  });

  it('does not advance an economy cycle while the game is paused', () => {
    const state = new SimulationState();
    state.execute({ type: 'build-road', input: straight(-50, 0, 50, 0) });
    state.setSpeed(0);
    state.tick(100);
    expect(state.clock.gameSeconds).toBe(0);
    expect(state.economy.snapshot().lastCycleIncome).toBe(0);
    expect(state.economy.snapshot().lastCycleExpenses).toBe(0);
    state.setSpeed(1);
    state.tick(60);
    expect(state.economy.snapshot().lastCycleExpenses).toBe(100);
  });

  it('keeps economy timing and funds through save/load without double-applying a cycle', () => {
    const state = new SimulationState();
    state.execute({ type: 'build-road', input: straight(-50, 0, 50, 0) });
    state.tick(60);
    expect(state.clock.gameSeconds).toBe(600);
    const saved = JSON.parse(JSON.stringify(state.serialize()));
    const restored = new SimulationState();
    restored.load(saved);
    expect(restored.economy.save()).toEqual(state.economy.save());
    const before = restored.economy.funds;
    restored.tick(0);
    expect(restored.economy.funds).toBe(before);
    restored.tick(60);
    expect(restored.economy.funds).toBe(before - 100);
  });

  it('migrates a v6 save with fresh treasury and no retroactive tax cycle', () => {
    const state = new SimulationState();
    state.tick(75);
    const legacy = state.serialize() as unknown as Record<string, unknown>;
    legacy.saveVersion = 6;
    delete legacy.economy;
    const restored = new SimulationState();
    restored.load(legacy as unknown as ReturnType<SimulationState['serialize']>);
    expect(restored.economy.funds).toBe(250_000);
    expect(restored.economy.snapshot().lastEconomyTickGameSeconds).toBe(750);
    restored.tick(0);
    expect(restored.economy.funds).toBe(250_000);
  });

  it('rejects corrupt economy data without mutating live state', () => {
    const state = new SimulationState();
    const before = state.economy.save();
    const saved = state.serialize();
    saved.economy.nextCycleAtGameSeconds = 0;
    expect(() => state.load(saved)).toThrow('invalid economy');
    expect(state.economy.save()).toEqual(before);
  });

  it('bounds transaction history and cycles safely across an elapsed-time gap', () => {
    const economy = new EconomySystem({ ...DEFAULT_ECONOMY_CONFIG, transactionLimit: 3 });
    economy.tick(3_000, { ...emptyTotals(), households: 1 }, []);
    expect(economy.snapshot().lastEconomyTickGameSeconds).toBe(3_000);
    expect(economy.snapshot().totalIncome).toBe(50);
    expect(economy.snapshot().transactions).toHaveLength(3);
  });

  it('updates a 100,000-person equivalent using aggregates without citizen iteration', () => {
    const totals = { ...emptyTotals(), population: 100_000, households: 33_334,
      jobsByZone: { commercial: 20_000, industrial: 15_000, office: 10_000 },
      availableJobsByZone: { commercial: 5_000, industrial: 5_000, office: 5_000 } };
    const economy = new EconomySystem();
    const started = performance.now();
    economy.tick(600, totals, []);
    const elapsed = performance.now() - started;
    expect(economy.snapshot().lastCycleIncome).toBe(33_334 * 10 + 15_000 * 12 + 10_000 * 10 + 5_000 * 14);
    expect(elapsed).toBeLessThan(100);
    console.info(`100,000 population equivalent economy tick: ${elapsed.toFixed(2)} ms`);
  });
});
