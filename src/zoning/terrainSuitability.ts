import type { ZoningCell } from './types';

// Lots on steep or strongly uneven terrain are not usable. Keep this derived
// from the heightmap so editing terrain never changes a cell's stable ID.
export const MAX_ZONE_SLOPE = 0.5;
export const MAX_ZONE_HEIGHT_SPREAD = 4;
const SAMPLE_INTERVALS = 4;

export function isTerrainSuitableForZone(cell: Pick<ZoningCell, 'corners'>, getHeight: (x: number, z: number) => number): boolean {
  const heights: number[][] = [];
  const points = cell.corners;
  let lowest = Infinity;
  let highest = -Infinity;
  for (let row = 0; row <= SAMPLE_INTERVALS; row += 1) {
    const v = row / SAMPLE_INTERVALS;
    const samples: number[] = [];
    for (let column = 0; column <= SAMPLE_INTERVALS; column += 1) {
      const u = column / SAMPLE_INTERVALS;
      const nearX = points[0].x * (1 - u) + points[1].x * u;
      const nearZ = points[0].z * (1 - u) + points[1].z * u;
      const farX = points[3].x * (1 - u) + points[2].x * u;
      const farZ = points[3].z * (1 - u) + points[2].z * u;
      const height = getHeight(nearX * (1 - v) + farX * v, nearZ * (1 - v) + farZ * v);
      samples.push(height);
      lowest = Math.min(lowest, height);
      highest = Math.max(highest, height);
    }
    heights.push(samples);
  }
  if (highest - lowest > MAX_ZONE_HEIGHT_SPREAD) return false;
  for (let row = 0; row <= SAMPLE_INTERVALS; row += 1) for (let column = 0; column <= SAMPLE_INTERVALS; column += 1) {
    if (column < SAMPLE_INTERVALS) {
      const a = points[0]; const b = points[1]; const c = points[3]; const d = points[2];
      const ux = ((b.x - a.x) * (1 - row / SAMPLE_INTERVALS) + (d.x - c.x) * row / SAMPLE_INTERVALS) / SAMPLE_INTERVALS;
      const uz = ((b.z - a.z) * (1 - row / SAMPLE_INTERVALS) + (d.z - c.z) * row / SAMPLE_INTERVALS) / SAMPLE_INTERVALS;
      if (Math.abs(heights[row][column + 1] - heights[row][column]) > Math.hypot(ux, uz) * MAX_ZONE_SLOPE) return false;
    }
    if (row < SAMPLE_INTERVALS) {
      const a = points[0]; const b = points[3]; const c = points[1]; const d = points[2];
      const vx = ((b.x - a.x) * (1 - column / SAMPLE_INTERVALS) + (d.x - c.x) * column / SAMPLE_INTERVALS) / SAMPLE_INTERVALS;
      const vz = ((b.z - a.z) * (1 - column / SAMPLE_INTERVALS) + (d.z - c.z) * column / SAMPLE_INTERVALS) / SAMPLE_INTERVALS;
      if (Math.abs(heights[row + 1][column] - heights[row][column]) > Math.hypot(vx, vz) * MAX_ZONE_SLOPE) return false;
    }
  }
  return true;
}
