import { afterEach, describe, expect, it, vi } from 'vitest';
import { SimulationClient } from '../src/app/simulationClient';
import { railwayFixture } from './fixtures/railway';
import type { UIToWorkerMessage, WorkerToUIMessage } from '../src/shared/protocol';
import type { SaveFileV13 } from '../src/save/serializer';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); });
describe('railway Worker authority', () => {
  it('publishes operation events without terrain or full graph copies, pauses and resumes Save state', async () => {
    vi.useFakeTimers(); const messages: WorkerToUIMessage[] = [];
    const worker = { onmessage: null as ((event: MessageEvent<WorkerToUIMessage>) => void) | null, postMessage: (data: UIToWorkerMessage) => scope.onmessage!({ data }) };
    const scope = { onmessage: null as ((event: { data: UIToWorkerMessage }) => void) | null,
      postMessage: (data: WorkerToUIMessage) => { messages.push(data); worker.onmessage!({ data } as MessageEvent<WorkerToUIMessage>); } };
    vi.stubGlobal('self', scope); const client = new SimulationClient(worker as unknown as Worker); await import('../src/worker/simulation.worker');
    const city = railwayFixture(); city.setSpeed(0);
    let request = client.load(city.serialize()); vi.advanceTimersByTime(50); await request;
    const spec = { name: 'Worker line', color: '#58b0d0', start: 30, end: 31, frequency: 120, faceIds: [...city.railway.stations.values()].map(s => s.platforms[0].faces[0].platformFaceId), depotId: [...city.railway.depots.keys()][0], formationTypeId: 'commuter-2', serviceTypeId: 'local', returnService: true };
    const created = client.execute({ type: 'create-rail-frequency', input: spec }); vi.advanceTimersByTime(50); await created;
    messages.length = 0; client.setSpeed(1); vi.advanceTimersByTime(4000);
    expect(client.latestSnapshot!.railwayRuntime!.activeTrains[0].state).toBe('running');
    expect(messages.some(m => m.type === 'rail-runtime-update')).toBe(true); expect(messages.some(m => m.type === 'snapshot' || m.type === 'terrain-update')).toBe(false);
    const graph = client.latestSnapshot!.railway!.segments;
    client.setSpeed(0); vi.advanceTimersByTime(50); const clock = client.latestSnapshot!.gameClock.gameSeconds;
    const processed = client.latestSnapshot!.railwayRuntime!.processedEvents; vi.advanceTimersByTime(1000);
    expect(client.latestSnapshot!.gameClock.gameSeconds).toBe(clock); expect(client.latestSnapshot!.railwayRuntime!.processedEvents).toBe(processed);
    const saved = client.requestSave(); vi.advanceTimersByTime(50); const save = await saved as SaveFileV13;
    request = client.load(save); vi.advanceTimersByTime(50); await request;
    expect(client.latestSnapshot!.railway!.segments).toEqual(graph); expect(client.latestSnapshot!.railwayRuntime!.activeTrains).toEqual(save.railway!.operations!.activeTrains);
    client.setSpeed(8); vi.advanceTimersByTime(10000);
    expect(client.latestSnapshot!.railwayRuntime!.serviceStates.every(s => s.status === 'completed')).toBe(true);
    expect(messages.some(m => m.type === 'notification' && m.level === 'error')).toBe(false);
  });
});
