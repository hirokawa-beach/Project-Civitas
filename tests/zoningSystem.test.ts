import { describe, expect, it } from 'vitest';
import { RoadGraph } from '../src/roads/roadGraph';
import { generateZoningCells } from '../src/zoning/generator';
import { ZoningSystem } from '../src/zoning/system';

describe('ZoningSystem', () => {
  it('replaces only dirty chunk results while matching full generation', () => {
    const graph = new RoadGraph();
    const zoning = new ZoningSystem();
    graph.buildRoad({ geometry: { kind: 'straight', points: [{ x: -430, z: -300 }, { x: -300, z: -300 }] }, roadTypeId: 'small' });
    zoning.update(graph.snapshot());
    expect(zoning.getUpdatedChunkIds()).toHaveLength(16);

    graph.buildRoad({ geometry: { kind: 'straight', points: [{ x: 300, z: 300 }, { x: 430, z: 300 }] }, roadTypeId: 'small' });
    const incremental = zoning.update(graph.snapshot());
    const full = generateZoningCells(graph.snapshot());
    expect(zoning.getUpdatedChunkIds().length).toBeLessThan(16);
    expect(incremental.map((cell) => cell.id).sort()).toEqual(full.map((cell) => cell.id).sort());
  });

  it('does no zoning work when road geometry is unchanged', () => {
    const graph = new RoadGraph();
    const zoning = new ZoningSystem();
    graph.buildRoad({ geometry: { kind: 'straight', points: [{ x: -80, z: 0 }, { x: 80, z: 0 }] }, roadTypeId: 'small' });
    zoning.update(graph.snapshot());
    const first = zoning.update(graph.snapshot());
    expect(zoning.getUpdatedChunkIds()).toEqual([]);
    expect(first.length).toBeGreaterThan(0);
  });

  it('regenerates both sides of a chunk boundary without diverging from a full generation', () => {
    const graph = new RoadGraph();
    const zoning = new ZoningSystem();
    graph.buildRoad({ geometry: { kind: 'straight', points: [{ x: -160, z: 16 }, { x: 160, z: 16 }] }, roadTypeId: 'small' });
    zoning.update(graph.snapshot());

    graph.buildRoad({ geometry: { kind: 'straight', points: [{ x: 0, z: -120 }, { x: 0, z: 144 }] }, roadTypeId: 'small' });
    const incremental = zoning.update(graph.snapshot());
    const full = generateZoningCells(graph.snapshot());

    expect(zoning.getUpdatedChunkIds()).toContain('chunk-1-2');
    expect(zoning.getUpdatedChunkIds()).toContain('chunk-2-2');
    expect(incremental).toEqual([...full].sort((left, right) => left.id.localeCompare(right.id)));
    expect(new Set(incremental.map((cell) => cell.id)).size).toBe(incremental.length);
  });

  it('keeps disconnected dirty regions separate instead of regenerating their bounding rectangle', () => {
    const graph = new RoadGraph();
    const zoning = new ZoningSystem();
    zoning.update(graph.snapshot());
    graph.buildRoad({ geometry: { kind: 'straight', points: [{ x: -470, z: -400 }, { x: -430, z: -400 }] }, roadTypeId: 'small' });
    graph.buildRoad({ geometry: { kind: 'straight', points: [{ x: 430, z: 400 }, { x: 470, z: 400 }] }, roadTypeId: 'small' });

    const incremental = zoning.update(graph.snapshot());
    const full = generateZoningCells(graph.snapshot());

    expect(zoning.getUpdatedChunkIds()).toEqual(['chunk-0-0', 'chunk-3-3']);
    expect(incremental).toEqual([...full].sort((left, right) => left.id.localeCompare(right.id)));
  });

  it('matches a fresh load after both endpoints split the same segment', () => {
    const graph = new RoadGraph();
    const zoning = new ZoningSystem();
    zoning.update(graph.snapshot());
    graph.buildRoad({
      geometry: { kind: 'straight', points: [{ x: -180, z: 0 }, { x: 180, z: 0 }] },
      roadTypeId: 'small',
    });
    zoning.update(graph.snapshot());

    graph.buildRoad({
      geometry: {
        kind: 'polyline',
        points: [{ x: -63, z: 0 }, { x: -63, z: 96 }, { x: 57, z: 96 }, { x: 57, z: 0 }],
      },
      roadTypeId: 'small',
      endpointIntents: {
        start: { kind: 'segment', segmentId: 'segment-1', position: { x: -63, z: 0 } },
        end: { kind: 'segment', segmentId: 'segment-1', position: { x: 57, z: 0 } },
      },
    });
    const incremental = zoning.update(graph.snapshot());
    const full = generateZoningCells(graph.snapshot());
    const reloaded = new ZoningSystem();
    reloaded.update({ nodes: [], segments: [], lanes: [] });
    const afterLoad = reloaded.update(graph.snapshot());

    expect(incremental).toEqual([...full].sort((left, right) => left.id.localeCompare(right.id)));
    expect(afterLoad).toEqual(incremental);
  });
});
