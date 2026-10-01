import { CreateLineSystem, CreateLines } from '@babylonjs/core/Meshes/Builders/linesBuilder';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { Scene } from '@babylonjs/core/scene';
import type { RailwaySnapshot, TrackSegment, Station, Depot } from '../railway/types';
import { TrackIndex, trackType } from '../railway/geometry';
import { distance } from '../roads/geometry';
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
  constructor(private scene: Scene, private height: (x: number, z: number) => number) {}
  update(snapshot: RailwaySnapshot | undefined, terrainRevision: number, debug: boolean) {
    this.snapshot = snapshot;
    if (snapshot?.networkRevision !== this.networkRevision || terrainRevision !== this.terrainRevision || this.debug !== debug) {
      this.clear(); this.index.rebuild(snapshot?.segments ?? []); this.viewKey = '';
      this.tracks = new Map(snapshot?.segments.map(t => [t.id, t])); this.stationsByTrack.clear(); this.depotsByTrack.clear();
      for (const station of snapshot?.stations ?? []) for (const id of station.connectedTrackIds) { const values = this.stationsByTrack.get(id) ?? []; values.push(station); this.stationsByTrack.set(id, values); }
      for (const depot of snapshot?.depots ?? []) { const values = this.depotsByTrack.get(depot.connectedTrackId) ?? []; values.push(depot); this.depotsByTrack.set(depot.connectedTrackId, values); }
      this.networkRevision = snapshot?.networkRevision ?? -1; this.terrainRevision = terrainRevision; this.debug = debug;
    }
  }
  draw(center: Vec2, radius: number) {
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
    }
    for (const depot of localDepots.values()) {
      ids.add(depot.id); if (!this.meshes.has(depot.id)) { const p = depot.position; const points = [{ x: p.x - 10, z: p.z - 8 }, { x: p.x + 10, z: p.z - 8 }, { x: p.x + 10, z: p.z + 8 }, { x: p.x - 10, z: p.z + 8 }, { x: p.x - 10, z: p.z - 8 }]; const mesh = CreateLines(depot.id, { points: points.map(p => vector(p, 2)) }, this.scene); mesh.color = Color3.FromHexString('#b4a4e5'); mesh.isPickable = false; this.meshes.set(depot.id, mesh); }
    }
    for (const [id, mesh] of this.meshes) if (!ids.has(id)) { mesh.dispose(); this.meshes.delete(id); }
  }
  private clear() { for (const mesh of this.meshes.values()) mesh.dispose(); this.meshes.clear(); }
  dispose() { this.clear(); }
}
