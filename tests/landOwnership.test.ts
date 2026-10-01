import { describe, expect, it } from 'vitest';
import { LandOwnership, defaultLandOwnership, landTileBounds } from '../src/world/landOwnership';
import { createWorldMetadata } from '../src/world/metadata';
import { blankMapAsset } from '../src/maps/mapAsset';
import { SimulationState } from '../src/simulation/state';
import { planServicePlacement } from '../src/services/system';
import { migrateSave } from '../src/save/serializer';

const identity = { id: 'land-test', name: 'Owned land', description: '', author: 'Test' };
const polygon = (x: number, z: number, width = 20) => ({ kind: 'polygon' as const, points: [{ x, z }, { x: x + width, z }, { x: x + width, z: z + width }, { x, z: z + width }] });
const progressiveAsset = () => {
  const asset = blankMapAsset(identity, { worldWidthMeters: 4096, worldDepthMeters: 4096, terrainSampleSpacingMeters: 8 });
  asset.world.landOwnership = defaultLandOwnership(asset.world, 'progressive'); return asset;
};
describe('physical world and independent land ownership', () => {
  it('tests complete footprints across unowned gaps, rather than only vertices or terrain chunks', () => {
    const world = createWorldMetadata({ worldWidthMeters: 4096, worldDepthMeters: 4096 });
    const land = new LandOwnership(world, { mode: 'progressive', tileSizeMeters: 1024, startingTiles: [{ x: 0, z: 0 }, { x: 2, z: 0 }] });
    expect(world.chunkSizeMeters).toBe(256); expect(land.settings.tileSizeMeters).toBe(1024);
    expect(land.canConstruct(polygon(-1500, -1500)).allowed).toBe(true);
    expect(land.canConstruct(polygon(-1100, -1500, 200)).allowed).toBe(false);
    expect(land.canConstruct({ kind: 'path', points: [{ x: -1500, z: -1500 }, { x: 500, z: -1500 }], width: 16 }).allowed).toBe(false);
    expect(land.canConstruct(polygon(-1500, -1500, 2000)).allowed).toBe(false);
    land.unlock({ x: 1, z: 0 });
    expect(land.canConstruct({ kind: 'path', points: [{ x: -1500, z: -1500 }, { x: 500, z: -1500 }], width: 16 }).allowed).toBe(true);
    expect(() => land.unlock({ x: 3, z: 3 })).toThrow(/adjacent/);
    expect(() => land.unlock({ x: 1, z: 0 })).toThrow(/already/);
    expect(() => land.unlock({ x: -1, z: 0 })).toThrow();
  });
  it('keeps Entire Map implicit and accepts a 64km physical world without enumerating owned tiles', () => {
    const world = createWorldMetadata({ worldWidthMeters: 65536, worldDepthMeters: 65536, terrainSampleSpacingMeters: 64 });
    const land = new LandOwnership(world);
    expect(land.save().ownedTiles).toEqual([]); expect(land.canConstruct(polygon(32000, 32000)).allowed).toBe(true);
    expect(land.canConstruct(polygon(32760, 32760)).allowed).toBe(false);
    const partial = landTileBounds({ x: 1, z: 0 }, { worldWidthMeters: 1104, worldDepthMeters: 512 }, 1024);
    expect(partial.maxX - partial.minX).toBe(80);
  });
  it('rejects a rendered bend join crossing locked land even when both segment strips fit', () => {
    const world = createWorldMetadata({ worldWidthMeters: 2048, worldDepthMeters: 2048 });
    const land = new LandOwnership(world, { mode: 'progressive', tileSizeMeters: 1024, startingTiles: [{ x: 1, z: 1 }] });
    const points = [{ x: 100, z: 109 }, { x: 9, z: 200 }, { x: 100, z: 291 }];
    expect(land.canConstruct({ kind: 'path', points: points.slice(0, 2), width: 20 }).allowed).toBe(true);
    expect(land.canConstruct({ kind: 'path', points: points.slice(1), width: 20 }).allowed).toBe(true);
    expect(land.canConstruct({ kind: 'path', points, width: 20 }).allowed).toBe(false);
    expect(land.canConstruct({ kind: 'path', points: points.map(p => ({ ...p, x: p.x + 4 })), width: 20 }).allowed).toBe(true);
  });
  it('uses the same authority for roads, zoning, automatic buildings and services; unlocks persist', () => {
    const state = new SimulationState(); state.startMapAsset(progressiveAsset());
    const build = (z: number) => state.execute({ type: 'build-road', input: { roadTypeId: 'small', geometry: { kind: 'straight', points: [{ x: 100, z }, { x: 300, z }] } } });
    const before = state.economy.save(); expect(() => build(-100)).toThrow(/Unlock/); expect(state.graph.segments.size).toBe(0); expect(state.economy.save()).toEqual(before);
    build(9);
    const cells = state.snapshot(false).zoningCells; const unowned = cells.filter(cell => !state.landOwnership.canConstruct({ kind: 'polygon', points: cell.corners }).allowed);
    expect(unowned.length).toBeGreaterThan(0);
    expect(() => state.execute({ type: 'set-zone', cellIds: [unowned[0].id], zoneType: 'residential' })).toThrow();
    const owned = cells.filter(cell => state.landOwnership.canConstruct({ kind: 'polygon', points: cell.corners }).allowed);
    state.execute({ type: 'set-zone', cellIds: owned.map(cell => cell.id), zoneType: 'residential' }); state.tick(100);
    expect(state.lots.buildings.length).toBeGreaterThan(0);
    expect(state.lots.lots.every(lot => state.landOwnership.canConstruct({ kind: 'polygon', points: lot.corners }).allowed)).toBe(true);
    const plan = planServicePlacement('water', { x: 200, z: -10 }, state.graph.snapshot(), [], [], [], () => 0, 'preview', state.worldMetadata, state.landOwnership);
    expect(plan.valid).toBe(false); expect(plan.reason).toMatch(/Unlock/);
    expect(() => state.execute({ type: 'place-service', serviceType: 'water', position: { x: 200, z: -10 } })).toThrow(/Unlock/);
    state.execute({ type: 'unlock-land', tile: { x: 2, z: 1 } }); build(-100);
    const save = state.serialize(); const reload = new SimulationState(); reload.load(save);
    expect(reload.landOwnership.save()).toEqual(state.landOwnership.save()); expect(reload.graph.snapshot()).toEqual(state.graph.snapshot());
    const corrupt = structuredClone(save); corrupt.landOwnership!.ownedTiles = [{ x: 2, z: 2 }];
    const liveBefore = reload.graph.snapshot(); expect(() => reload.load(corrupt)).toThrow(/owned/); expect(reload.graph.snapshot()).toEqual(liveBefore);
  });
  it('edits Starting Area only before city founding, and City state is detached from the map', () => {
    const asset = progressiveAsset(); const editor = new SimulationState(); editor.startMapAsset(asset, true);
    editor.setLandOwnershipSettings({ mode: 'progressive', tileSizeMeters: 512, startingTiles: [{ x: 5, z: 4 }] });
    const saved = editor.exportMapAsset(identity); const city = new SimulationState(); city.startMapAsset(saved);
    expect(city.landOwnership.save().ownedTiles).toEqual([{ x: 5, z: 4 }]);
    expect(() => city.setLandOwnershipSettings(defaultLandOwnership(city.worldMetadata, 'entire-map'))).toThrow(/Map Editor/);
    saved.world.landOwnership!.startingTiles[0].x = 0; expect(city.landOwnership.save().ownedTiles).toEqual([{ x: 5, z: 4 }]);
    expect(() => editor.setLandOwnershipSettings({ mode: 'progressive', tileSizeMeters: 512, startingTiles: [{ x: 1.5, z: 0 }] })).toThrow();
  });
  it('migrates old v13 and older saves to Entire Map while rejecting corrupt owned state', () => {
    const old = new SimulationState().serialize(); delete old.landOwnership; delete old.world.metadata.landOwnership;
    const migrated = migrateSave(old); expect(migrated.landOwnership?.mode).toBe('entire-map'); expect(migrated.landOwnership?.ownedTiles).toEqual([]);
    expect(migrateSave({ ...old, saveVersion: 12 }).world.metadata.landOwnership?.mode).toBe('entire-map');
    const asset = progressiveAsset(); asset.world.landOwnership!.startingTiles = []; expect(() => new SimulationState().startMapAsset(asset)).toThrow(/Starting Area/);
  });
});
