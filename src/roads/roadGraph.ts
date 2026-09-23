import { numericId, type RoadLineageId, type RoadNodeId, type RoadSegmentId } from '../shared/ids';
import type { Vec2 } from '../world/types';
import {
  EPSILON,
  closestPointOnPolyline,
  distance,
  polylineLength,
  segmentIntersection,
  slicePolyline,
  splitPolyline,
  type PolylineProjection,
} from './geometry';
import { getRoadType } from './roadTypes';
import type { BuildRoadInput, Lane, RoadEndpointIntent, RoadGeometry, RoadGraphSnapshot, RoadNode, RoadSegment } from './types';
import { validateRoadCandidate } from './validation';

export interface SnapResult {
  position: Vec2;
  type: 'none' | 'node' | 'segment';
  targetId?: RoadNodeId | RoadSegmentId;
}

export interface BuildRoadResult {
  createdSegmentIds: RoadSegmentId[];
  intersectionNodeIds: RoadNodeId[];
  startNodeId: RoadNodeId;
  endNodeId: RoadNodeId;
  startPosition: Vec2;
  endPosition: Vec2;
}

interface Anchor {
  along: number;
  nodeId: RoadNodeId;
  position: Vec2;
}

const cloneSnapshot = (snapshot: RoadGraphSnapshot): RoadGraphSnapshot => structuredClone(snapshot);

export class RoadGraph {
  readonly nodes = new Map<RoadNodeId, RoadNode>();
  readonly segments = new Map<RoadSegmentId, RoadSegment>();
  readonly lanes = new Map<Lane['id'], Lane>();

  private nextNodeId = 1;
  private nextSegmentId = 1;
  private nextLaneId = 1;
  private nextLineageId = 1;

  constructor(snapshot?: RoadGraphSnapshot) {
    if (snapshot) this.restore(snapshot);
  }

  snapshot(): RoadGraphSnapshot {
    return cloneSnapshot({
      nodes: [...this.nodes.values()],
      segments: [...this.segments.values()],
      lanes: [...this.lanes.values()],
    });
  }

  restore(snapshot: RoadGraphSnapshot): void {
    this.validateSnapshot(snapshot);
    this.nodes.clear();
    this.segments.clear();
    this.lanes.clear();
    for (const node of snapshot.nodes) this.nodes.set(node.id, structuredClone(node));
    const restoredSegments = snapshot.segments.map((segment) => structuredClone(segment));
    let legacyLineageId = Math.max(0, ...restoredSegments.map((segment) => segment.zoningLineageId ? numericId(segment.zoningLineageId) : 0)) + 1;
    for (const segment of restoredSegments) {
      segment.zoningLineageId ??= `roadline-${legacyLineageId++}`;
      segment.zoningStartOffset ??= 0;
      this.segments.set(segment.id, segment);
    }
    for (const lane of snapshot.lanes) this.lanes.set(lane.id, structuredClone(lane));
    this.nextNodeId = Math.max(0, ...snapshot.nodes.map((node) => numericId(node.id))) + 1;
    this.nextSegmentId = Math.max(0, ...snapshot.segments.map((segment) => numericId(segment.id))) + 1;
    this.nextLaneId = Math.max(0, ...snapshot.lanes.map((lane) => numericId(lane.id))) + 1;
    this.nextLineageId = Math.max(0, ...[...this.segments.values()].map((segment) => numericId(segment.zoningLineageId!))) + 1;
    this.assertIntegrity();
  }

  findSnap(position: Vec2, nodeRadius = 12, segmentRadius = 10): SnapResult {
    let closestNode: RoadNode | undefined;
    let closestNodeDistance = nodeRadius;
    for (const node of this.nodes.values()) {
      const candidateDistance = distance(position, node.position);
      if (candidateDistance <= closestNodeDistance) {
        closestNode = node;
        closestNodeDistance = candidateDistance;
      }
    }
    if (closestNode) return { position: { ...closestNode.position }, type: 'node', targetId: closestNode.id };

    let closestSegment: RoadSegment | undefined;
    let closestProjection: PolylineProjection | undefined;
    for (const segment of this.segments.values()) {
      const projection = closestPointOnPolyline(position, segment.geometry.points);
      if (projection.distance <= segmentRadius && (!closestProjection || projection.distance < closestProjection.distance)) {
        closestProjection = projection;
        closestSegment = segment;
      }
    }
    if (closestSegment && closestProjection) {
      return { position: { ...closestProjection.point }, type: 'segment', targetId: closestSegment.id };
    }
    return { position: { ...position }, type: 'none' };
  }

  buildRoad(input: BuildRoadInput): BuildRoadResult {
    const before = this.snapshot();
    try {
      return this.buildRoadMutating(input);
    } catch (error) {
      this.restore(before);
      throw error;
    }
  }

  private buildRoadMutating(input: BuildRoadInput): BuildRoadResult {
    if (input.geometry.points.length < 2) throw new Error('A road needs at least two points.');
    const geometry = structuredClone(input.geometry);
    if (polylineLength(geometry.points) < 4) throw new Error('Road is too short.');
    const roadType = getRoadType(input.roadTypeId);
    // First pass validates intrinsic geometry only. Endpoint snap intents are
    // resolved before testing against existing road surfaces.
    const validationOptions = {
      candidateWidth: roadType.width,
      minimumCurveRadius: geometry.kind === 'curve' ? roadType.minimumCurveRadius : 0,
    };
    const initialValidation = validateRoadCandidate({ nodes: [], segments: [], lanes: [] }, geometry.points, validationOptions);
    if (!initialValidation.valid) throw new Error(`Invalid road: ${initialValidation.reasons.join(', ')}.`);

    const [startNode, endNode] = input.endpointIntents
      ? this.resolveEndpointIntentPair(input.endpointIntents.start, input.endpointIntents.end)
      : [this.resolveEndpoint(geometry.points[0]), undefined];
    geometry.points[0] = { ...startNode.position };
    const lastIndex = geometry.points.length - 1;
    const resolvedEndNode = endNode ?? this.resolveEndpoint(geometry.points[lastIndex]);
    geometry.points[lastIndex] = { ...resolvedEndNode.position };

    const snappedValidation = validateRoadCandidate(this.snapshot(), geometry.points, validationOptions);
    if (!snappedValidation.valid) throw new Error(`Invalid snapped road: ${snappedValidation.reasons.join(', ')}.`);

    const totalLength = polylineLength(geometry.points);
    if (totalLength < 4 || startNode.id === resolvedEndNode.id) throw new Error('Road endpoints must be distinct.');

    const crossingCandidates: Array<{ point: Vec2; along: number }> = [];
    let newTraversed = 0;
    for (let newIndex = 0; newIndex < geometry.points.length - 1; newIndex += 1) {
      const newStart = geometry.points[newIndex];
      const newEnd = geometry.points[newIndex + 1];
      const newPartLength = distance(newStart, newEnd);
      for (const segment of this.segments.values()) {
        const existingPoints = segment.geometry.points;
        for (let existingIndex = 0; existingIndex < existingPoints.length - 1; existingIndex += 1) {
          const crossing = segmentIntersection(newStart, newEnd, existingPoints[existingIndex], existingPoints[existingIndex + 1]);
          if (!crossing) continue;
          const along = newTraversed + crossing.aT * newPartLength;
          if (along <= EPSILON || along >= totalLength - EPSILON) continue;
          if (!crossingCandidates.some((candidate) => distance(candidate.point, crossing.point) < 0.25)) {
            crossingCandidates.push({ point: crossing.point, along });
          }
        }
      }
      newTraversed += newPartLength;
    }

    crossingCandidates.sort((a, b) => a.along - b.along);
    const anchorDistances = [0, ...crossingCandidates.map((candidate) => candidate.along), totalLength];
    for (let index = 1; index < anchorDistances.length; index += 1) {
      if (anchorDistances[index] - anchorDistances[index - 1] < 1) {
        throw new Error('Intersections are too close to form a valid road segment.');
      }
    }
    const intersectionNodeIds: RoadNodeId[] = [];
    const anchors: Anchor[] = [
      { along: 0, nodeId: startNode.id, position: { ...startNode.position } },
    ];
    for (const crossing of crossingCandidates) {
      const node = this.resolveEndpoint(crossing.point, 0.3, 0.3);
      if (node.id === anchors.at(-1)?.nodeId || node.id === resolvedEndNode.id) continue;
      anchors.push({ along: crossing.along, nodeId: node.id, position: { ...node.position } });
      intersectionNodeIds.push(node.id);
    }
    anchors.push({ along: totalLength, nodeId: resolvedEndNode.id, position: { ...resolvedEndNode.position } });

    const createdSegmentIds: RoadSegmentId[] = [];
    const zoningLineageId = `roadline-${this.nextLineageId++}` as RoadLineageId;
    for (let index = 0; index < anchors.length - 1; index += 1) {
      const from = anchors[index];
      const to = anchors[index + 1];
      if (to.along - from.along < 1) continue;
      const points = slicePolyline(geometry.points, from.along, to.along);
      points[0] = { ...from.position };
      points[points.length - 1] = { ...to.position };
      const segment = this.createSegment(
        from.nodeId,
        to.nodeId,
        { kind: anchors.length === 2 ? geometry.kind : 'polyline', points },
        roadType.id,
        zoningLineageId,
        from.along,
      );
      createdSegmentIds.push(segment.id);
    }

    if (createdSegmentIds.length === 0) throw new Error('Road did not produce a valid segment.');
    this.assertIntegrity();
    return {
      createdSegmentIds,
      intersectionNodeIds,
      startNodeId: startNode.id,
      endNodeId: resolvedEndNode.id,
      startPosition: { ...startNode.position },
      endPosition: { ...resolvedEndNode.position },
    };
  }

  removeSegment(segmentId: RoadSegmentId): boolean {
    if (!this.segments.has(segmentId)) return false;
    this.deleteSegment(segmentId, true);
    this.assertIntegrity();
    return true;
  }

  connectedSegments(nodeId: RoadNodeId): RoadSegment[] {
    return [...this.segments.values()].filter((segment) => segment.startNodeId === nodeId || segment.endNodeId === nodeId);
  }

  assertIntegrity(): void {
    for (const segment of this.segments.values()) {
      if (!this.nodes.has(segment.startNodeId) || !this.nodes.has(segment.endNodeId)) {
        throw new Error(`Segment ${segment.id} references a missing node.`);
      }
      if (segment.geometry.points.length < 2) throw new Error(`Segment ${segment.id} has invalid geometry.`);
      if (distance(segment.geometry.points[0], this.nodes.get(segment.startNodeId)!.position) > EPSILON) {
        throw new Error(`Segment ${segment.id} start geometry is disconnected.`);
      }
      if (distance(segment.geometry.points.at(-1)!, this.nodes.get(segment.endNodeId)!.position) > EPSILON) {
        throw new Error(`Segment ${segment.id} end geometry is disconnected.`);
      }
      for (const laneId of segment.laneIds) {
        const lane = this.lanes.get(laneId);
        if (!lane || lane.roadSegmentId !== segment.id) throw new Error(`Segment ${segment.id} has an invalid lane.`);
      }
    }
    for (const lane of this.lanes.values()) {
      if (!this.segments.has(lane.roadSegmentId)) throw new Error(`Lane ${lane.id} references a missing segment.`);
    }
  }

  private resolveEndpoint(position: Vec2, nodeRadius = 12, segmentRadius = 10): RoadNode {
    const snap = this.findSnap(position, nodeRadius, segmentRadius);
    if (snap.type === 'node') return this.nodes.get(snap.targetId as RoadNodeId)!;
    if (snap.type === 'segment') {
      const segment = this.segments.get(snap.targetId as RoadSegmentId)!;
      const projection = closestPointOnPolyline(snap.position, segment.geometry.points);
      const segmentLength = polylineLength(segment.geometry.points);
      if (projection.along <= EPSILON) return this.nodes.get(segment.startNodeId)!;
      if (projection.along >= segmentLength - EPSILON) return this.nodes.get(segment.endNodeId)!;
      return this.splitSegment(segment, projection);
    }
    return this.createNode(snap.position);
  }

  private resolveEndpointIntent(intent: RoadEndpointIntent): RoadNode {
    if (intent.kind === 'free') {
      // Even with interactive snapping disabled, merge mathematically identical
      // endpoints so floating-point noise cannot create disconnected duplicates.
      return this.resolveEndpoint(intent.position, 0.1, 0.1);
    }
    if (intent.kind === 'node') {
      const node = this.nodes.get(intent.nodeId);
      if (!node || distance(node.position, intent.position) > 0.25) {
        throw new Error('The selected road node changed before construction completed.');
      }
      return node;
    }
    const segment = this.segments.get(intent.segmentId);
    if (!segment) throw new Error('The selected road segment changed before construction completed.');
    const projection = closestPointOnPolyline(intent.position, segment.geometry.points);
    if (projection.distance > 0.25) throw new Error('The selected road position is no longer valid.');
    const segmentLength = polylineLength(segment.geometry.points);
    if (projection.along <= EPSILON) return this.nodes.get(segment.startNodeId)!;
    if (projection.along >= segmentLength - EPSILON) return this.nodes.get(segment.endNodeId)!;
    return this.splitSegment(segment, projection);
  }

  private resolveEndpointIntentPair(start: RoadEndpointIntent, end: RoadEndpointIntent): [RoadNode, RoadNode] {
    if (start.kind !== 'segment' || end.kind !== 'segment' || start.segmentId !== end.segmentId) {
      return [this.resolveEndpointIntent(start), this.resolveEndpointIntent(end)];
    }
    const segment = this.segments.get(start.segmentId);
    if (!segment) throw new Error('The selected road segment changed before construction completed.');
    const startProjection = closestPointOnPolyline(start.position, segment.geometry.points);
    const endProjection = closestPointOnPolyline(end.position, segment.geometry.points);
    if (startProjection.distance > 0.25 || endProjection.distance > 0.25) {
      throw new Error('The selected road position is no longer valid.');
    }
    const segmentLength = polylineLength(segment.geometry.points);
    const endpoints = new Map<'start' | 'end', RoadNode>();
    const interiors: Array<{ key: 'start' | 'end'; projection: PolylineProjection; node: RoadNode }> = [];
    for (const [key, projection] of [['start', startProjection], ['end', endProjection]] as const) {
      if (projection.along <= EPSILON) endpoints.set(key, this.nodes.get(segment.startNodeId)!);
      else if (projection.along >= segmentLength - EPSILON) endpoints.set(key, this.nodes.get(segment.endNodeId)!);
      else {
        const matching = interiors.find((entry) => Math.abs(entry.projection.along - projection.along) <= EPSILON);
        const node = matching?.node ?? this.createNode(projection.point);
        interiors.push({ key, projection, node });
        endpoints.set(key, node);
      }
    }
    const uniqueInteriors = interiors
      .filter((entry, index, all) => all.findIndex((other) => other.node.id === entry.node.id) === index)
      .sort((a, b) => a.projection.along - b.projection.along);
    if (uniqueInteriors.length > 0) {
      this.deleteSegment(segment.id, false);
      const lineageId = segment.zoningLineageId ?? `roadline-${this.nextLineageId++}`;
      const startOffset = segment.zoningStartOffset ?? 0;
      const splitAnchors = [
        { along: 0, nodeId: segment.startNodeId },
        ...uniqueInteriors.map((entry) => ({ along: entry.projection.along, nodeId: entry.node.id })),
        { along: segmentLength, nodeId: segment.endNodeId },
      ];
      for (let index = 0; index < splitAnchors.length - 1; index += 1) {
        const from = splitAnchors[index];
        const to = splitAnchors[index + 1];
        this.createSegment(
          from.nodeId,
          to.nodeId,
          { kind: 'polyline', points: slicePolyline(segment.geometry.points, from.along, to.along) },
          segment.roadTypeId,
          lineageId,
          startOffset + from.along,
        );
      }
    }
    return [endpoints.get('start')!, endpoints.get('end')!];
  }

  private createNode(position: Vec2): RoadNode {
    const node: RoadNode = { id: `node-${this.nextNodeId++}`, position: { ...position } };
    this.nodes.set(node.id, node);
    return node;
  }

  private createSegment(
    startNodeId: RoadNodeId,
    endNodeId: RoadNodeId,
    geometry: RoadGeometry,
    roadTypeId: string,
    zoningLineageId: RoadLineageId = `roadline-${this.nextLineageId++}`,
    zoningStartOffset = 0,
  ): RoadSegment {
    const roadType = getRoadType(roadTypeId);
    const segment: RoadSegment = {
      id: `segment-${this.nextSegmentId++}`,
      startNodeId,
      endNodeId,
      geometry: structuredClone(geometry),
      roadTypeId,
      width: roadType.width,
      speedLimit: roadType.speedLimit,
      laneIds: [],
      zoningAllowed: roadType.zoningAllowed,
      zoningLineageId,
      zoningStartOffset,
    };
    for (const laneDefinition of roadType.lanes) {
      const lane: Lane = {
        id: `lane-${this.nextLaneId++}`,
        roadSegmentId: segment.id,
        direction: laneDefinition.direction,
        index: laneDefinition.index,
      };
      segment.laneIds.push(lane.id);
      this.lanes.set(lane.id, lane);
    }
    this.segments.set(segment.id, segment);
    return segment;
  }

  private splitSegment(segment: RoadSegment, projection: PolylineProjection): RoadNode {
    const [leftPoints, rightPoints] = splitPolyline(segment.geometry.points, projection);
    const junction = this.createNode(projection.point);
    this.deleteSegment(segment.id, false);
    const lineageId = segment.zoningLineageId ?? `roadline-${this.nextLineageId++}`;
    const startOffset = segment.zoningStartOffset ?? 0;
    this.createSegment(segment.startNodeId, junction.id, { kind: 'polyline', points: leftPoints }, segment.roadTypeId, lineageId, startOffset);
    this.createSegment(junction.id, segment.endNodeId, { kind: 'polyline', points: rightPoints }, segment.roadTypeId, lineageId, startOffset + projection.along);
    return junction;
  }

  private deleteSegment(segmentId: RoadSegmentId, cleanupNodes: boolean): void {
    const segment = this.segments.get(segmentId);
    if (!segment) return;
    for (const laneId of segment.laneIds) this.lanes.delete(laneId);
    this.segments.delete(segmentId);
    if (cleanupNodes) {
      for (const nodeId of [segment.startNodeId, segment.endNodeId]) {
        if (this.connectedSegments(nodeId).length === 0) this.nodes.delete(nodeId);
      }
    }
  }

  private validateSnapshot(snapshot: RoadGraphSnapshot): void {
    const nodeIds = new Set(snapshot.nodes.map((node) => node.id));
    const segmentIds = new Set(snapshot.segments.map((segment) => segment.id));
    const laneIds = new Set(snapshot.lanes.map((lane) => lane.id));
    if (nodeIds.size !== snapshot.nodes.length) throw new Error('Road graph contains duplicate node IDs.');
    if (segmentIds.size !== snapshot.segments.length) throw new Error('Road graph contains duplicate segment IDs.');
    if (laneIds.size !== snapshot.lanes.length) throw new Error('Road graph contains duplicate lane IDs.');
    for (const node of snapshot.nodes) {
      if (!Number.isFinite(node.position.x) || !Number.isFinite(node.position.z)) {
        throw new Error(`Node ${node.id} has a non-finite position.`);
      }
    }
    for (const segment of snapshot.segments) {
      getRoadType(segment.roadTypeId);
      if (!Number.isFinite(segment.width) || segment.width <= 0 || !Number.isFinite(segment.speedLimit) || segment.speedLimit < 0) {
        throw new Error(`Segment ${segment.id} has invalid road properties.`);
      }
      if (segment.geometry.points.length < 2 || segment.geometry.points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.z))) {
        throw new Error(`Segment ${segment.id} has invalid geometry.`);
      }
      if (new Set(segment.laneIds).size !== segment.laneIds.length) {
        throw new Error(`Segment ${segment.id} contains duplicate lane IDs.`);
      }
      if (segment.zoningLineageId !== undefined && !/^roadline-\d+$/.test(segment.zoningLineageId)) {
        throw new Error(`Segment ${segment.id} has an invalid zoning lineage ID.`);
      }
      if (segment.zoningStartOffset !== undefined
        && (!Number.isFinite(segment.zoningStartOffset) || segment.zoningStartOffset < 0)) {
        throw new Error(`Segment ${segment.id} has an invalid zoning start offset.`);
      }
    }
  }
}
