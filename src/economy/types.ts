import type { ZoneType } from '../zoning/types';

export type TaxZone = ZoneType;
export type EconomyTransactionKind =
  | 'TAX_RESIDENTIAL' | 'TAX_COMMERCIAL' | 'TAX_INDUSTRIAL' | 'TAX_OFFICE'
  | 'ROAD_CONSTRUCTION' | 'ROAD_CONSTRUCTION_REFUND' | 'ROAD_MAINTENANCE' | 'SERVICE_CONSTRUCTION' | 'SERVICE_MAINTENANCE';

export interface EconomyTransaction {
  id: number;
  gameSeconds: number;
  kind: EconomyTransactionKind;
  /** Signed change to funds, in integer game-currency units. */
  amount: number;
}

export interface EconomyTaxConfig {
  taxableBasePerUnit: number;
  taxRate: { numerator: number; denominator: number };
}

export interface EconomyConfig {
  version: 1;
  initialFunds: number;
  cycleGameSeconds: number;
  transactionLimit: number;
  taxes: Record<TaxZone, EconomyTaxConfig>;
}

export interface EconomyState {
  config: EconomyConfig;
  funds: number;
  totalIncome: number;
  totalExpenses: number;
  lastCycleIncome: number;
  lastCycleExpenses: number;
  lastCycleNet: number;
  lastEconomyTickGameSeconds: number;
  nextCycleAtGameSeconds: number;
  lastCycleTaxes: Record<TaxZone, number>;
  lastCycleRoadMaintenance: number;
  lastCycleServiceMaintenance: number;
  transactions: EconomyTransaction[];
  nextTransactionId: number;
}

export interface EconomySnapshot extends EconomyState { revision: number }
