import type { Vec2 } from '../world/types';

/** Shared horizontal ribbon geometry for rendering and authoritative land checks. */
export function roadRibbonSides(points: readonly Vec2[], width: number, spacing: number): [Vec2[], Vec2[]] {
  const sampled: Vec2[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]; const b = points[i];
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / spacing));
    for (let step = 0; step < steps; step++) {
      const t = step / steps; sampled.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
    }
  }
  if (points.length) sampled.push(points[points.length - 1]);
  const left: Vec2[] = []; const right: Vec2[] = [];
  for (let i = 0; i < sampled.length; i++) {
    const a = sampled[Math.max(0, i - 1)]; const b = sampled[Math.min(sampled.length - 1, i + 1)];
    const length = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    const dx = -(b.z - a.z) * width / (2 * length); const dz = (b.x - a.x) * width / (2 * length);
    left.push({ x: sampled[i].x + dx, z: sampled[i].z + dz });
    right.push({ x: sampled[i].x - dx, z: sampled[i].z - dz });
  }
  return [left, right];
}
