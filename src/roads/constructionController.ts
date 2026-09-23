import type { SimulationClient } from '../app/simulationClient';
import type { GameRenderer, RoadPreviewVisual } from '../renderer/gameRenderer';
import type { RoadSegmentId, ZoningCellId } from '../shared/ids';
import type { WorldSnapshot } from '../shared/protocol';
import type { TerrainBrushMode, TerrainPreset, Vec2 } from '../world/types';
import {
  buildContinuousCurveGeometry,
  buildCurveGeometry,
  buildTwoCurveGeometry,
  isOneCurveSuitable,
  type CurveGeometryResult,
} from './curveGeometry';
import { closestPointOnPolyline, cross, distance, dot, normalize, polylineLength, segmentIntersection, subtract } from './geometry';
import { getRoadType } from './roadTypes';
import {
  DEFAULT_SNAP_SETTINGS,
  resolveConstructionSnap,
  type ConstructionGuide,
  type ConstructionSnapKind,
  type ConstructionSnapResult,
  type SnapSettingKey,
  type SnapSettings,
} from './snapping';
import { validateRoadCandidate, type RoadValidationReason } from './validation';
import type { RoadEndpointIntent, RoadSegment } from './types';
import { RoadSpatialIndex } from './spatialIndex';
import { cellIntersectsScreenRect, pointInZoningCell, screenRect, ZoningCellIndex, type ScreenPoint, type ScreenRect } from '../zoning/interaction';
import type { LotId } from '../lots/types';
import type { ZoneBrush, ZoneType } from '../zoning/types';
import { roadConstructionCost } from '../economy/system';

export type ActiveTool = 'road' | 'demolish' | 'zone' | 'terrain';
export type RoadMode = 'straight' | 'one-curve' | 'two-curve' | 'continuous';
export type ZonePaintMode = 'brush' | 'box';

export const requiredControlPointsForMode = (mode: RoadMode): number => {
  if (mode === 'straight') return 0;
  return mode === 'two-curve' ? 2 : 1;
};

export const stepBackControlPoints = (points: readonly Vec2[]): Vec2[] => points.slice(0, -1);

export interface ConstructionStatus {
  tool: ActiveTool;
  roadMode: RoadMode;
  prompt: string;
  length: number;
  estimatedCost?: number;
  fundsAfterConstruction?: number;
  valid: boolean;
  snap: ConstructionSnapKind;
  guides: ConstructionGuide[];
  snapSettings: SnapSettings;
  plannedIntersections: number;
  analysisMs: number;
  candidateSegments: number;
  curveRadius: number;
  zoneBrush?: ZoneBrush;
  zoneMode?: ZonePaintMode;
  zoneSelectionRect?: ScreenRect;
  selectedZoneCells?: number;
  hoveredZoneType?: ZoneType;
  step?: number;
  totalSteps?: number;
  terrainMode?: TerrainBrushMode;
  terrainSize?: number;
  terrainStrength?: number;
  terrainHeight?: number;
  terrainNormal?: { x: number; y: number; z: number };
  hoveredLotId?: LotId;
}

const DEFAULT_STATUS: ConstructionStatus = {
  tool: 'road', roadMode: 'straight', prompt: 'Click to set a starting point', length: 0, valid: false, snap: 'none', guides: [], snapSettings: { ...DEFAULT_SNAP_SETTINGS }, plannedIntersections: 0, analysisMs: 0, candidateSegments: 0, curveRadius: 0,
};

export class ConstructionController {
  private tool: ActiveTool = 'road';
  private roadMode: RoadMode = 'straight';
  private snapshot?: WorldSnapshot;
  private start?: Vec2;
  private startIntent?: RoadEndpointIntent;
  private controlPoints: Vec2[] = [];
  private cursor?: Vec2;
  private tangentHint?: Vec2;
  private stickySnap?: ConstructionSnapResult;
  private hoveredSegmentId?: RoadSegmentId;
  private commandPending = false;
  private interactionRevision = 0;
  private pointerFrame?: number;
  private readonly snapSettings: SnapSettings = { ...DEFAULT_SNAP_SETTINGS };
  private readonly spatialIndex = new RoadSpatialIndex();
  private readonly zoningIndex = new ZoningCellIndex();
  private indexedRoadRevision = -1;
  private indexedZoningRevision = -1;
  private indexedTerrainRevision = -1;
  private indexedEconomyRevision = -1;
  private zoneBrush: ZoneBrush = 'residential';
  private zoneMode: ZonePaintMode = 'brush';
  private zonePainting = false;
  private zonePointerId?: number;
  private zoneSelectionStart?: ScreenPoint;
  private zoneSelectionEnd?: ScreenPoint;
  private readonly zoneStroke = new Set<ZoningCellId>();
  private lastZonePoint?: Vec2;
  private terrainMode: TerrainBrushMode = 'raise';
  private terrainSize = 48;
  private terrainStrength = 12;
  private terrainPointerId?: number;
  private lastTerrainPoint?: Vec2;
  private lastTerrainTime = 0;
  private status: ConstructionStatus = DEFAULT_STATUS;
  private readonly listeners = new Set<(status: ConstructionStatus) => void>();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly renderer: GameRenderer,
    private readonly simulation: SimulationClient,
  ) {
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerCancel);
    canvas.addEventListener('contextmenu', this.onContextMenu);
    window.addEventListener('keydown', this.onKeyDown);
  }

  updateSnapshot(snapshot: WorldSnapshot): void {
    this.snapshot = snapshot;
    let changed = false;
    if (snapshot.roadRevision !== this.indexedRoadRevision) {
      this.spatialIndex.rebuild(snapshot.roadGraph);
      this.indexedRoadRevision = snapshot.roadRevision;
      changed = true;
    }
    if (snapshot.zoningRevision !== this.indexedZoningRevision || snapshot.terrainRevision !== this.indexedTerrainRevision) {
      this.zoningIndex.rebuild(snapshot.zoningCells);
      this.indexedZoningRevision = snapshot.zoningRevision;
      this.indexedTerrainRevision = snapshot.terrainRevision;
      changed = true;
    }
    if (snapshot.economy.revision !== this.indexedEconomyRevision) {
      this.indexedEconomyRevision = snapshot.economy.revision;
      changed = true;
    }
    if (changed && this.cursor) this.refreshAt(this.cursor);
  }

  setTool(tool: ActiveTool): void {
    this.cancel();
    this.tool = tool;
    this.emit({
      ...DEFAULT_STATUS,
      tool,
      roadMode: this.roadMode,
      zoneBrush: this.zoneBrush,
      zoneMode: this.zoneMode,
      terrainMode: this.terrainMode,
      terrainSize: this.terrainSize,
      terrainStrength: this.terrainStrength,
      prompt: tool === 'road' ? 'Click to set a starting point' : tool === 'zone' ? this.zonePrompt() : tool === 'terrain' ? 'Drag to sculpt terrain' : 'Hover a road and click to demolish',
    });
  }

  setTerrainMode(mode: TerrainBrushMode): void {
    this.cancel();
    this.terrainMode = mode;
    this.tool = 'terrain';
    if (this.cursor) this.refreshAt(this.cursor);
  }

  setTerrainBrush(size: number, strength: number): void {
    this.terrainSize = Math.max(4, Math.min(256, size));
    this.terrainStrength = Math.max(0.1, Math.min(50, strength));
    if (this.cursor) this.refreshAt(this.cursor);
  }

  setTerrainPreset(preset: TerrainPreset): void { this.simulation.setTerrainPreset(preset); }

  setZoneBrush(brush: ZoneBrush): void {
    this.cancel();
    this.tool = 'zone';
    this.zoneBrush = brush;
    if (this.cursor) this.refreshAt(this.cursor);
    else this.emit({ ...DEFAULT_STATUS, tool: 'zone', roadMode: this.roadMode, zoneBrush: brush, zoneMode: this.zoneMode, prompt: this.zonePrompt() });
  }

  setZoneMode(mode: ZonePaintMode): void {
    this.cancel();
    this.tool = 'zone';
    this.zoneMode = mode;
    if (this.cursor) this.refreshAt(this.cursor);
    else this.emit({ ...DEFAULT_STATUS, tool: 'zone', roadMode: this.roadMode, zoneBrush: this.zoneBrush, zoneMode: mode, prompt: this.zonePrompt() });
  }

  setRoadMode(mode: RoadMode): void {
    this.interactionRevision += 1;
    this.clearTerrainInteraction(true);
    this.renderer.setTerrainBrushPreview();
    if (this.tool === 'zone') {
      this.clearZoneInteraction();
    }
    this.roadMode = mode;
    this.tool = 'road';
    this.controlPoints = [];
    this.stickySnap = undefined;
    this.renderer.setPreview(undefined);
    if (this.cursor) this.refreshAt(this.cursor);
    else this.emit({ ...DEFAULT_STATUS, tool: 'road', roadMode: mode, prompt: this.start ? 'Move to continue construction' : 'Click to set a starting point' });
  }

  toggleSnap(setting: SnapSettingKey): void {
    this.snapSettings[setting] = !this.snapSettings[setting];
    if (this.cursor) this.refreshAt(this.cursor);
    else this.emit({ ...this.status, snapSettings: { ...this.snapSettings } });
  }

  subscribe(listener: (status: ConstructionStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }

  cancel(): void {
    this.interactionRevision += 1;
    this.start = undefined;
    this.startIntent = undefined;
    this.controlPoints = [];
    this.tangentHint = undefined;
    this.stickySnap = undefined;
    this.renderer.setPreview(undefined);
    this.clearZoneInteraction();
    this.clearTerrainInteraction(true);
    this.renderer.setTerrainBrushPreview();
    this.renderer.setHoveredSegment(undefined);
    this.hoveredSegmentId = undefined;
    this.emit({ ...DEFAULT_STATUS, tool: this.tool, roadMode: this.roadMode, zoneBrush: this.zoneBrush, zoneMode: this.zoneMode, prompt: this.tool === 'road' ? 'Click to set a starting point' : this.tool === 'zone' ? this.zonePrompt() : this.tool === 'terrain' ? 'Drag to sculpt terrain' : 'Hover a road and click to demolish' });
  }

  dispose(): void {
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerCancel);
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);
    window.removeEventListener('keydown', this.onKeyDown);
    if (this.pointerFrame !== undefined) cancelAnimationFrame(this.pointerFrame);
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (this.tool === 'zone' && this.zonePainting && event.pointerId === this.zonePointerId && this.zoneMode === 'box') {
      this.zoneSelectionEnd = this.canvasPoint(event);
    }
    const point = this.renderer.pickGround(event.clientX, event.clientY);
    if (point) this.cursor = point;
    if (this.tool === 'zone' && this.zonePainting && event.pointerId === this.zonePointerId && this.zoneMode === 'brush' && point) {
      this.collectZoneStroke(point);
    }
    if (this.tool === 'terrain' && this.terrainPointerId === event.pointerId && point) {
      const previous = this.lastTerrainPoint ?? point;
      const steps = Math.max(1, Math.ceil(distance(previous, point) / Math.max(2, this.terrainSize / 5)));
      const points = Array.from({ length: steps }, (_, index) => {
        const t = (index + 1) / steps;
        return { x: previous.x + (point.x - previous.x) * t, z: previous.z + (point.z - previous.z) * t };
      });
      const now = performance.now();
      this.simulation.terrainStroke(points, Math.min(0.25, (now - this.lastTerrainTime) / 1000));
      this.lastTerrainTime = now;
      this.lastTerrainPoint = point;
    }
    if (!this.cursor) return;
    if (this.pointerFrame !== undefined) return;
    this.pointerFrame = requestAnimationFrame(() => {
      this.pointerFrame = undefined;
      if (this.cursor) this.refreshAt(this.cursor);
    });
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || this.commandPending) return;
    const picked = this.renderer.pickGround(event.clientX, event.clientY);
    if (picked) this.cursor = picked;
    if (this.tool === 'terrain') {
      if (!picked) return;
      this.terrainPointerId = event.pointerId;
      this.lastTerrainPoint = picked;
      this.lastTerrainTime = performance.now();
      this.canvas.setPointerCapture(event.pointerId);
      this.simulation.beginTerrainStroke(picked, this.terrainMode, this.terrainSize, this.terrainStrength);
      this.refreshAt(picked);
      return;
    }
    if (!this.cursor) return;
    if (this.tool === 'zone') {
      this.zonePainting = true;
      this.zonePointerId = event.pointerId;
      this.canvas.setPointerCapture(event.pointerId);
      this.zoneStroke.clear();
      this.lastZonePoint = undefined;
      if (this.zoneMode === 'box') {
        this.zoneSelectionStart = this.canvasPoint(event);
        this.zoneSelectionEnd = this.zoneSelectionStart;
        this.collectZoneBox();
      } else this.collectZoneStroke(this.cursor);
      this.refreshAt(this.cursor);
      return;
    }
    if (this.tool === 'demolish') {
      this.hoveredSegmentId = this.findClosestSegment(this.cursor);
      if (this.hoveredSegmentId) void this.removeRoad(this.hoveredSegmentId);
      return;
    }
    const currentSnap = this.snapPoint(this.cursor);
    const current = currentSnap.position;
    if (!this.start) {
      this.start = current;
      this.startIntent = this.endpointIntent(currentSnap);
      this.stickySnap = undefined;
      this.refreshAt(this.cursor);
      return;
    }
    const requiredControls = this.requiredControlPoints();
    if (this.controlPoints.length < requiredControls) {
      const controlPoint = this.nextControlPoint(current, currentSnap);
      const previous = this.controlPoints.at(-1) ?? this.start;
      if (distance(previous, controlPoint) < 2) return;
      this.controlPoints.push(controlPoint);
      this.stickySnap = undefined;
      this.refreshAt(this.cursor);
      return;
    }
    const curve = this.geometryFor(current, currentSnap);
    const points = curve?.points ?? this.previewPoints(current);
    const roadType = getRoadType('small');
    const validation = validateRoadCandidate(this.nearbyGraph(points, 24), points, {
      candidateWidth: roadType.width,
      minimumCurveRadius: curve ? roadType.minimumCurveRadius : 0,
      analyticalCurveRadius: curve?.minimumRadius ?? Number.POSITIVE_INFINITY,
      terrainHeight: (x, z) => this.renderer.getHeight(x, z),
    });
    const modeValid = !(this.roadMode === 'continuous' && curve?.exceedsHalfTurn)
      && !(this.roadMode === 'continuous' && curve && this.continuousEndTangentMismatch(currentSnap, curve))
      && !(this.roadMode === 'one-curve' && curve
        && !isOneCurveSuitable(this.start, current, curve.startTangent, curve.endTangent, roadType.width * 1.5));
    const cost = roadConstructionCost(points, roadType.id);
    if (!validation.valid || !modeValid || (this.snapshot && this.snapshot.economy.funds < cost)) return;
    void this.commitRoad(points, current, currentSnap);
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (this.terrainPointerId === event.pointerId) {
      this.clearTerrainInteraction(false);
      this.simulation.endTerrainStroke();
      if (this.cursor) this.refreshAt(this.cursor);
      return;
    }
    if (!this.zonePainting || event.pointerId !== this.zonePointerId) return;
    if (this.zoneMode === 'box') {
      this.zoneSelectionEnd = this.canvasPoint(event);
      this.collectZoneBox();
    } else {
      const point = this.renderer.pickGround(event.clientX, event.clientY);
      if (point) this.collectZoneStroke(point);
    }
    this.zonePainting = false;
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    this.zonePointerId = undefined;
    this.lastZonePoint = undefined;
    this.zoneSelectionStart = undefined;
    this.zoneSelectionEnd = undefined;
    const cellIds = [...this.zoneStroke];
    this.zoneStroke.clear();
    if (cellIds.length > 0) void this.commitZoneStroke(cellIds);
    else if (this.cursor) this.refreshAt(this.cursor);
  };

  private readonly onPointerCancel = (event: PointerEvent): void => {
    if (this.terrainPointerId === event.pointerId) this.clearTerrainInteraction(true);
    if (this.zonePainting && event.pointerId === this.zonePointerId) {
      this.clearZoneInteraction();
      if (this.cursor) this.refreshAt(this.cursor);
    }
  };

  private readonly onContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
    if (this.tool === 'terrain') {
      this.setTool('road');
      return;
    }
    if (this.controlPoints.length > 0) {
      this.controlPoints = stepBackControlPoints(this.controlPoints);
      this.stickySnap = undefined;
      if (this.cursor) this.refreshAt(this.cursor);
      return;
    }
    this.cancel();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.code === 'Escape') {
      if (this.tool === 'terrain') this.setTool('road');
      else this.cancel();
    }
    if (event.ctrlKey && event.code === 'KeyZ') {
      event.preventDefault();
      this.cancel();
      this.simulation.undo();
    }
    if (event.ctrlKey && event.code === 'KeyY') {
      event.preventDefault();
      this.cancel();
      this.simulation.redo();
    }
  };

  private refreshAt(rawPoint: Vec2): void {
    const analysisStarted = performance.now();
    if (this.tool === 'terrain') {
      this.renderer.setTerrainBrushPreview(rawPoint, this.terrainSize);
      this.emit({ ...DEFAULT_STATUS, tool: 'terrain', roadMode: this.roadMode, prompt: this.terrainPointerId === undefined ? 'Drag to sculpt terrain' : 'Sculpting terrain',
        terrainMode: this.terrainMode, terrainSize: this.terrainSize, terrainStrength: this.terrainStrength,
        terrainHeight: this.renderer.getHeight(rawPoint.x, rawPoint.z), terrainNormal: this.renderer.getNormal(rawPoint.x, rawPoint.z),
        analysisMs: performance.now() - analysisStarted });
      return;
    }
    if (this.tool === 'zone') {
      const hovered = this.zoningIndex.pick(rawPoint);
      if (this.zonePainting && this.zoneMode === 'box') this.collectZoneBox();
      const cells = this.zonePainting && this.snapshot
        ? this.snapshot.zoningCells.filter((cell) => this.zoneStroke.has(cell.id))
        : hovered ? [hovered] : [];
      this.renderer.setZonePreview(cells, this.zoneBrush);
      this.emit({ ...DEFAULT_STATUS, tool: 'zone', roadMode: this.roadMode, zoneBrush: this.zoneBrush, zoneMode: this.zoneMode,
        zoneSelectionRect: this.zonePainting && this.zoneMode === 'box' && this.zoneSelectionStart && this.zoneSelectionEnd
          ? screenRect(this.zoneSelectionStart, this.zoneSelectionEnd) : undefined,
        selectedZoneCells: this.zoneStroke.size, hoveredZoneType: hovered?.zoneType,
        prompt: this.zonePainting
          ? `${this.zoneMode === 'box' ? 'Selecting' : 'Painting'} ${this.zoneStroke.size} cell${this.zoneStroke.size === 1 ? '' : 's'}`
          : this.zoneMode === 'box' ? 'Drag a rectangle to select zoning cells' : hovered ? 'Click or drag to paint this cell' : 'Move over a roadside zoning cell',
        analysisMs: performance.now() - analysisStarted });
      return;
    }
    if (this.tool === 'demolish') {
      this.hoveredSegmentId = this.findClosestSegment(rawPoint);
      this.renderer.setHoveredSegment(this.hoveredSegmentId);
      this.emit({
        ...DEFAULT_STATUS,
        tool: this.tool,
        roadMode: this.roadMode,
        prompt: this.hoveredSegmentId ? `Click to remove ${this.hoveredSegmentId}` : 'Hover a road and click to demolish',
      });
      return;
    }
    const snap = this.snapPoint(rawPoint);
    if (!this.start) {
      this.renderer.setPreview(undefined);
      this.emit({ ...DEFAULT_STATUS, tool: this.tool, roadMode: this.roadMode, snap: snap.type, guides: snap.guides, snapSettings: { ...this.snapSettings }, prompt: 'Click to set a starting point' });
      return;
    }
    const requiredControls = this.requiredControlPoints();
    if (this.controlPoints.length < requiredControls) {
      const controlPosition = this.nextControlPoint(snap.position, snap);
      const startTangent = this.curveStartTangent(this.controlPoints[0] ?? controlPosition);
      const guideLength = Math.max(28, distance(this.start, controlPosition));
      const guides: ConstructionGuide[] = [
        ...snap.guides.filter((guide) => guide.kind !== 'tangent' || distance(guide.from, this.start!) > 1),
        { kind: 'direction', from: { ...(this.controlPoints.at(-1) ?? this.start) }, to: { ...controlPosition }, label: this.controlPoints.length === 0 ? 'INITIAL DIRECTION' : 'END APPROACH' },
      ];
      if (startTangent) {
        guides.push({
          kind: 'tangent',
          from: { ...this.start },
          to: {
            x: this.start.x + startTangent.x * guideLength,
            z: this.start.z + startTangent.z * guideLength,
          },
          label: 'ROAD TANGENT',
        });
      }
      const previousControl = this.controlPoints.at(-1) ?? this.start;
      const handleLength = distance(previousControl, controlPosition);
      const valid = handleLength >= 2;
      const provisionalPoints = this.controlPoints.length === 0
        ? [{ ...this.start }, { ...controlPosition }]
        : buildCurveGeometry({
          start: this.start,
          directionPoint: this.controlPoints[0],
          end: controlPosition,
          startTangent,
        }).points;
      this.renderer.setPreview({
        points: provisionalPoints,
        width: getRoadType('small').width,
        valid,
        snapPosition: snap.type === 'none' ? undefined : snap.position,
        intersections: [],
        guides,
        anchors: [
          { position: this.start, kind: 'start' },
          ...this.controlPoints.map((position) => ({ position, kind: 'direction' as const })),
          { position: controlPosition, kind: 'direction' },
        ],
        labels: [{ position: this.midpoint(previousControl, controlPosition), text: `${handleLength.toFixed(0)} m` }],
        angleArcs: startTangent ? [{
          center: this.start,
          fromDirection: { x: -startTangent.x, z: -startTangent.z },
          toDirection: normalize(subtract(this.controlPoints[0] ?? controlPosition, this.start)),
          radius: getRoadType('small').width + 7,
        }] : [],
      });
      this.emit({
        tool: this.tool,
        roadMode: this.roadMode,
        prompt: valid
          ? this.roadMode === 'two-curve' && this.controlPoints.length === 1
            ? 'Set end approach · align with the target guideline'
            : this.roadMode === 'continuous'
              ? 'Set initial direction · click distance does not affect shape'
              : 'Set start direction · align with an endpoint guideline'
          : 'Move farther from the previous point',
        length: handleLength,
        valid,
        snap: snap.type,
        guides,
        snapSettings: { ...this.snapSettings },
        plannedIntersections: 0,
        analysisMs: performance.now() - analysisStarted,
        candidateSegments: 0,
        curveRadius: 0,
        step: this.controlPoints.length + 1,
        totalSteps: requiredControls + 1,
      });
      return;
    }
    const curve = this.geometryFor(snap.position, snap);
    const points = curve?.points ?? this.previewPoints(snap.position);
    const length = polylineLength(points);
    const nearbyGraph = this.nearbyGraph(points, 24);
    const intersections = this.findIntersections(points, nearbyGraph.segments);
    const roadType = getRoadType('small');
    const estimatedCost = roadConstructionCost(points, roadType.id);
    const fundsAfterConstruction = (this.snapshot?.economy.funds ?? 0) - estimatedCost;
    const affordable = !this.snapshot || fundsAfterConstruction >= 0;
    const validation = validateRoadCandidate(nearbyGraph, points, {
      candidateWidth: roadType.width,
      minimumCurveRadius: curve ? roadType.minimumCurveRadius : 0,
      analyticalCurveRadius: curve?.minimumRadius ?? Number.POSITIVE_INFINITY,
      terrainHeight: (x, z) => this.renderer.getHeight(x, z),
    });
    const oneCurveUnsuitable = this.roadMode === 'one-curve' && curve
      ? !isOneCurveSuitable(this.start, snap.position, curve.startTangent, curve.endTangent, roadType.width * 1.5)
      : false;
    const exceedsHalfTurn = this.roadMode === 'continuous' && curve?.exceedsHalfTurn === true;
    const continuousTangentMismatch = this.roadMode === 'continuous' && curve
      ? this.continuousEndTangentMismatch(snap, curve)
      : false;
    const valid = validation.valid && !oneCurveUnsuitable && !exceedsHalfTurn && !continuousTangentMismatch && affordable;
    const guides = [...snap.guides];
    if (curve) {
      guides.push({
        kind: 'tangent',
        from: { ...this.start },
        to: { ...curve.startControl },
        label: 'START TANGENT',
      });
      guides.push({
        kind: 'tangent',
        from: { ...curve.endControl },
        to: { ...snap.position },
        label: 'END TANGENT',
      });
    }
    const visual: RoadPreviewVisual = {
      points,
      width: roadType.width,
      valid,
      snapPosition: snap.type === 'none' ? undefined : snap.position,
      intersections,
      guides,
      anchors: [
        { position: this.start, kind: 'start' },
        ...this.controlPoints.map((position) => ({ position, kind: 'direction' as const })),
        { position: snap.position, kind: 'end' },
      ],
      labels: curve ? [
        { position: curve.points[Math.floor(curve.points.length / 2)], text: `${length.toFixed(0)} m` },
        { position: this.midpoint(this.start, curve.startControl), text: `${distance(this.start, curve.startControl).toFixed(0)} m` },
        { position: this.midpoint(curve.endControl, snap.position), text: `${distance(curve.endControl, snap.position).toFixed(0)} m` },
      ] : [{ position: this.midpoint(this.start, snap.position), text: `${length.toFixed(0)} m` }],
      angleArcs: curve ? [
        ...(this.startIntent && this.startIntent.kind !== 'free' ? [{
          center: this.start,
          fromDirection: { x: -curve.startTangent.x, z: -curve.startTangent.z },
          toDirection: curve.startTangent,
          radius: roadType.width + 7,
        }] : []),
        ...(snap.type === 'node' || snap.type === 'segment' ? [{
          center: snap.position,
          fromDirection: { x: -curve.endTangent.x, z: -curve.endTangent.z },
          toDirection: curve.endTangent,
          radius: roadType.width + 7,
        }] : []),
      ] : [],
    };
    this.renderer.setPreview(visual);
    this.emit({
      tool: this.tool,
      roadMode: this.roadMode,
      prompt: valid
          ? this.roadMode !== 'straight'
            ? 'Click endpoint to build · right-click goes back one step'
            : 'Click to build · right-click to cancel'
          : oneCurveUnsuitable
            ? 'Cannot build naturally · use 2-CURVE'
            : exceedsHalfTurn
              ? 'Cannot build · split arcs beyond 180°'
              : continuousTangentMismatch
                ? 'Cannot join smoothly · adjust endpoint or use 2-CURVE'
              : !affordable
                ? 'Cannot build · Not enough funds'
              : `Cannot build · ${this.validationMessage(validation.reasons[0])}`,
      length,
      estimatedCost,
      fundsAfterConstruction,
      valid,
      snap: snap.type,
      guides,
      snapSettings: { ...this.snapSettings },
      plannedIntersections: intersections.length,
      analysisMs: performance.now() - analysisStarted,
      candidateSegments: nearbyGraph.segments.length,
      curveRadius: curve && Number.isFinite(curve.minimumRadius) ? curve.minimumRadius : 0,
      step: requiredControls + 1,
      totalSteps: requiredControls + 1,
    });
  }

  private collectZoneStroke(point: Vec2): void {
    const previous = this.lastZonePoint ?? point;
    const steps = Math.max(1, Math.ceil(distance(previous, point) / 4));
    for (let step = 0; step <= steps; step += 1) {
      const t = step / steps;
      const cell = this.zoningIndex.pick({
        x: previous.x + (point.x - previous.x) * t,
        z: previous.z + (point.z - previous.z) * t,
      });
      if (cell) this.zoneStroke.add(cell.id);
    }
    this.lastZonePoint = point;
  }

  private collectZoneBox(): void {
    if (!this.snapshot || !this.zoneSelectionStart || !this.zoneSelectionEnd) return;
    this.zoneStroke.clear();
    const rect = screenRect(this.zoneSelectionStart, this.zoneSelectionEnd);
    const canvasRect = this.canvas.getBoundingClientRect();
    if (rect.right - rect.left < 4 && rect.bottom - rect.top < 4) {
      const point = this.renderer.pickGround(canvasRect.left + this.zoneSelectionEnd.x, canvasRect.top + this.zoneSelectionEnd.y);
      const cell = point && this.zoningIndex.pick(point);
      if (cell) this.zoneStroke.add(cell.id);
      return;
    }
    const groundCorners = [
      { x: rect.left, y: rect.top }, { x: rect.right, y: rect.top },
      { x: rect.right, y: rect.bottom }, { x: rect.left, y: rect.bottom },
    ].map((corner) => this.renderer.pickGround(canvasRect.left + corner.x, canvasRect.top + corner.y));
    const candidates = groundCorners.every(Boolean)
      ? this.zoningIndex.queryBounds(
          Math.min(...groundCorners.map((point) => point!.x)),
          Math.min(...groundCorners.map((point) => point!.z)),
          Math.max(...groundCorners.map((point) => point!.x)),
          Math.max(...groundCorners.map((point) => point!.z)),
        )
      : this.snapshot.zoningCells;
    for (const cell of candidates) {
      if (cell.terrainSuitable !== false && cellIntersectsScreenRect(cell, rect, (point) => this.renderer.projectGround(point))) this.zoneStroke.add(cell.id);
    }
  }

  private canvasPoint(event: PointerEvent): ScreenPoint {
    const rect = this.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private clearZoneInteraction(): void {
    if (this.zonePointerId !== undefined && this.canvas.hasPointerCapture(this.zonePointerId)) {
      this.canvas.releasePointerCapture(this.zonePointerId);
    }
    this.zonePointerId = undefined;
    this.zonePainting = false;
    this.zoneStroke.clear();
    this.lastZonePoint = undefined;
    this.zoneSelectionStart = undefined;
    this.zoneSelectionEnd = undefined;
    this.renderer.setZonePreview([], this.zoneBrush);
  }

  private clearTerrainInteraction(cancel: boolean): void {
    if (this.terrainPointerId !== undefined && this.canvas.hasPointerCapture(this.terrainPointerId)) this.canvas.releasePointerCapture(this.terrainPointerId);
    if (cancel && this.terrainPointerId !== undefined) this.simulation.cancelTerrainStroke();
    this.terrainPointerId = undefined;
    this.lastTerrainPoint = undefined;
  }

  private zonePrompt(): string {
    return this.zoneMode === 'box' ? 'Drag a rectangle to select zoning cells' : 'Click or drag across zoning cells';
  }

  private async commitZoneStroke(cellIds: ZoningCellId[]): Promise<void> {
    this.commandPending = true;
    try {
      await this.simulation.execute({ type: 'set-zone', cellIds, zoneType: this.zoneBrush });
    } finally {
      this.commandPending = false;
      if (this.cursor) this.refreshAt(this.cursor);
    }
  }

  private previewPoints(end: Vec2): Vec2[] {
    if (!this.start) return [];
    return [{ ...this.start }, { ...end }];
  }

  private snapPoint(point: Vec2): ConstructionSnapResult {
    const snapOrigin = this.controlPoints.at(-1) ?? this.start;
    const result = resolveConstructionSnap({
      raw: point,
      start: snapOrigin,
      graph: this.spatialIndex.query(this.start ? [this.start, point] : [point], 240),
      settings: this.snapSettings,
      tangentHint: this.start && (this.roadMode === 'straight' || this.controlPoints.length === 0)
        ? this.curveStartTangent(point)
        : undefined,
      previousSnap: this.stickySnap,
    });
    this.stickySnap = result;
    return result;
  }

  private geometryFor(end: Vec2, endSnap: ConstructionSnapResult): CurveGeometryResult | undefined {
    if (this.roadMode === 'straight' || !this.start || this.controlPoints.length < this.requiredControlPoints()) return undefined;
    const startTangent = this.curveStartTangent(this.controlPoints[0]);
    const endTangent = this.curveEndTangent(endSnap, this.controlPoints.at(-1)!);
    if (this.roadMode === 'one-curve') {
      return buildCurveGeometry({
        start: this.start,
        directionPoint: this.controlPoints[0],
        end,
        startTangent,
        endTangent,
      });
    }
    if (this.roadMode === 'two-curve') {
      return buildTwoCurveGeometry({
        start: this.start,
        firstDirectionPoint: this.controlPoints[0],
        secondDirectionPoint: this.controlPoints[1],
        end,
        startTangent,
        endTangent,
      });
    }
    return buildContinuousCurveGeometry({
      start: this.start,
      initialDirection: subtract(this.controlPoints[0], this.start),
      end,
    });
  }

  private requiredControlPoints(): number {
    return requiredControlPointsForMode(this.roadMode);
  }

  private nextControlPoint(position: Vec2, snap: ConstructionSnapResult): Vec2 {
    if (!this.start) return position;
    if (this.roadMode === 'continuous' && this.controlPoints.length === 0) {
      const direction = this.curveStartTangent(position) ?? normalize(subtract(position, this.start));
      return {
        x: this.start.x + direction.x * 40,
        z: this.start.z + direction.z * 40,
      };
    }
    if (this.controlPoints.length === 0) return this.curveDirectionPoint(position, snap);
    return position;
  }

  private curveDirectionPoint(position: Vec2, snap: ConstructionSnapResult): Vec2 {
    if (!this.start) return position;
    const startTangent = this.curveStartTangent(position);
    if (!startTangent) return position;
    const endpointGuide = snap.guides.find((guide) => guide.kind === 'tangent' && distance(guide.from, this.start!) > 1);
    if (endpointGuide) {
      const endDirection = normalize(subtract(endpointGuide.to, endpointGuide.from));
      const denominator = cross(startTangent, endDirection);
      if (Math.abs(denominator) > 0.001) {
        const offset = subtract(endpointGuide.from, this.start);
        const alongStart = cross(offset, endDirection) / denominator;
        const alongEnd = cross(offset, startTangent) / denominator;
        if (alongStart >= 2 && alongStart <= 320 && alongEnd >= 0) {
          return {
            x: this.start.x + startTangent.x * alongStart,
            z: this.start.z + startTangent.z * alongStart,
          };
        }
      }
    }
    const projectedLength = dot(subtract(position, this.start), startTangent);
    if (projectedLength >= 2) {
      return {
        x: this.start.x + startTangent.x * projectedLength,
        z: this.start.z + startTangent.z * projectedLength,
      };
    }
    return position;
  }

  private midpoint(first: Vec2, second: Vec2): Vec2 {
    return { x: (first.x + second.x) / 2, z: (first.z + second.z) / 2 };
  }

  private curveStartTangent(directionPoint: Vec2): Vec2 | undefined {
    if (!this.start) return undefined;
    if (this.tangentHint && Math.hypot(this.tangentHint.x, this.tangentHint.z) > 0.1) {
      return normalize(this.tangentHint);
    }
    return this.bestConnectionTangent(
      this.startIntent,
      this.start,
      normalize(subtract(directionPoint, this.start)),
    );
  }

  private curveEndTangent(snap: ConstructionSnapResult, referencePoint: Vec2): Vec2 | undefined {
    if (snap.type === 'none') return undefined;
    const intent = this.endpointIntent(snap);
    return this.bestConnectionTangent(
      intent,
      snap.position,
      normalize(subtract(snap.position, referencePoint)),
    );
  }

  private continuousEndTangentMismatch(snap: ConstructionSnapResult, curve: CurveGeometryResult): boolean {
    const candidates = this.connectionTangents(this.endpointIntent(snap), snap.position);
    return candidates.length > 0
      && Math.max(...candidates.map((candidate) => dot(candidate, curve.endTangent))) < Math.cos(11 * Math.PI / 180);
  }

  private bestConnectionTangent(intent: RoadEndpointIntent | undefined, position: Vec2, desired: Vec2): Vec2 | undefined {
    const candidates = this.connectionTangents(intent, position);
    if (candidates.length === 0) return undefined;
    return candidates.sort((left, right) => dot(right, desired) - dot(left, desired))[0];
  }

  private connectionTangents(intent: RoadEndpointIntent | undefined, position: Vec2): Vec2[] {
    if (!intent || intent.kind === 'free' || !this.snapshot) return [];
    const segments = intent.kind === 'segment'
      ? this.snapshot.roadGraph.segments.filter((segment) => segment.id === intent.segmentId)
      : this.snapshot.roadGraph.segments.filter((segment) => segment.startNodeId === intent.nodeId || segment.endNodeId === intent.nodeId);
    const candidates: Vec2[] = [];
    for (const segment of segments) {
      const projection = closestPointOnPolyline(position, segment.geometry.points);
      const start = segment.geometry.points[projection.segmentIndex];
      const end = segment.geometry.points[Math.min(segment.geometry.points.length - 1, projection.segmentIndex + 1)];
      const tangent = normalize(subtract(end, start));
      if (Math.hypot(tangent.x, tangent.z) <= 0.1) continue;
      for (const candidate of [tangent, { x: -tangent.x, z: -tangent.z }]) {
        if (!candidates.some((existing) => dot(existing, candidate) > 0.999)) candidates.push(candidate);
      }
    }
    return candidates;
  }

  private findClosestSegment(point: Vec2): RoadSegmentId | undefined {
    let best: { id: RoadSegmentId; distance: number } | undefined;
    for (const segment of this.spatialIndex.query([point], 24).segments) {
      const candidateDistance = closestPointOnPolyline(point, segment.geometry.points).distance;
      if (candidateDistance <= segment.width / 2 + 4 && (!best || candidateDistance < best.distance)) {
        best = { id: segment.id, distance: candidateDistance };
      }
    }
    return best?.id;
  }

  private findIntersections(points: Vec2[], nearbySegments: RoadSegment[]): Vec2[] {
    const results: Vec2[] = [];
    for (let newIndex = 0; newIndex < points.length - 1; newIndex += 1) {
      for (const segment of nearbySegments) {
        for (let index = 0; index < segment.geometry.points.length - 1; index += 1) {
          const crossing = segmentIntersection(points[newIndex], points[newIndex + 1], segment.geometry.points[index], segment.geometry.points[index + 1]);
          if (crossing && !results.some((point) => distance(point, crossing.point) < 1)) results.push(crossing.point);
        }
      }
    }
    return results;
  }

  private nearbyGraph(points: Vec2[], padding: number) {
    return this.spatialIndex.query(points, padding);
  }

  private async commitRoad(points: Vec2[], end: Vec2, endSnap: ConstructionSnapResult): Promise<void> {
    this.commandPending = true;
    const interactionRevision = this.interactionRevision;
    const mode = this.roadMode;
    const response = await this.simulation.execute({
      type: 'build-road',
      input: {
        geometry: { kind: mode === 'straight' ? 'straight' : 'curve', points },
        roadTypeId: 'small',
        endpointIntents: {
          start: this.startIntent ?? { kind: 'free', position: { ...points[0] } },
          end: this.endpointIntent(endSnap),
        },
      },
    });
    this.commandPending = false;
    if (!response.ok || interactionRevision !== this.interactionRevision) {
      if (this.cursor) this.refreshAt(this.cursor);
      return;
    }
    const authoritativeEnd = response.result?.type === 'build-road' ? response.result.endPosition : end;
    this.tangentHint = points.length >= 2
      ? normalize(subtract(authoritativeEnd, points.at(-2)!))
      : undefined;
    this.start = authoritativeEnd;
    this.startIntent = response.result?.type === 'build-road'
      ? { kind: 'node', nodeId: response.result.endNodeId, position: { ...authoritativeEnd } }
      : { kind: 'free', position: { ...authoritativeEnd } };
    this.controlPoints = [];
    this.stickySnap = undefined;
    if (this.cursor) this.refreshAt(this.cursor);
  }

  private endpointIntent(snap: ConstructionSnapResult): RoadEndpointIntent {
    if (snap.type === 'node' && snap.targetId) {
      return { kind: 'node', nodeId: snap.targetId as `node-${number}`, position: { ...snap.position } };
    }
    if (snap.type === 'segment' && snap.targetId) {
      return { kind: 'segment', segmentId: snap.targetId as RoadSegmentId, position: { ...snap.position } };
    }
    return { kind: 'free', position: { ...snap.position } };
  }

  private async removeRoad(segmentId: RoadSegmentId): Promise<void> {
    this.commandPending = true;
    await this.simulation.execute({ type: 'remove-road', segmentId });
    this.commandPending = false;
  }

  private validationMessage(reason?: RoadValidationReason): string {
    switch (reason) {
      case 'out-of-bounds': return 'outside map';
      case 'too-short': return 'road too short';
      case 'parallel-overlap': return 'overlaps existing road';
      case 'road-footprint-overlap': return 'road surfaces would overlap';
      case 'self-intersection': return 'self intersection';
      case 'sharp-turn': return 'turn is too sharp';
      case 'short-kink': return 'bend is too short';
      case 'curve-radius': return 'curve radius is too tight';
      case 'steep-grade': return 'terrain slope is too steep';
      case 'invalid-geometry': return 'invalid geometry';
      case 'insufficient-points': return 'more points required';
      default: return 'invalid placement';
    }
  }

  private emit(status: ConstructionStatus): void {
    const hoveredLotId = this.cursor && this.snapshot?.lots.find((lot) => pointInZoningCell(this.cursor!, lot))?.id;
    this.status = { ...status, ...(status.tool === 'terrain' ? {
      terrainMode: this.terrainMode, terrainSize: this.terrainSize, terrainStrength: this.terrainStrength,
    } : {}), hoveredLotId, snapSettings: { ...this.snapSettings } };
    for (const listener of this.listeners) listener(this.status);
  }
}
