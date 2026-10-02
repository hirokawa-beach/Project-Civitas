import { describe, it, expect } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { RailwayRenderer } from '../src/renderer/railwayRenderer';
import { railwayFixture } from './fixtures/railway';

describe('railway representation', () => {
  it('interpolates only active formations, preserves paused poses and clears replaced worlds', () => {
    const state = railwayFixture('island'), stations = [...state.railway.stations.values()];
    state.execute({ type: 'create-rail-frequency', input: { name: 'Test', color: '#58b0d0', start: 30, end: 600, frequency: 120, faceIds: stations.map(s => s.platforms[0].faces[0].platformFaceId), formationTypeId: 'commuter-2', depotId: [...state.railway.depots.keys()][0], serviceTypeId: 'local', returnService: true } });
    state.tick(3);
    const engine = new NullEngine(), scene = new Scene(engine), renderer = new RailwayRenderer(scene, () => 0);
    renderer.update(state.railway.snapshot(), 0, true); renderer.updateRuntime(state.railway.runtime()); renderer.draw({ x: 0, z: 0 }, 900); renderer.animate(30);
    const cars = scene.meshes.filter(m => m.name.startsWith('train-')); expect(cars).toHaveLength(2);
    const x = cars[0].position.x; renderer.animate(35); expect(cars[0].position.x).toBeGreaterThan(x);
    const paused = cars[0].position.clone(); renderer.animate(35); expect(cars[0].position).toEqual(paused);
    renderer.draw({ x: 10000, z: 10000 }, 300); renderer.animate(35); expect(scene.meshes.filter(m => m.name.startsWith('train-'))).toHaveLength(0);
    renderer.update(undefined, 1, true); renderer.updateRuntime(undefined); renderer.draw({ x: 0, z: 0 }, 900); renderer.animate(35); expect(scene.meshes).toHaveLength(0);
    renderer.dispose(); scene.dispose(); engine.dispose();
  });
});
