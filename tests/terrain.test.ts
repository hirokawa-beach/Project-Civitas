import { describe, expect, it } from 'vitest';
import { HeightmapTerrain, TERRAIN_COLUMNS } from '../src/terrain/heightmap';
import { SimulationState } from '../src/simulation/state';
import { validateRoadCandidate } from '../src/roads/validation';
import { buildRoadTerrainProtection } from '../src/terrain/roadProtection';
import { isTerrainSuitableForZone } from '../src/zoning/terrainSuitability';
import { ZoningCellIndex } from '../src/zoning/interaction';

const stamp = (terrain: HeightmapTerrain, mode: 'raise' | 'lower' | 'flatten' | 'smooth', x = 0, z = 0, flattenHeight = 0) =>
  terrain.applyBrush({ mode, center: { x, z }, size: 48, strength: 20, seconds: 0.5, flattenHeight }, new Map());

describe('heightmap terrain foundation', () => {
  it('samples flat terrain in world metres and clamps map edges', () => {
    const terrain = new HeightmapTerrain();
    expect(terrain.heights).toHaveLength(TERRAIN_COLUMNS ** 2);
    expect(terrain.getHeight(0, 0)).toBe(0);
    expect(terrain.getHeight(9999, -9999)).toBe(0);
    expect(terrain.getNormal(0, 0)).toEqual({ x: -0, y: 1, z: -0 });
  });

  it('bilinearly samples heights and returns an uphill normal', () => {
    const terrain = new HeightmapTerrain();
    const center = 128 * TERRAIN_COLUMNS + 128;
    terrain.heights[center] = 8;
    expect(terrain.getHeight(2, 0)).toBeCloseTo(4);
    expect(terrain.getNormal(-4, 0).x).toBeLessThan(0);
    expect(terrain.getNormal(0, 0).y).toBeGreaterThan(0);
  });

  it('raises and lowers only brush-nearby chunks', () => {
    const terrain = new HeightmapTerrain();
    const raised = stamp(terrain, 'raise', -320, -320);
    expect(terrain.getHeight(-320, -320)).toBeGreaterThan(0);
    expect(terrain.getHeight(320, 320)).toBe(0);
    expect(raised).toEqual(['chunk-0-0']);
    stamp(terrain, 'lower', -320, -320);
    expect(terrain.getHeight(-320, -320)).toBeCloseTo(0);
  });

  it('flattens toward a captured height and smooths a spike', () => {
    const terrain = new HeightmapTerrain();
    stamp(terrain, 'raise');
    const initial = terrain.getHeight(0, 0);
    stamp(terrain, 'flatten', 0, 0, -5);
    expect(terrain.getHeight(0, 0)).toBeLessThan(initial);
    const center = 128 * TERRAIN_COLUMNS + 128;
    terrain.heights[center] = 60;
    stamp(terrain, 'smooth');
    expect(terrain.heights[center]).toBeLessThan(60);
  });

  it('restores a complete drag with one undo and redo', () => {
    const state = new SimulationState();
    state.beginTerrainStroke({ x: 10, z: 10 }, 'raise', 48, 12);
    state.applyTerrainStroke([{ x: 16, z: 10 }, { x: 24, z: 10 }], 0.1);
    state.endTerrainStroke();
    const raised = state.terrain.getHeight(16, 10);
    expect(raised).toBeGreaterThan(0);
    expect(state.undo()).toBe(true);
    expect(state.terrain.getHeight(16, 10)).toBe(0);
    expect(state.redo()).toBe(true);
    expect(state.terrain.getHeight(16, 10)).toBeCloseTo(raised);
  });

  it('cancels a drag without history and supports preset undo', () => {
    const state = new SimulationState();
    state.beginTerrainStroke({ x: 0, z: 0 }, 'raise', 48, 12);
    state.cancelTerrainStroke();
    expect(state.terrain.getHeight(0, 0)).toBe(0);
    expect(state.undo()).toBe(false);
    state.setTerrainPreset('hills');
    expect(state.terrain.getHeight(-160, -120)).toBeGreaterThan(20);
    expect(state.undo()).toBe(true);
    expect(state.terrain.getHeight(-160, -120)).toBe(0);
    expect(state.redo()).toBe(true);
    expect(state.terrain.getHeight(-160, -120)).toBeGreaterThan(20);
  });

  it('round-trips terrain settings and all heights through save/load', () => {
    const state = new SimulationState();
    state.setTerrainPreset('hills');
    state.beginTerrainStroke({ x: -80, z: -40 }, 'lower', 40, 20);
    state.endTerrainStroke();
    const save = state.serialize();
    expect(save.world.terrain.settings.preset).toBe('hills');
    expect(save.world.terrain.terrainVersion).toBe(1);
    const restored = new SimulationState();
    restored.load(JSON.parse(JSON.stringify(save)));
    expect(restored.terrain.heights).toEqual(state.terrain.heights);
    expect(restored.terrain.settings).toEqual(state.terrain.settings);
  });

  it('rejects a corrupt terrain without changing roads or existing terrain', () => {
    const state = new SimulationState();
    state.setTerrainPreset('hills');
    const height = state.terrain.getHeight(-160, -120);
    const save = state.serialize();
    save.world.terrain.heightmap[0] = Number.NaN;
    expect(() => state.load(save)).toThrow(/heightmap/);
    expect(state.terrain.getHeight(-160, -120)).toBe(height);
  });

  it('sends a bounded patch for one edited chunk', () => {
    const state = new SimulationState();
    state.beginTerrainStroke({ x: -320, z: -320 }, 'raise', 40, 10);
    state.endTerrainStroke();
    const update = state.consumeTerrainUpdate()!;
    expect(update.chunkIds).toEqual(['chunk-0-0']);
    expect(update.messageBytes).toBeGreaterThanOrEqual(65 * 65 * 4);
    expect(update.messageBytes).toBeLessThan(65 * 65 * 4 + 256);
    expect(update.patches[0].heights).toHaveLength(65 * 65);
    expect(state.consumeTerrainUpdate()).toBeUndefined();
  });

  it('rejects a steep surface road and allows a level road', () => {
    const state = new SimulationState();
    stamp(state.terrain, 'raise', 0, 0);
    const points = [{ x: -40, z: 0 }, { x: 40, z: 0 }];
    expect(validateRoadCandidate(state.graph.snapshot(), points, { terrainHeight: (x, z) => state.terrain.getHeight(x, z) }).reasons)
      .toContain('steep-grade');
    expect(() => state.execute({ type: 'build-road', input: { geometry: { kind: 'straight', points }, roadTypeId: 'small' } }))
      .toThrow(/grade/);
    expect(() => state.execute({ type: 'build-road', input: { geometry: { kind: 'straight', points: [{ x: 80, z: 80 }, { x: 160, z: 80 }] }, roadTypeId: 'small' } }))
      .not.toThrow();
  });

  it('places a surface road on gentle elevated terrain without flattening the terrain', () => {
    const state = new SimulationState();
    state.setTerrainPreset('hills');
    const points = [{ x: -180, z: -120 }, { x: -140, z: -120 }];
    const elevation = state.terrain.getHeight(-160, -120);
    expect(elevation).toBeGreaterThan(20);
    expect(() => state.execute({ type: 'build-road', input: { geometry: { kind: 'straight', points }, roadTypeId: 'small' } }))
      .not.toThrow();
    expect(state.snapshot().roadGraph.segments).toHaveLength(1);
    expect(state.terrain.getHeight(-160, -120)).toBe(elevation);
  });

  it('keeps RCIO cell IDs and assignments across terrain edits', () => {
    const state = new SimulationState();
    state.execute({ type: 'build-road', input: { geometry: { kind: 'straight', points: [{ x: -100, z: 0 }, { x: 100, z: 0 }] }, roadTypeId: 'small' } });
    const before = state.snapshot();
    const id = before.zoningCells[0].id;
    state.execute({ type: 'set-zone', cellIds: [id], zoneType: 'residential' });
    state.beginTerrainStroke({ x: -80, z: 20 }, 'raise', 48, 12);
    state.endTerrainStroke();
    const after = state.snapshot();
    expect(after.zoningCells.map((cell) => cell.id)).toEqual(before.zoningCells.map((cell) => cell.id));
    expect(after.zoningCells.find((cell) => cell.id === id)?.zoneType).toBe('residential');
    expect(after.zoningCells.find((cell) => cell.id === id)?.terrainHeight).toBeDefined();
    expect(after.zoningRevision).toBe(before.zoningRevision + 1);
  });

  it('keeps road surfaces fixed while allowing terrain edits beyond the shoulder', () => {
    const state = new SimulationState();
    state.execute({ type: 'build-road', input: { geometry: { kind: 'straight', points: [{ x: -100, z: 0 }, { x: 100, z: 0 }] }, roadTypeId: 'small' } });
    state.beginTerrainStroke({ x: 0, z: 0 }, 'raise', 96, 40);
    state.applyTerrainStroke([{ x: 0, z: 0 }], 0.25);
    state.endTerrainStroke();
    expect(state.terrain.getHeight(0, 0)).toBe(0);
    expect(state.terrain.getHeight(0, 8)).toBe(0);
    expect(state.terrain.getHeight(0, 28)).toBeGreaterThan(0);
    expect(state.terrain.getHeight(0, 60)).toBe(0);
    const raised = state.terrain.getHeight(0, 28);
    expect(state.undo()).toBe(true);
    expect(state.terrain.getHeight(0, 28)).toBe(0);
    expect(state.redo()).toBe(true);
    expect(state.terrain.getHeight(0, 28)).toBeCloseTo(raised);
  });

  it('protects road vertices from every brush mode and terrain presets', () => {
    const state = new SimulationState();
    state.execute({ type: 'build-road', input: { geometry: { kind: 'straight', points: [{ x: -200, z: -120 }, { x: -120, z: -120 }] }, roadTypeId: 'small' } });
    const center = state.terrain.getHeight(-160, -120);
    for (const mode of ['raise', 'lower', 'flatten', 'smooth'] as const) {
      state.beginTerrainStroke({ x: -160, z: -120 }, mode, 96, 40);
      state.applyTerrainStroke([{ x: -160, z: -120 }], 0.25);
      state.endTerrainStroke();
      expect(state.terrain.getHeight(-160, -120)).toBe(center);
    }
    state.setTerrainPreset('hills');
    expect(state.terrain.getHeight(-160, -120)).toBe(center);
    expect(state.terrain.getHeight(-160, -80)).toBeGreaterThan(0);
    const save = state.serialize();
    const loaded = new SimulationState();
    loaded.load(save);
    loaded.beginTerrainStroke({ x: -160, z: -120 }, 'raise', 48, 40);
    loaded.endTerrainStroke();
    expect(loaded.terrain.getHeight(-160, -120)).toBe(center);
  });

  it('releases the protection footprint when a road is undone', () => {
    const state = new SimulationState();
    state.execute({ type: 'build-road', input: { geometry: { kind: 'straight', points: [{ x: -100, z: 0 }, { x: 100, z: 0 }] }, roadTypeId: 'small' } });
    expect(state.undo()).toBe(true);
    state.beginTerrainStroke({ x: 0, z: 0 }, 'raise', 48, 20);
    state.endTerrainStroke();
    expect(state.terrain.getHeight(0, 0)).toBeGreaterThan(0);
    expect(state.undo()).toBe(true);
    expect(state.redo()).toBe(true);
    expect(state.redo()).toBe(false);
  });

  it('protects curved-road legs and their endpoints', () => {
    const weights = buildRoadTerrainProtection([{ width: 16, geometry: { kind: 'curve', points: [{ x: 0, z: 0 }, { x: 40, z: 0 }, { x: 40, z: 40 }] } }]);
    const at = (x: number, z: number) => weights[(z / 4 + 128) * TERRAIN_COLUMNS + x / 4 + 128];
    expect(at(20, 0)).toBe(0);
    expect(at(40, 20)).toBe(0);
    expect(at(40, 40)).toBe(0);
    expect(at(8, 32)).toBe(1);
  });

  it('rejects steep and uneven zone ground without changing cell identity or assignments', () => {
    const state = new SimulationState();
    state.execute({ type: 'build-road', input: { geometry: { kind: 'straight', points: [{ x: -100, z: 0 }, { x: 100, z: 0 }] }, roadTypeId: 'small' } });
    const cell = state.snapshot().zoningCells.find((candidate) => candidate.center.z > 28 && Math.abs(candidate.center.x) < 20)!;
    expect(cell).toBeDefined();
    state.execute({ type: 'set-zone', cellIds: [cell.id], zoneType: 'residential' });
    state.beginTerrainStroke(cell.center, 'raise', 24, 50);
    state.applyTerrainStroke([cell.center], 0.25);
    state.endTerrainStroke();
    const update = state.consumeTerrainUpdate()!;
    expect(update.zoneElevations.find((entry) => entry.id === cell.id)?.terrainSuitable).toBe(false);
    const changed = state.snapshot().zoningCells.find((candidate) => candidate.id === cell.id)!;
    expect(changed.terrainSuitable).toBe(false);
    expect(changed.zoneType).toBe('residential');
    const index = new ZoningCellIndex();
    index.rebuild(state.snapshot().zoningCells);
    expect(index.pick(cell.center)?.id).not.toBe(cell.id);
    expect(() => state.execute({ type: 'set-zone', cellIds: [cell.id], zoneType: 'office' })).toThrow();
    expect(state.undo()).toBe(true);
    state.consumeTerrainUpdate();
    const restored = state.snapshot().zoningCells.find((candidate) => candidate.id === cell.id)!;
    expect(restored.terrainSuitable).toBe(true);
    expect(restored.zoneType).toBe('residential');
  });

  it('checks zone edges as well as the center for excessive local grade', () => {
    const corners = [{ x: 0, z: 0 }, { x: 8, z: 0 }, { x: 8, z: 8 }, { x: 0, z: 8 }] as const;
    expect(isTerrainSuitableForZone({ corners: [...corners] }, () => 0)).toBe(true);
    expect(isTerrainSuitableForZone({ corners: [...corners] }, (x) => x)).toBe(false);
    expect(isTerrainSuitableForZone({ corners: [...corners] }, (x, z) => x === 0 && z === 0 ? 10 : 0)).toBe(false);
    expect(isTerrainSuitableForZone({ corners: [...corners] }, (x, z) => x === 2 && z === 2 ? 10 : 0)).toBe(false);
  });
});
