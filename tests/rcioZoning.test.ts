import { describe, expect, it } from 'vitest';
import { SimulationState } from '../src/simulation/state';
import { cellIntersectsScreenRect, screenRect, ZoningCellIndex, pointInZoningCell } from '../src/zoning/interaction';
import type { ZoningCell } from '../src/zoning/types';

const makeRoad = (state: SimulationState) => state.execute({
  type: 'build-road',
  input: {
    geometry: { kind: 'straight', points: [{ x: -120, z: 0 }, { x: 120, z: 0 }] },
    roadTypeId: 'small',
  },
});

describe('RCIO zoning', () => {
  it('paints all four types, erases, and undoes one stroke at a time', () => {
    const state = new SimulationState();
    makeRoad(state);
    const ids = state.snapshot().zoningCells.slice(0, 5).map((cell) => cell.id);
    expect(ids).toHaveLength(5);
    const roadRevision = state.snapshot().roadRevision;
    for (const [index, zoneType] of (['residential', 'commercial', 'industrial', 'office'] as const).entries()) {
      state.execute({ type: 'set-zone', cellIds: [ids[index]], zoneType });
    }
    expect(state.snapshot().zoningCells.filter((cell) => cell.zoneType).map((cell) => cell.zoneType))
      .toEqual(expect.arrayContaining(['residential', 'commercial', 'industrial', 'office']));
    expect(state.snapshot().roadRevision).toBe(roadRevision);

    state.execute({ type: 'set-zone', cellIds: [ids[0], ids[1]], zoneType: null });
    expect(state.snapshot().zoningCells.filter((cell) => ids.slice(0, 2).includes(cell.id)).every((cell) => !cell.zoneType)).toBe(true);
    expect(state.undo()).toBe(true);
    expect(state.snapshot().zoningCells.find((cell) => cell.id === ids[0])?.zoneType).toBe('residential');
    expect(state.redo()).toBe(true);
    expect(state.snapshot().zoningCells.find((cell) => cell.id === ids[0])?.zoneType).toBeUndefined();
  });

  it('preserves painted lineage across a road split and mixed undo/redo', () => {
    const state = new SimulationState();
    makeRoad(state);
    const cell = state.snapshot().zoningCells.find((candidate) => candidate.center.x < -70)!;
    state.execute({ type: 'set-zone', cellIds: [cell.id], zoneType: 'residential' });
    state.execute({ type: 'build-road', input: {
      geometry: { kind: 'straight', points: [{ x: 0, z: -80 }, { x: 0, z: 80 }] }, roadTypeId: 'small',
    } });
    expect(state.snapshot().zoningCells.find((candidate) => candidate.id === cell.id)?.zoneType).toBe('residential');
    expect(state.undo()).toBe(true);
    expect(state.snapshot().zoningCells.find((candidate) => candidate.id === cell.id)?.zoneType).toBe('residential');
    expect(state.undo()).toBe(true);
    expect(state.snapshot().zoningCells.find((candidate) => candidate.id === cell.id)?.zoneType).toBeUndefined();
    expect(state.redo()).toBe(true);
    expect(state.redo()).toBe(true);
    expect(state.snapshot().zoningCells.find((candidate) => candidate.id === cell.id)?.zoneType).toBe('residential');
  });

  it('round-trips zoning in v4 saves and rejects stale or corrupt assignments', () => {
    const state = new SimulationState();
    makeRoad(state);
    const id = state.snapshot().zoningCells[0].id;
    state.execute({ type: 'set-zone', cellIds: [id], zoneType: 'office' });
    const save = state.serialize();
    expect(save.saveVersion).toBe(8);
    expect(save.zoningAssignments).toEqual([{ cellId: id, zoneType: 'office' }]);

    const restored = new SimulationState();
    restored.load(JSON.parse(JSON.stringify(save)));
    expect(restored.snapshot().zoningCells.find((cell) => cell.id === id)?.zoneType).toBe('office');
    expect(() => restored.execute({ type: 'set-zone', cellIds: ['zone-not-present'], zoneType: 'commercial' })).toThrow(/no longer exists/);
    const corrupt = structuredClone(save);
    corrupt.zoningAssignments[0].zoneType = 'invalid' as 'office';
    expect(() => restored.load(corrupt)).toThrow(/invalid zoning/);
    expect(restored.snapshot().zoningCells.find((cell) => cell.id === id)?.zoneType).toBe('office');
  });

  it('does not transfer old zoning to a new road after demolition undo/redo', () => {
    const state = new SimulationState();
    makeRoad(state);
    const original = state.snapshot().zoningCells[0];
    state.execute({ type: 'set-zone', cellIds: [original.id], zoneType: 'industrial' });
    state.execute({ type: 'remove-road', segmentId: 'segment-1' });
    expect(state.snapshot().zoningCells).toHaveLength(0);
    expect(state.undo()).toBe(true);
    expect(state.snapshot().zoningCells.find((cell) => cell.id === original.id)?.zoneType).toBe('industrial');
    expect(state.redo()).toBe(true);
    makeRoad(state);
    expect(state.snapshot().zoningCells.some((cell) => cell.zoneType)).toBe(false);
    // World-footprint IDs are stable when the same road is rebuilt; only its
    // cleared zoning assignment must not return.
    expect(state.snapshot().zoningCells.some((cell) => cell.id === original.id)).toBe(true);
  });

  it('indexes rotated cell footprints and their bucket boundaries', () => {
    const cell: ZoningCell = {
      id: 'zone-test', roadSegmentId: 'segment-1', center: { x: 16, z: 16 }, angle: Math.PI / 4,
      depth: 0, side: 1, size: 8,
      corners: [{ x: 16, z: 10 }, { x: 22, z: 16 }, { x: 16, z: 22 }, { x: 10, z: 16 }],
    };
    const index = new ZoningCellIndex();
    index.rebuild([cell]);
    expect(pointInZoningCell({ x: 10, z: 16 }, cell)).toBe(true);
    expect(index.pick({ x: 15, z: 15 })?.id).toBe(cell.id);
    expect(index.pick({ x: 17, z: 17 })?.id).toBe(cell.id);
    expect(index.pick({ x: 25, z: 25 })).toBeUndefined();
    expect(index.queryBounds(14, 14, 18, 18).map((candidate) => candidate.id)).toEqual([cell.id]);
    expect(index.queryBounds(30, 30, 34, 34)).toEqual([]);
  });

  it('box-selects overlapping projected cells in either drag direction', () => {
    const cell: ZoningCell = {
      id: 'zone-box', roadSegmentId: 'segment-1', center: { x: 20, z: 20 }, angle: Math.PI / 4,
      depth: 0, side: 1, size: 8,
      corners: [{ x: 20, z: 10 }, { x: 30, z: 20 }, { x: 20, z: 30 }, { x: 10, z: 20 }],
    };
    const project = (point: { x: number; z: number }) => ({ x: point.x, y: point.z });
    const forward = screenRect({ x: 27, y: 15 }, { x: 36, y: 25 });
    const backward = screenRect({ x: 36, y: 25 }, { x: 27, y: 15 });
    expect(cellIntersectsScreenRect(cell, forward, project)).toBe(true);
    expect(cellIntersectsScreenRect(cell, backward, project)).toBe(true);
    expect(cellIntersectsScreenRect(cell, screenRect({ x: 31, y: 15 }, { x: 40, y: 25 }), project)).toBe(false);
  });
});
