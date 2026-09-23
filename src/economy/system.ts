import { polylineLength } from '../roads/geometry';
import { getRoadType } from '../roads/roadTypes';
import type { RoadSegment } from '../roads/types';
import type { Vec2 } from '../world/types';
import type { ZoneType } from '../zoning/types';
import type { PopulationTotals } from '../population/types';
import type { EconomyConfig, EconomySnapshot, EconomyState, EconomyTransactionKind } from './types';

export const DEFAULT_ECONOMY_CONFIG: EconomyConfig = {
  version: 1,
  initialFunds: 250_000,
  cycleGameSeconds: 600,
  transactionLimit: 40,
  taxes: {
    residential: { taxableBasePerUnit: 100, taxRate: { numerator: 1, denominator: 10 } },
    commercial: { taxableBasePerUnit: 120, taxRate: { numerator: 1, denominator: 10 } },
    industrial: { taxableBasePerUnit: 100, taxRate: { numerator: 1, denominator: 10 } },
    office: { taxableBasePerUnit: 140, taxRate: { numerator: 1, denominator: 10 } },
  },
};

const ZONES: readonly ZoneType[] = ['residential', 'commercial', 'industrial', 'office'];
const emptyTaxes = (): Record<ZoneType, number> => ({ residential: 0, commercial: 0, industrial: 0, office: 0 });
const whole = (value: number): boolean => Number.isSafeInteger(value);

/** Cost is rounded once for the entire new road, not once per intersection-split segment. */
export const roadConstructionCost = (points: readonly Vec2[], roadTypeId: string): number =>
  Math.round(polylineLength(points) * getRoadType(roadTypeId).constructionCostPerMeter);

export const roadMaintenanceCost = (segments: readonly RoadSegment[]): number => {
  let amount = 0;
  for (const segment of segments) amount += polylineLength(segment.geometry.points) * getRoadType(segment.roadTypeId).maintenanceCostPerMeter;
  return Math.round(amount);
};

export class EconomySystem {
  private state: EconomyState;
  revision = 0;

  constructor(config: EconomyConfig = DEFAULT_ECONOMY_CONFIG, startGameSeconds = 0) {
    this.state = {
      config: structuredClone(config), funds: config.initialFunds, totalIncome: 0, totalExpenses: 0,
      lastCycleIncome: 0, lastCycleExpenses: 0, lastCycleNet: 0,
      lastEconomyTickGameSeconds: startGameSeconds,
      nextCycleAtGameSeconds: startGameSeconds + config.cycleGameSeconds,
      lastCycleTaxes: emptyTaxes(), lastCycleRoadMaintenance: 0,
      transactions: [], nextTransactionId: 1,
    };
  }

  get funds(): number { return this.state.funds; }
  get nextCycleAtGameSeconds(): number { return this.state.nextCycleAtGameSeconds; }
  canAfford(cost: number): boolean { return whole(cost) && cost >= 0 && this.state.funds >= cost; }
  snapshot(): EconomySnapshot { return { ...structuredClone(this.state), revision: this.revision }; }
  save(): EconomyState { return structuredClone(this.state); }

  /** A normal build cannot incur debt. Redo can, so a previously valid command remains replayable. */
  chargeRoad(cost: number, gameSeconds: number, redo = false): void {
    if (!whole(cost) || cost < 0 || (!redo && !this.canAfford(cost))) throw new Error('Not enough funds.');
    this.state.funds -= cost;
    this.state.totalExpenses += cost;
    this.record('ROAD_CONSTRUCTION', -cost, gameSeconds);
  }

  refundRoad(cost: number, gameSeconds: number): void {
    if (!whole(cost) || cost < 0) throw new Error('Invalid road refund.');
    this.state.funds += cost;
    this.state.totalExpenses -= cost;
    this.record('ROAD_CONSTRUCTION_REFUND', cost, gameSeconds);
  }

  tick(gameSeconds: number, population: PopulationTotals, roads: readonly RoadSegment[]): boolean {
    if (gameSeconds < this.state.nextCycleAtGameSeconds) return false;
    const units: Record<ZoneType, number> = {
      residential: population.households,
      commercial: population.jobsByZone.commercial - population.availableJobsByZone.commercial,
      industrial: population.jobsByZone.industrial - population.availableJobsByZone.industrial,
      office: population.jobsByZone.office - population.availableJobsByZone.office,
    };
    const taxes = emptyTaxes();
    for (const zone of ZONES) {
      const { taxableBasePerUnit, taxRate } = this.state.config.taxes[zone];
      taxes[zone] = Math.floor(units[zone] * taxableBasePerUnit * taxRate.numerator / taxRate.denominator);
    }
    const income = ZONES.reduce((sum, zone) => sum + taxes[zone], 0);
    const maintenance = roadMaintenanceCost(roads);
    // When a worker frame crosses more than one due cycle, apply each exactly once.
    while (gameSeconds >= this.state.nextCycleAtGameSeconds) {
      const due = this.state.nextCycleAtGameSeconds;
      this.state.funds += income - maintenance;
      this.state.totalIncome += income;
      this.state.totalExpenses += maintenance;
      this.state.lastCycleIncome = income;
      this.state.lastCycleExpenses = maintenance;
      this.state.lastCycleNet = income - maintenance;
      this.state.lastCycleTaxes = { ...taxes };
      this.state.lastCycleRoadMaintenance = maintenance;
      this.state.lastEconomyTickGameSeconds = due;
      this.state.nextCycleAtGameSeconds += this.state.config.cycleGameSeconds;
      for (const zone of ZONES) if (taxes[zone] > 0) this.record(`TAX_${zone.toUpperCase()}` as EconomyTransactionKind, taxes[zone], due);
      if (maintenance > 0) this.record('ROAD_MAINTENANCE', -maintenance, due);
      this.revision += 1;
    }
    return true;
  }

  restore(saved: EconomyState, gameSeconds: number): void {
    const config = saved?.config;
    if (config?.version !== 1 || !whole(config.initialFunds) || !whole(config.cycleGameSeconds) || config.cycleGameSeconds < 1
      || !whole(config.transactionLimit) || config.transactionLimit < 1 || config.transactionLimit > 1000
      || ZONES.some((zone) => { const tax = config.taxes?.[zone]; return !tax || !whole(tax.taxableBasePerUnit)
        || tax.taxableBasePerUnit < 0 || !whole(tax.taxRate?.numerator) || tax.taxRate.numerator < 0
        || !whole(tax.taxRate?.denominator) || tax.taxRate.denominator < 1; })
      || ![saved.funds, saved.totalIncome, saved.totalExpenses, saved.lastCycleIncome, saved.lastCycleExpenses,
        saved.lastCycleNet, saved.lastEconomyTickGameSeconds, saved.nextCycleAtGameSeconds,
        saved.lastCycleRoadMaintenance, saved.nextTransactionId].every(whole)
      || saved.totalIncome < 0 || saved.totalExpenses < 0 || saved.lastCycleIncome < 0 || saved.lastCycleExpenses < 0
      || saved.lastCycleRoadMaintenance < 0 || saved.nextTransactionId < 1
      || saved.lastCycleNet !== saved.lastCycleIncome - saved.lastCycleExpenses
      || saved.lastEconomyTickGameSeconds > gameSeconds
      || saved.nextCycleAtGameSeconds <= saved.lastEconomyTickGameSeconds
      || !saved.lastCycleTaxes || ZONES.some((zone) => !whole(saved.lastCycleTaxes[zone]) || saved.lastCycleTaxes[zone] < 0)
      || !Array.isArray(saved.transactions) || saved.transactions.length > config.transactionLimit
      || saved.transactions.some((item) => !whole(item?.id) || !whole(item?.amount) || !whole(item?.gameSeconds)
        || item.gameSeconds > gameSeconds || typeof item.kind !== 'string')) throw new Error('Save contains invalid economy data.');
    this.state = structuredClone(saved);
    this.revision += 1;
  }

  private record(kind: EconomyTransactionKind, amount: number, gameSeconds: number): void {
    this.state.transactions.push({ id: this.state.nextTransactionId++, gameSeconds, kind, amount });
    if (this.state.transactions.length > this.state.config.transactionLimit) this.state.transactions.shift();
    this.revision += 1;
  }
}
