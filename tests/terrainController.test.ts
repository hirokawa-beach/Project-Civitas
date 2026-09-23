import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConstructionController, type ConstructionStatus } from '../src/roads/constructionController';
import type { GameRenderer } from '../src/renderer/gameRenderer';
import type { SimulationClient } from '../src/app/simulationClient';

const createHarness = () => {
  const listeners = new Map<string, (event: any) => void>();
  const canvas = {
    addEventListener: (type: string, handler: (event: any) => void) => { listeners.set(type, handler); },
    removeEventListener: vi.fn(),
    setPointerCapture: vi.fn(),
    hasPointerCapture: () => false,
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
  };
  const renderer = {
    pickGround: () => ({ x: 0, z: 0 }),
    setPreview: vi.fn(), setZonePreview: vi.fn(), setHoveredSegment: vi.fn(), setTerrainBrushPreview: vi.fn(),
    getHeight: () => 0, getNormal: () => ({ x: 0, y: 1, z: 0 }),
  };
  const simulation = {
    beginTerrainStroke: vi.fn(), terrainStroke: vi.fn(), endTerrainStroke: vi.fn(), cancelTerrainStroke: vi.fn(),
  };
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const controller = new ConstructionController(canvas as unknown as HTMLCanvasElement, renderer as unknown as GameRenderer, simulation as unknown as SimulationClient);
  return { controller, listeners, simulation, canvas };
};

afterEach(() => vi.unstubAllGlobals());

describe('terrain tool pointer safety', () => {
  it('does not sculpt from pointer movement alone', () => {
    const { controller, listeners, simulation } = createHarness();
    controller.setTool('terrain');
    listeners.get('pointermove')!({ clientX: 100, clientY: 100, pointerId: 1 });
    expect(simulation.beginTerrainStroke).not.toHaveBeenCalled();
    expect(simulation.terrainStroke).not.toHaveBeenCalled();
    listeners.get('pointerdown')!({ button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    expect(simulation.beginTerrainStroke).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it('returns to road mode on right-click without starting another edit', () => {
    const { controller, listeners, simulation } = createHarness();
    let status: ConstructionStatus | undefined;
    controller.subscribe((next) => { status = next; });
    controller.setTool('terrain');
    listeners.get('contextmenu')!({ preventDefault: vi.fn() });
    expect(status?.tool).toBe('road');
    expect(simulation.beginTerrainStroke).not.toHaveBeenCalled();
    controller.dispose();
  });
});
