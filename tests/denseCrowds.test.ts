import { describe, expect, it } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { CreateCylinder } from '@babylonjs/core/Meshes/Builders/cylinderBuilder';
import '@babylonjs/core/Meshes/thinInstanceMesh';
import { BenchmarkScenario } from '../src/performance/scenarios';
import { CitizenSampler } from '../src/visual/citizenSampler';
import { VISUAL_AGENT_PROFILES, stableAgentLod } from '../src/visual/agentBudget';
import { CrowdInstanceBatch } from '../src/visual/crowdInstances';
import { pedestrianPose, polylineLength } from '../src/citizens/routing';
import { TransitSystem } from '../src/transit/system';

describe('actual individual crowds', () => {
  it('returns and renders 6000 real identities; detail budgets simplify overflow instead of removing people', () => {
    const city = new BenchmarkScenario('camera-6000'); const snapshot = city.snapshot();
    const candidates = snapshot.traffic.citizenCandidates!;
    expect(candidates).toHaveLength(6000);
    expect(new Set(candidates.map((person) => person.id)).size).toBe(6000);
    const actual = new Map(city.traffic.citizens.save().residents.map((person) => [person.id, person]));
    expect(candidates.every((person) => actual.get(person.id)?.name === person.name)).toBe(true);
    const sampler = new CitizenSampler(); sampler.sync(candidates);
    const selected = sampler.select({ x: 0, z: 0 }, VISUAL_AGENT_PROFILES.balanced, 1500, [], city.gameSeconds, 6000);
    expect(selected.agents).toHaveLength(6000);
    expect(selected.culled).toBe(0);
    expect(selected.agents.slice(1500).every((person) => person.lod === 'far')).toBe(true);
    const slow = sampler.select({ x: 0, z: 0 }, VISUAL_AGENT_PROFILES.balanced, 500, selected.agents,
      city.gameSeconds, 6000, { qualityScale: .3 });
    expect(slow.agents).toHaveLength(6000); expect(slow.agents.every((person) => person.lod === 'far')).toBe(true);
  });

  it('retains visibility while the camera moves and resumes the actual outside-camera journey at its current position', () => {
    const city = new BenchmarkScenario('camera-6000');
    const sampler = new CitizenSampler(); sampler.sync(city.snapshot().traffic.citizenCandidates!);
    const before = sampler.select({ x: 0, z: 0 }, VISUAL_AGENT_PROFILES.balanced, 1500, [], city.gameSeconds, 6000);
    const moved = sampler.select({ x: 5, z: 2 }, VISUAL_AGENT_PROFILES.balanced, 1500, before.agents, city.gameSeconds, 6000);
    expect(new Set(moved.agents.map((person) => person.id))).toEqual(new Set(before.agents.map((person) => person.id)));
    const person = before.agents[0]; const original = city.traffic.citizens.get(person.id)!.journey!;
    const originalPose = sampler.pose(person.id, city.gameSeconds)!;
    city.traffic.setCitizenView({ x: 5000, z: 5000 }, 40, 10);
    expect(city.snapshot().traffic.citizenCandidates).toHaveLength(0);
    city.tick(.5);
    city.traffic.setCitizenView({ x: 0, z: 0 }, 410, 10); sampler.sync(city.snapshot().traffic.citizenCandidates!);
    const pose = sampler.pose(person.id, city.gameSeconds)!;
    expect(pose.position).not.toEqual(originalPose.position);
    expect(pose).toEqual(pedestrianPose(original.route, original.length, original.speed, original.departedAt, city.gameSeconds));
    expect(city.traffic.citizens.get(person.id)!.journey!.destination).toEqual(original.destination);
  });

  it('uses Near/Mid/Far hysteresis and frustum filtering without changing identities', () => {
    const p = VISUAL_AGENT_PROFILES.balanced;
    expect(stableAgentLod(20, undefined, p)).toBe('near');
    expect(stableAgentLod(150, undefined, p)).toBe('mid');
    expect(stableAgentLod(300, undefined, p)).toBe('far');
    expect(stableAgentLod(95, 'near', p)).toBe('near');
    expect(stableAgentLod(85, 'mid', p)).toBe('mid');
    const city = new BenchmarkScenario('camera-6000'); const sampler = new CitizenSampler(); sampler.sync(city.snapshot().traffic.citizenCandidates!);
    const selected = sampler.select({ x: 0, z: 0 }, p, 1500, [], city.gameSeconds, 6000, { visible: (point) => point.x < 0 });
    expect(selected.agents.length).toBeGreaterThan(0); expect(selected.agents.every((person) => person.position.x < 0)).toBe(true);
  });

  it('shares detached route data and reuses GPU instance buffers for thousands of identities', () => {
    const city = new BenchmarkScenario('camera-6000'); const people = city.snapshot().traffic.citizenCandidates!;
    expect(new Set(people.map((person) => person.route)).size).toBeLessThan(people.length / 10);
    expect(Object.isFrozen(people[0].route)).toBe(true);
    const engine = new NullEngine(); const scene = new Scene(engine);
    const batch = new CrowdInstanceBatch(CreateCylinder('crowd', { tessellation: 3 }, scene));
    try {
      batch.begin(people.length);
      for (const person of people) { const pose = pedestrianPose(person.route, person.length, person.speed, person.departedAt, city.gameSeconds); batch.append(person.id, pose.position.x, 1, pose.position.z, pose.yaw); }
      expect(batch.commit()).toBe(6000); expect(scene.meshes).toHaveLength(1);
      const bytes = batch.bytes; const buffer = batch.mesh.thinInstanceGetWorldMatrices();
      expect(buffer[0].getTranslation().x).toBeCloseTo(pedestrianPose(people[0].route, people[0].length, people[0].speed, people[0].departedAt, city.gameSeconds).position.x);
      batch.begin(people.length); batch.append(people[0].id, 3, 2, 1, 0); batch.commit();
      expect(batch.bytes).toBe(bytes); expect(batch.mesh.thinInstanceCount).toBe(1);
      expect(batch.mesh.metadata.agentIds).toEqual([people[0].id]);
    } finally { scene.dispose(); engine.dispose(); }
  });

  it('shows actual waiting passengers at the stop, access walkers before arrival, and alighting walkers afterwards', () => {
    const city = new BenchmarkScenario('transit-hotspot');
    const snapshot = city.snapshot(); const waiting = snapshot.traffic.citizenCandidates!.filter((person) => person.state === 'waiting');
    expect(waiting).toHaveLength(1500);
    const positions = waiting.map((person) => person.stationaryPosition!);
    const meanX = positions.reduce((sum, point) => sum + point.x, 0) / positions.length;
    const meanZ = positions.reduce((sum, point) => sum + point.z, 0) / positions.length;
    const xx = positions.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0);
    const zz = positions.reduce((sum, point) => sum + (point.z - meanZ) ** 2, 0);
    const xz = positions.reduce((sum, point) => sum + (point.x - meanX) * (point.z - meanZ), 0);
    // Hashes differing only in the final character can collapse a stop crowd into one diagonal line.
    expect(Math.abs(xz / Math.sqrt(xx * zz))).toBeLessThan(.8);
    const id = waiting[0].id; const stop = city.transit.getStop(city.transit.waitingCitizen(id)!.originStopId)!;
    expect(city.traffic.citizens.get(id)!.journey!.mode).toBe('transit');
    const actual = city.traffic.citizens.get(id)!; const route = city.traffic.citizens.routeToStop(actual, stop)!;
    const ready = city.gameSeconds + polylineLength(route) / actual.journey!.speed;
    const access = city.traffic.citizens.transitCandidate(id, stop, city.gameSeconds, ready, city.gameSeconds + 1)!;
    expect(access.state).toBe('transit-access'); expect(access.route.at(-1)).toEqual(stop.position);
    const queue = city.traffic.citizens.transitCandidate(id, stop, city.gameSeconds, ready, ready + 1)!;
    expect(queue.state).toBe('waiting');
    const sampler = new CitizenSampler(); sampler.sync([queue]);
    expect(sampler.pose(id, ready + 1)).toEqual(sampler.pose(id, ready + 10));
    const destinationStop = city.transit.stops[1]; city.traffic.citizens.alight(id, destinationStop, city.gameSeconds);
    const journey = city.traffic.citizens.get(id)!.journey!;
    expect(journey.mode).toBe('walk'); expect(journey.origin.nodeId).toBe(`stop:${destinationStop.id}`);
    expect(journey.destination).toEqual(actual.journey!.destination);
    expect(city.traffic.citizens.nearby(destinationStop.position, 200, Infinity, city.gameSeconds).find((person) => person.id === id)?.state).toBe('alighting');
  });

  it('preserves optional access/egress transit state across saves and accepts old saves without it', () => {
    const city = new BenchmarkScenario('transit-hotspot'); const id = city.transit.waitingGroups[0].citizenId!;
    city.transit.setCitizenReadyAt(id, city.gameSeconds + 120);
    city.transit.tick(city.gameSeconds, []);
    expect(city.transit.waitingCitizen(id)).toBeDefined(); // cannot board before reaching stop
    const saved = city.transit.save();
    const loaded = new TransitSystem(city.roads, undefined, city.gameSeconds); loaded.restore(saved, city.gameSeconds);
    expect(loaded.waitingCitizen(id)!.readyAtGameSeconds).toBe(city.gameSeconds + 120);
    const legacy = structuredClone(saved); for (const group of legacy.waitingGroups) delete group.readyAtGameSeconds;
    loaded.restore(legacy, city.gameSeconds); expect(loaded.waitingCitizen(id)!.readyAtGameSeconds).toBeUndefined();
    const egress = { ...legacy, alightedCitizens: [{ citizenId: id, stopId: city.transit.stops[1].id, gameSeconds: city.gameSeconds }] };
    loaded.restore(egress, city.gameSeconds);
    expect(loaded.save().alightedCitizens).toEqual(egress.alightedCitizens);
    expect(loaded.takeAlightedCitizens()[0].citizenId).toBe(id);
    expect(loaded.takeAlightedCitizens()).toHaveLength(0);
    const corrupt = structuredClone(saved); corrupt.waitingGroups[0].readyAtGameSeconds = NaN;
    expect(() => loaded.restore(corrupt, city.gameSeconds)).toThrow(/passenger/);
  });
});
