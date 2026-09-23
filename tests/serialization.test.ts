import { describe, expect, it } from 'vitest';
import { RoadGraph } from '../src/roads/roadGraph';
import { deserializeWorld, migrateSave, serializeWorld } from '../src/save/serializer';
import { SimulationState } from '../src/simulation/state';

describe('save serialization', () => {
  it('round-trips graph IDs, geometry, lanes, terrain, and game clock', () => {
    const graph = new RoadGraph();
    graph.buildRoad({
      geometry: { kind: 'curve', points: [{ x: -40, z: 0 }, { x: 0, z: 30 }, { x: 40, z: 20 }] },
      roadTypeId: 'small',
    });
    const source = {
      terrain: { width: 1024, depth: 1024, baseHeight: 0 },
      roadGraph: graph.snapshot(),
      gameClock: { gameSeconds: 12_345, speed: 4 as const },
      zoningAssignments: [],
    };
    const encoded = serializeWorld(source);
    const decoded = deserializeWorld(JSON.parse(JSON.stringify(encoded)));
    expect(decoded.roadGraph).toEqual(source.roadGraph);
    expect(decoded.gameClock).toEqual(source.gameClock);
    expect(decoded.zoningAssignments).toEqual(source.zoningAssignments);
    expect(decoded.terrain.heightmap).toHaveLength(257 * 257);
    expect(decoded.terrain.terrainVersion).toBe(1);
    expect(encoded.saveVersion).toBe(6);
    expect(() => new RoadGraph(decoded.roadGraph).assertIntegrity()).not.toThrow();
  });

  it('migrates v1 roads to deterministic zoning lineages', () => {
    const graph = new RoadGraph();
    graph.buildRoad({
      geometry: { kind: 'straight', points: [{ x: -40, z: 0 }, { x: 40, z: 0 }] },
      roadTypeId: 'small',
    });
    const legacy = serializeWorld({
      terrain: { width: 1024, depth: 1024, baseHeight: 0 },
      roadGraph: graph.snapshot(),
      gameClock: { gameSeconds: 0, speed: 1 as const },
      zoningAssignments: [],
    }) as unknown as Record<string, unknown>;
    legacy.saveVersion = 1;
    (legacy.world as { terrain: Record<string, unknown> }).terrain = { width: 1024, depth: 1024, baseHeight: 0 };
    const legacyGraph = legacy.roadGraph as ReturnType<RoadGraph['snapshot']>;
    for (const segment of legacyGraph.segments) {
      delete segment.zoningLineageId;
      delete segment.zoningStartOffset;
    }

    const first = migrateSave(legacy);
    const second = migrateSave(legacy);
    expect(first).toEqual(second);
    expect(first.saveVersion).toBe(6);
    expect(first.world.terrain.heightmap[0]).toBe(0);
    expect(first.roadGraph.segments[0]).toMatchObject({
      zoningLineageId: 'roadline-1',
      zoningStartOffset: 0,
    });
    expect(deserializeWorld(legacy).roadGraph).toEqual(first.roadGraph);
  });

  it('migrates v2 saves to unpainted v4 terrain without changing roads', () => {
    const graph = new RoadGraph();
    graph.buildRoad({ geometry: { kind: 'straight', points: [{ x: -40, z: 0 }, { x: 40, z: 0 }] }, roadTypeId: 'small' });
    const legacy = serializeWorld({
      terrain: { width: 1024, depth: 1024, baseHeight: 0 }, roadGraph: graph.snapshot(),
      gameClock: { gameSeconds: 42, speed: 1 }, zoningAssignments: [],
    }) as unknown as Record<string, unknown>;
    legacy.saveVersion = 2;
    delete legacy.zoningAssignments;
    (legacy.world as { terrain: Record<string, unknown> }).terrain = { width: 1024, depth: 1024, baseHeight: 0 };
    const migrated = migrateSave(legacy);
    expect(migrated.saveVersion).toBe(6);
    expect(migrated.zoningAssignments).toEqual([]);
    expect(deserializeWorld(legacy).roadGraph).toEqual(graph.snapshot());
  });

  it('migrates v3 zoning saves to a flat heightmap without losing assignments', () => {
    const state = new SimulationState();
    state.execute({ type: 'build-road', input: { geometry: { kind: 'straight', points: [{ x: -40, z: 0 }, { x: 40, z: 0 }] }, roadTypeId: 'small' } });
    const id = state.snapshot().zoningCells[0].id;
    state.execute({ type: 'set-zone', cellIds: [id], zoneType: 'office' });
    const legacy = state.serialize() as unknown as Record<string, unknown>;
    legacy.saveVersion = 3;
    (legacy.world as { terrain: Record<string, unknown> }).terrain = { width: 1024, depth: 1024, baseHeight: 0 };
    const restored = new SimulationState();
    restored.load(legacy as unknown as ReturnType<SimulationState['serialize']>);
    expect(restored.snapshot().zoningCells.find((cell) => cell.id === id)?.zoneType).toBe('office');
    expect(restored.terrain.getHeight(0, 0)).toBe(0);
  });

  it('migrates v4 terrain and zoning into generated lots and buildings', () => {
    const state = new SimulationState();
    state.execute({ type: 'build-road', input: { geometry: { kind: 'straight', points: [{ x: -80, z: 0 }, { x: 80, z: 0 }] }, roadTypeId: 'small' } });
    state.execute({ type: 'set-zone', cellIds: state.snapshot().zoningCells.map((cell) => cell.id), zoneType: 'office' });
    const legacy = state.serialize() as unknown as Record<string, unknown>;
    legacy.saveVersion = 4;
    delete legacy.lots;
    delete legacy.buildings;
    const restored = new SimulationState();
    restored.load(legacy as unknown as ReturnType<SimulationState['serialize']>);
    expect(restored.snapshot().lots.length).toBeGreaterThan(0);
    expect(restored.snapshot().buildings.length).toBeGreaterThan(0);
    expect(restored.snapshot().buildings.every((building) => building.definitionId.includes('office'))).toBe(true);
  });

  it('rejects a corrupt save without partially replacing live state', () => {
    const simulation = new SimulationState();
    simulation.graph.buildRoad({
      geometry: { kind: 'straight', points: [{ x: -50, z: 0 }, { x: 50, z: 0 }] },
      roadTypeId: 'small',
    });
    const before = simulation.graph.snapshot();
    const corrupt = simulation.serialize();
    corrupt.roadGraph.nodes[0].position.x = Number.NaN;
    expect(() => simulation.load(corrupt)).toThrow(/non-finite/);
    expect(simulation.graph.snapshot()).toEqual(before);
  });
});
