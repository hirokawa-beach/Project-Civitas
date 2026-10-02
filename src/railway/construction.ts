import type { GameRenderer } from '../renderer/gameRenderer';
import type { SimulationClient } from '../app/simulationClient';
import type { Vec2 } from '../world/types';
import { closestPointOnPolyline, polylineLength } from '../roads/geometry';
import { trackGeometry, TrackIndex } from './geometry';
import type { StationTemplate, TrackMode } from './types';

export class RailConstruction {
  enabled = false;
  mode: 'track' | 'station' | 'depot' | 'demolish' = 'track';
  trackMode: TrackMode = 'straight';
  trackTypeId = 'standard';
  template: StationTemplate = 'single';
  length = 120;
  name = 'Station';
  capacity = 8;
  status = 'Choose a railway tool, then click the terrain.';
  private anchors: Vec2[] = [];
  private pending = false;
  private index = new TrackIndex();
  private networkRevision = -1;
  private interactionRevision = 0;
  private listeners = new Set<(status: string) => void>();
  constructor(private canvas: HTMLCanvasElement, private renderer: GameRenderer, private client: SimulationClient) {
    canvas.addEventListener('pointerdown', this.down, true); canvas.addEventListener('pointermove', this.move, true);
    window.addEventListener('keydown', this.key);
  }
  subscribe(listener: (status: string) => void) { this.listeners.add(listener); listener(this.status); return () => { this.listeners.delete(listener); }; }
  private emit(text: string) { this.status = text; for (const listener of this.listeners) listener(text); }
  setEnabled(enabled: boolean) { this.enabled = enabled; this.cancel(); }
  cancel() { this.interactionRevision++; this.anchors = []; this.renderer.setMapGeometryPreview(); this.emit('Click a start point or an existing track for station/depot placement. Esc cancels.'); }
  dispose() { this.canvas.removeEventListener('pointerdown', this.down, true); this.canvas.removeEventListener('pointermove', this.move, true); window.removeEventListener('keydown', this.key); this.listeners.clear(); }
  private snap(point: Vec2) {
    const snapshot = this.client.latestSnapshot?.railway;
    if (snapshot?.networkRevision !== this.networkRevision) { this.index.rebuild(snapshot?.segments ?? []); this.networkRevision = snapshot?.networkRevision ?? -1; }
    let best: ReturnType<typeof closestPointOnPolyline> & { id?: string } = { point, distance: 12, along: 0, segmentIndex: 0, t: 0 };
    for (const track of this.index.query({ x: point.x - 12, z: point.z - 12 }, { x: point.x + 12, z: point.z + 12 })) {
      const candidate = closestPointOnPolyline(point, track.points); if (candidate.distance < best.distance) best = { ...candidate, id: track.id };
    }
    return best;
  }
  private move = (event: PointerEvent) => {
    if (!this.enabled) return;
    event.stopImmediatePropagation();
    const point = this.renderer.pickGround(event.clientX, event.clientY); if (!point || !this.anchors.length || this.mode !== 'track') return;
    try {
      const anchors = [...this.anchors, this.snap(point).point], expected = this.trackMode === 'straight' ? 2 : this.trackMode === 'two-curve' ? 4 : 3;
      const points = anchors.length === expected ? trackGeometry(this.trackMode, anchors) : anchors;
      this.renderer.setMapGeometryPreview(points, false);
      this.emit(`${Math.round(polylineLength(points))} m · click ${anchors.length < expected ? 'direction control' : 'end point'} (${this.anchors.length + 1}/${expected})`);
    } catch { this.renderer.setMapGeometryPreview([...this.anchors, point], false); }
  };
  private down = (event: PointerEvent) => {
    if (!this.enabled || event.button !== 0) return;
    event.preventDefault(); event.stopImmediatePropagation(); if (this.pending) return;
    const point = this.renderer.pickGround(event.clientX, event.clientY); if (!point) return;
    const snap = this.snap(point);
    if (this.mode === 'track') {
      this.anchors.push(snap.point); const expected = this.trackMode === 'straight' ? 2 : this.trackMode === 'two-curve' ? 4 : 3;
      if (this.anchors.length < expected) { this.emit(`Point ${this.anchors.length}/${expected}. Click the next control/end point.`); return; }
      try { const points = trackGeometry(this.trackMode, this.anchors); void this.submit({ type: 'build-track', input: { points, trackTypeId: this.trackTypeId } }, this.trackMode === 'continuous' ? points : undefined); }
      catch (error) { this.cancel(); this.emit(String(error)); }
    } else if (!snap.id) this.emit('Click within 12m of an existing track.');
    else if (this.mode === 'station') void this.submit({ type: 'place-station', trackSegmentId: snap.id, offset: snap.along, name: this.name, template: this.template, length: this.length });
    else if (this.mode === 'depot') void this.submit({ type: 'place-depot', trackSegmentId: snap.id, offset: snap.along, name: this.name === 'Station' ? 'Depot' : this.name, capacity: this.capacity });
    else void this.submit({ type: 'remove-railway', kind: 'track', id: snap.id });
  };
  private async submit(command: import('./types').RailCommandData, continuation?: Vec2[]) {
    const revision = this.interactionRevision;
    this.pending = true; this.emit('Applying railway command…');
    try { const response = await this.client.execute(command);
      if (revision !== this.interactionRevision) return;
      this.cancel(); this.emit(response.ok ? 'Railway updated.' : response.error ?? 'Railway command rejected; see the notification.');
      if (response.ok && continuation && this.enabled && this.trackMode === 'continuous') {
        const end = continuation.at(-1)!, previous = continuation.at(-2)!;
        this.anchors = [end, { x: end.x + end.x - previous.x, z: end.z + end.z - previous.z }];
        this.renderer.setMapGeometryPreview([end], false); this.emit('Continuous curve: click the next end point. Esc starts a new alignment.');
      }
    }
    finally { this.pending = false; }
  }
  private key = (event: KeyboardEvent) => {
    if (!this.enabled || (event.target as HTMLElement)?.closest('input,textarea,select')) return;
    // The shared road controller sends history shortcuts; clear this controller
    // as well without sending a second Undo/Redo command.
    if (event.ctrlKey && (event.code === 'KeyZ' || event.code === 'KeyY')) this.cancel();
    if (event.key === 'Escape') this.cancel();
    if (event.key === 'Backspace') { event.preventDefault(); this.anchors.pop(); this.renderer.setMapGeometryPreview(this.anchors, false); }
  };
}
