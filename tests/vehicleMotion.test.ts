import { describe, expect, it } from 'vitest';
import { interpolateVehiclePose, VehicleMotion, type VehiclePose } from '../src/traffic/vehicleMotion';

const pose = (x: number, yaw = 0): VehiclePose => ({ x, y: 1, z: 0, yaw });

describe('visible vehicle interpolation', () => {
  it('moves continuously between traffic samples and reaches the authority target', () => {
    const motion = new VehicleMotion();
    motion.sync(new Map([['trip-1', pose(0)]]));
    motion.sync(new Map([['trip-1', pose(5)]]));
    motion.advance(0.25, 1, 5);
    expect(motion.pose('trip-1')?.x).toBeCloseTo(2.5);
    motion.advance(0.25, 1, 5);
    expect(motion.pose('trip-1')?.x).toBeCloseTo(5);
  });

  it('pauses and scales motion with GameClock speed', () => {
    const motion = new VehicleMotion();
    motion.sync(new Map([['trip-1', pose(0)]]));
    motion.sync(new Map([['trip-1', pose(8)]]));
    motion.advance(1, 0, 5);
    expect(motion.pose('trip-1')?.x).toBe(0);
    motion.advance(0.025, 8, 5);
    expect(motion.pose('trip-1')?.x).toBeCloseTo(3.2);
  });

  it('keeps the same trip attached to its pose when selection order changes', () => {
    const motion = new VehicleMotion();
    motion.sync(new Map([['a', pose(0)], ['b', pose(20)]]));
    motion.sync(new Map([['b', pose(21)], ['a', pose(1)]]));
    motion.advance(0.25, 1, 5);
    expect(motion.pose('a')?.x).toBeCloseTo(0.5);
    expect(motion.pose('b')?.x).toBeCloseTo(20.5);
    motion.sync(new Map([['b', pose(21)]]));
    expect([...motion.ids]).toEqual(['b']);
  });

  it('does not reset a moving car when the camera refreshes unchanged targets', () => {
    const motion = new VehicleMotion();
    motion.sync(new Map([['trip-1', pose(0)]]));
    motion.sync(new Map([['trip-1', pose(5)]]));
    motion.advance(0.2, 1, 5);
    motion.sync(new Map([['trip-1', pose(5)]]));
    motion.advance(0.2, 1, 5);
    expect(motion.pose('trip-1')?.x).toBeCloseTo(4);
  });

  it('takes the shortest heading turn and snaps after a route teleport', () => {
    const halfway = interpolateVehiclePose(pose(0, Math.PI - 0.1), pose(2, -Math.PI + 0.1), 0.5);
    expect(Math.abs(halfway.yaw)).toBeCloseTo(Math.PI);
    const motion = new VehicleMotion();
    motion.sync(new Map([['trip-1', pose(0)]]));
    motion.sync(new Map([['trip-1', pose(100)]]));
    expect(motion.pose('trip-1')?.x).toBe(100);
    motion.sync(new Map([['trip-1', pose(102)]]), true);
    expect(motion.pose('trip-1')?.x).toBe(102);
  });
});
