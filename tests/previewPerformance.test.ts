import { describe, expect, it } from 'vitest';
import { buildTwoCurveGeometry } from '../src/roads/curveGeometry';
import { RoadGraph } from '../src/roads/roadGraph';
import { RoadSpatialIndex } from '../src/roads/spatialIndex';
import { validateRoadCandidate } from '../src/roads/validation';

describe('curve preview locality', () => {
  it('keeps repeated preview validation local in a 100-road grid', () => {
    const graph = new RoadGraph();
    for (let row = 0; row < 10; row += 1) {
      for (let column = 0; column < 10; column += 1) {
        const x = -450 + column * 90;
        const z = -450 + row * 90;
        graph.buildRoad({
          geometry: { kind: 'straight', points: [{ x, z }, { x: x + 24, z }] },
          roadTypeId: 'small',
        });
      }
    }
    const index = new RoadSpatialIndex();
    index.rebuild(graph.snapshot());
    const started = performance.now();
    let largestCandidateSet = 0;
    for (let iteration = 0; iteration < 50; iteration += 1) {
      const offset = iteration * 0.1;
      const curve = buildTwoCurveGeometry({
        start: { x: -180, z: -140 },
        firstDirectionPoint: { x: -140, z: -140 },
        secondDirectionPoint: { x: -90, z: -90 - offset },
        end: { x: -50, z: -90 - offset },
        startTangent: { x: 1, z: 0 },
        endTangent: { x: 1, z: 0 },
      });
      const nearby = index.query(curve.points, 24);
      largestCandidateSet = Math.max(largestCandidateSet, nearby.segments.length);
      validateRoadCandidate(nearby, curve.points, { candidateWidth: 16, minimumCurveRadius: 24 });
    }
    const elapsed = performance.now() - started;
    console.info(`50 dense-grid curve previews: ${elapsed.toFixed(1)} ms; largest candidate set: ${largestCandidateSet}/100 roads`);
    expect(largestCandidateSet).toBeLessThan(20);
  });
});
