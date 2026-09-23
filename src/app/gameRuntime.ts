import { ConstructionController, type ActiveTool, type ConstructionStatus, type RoadMode, type ZonePaintMode } from '../roads/constructionController';
import type { SnapSettingKey } from '../roads/snapping';
import { GameRenderer } from '../renderer/gameRenderer';
import type { WorldSnapshot } from '../shared/protocol';
import type { SimulationClient } from './simulationClient';
import type { ZoneBrush } from '../zoning/types';
import type { TerrainBrushMode, TerrainPreset } from '../world/types';

export class GameRuntime {
  readonly construction: ConstructionController;
  private constructor(
    readonly renderer: GameRenderer,
    private readonly simulation: SimulationClient,
    canvas: HTMLCanvasElement,
  ) {
    this.construction = new ConstructionController(canvas, renderer, simulation);
    simulation.subscribe((snapshot) => {
      renderer.updateSnapshot(snapshot);
      this.construction.updateSnapshot(snapshot);
    });
  }

  static async create(canvas: HTMLCanvasElement, simulation: SimulationClient): Promise<GameRuntime> {
    const renderer = await GameRenderer.create(canvas);
    return new GameRuntime(renderer, simulation, canvas);
  }

  setTool(tool: ActiveTool): void { this.construction.setTool(tool); }
  setRoadMode(mode: RoadMode): void { this.construction.setRoadMode(mode); }
  setZoneBrush(brush: ZoneBrush): void { this.construction.setZoneBrush(brush); }
  setZoneMode(mode: ZonePaintMode): void { this.construction.setZoneMode(mode); }
  setTerrainMode(mode: TerrainBrushMode): void { this.construction.setTerrainMode(mode); }
  setTerrainBrush(size: number, strength: number): void { this.construction.setTerrainBrush(size, strength); }
  setTerrainPreset(preset: TerrainPreset): void { this.construction.setTerrainPreset(preset); }
  toggleSnap(setting: SnapSettingKey): void { this.construction.toggleSnap(setting); }
  cancelConstruction(): void { this.construction.cancel(); }
  undo(): void {
    this.construction.cancel();
    this.simulation.undo();
  }
  redo(): void {
    this.construction.cancel();
    this.simulation.redo();
  }
  toggleDebug(): boolean {
    const next = !this.renderer.getDebugVisible();
    this.renderer.setDebugVisible(next);
    return next;
  }
  subscribeConstruction(listener: (status: ConstructionStatus) => void): () => void { return this.construction.subscribe(listener); }
  getLatestSnapshot(): WorldSnapshot | undefined { return this.simulation.latestSnapshot; }
}
