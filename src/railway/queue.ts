/** Stable binary heap. Railway events and route searches do not sort/scan all trains. */
export class MinQueue<T> {
  private heap: T[] = [];
  constructor(private less: (a: T, b: T) => boolean) {}
  get size() { return this.heap.length; }
  peek() { return this.heap[0]; }
  values(): T[] { return [...this.heap]; }
  clear() { this.heap = []; }
  push(value: T) {
    let i = this.heap.length; this.heap.push(value);
    while (i > 0) { const parent = (i - 1) >> 1; if (!this.less(this.heap[i], this.heap[parent])) break; [this.heap[i], this.heap[parent]] = [this.heap[parent], this.heap[i]]; i = parent; }
  }
  pop(): T | undefined {
    const first = this.heap[0], last = this.heap.pop(); if (!this.heap.length) return first;
    this.heap[0] = last!; let i = 0;
    while (true) { const left = i * 2 + 1, right = left + 1; let next = i; if (left < this.heap.length && this.less(this.heap[left], this.heap[next])) next = left; if (right < this.heap.length && this.less(this.heap[right], this.heap[next])) next = right; if (next === i) break; [this.heap[i], this.heap[next]] = [this.heap[next], this.heap[i]]; i = next; }
    return first;
  }
}
