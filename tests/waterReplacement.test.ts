import { describe, expect, it } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { GameRenderer } from '../src/renderer/gameRenderer';
import { SimulationState } from '../src/simulation/state';
import { migrateSave } from '../src/save/serializer';
import { generateMap, presetParameters } from '../src/terrain/generator';
import type { WorldSnapshot } from '../src/shared/protocol';

const coastal = () => generateMap({ generatorVersion: 1, seed: 'water-regression', preset: 'coastal', parameters: presetParameters('coastal') });
const saveAt = (level: number) => { const state = new SimulationState(); state.water.setSeaLevel(level); return state.serialize(); };

describe('water synchronization across world replacement', () => {
  it('keeps revisions increasing from coastal New Game to a migrated legacy save and A → B → A', () => {
    const state = new SimulationState();
    const authority = state.water;
    let revision = authority.revision;
    state.startGeneratedCity(coastal());
    expect(state.water.revision).toBeGreaterThan(revision);
    revision = state.water.revision;
    const a = migrateSave({ ...saveAt(-12), saveVersion: 11, generation: undefined }); const b = saveAt(8);
    for (const save of [a, b, a, a]) {
      state.load(save);
      expect(state.water).toBe(authority);
      expect(state.water.seaLevel).toBe(save.water.seaLevel);
      expect(state.water.revision).toBeGreaterThan(revision);
      revision = state.water.revision;
    }
  });

  it('does not change water or its revision when world validation fails', () => {
    const state = new SimulationState(); state.startGeneratedCity(coastal());
    const before = state.water.snapshot();
    const corrupt = saveAt(-12); corrupt.world.terrain.heightmap[0] = NaN;
    expect(() => state.load(corrupt)).toThrow();
    expect(state.water.snapshot()).toEqual(before);
  });

  it('updates the actual Babylon water plane for coastal → legacy A → B → A, including same-level replacement', () => {
    const engine = new NullEngine(); const scene = new Scene(engine);
    // Use the real snapshot gate and mesh creation, without browser camera/DOM setup.
    // Other domains are synchronized so this fixture isolates the water revision gate.
    const renderer = Object.create(GameRenderer.prototype) as GameRenderer;
    Object.assign(renderer, { scene, waterMaterial: new StandardMaterial('water', scene), appliedWaterRevision: -1, visualGameSeconds: 0, debugVisible: false });
    const synchronizeOtherDomains = (s: WorldSnapshot) => Object.assign(renderer, {
      appliedTerrainRevision: s.terrainRevision, appliedRoadRevision: s.roadRevision,
      appliedZoningRevision: s.zoningRevision, appliedLotRevision: s.lotRevision,
      appliedTrafficRevision: s.traffic.revision, appliedPopulationRevision: s.population.revision,
      appliedServiceRevision: s.services.revision, appliedTransitRevision: s.transit.revision,
    });
    const state = new SimulationState(); state.startGeneratedCity(coastal());
    const legacy = migrateSave({ ...saveAt(-12), saveVersion: 11, generation: undefined });
    try {
      for (const save of [undefined, legacy, saveAt(8), legacy, legacy]) {
        if (save) state.load(save);
        const snapshot = state.snapshot(); synchronizeOtherDomains(snapshot);
        const previous = scene.getMeshByName('static-water-surface');
        renderer.updateSnapshot(snapshot);
        const plane = scene.getMeshByName('static-water-surface')!;
        expect(plane.position.y).toBeCloseTo(snapshot.water.seaLevel + .04);
        expect(plane).not.toBe(previous);
        if (previous) expect(previous.isDisposed()).toBe(true);
      }
    } finally { scene.dispose(); engine.dispose(); }
  });
});
