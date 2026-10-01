import { createWorldMetadata } from './metadata';

export const WORLD_SIZE_OPTIONS = [1024, 4096, 8192, 16384, 32768];
export const UI_TERRAIN_SAMPLE_BUDGET = 1025 * 1025;
export function safeTerrainSpacings(width: number, depth: number): number[] {
  return [4, 8, 16, 32, 64].filter(spacing => {
    if ((width / spacing + 1) * (depth / spacing + 1) > UI_TERRAIN_SAMPLE_BUDGET) return false;
    try { createWorldMetadata({ worldWidthMeters: width, worldDepthMeters: depth, terrainSampleSpacingMeters: spacing }); return true; } catch { return false; }
  });
}
export function safeTerrainSpacing(width: number, depth: number, preferred = 4): number {
  const candidates = safeTerrainSpacings(width, depth); if (!candidates.length) throw new Error('No safe terrain spacing for these dimensions.');
  return candidates.includes(preferred) ? preferred : candidates.find(spacing => spacing >= preferred) ?? candidates[0];
}
