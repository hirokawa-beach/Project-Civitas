import type { CitizenCandidate } from '../citizens/types';
import { stableHash } from '../citizens/identity';
import { pedestrianPose } from '../citizens/routing';
import type { Vec2 } from '../world/types';
import { agentLod, type AgentLod, type VisualAgentProfile } from './agentBudget';

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
    const pose = pedestrianPose(candidate.route, candidate.length, candidate.speed, candidate.departedAt, gameSeconds);
    return pose.arrived ? undefined : pose;
  }
  select(camera: Vec2, profile: VisualAgentProfile, budget: number, previous: readonly CitizenVisual[],
    gameSeconds: number, population: number): { agents: CitizenVisual[]; culled: number } {
    const cap = Math.max(0, Math.min(budget, population));
    const priorIds = new Set(previous.map((citizen) => citizen.id));
    const nearby: Array<{ visual: CitizenVisual; distance: number; retained: boolean }> = [];
    for (const candidate of this.candidates.values()) {
      const pose = this.pose(candidate.id, gameSeconds);
      if (!pose) continue;
      const distance = Math.hypot(pose.position.x - camera.x, pose.position.z - camera.z);
      const retained = priorIds.has(candidate.id);
      if (distance > (retained ? profile.despawnMeters : profile.spawnMeters)) continue;
      nearby.push({ visual: { ...candidate, ...pose, lod: agentLod(distance, profile),
        variation: Math.floor(stableHash(`${candidate.id}:appearance`) * 3) }, distance, retained });
    }
    nearby.sort((a, b) => a.distance - (a.retained ? 12 : 0) - (b.distance - (b.retained ? 12 : 0))
      || a.visual.id.localeCompare(b.visual.id));
    return { agents: nearby.slice(0, cap).map((item) => item.visual), culled: Math.max(0, nearby.length - cap) };
  }
}
