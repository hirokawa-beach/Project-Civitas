import { describe, expect, it } from 'vitest';
import { createWorldMetadata, validateWorldMetadata, worldBounds } from '../src/world/metadata';
import { SimulationState } from '../src/simulation/state';
import { migrateSave } from '../src/save/serializer';

describe('shared World / Map schema', () => {
  it('describes legacy metres and independent rectangular resolution', () => {
    expect(createWorldMetadata()).toMatchObject({ mapSchemaVersion: 1, worldWidthMeters: 1024,
      terrainColumns: 257, terrainRows: 257, terrainSampleSpacingMeters: 4, chunkSizeMeters: 256 });
    const world = createWorldMetadata({ worldWidthMeters: 4096, worldDepthMeters: 2048, terrainSampleSpacingMeters: 8 });
    expect(world.terrainColumns).toBe(513); expect(world.terrainRows).toBe(257);
    expect(worldBounds(world)).toEqual({ minX: -2048, maxX: 2048, minZ: -1024, maxZ: 1024 });
  });
  it('rejects inconsistent dimensions, schemas and metadata without touching the live city', () => {
    for (const patch of [{ worldWidthMeters: NaN }, { terrainSampleSpacingMeters: 3 }, { worldDepthMeters: 0 }])
      expect(() => createWorldMetadata(patch)).toThrow();
    expect(() => validateWorldMetadata({ ...createWorldMetadata(), terrainColumns: 10 })).toThrow();
    const city = new SimulationState(); const save = city.serialize(); const before = city.serialize();
    save.world.metadata.mapSchemaVersion = 99 as 1;
    expect(() => city.load(save)).toThrow(); expect(city.serialize().world).toEqual(before.world);
  });
  it('migrates v12 and retains metadata in detached City Saves', () => {
    const city = new SimulationState(); const current = city.serialize();
    const old = { ...current, saveVersion: 12 as const, world: { width: 1024, depth: 1024, terrain: current.world.terrain } };
    const migrated = migrateSave(old);
    expect(migrated.saveVersion).toBe(13); expect(migrated.world.metadata.waterMode).toBe('legacy-height');
    city.load(migrated);
    const saved = city.serialize(); saved.world.metadata.source.name = 'external edit';
    expect(city.worldMetadata.source.name).toBeUndefined();
    expect(city.snapshot(false).worldMetadata).toEqual(migrated.world.metadata);
  });
});
