export type PerformanceProfile = 'low' | 'balanced' | 'high';
export type AgentLod = 'near' | 'mid' | 'far';

export interface VisualAgentProfile {
  maxVehicles: number;
  maxCitizens: number;
  nearMeters: number;
  spawnMeters: number;
  despawnMeters: number;
  targetFrameMs: number;
}

export const VISUAL_AGENT_PROFILES: Record<PerformanceProfile, VisualAgentProfile> = {
  low: { maxVehicles: 500, maxCitizens: 500, nearMeters: 75, spawnMeters: 240, despawnMeters: 290, targetFrameMs: 20 },
  balanced: { maxVehicles: 1000, maxCitizens: 1500, nearMeters: 90, spawnMeters: 320, despawnMeters: 380, targetFrameMs: 18 },
  high: { maxVehicles: 2000, maxCitizens: 3000, nearMeters: 110, spawnMeters: 400, despawnMeters: 470, targetFrameMs: 17 },
};

/** Hysteresis keeps small FPS fluctuations from changing the visible population. */
export class AdaptiveAgentBudget {
  private profile: PerformanceProfile;
  private scale = 1;
  private sampleSeconds = 0;
  private frameMsTotal = 0;
  private frameCount = 0;
  private slowSamples = 0;
  private fastSamples = 0;

  constructor(profile: PerformanceProfile = 'balanced') { this.profile = profile; }
  get profileName(): PerformanceProfile { return this.profile; }
  get config(): VisualAgentProfile { return VISUAL_AGENT_PROFILES[this.profile]; }
  get vehicleBudget(): number { return Math.round(this.config.maxVehicles * this.scale); }
  get citizenBudget(): number { return Math.round(this.config.maxCitizens * this.scale); }
  get qualityScale(): number { return this.scale; }

  setProfile(profile: PerformanceProfile): void {
    this.profile = profile;
    this.scale = 1;
    this.slowSamples = 0;
    this.fastSamples = 0;
    this.sampleSeconds = 0;
    this.frameMsTotal = 0;
    this.frameCount = 0;
  }

  observe(frameMs: number, realSeconds: number): boolean {
    if (!Number.isFinite(frameMs) || frameMs <= 0 || !Number.isFinite(realSeconds) || realSeconds <= 0) return false;
    this.sampleSeconds += realSeconds;
    this.frameMsTotal += frameMs;
    this.frameCount += 1;
    if (this.sampleSeconds < 1) return false;
    const average = this.frameMsTotal / this.frameCount;
    this.sampleSeconds = 0; this.frameMsTotal = 0; this.frameCount = 0;
    if (average > this.config.targetFrameMs * 1.18) { this.slowSamples++; this.fastSamples = 0; }
    else if (average < this.config.targetFrameMs * .76) { this.fastSamples++; this.slowSamples = 0; }
    else { this.slowSamples = 0; this.fastSamples = 0; }
    if (this.slowSamples >= 2) {
      this.slowSamples = 0;
      const next = Math.max(.25, this.scale - .1);
      if (next !== this.scale) { this.scale = next; return true; }
    }
    if (this.fastSamples >= 3) {
      this.fastSamples = 0;
      const next = Math.min(1, this.scale + .05);
      if (next !== this.scale) { this.scale = next; return true; }
    }
    return false;
  }
}

export const agentLod = (distanceMeters: number, profile: VisualAgentProfile): AgentLod =>
  distanceMeters <= profile.nearMeters ? 'near'
    : distanceMeters <= (profile.nearMeters + profile.spawnMeters) / 2 ? 'mid' : 'far';

export function stableAgentLod(distance: number, prior: AgentLod | undefined, profile: VisualAgentProfile): AgentLod {
  const mid = (profile.nearMeters + profile.spawnMeters) / 2;
  if (prior === 'near' && distance <= profile.nearMeters * 1.12) return 'near';
  if (distance <= profile.nearMeters * (prior ? .88 : 1)) return 'near';
  if (prior === 'mid' && distance <= mid * 1.12) return 'mid';
  return distance <= mid * (prior === 'far' ? .88 : 1) ? 'mid' : 'far';
}
