import { closestPointOnPolyline, distance, normalize, pointAtDistance, polylineLength, segmentIntersection, slicePolyline, subtract } from '../roads/geometry';
import { LandOwnership } from '../world/landOwnership';
import type { Vec2 } from '../world/types';
import type { TrackNode, TrackSegment, Junction, Station, Depot, RailwaySave, RailwaySnapshot, RailCommandData, RailBlock, PlatformFace } from './types';
import { sampleTrackPath, collinearOverlap, TrackIndex, TrackEdgeIndex, validateTrack, validateSimpleTrackPath, trackType } from './geometry';

const validRectangle = (points: Vec2[]): boolean => {
  if (!Array.isArray(points) || points.length !== 4 || points.some(p => !p || ![p.x, p.z].every(Number.isFinite))) return false;
  const u = subtract(points[1], points[0]), v = subtract(points[3], points[0]), width = Math.hypot(u.x, u.z), depth = Math.hypot(v.x, v.z);
  return width > .01 && depth > .01 && Math.abs(u.x * v.x + u.z * v.z) / (width * depth) < 1e-5
    && distance(points[2], { x: points[0].x + u.x + v.x, z: points[0].z + u.z + v.z }) < .01;
};

export class RailwayInfrastructure {
  revision = 0;
  networkRevision = 0;
  protected nextId = 1;
  readonly nodes = new Map<string, TrackNode>();
  readonly segments = new Map<string, TrackSegment>();
  readonly junctions = new Map<string, Junction>();
  readonly stations = new Map<string, Station>();
  readonly depots = new Map<string, Depot>();
  readonly blocks = new Map<string, RailBlock>();
  readonly index = new TrackIndex();
  private edges = new TrackEdgeIndex();
  private faceIndex = new Map<string, { station: Station; face: PlatformFace; length: number }>();
  protected adjacency = new Map<string, string[]>();
  private nodeIndex = new Map<string, TrackNode[]>();
  ownership = new LandOwnership({ worldWidthMeters: 1024, worldDepthMeters: 1024 });
  height: (x: number, z: number) => number = () => 0;
  waterAt: (x: number, z: number) => boolean = () => false;
  protected id(prefix: string) { return `${prefix}-${this.nextId++}`; }
  save(): RailwaySave { return structuredClone({ version: 1, nextId: this.nextId, nodes: [...this.nodes.values()], segments: [...this.segments.values()],
    junctions: [...this.junctions.values()], stations: [...this.stations.values()], depots: [...this.depots.values()], blocks: [...this.blocks.values()] }); }
  snapshot(): RailwaySnapshot { return { ...this.save(), revision: this.revision, networkRevision: this.networkRevision }; }
  assertEditable(): void { if ([...this.blocks.values()].some(b => b.occupancyOwner || b.reservationOwner)) throw new Error('Stop rail operations before Undo/Redo of infrastructure.'); }
  restoreConstruction(save: RailwaySave): void { this.assertEditable(); this.restore(save); }
  restore(save: RailwaySave): void {
    if (!save || save.version !== 1 || !Number.isSafeInteger(save.nextId) || save.nextId < 1) throw new Error('Invalid railway save.');
    const put = <T extends { [key: string]: unknown }>(values: T[], key: keyof T, target: Map<string, T>) => {
      if (!Array.isArray(values) || values.length > 100000) throw new Error('Invalid railway collection.');
      target.clear(); for (const value of values) { const id = value?.[key]; if (typeof id !== 'string' || !id || target.has(id)) throw new Error('Invalid duplicate railway ID.'); target.set(id, structuredClone(value)); }
    };
    // Restore is used on detached instances during load; commands roll back on any failure.
    put(save.nodes as unknown as Record<string, unknown>[], 'id', this.nodes as unknown as Map<string, Record<string, unknown>>);
    put(save.segments as unknown as Record<string, unknown>[], 'id', this.segments as unknown as Map<string, Record<string, unknown>>);
    put(save.junctions as unknown as Record<string, unknown>[], 'id', this.junctions as unknown as Map<string, Record<string, unknown>>);
    put(save.stations as unknown as Record<string, unknown>[], 'stationId', this.stations as unknown as Map<string, Record<string, unknown>>);
    put(save.depots as unknown as Record<string, unknown>[], 'id', this.depots as unknown as Map<string, Record<string, unknown>>);
    put(save.blocks as unknown as Record<string, unknown>[], 'id', this.blocks as unknown as Map<string, Record<string, unknown>>);
    const allIds = [...this.nodes.keys(), ...this.segments.keys(), ...this.junctions.keys(), ...this.stations.keys(), ...this.depots.keys()];
    if (allIds.some(id => !/^[a-z-]+-\d+$/.test(id) || Number(id.match(/\d+$/)![0]) >= save.nextId)) throw new Error('Invalid railway ID sequence.');
    for (const node of this.nodes.values()) if (!node.position || ![node.position.x, node.position.z].every(Number.isFinite)
      || Math.abs(node.position.x) > this.ownership.world.worldWidthMeters / 2 || Math.abs(node.position.z) > this.ownership.world.worldDepthMeters / 2) throw new Error('Invalid track node.');
    for (const segment of this.segments.values()) {
      // Suitability is checked on construction. Later floods/terrain presets
      // must not make an already saved city's infrastructure impossible to load.
      validateTrack(segment.points, segment.trackTypeId, () => 0, this.ownership, () => false, .01);
      if (!this.nodes.has(segment.startNodeId) || !this.nodes.has(segment.endNodeId) || segment.startNodeId === segment.endNodeId
        || distance(this.nodes.get(segment.startNodeId)!.position, segment.points[0]) > .01
        || distance(this.nodes.get(segment.endNodeId)!.position, segment.points.at(-1)!) > .01
        || Math.abs(polylineLength(segment.points) - segment.length) > .01) throw new Error('Invalid track geometry/node reference.');
    }
    this.nextId = save.nextId; this.rebuild();
    if ([...this.nodes.keys()].some(id => !this.adjacency.has(id)) || [...this.adjacency].filter(([, ids]) => ids.length >= 3).length !== this.junctions.size) throw new Error('Invalid railway nodes/junctions.');
    for (const junction of this.junctions.values()) {
      const ids = this.adjacency.get(junction.nodeId) ?? [];
      if (junction.id !== `junction-${junction.nodeId.split('-').at(-1)}` || ids.length < 3 || ids.length !== junction.segmentIds.length || ids.some(id => !junction.segmentIds.includes(id))) throw new Error('Invalid junction connectivity.');
      if (junction.selectedRoute && (junction.selectedRoute.length !== 2 || junction.selectedRoute[0] === junction.selectedRoute[1] || junction.selectedRoute.some(id => !ids.includes(id)))) throw new Error('Invalid switch route.');
    }
    for (const station of this.stations.values()) {
      if (!station.name?.trim() || !station.platforms?.length || !validRectangle(station.boundary) || !this.ownership.canConstruct({ kind: 'polygon', points: station.boundary }).allowed) throw new Error('Invalid station.');
      for (const platform of station.platforms) {
        if (!Number.isFinite(platform.length) || platform.length < 20 || !platform.faces?.length || !validRectangle(platform.outline) || !this.ownership.canConstruct({ kind: 'polygon', points: platform.outline }).allowed) throw new Error('Invalid platform.');
        for (const face of platform.faces) {
          const track = this.segments.get(face.trackSegmentId);
          if (!track || !Number.isFinite(face.offset) || face.offset < platform.length / 2 - .01 || face.offset + platform.length / 2 > track.length + .01
            || !['both', 'forward', 'reverse'].includes(face.direction) || !['left', 'right'].includes(face.side)) throw new Error('Invalid platform face.');
        }
      }
      const faceTracks = new Set(station.platforms.flatMap(p => p.faces.map(face => face.trackSegmentId)));
      if (!Array.isArray(station.connectedTrackIds) || station.connectedTrackIds.length !== faceTracks.size
        || new Set(station.connectedTrackIds).size !== faceTracks.size || station.connectedTrackIds.some(id => !faceTracks.has(id))) throw new Error('Invalid station connected tracks.');
    }
    const faceIds = [...this.stations.values()].flatMap(s => s.platforms.flatMap(p => p.faces.map(f => f.platformFaceId)));
    const platformIds = [...this.stations.values()].flatMap(s => s.platforms.map(p => p.platformId));
    if ([...platformIds, ...faceIds].some(id => !/^[a-z-]+-\d+$/.test(id) || Number(id.match(/\d+$/)![0]) >= save.nextId)) throw new Error('Invalid platform ID sequence.');
    if (new Set([...allIds, ...faceIds, ...platformIds]).size !== allIds.length + faceIds.length + platformIds.length) throw new Error('Duplicate railway object ID.');
    for (const depot of this.depots.values()) if (!this.segments.has(depot.connectedTrackId) || !depot.name?.trim() || !Number.isInteger(depot.capacity) || depot.capacity < 1 || depot.capacity > 1000
      || !this.ownership.canConstruct({ kind: 'polygon', points: this.depotOutline(depot.position) }).allowed) throw new Error('Invalid depot.');
    const resources = this.resourceIds();
    if (resources.size !== this.blocks.size || [...resources].some(id => !this.blocks.has(id))) throw new Error('Invalid railway block resources.');
    for (const block of this.blocks.values()) if ([block.occupancyOwner, block.reservationOwner].some(owner => owner !== null && (typeof owner !== 'string' || !owner.trim()))
      || block.occupancyOwner && block.reservationOwner && block.occupancyOwner !== block.reservationOwner) throw new Error('Invalid railway block owner.');
    this.revision++; this.networkRevision++;
  }
  mutate(command: RailCommandData): string[] {
    const before = this.save();
    try {
      if ([...this.blocks.values()].some(b => b.occupancyOwner || b.reservationOwner)) throw new Error('Release occupied/reserved railway resources before editing.');
      let ids: string[];
      switch (command.type) {
        case 'build-track': ids = this.build(command.input.points, command.input.trackTypeId); break;
        case 'place-station': ids = [this.placeStation(command)]; break;
        case 'place-depot': {
          const track = this.requireTrack(command.trackSegmentId), offset = command.offset ?? track.length / 2;
          if (!Number.isFinite(offset) || offset < 0 || offset > track.length) throw new Error('Choose a depot offset within the connected track.');
          const position = pointAtDistance(track.points, offset).point;
          const outline = this.depotOutline(position), permission = this.ownership.canConstruct({ kind: 'polygon', points: outline });
          if (!permission.allowed) throw new Error(permission.reason);
          this.validateFootprint(outline, track.trackTypeId);
          if (!command.name.trim() || !Number.isInteger(command.capacity) || command.capacity < 1 || command.capacity > 1000) throw new Error('Depot needs a name and capacity from 1 to 1000.');
          const id = this.id('depot'); this.depots.set(id, { id, name: command.name.trim(), connectedTrackId: track.id, capacity: command.capacity, position }); ids = [id]; break;
        }
        case 'set-rail-switch': {
          const junction = this.junctions.get(command.junctionId); if (!junction) throw new Error('Junction no longer exists.');
          if (command.route && (command.route.length !== 2 || command.route[0] === command.route[1] || command.route.some(id => !junction.segmentIds.includes(id)))) throw new Error('Choose two connected track legs.');
          junction.selectedRoute = command.route ? [...command.route] : null; ids = [junction.id]; break;
        }
        case 'remove-railway': {
          if (command.kind === 'track') { this.ensureUnreferenced(command.id); if (!this.segments.delete(command.id)) throw new Error('Track no longer exists.'); }
          else if (command.kind === 'station') { if (!this.stations.delete(command.id)) throw new Error('Station no longer exists.'); }
          else if (!this.depots.delete(command.id)) throw new Error('Depot no longer exists.');
          ids = [command.id]; break;
        }
      }
      this.reconcile(); this.revision++; this.networkRevision++; return ids;
    } catch (error) { this.restore(before); throw error; }
  }
  requireTrack(id: string) { const track = this.segments.get(id); if (!track) throw new Error('Track no longer exists.'); return track; }
  face(id: string): { station: Station; face: PlatformFace; length: number } {
    const value = this.faceIndex.get(id); if (value) return value;
    throw new Error('Platform face no longer exists.');
  }
  fitsPlatform(faceId: string, formationLength: number): boolean { return Number.isFinite(formationLength) && formationLength > 0 && formationLength <= this.face(faceId).length; }
  reserve(owner: string, resourceIds: string[]): boolean {
    if (!owner.trim() || !resourceIds.length || resourceIds.some(id => !this.blocks.has(id))) throw new Error('Invalid block reservation.');
    if (resourceIds.some(id => { const b = this.blocks.get(id)!; return b.occupancyOwner && b.occupancyOwner !== owner || b.reservationOwner && b.reservationOwner !== owner; })) return false;
    for (const id of resourceIds) this.blocks.get(id)!.reservationOwner = owner;
    this.revision++; return true;
  }
  occupy(owner: string, resourceIds: string[]): boolean { if (!this.reserve(owner, resourceIds)) return false; for (const id of resourceIds) this.blocks.get(id)!.occupancyOwner = owner; this.revision++; return true; }
  release(owner: string, resources = [...this.blocks.keys()]): void { for (const id of resources) { const b = this.blocks.get(id); if (b?.occupancyOwner === owner) b.occupancyOwner = null; if (b?.reservationOwner === owner) b.reservationOwner = null; } this.revision++; }
  junctionAllows(node: string, incoming: string, outgoing: string): boolean {
    const junction = this.junctions.get(`junction-${node.split('-').at(-1)}`);
    return !junction?.selectedRoute || junction.selectedRoute.includes(incoming) && junction.selectedRoute.includes(outgoing);
  }
  protected ensureUnreferenced(id: string): void { if ([...this.stations.values()].some(s => s.connectedTrackIds.includes(id)) || [...this.depots.values()].some(d => d.connectedTrackId === id)) throw new Error('Remove the station/depot before changing its track.'); }
  protected build(input: Vec2[], typeId: string): string[] {
    const points = structuredClone(input);
    // Snap endpoints to nearby existing tracks. Splits stay strictly within this Track Graph.
    for (const endpoint of [0, points.length - 1]) {
      const p = points[endpoint]; if (!p) continue;
      let nearest = { distance: 6.001, point: p };
      for (const track of this.index.query({ x: p.x - 6, z: p.z - 6 }, { x: p.x + 6, z: p.z + 6 })) {
        const candidate = closestPointOnPolyline(p, track.points); if (candidate.distance < nearest.distance) nearest = candidate;
      }
      if (nearest.distance <= 6) points[endpoint] = nearest.point;
    }
    validateTrack(points, typeId, this.height, this.ownership, this.waterAt);
    validateSimpleTrackPath(points);
    const cuts = new Map<string, number[]>(), ownCuts = [0, polylineLength(points)]; let traversed = 0;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i], legLength = distance(a, b);
      for (const edge of this.edges.query(a, b)) {
        const [c, d] = edge.points, hit = segmentIntersection(a, b, c, d);
        if (collinearOverlap(a, b, c, d)) throw new Error('Track overlaps an existing track.');
        if (hit) { ownCuts.push(traversed + legLength * hit.aT); const values = cuts.get(edge.trackId) ?? []; values.push(edge.along + edge.length * hit.bT); cuts.set(edge.trackId, values); }
      }
      traversed += legLength;
    }
    for (const endpoint of [points[0], points.at(-1)!]) for (const track of this.index.query({ x: endpoint.x - .01, z: endpoint.z - .01 }, { x: endpoint.x + .01, z: endpoint.z + .01 })) {
      const projection = closestPointOnPolyline(endpoint, track.points);
      if (projection.distance < .01) { const values = cuts.get(track.id) ?? []; values.push(projection.along); cuts.set(track.id, values); }
    }
    for (const [id, values] of cuts) this.split(id, values);
    const values = this.uniqueCuts(ownCuts); const ids: string[] = [];
    for (let i = 1; i < values.length; i++) if (values[i] - values[i - 1] >= .5) ids.push(this.add(slicePolyline(points, values[i - 1], values[i]), typeId));
    return ids;
  }
  protected add(points: Vec2[], trackTypeId: string): string {
    points = sampleTrackPath(points);
    if (points.length > 16384) throw new Error('Track path is too long. Construct it in shorter sections.');
    const node = (position: Vec2) => {
      const x = Math.round(position.x * 100), z = Math.round(position.z * 100);
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        const match = this.nodeIndex.get(`${x + dx}:${z + dz}`)?.find(n => distance(n.position, position) < .01); if (match) return match.id;
      }
      const id = this.id('track-node'), value = { id, position: { ...position } }; this.nodes.set(id, value);
      const key = `${x}:${z}`, bucket = this.nodeIndex.get(key) ?? []; bucket.push(value); this.nodeIndex.set(key, bucket); return id;
    };
    const startNodeId = node(points[0]), endNodeId = node(points.at(-1)!); if (startNodeId === endNodeId) throw new Error('Closed track segments need distinct nodes.');
    const id = this.id('track'); this.segments.set(id, { id, startNodeId, endNodeId, points: structuredClone(points), length: polylineLength(points), trackTypeId }); return id;
  }
  private uniqueCuts(values: number[]) { return values.sort((a, b) => a - b).filter((v, i, all) => i === 0 || v - all[i - 1] > .01); }
  private split(id: string, values: number[]): string[] {
    const track = this.requireTrack(id), cuts = this.uniqueCuts([0, track.length, ...values.filter(v => v > .01 && v < track.length - .01)]);
    if (cuts.length === 2) return [id]; this.ensureUnreferenced(id); this.segments.delete(id);
    const ids: string[] = []; for (let i = 1; i < cuts.length; i++) ids.push(this.add(slicePolyline(track.points, cuts[i - 1], cuts[i]), track.trackTypeId)); return ids;
  }
  private placeStation(command: Extract<RailCommandData, { type: 'place-station' }>): string {
    const track = this.requireTrack(command.trackSegmentId), length = command.length, offset = command.offset;
    if (!command.name?.trim() || !['single', 'double', 'island'].includes(command.template) || !Number.isFinite(length) || length < 20 || length > 400
      || !Number.isFinite(offset) || offset - length / 2 < 80 || offset + length / 2 > track.length - 80) throw new Error('Station needs a straight track with 80m approaches on both ends and a 20–400m platform.');
    const start = track.points[0], end = track.points.at(-1)!, direction = normalize(subtract(end, start)), normal = { x: -direction.z, z: direction.x };
    if (track.points.some(p => closestPointOnPolyline(p, [start, end]).distance > .05)) throw new Error('Station templates require straight track.');
    const at = (along: number, side = 0) => { const p = pointAtDistance(track.points, along).point; return { x: p.x + normal.x * side, z: p.z + normal.z * side }; };
    const rectangle = (side: number, halfWidth: number) => [at(offset - length / 2, side - halfWidth), at(offset + length / 2, side - halfWidth), at(offset + length / 2, side + halfWidth), at(offset - length / 2, side + halfWidth)];
    const boundary = rectangle(command.template === 'single' ? -2 : 3, command.template === 'single' ? 4 : 8);
    const permission = this.ownership.canConstruct({ kind: 'polygon', points: boundary }); if (!permission.allowed) throw new Error(permission.reason);
    this.validateFootprint(boundary, track.trackTypeId);
    const from = offset - length / 2, to = offset + length / 2;
    const generated = command.template === 'single' ? [] : [
      [at(from, 6), at(to, 6)],
      ...[true, false].map(approach => Array.from({ length: 21 }, (_, i) => { const t = i / 20, smooth = t * t * (3 - 2 * t); return approach ? at(from - 80 + t * 80, smooth * 6) : at(to + t * 80, (1 - smooth) * 6); })),
    ];
    for (const points of generated) {
      validateTrack(points, track.trackTypeId, this.height, this.ownership, this.waterAt);
      this.validateGeneratedTrack(points, track.id);
    }
    const pieces = this.split(track.id, [from - 80, from, to, to + 80]);
    const base = pieces.find(id => Math.abs(this.requireTrack(id).length - length) < .01 && distance(this.requireTrack(id).points[0], at(from)) < .01)!;
    const stationId = this.id('station'), firstFace: PlatformFace = { platformFaceId: this.id('platform-face'), trackSegmentId: base, offset: length / 2, side: 'left', direction: 'both' };
    const platforms: Station['platforms'] = [{ platformId: this.id('platform'), length, faces: [firstFace], outline: rectangle(command.template === 'island' ? 3 : -3, 1.5) }];
    const connectedTrackIds = [base];
    if (command.template !== 'single') {
      const second = this.add(generated[0], track.trackTypeId); connectedTrackIds.push(second);
      for (const points of generated.slice(1)) this.add(points, track.trackTypeId);
      const face: PlatformFace = { platformFaceId: this.id('platform-face'), trackSegmentId: second, offset: length / 2, side: command.template === 'island' ? 'right' : 'left', direction: 'both' };
      if (command.template === 'island') platforms[0].faces.push(face);
      else platforms.push({ platformId: this.id('platform'), length, faces: [face], outline: rectangle(9, 1.5) });
    }
    this.stations.set(stationId, { stationId, name: command.name.trim(), platforms, connectedTrackIds, boundary }); return stationId;
  }
  depotOutline(p: Vec2): Vec2[] { return [{ x: p.x - 10, z: p.z - 8 }, { x: p.x + 10, z: p.z - 8 }, { x: p.x + 10, z: p.z + 8 }, { x: p.x - 10, z: p.z + 8 }]; }
  private validateFootprint(outline: Vec2[], typeId: string) {
    const [a, b, , d] = outline, columns = Math.ceil(distance(a, b) / 4), rows = Math.ceil(distance(a, d) / 4);
    const columnSpacing = distance(a, b) / columns, rowSpacing = distance(a, d) / rows, maxGrade = trackType(typeId).maxGrade;
    const previousRow = new Float64Array(columns + 1);
    for (let row = 0; row <= rows; row++) for (let column = 0; column <= columns; column++) {
      const u = column / columns, v = row / rows;
      const x = a.x + (b.x - a.x) * u + (d.x - a.x) * v, z = a.z + (b.z - a.z) * u + (d.z - a.z) * v, height = this.height(x, z);
      if (!Number.isFinite(height)) throw new Error('Railway footprint has missing terrain.');
      if (this.waterAt(x, z)) throw new Error('Railway station/depot footprint crosses water.');
      const alongGrade = column ? (height - previousRow[column - 1]) / columnSpacing : 0;
      const crossGrade = row ? (height - previousRow[column]) / rowSpacing : 0;
      if (Math.hypot(alongGrade, crossGrade) > maxGrade + 1e-6) throw new Error('Railway footprint grade exceeds the track type limit.');
      previousRow[column] = height;
    }
  }
  private validateGeneratedTrack(points: Vec2[], baseTrackId: string) {
    for (let i = 1; i < points.length; i++) for (const edge of this.edges.query(points[i - 1], points[i])) {
      const [c, d] = edge.points;
      if (collinearOverlap(points[i - 1], points[i], c, d)) throw new Error('Generated station track overlaps an existing track.');
      const hit = segmentIntersection(points[i - 1], points[i], c, d); if (!hit) continue;
      const existing = this.requireTrack(edge.trackId), endpoint = distance(hit.point, points[0]) < .01 || distance(hit.point, points.at(-1)!) < .01;
      // The template splits its base alignment at approach endpoints. Other
      // alignments may connect only at an already existing graph endpoint.
      if (endpoint && (edge.trackId === baseTrackId || distance(hit.point, existing.points[0]) < .01 || distance(hit.point, existing.points.at(-1)!) < .01)) continue;
      throw new Error('Generated station track collides with an existing track; choose clear approach space.');
    }
  }
  protected rebuild(): void {
    this.nodeIndex.clear(); for (const node of this.nodes.values()) { const key = `${Math.round(node.position.x * 100)}:${Math.round(node.position.z * 100)}`, bucket = this.nodeIndex.get(key) ?? []; bucket.push(node); this.nodeIndex.set(key, bucket); }
    this.adjacency.clear(); for (const track of this.segments.values()) for (const node of [track.startNodeId, track.endNodeId]) { const ids = this.adjacency.get(node) ?? []; ids.push(track.id); this.adjacency.set(node, ids); }
    this.index.rebuild(this.segments.values());
    this.edges.rebuild(this.segments.values());
    this.faceIndex.clear(); for (const station of this.stations.values()) for (const platform of station.platforms) for (const face of platform.faces) this.faceIndex.set(face.platformFaceId, { station, face, length: platform.length });
  }
  protected resourceIds(): Set<string> { return new Set([...this.segments.keys(), ...this.junctions.keys(), ...[...this.stations.values()].flatMap(s => s.platforms.flatMap(p => p.faces.map(f => f.platformFaceId)))]); }
  protected reconcile(): void {
    this.rebuild(); for (const id of this.nodes.keys()) if (!this.adjacency.has(id)) this.nodes.delete(id);
    const old = this.junctions; const next = new Map<string, Junction>();
    for (const [nodeId, ids] of this.adjacency) if (ids.length >= 3) {
      const id = `junction-${nodeId.split('-').at(-1)}`, previous = old.get(id)?.selectedRoute;
      next.set(id, { id, nodeId, segmentIds: ids, selectedRoute: previous?.every(segment => ids.includes(segment)) ? previous : null });
    }
    this.junctions.clear(); for (const [id, value] of next) this.junctions.set(id, value);
    const resources = this.resourceIds(); for (const id of this.blocks.keys()) if (!resources.has(id)) this.blocks.delete(id);
    for (const id of resources) if (!this.blocks.has(id)) this.blocks.set(id, { id, occupancyOwner: null, reservationOwner: null });
  }
}
