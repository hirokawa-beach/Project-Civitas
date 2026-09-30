import { describe, expect, it } from 'vitest';
import { RoadGraph } from '../src/roads/roadGraph';
import type { Lot } from '../src/lots/types';
import type { CitizenCandidate } from '../src/citizens/types';
import type { TransitStop } from '../src/transit/types';
import { AdaptiveAgentBudget, agentLod, VISUAL_AGENT_PROFILES } from '../src/visual/agentBudget';
import { CitizenSampler } from '../src/visual/citizenSampler';
import { buildPedestrianGraph } from '../src/visual/pedestrianGraph';

const roads = () => {
  const graph = new RoadGraph();
  graph.buildRoad({ geometry: { kind: 'straight', points: [{ x: -100, z: 0 }, { x: 100, z: 0 }] }, roadTypeId: 'small' });
  return graph.snapshot();
};
const home = (roadSegmentId: Lot['roadAccess']['roadSegmentId']): Lot => ({
  id: 'lot-home', zoneType: 'residential', zoneCellIds: [],
  roadAccess: { roadSegmentId, frontage: [{ x: -10, z: 4 }, { x: -2, z: 4 }] },
  widthCells: 1, depthCells: 1, width: 8, depth: 8, position: { x: -6, z: 10 }, rotation: 0,
  corners: [{ x: -10, z: 4 }, { x: -2, z: 4 }, { x: -2, z: 12 }, { x: -10, z: 12 }],
  averageElevation: 0, minElevation: 0, maxElevation: 0, baseElevation: 0, slope: 0,
  buildable: true, buildingId: 'building-home',
});
const stop = (road: ReturnType<typeof roads>): TransitStop => ({
  id: 'stop-1', name: 'Central', position: { x: 10, z: 4 }, roadSegmentId: road.segments[0].id,
  laneId: road.lanes[0].id, direction: road.lanes[0].direction, along: 110,
});

describe('derived visual agents', () => {
  it('derives sidewalk, crossing, building access and transit access from the road graph', () => {
    const graph = new RoadGraph();
    graph.buildRoad({ geometry: { kind: 'straight', points: [{ x: -100, z: 0 }, { x: 100, z: 0 }] }, roadTypeId: 'small' });
    graph.buildRoad({ geometry: { kind: 'straight', points: [{ x: 0, z: -100 }, { x: 0, z: 100 }] }, roadTypeId: 'small' });
    const snapshot = graph.snapshot();
    const derived = buildPedestrianGraph(snapshot, [home(snapshot.segments[0].id)], [stop(snapshot)]);
    expect(new Set(derived.edges.map((edge) => edge.kind))).toEqual(new Set([
      'sidewalk', 'crossing', 'access', 'transit-access',
    ]));
    expect(derived.nodes.some((node) => node.id === 'building:building-home')).toBe(true);
    expect(derived.nodes.some((node) => node.id === 'stop:stop-1')).toBe(true);
  });

  it('keeps actual nearby citizens visible, reduces overflow detail, and releases them outside the despawn radius', () => {
    const sampler = new CitizenSampler();
    const candidates: CitizenCandidate[] = Array.from({ length: 80 }, (_, i) => ({
      id: `citizen-${i}`, name: `人物 ${i}`, homeBuildingId: 'building-home', activity: 'shopping',
      origin: { id: 'home', label: '自宅', nodeId: 'home', position: { x: -50, z: i } },
      destination: { id: 'shop', label: '店舗', nodeId: 'shop', position: { x: 50, z: i } },
      route: [{ x: -50, z: i }, { x: 50, z: i }], length: 100, speed: 1.2, departedAt: 12 * 3600,
    }));
    sampler.sync(candidates);
    const profile = VISUAL_AGENT_PROFILES.balanced;
    const first = sampler.select({ x: 0, z: 0 }, profile, 1500, [], 12 * 3600, 80);
    expect(first.agents.length).toBeGreaterThan(0);
    expect(first.agents.length).toBeLessThanOrEqual(80);
    expect(sampler.select({ x: 0, z: 0 }, profile, 1500, [], 12 * 3600, 80).agents)
      .toEqual(first.agents);
    const overflow = sampler.select({ x: 0, z: 0 }, profile, 2, first.agents, 12 * 3600, 80).agents;
    expect(overflow).toHaveLength(80);
    expect(overflow.slice(2).every((person) => person.lod === 'far')).toBe(true);
    expect(sampler.select({ x: 0, z: 0 }, profile, 1500, first.agents, 12 * 3600, 1).agents).toHaveLength(1);
    expect(sampler.select({ x: 500, z: 500 }, profile, 1500, first.agents, 12 * 3600, 80).agents).toHaveLength(0);
    const pose = sampler.pose(first.agents[0].id, 12 * 3600 + 5);
    expect(pose?.position).not.toEqual(first.agents[0].position);
    expect(sampler.pose(first.agents[0].id, 12 * 3600 + 100)).toBeUndefined();
    expect(sampler.select({ x: 0, z: 0 }, profile, 1500, [], 12 * 3600 + 100, 80).agents).toHaveLength(0);
  });

  it('adapts only after sustained frame time and assigns three distance levels', () => {
    const budget = new AdaptiveAgentBudget('balanced');
    const initial = budget.vehicleBudget;
    expect(budget.observe(25, 1)).toBe(false);
    expect(budget.observe(25, 1)).toBe(true);
    expect(budget.vehicleBudget).toBeLessThan(initial);
    expect(budget.observe(8, 1)).toBe(false);
    expect(budget.observe(8, 1)).toBe(false);
    expect(budget.observe(8, 1)).toBe(true);
    expect(budget.vehicleBudget).toBeGreaterThan(initial * .9);
    const profile = VISUAL_AGENT_PROFILES.balanced;
    expect(agentLod(20, profile)).toBe('near');
    expect(agentLod(150, profile)).toBe('mid');
    expect(agentLod(300, profile)).toBe('far');
  });
});
