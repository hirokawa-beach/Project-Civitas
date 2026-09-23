export type RoadNodeId = `node-${number}`;
export type RoadSegmentId = `segment-${number}`;
export type LaneId = `lane-${number}`;
export type ZoningCellId = `zone-${string}`;
export type RoadLineageId = `roadline-${number}`;

export const numericId = (id: string): number => {
  const value = Number(id.slice(id.lastIndexOf('-') + 1));
  return Number.isFinite(value) ? value : 0;
};
