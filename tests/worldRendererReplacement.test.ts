import { describe, expect, it } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { GameRenderer } from '../src/renderer/gameRenderer';
import { SimulationState } from '../src/simulation/state';
import { createWorldMetadata } from '../src/world/metadata';

describe('large to small world Renderer replacement', () => {
  it('disposes cached zoning and debug zoning outside the new world through the actual snapshot gate', () => {
    const engine = new NullEngine(); const scene = new Scene(engine); const renderer = Object.create(GameRenderer.prototype) as GameRenderer;
    const inside = new Mesh('old-zone-inside', scene); const outside = new Mesh('old-zone-outside', scene); const debug = new Mesh('old-zone-debug-outside', scene);
    const snapshot = new SimulationState().snapshot(false);
    Object.assign(renderer, { scene, snapshot: { ...snapshot, worldMetadata: createWorldMetadata({ worldWidthMeters: 32768, worldDepthMeters: 32768, terrainSampleSpacingMeters: 32 }) },
      waterMaterial: new StandardMaterial('water', scene), zoneMeshes: new Map([['chunk-0-0:residential', inside], ['chunk-120-120:residential', outside]]), zoningDebugMeshes: new Map([['chunk-120-120', debug]]),
      visualGameSeconds: 0, appliedWaterRevision: snapshot.water.revision, appliedTerrainRevision: snapshot.terrainRevision, appliedRoadRevision: snapshot.roadRevision, appliedZoningRevision: -1,
      appliedLotRevision: snapshot.lotRevision, appliedTrafficRevision: snapshot.traffic.revision, appliedPopulationRevision: snapshot.population.revision, appliedServiceRevision: snapshot.services.revision, appliedTransitRevision: snapshot.transit.revision, debugVisible: false });
    try { renderer.updateSnapshot(snapshot); expect(inside.isDisposed()).toBe(true); expect(outside.isDisposed()).toBe(true); expect(debug.isDisposed()).toBe(true); expect(scene.getMeshByName('old-zone-outside')).toBeNull(); }
    finally { scene.dispose(); engine.dispose(); }
  });
});
