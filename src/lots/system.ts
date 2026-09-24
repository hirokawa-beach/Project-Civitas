import { CHUNK_SIZE, HALF_WORLD_SIZE, type ChunkDescriptor } from '../world/types';
import type { ZoningCell } from '../zoning/types';
import type { ZoningCellId } from '../shared/ids';
import type { RoadSegment } from '../roads/types';
import { closestPointOnPolyline } from '../roads/geometry';
import { buildingDefinition, definitionForLot } from './definitions';
import { generateLots } from './generator';
import type { Building, BuildingGrowthState, Lot, LotId } from './types';
import type { ZoneType } from '../zoning/types';

const LOCAL_HALO = 40;
export const MIN_GROWTH_DEMAND = 25;
const DURATION: Record<Exclude<BuildingGrowthState, 'Occupied'>, number> = {
  Empty: 10, Planned: 20, Constructing: 40,
};
const nextState: Record<Exclude<BuildingGrowthState, 'Occupied'>, BuildingGrowthState> = {
  Empty: 'Planned', Planned: 'Constructing', Constructing: 'Occupied',
};

export class LotSystem {
  private readonly lotsById = new Map<LotId, Lot>();
  private readonly buildingsById = new Map<Building['id'], Building>();
  private readonly archivedBuildings = new Map<string, Building>();
  private nextDue = Infinity;
  revision = 0;
  lastReevaluatedCells = 0;
  private pendingDelta: { lots: Lot[]; removedLotIds: LotId[]; buildings: Building[]; removedBuildingIds: Building['id'][] } =
    { lots: [], removedLotIds: [], buildings: [], removedBuildingIds: [] };

  get lots(): Lot[] { return [...this.lotsById.values()].sort((a, b) => a.id.localeCompare(b.id)); }
  get buildings(): Building[] { return [...this.buildingsById.values()].sort((a, b) => a.id.localeCompare(b.id)); }

  reconcile(cells: readonly ZoningCell[], getHeight: (x: number, z: number) => number, now: number,
    options: { cellIds?: readonly ZoningCellId[]; chunkIds?: readonly ChunkDescriptor['id'][]; all?: boolean } = { all: true }): void {
    const byId = new Map(cells.map((cell) => [cell.id, cell]));
    const previous = new Map(this.lotsById);
    const oldLotByCell = new Map<ZoningCellId, Lot>();
    for (const lot of previous.values()) for (const id of lot.zoneCellIds) oldLotByCell.set(id, lot);
    const bounds: Array<{ minX: number; maxX: number; minZ: number; maxZ: number }> = [];
    if (!options.all) {
      for (const id of options.cellIds ?? []) {
        const cell = byId.get(id);
        const oldLot = oldLotByCell.get(id);
        const point = cell?.center ?? oldLot?.position;
        if (point) bounds.push({ minX: point.x - LOCAL_HALO, maxX: point.x + LOCAL_HALO,
          minZ: point.z - LOCAL_HALO, maxZ: point.z + LOCAL_HALO });
      }
      for (const id of options.chunkIds ?? []) {
        const match = /^chunk-(\d+)-(\d+)$/.exec(id);
        if (!match) continue;
        const x = Number(match[1]); const z = Number(match[2]);
        bounds.push({ minX: -HALF_WORLD_SIZE + x * CHUNK_SIZE - LOCAL_HALO,
          maxX: -HALF_WORLD_SIZE + (x + 1) * CHUNK_SIZE + LOCAL_HALO,
          minZ: -HALF_WORLD_SIZE + z * CHUNK_SIZE - LOCAL_HALO,
          maxZ: -HALF_WORLD_SIZE + (z + 1) * CHUNK_SIZE + LOCAL_HALO });
      }
      if (bounds.length === 0) return;
    }
    const affected = (x: number, z: number): boolean => options.all === true
      || bounds.some((box) => x >= box.minX && x <= box.maxX && z >= box.minZ && z <= box.maxZ);
    const oldBuildings = new Map(this.buildingsById);
    const retained = new Map<LotId, Lot>();
    const removedLotCellIds = new Set<ZoningCellId>();
    for (const lot of previous.values()) {
      if (lot.zoneCellIds.some((id) => {
        const cell = byId.get(id);
        return !cell || affected(cell.center.x, cell.center.z);
      })) {
        for (const id of lot.zoneCellIds) removedLotCellIds.add(id);
        if (lot.buildingId) {
          const building = this.buildingsById.get(lot.buildingId);
          if (building) this.archivedBuildings.set(`${lot.id}|${building.definitionId}`, building);
        }
      } else retained.set(lot.id, lot);
    }
    const reserved = new Set([...retained.values()].flatMap((lot) => lot.zoneCellIds));
    const candidates = cells.filter((cell) => (affected(cell.center.x, cell.center.z) || removedLotCellIds.has(cell.id))
      && !reserved.has(cell.id));
    this.lastReevaluatedCells = candidates.length;
    const generated = generateLots(candidates, getHeight);
    const nextBuildings = new Map<Building['id'], Building>();
    for (const lot of retained.values()) if (lot.buildingId) {
      const building = this.buildingsById.get(lot.buildingId);
      if (building) nextBuildings.set(building.id, building);
    }
    for (const lot of generated) {
      const definition = definitionForLot(lot.zoneType, lot.widthCells, lot.depthCells);
      if (lot.buildable && definition) {
        const old = previous.get(lot.id);
        const existing = old?.buildingId ? this.buildingsById.get(old.buildingId) : undefined;
        const archiveKey = `${lot.id}|${definition.id}`;
        const archived = this.archivedBuildings.get(archiveKey);
        const compatible = [existing, archived].find((building) => building?.definitionId === definition.id);
        const building: Building = compatible ?? {
          id: `building-${lot.id}`, lotId: lot.id, definitionId: definition.id,
          state: 'Empty', stateEnteredAt: now, nextTransitionAt: now + DURATION.Empty,
        };
        lot.buildingId = building.id;
        nextBuildings.set(building.id, building);
        this.archivedBuildings.delete(archiveKey);
      }
      retained.set(lot.id, lot);
    }
    this.lotsById.clear();
    for (const [id, lot] of retained) this.lotsById.set(id, lot);
    this.buildingsById.clear();
    for (const [id, building] of nextBuildings) this.buildingsById.set(id, building);
    this.recordDelta(previous, oldBuildings);
    this.recomputeNextDue();
    this.revision += 1;
  }

  /** Road splits may only change the owning segment, not the underlying cells. */
  refreshRoadAccess(segments: readonly RoadSegment[]): void {
    const changed: Lot[] = [];
    for (const lot of this.lotsById.values()) {
      const midpoint = { x: (lot.roadAccess.frontage[0].x + lot.roadAccess.frontage[1].x) / 2,
        z: (lot.roadAccess.frontage[0].z + lot.roadAccess.frontage[1].z) / 2 };
      const nearest = segments.filter((segment) => (segment.structureType ?? 'ground') === 'ground')
        .map((segment) => ({ segment, distance: closestPointOnPolyline(midpoint, segment.geometry.points).distance }))
        .sort((a, b) => a.distance - b.distance || a.segment.id.localeCompare(b.segment.id))[0];
      if (nearest && nearest.distance <= nearest.segment.width / 2 + 16
        && lot.roadAccess.roadSegmentId !== nearest.segment.id) {
        lot.roadAccess.roadSegmentId = nearest.segment.id;
        changed.push(lot);
      }
    }
    if (changed.length > 0) {
      this.pendingDelta.lots.push(...changed);
      this.revision += 1;
    }
  }

  advance(now: number, demand?: Readonly<Record<ZoneType, number>>): boolean {
    if (now < this.nextDue) return false;
    const changed: Building[] = [];
    for (const building of this.buildingsById.values()) {
      let transitioned = false;
      while (building.nextTransitionAt !== null && building.nextTransitionAt <= now) {
        const current = building.state;
        if (current === 'Occupied') break;
        if (current === 'Empty' && demand && (demand[buildingDefinition(building.definitionId)!.zoneType] ?? 0) < MIN_GROWTH_DEMAND) {
          building.nextTransitionAt = now + DURATION.Empty;
          break;
        }
        building.state = nextState[current];
        building.stateEnteredAt = building.nextTransitionAt;
        building.nextTransitionAt = building.state === 'Occupied' ? null : building.stateEnteredAt + DURATION[building.state];
        transitioned = true;
      }
      if (transitioned) changed.push(building);
    }
    this.recomputeNextDue();
    if (changed.length > 0) {
      this.pendingDelta.buildings.push(...changed);
      this.revision += 1;
    }
    return changed.length > 0;
  }

  takeDelta(): { lots: Lot[]; removedLotIds: LotId[]; buildings: Building[]; removedBuildingIds: Building['id'][] } {
    const lotIds = new Set([...this.pendingDelta.lots.map((lot) => lot.id), ...this.pendingDelta.removedLotIds]);
    const buildingIds = new Set([...this.pendingDelta.buildings.map((building) => building.id), ...this.pendingDelta.removedBuildingIds]);
    const result = {
      lots: [...lotIds].flatMap((id) => this.lotsById.has(id) ? [this.lotsById.get(id)!] : []),
      removedLotIds: [...lotIds].filter((id) => !this.lotsById.has(id)),
      buildings: [...buildingIds].flatMap((id) => this.buildingsById.has(id) ? [this.buildingsById.get(id)!] : []),
      removedBuildingIds: [...buildingIds].filter((id) => !this.buildingsById.has(id)),
    };
    this.pendingDelta = { lots: [], removedLotIds: [], buildings: [], removedBuildingIds: [] };
    return result;
  }

  restore(savedLots: readonly Lot[], savedBuildings: readonly Building[], cells: readonly ZoningCell[],
    getHeight: (x: number, z: number) => number, now: number): void {
    this.lotsById.clear(); this.buildingsById.clear(); this.archivedBuildings.clear();
    const validCells = new Map(cells.map((cell) => [cell.id, cell]));
    const occupiedCells = new Set<ZoningCellId>();
    for (const lot of savedLots) {
      if (!lot || !lot.id?.startsWith('lot-') || !lot.zoneType || !Number.isInteger(lot.widthCells)
        || !Number.isInteger(lot.depthCells) || lot.widthCells < 1 || lot.widthCells > 4
        || lot.depthCells < 1 || lot.depthCells > 4 || lot.width !== lot.widthCells * 8
        || lot.depth !== lot.depthCells * 8 || !Array.isArray(lot.zoneCellIds)
        || lot.zoneCellIds.length !== lot.widthCells * lot.depthCells
        || !Array.isArray(lot.corners) || lot.corners.length !== 4
        || !definitionForLot(lot.zoneType, lot.widthCells, lot.depthCells)
        || !Number.isFinite(lot.position?.x) || !Number.isFinite(lot.position?.z)
        || !Number.isFinite(lot.baseElevation) || !Number.isFinite(lot.slope)
        || !Number.isFinite(lot.minElevation) || !Number.isFinite(lot.maxElevation)
        || this.lotsById.has(lot.id)) throw new Error('Save contains invalid lots.');
      const members = lot.zoneCellIds.map((id) => validCells.get(id));
      if (members.some((cell) => !cell || cell.zoneType !== lot.zoneType || cell.terrainSuitable === false)
        || !members.some((cell) => cell?.depth === 0) || !lot.roadAccess?.roadSegmentId) {
        throw new Error('Save contains invalid lots.');
      }
      for (const id of lot.zoneCellIds) {
        if (occupiedCells.has(id)) throw new Error('Save contains overlapping lots.');
        occupiedCells.add(id);
      }
      this.lotsById.set(lot.id, structuredClone(lot));
    }
    const expectedIds = new Set(savedLots.filter((lot) => lot.buildingId).map((lot) => lot.buildingId));
    if (savedBuildings.length !== expectedIds.size) throw new Error('Save contains invalid buildings.');
    for (const building of savedBuildings) {
      const definition = buildingDefinition(building.definitionId);
      if (!expectedIds.has(building.id) || !definition || !this.lotsById.has(building.lotId)
        || definition.zoneType !== this.lotsById.get(building.lotId)?.zoneType
        || definition.lotWidthCells !== this.lotsById.get(building.lotId)?.widthCells
        || definition.lotDepthCells !== this.lotsById.get(building.lotId)?.depthCells
        || this.lotsById.get(building.lotId)?.buildingId !== building.id
        || !Number.isFinite(building.stateEnteredAt) || building.stateEnteredAt < 0
        || (building.nextTransitionAt !== null && (!Number.isFinite(building.nextTransitionAt) || building.nextTransitionAt < building.stateEnteredAt))
        || !(['Empty', 'Planned', 'Constructing', 'Occupied'] as BuildingGrowthState[]).includes(building.state)
        || (building.state === 'Occupied') !== (building.nextTransitionAt === null)
        || this.buildingsById.has(building.id)) throw new Error('Save contains invalid buildings.');
      this.buildingsById.set(building.id, structuredClone(building));
    }
    this.recomputeNextDue();
    this.takeDelta();
    this.revision += 1;
  }

  private recordDelta(previous: Map<LotId, Lot>, oldBuildings: Map<Building['id'], Building>): void {
    for (const [id, lot] of this.lotsById) {
      if (JSON.stringify(previous.get(id)) !== JSON.stringify(lot)) this.pendingDelta.lots.push(lot);
    }
    for (const id of previous.keys()) if (!this.lotsById.has(id)) this.pendingDelta.removedLotIds.push(id);
    for (const [id, building] of this.buildingsById) {
      if (JSON.stringify(oldBuildings.get(id)) !== JSON.stringify(building)) this.pendingDelta.buildings.push(building);
    }
    for (const id of oldBuildings.keys()) if (!this.buildingsById.has(id)) this.pendingDelta.removedBuildingIds.push(id);
  }

  private recomputeNextDue(): void {
    this.nextDue = Infinity;
    for (const building of this.buildingsById.values()) {
      if (building.nextTransitionAt !== null) this.nextDue = Math.min(this.nextDue, building.nextTransitionAt);
    }
  }
}
