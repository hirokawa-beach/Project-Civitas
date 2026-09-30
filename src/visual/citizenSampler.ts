import type { CitizenCandidate } from '../citizens/types';
import { stableHash } from '../citizens/identity';
import { pedestrianPose } from '../citizens/routing';
import type { Vec2 } from '../world/types';
import { stableAgentLod, type AgentLod, type VisualAgentProfile } from './agentBudget';

export const visualHash = stableHash;
export interface CitizenVisual extends CitizenCandidate {
  position: Vec2;
  yaw: number;
  lod: AgentLod;
  variation: number;
}

/** Select actual worker-side journeys. This class never invents people or destinations. */
export class CitizenSampler {
  private candidates = new Map<string, CitizenCandidate>();
  sync(candidates: readonly CitizenCandidate[]): void {
    this.candidates = new Map(candidates.map((citizen) => [citizen.id, citizen]));
  }
  pose(id: string, gameSeconds: number): { position: Vec2; yaw: number } | undefined {
    const candidate = this.candidates.get(id);
    if (!candidate) return;
    if (candidate.stationaryPosition) return { position: candidate.stationaryPosition, yaw: 0 };
    const pose = pedestrianPose(candidate.route, candidate.length, candidate.speed, candidate.departedAt, gameSeconds);
    return pose.arrived ? undefined : pose;
  }
  select(camera: Vec2, profile: VisualAgentProfile, budget: number, previous: readonly CitizenVisual[],
    gameSeconds: number, population: number, options?: { visible?: (position: Vec2, retained: boolean) => boolean;
      lodDistance?: (position: Vec2) => number; qualityScale?: number }): { agents: CitizenVisual[]; culled: number } {
    const cap = Math.max(0, population);
    const priorIds = new Set(previous.map((citizen) => citizen.id));
    const priorLods = new Map(previous.map((citizen) => [citizen.id, citizen.lod]));
    const nearby: Array<{ visual: CitizenVisual; distance: number; retained: boolean }> = [];
    for (const candidate of this.candidates.values()) {
      const pose = this.pose(candidate.id, gameSeconds);
      if (!pose) continue;
      const distance = Math.hypot(pose.position.x - camera.x, pose.position.z - camera.z);
      const retained = priorIds.has(candidate.id);
      if (distance > (retained ? profile.despawnMeters : profile.spawnMeters)) continue;
      if (options?.visible && !options.visible(pose.position, retained)) continue;
      nearby.push({ visual: { ...candidate, ...pose, lod: stableAgentLod(options?.lodDistance?.(pose.position) ?? distance, priorLods.get(candidate.id), profile),
        variation: Math.floor(stableHash(`${candidate.id}:appearance`) * 3) }, distance, retained });
    }
    nearby.sort((a, b) => a.distance - (a.retained ? 12 : 0) - (b.distance - (b.retained ? 12 : 0))
      || a.visual.id.localeCompare(b.visual.id));
    // Reduce detail before density. Overflow remains visible as thin-instanced Far agents.
    const qualityScale = options?.qualityScale ?? 1;
    const agents = nearby.slice(0, cap).map((item, i) => {
      if (i >= budget || qualityScale < .45) item.visual.lod = 'far';
      else if (qualityScale < .75 && item.visual.lod === 'near') item.visual.lod = 'mid';
      return item.visual;
    });
    return { agents, culled: Math.max(0, nearby.length - cap) };
  }
}
