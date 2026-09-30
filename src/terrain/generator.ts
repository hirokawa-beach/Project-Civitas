import { captureGeneratedWater } from '../water/generatedWater';
import { withShoreline } from '../water/geometry';
import { createWorldMetadata, type WorldMetadata, type WorldDimensions } from '../world/metadata';

export const GENERATOR_VERSION = 1;
export type MapPreset = 'flat-plains' | 'rolling-hills' | 'river-valley' | 'coastal' | 'mountain-basin' | 'plateau' | 'islands' | 'mountainous';
export type CoastDirection = 'north' | 'east' | 'south' | 'west';
export interface GeneratorParameters {
  roughness: number;
  mountainAmount: number;
  hillScale: number;
  waterAmount: number;
  seaLevel: number;
  riverCount: number;
  riverWidth: number;
  coastBias: number;
  coastDirection: CoastDirection;
  coastIrregularity: number;
  smoothing: number;
  flatness: number;
}
export interface GenerationMetadata {
  generatorVersion: number;
  seed: string | number;
  preset: MapPreset;
  parameters: GeneratorParameters;
}
export interface MapValidation {
  valid: boolean;
  buildableLandRatio: number;
  extremeSlopeRatio: number;
  waterRatio: number;
  largestBuildableAreaRatio: number;
  outsideRoadCandidates: number;
}
export interface GeneratedMap { world?: WorldMetadata; heights: Float32Array; metadata: GenerationMetadata; validation: MapValidation; riverPaths: Array<Array<{ x: number; z: number }>> }

// These defaults are part of generator version 1. Bump GENERATOR_VERSION when changing them.
export const MAP_PRESETS: Record<MapPreset, { label: string; parameters: GeneratorParameters }> = {
  'flat-plains': { label: 'Flat Plains', parameters: { roughness: .12, mountainAmount: .02, hillScale: 210, waterAmount: 0, seaLevel: -12, riverCount: 0, riverWidth: 22, coastBias: 0, coastDirection: 'west', coastIrregularity: .2, smoothing: .65, flatness: .9 } },
  'rolling-hills': { label: 'Rolling Hills', parameters: { roughness: .43, mountainAmount: .15, hillScale: 190, waterAmount: .08, seaLevel: -12, riverCount: 0, riverWidth: 24, coastBias: 0, coastDirection: 'west', coastIrregularity: .25, smoothing: .35, flatness: .55 } },
  'river-valley': { label: 'River Valley', parameters: { roughness: .34, mountainAmount: .28, hillScale: 190, waterAmount: .3, seaLevel: 2, riverCount: 1, riverWidth: 28, coastBias: 0, coastDirection: 'west', coastIrregularity: .2, smoothing: .45, flatness: .6 } },
  coastal: { label: 'Coastal', parameters: { roughness: .3, mountainAmount: .18, hillScale: 200, waterAmount: .6, seaLevel: 0, riverCount: 0, riverWidth: 26, coastBias: .85, coastDirection: 'west', coastIrregularity: .4, smoothing: .5, flatness: .65 } },
  'mountain-basin': { label: 'Mountain Basin', parameters: { roughness: .48, mountainAmount: .8, hillScale: 170, waterAmount: .12, seaLevel: -8, riverCount: 0, riverWidth: 24, coastBias: 0, coastDirection: 'west', coastIrregularity: .2, smoothing: .4, flatness: .48 } },
  plateau: { label: 'Plateau', parameters: { roughness: .33, mountainAmount: .28, hillScale: 230, waterAmount: .05, seaLevel: -12, riverCount: 0, riverWidth: 24, coastBias: 0, coastDirection: 'west', coastIrregularity: .2, smoothing: .55, flatness: .6 } },
  islands: { label: 'Islands', parameters: { roughness: .24, mountainAmount: .16, hillScale: 200, waterAmount: .72, seaLevel: 0, riverCount: 0, riverWidth: 22, coastBias: 0, coastDirection: 'west', coastIrregularity: .3, smoothing: .7, flatness: .82 } },
  mountainous: { label: 'Mountainous', parameters: { roughness: .6, mountainAmount: .95, hillScale: 140, waterAmount: .08, seaLevel: -12, riverCount: 1, riverWidth: 20, coastBias: 0, coastDirection: 'west', coastIrregularity: .2, smoothing: .38, flatness: .38 } },
};
export const presetParameters = (preset: MapPreset): GeneratorParameters => ({ ...MAP_PRESETS[preset].parameters });
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const smooth = (t: number) => t * t * (3 - 2 * t);
const hashSeed = (seed: string | number): number => {
  let h = 2166136261;
  for (const char of `${typeof seed}:${seed}`) { h ^= char.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
};
const rng = (seed: number) => {
  let state = seed;
  return () => { state = (state + 0x6d2b79f5) | 0; let n = Math.imul(state ^ state >>> 15, 1 | state); n ^= n + Math.imul(n ^ n >>> 7, 61 | n); return ((n ^ n >>> 14) >>> 0) / 4294967296; };
};
const lattice = (x: number, z: number, seed: number): number => {
  let h = Math.imul(x, 374761393) ^ Math.imul(z, 668265263) ^ seed;
  h = Math.imul(h ^ h >>> 13, 1274126177);
  return ((h ^ h >>> 16) >>> 0) / 2147483648 - 1;
};
const noise = (x: number, z: number, scale: number, seed: number): number => {
  const a = x / scale; const b = z / scale;
  const ix = Math.floor(a); const iz = Math.floor(b);
  const tx = smooth(a - ix); const tz = smooth(b - iz);
  const top = lattice(ix, iz, seed) * (1 - tx) + lattice(ix + 1, iz, seed) * tx;
  const bottom = lattice(ix, iz + 1, seed) * (1 - tx) + lattice(ix + 1, iz + 1, seed) * tx;
  return top * (1 - tz) + bottom * tz;
};

export function validateGenerationMetadata(value: GenerationMetadata): void {
  if (!value || !Number.isInteger(value.generatorVersion) || value.generatorVersion < 1 || !(['string', 'number'].includes(typeof value.seed))
    || (typeof value.seed === 'number' && !Number.isFinite(value.seed)) || String(value.seed).length > 128
    || !(value.preset in MAP_PRESETS) || !value.parameters) throw new Error('Invalid map generator settings.');
  const p = value.parameters;
  for (const key of ['roughness', 'mountainAmount', 'waterAmount', 'coastBias', 'coastIrregularity', 'smoothing', 'flatness'] as const)
    if (!Number.isFinite(p[key]) || p[key] < 0 || p[key] > 1) throw new Error(`Invalid ${key}.`);
  if (!Number.isFinite(p.hillScale) || p.hillScale < 60 || p.hillScale > 400
    || !Number.isFinite(p.seaLevel) || p.seaLevel < -80 || p.seaLevel > 80
    || !Number.isInteger(p.riverCount) || p.riverCount < 0 || p.riverCount > 4
    || !Number.isFinite(p.riverWidth) || p.riverWidth < 8 || p.riverWidth > 80
    || !(['north', 'east', 'south', 'west'] as CoastDirection[]).includes(p.coastDirection)) throw new Error('Invalid map generator parameters.');
}

const riverPaths = (p: GeneratorParameters, random: () => number, world: WorldDimensions): GeneratedMap['riverPaths'] =>
  Array.from({ length: p.riverCount }, (_, river) => {
    const phase = random() * Math.PI * 2;
    const offset = (river - (p.riverCount - 1) / 2) * 230 + (random() - .5) * 80;
    const amplitude = 35 + random() * 45;
    const frequency = 1.2 + random() * 1.1;
    return Array.from({ length: 65 }, (_, i) => {
      const t = i / 64;
      return { x: -world.worldWidthMeters / 2 + world.worldWidthMeters * t, z: offset + amplitude * Math.sin(t * Math.PI * 2 * frequency + phase) + 22 * Math.sin(t * Math.PI * 5 + phase * .7) };
    });
  });

export function validateMap(heights: Float32Array, seaLevel: number, world: WorldDimensions = createWorldMetadata()): MapValidation {
  if (heights.length !== world.terrainColumns * world.terrainRows || !heights.every(Number.isFinite) || !Number.isFinite(seaLevel))
    throw new Error('Invalid generated heightmap.');
  const side = Math.min(64, world.terrainColumns - 1, world.terrainRows - 1); const strideX = (world.terrainColumns - 1) / side; const strideZ = (world.terrainRows - 1) / side; const buildable = new Uint8Array(side * side);
  let buildableCount = 0; let extreme = 0; let water = 0; let outsideRoadCandidates = 0;
  const at = (x: number, z: number) => heights[Math.round(z) * world.terrainColumns + Math.round(x)];
  for (let z = 0; z < side; z++) for (let x = 0; x < side; x++) {
    const sx = Math.floor(x * strideX) + 1; const sz = Math.floor(z * strideZ) + 1;
    const h = at(sx, sz);
    const slope = Math.max(Math.abs(at(sx + 2, sz) - at(sx - 1, sz)), Math.abs(at(sx, sz + 2) - at(sx, sz - 1))) / (3 * world.terrainSampleSpacingMeters);
    if (h <= seaLevel) water++;
    else if (slope < .12) { buildable[z * side + x] = 1; buildableCount++; }
    if (slope > .4) extreme++;
  }
  const queue = new Int32Array(side * side); let largest = 0;
  for (let i = 0; i < buildable.length; i++) if (buildable[i]) {
    let head = 0; let tail = 0; queue[tail++] = i; buildable[i] = 0;
    while (head < tail) {
      const n = queue[head++]; const x = n % side; const z = Math.floor(n / side);
      for (const next of [x > 0 ? n - 1 : -1, x < side - 1 ? n + 1 : -1, z > 0 ? n - side : -1, z < side - 1 ? n + side : -1])
        if (next >= 0 && buildable[next]) { buildable[next] = 0; queue[tail++] = next; }
    }
    largest = Math.max(largest, tail);
  }
  const edgeOk = (x: number, z: number) => {
    const h = at(x, z);
    return h > seaLevel + 1 && Math.abs(h - at(clamp(x + 2, 0, world.terrainColumns - 1), clamp(z + 2, 0, world.terrainRows - 1))) < 2;
  };
  for (let i = 8; i < Math.min(world.terrainColumns, world.terrainRows) - 8; i += 4) {
    if (edgeOk(i, 2) && edgeOk(i + 4, 2)) outsideRoadCandidates++;
    if (edgeOk(i, world.terrainRows - 3) && edgeOk(i + 4, world.terrainRows - 3)) outsideRoadCandidates++;
    if (edgeOk(2, i) && edgeOk(2, i + 4)) outsideRoadCandidates++;
    if (edgeOk(world.terrainColumns - 3, i) && edgeOk(world.terrainColumns - 3, i + 4)) outsideRoadCandidates++;
  }
  const total = side * side;
  const result = { buildableLandRatio: buildableCount / total, extremeSlopeRatio: extreme / total,
    waterRatio: water / total, largestBuildableAreaRatio: largest / total, outsideRoadCandidates };
  return { ...result, valid: result.buildableLandRatio >= .2 && result.extremeSlopeRatio < .45
    && result.waterRatio < .8 && result.largestBuildableAreaRatio >= .12 && outsideRoadCandidates > 0 };
}

function generateAttempt(metadata: GenerationMetadata, attempt: number, world: WorldMetadata): GeneratedMap {
  const p = metadata.parameters; const seed = hashSeed(metadata.seed) ^ Math.imul(attempt + 1, 0x9e3779b9);
  const roughness = p.roughness * (1 - attempt * .12);
  const mountainAmount = p.mountainAmount * (1 - attempt * .16);
  const flatness = Math.min(1, p.flatness + attempt * .15);
  const random = rng(seed); const offsets = Array.from({ length: 4 }, () => (random() - .5) * 2000);
  const paths = riverPaths(p, random, world);
  const heights = new Float32Array(world.terrainColumns * world.terrainRows);
  const smoothFactor = 1 - p.smoothing * .65;
  for (let z = 0; z < world.terrainRows; z++) for (let x = 0; x < world.terrainColumns; x++) {
    const wx = x * world.terrainSampleSpacingMeters - world.worldWidthMeters / 2;
    const wz = z * world.terrainSampleSpacingMeters - world.worldDepthMeters / 2;
    const low = noise(wx + offsets[0], wz + offsets[1], p.hillScale * 2.2, seed);
    const mid = noise(wx + offsets[2], wz + offsets[1], p.hillScale, seed + 31);
    const fine = noise(wx + offsets[0], wz + offsets[3], Math.max(32, p.hillScale / 3), seed + 79);
    const ridge = 1 - Math.abs(noise(wx + offsets[3], wz + offsets[2], p.hillScale * 1.3, seed + 137));
    let h = 18 + low * 11 * roughness + mid * 13 * roughness * smoothFactor
      + fine * 5 * roughness * smoothFactor + Math.pow(ridge, 3) * 55 * mountainAmount * (1 - flatness * .55);
    h -= p.waterAmount * 26 * smooth(clamp((-low - .05) / .7, 0, 1));
    const radial = Math.hypot(wx / (world.worldWidthMeters / 2), wz / (world.worldDepthMeters / 2));
    if (metadata.preset === 'mountain-basin') h += Math.pow(clamp(radial, 0, 1.5), 2) * 55 * mountainAmount - 12;
    if (metadata.preset === 'plateau') h += 27 * smooth(clamp((radial - .38) / .14, 0, 1));
    if (metadata.preset === 'islands') {
      // One natural peninsula reaches the east edge for an outside connection.
      const access = smooth(clamp((wx - 160) / 300, 0, 1)) * (1 - smooth(clamp((Math.abs(wz) - 65) / 90, 0, 1)));
      h -= 55 * smooth(clamp((radial - .46) / .54, 0, 1)) * (.5 + p.waterAmount * .5) * (1 - access);
      h += access * 10;
    }
    if (p.coastBias > 0) {
      const direction = p.coastDirection === 'west' ? -wx : p.coastDirection === 'east' ? wx : p.coastDirection === 'north' ? -wz : wz;
      const irregularity = noise(wx + 500, wz - 500, 170, seed + 211) * p.coastIrregularity * 80;
      const shore = smooth(clamp((direction + irregularity + 130) / 360, 0, 1));
      h -= shore * (36 + 24 * p.waterAmount) * p.coastBias;
    }
    // A gentle central district is deliberately kept large enough for a first road network.
    const centerMask = 1 - smooth(clamp((radial - .12) / .38, 0, 1));
    if (metadata.preset !== 'islands') h += (18 - h) * centerMask * flatness * .6;
    for (const path of paths) {
      let closest = Infinity;
      // Paths run west to east, so nearby points occupy at most two short segments.
      const segment = clamp(Math.floor((wx + world.worldWidthMeters / 2) / (world.worldWidthMeters / 64)), 0, 63);
      for (let k = Math.max(0, segment - 1); k <= Math.min(63, segment + 1); k++) {
        const a = path[k]; const b = path[k + 1];
        const t = clamp(((wx - a.x) * (b.x - a.x) + (wz - a.z) * (b.z - a.z)) / ((b.x - a.x) ** 2 + (b.z - a.z) ** 2), 0, 1);
        closest = Math.min(closest, Math.hypot(wx - a.x - t * (b.x - a.x), wz - a.z - t * (b.z - a.z)));
      }
      const valley = 1 - smooth(clamp((closest - p.riverWidth * .5) / (p.riverWidth * 3), 0, 1));
      h -= valley * 12;
      const channel = 1 - smooth(clamp((closest - p.riverWidth * .3) / (p.riverWidth * .8), 0, 1));
      h = h * (1 - channel) + Math.min(h, p.seaLevel - 2) * channel;
    }
    h += attempt * 2;
    heights[Math.round(z) * world.terrainColumns + Math.round(x)] = clamp(h, -80, 240);
  }
  world.generatorMetadata = structuredClone(metadata); world.source.kind = 'procedural';
  world.waterMode = 'explicit';
  world.waterBodies = paths.map((path, i) => withShoreline({ id: `generated-river-${i + 1}`, type: 'river', surfaceElevation: p.seaLevel, geometry: { kind: 'river', path, widths: path.map(() => p.riverWidth) } }, world));
  if (metadata.preset === 'coastal' || metadata.preset === 'islands') world.waterBodies.push(...captureGeneratedWater(heights, p.seaLevel, world, 'sea'));
  else if (!paths.length && p.waterAmount > 0) world.waterBodies.push(...captureGeneratedWater(heights, p.seaLevel, world, 'lake'));
  return { world: structuredClone(world), heights, metadata: structuredClone(metadata), validation: validateMap(heights, p.seaLevel, world), riverPaths: paths };
}

export function generateMap(metadata: GenerationMetadata, dimensions: Partial<WorldDimensions> = {}): GeneratedMap {
  const world = createWorldMetadata(dimensions);
  validateGenerationMetadata(metadata);
  if (metadata.generatorVersion !== GENERATOR_VERSION) throw new Error('Unsupported map generator version.');
  let result = generateAttempt(metadata, 0, world);
  for (let attempt = 1; attempt < 4 && !result.validation.valid; attempt++) result = generateAttempt(metadata, attempt, world);
  return result;
}
