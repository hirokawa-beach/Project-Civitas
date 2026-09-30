import type { Vec2 } from '../world/types';
import type { PedestrianGraph } from '../visual/pedestrianGraph';
import { pointAtDistance, polylineLength } from '../roads/geometry';

export class PedestrianRouter {
  private nodes = new Map<string, Vec2>();
  private links = new Map<string, Array<{ to: string; length: number }>>();
  private cache = new Map<string, Vec2[] | null>();
  update(graph: PedestrianGraph): void {
    this.nodes = new Map(graph.nodes.map((node) => [node.id, node.point]));
    this.links.clear(); this.cache.clear();
    for (const edge of graph.edges) for (const [from, to] of [[edge.from, edge.to], [edge.to, edge.from]]) {
      const links = this.links.get(from) ?? [];
      links.push({ to, length: edge.length }); this.links.set(from, links);
    }
  }
  route(from: string, to: string): Vec2[] | null {
    const key = `${from}>${to}`;
    if (this.cache.has(key)) return this.cache.get(key)!;
    if (!this.nodes.has(from) || !this.nodes.has(to)) return null;
    const distances = new Map<string, number>([[from, 0]]);
    const previous = new Map<string, string>();
    const queue: Array<{ id: string; cost: number }> = [{ id: from, cost: 0 }];
    while (queue.length) {
      queue.sort((a, b) => b.cost - a.cost);
      const item = queue.pop()!;
      if (item.cost !== distances.get(item.id)) continue;
      if (item.id === to) break;
      for (const link of this.links.get(item.id) ?? []) {
        const cost = item.cost + link.length;
        if (cost >= (distances.get(link.to) ?? Infinity)) continue;
        distances.set(link.to, cost); previous.set(link.to, item.id); queue.push({ id: link.to, cost });
      }
    }
    if (!distances.has(to)) { this.cache.set(key, null); return null; }
    const ids = [to];
    while (ids.at(-1) !== from) ids.push(previous.get(ids.at(-1)!)!);
    const points = ids.reverse().map((id) => ({ ...this.nodes.get(id)! }));
    if (this.cache.size > 4096) this.cache.clear();
    this.cache.set(key, points); return points;
  }
}

export function pedestrianPose(route: readonly Vec2[], length: number, speed: number, departedAt: number, now: number) {
  const along = Math.max(0, Math.min(length, (now - departedAt) * speed));
  const { point, tangent } = pointAtDistance(route, along);
  return { position: point, yaw: Math.atan2(tangent.x, tangent.z), arrived: along >= length };
}
export { polylineLength };
