import type { RoadTypeDefinition } from './types';

export const ROAD_TYPES: Readonly<Record<string, RoadTypeDefinition>> = {
  small: {
    id: 'small',
    label: 'Small road',
    width: 16,
    speedLimit: 40,
    minimumCurveRadius: 24,
    lanes: [
      { direction: 'forward', index: 0 },
      { direction: 'backward', index: 0 },
    ],
    zoningAllowed: true,
  },
};

export const getRoadType = (id: string): RoadTypeDefinition => {
  const roadType = ROAD_TYPES[id];
  if (!roadType) throw new Error(`Unknown road type: ${id}`);
  return roadType;
};
