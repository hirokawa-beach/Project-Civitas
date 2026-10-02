import { ConstructionController, type ActiveTool, type ConstructionStatus, type RoadMode, type ZonePaintMode } from '../roads/constructionController';
import { RailConstruction } from '../railway/construction';
import type { SnapSettingKey } from '../roads/snapping';
import { GameRenderer } from '../renderer/gameRenderer';
import type { WorldSnapshot } from '../shared/protocol';
import type { SimulationClient } from './simulationClient';
import type { ZoneBrush } from '../zoning/types';
import type { TerrainBrushMode, TerrainPreset } from '../world/types';
import type { ServiceType } from '../services/types';
import type { RoadStructureType } from '../roads/types';
import type { PerformanceProfile } from '../visual/agentBudget';
import type { AgentDetails } from '../citizens/types';

export class GameRuntime {
  readonly construction: ConstructionController;
  readonly railConstruction: RailConstruction;
  private inspecting = false;
  private selectedAgent?: AgentDetails;
  private readonly agentListeners = new Set<(enabled: boolean, details?: AgentDetails) => void>();
  private lastAgentView = '';
  private lastInspectionAt = 0;
  private unsubscribeSnapshot: () => void;
  private unsubscribeConstruction: () => void;
  private readonly inspectionPointer = (event: PointerEvent): void => {
    if (this.construction.isEditorMode || !this.inspecting || event.button !== 0) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const rect = this.canvas.getBoundingClientRect();
    this.selectAgent(this.renderer.pickAgent(event.clientX - rect.left, event.clientY - rect.top));
  };
  private constructor(
    readonly renderer: GameRenderer,
    private readonly simulation: SimulationClient,
    private readonly canvas: HTMLCanvasElement,
  ) {
    this.construction = new ConstructionController(canvas, renderer, simulation);
    this.railConstruction = new RailConstruction(canvas, renderer, simulation);
    this.unsubscribeConstruction = this.construction.subscribe((status) => {
      if (status.tool !== 'railway' && this.railConstruction.enabled) this.railConstruction.setEnabled(false);
      const inspecting = status.tool === 'inspect';
      if (this.inspecting !== inspecting) { this.inspecting = inspecting; this.emitAgentSelection(); }
    });
    canvas.addEventListener('pointerdown', this.inspectionPointer, true);
    this.unsubscribeSnapshot = simulation.subscribe((snapshot) => {
      renderer.updateSnapshot(snapshot);
      this.construction.updateSnapshot(snapshot);
    });
  }

  dispose(): void {
    this.unsubscribeSnapshot(); this.unsubscribeConstruction(); this.canvas.removeEventListener('pointerdown', this.inspectionPointer, true);
    this.agentListeners.clear(); this.railConstruction.dispose(); this.construction.dispose(); this.renderer.dispose();
  }

  static async create(canvas: HTMLCanvasElement, simulation: SimulationClient): Promise<GameRuntime> {
    const renderer = await GameRenderer.create(canvas);
    return new GameRuntime(renderer, simulation, canvas);
  }

  setTool(tool: ActiveTool): void { this.inspecting = tool === 'inspect'; this.emitAgentSelection(); this.construction.setTool(tool); }
  setRoadMode(mode: RoadMode): void { this.inspecting = false; this.emitAgentSelection(); this.construction.setRoadMode(mode); }
  setAgentInspection(enabled: boolean): void { this.setTool(enabled ? 'inspect' : 'road'); }
  selectAgent(details?: AgentDetails): void { this.selectedAgent = details; this.emitAgentSelection(); this.lastInspectionAt = 0; this.refreshAgentSelection(); }
  subscribeAgentSelection(listener: (enabled: boolean, details?: AgentDetails) => void): () => void {
    this.agentListeners.add(listener); listener(this.inspecting, this.selectedAgent); return () => this.agentListeners.delete(listener);
  }
  private emitAgentSelection(): void { for (const listener of this.agentListeners) listener(this.inspecting, this.selectedAgent); }
  updateAgentView(): void {
    const view = this.renderer.getAgentView();
    const key = `${Math.round(view.position.x / 8)}:${Math.round(view.position.z / 8)}:${view.radius}:${view.cap}`;
    if (key !== this.lastAgentView) { this.lastAgentView = key; this.simulation.setAgentView(view.position, view.radius, view.cap); }
  }
  refreshAgentSelection(): void {
    if (!this.inspecting || !this.selectedAgent || performance.now() - this.lastInspectionAt < 1000) return;
    this.lastInspectionAt = performance.now(); const id = this.selectedAgent.id;
    void this.simulation.inspectCitizen(id).then((details) => {
      if (this.selectedAgent?.id === id) { this.selectedAgent = details; this.emitAgentSelection(); }
    });
  }
  setRoadStructure(type: RoadStructureType): void { this.construction.setRoadStructure(type); }
  setRoadTargetElevation(meters: number): void { this.construction.setRoadTargetElevation(meters); }
  setZoneBrush(brush: ZoneBrush): void { this.construction.setZoneBrush(brush); }
  setZoneMode(mode: ZonePaintMode): void { this.construction.setZoneMode(mode); }
  setTerrainMode(mode: TerrainBrushMode): void { this.construction.setTerrainMode(mode); }
  setServiceType(type: ServiceType): void { this.construction.setServiceType(type); }
  setTerrainBrush(size: number, strength: number): void { this.construction.setTerrainBrush(size, strength); }
  setTerrainPreset(preset: TerrainPreset): void { this.construction.setTerrainPreset(preset); }
  toggleSnap(setting: SnapSettingKey): void { this.construction.toggleSnap(setting); }
  cancelConstruction(): void { this.construction.cancel(); this.railConstruction.cancel(); }
  endRailConstruction(): void {
    const wasEnabled = this.railConstruction.enabled;
    this.railConstruction.setEnabled(false);
    if (wasEnabled && !this.construction.isEditorMode) this.setTool('road');
  }
  undo(): void {
    this.cancelConstruction();
    this.simulation.undo();
  }
  redo(): void {
    this.cancelConstruction();
    this.simulation.redo();
  }
  toggleDebug(): boolean {
    const next = !this.renderer.getDebugVisible();
    this.renderer.setDebugVisible(next);
    return next;
  }
  toggleTrafficOverlay(): boolean {
    const next = !this.renderer.getTrafficOverlay();
    this.renderer.setTrafficOverlay(next);
    return next;
  }
  setPerformanceProfile(profile: PerformanceProfile): void { this.renderer.setPerformanceProfile(profile); }
  subscribeConstruction(listener: (status: ConstructionStatus) => void): () => void { return this.construction.subscribe(listener); }
  getLatestSnapshot(): WorldSnapshot | undefined { return this.simulation.latestSnapshot; }
}
