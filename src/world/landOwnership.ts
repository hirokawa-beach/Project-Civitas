import type { Vec2 } from './types';
import { roadRibbonSides } from '../roads/footprint';

export interface PhysicalWorld { worldWidthMeters: number; worldDepthMeters: number; terrainSampleSpacingMeters?: number }
export interface LandTile { x: number; z: number }
export type LandOwnershipMode = 'progressive' | 'entire-map';
export interface LandOwnershipSettings { mode: LandOwnershipMode; tileSizeMeters: number; startingTiles: LandTile[] }
export interface LandOwnershipSave { mode: LandOwnershipMode; tileSizeMeters: number; ownedTiles: LandTile[] }
export type ConstructionFootprint = { kind: 'polygon'; points: readonly Vec2[] } | { kind: 'path'; points: readonly Vec2[]; width: number };
export const entireMapOwnership = (): LandOwnershipSettings => ({ mode: 'entire-map', tileSizeMeters: 1024, startingTiles: [] });
export const tileKey = (tile: LandTile) => `${tile.x}:${tile.z}`;
export function landTileAt(point: Vec2, world: PhysicalWorld, size: number): LandTile {
  return { x: Math.max(0, Math.min(Math.ceil(world.worldWidthMeters / size) - 1, Math.floor((point.x + world.worldWidthMeters / 2) / size))),
    z: Math.max(0, Math.min(Math.ceil(world.worldDepthMeters / size) - 1, Math.floor((point.z + world.worldDepthMeters / 2) / size))) };
}
export function defaultLandOwnership(world: PhysicalWorld, mode: LandOwnershipMode, tileSizeMeters = 1024): LandOwnershipSettings {
  return { mode, tileSizeMeters, startingTiles: mode === 'progressive' ? [landTileAt({ x: 0, z: 0 }, world, tileSizeMeters)] : [] };
}
export function landTileBounds(tile: LandTile, world: PhysicalWorld, size: number) {
  const minX = -world.worldWidthMeters / 2 + tile.x * size; const minZ = -world.worldDepthMeters / 2 + tile.z * size;
  return { minX, minZ, maxX: Math.min(world.worldWidthMeters / 2, minX + size), maxZ: Math.min(world.worldDepthMeters / 2, minZ + size) };
}
export function validateLandTiles(tiles: LandTile[], world: PhysicalWorld, size: number): void {
  if (!Array.isArray(tiles) || tiles.length > 65536) throw new Error('Invalid land tiles.');
  const ids = new Set<string>();
  for (const tile of tiles) {
    if (!tile || !Number.isInteger(tile.x) || !Number.isInteger(tile.z) || tile.x < 0 || tile.z < 0
      || tile.x >= Math.ceil(world.worldWidthMeters / size) || tile.z >= Math.ceil(world.worldDepthMeters / size) || ids.has(tileKey(tile))) throw new Error('Invalid or duplicate land tile.');
    ids.add(tileKey(tile));
  }
}
export function validateLandSettings(settings: LandOwnershipSettings, world: PhysicalWorld): void {
  if (!settings || !['entire-map', 'progressive'].includes(settings.mode) || !Number.isFinite(settings.tileSizeMeters)
    || settings.tileSizeMeters < 256 || settings.tileSizeMeters > 4096) throw new Error('Invalid land ownership settings.');
  validateLandTiles(settings.startingTiles, world, settings.tileSizeMeters);
  if (settings.mode === 'progressive' && !settings.startingTiles.length) throw new Error('Progressive mode needs a Starting Area.');
  if (settings.mode === 'entire-map' && settings.startingTiles.length) throw new Error('Entire Map does not use starting tiles.');
}

// Clip a footprint to a land rectangle; test positive area, so touching an unowned
// boundary does not reject a building entirely on the owned side. No population scan.
function clippedArea(points: readonly Vec2[], box: ReturnType<typeof landTileBounds>): number {
  let clipped = [...points];
  for (const [axis, value, sign] of [['x', box.minX, 1], ['x', box.maxX, -1], ['z', box.minZ, 1], ['z', box.maxZ, -1]] as const) {
    const next: Vec2[] = [];
    for (let i = 0; i < clipped.length; i++) {
      const a = clipped[i]; const b = clipped[(i + 1) % clipped.length];
      const insideA = (a[axis] - value) * sign >= 0; const insideB = (b[axis] - value) * sign >= 0;
      if (insideA) next.push(a);
      if (insideA !== insideB) { const t = (value - a[axis]) / (b[axis] - a[axis]); next.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t }); }
    }
    clipped = next;
  }
  return Math.abs(clipped.reduce((sum, a, i) => { const b = clipped[(i + 1) % clipped.length]; return sum + a.x * b.z - b.x * a.z; }, 0)) / 2;
}

/** One authority/query API for roads, zoning, lots/buildings and services. */
export class LandOwnership {
  private readonly owned = new Set<string>();
  revision = 0;
  readonly settings: LandOwnershipSettings;
  constructor(readonly world: PhysicalWorld, settings: LandOwnershipSettings = entireMapOwnership(), saved?: LandOwnershipSave) {
    validateLandSettings(settings, world); this.settings = structuredClone(settings);
    if (saved) {
      if (saved.mode !== settings.mode || saved.tileSizeMeters !== settings.tileSizeMeters) throw new Error('Land ownership disagrees with map settings.');
      validateLandTiles(saved.ownedTiles, world, settings.tileSizeMeters);
      if (settings.mode === 'entire-map' && saved.ownedTiles.length) throw new Error('Entire Map ownership must remain implicit.');
      const savedIds = new Set(saved.ownedTiles.map(tileKey));
      if (settings.mode === 'progressive' && settings.startingTiles.some(tile => !savedIds.has(tileKey(tile)))) throw new Error('Save is missing a starting tile.');
    }
    for (const tile of saved?.ownedTiles ?? settings.startingTiles) this.owned.add(tileKey(tile));
  }
  owns(tile: LandTile): boolean { return this.settings.mode === 'entire-map' || this.owned.has(tileKey(tile)); }
  save(): LandOwnershipSave { return { mode: this.settings.mode, tileSizeMeters: this.settings.tileSizeMeters,
    ownedTiles: [...this.owned].map(id => { const [x, z] = id.split(':').map(Number); return { x, z }; }) }; }
  unlock(tile: LandTile): void {
    validateLandTiles([tile], this.world, this.settings.tileSizeMeters);
    if (this.settings.mode !== 'progressive') throw new Error('Entire Map is already owned.');
    if (this.owns(tile)) throw new Error('Tile is already owned.');
    if (![[-1, 0], [1, 0], [0, -1], [0, 1]].some(([dx, dz]) => this.owned.has(tileKey({ x: tile.x + dx, z: tile.z + dz })))) throw new Error('Unlock a tile adjacent to your owned area.');
    this.owned.add(tileKey(tile)); this.revision++;
  }
  canConstruct(footprint: ConstructionFootprint): { allowed: boolean; reason?: string } {
    const denied = (reason: string) => ({ allowed: false, reason });
    if (!footprint.points.length || footprint.points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.z)
      || Math.abs(p.x) > this.world.worldWidthMeters / 2 || Math.abs(p.z) > this.world.worldDepthMeters / 2)) return denied('Construction is outside the physical world.');
    if (footprint.kind === 'path') {
      if (footprint.points.length < 2 || !Number.isFinite(footprint.width) || footprint.width <= 0) return denied('Invalid road footprint.');
      // Outside road centreline endpoints may touch the World edge. In Entire Map
      // keep existing connection semantics; Progressive checks the full road width.
      if (this.settings.mode === 'entire-map') return { allowed: true };
      const [left, right] = roadRibbonSides(footprint.points, footprint.width, this.world.terrainSampleSpacingMeters ?? 4);
      const clamp = (p: Vec2) => ({ x: Math.max(-this.world.worldWidthMeters / 2, Math.min(this.world.worldWidthMeters / 2, p.x)), z: Math.max(-this.world.worldDepthMeters / 2, Math.min(this.world.worldDepthMeters / 2, p.z)) });
      // Include the rendered joins: averaged tangents at a bend can extend beyond
      // either segment's perpendicular strip. Check triangles to avoid crossed quads.
      for (let i = 1; i < left.length; i++) {
        for (const triangle of [[left[i - 1], left[i], right[i - 1]], [left[i], right[i], right[i - 1]]]) {
          const result = this.canConstruct({ kind: 'polygon', points: triangle.map(clamp) });
          if (!result.allowed) return result;
        }
      }
      return { allowed: true };
    }
    if (footprint.points.length < 3) return denied('Invalid construction footprint.');
    if (this.settings.mode === 'entire-map') return { allowed: true };
    const size = this.settings.tileSizeMeters;
    const min = landTileAt({ x: Math.min(...footprint.points.map(p => p.x)), z: Math.min(...footprint.points.map(p => p.z)) }, this.world, size);
    const max = landTileAt({ x: Math.max(...footprint.points.map(p => p.x)), z: Math.max(...footprint.points.map(p => p.z)) }, this.world, size);
    for (let z = min.z; z <= max.z; z++) for (let x = min.x; x <= max.x; x++) if (!this.owns({ x, z }) && clippedArea(footprint.points, landTileBounds({ x, z }, this.world, size)) > 1e-6)
      return denied('Unlock this land tile before construction.');
    return { allowed: true };
  }
}
