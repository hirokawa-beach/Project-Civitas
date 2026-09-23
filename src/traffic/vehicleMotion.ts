import type { GameSpeed } from '../simulation/gameClock';

export interface VehiclePose { x: number; y: number; z: number; yaw: number }
interface VehicleTrack { current: VehiclePose; start: VehiclePose; target: VehiclePose; elapsedGameSeconds: number }

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

export function interpolateVehiclePose(start: VehiclePose, target: VehiclePose, fraction: number): VehiclePose {
  const t = clamp01(fraction);
  const yawDelta = Math.atan2(Math.sin(target.yaw - start.yaw), Math.cos(target.yaw - start.yaw));
  return {
    x: start.x + (target.x - start.x) * t,
    y: start.y + (target.y - start.y) * t,
    z: start.z + (target.z - start.z) * t,
    yaw: start.yaw + yawDelta * t,
  };
}

/** Renderer-only interpolation; Simulation remains authoritative for vehicle positions. */
export class VehicleMotion {
  private readonly tracks = new Map<string, VehicleTrack>();
  get ids(): IterableIterator<string> { return this.tracks.keys(); }
  get size(): number { return this.tracks.size; }
  pose(id: string): VehiclePose | undefined { return this.tracks.get(id)?.current; }

  sync(targets: ReadonlyMap<string, VehiclePose>, snap = false): void {
    for (const id of this.tracks.keys()) if (!targets.has(id)) this.tracks.delete(id);
    for (const [id, target] of targets) {
      const existing = this.tracks.get(id);
      if (!existing) {
        this.tracks.set(id, { current: target, start: target, target, elapsedGameSeconds: 0 });
        continue;
      }
      if (snap) {
        this.tracks.set(id, { current: target, start: target, target, elapsedGameSeconds: 0 });
        continue;
      }
      if (existing.target.x === target.x && existing.target.y === target.y
        && existing.target.z === target.z && existing.target.yaw === target.yaw) continue;
      const distance = Math.hypot(existing.current.x - target.x, existing.current.z - target.z);
      if (distance > 12) {
        this.tracks.set(id, { current: target, start: target, target, elapsedGameSeconds: 0 });
      } else {
        existing.start = existing.current;
        existing.target = target;
        existing.elapsedGameSeconds = 0;
      }
    }
  }

  advance(realSeconds: number, speed: GameSpeed, intervalGameSeconds: number): void {
    if (speed === 0 || realSeconds <= 0 || intervalGameSeconds <= 0) return;
    for (const track of this.tracks.values()) {
      track.elapsedGameSeconds = Math.min(intervalGameSeconds,
        track.elapsedGameSeconds + realSeconds * speed * 10);
      track.current = interpolateVehiclePose(track.start, track.target,
        track.elapsedGameSeconds / intervalGameSeconds);
    }
  }
}
