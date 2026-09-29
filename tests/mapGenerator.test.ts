import { describe, expect, it } from 'vitest';
import { generateMap, MAP_PRESETS, presetParameters, validateMap, type GenerationMetadata, type MapPreset } from '../src/terrain/generator';
import { TERRAIN_COLUMNS } from '../src/terrain/heightmap';
import { SimulationState } from '../src/simulation/state';
import { migrateSave } from '../src/save/serializer';

const settings = (preset: MapPreset, seed: string | number = 'civitas'): GenerationMetadata =>
  ({ generatorVersion: 1, seed, preset, parameters: presetParameters(preset) });

describe('procedural map generator', () => {
  it('repeats the exact heightmap for the same seed and parameters and changes with another seed', () => {
    const first = generateMap(settings('rolling-hills', 42));
    expect(generateMap(settings('rolling-hills', 42)).heights).toEqual(first.heights);
    expect(generateMap(settings('rolling-hills', '42')).heights).not.toEqual(first.heights);
    expect(generateMap(settings('rolling-hills', 43)).heights).not.toEqual(first.heights);
    expect(() => generateMap({ ...settings('rolling-hills'), generatorVersion: 2 })).toThrow(/version/);
  });

  it.each(Object.keys(MAP_PRESETS) as MapPreset[])('%s gives finite, playable terrain', (preset) => {
    for (const seed of ['civitas', 42, 'second-city']) {
      const map = generateMap(settings(preset, seed));
      expect(map.heights).toHaveLength(TERRAIN_COLUMNS ** 2);
      expect(map.heights.every(Number.isFinite)).toBe(true);
      expect(map.validation.valid).toBe(true);
      expect(map.validation.outsideRoadCandidates).toBeGreaterThan(0);
      expect(map.validation.largestBuildableAreaRatio).toBeGreaterThanOrEqual(.12);
    }
  });

  it('creates sea and land along the requested coastal edge', () => {
    const map = generateMap(settings('coastal'));
    const at = (x: number, z: number) => map.heights[z * TERRAIN_COLUMNS + x];
    const water = map.metadata.parameters.seaLevel;
    expect(at(0, 128)).toBeLessThan(water);
    expect(at(256, 128)).toBeGreaterThan(water);
    expect(map.validation.waterRatio).toBeGreaterThan(.05);
    expect(map.validation.waterRatio).toBeLessThan(.8);
  });

  it('carves a continuous river path below the static water level', () => {
    const map = generateMap(settings('river-valley'));
    expect(map.riverPaths).toHaveLength(1);
    for (const point of map.riverPaths[0]) {
      const x = Math.max(0, Math.min(256, Math.round((point.x + 512) / 4)));
      const z = Math.max(0, Math.min(256, Math.round((point.z + 512) / 4)));
      expect(map.heights[z * TERRAIN_COLUMNS + x]).toBeLessThan(map.metadata.parameters.seaLevel);
    }
  });

  it('rejects a water-only or isolated-flatland map', () => {
    const submerged = new Float32Array(TERRAIN_COLUMNS ** 2).fill(-20);
    expect(validateMap(submerged, 0).valid).toBe(false);
    const isolated = new Float32Array(TERRAIN_COLUMNS ** 2).fill(-20);
    for (let z = 120; z < 135; z++) for (let x = 120; x < 135; x++) isolated[z * TERRAIN_COLUMNS + x] = 10;
    expect(validateMap(isolated, 0).valid).toBe(false);
  });

  it('starts a city, keeps edits and exact heights through save/load, and migrates old saves', () => {
    const map = generateMap(settings('coastal', 'coast-1'));
    const city = new SimulationState();
    city.startGeneratedCity(map);
    expect(city.water.seaLevel).toBe(map.metadata.parameters.seaLevel);
    expect(city.terrain.heights).toEqual(map.heights);
    const before = city.terrain.getHeight(0, 0);
    city.beginTerrainStroke({ x: 0, z: 0 }, 'raise', 32, 20);
    city.endTerrainStroke();
    expect(city.terrain.getHeight(0, 0)).toBeGreaterThan(before);
    city.undo(); expect(city.terrain.getHeight(0, 0)).toBe(before);
    city.redo(); expect(city.terrain.getHeight(0, 0)).toBeGreaterThan(before);
    const saved = city.serialize();
    expect(saved.generation).toEqual(map.metadata);
    const loaded = new SimulationState(); loaded.load(JSON.parse(JSON.stringify(saved)));
    expect(loaded.terrain.heights).toEqual(city.terrain.heights);
    expect(loaded.generation).toEqual(map.metadata);
    const futureAlgorithm = structuredClone(saved);
    futureAlgorithm.generation!.generatorVersion = 2;
    futureAlgorithm.world.terrain.heightmap[0] = 7.25;
    loaded.load(futureAlgorithm);
    expect(loaded.terrain.heights[0]).toBe(7.25);
    expect(loaded.generation?.generatorVersion).toBe(2);
    const legacy = structuredClone(saved) as unknown as Record<string, unknown>;
    legacy.saveVersion = 11; delete legacy.generation;
    const migrated = migrateSave(legacy);
    expect(migrated.generation).toBeNull();
    expect(migrated.world.terrain.heightmap).toEqual(saved.world.terrain.heightmap);
  });
});
