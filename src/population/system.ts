import { buildingDefinition } from '../lots/definitions';
import type { Building, BuildingId, Lot } from '../lots/types';
import type { ZoneType } from '../zoning/types';
import { calculateDemand } from './demand';
import type { BuildingOccupancy, Household, HouseholdId, PopulationSaveState, PopulationSnapshot, PopulationTotals } from './types';

export const POPULATION_INTERVALS = {
  moveIn: 30,
  employment: 45,
  demand: 60,
} as const;

const emptyJobs = () => ({ commercial: 0, industrial: 0, office: 0 });
const emptyTotals = (): PopulationTotals => ({
  population: 0, households: 0, employed: 0, unemployed: 0, laborForce: 0,
  totalJobs: 0, availableJobs: 0, residentialCapacity: 0, commercialCapacity: 0,
  jobsByZone: emptyJobs(), availableJobsByZone: emptyJobs(),
  emptyBuildingsByZone: emptyJobs(), occupiedBuildingsByZone: emptyJobs(),
});
const workersIn = (size: number): number => Math.max(1, Math.floor(size / 2));
const validInteger = (value: number, min = 0): boolean => Number.isSafeInteger(value) && value >= min;

/** Worker-side authority. Matching is a single sweep over households and job buildings. */
export class PopulationSystem {
  private readonly householdsById = new Map<HouseholdId, Household>();
  private readonly householdIdsByHome = new Map<BuildingId, Set<HouseholdId>>();
  private readonly archivedByHome = new Map<BuildingId, Household[]>();
  private readonly occupanciesByBuilding = new Map<BuildingId, BuildingOccupancy>();
  private nextHouseholdSerial = 1;
  private nextMoveInAt: number = POPULATION_INTERVALS.moveIn;
  private nextEmploymentAt: number = POPULATION_INTERVALS.employment;
  private nextDemandAt: number = POPULATION_INTERVALS.demand;
  private totals = emptyTotals();
  private demand = calculateDemand(this.totals, 0);
  revision = 0;

  get households(): Household[] { return [...this.householdsById.values()].map((household) => ({ ...household })); }
  get population(): PopulationSnapshot { return this.snapshot(); }
  get demandValues(): Readonly<Record<ZoneType, number>> { return this.demand.values; }

  snapshot(): PopulationSnapshot {
    return { revision: this.revision, totals: structuredClone(this.totals),
      occupancies: [...this.occupanciesByBuilding.values()].map((occupancy) => ({ ...occupancy })),
      demand: structuredClone(this.demand) };
  }

  save(): PopulationSaveState {
    return { households: this.households, occupancies: this.snapshot().occupancies,
      nextHouseholdSerial: this.nextHouseholdSerial, nextMoveInAt: this.nextMoveInAt,
      nextEmploymentAt: this.nextEmploymentAt, nextDemandAt: this.nextDemandAt,
      demand: structuredClone(this.demand) };
  }

  /** Called only after a building/lot change, never for every worker frame. */
  syncBuildings(buildings: readonly Building[], lots: readonly Lot[], now: number): boolean {
    const lotsById = new Map(lots.map((lot) => [lot.id, lot]));
    const activeIds = new Set(buildings.map((building) => building.id));
    let changed = false;
    for (const id of this.occupanciesByBuilding.keys()) if (!activeIds.has(id)) {
      this.archiveHome(id);
      this.occupanciesByBuilding.delete(id);
      changed = true;
    }
    for (const building of buildings) {
      const lot = lotsById.get(building.lotId);
      const definition = buildingDefinition(building.definitionId);
      if (!lot || !definition) continue;
      const area = lot.widthCells * lot.depthCells;
      const active = building.state === 'Occupied';
      const old = this.occupanciesByBuilding.get(building.id);
      const residential = lot.zoneType === 'residential';
      const capacity = area * definition.householdsPerCell;
      const totalJobs = area * definition.jobsPerCell;
      const next: BuildingOccupancy = {
        buildingId: building.id, zoneType: lot.zoneType, active,
        householdCapacity: capacity, populationCapacity: capacity * 4,
        currentHouseholds: old?.currentHouseholds ?? 0, currentPopulation: old?.currentPopulation ?? 0,
        totalJobs, filledJobs: old?.filledJobs ?? 0,
        availableJobs: active ? totalJobs - (old?.filledJobs ?? 0) : 0,
        commercialCapacity: area * definition.commercialCapacityPerCell,
      };
      if (old && old.active && !active) {
        this.archiveHome(building.id);
        next.currentHouseholds = 0;
        next.currentPopulation = 0;
        next.filledJobs = 0;
        next.availableJobs = 0;
      }
      if ((!old || !old.active) && active && residential) this.restoreHome(building.id, next);
      if (!active) { next.filledJobs = 0; next.availableJobs = 0; }
      if (!old || JSON.stringify(old) !== JSON.stringify(next)) changed = true;
      this.occupanciesByBuilding.set(building.id, next);
    }
    if (changed) {
      this.matchEmployment();
      this.recomputeTotals();
      this.demand = calculateDemand(this.totals, now);
      this.revision += 1;
    }
    return changed;
  }

  tick(now: number): boolean {
    let changed = false;
    if (now >= this.nextMoveInAt) {
      changed = this.moveIn() || changed;
      this.nextMoveInAt = now + POPULATION_INTERVALS.moveIn;
    }
    if (now >= this.nextEmploymentAt) {
      changed = this.matchEmployment() || changed;
      this.nextEmploymentAt = now + POPULATION_INTERVALS.employment;
    }
    if (changed) this.recomputeTotals();
    if (now >= this.nextDemandAt) {
      const next = calculateDemand(this.totals, now);
      changed = JSON.stringify(next.values) !== JSON.stringify(this.demand.values) || changed;
      this.demand = next;
      this.nextDemandAt = now + POPULATION_INTERVALS.demand;
    }
    if (changed) this.revision += 1;
    return changed;
  }

  /** Validate detached data before replacing the live simulation during load. */
  restore(saved: PopulationSaveState, buildings: readonly Building[], lots: readonly Lot[], now: number): void {
    if (!saved || !Array.isArray(saved.households) || !Array.isArray(saved.occupancies)
      || !validInteger(saved.nextHouseholdSerial, 1)
      || ![saved.nextMoveInAt, saved.nextEmploymentAt, saved.nextDemandAt].every((value) => Number.isFinite(value) && value >= 0)
      || !saved.demand || !Number.isFinite(saved.demand.calculatedAt)
      || !saved.demand.values || !saved.demand.factors) throw new Error('Save contains invalid population data.');
    for (const zone of ['residential', 'commercial', 'industrial', 'office'] as ZoneType[]) {
      if (!validInteger(saved.demand.values[zone]) || saved.demand.values[zone] > 100
        || !saved.demand.factors[zone]
        || Object.values(saved.demand.factors[zone]).some((value) => !Number.isFinite(value))) {
        throw new Error('Save contains invalid demand data.');
      }
    }
    this.syncBuildings(buildings, lots, now);
    const expected = new Map(this.occupanciesByBuilding);
    if (saved.occupancies.length !== expected.size) throw new Error('Save contains invalid building occupancy.');
    const seenOccupancies = new Set<BuildingId>();
    for (const occupancy of saved.occupancies) {
      const model = expected.get(occupancy?.buildingId);
      if (!model || seenOccupancies.has(occupancy.buildingId)
        || occupancy.zoneType !== model.zoneType || occupancy.active !== model.active
        || occupancy.householdCapacity !== model.householdCapacity
        || occupancy.populationCapacity !== model.populationCapacity
        || occupancy.totalJobs !== model.totalJobs
        || occupancy.commercialCapacity !== model.commercialCapacity
        || !validInteger(occupancy.currentHouseholds) || !validInteger(occupancy.currentPopulation)
        || !validInteger(occupancy.filledJobs) || !validInteger(occupancy.availableJobs)
        || occupancy.currentHouseholds > occupancy.householdCapacity
        || occupancy.currentPopulation > occupancy.populationCapacity
        || occupancy.filledJobs > occupancy.totalJobs
        || occupancy.availableJobs !== (occupancy.active ? occupancy.totalJobs - occupancy.filledJobs : 0)
        || (!occupancy.active && (occupancy.currentHouseholds > 0 || occupancy.filledJobs > 0))) {
        throw new Error('Save contains invalid building occupancy.');
      }
      seenOccupancies.add(occupancy.buildingId);
      this.occupanciesByBuilding.set(occupancy.buildingId, { ...occupancy });
    }
    const serials = new Set<number>();
    for (const household of saved.households) {
      const serial = Number(household?.id?.slice('household-'.length));
      const home = this.occupanciesByBuilding.get(household?.homeBuildingId);
      if (!household?.id?.startsWith('household-') || !validInteger(serial, 1) || serials.has(serial)
        || serial >= saved.nextHouseholdSerial || !home?.active || home.zoneType !== 'residential'
        || !validInteger(household.householdSize, 1) || household.householdSize > 4
        || !validInteger(household.employedCount) || !validInteger(household.unemployedCount)
        || household.employedCount + household.unemployedCount !== workersIn(household.householdSize)
        || household.state !== 'Housed') throw new Error('Save contains invalid households.');
      serials.add(serial);
      this.addHousehold({ ...household });
    }
    for (const occupancy of this.occupanciesByBuilding.values()) if (occupancy.zoneType === 'residential') {
      const ids = this.householdIdsByHome.get(occupancy.buildingId) ?? new Set();
      const population = [...ids].reduce((sum, id) => sum + this.householdsById.get(id)!.householdSize, 0);
      if (ids.size !== occupancy.currentHouseholds || population !== occupancy.currentPopulation) {
        throw new Error('Save contains inconsistent households.');
      }
    }
    this.recomputeTotals();
    if (this.totals.employed !== [...this.occupanciesByBuilding.values()].reduce((sum, occupancy) => sum + occupancy.filledJobs, 0)) {
      throw new Error('Save contains inconsistent employment.');
    }
    this.nextHouseholdSerial = saved.nextHouseholdSerial;
    this.nextMoveInAt = saved.nextMoveInAt;
    this.nextEmploymentAt = saved.nextEmploymentAt;
    this.nextDemandAt = saved.nextDemandAt;
    this.demand = structuredClone(saved.demand);
    this.revision += 1;
  }

  private addHousehold(household: Household): void {
    this.householdsById.set(household.id, household);
    const ids = this.householdIdsByHome.get(household.homeBuildingId) ?? new Set<HouseholdId>();
    ids.add(household.id);
    this.householdIdsByHome.set(household.homeBuildingId, ids);
  }

  private archiveHome(id: BuildingId): void {
    const ids = this.householdIdsByHome.get(id);
    if (!ids) return;
    const removed: Household[] = [];
    for (const householdId of ids) {
      const household = this.householdsById.get(householdId);
      if (household) { removed.push({ ...household }); this.householdsById.delete(householdId); }
    }
    if (removed.length > 0) this.archivedByHome.set(id, removed);
    this.householdIdsByHome.delete(id);
  }

  private restoreHome(id: BuildingId, occupancy: BuildingOccupancy): void {
    const archived = this.archivedByHome.get(id);
    if (!archived) return;
    for (const household of archived.slice(0, occupancy.householdCapacity)) {
      this.addHousehold({ ...household });
      occupancy.currentHouseholds += 1;
      occupancy.currentPopulation += household.householdSize;
    }
    this.archivedByHome.delete(id);
  }

  private moveIn(): boolean {
    let changed = false;
    for (const occupancy of this.occupanciesByBuilding.values()) {
      if (!occupancy.active || occupancy.zoneType !== 'residential'
        || occupancy.currentHouseholds >= occupancy.householdCapacity) continue;
      const serial = this.nextHouseholdSerial++;
      const householdSize = 2 + serial % 3;
      const household: Household = { id: `household-${serial}`, homeBuildingId: occupancy.buildingId,
        householdSize, employedCount: 0, unemployedCount: workersIn(householdSize), state: 'Housed' };
      this.addHousehold(household);
      occupancy.currentHouseholds += 1;
      occupancy.currentPopulation += householdSize;
      changed = true;
    }
    return changed;
  }

  private matchEmployment(): boolean {
    const jobs = [...this.occupanciesByBuilding.values()].filter((occupancy) => occupancy.active && occupancy.zoneType !== 'residential');
    const previousFilled = jobs.map((job) => job.filledJobs);
    let changed = false;
    for (const job of jobs) {
      job.filledJobs = 0;
      job.availableJobs = job.totalJobs;
    }
    let jobIndex = 0;
    for (const household of this.householdsById.values()) {
      let seeking = workersIn(household.householdSize);
      while (seeking > 0 && jobIndex < jobs.length) {
        const job = jobs[jobIndex];
        const assigned = Math.min(seeking, job.availableJobs);
        job.filledJobs += assigned;
        job.availableJobs -= assigned;
        seeking -= assigned;
        if (job.availableJobs === 0) jobIndex += 1;
      }
      const employed = workersIn(household.householdSize) - seeking;
      if (household.employedCount !== employed) changed = true;
      household.employedCount = employed;
      household.unemployedCount = seeking;
    }
    return changed || jobs.some((job, index) => job.filledJobs !== previousFilled[index]);
  }

  private recomputeTotals(): void {
    const totals = emptyTotals();
    for (const household of this.householdsById.values()) {
      totals.households += 1;
      totals.population += household.householdSize;
      totals.employed += household.employedCount;
      totals.unemployed += household.unemployedCount;
    }
    totals.laborForce = totals.employed + totals.unemployed;
    for (const occupancy of this.occupanciesByBuilding.values()) {
      if (!occupancy.active) continue;
      if (occupancy.zoneType === 'residential') {
        totals.residentialCapacity += occupancy.householdCapacity;
      } else {
        const zone = occupancy.zoneType;
        totals.totalJobs += occupancy.totalJobs;
        totals.availableJobs += occupancy.availableJobs;
        totals.jobsByZone[zone] += occupancy.totalJobs;
        totals.availableJobsByZone[zone] += occupancy.availableJobs;
        totals.occupiedBuildingsByZone[zone] += 1;
        if (occupancy.filledJobs === 0) totals.emptyBuildingsByZone[zone] += 1;
        if (zone === 'commercial') totals.commercialCapacity += occupancy.commercialCapacity;
      }
    }
    this.totals = totals;
  }
}
