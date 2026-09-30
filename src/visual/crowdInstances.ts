import type { Mesh } from '@babylonjs/core/Meshes/mesh';

/** Reusable dynamic thin-instance buffers. No per-citizen Babylon object or Matrix allocation. */
export class CrowdInstanceBatch {
  private matrices = new Float32Array(0);
  private boundBuffer?: Float32Array;
  private count = 0;
  private ids: string[] = [];
  constructor(readonly mesh: Mesh) { mesh.alwaysSelectAsActiveMesh = true; }
  get capacity(): number { return this.matrices.length / 16; }
  get bytes(): number { return this.matrices.byteLength; }
  begin(capacity: number): void {
    if (capacity > this.capacity) this.matrices = new Float32Array(16 * 2 ** Math.ceil(Math.log2(Math.max(16, capacity))));
    this.count = 0; this.ids.length = 0;
  }
  append(id: string, x: number, y: number, z: number, yaw: number): void {
    if (this.count >= this.capacity) throw new Error('Crowd batch capacity exceeded.');
    const offset = this.count++ * 16; const c = Math.cos(yaw); const s = Math.sin(yaw);
    const m = this.matrices;
    m[offset] = c; m[offset + 1] = 0; m[offset + 2] = -s; m[offset + 3] = 0;
    m[offset + 4] = 0; m[offset + 5] = 1; m[offset + 6] = 0; m[offset + 7] = 0;
    m[offset + 8] = s; m[offset + 9] = 0; m[offset + 10] = c; m[offset + 11] = 0;
    m[offset + 12] = x; m[offset + 13] = y; m[offset + 14] = z; m[offset + 15] = 1;
    this.ids.push(id);
  }
  commit(): number {
    this.mesh.setEnabled(this.count > 0);
    if (this.count && this.boundBuffer !== this.matrices) {
      this.mesh.thinInstanceSetBuffer('matrix', this.matrices, 16, false);
      this.boundBuffer = this.matrices;
    } else if (this.count) this.mesh.thinInstanceBufferUpdated('matrix');
    this.mesh.thinInstanceCount = this.count;
    this.mesh.isPickable = true; this.mesh.thinInstanceEnablePicking = true;
    this.mesh.metadata = { agentIds: this.ids };
    return this.count;
  }
}
