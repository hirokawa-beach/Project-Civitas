import { afterEach, describe, expect, it, vi } from 'vitest';
import { SimulationClient } from '../src/app/simulationClient';
import { SimulationState } from '../src/simulation/state';
import type { UIToWorkerMessage, WorkerToUIMessage } from '../src/shared/protocol';
import { generateMap, presetParameters } from '../src/terrain/generator';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); });

async function connectWorker() {
  vi.useFakeTimers();
  const messages: WorkerToUIMessage[] = [];
  const sent: UIToWorkerMessage[] = [];
  const worker = { onmessage: null as ((event: MessageEvent<WorkerToUIMessage>) => void) | null,
    postMessage: (data: UIToWorkerMessage) => { sent.push(data); scope.onmessage!({ data }); } };
  const scope = { onmessage: null as ((event: { data: UIToWorkerMessage }) => void) | null,
    postMessage: (data: WorkerToUIMessage) => { messages.push(data); worker.onmessage!({ data } as MessageEvent<WorkerToUIMessage>); } };
  vi.stubGlobal('self', scope);
  const client = new SimulationClient(worker as unknown as Worker);
  await import('../src/worker/simulation.worker');
  return { client, messages, sent };
}

describe('startup save loading through the real Worker', () => {
  it('loads an existing city and starts ticking without initializing a throwaway city', async () => {
    const city = new SimulationState();
    city.water.setSeaLevel(-12);
    city.execute({ type: 'build-road', input: { geometry: { kind: 'straight', points: [{ x: -80, z: 0 }, { x: 80, z: 0 }] }, roadTypeId: 'small' } });
    const save = city.serialize();
    const { client, messages, sent } = await connectWorker();
    const loaded = client.load(save);
    expect(client.latestSnapshot).toBeUndefined();
    vi.advanceTimersByTime(50);
    await loaded;
    expect(sent.map((message) => message.type)).toEqual(['load']);
    expect(client.latestSnapshot!.roadGraph).toEqual(city.snapshot().roadGraph);
    expect(Array.from(client.latestSnapshot!.terrainHeightmap!)).toEqual(save.world.terrain.heightmap);
    expect(client.latestSnapshot!.water.seaLevel).toBe(-12);
    const before = client.latestSnapshot!.gameClock.gameSeconds;
    vi.advanceTimersByTime(100);
    expect(client.latestSnapshot!.gameClock.gameSeconds).toBeGreaterThan(before);
    expect(messages.some((message) => message.type === 'clock-update')).toBe(true);
  });

  it('rejects corrupt startup saves, stays uninitialized, and allows retry', async () => {
    const city = new SimulationState();
    const corrupt = city.serialize(); corrupt.world.terrain.heightmap[0] = NaN;
    const { client, messages } = await connectWorker();
    const rejection = expect(client.load(corrupt)).rejects.toThrow(/heightmap/);
    vi.advanceTimersByTime(100); await rejection;
    expect(messages.some((message) => message.type === 'snapshot' || message.type === 'clock-update')).toBe(false);
    const retry = client.load(city.serialize()); vi.advanceTimersByTime(50); await retry;
    expect(client.latestSnapshot?.terrainHeightmap).toBeDefined();
  });

  it('still initializes generated New Game maps with their exact terrain and water', async () => {
    const map = generateMap({ generatorVersion: 1, seed: 'startup-coast', preset: 'coastal', parameters: presetParameters('coastal') });
    const { client } = await connectWorker();
    client.initialize(map); vi.advanceTimersByTime(50);
    expect(client.latestSnapshot!.terrainHeightmap).toEqual(map.heights);
    expect(client.latestSnapshot!.water.seaLevel).toBe(map.metadata.parameters.seaLevel);
  });

  it('preserves the active city when an in-game load fails', async () => {
    const city = new SimulationState(); city.setSpeed(0); city.water.setSeaLevel(-12);
    const { client } = await connectWorker();
    const loaded = client.load(city.serialize()); vi.advanceTimersByTime(50); await loaded;
    const before = client.latestSnapshot;
    const corrupt = city.serialize(); corrupt.water.seaLevel = NaN;
    const rejection = expect(client.load(corrupt)).rejects.toThrow();
    vi.advanceTimersByTime(50); await rejection;
    expect(client.latestSnapshot!.water).toEqual(before!.water);
    expect(client.latestSnapshot!.terrainHeightmap).toEqual(before!.terrainHeightmap);
  });
});
