import { afterEach, describe, expect, it, vi } from 'vitest';
import { RailConstruction } from '../src/railway/construction';
import type { GameRenderer } from '../src/renderer/gameRenderer';
import type { SimulationClient } from '../src/app/simulationClient';
import type { RailCommandData } from '../src/railway/types';
import { SimulationState } from '../src/simulation/state';
import { GameRuntime } from '../src/app/gameRuntime';

afterEach(() => vi.unstubAllGlobals());
describe('railway construction interaction', () => {
  function setup() {
    vi.stubGlobal('window', new EventTarget()); const state = new SimulationState(), listeners = new Map<string, (e: PointerEvent) => void>(), commands: RailCommandData[] = [];
    const canvas = { addEventListener: (name: string, listener: (e: PointerEvent) => void) => listeners.set(name, listener), removeEventListener: (name: string) => listeners.delete(name) };
    const renderer = { pickGround: (x: number, z: number) => ({ x, z }), setMapGeometryPreview: vi.fn() };
    const client = { latestSnapshot: state.snapshot(), execute: vi.fn(async (command: RailCommandData) => { commands.push(command); const result = state.execute(command); client.latestSnapshot = state.snapshot(); return { ok: true, result }; }) };
    const controller = new RailConstruction(canvas as unknown as HTMLCanvasElement, renderer as unknown as GameRenderer, client as unknown as SimulationClient);
    const click = async (x: number, z: number) => { listeners.get('pointerdown')!({ clientX: x, clientY: z, button: 0, preventDefault: () => {}, stopImmediatePropagation: () => {} } as PointerEvent); await Promise.resolve(); };
    return { controller, click, commands, state, client };
  }
  it('continues curves from the previous endpoint and tangent until canceled', async () => {
    const { controller, click, commands, state } = setup(); controller.trackMode = 'continuous'; controller.setEnabled(true);
    await click(-200, -200); await click(100, -200); await click(200, 200); expect(commands).toHaveLength(1);
    await click(0, 400); expect(commands).toHaveLength(2); expect(state.railway.segments.size).toBe(2);
    const a = commands[0], b = commands[1]; if (a.type !== 'build-track' || b.type !== 'build-track') throw Error('track expected');
    expect(b.input.points[0]).toEqual(a.input.points.at(-1));
    controller.cancel(); await click(-100, -100); expect(commands).toHaveLength(2); controller.dispose();
  });
  it('does not restore canceled anchors after an asynchronous authority reply', async () => {
    const { controller, click, commands, client } = setup(); let resolve!: (result: { ok: boolean }) => void;
    client.execute.mockImplementationOnce(() => new Promise(r => { resolve = r as typeof resolve; }));
    controller.trackMode = 'continuous'; controller.setEnabled(true); await click(-200, -200); await click(100, -200); await click(200, 200);
    controller.cancel(); resolve({ ok: true }); await Promise.resolve(); await click(0, 400); expect(commands).toHaveLength(0); controller.dispose();
  });
  it.each(['cancelConstruction', 'undo', 'redo'] as const)('%s clears railway anchors through the shared runtime path', async method => {
    const { controller, click, commands } = setup(); controller.setEnabled(true); await click(-200, 0);
    const runtime = Object.create(GameRuntime.prototype) as GameRuntime;
    Object.assign(runtime, { construction: { cancel: vi.fn() }, railConstruction: controller, simulation: { undo: vi.fn(), redo: vi.fn() } });
    runtime[method](); await click(200, 0); expect(commands).toHaveLength(0);
    await click(400, 0); expect(commands).toHaveLength(1); controller.dispose();
  });
});
