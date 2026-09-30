import type { WaterBody, WaterPolygon, WorldDimensions } from '../world/metadata';
import type { Vec2 } from '../world/types';
import { ringArea, withShoreline } from './geometry';

/** Capture a generated shoreline once. Subsequent terrain brushes never run this conversion. */
export function captureGeneratedWater(heights: Float32Array, elevation: number, world: WorldDimensions, type: 'sea' | 'lake'): WaterBody[] {
  const stride = Math.max(1, Math.round(8 / world.terrainSampleSpacingMeters));
  const columns = Math.ceil((world.terrainColumns - 1) / stride); const rows = Math.ceil((world.terrainRows - 1) / stride);
  const wet = new Uint8Array(columns * rows);
  for (let z = 0; z < rows; z++) for (let x = 0; x < columns; x++) {
    const sx = Math.min(world.terrainColumns - 1, x * stride + Math.floor(stride / 2));
    const sz = Math.min(world.terrainRows - 1, z * stride + Math.floor(stride / 2));
    wet[z * columns + x] = heights[sz * world.terrainColumns + sx] < elevation ? 1 : 0;
  }
  const bodies: WaterBody[] = []; const queue = new Int32Array(wet.length);
  const vertex = (x: number, z: number) => `${x}:${z}`;
  for (let start = 0; start < wet.length; start++) if (wet[start] === 1) {
    let head = 0; let tail = 0; queue[tail++] = start; wet[start] = 2;
    const edges = new Map<string, string[]>();
    const add = (ax: number, az: number, bx: number, bz: number) => {
      const key = vertex(ax, az); const list = edges.get(key) ?? []; list.push(vertex(bx, bz)); edges.set(key, list);
    };
    while (head < tail) {
      const cell = queue[head++]; const x = cell % columns; const z = Math.floor(cell / columns);
      const neighbors = [z > 0 ? cell - columns : -1, x < columns - 1 ? cell + 1 : -1, z < rows - 1 ? cell + columns : -1, x > 0 ? cell - 1 : -1];
      if (neighbors[0] < 0 || !wet[neighbors[0]]) add(x, z, x + 1, z);
      if (neighbors[1] < 0 || !wet[neighbors[1]]) add(x + 1, z, x + 1, z + 1);
      if (neighbors[2] < 0 || !wet[neighbors[2]]) add(x + 1, z + 1, x, z + 1);
      if (neighbors[3] < 0 || !wet[neighbors[3]]) add(x, z + 1, x, z);
      for (const next of neighbors) if (next >= 0 && wet[next] === 1) { wet[next] = 2; queue[tail++] = next; }
    }
    const rings: Vec2[][] = [];
    while (edges.size) {
      const first = edges.keys().next().value!; let key = first; const ring: Vec2[] = [];
      do {
        const [x, z] = key.split(':').map(Number);
        ring.push({ x: Math.min(world.worldWidthMeters, x * stride * world.terrainSampleSpacingMeters) - world.worldWidthMeters / 2,
          z: Math.min(world.worldDepthMeters, z * stride * world.terrainSampleSpacingMeters) - world.worldDepthMeters / 2 });
        const list = edges.get(key)!; const next = list.pop()!; if (!list.length) edges.delete(key); key = next;
      } while (key !== first && edges.has(key));
      const simplified = ring.filter((p, i) => {
        const a = ring[(i + ring.length - 1) % ring.length]; const b = ring[(i + 1) % ring.length];
        return Math.abs((p.x - a.x) * (b.z - p.z) - (p.z - a.z) * (b.x - p.x)) > 1e-8;
      });
      if (simplified.length >= 3) rings.push(simplified);
    }
    const outer = rings.filter(r => ringArea(r) > 0); const holes = rings.filter(r => ringArea(r) < 0);
    if (!outer.length) continue;
    // A four-connected component has one outer shoreline; land islands become holes.
    const polygons: WaterPolygon[] = outer.map((vertices, i) => ({ vertices, holes: i === 0 ? holes : [] }));
    bodies.push(withShoreline({ id: `generated-${type}-${bodies.length + 1}`, type,
      surfaceElevation: elevation, geometry: { kind: 'multipolygon', polygons } }, world));
  }
  return bodies;
}
