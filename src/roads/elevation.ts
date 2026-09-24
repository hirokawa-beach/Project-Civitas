import type { Vec3 } from '../terrain/heightmap';
import type { Vec2 } from '../world/types';
import { closestPointOnPolyline, pointAtDistance, polylineLength } from './geometry';
import type { RoadGeometry, RoadStructureType, RoadTypeDefinition } from './types';

const SPACING = 4;
const interpolate = (a: number, b: number, t: number): number => a + (b - a) * t;
const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

export interface RoadElevationProfile {
  centerline: Vec3[];
  maximumGrade: number;
  minimumClearance: number;
  transitionLength: number;
  valid: boolean;
  reason?: 'steep-grade' | 'insufficient-clearance' | 'short-transition';
}

/** Construct a ground-following or independently elevated deck with ground-level entry/exit ramps. */
export function profileRoadElevation(points: readonly Vec2[], structure: RoadStructureType,
  targetElevation: number, terrainHeight: (x: number, z: number) => number,
  config: Pick<RoadTypeDefinition, 'maximumGrade' | 'minimumVerticalClearance' | 'structureTransitionLength'>,
  waterLevel = Number.NEGATIVE_INFINITY): RoadElevationProfile {
  const length = polylineLength(points);
  const start = points[0]; const end = points[points.length - 1];
  const startHeight = terrainHeight(start.x, start.z); const endHeight = terrainHeight(end.x, end.z);
  const deck = structure === 'tunnel' ? Math.min(startHeight, endHeight) - targetElevation
    : Math.max(startHeight, endHeight, structure === 'bridge' ? waterLevel : Number.NEGATIVE_INFINITY) + targetElevation;
  const startRun = structure === 'ground' ? 0 : Math.max(config.structureTransitionLength, Math.abs(deck - startHeight) / config.maximumGrade);
  const endRun = structure === 'ground' ? 0 : Math.max(config.structureTransitionLength, Math.abs(deck - endHeight) / config.maximumGrade);
  const transitionLength = Math.max(startRun, endRun);
  const tooShort = structure !== 'ground' && length < startRun + endRun + 8;
  const steps = Math.max(1, Math.ceil(length / SPACING));
  const distances = Array.from({ length: steps + 1 }, (_, index) => length * index / steps);
  let vertexDistance = 0;
  for (let index = 1; index < points.length - 1; index += 1) {
    vertexDistance += Math.hypot(points[index].x - points[index - 1].x, points[index].z - points[index - 1].z);
    distances.push(vertexDistance);
  }
  distances.sort((a, b) => a - b);
  const samples = distances.filter((along, index) => index === 0 || along - distances[index - 1] > 1e-5);
  const centerline: Vec3[] = [];
  let minimumClearance = Infinity; let maximumGrade = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const along = samples[index];
    const point = pointAtDistance(points, along).point;
    const terrain = terrainHeight(point.x, point.z);
    let y = terrain;
    if (structure !== 'ground') {
      y = along < startRun ? interpolate(startHeight, deck, clamp01(along / startRun))
        : along > length - endRun ? interpolate(endHeight, deck, clamp01((length - along) / endRun)) : deck;
      if (along >= startRun && along <= length - endRun)
        minimumClearance = Math.min(minimumClearance, structure === 'tunnel' ? terrain - y
          : y - Math.max(terrain, structure === 'bridge' ? waterLevel : Number.NEGATIVE_INFINITY));
    }
    centerline.push({ x: point.x, y, z: point.z });
    if (index > 0) {
      const prior = centerline[index - 1];
      maximumGrade = Math.max(maximumGrade, Math.abs(y - prior.y) / Math.hypot(point.x - prior.x, point.z - prior.z));
    }
  }
  const reason = tooShort ? 'short-transition'
    : maximumGrade > config.maximumGrade + 0.005 ? 'steep-grade'
      : structure !== 'ground' && minimumClearance < config.minimumVerticalClearance - 0.1 ? 'insufficient-clearance' : undefined;
  return { centerline, maximumGrade, minimumClearance, transitionLength, valid: !reason, reason };
}

/** Sample the recorded 3D centerline at an X/Z position without touching Terrain. */
export function roadHeightAt(geometry: RoadGeometry, point: Vec2, terrainHeight?: (x: number, z: number) => number): number {
  const centerline = geometry.centerline;
  if (!centerline || centerline.length < 2) return terrainHeight?.(point.x, point.z) ?? 0;
  const projected = closestPointOnPolyline(point, centerline);
  let remaining = projected.along;
  for (let index = 1; index < centerline.length; index += 1) {
    const a = centerline[index - 1]; const b = centerline[index];
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    if (remaining <= length || index === centerline.length - 1) return interpolate(a.y, b.y, clamp01(remaining / Math.max(length, 1e-6)));
    remaining -= length;
  }
  return centerline.at(-1)!.y;
}

/** Preserve the exact recorded elevation profile when an existing segment is split. */
export function sliceRoadCenterline(geometry: RoadGeometry, from: number, to: number): Vec3[] | undefined {
  if (!geometry.centerline) return undefined;
  const planar = geometry.centerline.map(({ x, z }) => ({ x, z }));
  const result: Vec3[] = [];
  const sample = (along: number): Vec3 => {
    const point = pointAtDistance(planar, along).point;
    return { ...point, y: roadHeightAt(geometry, point) };
  };
  result.push(sample(from));
  let traversed = 0;
  for (let index = 1; index < planar.length - 1; index += 1) {
    traversed += Math.hypot(planar[index].x - planar[index - 1].x, planar[index].z - planar[index - 1].z);
    if (traversed > from + 1e-5 && traversed < to - 1e-5) result.push({ ...geometry.centerline[index] });
  }
  result.push(sample(to));
  return result;
}
