import type { RoadGraphSnapshot } from './types';
import { closestPointOnPolyline, distance, dot, normalize, subtract } from './geometry';
import type { Vec2 } from '../world/types';

export type ConstructionSnapKind = 'none' | 'node' | 'segment' | 'angle' | 'parallel' | 'perpendicular' | 'distance' | 'tangent' | 'direction';
export type SnapSettingKey = 'nodes' | 'segments' | 'guidelines' | 'angles' | 'parallel' | 'perpendicular' | 'distance';

export interface SnapSettings extends Record<SnapSettingKey, boolean> {
  nodes: boolean;
  segments: boolean;
  guidelines: boolean;
  angles: boolean;
  parallel: boolean;
  perpendicular: boolean;
  distance: boolean;
}

export interface ConstructionGuide {
  kind: Exclude<ConstructionSnapKind, 'none' | 'node' | 'segment'>;
  from: Vec2;
  to: Vec2;
  label: string;
}

export interface ConstructionSnapResult {
  position: Vec2;
  type: ConstructionSnapKind;
  targetId?: string;
  guides: ConstructionGuide[];
}

export interface ConstructionSnapInput {
  raw: Vec2;
  start?: Vec2;
  graph: RoadGraphSnapshot;
  settings: SnapSettings;
  tangentHint?: Vec2;
  previousSnap?: ConstructionSnapResult;
}

export const DEFAULT_SNAP_SETTINGS: SnapSettings = {
  nodes: true,
  segments: true,
  guidelines: true,
  angles: true,
  parallel: true,
  perpendicular: true,
  distance: true,
};

const NODE_RADIUS = 12;
const SEGMENT_RADIUS = 10;
const ANGLE_STEP = Math.PI / 12;
const ANGLE_THRESHOLD = 5 * Math.PI / 180;
const TANGENT_THRESHOLD = 11 * Math.PI / 180;
const GUIDE_SEARCH_RADIUS = 160;
const DISTANCE_STEP = 8;
const DISTANCE_THRESHOLD = 1.25;
const ENDPOINT_RELEASE_MULTIPLIER = 1.45;
const DIRECTION_RELEASE_THRESHOLD = 9 * Math.PI / 180;
const ENDPOINT_GUIDE_THRESHOLD = 7;
const ENDPOINT_GUIDE_MIN_LENGTH = 10;
const ENDPOINT_GUIDE_MAX_LENGTH = 220;

const angleDifference = (first: number, second: number): number => {
  const raw = Math.abs(first - second) % (Math.PI * 2);
  return Math.min(raw, Math.PI * 2 - raw);
};

interface DirectionCandidate {
  angle: number;
  difference: number;
  type: 'angle' | 'parallel' | 'perpendicular' | 'tangent';
  label: string;
}

interface EndpointGuideCandidate {
  position: Vec2;
  origin: Vec2;
  direction: Vec2;
  distance: number;
  along: number;
}

const endpointGuideCandidate = (input: ConstructionSnapInput): EndpointGuideCandidate | undefined => {
  if (!input.settings.guidelines || !input.start) return undefined;
  const degree = new Map<string, number>();
  for (const segment of input.graph.segments) {
    degree.set(segment.startNodeId, (degree.get(segment.startNodeId) ?? 0) + 1);
    degree.set(segment.endNodeId, (degree.get(segment.endNodeId) ?? 0) + 1);
  }
  let best: EndpointGuideCandidate | undefined;
  for (const segment of input.graph.segments) {
    const points = segment.geometry.points;
    if (points.length < 2) continue;
    const endpoints = [
      {
        nodeId: segment.startNodeId,
        origin: points[0],
        direction: normalize(subtract(points[0], points[1])),
      },
      {
        nodeId: segment.endNodeId,
        origin: points.at(-1)!,
        direction: normalize(subtract(points.at(-1)!, points.at(-2)!)),
      },
    ];
    for (const endpoint of endpoints) {
      if ((degree.get(endpoint.nodeId) ?? 0) !== 1 || distance(endpoint.origin, input.start) < 1) continue;
      const along = dot(subtract(input.raw, endpoint.origin), endpoint.direction);
      if (along < ENDPOINT_GUIDE_MIN_LENGTH || along > ENDPOINT_GUIDE_MAX_LENGTH) continue;
      const position = {
        x: endpoint.origin.x + endpoint.direction.x * along,
        z: endpoint.origin.z + endpoint.direction.z * along,
      };
      const guideDistance = distance(input.raw, position);
      if (guideDistance > ENDPOINT_GUIDE_THRESHOLD || (best && guideDistance >= best.distance)) continue;
      best = { position, origin: endpoint.origin, direction: endpoint.direction, distance: guideDistance, along };
    }
  }
  return best;
};

const directionCandidates = (input: ConstructionSnapInput, rawAngle: number): DirectionCandidate[] => {
  const candidates: DirectionCandidate[] = [];
  const previousGuide = input.previousSnap?.guides[0];
  if (
    input.start
    && previousGuide
    && previousGuide.kind !== 'distance'
    && previousGuide.kind !== 'direction'
    && distance(previousGuide.from, input.start) <= 0.1
  ) {
    const previousDirection = normalize(subtract(previousGuide.to, previousGuide.from));
    const previousAngle = Math.atan2(previousDirection.z, previousDirection.x);
    const difference = angleDifference(rawAngle, previousAngle);
    const releaseThreshold = previousGuide.kind === 'tangent' ? TANGENT_THRESHOLD * 1.35 : DIRECTION_RELEASE_THRESHOLD;
    if (difference <= releaseThreshold) {
      candidates.push({
        angle: previousAngle,
        difference: difference * 0.35,
        type: previousGuide.kind,
        label: previousGuide.label,
      });
    }
  }
  if (input.tangentHint) {
    const tangent = normalize(input.tangentHint);
    const angle = Math.atan2(tangent.z, tangent.x);
    const difference = angleDifference(rawAngle, angle);
    if (difference <= TANGENT_THRESHOLD) candidates.push({ angle, difference: difference * 0.5, type: 'tangent', label: 'TANGENT' });
  }
  if (input.settings.angles) {
    const angle = Math.round(rawAngle / ANGLE_STEP) * ANGLE_STEP;
    const difference = angleDifference(rawAngle, angle);
    if (difference <= ANGLE_THRESHOLD) {
      candidates.push({ angle, difference, type: 'angle', label: `${Math.round(angle * 180 / Math.PI)}°` });
    }
  }
  if (!input.start || (!input.settings.parallel && !input.settings.perpendicular)) return candidates;
  for (const segment of input.graph.segments) {
    const nearStart = closestPointOnPolyline(input.start, segment.geometry.points).distance;
    const nearEnd = closestPointOnPolyline(input.raw, segment.geometry.points).distance;
    if (Math.min(nearStart, nearEnd) > GUIDE_SEARCH_RADIUS) continue;
    for (let index = 0; index < segment.geometry.points.length - 1; index += 1) {
      const delta = subtract(segment.geometry.points[index + 1], segment.geometry.points[index]);
      if (Math.hypot(delta.x, delta.z) < 1) continue;
      const baseAngle = Math.atan2(delta.z, delta.x);
      if (input.settings.parallel) {
        for (const angle of [baseAngle, baseAngle + Math.PI]) {
          const difference = angleDifference(rawAngle, angle);
          if (difference <= ANGLE_THRESHOLD) candidates.push({ angle, difference, type: 'parallel', label: 'PARALLEL' });
        }
      }
      if (input.settings.perpendicular) {
        for (const angle of [baseAngle + Math.PI / 2, baseAngle - Math.PI / 2]) {
          const difference = angleDifference(rawAngle, angle);
          if (difference <= ANGLE_THRESHOLD) candidates.push({ angle, difference, type: 'perpendicular', label: '90°' });
        }
      }
    }
  }
  return candidates;
};

export const resolveConstructionSnap = (input: ConstructionSnapInput): ConstructionSnapResult => {
  const closestNode = input.settings.nodes
    ? input.graph.nodes
      .map((node) => ({ id: node.id, point: node.position, distance: distance(input.raw, node.position) }))
      .filter((candidate) => candidate.distance <= NODE_RADIUS)
      .sort((left, right) => left.distance - right.distance)[0]
    : undefined;

  const previous = input.previousSnap;
  if (previous?.targetId) {
    if (previous.type === 'node' && input.settings.nodes) {
      const node = input.graph.nodes.find((candidate) => candidate.id === previous.targetId);
      if (node && distance(input.raw, node.position) <= NODE_RADIUS * ENDPOINT_RELEASE_MULTIPLIER) {
        return { position: { ...node.position }, type: 'node', targetId: node.id, guides: [] };
      }
    }
    if (previous.type === 'segment' && input.settings.segments && (!closestNode || closestNode.distance > 4)) {
      const segment = input.graph.segments.find((candidate) => candidate.id === previous.targetId);
      if (segment) {
        const projection = closestPointOnPolyline(input.raw, segment.geometry.points);
        if (projection.distance <= SEGMENT_RADIUS * ENDPOINT_RELEASE_MULTIPLIER) {
          return { position: { ...projection.point }, type: 'segment', targetId: segment.id, guides: [] };
        }
      }
    }
  }

  if (input.settings.nodes) {
    if (closestNode) return { position: { ...closestNode.point }, type: 'node', targetId: closestNode.id, guides: [] };
  }

  if (input.settings.segments) {
    let bestSegment: { id: string; point: Vec2; distance: number } | undefined;
    for (const segment of input.graph.segments) {
      const projection = closestPointOnPolyline(input.raw, segment.geometry.points);
      if (projection.distance <= SEGMENT_RADIUS && (!bestSegment || projection.distance < bestSegment.distance)) {
        bestSegment = { id: segment.id, point: projection.point, distance: projection.distance };
      }
    }
    if (bestSegment) return { position: { ...bestSegment.point }, type: 'segment', targetId: bestSegment.id, guides: [] };
  }

  if (!input.start) return { position: { ...input.raw }, type: 'none', guides: [] };
  const previousEndpointGuide = previous?.type === 'tangent'
    ? previous.guides.find((guide) => guide.kind === 'tangent' && guide.label === 'END GUIDE')
    : undefined;
  if (input.settings.guidelines && previousEndpointGuide) {
    const direction = normalize(subtract(previousEndpointGuide.to, previousEndpointGuide.from));
    const along = dot(subtract(input.raw, previousEndpointGuide.from), direction);
    const position = {
      x: previousEndpointGuide.from.x + direction.x * along,
      z: previousEndpointGuide.from.z + direction.z * along,
    };
    if (
      along >= ENDPOINT_GUIDE_MIN_LENGTH * 0.75
      && along <= ENDPOINT_GUIDE_MAX_LENGTH * 1.1
      && distance(input.raw, position) <= ENDPOINT_GUIDE_THRESHOLD * ENDPOINT_RELEASE_MULTIPLIER
    ) {
      return {
        position,
        type: 'tangent',
        guides: [{ ...previousEndpointGuide, from: { ...previousEndpointGuide.from }, to: { ...previousEndpointGuide.to } }],
      };
    }
  }
  const endpointGuide = endpointGuideCandidate(input);
  if (endpointGuide) {
    const guideLength = Math.min(
      ENDPOINT_GUIDE_MAX_LENGTH,
      Math.max(64, endpointGuide.along + 32),
    );
    return {
      position: endpointGuide.position,
      type: 'tangent',
      guides: [{
        kind: 'tangent',
        from: { ...endpointGuide.origin },
        to: {
          x: endpointGuide.origin.x + endpointGuide.direction.x * guideLength,
          z: endpointGuide.origin.z + endpointGuide.direction.z * guideLength,
        },
        label: 'END GUIDE',
      }],
    };
  }
  const offset = subtract(input.raw, input.start);
  let length = Math.hypot(offset.x, offset.z);
  if (length < 0.001) return { position: { ...input.raw }, type: 'none', guides: [] };
  const rawAngle = Math.atan2(offset.z, offset.x);
  const direction = directionCandidates(input, rawAngle).sort((a, b) => a.difference - b.difference).at(0);
  const angle = direction?.angle ?? rawAngle;
  let type: ConstructionSnapKind = direction?.type ?? 'none';
  const guides: ConstructionGuide[] = [];

  if (input.settings.distance) {
    const quantized = Math.round(length / DISTANCE_STEP) * DISTANCE_STEP;
    if (quantized >= 4 && Math.abs(length - quantized) <= DISTANCE_THRESHOLD) {
      length = quantized;
      if (type === 'none') type = 'distance';
    }
  }

  const position = {
    x: input.start.x + Math.cos(angle) * length,
    z: input.start.z + Math.sin(angle) * length,
  };
  if (direction) guides.push({ kind: direction.type, from: { ...input.start }, to: { ...position }, label: direction.label });
  else if (type === 'distance') guides.push({ kind: 'distance', from: { ...input.start }, to: { ...position }, label: `${length.toFixed(0)} m` });
  return { position, type, guides };
};
