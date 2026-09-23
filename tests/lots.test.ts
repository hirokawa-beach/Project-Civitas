import { describe, expect, it } from 'vitest';
import { SimulationState } from '../src/simulation/state';
import { LOT_SIZES } from '../src/lots/definitions';
import { generateLots } from '../src/lots/generator';
import type { ZoningCell } from '../src/zoning/types';

const straightRoad = () => {
  const state = new SimulationState();
  state.execute({ type: 'build-road', input: { geometry: { kind: 'straight', points: [{ x: -160, z: 0 }, { x: 160, z: 0 }] }, roadTypeId: 'small' } });
  return state;
};

const paintAll = (state: SimulationState, zoneType: 'residential' | 'commercial' | 'industrial' | 'office' = 'residential') => {
  const ids = state.snapshot().zoningCells.filter((cell) => cell.terrainSuitable !== false).map((cell) => cell.id);
  state.execute({ type: 'set-zone', cellIds: ids, zoneType });
};

describe('lots and prototype buildings', () => {
  it.each([[1, 1], [1, 2], [2, 2], [2, 3], [3, 2], [3, 3], [4, 4]])('can pack a %i×%i roadside rectangle', (width, depth) => {
    const cells: ZoningCell[] = [];
    for (let row = 0; row < depth; row += 1) for (let column = 0; column < width; column += 1) {
      const x = column * 8; const z = 8 + row * 8;
      cells.push({ id: `zone-synthetic-${column}-${row}`, roadSegmentId: 'segment-1',
        center: { x: x + 4, z: z + 4 },
        corners: [{ x, z }, { x: x + 8, z }, { x: x + 8, z: z + 8 }, { x, z: z + 8 }],
        angle: 0, depth: row, side: 1, size: 8, zoneType: 'residential', terrainSuitable: true });
    }
    const lots = generateLots(cells, () => 0);
    expect(lots).toHaveLength(1);
    expect([lots[0].widthCells, lots[0].depthCells]).toEqual([width, depth]);
    expect(lots[0].zoneCellIds).toHaveLength(width * depth);
  });

  it('packs deterministic multi-cell lots with frontage and no overlap', () => {
    const state = straightRoad();
    paintAll(state);
    const lots = state.snapshot().lots;
    expect(lots.length).toBeGreaterThan(0);
    expect(lots.some((lot) => lot.zoneCellIds.length > 1)).toBe(true);
    expect(lots.some((lot) => lot.widthCells > 1 && lot.depthCells > 1)).toBe(true);
    const used = lots.flatMap((lot) => lot.zoneCellIds);
    expect(new Set(used).size).toBe(used.length);
    const cells = new Map(state.snapshot().zoningCells.map((cell) => [cell.id, cell]));
    for (const lot of lots) {
      expect(LOT_SIZES.some(([width, depth]) => width === lot.widthCells && depth === lot.depthCells)).toBe(true);
      expect(lot.zoneCellIds.some((id) => cells.get(id)?.depth === 0)).toBe(true);
      expect(lot.roadAccess.frontage).toHaveLength(2);
      expect(lot.roadAccess.roadSegmentId).toBeDefined();
    }
  });

  it('samples lot elevation and blocks buildings on a steep footprint', () => {
    const cells: ZoningCell[] = [];
    for (let row = 0; row < 2; row += 1) for (let column = 0; column < 2; column += 1) {
      const x = column * 8; const z = 8 + row * 8;
      cells.push({ id: `zone-slope-${column}-${row}`, roadSegmentId: 'segment-1', center: { x: x + 4, z: z + 4 },
        corners: [{ x, z }, { x: x + 8, z }, { x: x + 8, z: z + 8 }, { x, z: z + 8 }],
        angle: 0, depth: row, side: 1, size: 8, zoneType: 'industrial', terrainSuitable: true });
    }
    const gentle = generateLots(cells, (x) => x / 8)[0];
    expect(gentle.buildable).toBe(true);
    expect(gentle.minElevation).toBe(0);
    expect(gentle.maxElevation).toBe(2);
    expect(gentle.baseElevation).toBeGreaterThan(0);
    const steep = generateLots(cells, (x) => x)[0];
    expect(steep.buildable).toBe(false);
    expect(steep.slope).toBeGreaterThan(0.5);
  });

  it('advances building states on the game clock and round-trips timers', () => {
    const state = straightRoad();
    paintAll(state);
    const first = state.snapshot().buildings[0];
    expect(first).toBeDefined();
    expect(first.state).toBe('Empty');
    state.tick(1);
    expect(state.snapshot().buildings[0].state).toBe('Planned');
    state.tick(2);
    expect(state.snapshot().buildings[0].state).toBe('Constructing');
    const saved = state.serialize();
    const restored = new SimulationState();
    restored.load(JSON.parse(JSON.stringify(saved)));
    expect(restored.snapshot().buildings).toEqual(state.snapshot().buildings);
    expect(restored.snapshot().lots).toEqual(state.snapshot().lots);
    restored.tick(4);
    expect(restored.snapshot().buildings[0].state).toBe('Occupied');
  });

  it('does not transfer a residential building to a commercial zone', () => {
    const state = straightRoad();
    const id = state.snapshot().zoningCells.find((cell) => cell.depth === 0)!.id;
    state.execute({ type: 'set-zone', cellIds: [id], zoneType: 'residential' });
    state.tick(7);
    expect(state.snapshot().buildings[0].state).toBe('Occupied');
    state.execute({ type: 'set-zone', cellIds: [id], zoneType: 'commercial' });
    expect(state.snapshot().lots[0].zoneType).toBe('commercial');
    expect(state.snapshot().buildings[0].definitionId).toContain('commercial');
    expect(state.snapshot().buildings[0].state).toBe('Empty');
    expect(state.undo()).toBe(true);
    expect(state.snapshot().lots[0].zoneType).toBe('residential');
    expect(state.snapshot().buildings[0].state).toBe('Occupied');
    expect(state.redo()).toBe(true);
    expect(state.snapshot().buildings[0].definitionId).toContain('commercial');
  });

  it('creates a prototype definition for each RCIO type and removes a building with zoning', () => {
    for (const zoneType of ['residential', 'commercial', 'industrial', 'office'] as const) {
      const state = straightRoad();
      const id = state.snapshot().zoningCells.find((cell) => cell.depth === 0)!.id;
      state.execute({ type: 'set-zone', cellIds: [id], zoneType });
      expect(state.snapshot().buildings[0].definitionId).toContain(zoneType);
      state.execute({ type: 'set-zone', cellIds: [id], zoneType: null });
      expect(state.snapshot().buildings).toHaveLength(0);
      expect(state.undo()).toBe(true);
      expect(state.snapshot().buildings[0].definitionId).toContain(zoneType);
    }
  });

  it('keeps an unaffected building across a road split and removes it with its road', () => {
    const state = straightRoad();
    paintAll(state);
    state.tick(7);
    const stable = state.snapshot().lots.find((lot) => lot.position.x < -100 && lot.buildingId)!;
    expect(stable).toBeDefined();
    const original = state.snapshot().buildings.find((building) => building.id === stable.buildingId)!;
    state.execute({ type: 'build-road', input: { geometry: { kind: 'straight', points: [{ x: 0, z: -80 }, { x: 0, z: 80 }] }, roadTypeId: 'small' } });
    expect(state.snapshot().buildings.find((building) => building.id === original.id)).toEqual(original);
    const splitSave = state.serialize();
    const splitRestored = new SimulationState();
    splitRestored.load(JSON.parse(JSON.stringify(splitSave)));
    expect(splitRestored.snapshot().lots).toEqual(state.snapshot().lots);
    expect(splitRestored.snapshot().buildings).toEqual(state.snapshot().buildings);
    const segment = state.snapshot().lots.find((lot) => lot.id === stable.id)!.roadAccess.roadSegmentId;
    state.execute({ type: 'remove-road', segmentId: segment });
    expect(state.snapshot().lots.some((lot) => lot.id === stable.id)).toBe(false);
    expect(state.undo()).toBe(true);
    expect(state.snapshot().buildings.find((building) => building.id === original.id)).toEqual(original);
  });

  it('creates non-overlapping lots along a curved road', () => {
    const state = new SimulationState();
    state.execute({ type: 'build-road', input: { geometry: { kind: 'curve', points: [
      { x: -120, z: -20 }, { x: -60, z: 10 }, { x: 0, z: 30 }, { x: 60, z: 10 }, { x: 120, z: -20 },
    ] }, roadTypeId: 'small' } });
    paintAll(state, 'office');
    const lots = state.snapshot().lots;
    expect(lots.length).toBeGreaterThan(0);
    expect(new Set(lots.flatMap((lot) => lot.zoneCellIds)).size).toBe(lots.flatMap((lot) => lot.zoneCellIds).length);
  });

  it('revalidates only affected terrain chunks and restores buildings on undo', () => {
    const state = straightRoad();
    paintAll(state);
    const lot = state.snapshot().lots.find((item) => item.buildingId && item.position.z > 15 && Math.abs(item.position.x) < 40)!;
    expect(lot).toBeDefined();
    state.beginTerrainStroke(lot.position, 'raise', 24, 50);
    state.applyTerrainStroke([lot.position], 0.25);
    state.endTerrainStroke();
    expect(state.lots.lastReevaluatedCells).toBeLessThan(state.snapshot().zoningCells.length);
    expect(state.snapshot().lots.find((item) => item.id === lot.id)?.buildingId).toBeUndefined();
    expect(state.undo()).toBe(true);
    expect(state.snapshot().lots.some((item) => item.id === lot.id)).toBe(true);
  });

  it('rejects a corrupt building reference without replacing the current city', () => {
    const state = straightRoad();
    paintAll(state);
    const before = state.snapshot().buildings;
    const save = state.serialize();
    save.buildings[0].definitionId = 'missing-definition';
    expect(() => state.load(save)).toThrow(/invalid buildings/);
    expect(state.snapshot().buildings).toEqual(before);
  });

  it('keeps a local terrain edit local in a two-district city', () => {
    const state = new SimulationState();
    for (const z of [-300, 300]) state.execute({ type: 'build-road', input: {
      geometry: { kind: 'straight', points: [{ x: -160, z }, { x: 160, z }] }, roadTypeId: 'small',
    } });
    paintAll(state);
    const before = state.snapshot();
    const remote = before.lots.filter((lot) => lot.position.z > 200);
    const started = performance.now();
    state.beginTerrainStroke({ x: 0, z: -275 }, 'raise', 24, 50);
    state.applyTerrainStroke([{ x: 0, z: -275 }], 0.25);
    state.endTerrainStroke();
    const update = state.consumeTerrainUpdate()!;
    const elapsed = performance.now() - started;
    expect(state.lots.lastReevaluatedCells).toBeLessThan(before.zoningCells.length / 2);
    expect(state.snapshot().lots.filter((lot) => lot.position.z > 200)).toEqual(remote);
    expect(update.chunkIds.length).toBeLessThan(16);
    expect(update.messageBytes).toBeLessThan(300_000);
    const saveBytes = JSON.stringify(state.serialize()).length;
    expect(saveBytes).toBeLessThan(600_000);
    console.info(`Local lot recheck: ${state.lots.lastReevaluatedCells}/${before.zoningCells.length} cells; `
      + `terrain update: ${update.messageBytes} bytes; edit: ${elapsed.toFixed(1)} ms; save: ${saveBytes} bytes`);
  });
});
