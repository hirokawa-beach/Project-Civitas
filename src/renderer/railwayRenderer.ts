import { CreateLineSystem, CreateLines } from '@babylonjs/core/Meshes/Builders/linesBuilder';
import '@babylonjs/core/Rendering/edgesRenderer';
import '@babylonjs/core/Rendering/outlineRenderer';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { Scene } from '@babylonjs/core/scene';
import type { RailwaySnapshot, TrackSegment, Station, Depot } from '../railway/types';
import { TrackIndex, trackType } from '../railway/geometry';
import { distance } from '../roads/geometry';
import { railPose, sampleRailPath } from '../railway/routing';
import type { RailRuntimeSnapshot, FormationType } from '../railway/operationsTypes';
import type { Vec2 } from '../world/types';

/** Camera-local representation; never writes track/operation state. */
export class RailwayRenderer {
  private index = new TrackIndex();
  private meshes = new Map<string, Mesh>();
  private snapshot?: RailwaySnapshot;
  private tracks = new Map<string, TrackSegment>();
  private stationsByTrack = new Map<string, Station[]>();
  private depotsByTrack = new Map<string, Depot[]>();
  private viewKey = '';
  private networkRevision = -1;
  private terrainRevision = -1;
  private debug = true;
  private runtime?: RailRuntimeSnapshot;
  private trainMeshes = new Map<string, Mesh[]>();
  private trainTypes = new Map<string, FormationType>();
  private trainColors = new Map<string, string>();
  private faces = new Map<string, { track: TrackSegment; offset: number }>();
  private material: StandardMaterial;
  private center: Vec2 = { x: 0, z: 0 };
  private radius = 2000;
  constructor(private scene: Scene, private height: (x: number, z: number) => number) {
    this.material = new StandardMaterial('rail-trains', scene); this.material.diffuseColor = Color3.FromHexString('#e7e6d8'); this.material.emissiveColor = new Color3(.22, .22, .18);
  }
  updateRuntime(runtime?: RailRuntimeSnapshot) {
    this.runtime = runtime;
    const owned = new Set(runtime?.ownedBlocks.filter(b => b.occupancyOwner || b.reservationOwner).map(b => b.id));
    for (const [id, mesh] of this.meshes) if (this.tracks.has(id)) (mesh as import('@babylonjs/core/Meshes/linesMesh').LinesMesh).color = Color3.FromHexString(this.debug && owned.has(id) ? '#f28b58' : '#c7d5df');
  }
  update(snapshot: RailwaySnapshot | undefined, terrainRevision: number, debug: boolean) {
    this.snapshot = snapshot;
    if (snapshot?.networkRevision !== this.networkRevision || terrainRevision !== this.terrainRevision || this.debug !== debug) {
      this.clear(); this.clearTrains(); this.index.rebuild(snapshot?.segments ?? []); this.viewKey = '';
      this.tracks = new Map(snapshot?.segments.map(t => [t.id, t])); this.stationsByTrack.clear(); this.depotsByTrack.clear();
      for (const station of snapshot?.stations ?? []) for (const id of station.connectedTrackIds) { const values = this.stationsByTrack.get(id) ?? []; values.push(station); this.stationsByTrack.set(id, values); }
      for (const depot of snapshot?.depots ?? []) { const values = this.depotsByTrack.get(depot.connectedTrackId) ?? []; values.push(depot); this.depotsByTrack.set(depot.connectedTrackId, values); }
      this.faces.clear();
      for (const station of snapshot?.stations ?? []) for (const platform of station.platforms) for (const face of platform.faces) { const track = this.tracks.get(face.trackSegmentId); if (track) this.faces.set(face.platformFaceId, { track, offset: face.offset }); }
      const types = new Map(snapshot?.operations?.formationTypes.map(t => [t.id, t]));
      this.trainTypes = new Map(snapshot?.operations?.formations.flatMap(f => { const type = types.get(f.formationTypeId); return type ? [[f.formationId, type] as const] : []; }));
      const colors = new Map(snapshot?.operations?.lines.map(l => [l.id, l.color]));
      this.trainColors = new Map(snapshot?.operations?.services.map(s => [s.id, colors.get(s.lineId) ?? '#e7e6d8']));
      this.networkRevision = snapshot?.networkRevision ?? -1; this.terrainRevision = terrainRevision; this.debug = debug;
    }
  }
  draw(center: Vec2, radius: number) {
    this.center = center; this.radius = Math.min(2000, radius + 180);
    const key = `${Math.floor(center.x / 128)}:${Math.floor(center.z / 128)}:${Math.ceil(radius / 128)}`;
    if (key === this.viewKey) return; this.viewKey = key;
    const r = Math.min(2000, radius + 180), candidates = this.index.query({ x: center.x - r, z: center.z - r }, { x: center.x + r, z: center.z + r });
    const ids = new Set(candidates.map(t => t.id));
    const vector = (p: Vec2, offset = .25) => new Vector3(p.x, this.height(p.x, p.z) + offset, p.z);
    for (const track of candidates) if (!this.meshes.has(track.id)) {
      const type = trackType(this.tracks.get(track.id)!.trackTypeId), rails: Vector3[][] = [[], []];
      for (let i = 0; i < track.points.length; i++) {
        const p = track.points[i], a = track.points[Math.max(0, i - 1)], b = track.points[Math.min(track.points.length - 1, i + 1)], length = distance(a, b) || 1;
        for (const [side, sign] of [[0, -1], [1, 1]]) rails[side].push(vector({ x: p.x - (b.z - a.z) / length * type.gauge / 2 * sign, z: p.z + (b.x - a.x) / length * type.gauge / 2 * sign }));
      }
      const mesh = CreateLineSystem(track.id, { lines: rails }, this.scene); mesh.color = Color3.FromHexString('#c7d5df'); mesh.isPickable = false; this.meshes.set(track.id, mesh);
    }
    const localStations = new Map<string, Station>(), localDepots = new Map<string, Depot>();
    for (const id of ids) { for (const station of this.stationsByTrack.get(id) ?? []) localStations.set(station.stationId, station); for (const depot of this.depotsByTrack.get(id) ?? []) localDepots.set(depot.id, depot); }
    for (const station of localStations.values()) {
      for (const platform of station.platforms) {
        ids.add(platform.platformId);
        if (!this.meshes.has(platform.platformId)) { const mesh = CreateLines(platform.platformId, { points: [...platform.outline, platform.outline[0]].map(p => vector(p, .8)) }, this.scene); mesh.color = Color3.FromHexString('#f4cd75'); mesh.isPickable = false; this.meshes.set(platform.platformId, mesh); }
      }
      if (this.debug) { ids.add(station.stationId); if (!this.meshes.has(station.stationId)) { const mesh = CreateLines(station.stationId, { points: [...station.boundary, station.boundary[0]].map(p => vector(p, .6)) }, this.scene); mesh.color = Color3.FromHexString('#70d0b1'); mesh.isPickable = false; this.meshes.set(station.stationId, mesh); } }
      if (this.debug) for (const platform of station.platforms) for (const face of platform.faces) {
        const id = `face-${face.platformFaceId}`; ids.add(id);
        if (!this.meshes.has(id)) { const track = this.tracks.get(face.trackSegmentId)!; const pose = sampleRailPath(track.points, face.offset), sign = face.side === 'left' ? -1 : 1;
          const p = pose.point, t = pose.tangent; const mesh = CreateLines(id, { points: [vector(p, 1), vector({ x: p.x - t.z * 5 * sign, z: p.z + t.x * 5 * sign }, 1)] }, this.scene); mesh.color = Color3.FromHexString('#f4cd75'); mesh.isPickable = false; this.meshes.set(id, mesh); }
      }
    }
    for (const depot of localDepots.values()) {
      ids.add(depot.id); if (!this.meshes.has(depot.id)) { const p = depot.position; const points = [{ x: p.x - 10, z: p.z - 8 }, { x: p.x + 10, z: p.z - 8 }, { x: p.x + 10, z: p.z + 8 }, { x: p.x - 10, z: p.z + 8 }, { x: p.x - 10, z: p.z - 8 }]; const mesh = CreateLines(depot.id, { points: points.map(p => vector(p, 2)) }, this.scene); mesh.color = Color3.FromHexString('#b4a4e5'); mesh.isPickable = false; this.meshes.set(depot.id, mesh); }
    }
    if (this.debug) {
      const nodes = new Set(candidates.flatMap(t => { const track = this.tracks.get(t.id)!; return [track.startNodeId, track.endNodeId]; }));
      // Nodes are looked up once on a view change; train animation never walks the graph.
      const nodeMap = new Map(this.snapshot?.nodes.map(n => [n.id, n]));
      const junctions = new Set(this.snapshot?.junctions.map(j => j.nodeId));
      for (const id of nodes) {
        const key = `node-${id}`; ids.add(key); if (this.meshes.has(key)) continue;
        const p = nodeMap.get(id)!.position, s = junctions.has(id) ? 4 : 1.5;
        const mesh = CreateLineSystem(key, { lines: [[vector({ x: p.x - s, z: p.z }, 1), vector({ x: p.x + s, z: p.z }, 1)], [vector({ x: p.x, z: p.z - s }, 1), vector({ x: p.x, z: p.z + s }, 1)]] }, this.scene);
        mesh.color = Color3.FromHexString(junctions.has(id) ? '#f28b58' : '#8ba8d9'); mesh.isPickable = false; this.meshes.set(key, mesh);
      }
    }
    for (const [id, mesh] of this.meshes) if (!ids.has(id)) { mesh.dispose(); this.meshes.delete(id); }
    this.updateRuntime(this.runtime);
  }
  animate(gameSeconds: number) {
    const visible = new Set<string>();
    for (const train of this.runtime?.activeTrains ?? []) {
      const type = this.trainTypes.get(train.formationId), face = this.faces.get(train.faceId); if (!type || !face) continue;
      const pose = train.leg ? railPose(train.leg, gameSeconds) : sampleRailPath(face.track.points, face.offset);
      if (distance(pose.point, this.center) > this.radius + type.length) continue;
      visible.add(train.formationId); let meshes = this.trainMeshes.get(train.formationId);
      if (!meshes) { meshes = Array.from({ length: type.cars }, (_, i) => { const mesh = CreateBox(`train-${train.formationId}-${i}`, { width: 2.7, height: 3.3, depth: Math.max(.1, type.length / type.cars - .7) }, this.scene); mesh.material = this.material; mesh.isPickable = false; mesh.enableEdgesRendering(); mesh.edgesColor.set(0.08, .13, .18, 1); return mesh; }); this.trainMeshes.set(train.formationId, meshes); }
      for (let i = 0; i < meshes.length; i++) {
        const offset = ((i + .5) / type.cars - .5) * type.length;
        const car = train.leg ? sampleRailPath(train.leg.route.points, (pose as ReturnType<typeof railPose>).along + offset) : sampleRailPath(face.track.points, face.offset + offset);
        const mesh = meshes[i]; mesh.position.set(car.point.x, this.height(car.point.x, car.point.z) + 1.9, car.point.z); mesh.rotation.y = Math.atan2(car.tangent.x, car.tangent.z);
        mesh.outlineColor = Color3.FromHexString(this.trainColors.get(train.serviceId) ?? '#e7e6d8'); mesh.renderOutline = true; mesh.outlineWidth = .08;
      }
    }
    for (const [id, meshes] of this.trainMeshes) if (!visible.has(id)) { for (const mesh of meshes) mesh.dispose(); this.trainMeshes.delete(id); }
  }
  private clearTrains() { for (const meshes of this.trainMeshes.values()) for (const mesh of meshes) mesh.dispose(); this.trainMeshes.clear(); }
  private clear() { for (const mesh of this.meshes.values()) mesh.dispose(); this.meshes.clear(); }
  dispose() { this.clear(); this.clearTrains(); this.material.dispose(); }
}
