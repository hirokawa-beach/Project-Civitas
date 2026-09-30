import { describe, expect, it } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { SimulationState } from '../src/simulation/state';
import { createWorldMetadata, validateWorldMetadata, type WaterBody } from '../src/world/metadata';
import { Hydrography, withShoreline } from '../src/water/geometry';
import { GameRenderer } from '../src/renderer/gameRenderer';
import { generateMap, presetParameters } from '../src/terrain/generator';

const polygon = (x: number, z: number, size: number) => [{ x, z }, { x: x + size, z }, { x: x + size, z: z + size }, { x, z: z + size }];
const bodies = (): WaterBody[] => [
  withShoreline({ id: 'sea', type: 'sea', surfaceElevation: 0, geometry: { kind: 'polygon', vertices: polygon(-400, -400, 200) } }),
  withShoreline({ id: 'river', type: 'river', surfaceElevation: 12, geometry: { kind: 'river', path: [{ x: -512, z: 100 }, { x: 0, z: 100 }, { x: 512, z: 100 }], widths: [20, 30, 20] } }),
  withShoreline({ id: 'lake', type: 'lake', surfaceElevation: 32, geometry: { kind: 'polygon', vertices: polygon(150, -200, 200), holes: [polygon(220, -130, 40)] } }),
];
describe('explicit hydrography', () => {
  it('queries independent Sea / River / Lake elevations and land islands', () => {
    const world = createWorldMetadata(); const hydro = new Hydrography(bodies(), world);
    expect(hydro.bodyAt(-300, -300)?.id).toBe('sea');
    expect(hydro.waterSurfaceAt(0, 100)).toBe(12);
    expect(hydro.waterSurfaceAt(180, -180)).toBe(32);
    expect(hydro.isWaterAt(240, -110)).toBe(false);
    expect(hydro.isWaterAt(0, -300)).toBe(false);
    expect(hydro.intersectsSegment({ x: 0, z: 50 }, { x: 0, z: 150 })).toBe(true);
    expect(hydro.distanceToShoreline(-300, -300)).toBeCloseTo(100);
  });
  it('keeps water geometry and revision unchanged across terrain edits and round-trips city saves', () => {
    const state = new SimulationState(); state.setWaterBodies(bodies());
    const water = structuredClone(state.worldMetadata.waterBodies); const revision = state.water.revision;
    state.beginTerrainStroke({ x: -300, z: -300 }, 'lower', 40, 20); state.applyTerrainStroke([{ x: -300, z: -300 }], .5); state.endTerrainStroke();
    expect(state.worldMetadata.waterBodies).toEqual(water); expect(state.water.revision).toBe(revision);
    expect(state.water.isWaterAt(-300, -300, state.terrain)).toBe(true);
    expect(state.water.isWaterAt(0, 0, { getHeight: () => -80 })).toBe(false);
    const reload = new SimulationState(); reload.load(state.serialize());
    expect(reload.worldMetadata.waterBodies).toEqual(water); expect(reload.water.waterSurfaceAt(180, -180)).toBe(32);
  });
  it('safely rejects invalid and duplicate water without touching live Authority', () => {
    const state = new SimulationState(); state.setWaterBodies(bodies()); const before = state.serialize();
    expect(() => state.setWaterBodies([bodies()[0], bodies()[0]])).toThrow();
    const invalid = bodies()[0]; invalid.geometry = { kind: 'polygon', vertices: [{ x: 0, z: 0 }, { x: 40, z: 40 }, { x: 0, z: 40 }, { x: 40, z: 0 }] };
    expect(() => state.setWaterBodies([invalid])).toThrow(); expect(state.serialize().world).toEqual(before.world);
  });
  it('captures coastal/island shores once and represents river valleys with an explicit river', () => {
    for (const preset of ['coastal', 'islands', 'river-valley'] as const) {
      const map = generateMap({ generatorVersion: 1, seed: 'hydrography', preset, parameters: presetParameters(preset) });
      expect(map.world?.waterMode).toBe('explicit'); expect(map.world?.waterBodies.length).toBeGreaterThan(0);
      validateWorldMetadata(map.world!);
      expect(map.world?.waterBodies.some(body => body.type === (preset === 'river-valley' ? 'river' : 'sea'))).toBe(true);
    }
  });
  it('builds meshes only when water changes, and removes explicit meshes on legacy reload', () => {
    const engine = new NullEngine(); const scene = new Scene(engine); const state = new SimulationState(); state.setWaterBodies(bodies());
    const renderer = Object.create(GameRenderer.prototype) as GameRenderer;
    const prepare = () => { const snapshot = state.snapshot(); Object.assign(renderer, { scene, waterMaterial: new StandardMaterial('water', scene),
      appliedTerrainRevision: snapshot.terrainRevision, appliedRoadRevision: snapshot.roadRevision, appliedZoningRevision: snapshot.zoningRevision,
      appliedLotRevision: snapshot.lotRevision, appliedTrafficRevision: snapshot.traffic.revision, appliedPopulationRevision: snapshot.population.revision,
      appliedServiceRevision: snapshot.services.revision, appliedTransitRevision: snapshot.transit.revision, visualGameSeconds: 0 }); return snapshot; };
    try {
      renderer.updateSnapshot(prepare()); const lake = scene.getMeshByName('water-body-lake')!;
      expect(lake.getVerticesData('position')?.[1]).toBeCloseTo(32.04);
      state.beginTerrainStroke({ x: 180, z: -180 }, 'raise', 40, 10); state.applyTerrainStroke([{ x: 180, z: -180 }], .5); state.endTerrainStroke();
      renderer.updateSnapshot(prepare()); expect(scene.getMeshByName('water-body-lake')).toBe(lake);
      state.load(new SimulationState().serialize()); renderer.updateSnapshot(prepare());
      expect(lake.isDisposed()).toBe(true); expect(scene.getMeshByName('static-water-surface')).not.toBeNull();
    } finally { scene.dispose(); engine.dispose(); }
  });
});
