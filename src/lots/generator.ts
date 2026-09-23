import type { Vec2 } from '../world/types';
import type { ZoningCell } from '../zoning/types';
import type { ZoningCellId } from '../shared/ids';
import { LOT_SIZES, definitionForLot } from './definitions';
import type { Lot } from './types';

const CELL_SIZE = 8;
const EDGE_TOLERANCE = 2.5;
const BUCKET = 16;
const distance = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.z - b.z);
const bucketKey = (x: number, z: number): string => `${x}:${z}`;
const edgeMatches = (a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean =>
  distance(a, c) <= EDGE_TOLERANCE && distance(b, d) <= EDGE_TOLERANCE;

export function generateLots(cells: readonly ZoningCell[], getHeight: (x: number, z: number) => number): Lot[] {
  const eligible = cells.filter((cell) => cell.zoneType && cell.terrainSuitable !== false);
  const buckets = new Map<string, ZoningCell[]>();
  for (const cell of eligible) {
    const key = bucketKey(Math.floor(cell.center.x / BUCKET), Math.floor(cell.center.z / BUCKET));
    const bucket = buckets.get(key) ?? [];
    bucket.push(cell);
    buckets.set(key, bucket);
  }
  const nearby = (cell: ZoningCell): ZoningCell[] => {
    const x = Math.floor(cell.center.x / BUCKET);
    const z = Math.floor(cell.center.z / BUCKET);
    const found: ZoningCell[] = [];
    for (let dz = -1; dz <= 1; dz += 1) for (let dx = -1; dx <= 1; dx += 1) {
      found.push(...(buckets.get(bucketKey(x + dx, z + dz)) ?? []));
    }
    return found;
  };
  const right = new Map<ZoningCellId, ZoningCell>();
  const rear = new Map<ZoningCellId, ZoningCell>();
  for (const cell of eligible) {
    const candidates = nearby(cell).filter((other) => other.id !== cell.id && other.zoneType === cell.zoneType);
    const rightCandidate = candidates.filter((other) => other.depth === cell.depth
      && edgeMatches(cell.corners[1], cell.corners[2], other.corners[0], other.corners[3]))
      .sort((a, b) => distance(a.center, cell.center) - distance(b.center, cell.center) || a.id.localeCompare(b.id))[0];
    if (rightCandidate) right.set(cell.id, rightCandidate);
    const rearCandidate = candidates.filter((other) => other.depth === cell.depth + 1
      && edgeMatches(cell.corners[3], cell.corners[2], other.corners[0], other.corners[1]))
      .sort((a, b) => distance(a.center, cell.center) - distance(b.center, cell.center) || a.id.localeCompare(b.id))[0];
    if (rearCandidate) rear.set(cell.id, rearCandidate);
  }

  const front = eligible.filter((cell) => cell.depth === 0).sort((a, b) => a.id.localeCompare(b.id));
  const frontIds = new Set<ZoningCellId>(front.map((cell) => cell.id));
  const predecessors = new Set([...right.entries()].filter(([id, next]) => frontIds.has(id) && frontIds.has(next.id)).map(([, next]) => next.id));
  const chains: ZoningCell[][] = [];
  const visited = new Set<string>();
  for (const start of [...front.filter((cell) => !predecessors.has(cell.id)), ...front]) {
    if (visited.has(start.id)) continue;
    const chain: ZoningCell[] = [];
    let cursor: ZoningCell | undefined = start;
    while (cursor && !visited.has(cursor.id)) {
      visited.add(cursor.id);
      chain.push(cursor);
      cursor = right.get(cursor.id);
    }
    chains.push(chain);
  }

  const used = new Set<string>();
  const lots: Lot[] = [];
  for (const chain of chains) for (const anchor of chain) {
    if (used.has(anchor.id)) continue;
    for (const [widthCells, depthCells] of LOT_SIZES) {
      const rectangle: ZoningCell[][] = [];
      let row = anchor;
      let valid = true;
      for (let depth = 0; depth < depthCells && valid; depth += 1) {
        const line: ZoningCell[] = [];
        let column: ZoningCell | undefined = row;
        for (let width = 0; width < widthCells; width += 1) {
          if (!column || used.has(column.id) || column.zoneType !== anchor.zoneType || column.depth !== depth) { valid = false; break; }
          if (depth > 0 && rear.get(rectangle[depth - 1][width].id)?.id !== column.id) { valid = false; break; }
          line.push(column);
          column = right.get(column.id);
        }
        if (valid) { rectangle.push(line); row = rear.get(row.id)!; }
      }
      if (!valid) continue;
      const flat = rectangle.flat();
      const corners: Lot['corners'] = [
        rectangle[0][0].corners[0], rectangle[0][widthCells - 1].corners[1],
        rectangle[depthCells - 1][widthCells - 1].corners[2], rectangle[depthCells - 1][0].corners[3],
      ];
      const position = { x: flat.reduce((sum, cell) => sum + cell.center.x, 0) / flat.length,
        z: flat.reduce((sum, cell) => sum + cell.center.z, 0) / flat.length };
      const samplePoints = flat.flatMap((cell) => [...cell.corners, cell.center]);
      const elevations = samplePoints.map((point) => getHeight(point.x, point.z));
      const minElevation = Math.min(...elevations);
      const maxElevation = Math.max(...elevations);
      const averageElevation = elevations.reduce((sum, height) => sum + height, 0) / elevations.length;
      const slope = (maxElevation - minElevation) / Math.max(CELL_SIZE, Math.min(widthCells, depthCells) * CELL_SIZE);
      const definition = definitionForLot(anchor.zoneType!, widthCells, depthCells);
      const buildable = !!definition && slope >= definition.minSlope && slope <= definition.maxSlope
        && maxElevation - minElevation <= 8;
      const id = `lot-${anchor.id}-${widthCells}x${depthCells}` as const;
      const lot: Lot = {
        id, zoneType: anchor.zoneType!, zoneCellIds: flat.map((cell) => cell.id).sort(),
        roadAccess: { roadSegmentId: anchor.roadSegmentId,
          frontage: [corners[0], corners[1]] },
        widthCells, depthCells, width: widthCells * CELL_SIZE, depth: depthCells * CELL_SIZE,
        position, rotation: Math.atan2(corners[1].z - corners[0].z, corners[1].x - corners[0].x), corners,
        averageElevation, minElevation, maxElevation, baseElevation: averageElevation, slope, buildable,
      };
      lots.push(lot);
      for (const cell of flat) used.add(cell.id);
      break;
    }
  }
  return lots.sort((a, b) => a.id.localeCompare(b.id));
}
