import type { ZoneType } from '../zoning/types';
import type { DemandState, PopulationTotals } from './types';

const clamp = (value: number): number => Math.max(0, Math.min(100, Math.round(value)));
const fraction = (part: number, whole: number): number => whole > 0 ? part / whole : 0;
const score = (factors: Record<string, number>): number => clamp(Object.values(factors).reduce((sum, value) => sum + value, 0));

/** Demand is intentionally explainable: every input contributes signed points. */
export function calculateDemand(totals: PopulationTotals, now: number): DemandState {
  const residentialVacancy = fraction(totals.residentialCapacity - totals.households, totals.residentialCapacity);
  const unemployment = fraction(totals.unemployed, totals.laborForce);
  const opportunity = fraction(totals.availableJobs, totals.laborForce + totals.availableJobs);
  const vacancy = (zone: 'commercial' | 'industrial' | 'office'): number =>
    fraction(totals.availableJobsByZone[zone], totals.jobsByZone[zone]);
  const emptyBuildings = (zone: 'commercial' | 'industrial' | 'office'): number =>
    fraction(totals.emptyBuildingsByZone[zone], totals.occupiedBuildingsByZone[zone]);
  const factors: DemandState['factors'] = {
    residential: {
      baseline: 60, jobOpportunity: 25 * opportunity,
      vacantHomes: 0 - 40 * residentialVacancy, unemployment: 0 - 35 * unemployment,
    },
    commercial: {
      baseline: 35, population: 45 * fraction(totals.population, totals.population + totals.commercialCapacity + 20),
      emptyJobs: 0 - 35 * vacancy('commercial'), emptyBuildings: 0 - 10 * emptyBuildings('commercial'),
    },
    industrial: {
      baseline: 40, workforce: 35 * fraction(totals.laborForce, totals.laborForce + totals.jobsByZone.industrial + 20),
      emptyJobs: 0 - 35 * vacancy('industrial'), emptyBuildings: 0 - 10 * emptyBuildings('industrial'),
    },
    office: {
      baseline: 35, workforce: 40 * fraction(totals.laborForce, totals.laborForce + totals.jobsByZone.office + 30),
      emptyJobs: 0 - 35 * vacancy('office'), emptyBuildings: 0 - 10 * emptyBuildings('office'),
    },
  };
  const values = Object.fromEntries((Object.keys(factors) as ZoneType[]).map((zone) => [zone, score(factors[zone])])) as DemandState['values'];
  return { values, factors, calculatedAt: now };
}
