import type { ZoningCell } from './types';
import type { Vec2 } from '../world/types';

const BUCKET_SIZE = 16;
const bucketKey = (x: number, z: number): string => `${x}:${z}`;

export interface ScreenPoint { x: number; y: number }
export interface ScreenRect { left: number; top: number; right: number; bottom: number }

export const screenRect = (start: ScreenPoint, end: ScreenPoint): ScreenRect => ({
  left: Math.min(start.x, end.x), top: Math.min(start.y, end.y),
  right: Math.max(start.x, end.x), bottom: Math.max(start.y, end.y),
});

/** A cell is selected when any portion of its projected quadrilateral meets the marquee. */
export const cellIntersectsScreenRect = (
  cell: ZoningCell,
  rect: ScreenRect,
  project: (point: Vec2) => ScreenPoint | undefined,
): boolean => {
  const corners = cell.corners.map(project);
  if (corners.some((corner) => !corner)) return false;
  const polygon = corners as ScreenPoint[];
  const axes: ScreenPoint[] = [{ x: 1, y: 0 }, { x: 0, y: 1 }];
  for (let index = 0; index < polygon.length; index += 1) {
    const a = polygon[index];
    const b = polygon[(index + 1) % polygon.length];
    axes.push({ x: b.y - a.y, y: a.x - b.x });
  }
  const rectangle = [
    { x: rect.left, y: rect.top }, { x: rect.right, y: rect.top },
    { x: rect.right, y: rect.bottom }, { x: rect.left, y: rect.bottom },
  ];
  return axes.every((axis) => {
    const cellValues = polygon.map((point) => point.x * axis.x + point.y * axis.y);
    const rectValues = rectangle.map((point) => point.x * axis.x + point.y * axis.y);
    return Math.max(...cellValues) >= Math.min(...rectValues)
      && Math.max(...rectValues) >= Math.min(...cellValues);
  });
};

export const pointInZoningCell = (point: Vec2, cell: Pick<ZoningCell, 'corners'>): boolean => {
  let inside = false;
  for (let index = 0, previous = cell.corners.length - 1; index < cell.corners.length; previous = index, index += 1) {
    const a = cell.corners[previous];
    const b = cell.corners[index];
    const cross = (b.x - a.x) * (point.z - a.z) - (b.z - a.z) * (point.x - a.x);
    if (Math.abs(cross) < 1e-6
      && point.x >= Math.min(a.x, b.x) - 1e-6 && point.x <= Math.max(a.x, b.x) + 1e-6
      && point.z >= Math.min(a.z, b.z) - 1e-6 && point.z <= Math.max(a.z, b.z) + 1e-6) return true;
    if ((a.z > point.z) !== (b.z > point.z)
      && point.x < (b.x - a.x) * (point.z - a.z) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
};

/** Small world-space buckets keep brush hit-testing local in a dense city. */
export class ZoningCellIndex {
  private readonly buckets = new Map<string, ZoningCell[]>();

  rebuild(cells: readonly ZoningCell[]): void {
    this.buckets.clear();
    for (const cell of cells) {
      if (cell.terrainSuitable === false) continue;
      const minX = Math.min(...cell.corners.map((corner) => corner.x));
      const maxX = Math.max(...cell.corners.map((corner) => corner.x));
      const minZ = Math.min(...cell.corners.map((corner) => corner.z));
      const maxZ = Math.max(...cell.corners.map((corner) => corner.z));
      for (let x = Math.floor(minX / BUCKET_SIZE); x <= Math.floor(maxX / BUCKET_SIZE); x += 1) {
        for (let z = Math.floor(minZ / BUCKET_SIZE); z <= Math.floor(maxZ / BUCKET_SIZE); z += 1) {
          const key = bucketKey(x, z);
          const bucket = this.buckets.get(key) ?? [];
          bucket.push(cell);
          this.buckets.set(key, bucket);
        }
      }
    }
  }

  pick(point: Vec2): ZoningCell | undefined {
    return this.buckets.get(bucketKey(Math.floor(point.x / BUCKET_SIZE), Math.floor(point.z / BUCKET_SIZE)))
      ?.find((cell) => pointInZoningCell(point, cell));
  }

  queryBounds(minX: number, minZ: number, maxX: number, maxZ: number): ZoningCell[] {
    const found = new Map<string, ZoningCell>();
    for (let x = Math.floor(minX / BUCKET_SIZE); x <= Math.floor(maxX / BUCKET_SIZE); x += 1) {
      for (let z = Math.floor(minZ / BUCKET_SIZE); z <= Math.floor(maxZ / BUCKET_SIZE); z += 1) {
        for (const cell of this.buckets.get(bucketKey(x, z)) ?? []) {
          if (cell.corners.every((corner) => corner.x < minX)
            || cell.corners.every((corner) => corner.x > maxX)
            || cell.corners.every((corner) => corner.z < minZ)
            || cell.corners.every((corner) => corner.z > maxZ)) continue;
          found.set(cell.id, cell);
        }
      }
    }
    return [...found.values()];
  }
}
