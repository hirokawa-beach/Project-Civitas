import { SimulationState } from '../../src/simulation/state';
import type { StationTemplate } from '../../src/railway/types';

export function railwayFixture(template: StationTemplate = 'single') {
  const state = new SimulationState();
  state.execute({ type: 'build-track', input: { points: [{ x: -480, z: 0 }, { x: 480, z: 0 }], trackTypeId: 'standard' } });
  const first = [...state.railway.segments.values()][0];
  state.execute({ type: 'place-station', trackSegmentId: first.id, offset: 180, length: 120, template, name: 'West' });
  const last = [...state.railway.segments.values()].find(t => t.points.at(-1)!.x === 480)!;
  state.execute({ type: 'place-station', trackSegmentId: last.id, offset: 460, length: 120, template: 'single', name: 'East' });
  const depotTrack = [...state.railway.segments.values()].find(t => t.points[0].x === -480)!;
  state.execute({ type: 'place-depot', trackSegmentId: depotTrack.id, capacity: 8, name: 'West Depot' });
  return state;
}
