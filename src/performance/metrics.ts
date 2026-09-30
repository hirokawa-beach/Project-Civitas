export interface TimingSummary { samples: number; mean: number; p95: number; max: number }
export function summarize(values: readonly number[]): TimingSummary {
  if (!values.length) return { samples: 0, mean: 0, p95: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  return { samples: values.length, mean: values.reduce((a, b) => a + b, 0) / values.length,
    p95: sorted[Math.ceil(sorted.length * .95) - 1], max: sorted.at(-1)! };
}

/** Bounded samples; wall times are informational, never a hardware-dependent pass/fail gate. */
export class PerformanceLedger {
  private samples = new Map<string, number[]>();
  record(name: string, value: number): void {
    const values = this.samples.get(name) ?? [];
    values.push(value); if (values.length > 240) values.shift(); this.samples.set(name, values);
  }
  measure<T>(name: string, action: () => T): T {
    const start = performance.now();
    try { return action(); } finally { this.record(name, performance.now() - start); }
  }
  report(): Record<string, TimingSummary> { return Object.fromEntries([...this.samples].map(([key, values]) => [key, summarize(values)])); }
  clear(): void { this.samples.clear(); }
}

/** Estimated structured-clone payload bytes, including UTF-8 strings and raw typed arrays.
 * This is not a browser heap or transport allocation measurement. It avoids JSON-expanding heightmaps. */
export function payloadBytes(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value === 'number') return 8;
  if (typeof value === 'boolean') return 1;
  if (typeof value === 'string') return new TextEncoder().encode(value).byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + payloadBytes(item), 0);
  if (typeof value === 'object') return Object.entries(value).reduce((sum, [key, item]) => sum + key.length + payloadBytes(item), 0);
  return 0;
}
