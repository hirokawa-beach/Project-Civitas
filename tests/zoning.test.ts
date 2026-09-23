import { describe, expect, it } from 'vitest';
import type { RoadGraphSnapshot, RoadSegment } from '../src/roads/types';
import type { Vec2 } from '../src/world/types';
import { generateZoningCells, type ZoningGenerationStats } from '../src/zoning/generator';
import type { ZoningCell } from '../src/zoning/types';

const road = (
  id: number,
  startNodeId: number,
  endNodeId: number,
  points: Vec2[],
  width = 16,
): RoadSegment => ({
  id: `segment-${id}`,
  startNodeId: `node-${startNodeId}`,
  endNodeId: `node-${endNodeId}`,
  geometry: { kind: 'straight', points },
  roadTypeId: 'small',
  width,
  speedLimit: 40,
  laneIds: [],
  zoningAllowed: true,
});

const graph = (positions: Vec2[], segments: RoadSegment[]): RoadGraphSnapshot => ({
  nodes: positions.map((position, index) => ({ id: `node-${index + 1}`, position })),
  segments,
  lanes: [],
});

const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.z * b.z;

const overlaps = (a: ZoningCell, b: ZoningCell): boolean => {
  for (const corners of [a.corners, b.corners]) {
    for (let index = 0; index < corners.length; index += 1) {
      const start = corners[index];
      const end = corners[(index + 1) % corners.length];
      const axis = { x: -(end.z - start.z), z: end.x - start.x };
      const aProjections = a.corners.map((corner) => dot(corner, axis));
      const bProjections = b.corners.map((corner) => dot(corner, axis));
      if (Math.max(...aProjections) <= Math.min(...bProjections) + 1e-4 ||
          Math.max(...bProjections) <= Math.min(...aProjections) + 1e-4) return false;
    }
  }
  return true;
};

const pointToSegment = (point: Vec2, start: Vec2, end: Vec2): number => {
  const delta = { x: end.x - start.x, z: end.z - start.z };
  const lengthSquared = dot(delta, delta);
  const offset = { x: point.x - start.x, z: point.z - start.z };
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, dot(offset, delta) / lengthSquared));
  return Math.hypot(point.x - (start.x + delta.x * t), point.z - (start.z + delta.z * t));
};

const distanceToCell = (point: Vec2, cell: ZoningCell): number => Math.min(
  ...cell.corners.map((corner, index) => pointToSegment(point, corner, cell.corners[(index + 1) % cell.corners.length])),
);

describe('generateZoningCells', () => {
  it('keeps ordinary straight-road cells as complete 8 m squares', () => {
    const snapshot = graph(
      [{ x: 0, z: 0 }, { x: 64, z: 0 }],
      [road(1, 1, 2, [{ x: 0, z: 0 }, { x: 64, z: 0 }])],
    );

    const cells = generateZoningCells(snapshot);

    expect(cells).toHaveLength(8 * 2 * 6);
    for (const cell of cells) {
      expect(cell.size).toBe(8);
      for (let index = 0; index < cell.corners.length; index += 1) {
        const a = cell.corners[index];
        const b = cell.corners[(index + 1) % cell.corners.length];
        expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeCloseTo(8, 8);
      }
    }
  });

  it('does not accept intersecting rotated cells inside an acute road triangle', () => {
    const positions = [{ x: -80, z: -50 }, { x: 80, z: -50 }, { x: 0, z: 90 }];
    const snapshot = graph(positions, [
      road(1, 1, 2, [positions[0], positions[1]]),
      road(2, 2, 3, [positions[1], positions[2]]),
      road(3, 3, 1, [positions[2], positions[0]]),
    ]);

    const cells = generateZoningCells(snapshot);

    expect(cells.length).toBeGreaterThan(0);
    for (let first = 0; first < cells.length; first += 1) {
      for (let second = first + 1; second < cells.length; second += 1) {
        expect(overlaps(cells[first], cells[second]), `${cells[first].id} overlaps ${cells[second].id}`).toBe(false);
      }
    }
  });

  it('keeps the outer frontage continuous along a straight leg of a narrow V', () => {
    const leftStart = { x: -40, z: -100 };
    const rightStart = { x: 20, z: -100 };
    const apex = { x: 0, z: 100 };
    const snapshot = graph([leftStart, rightStart, apex], [
      road(1, 1, 3, [leftStart, apex]),
      road(2, 2, 3, [rightStart, apex]),
    ]);
    const cells = generateZoningCells(snapshot);
    for (let x = -96; x < 64; x += 32) {
      for (let z = -112; z < 112; z += 32) {
        const bounds = { minX: x, maxX: x + 32, minZ: z, maxZ: z + 32 };
        expect(generateZoningCells(snapshot, { bounds }), `${x}:${z}`).toEqual(cells.filter((cell) =>
          cell.center.x >= bounds.minX && cell.center.x < bounds.maxX
          && cell.center.z >= bounds.minZ && cell.center.z < bounds.maxZ,
        ));
      }
    }
    const outerRoadside = cells.filter((cell) => cell.roadSegmentId === 'segment-1' && cell.side === 1 && cell.depth === 0);
    const direction = { x: apex.x - leftStart.x, z: apex.z - leftStart.z };
    const length = Math.hypot(direction.x, direction.z);
    const along = outerRoadside.map((cell) => ((cell.center.x - leftStart.x) * direction.x
      + (cell.center.z - leftStart.z) * direction.z) / length).sort((a, b) => a - b);
    expect(along.length).toBeGreaterThan(20);
    for (let index = 1; index < along.length; index += 1) {
      expect(along[index] - along[index - 1]).toBeLessThan(8.5);
    }
  });

  it('keeps a usable roadside row on the concave side of a broad curve', () => {
    const radius = 96;
    const steps = 72;
    const points = Array.from({ length: steps + 1 }, (_, index) => {
      const angle = index / steps * Math.PI * 1.5;
      return { x: Math.cos(angle) * radius, z: Math.sin(angle) * radius };
    });
    const curvedRoad = road(1, 1, 2, points, 12);
    curvedRoad.geometry.kind = 'curve';
    const snapshot = graph([points[0], points.at(-1)!], [curvedRoad]);

    const cells = generateZoningCells(snapshot);
    const innerRoadside = cells.filter((cell) => cell.side === 1 && cell.depth === 0);

    // Centerline sampling compresses on the inside of an arc. We still expect
    // regularly distributed buildable frontage instead of one surviving cell
    // followed by a transitive rejection gap.
    expect(innerRoadside.length).toBeGreaterThan(50);
    for (let first = 0; first < cells.length; first += 1) {
      for (let second = first + 1; second < cells.length; second += 1) {
        expect(overlaps(cells[first], cells[second]), `${cells[first].id} overlaps ${cells[second].id}`).toBe(false);
      }
    }

    for (const minX of [-120, 0]) {
      for (const minZ of [-120, 0]) {
        const bounds = { minX, maxX: minX + 120, minZ, maxZ: minZ + 120 };
        const expected = cells.filter((cell) =>
          cell.center.x >= bounds.minX && cell.center.x < bounds.maxX
          && cell.center.z >= bounds.minZ && cell.center.z < bounds.maxZ,
        );
        expect(generateZoningCells(snapshot, { bounds })).toEqual(expected);
      }
    }
  }, 15_000);

  it('rejects a whole cell when one edge intrudes into another road surface', () => {
    const snapshot = graph(
      [
        { x: 0, z: 0 }, { x: 80, z: 0 },
        { x: 0, z: 23.8 }, { x: 80, z: 23.8 },
      ],
      [
        road(1, 1, 2, [{ x: 0, z: 0 }, { x: 80, z: 0 }]),
        road(2, 3, 4, [{ x: 0, z: 23.8 }, { x: 80, z: 23.8 }]),
      ],
    );

    const cells = generateZoningCells(snapshot);
    const firstRoadNearSide = cells.filter((cell) => cell.roadSegmentId === 'segment-1' && cell.side === 1 && cell.depth === 0);

    expect(firstRoadNearSide).toHaveLength(0);
    expect(cells.some((cell) => cell.roadSegmentId === 'segment-1' && cell.side === -1 && cell.depth === 0)).toBe(true);
  });

  it('keeps cells outside the full intersection clearance at a two-road corner', () => {
    const snapshot = graph(
      [{ x: -64, z: 0 }, { x: 0, z: 0 }, { x: 0, z: 64 }],
      [
        road(1, 1, 2, [{ x: -64, z: 0 }, { x: 0, z: 0 }]),
        road(2, 2, 3, [{ x: 0, z: 0 }, { x: 0, z: 64 }]),
      ],
    );

    const cells = generateZoningCells(snapshot);

    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) expect(distanceToCell({ x: 0, z: 0 }, cell)).toBeGreaterThanOrEqual(16 - 1e-4);
  });

  it('does not create an artificial gap at a straight degree-two node', () => {
    const snapshot = graph(
      [{ x: -64, z: 0 }, { x: 0, z: 0 }, { x: 64, z: 0 }],
      [
        road(1, 1, 2, [{ x: -64, z: 0 }, { x: 0, z: 0 }]),
        road(2, 2, 3, [{ x: 0, z: 0 }, { x: 64, z: 0 }]),
      ],
    );

    const cells = generateZoningCells(snapshot);

    expect(cells.some((cell) => distanceToCell({ x: 0, z: 0 }, cell) < 16)).toBe(true);
  });

  it('returns a deterministic center-bounded slice of full-map generation', () => {
    const snapshot = graph(
      [{ x: -64, z: 0 }, { x: 64, z: 0 }],
      [road(1, 1, 2, [{ x: -64, z: 0 }, { x: 64, z: 0 }])],
    );
    const bounds = { minX: -32, maxX: 32, minZ: -30, maxZ: 30 };
    const allCells = generateZoningCells(snapshot);
    const boundedCells = generateZoningCells(snapshot, { bounds });
    const expected = allCells.filter((cell) =>
      cell.center.x >= bounds.minX && cell.center.x < bounds.maxX &&
      cell.center.z >= bounds.minZ && cell.center.z < bounds.maxZ,
    );

    expect(boundedCells.map((cell) => cell.id)).toEqual(expected.map((cell) => cell.id));
  });

  it('matches a full slice when competing rotated cells cross the bounds', () => {
    const positions = [{ x: -80, z: -50 }, { x: 80, z: -50 }, { x: 0, z: 90 }];
    const snapshot = graph(positions, [
      road(1, 1, 2, [positions[0], positions[1]]),
      road(2, 2, 3, [positions[1], positions[2]]),
      road(3, 3, 1, [positions[2], positions[0]]),
    ]);
    const bounds = { minX: -11, maxX: 29, minZ: -17, maxZ: 31 };
    const expected = generateZoningCells(snapshot).filter((cell) =>
      cell.center.x >= bounds.minX && cell.center.x < bounds.maxX
      && cell.center.z >= bounds.minZ && cell.center.z < bounds.maxZ,
    );

    expect(generateZoningCells(snapshot, { bounds })).toEqual(expected);
  });

  it('evaluates only nearby columns and obstacles for a bounded slice', () => {
    const snapshot = graph(
      [
        { x: -480, z: 0 }, { x: 480, z: 0 },
        { x: -480, z: 300 }, { x: 480, z: 300 },
        { x: -480, z: -300 }, { x: 480, z: -300 },
      ],
      [
        road(1, 1, 2, [{ x: -480, z: 0 }, { x: 480, z: 0 }]),
        road(2, 3, 4, [{ x: -480, z: 300 }, { x: 480, z: 300 }]),
        road(3, 5, 6, [{ x: -480, z: -300 }, { x: 480, z: -300 }]),
      ],
    );
    const bounds = { minX: -64, maxX: 64, minZ: -64, maxZ: 64 };
    const fullStats: Partial<ZoningGenerationStats> = {};
    const localStats: Partial<ZoningGenerationStats> = {};
    const allCells = generateZoningCells(snapshot, { stats: fullStats });
    const boundedCells = generateZoningCells(snapshot, { bounds, stats: localStats });
    const expected = allCells.filter((cell) =>
      cell.center.x >= bounds.minX && cell.center.x < bounds.maxX
      && cell.center.z >= bounds.minZ && cell.center.z < bounds.maxZ,
    );

    expect(boundedCells).toEqual(expected);
    expect(localStats.segmentsEvaluated).toBe(1);
    expect(localStats.roadPartsIndexed).toBe(1);
    expect(localStats.candidateColumnsEvaluated!).toBeLessThan(fullStats.candidateColumnsEvaluated! / 4);
    expect(localStats.candidateCentersEvaluated!).toBeLessThan(fullStats.candidateCentersEvaluated! / 4);
  });

  it('preserves world-derived IDs and 8 m phase across an arbitrary segment split', () => {
    const original = graph(
      [{ x: -50, z: 0 }, { x: 70, z: 0 }],
      [{
        ...road(1, 1, 2, [{ x: -50, z: 0 }, { x: 70, z: 0 }]),
        zoningLineageId: 'roadline-9',
        zoningStartOffset: 0,
      }],
    );
    const split = graph(
      [{ x: -50, z: 0 }, { x: -13, z: 0 }, { x: 70, z: 0 }],
      [
        {
          ...road(2, 1, 2, [{ x: -50, z: 0 }, { x: -13, z: 0 }]),
          zoningLineageId: 'roadline-9',
          zoningStartOffset: 0,
        },
        {
          ...road(3, 2, 3, [{ x: -13, z: 0 }, { x: 70, z: 0 }]),
          zoningLineageId: 'roadline-9',
          zoningStartOffset: 37,
        },
      ],
    );

    const before = generateZoningCells(original);
    const after = generateZoningCells(split);
    expect(after.map((cell) => cell.id).sort()).toEqual(before.map((cell) => cell.id).sort());
    expect(after.map((cell) => cell.center).sort((a, b) => a.x - b.x || a.z - b.z))
      .toEqual(before.map((cell) => cell.center).sort((a, b) => a.x - b.x || a.z - b.z));
    expect(new Set(after.map((cell) => cell.id)).size).toBe(after.length);
  });

  it('normalizes harmless floating-point drift in world-derived IDs', () => {
    const makeSnapshot = (drift: number): RoadGraphSnapshot => graph(
      [{ x: -50 + drift, z: drift }, { x: 70 + drift, z: drift }],
      [{
        ...road(1, 1, 2, [{ x: -50 + drift, z: drift }, { x: 70 + drift, z: drift }]),
        zoningLineageId: 'roadline-1',
        zoningStartOffset: 0,
      }],
    );

    const stable = generateZoningCells(makeSnapshot(0)).map((cell) => cell.id).sort();
    const drifted = generateZoningCells(makeSnapshot(1e-7)).map((cell) => cell.id).sort();
    expect(drifted).toEqual(stable);
  });
});
