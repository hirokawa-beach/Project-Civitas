import { describe, expect, it } from 'vitest';
import { RoadGraph } from '../src/roads/roadGraph';
import { RoadSpatialIndex } from '../src/roads/spatialIndex';

describe('RoadSpatialIndex', () => {
  it('returns nearby roads without scanning distant map regions', () => {
    const graph = new RoadGraph();
    for (let row = 0; row < 8; row += 1) {
      graph.buildRoad({
        geometry: { kind: 'straight', points: [{ x: -450, z: -420 + row * 40 }, { x: -350, z: -420 + row * 40 }] },
        roadTypeId: 'small',
      });
      graph.buildRoad({
        geometry: { kind: 'straight', points: [{ x: 350, z: 120 + row * 40 }, { x: 450, z: 120 + row * 40 }] },
        roadTypeId: 'small',
      });
    }
    const index = new RoadSpatialIndex();
    index.rebuild(graph.snapshot());
    const nearby = index.query([{ x: -400, z: -420 }], 20);
    expect(nearby.segments.length).toBeGreaterThan(0);
    expect(nearby.segments.length).toBeLessThan(graph.segments.size);
    expect(nearby.segments.every((segment) => segment.geometry.points[0].x < 0)).toBe(true);
  });

  it('deduplicates long segments stored in several buckets', () => {
    const graph = new RoadGraph();
    graph.buildRoad({ geometry: { kind: 'straight', points: [{ x: -300, z: 0 }, { x: 300, z: 0 }] }, roadTypeId: 'small' });
    const index = new RoadSpatialIndex();
    index.rebuild(graph.snapshot());
    expect(index.query([{ x: -200, z: 0 }, { x: 200, z: 0 }], 20).segments).toHaveLength(1);
  });
});
