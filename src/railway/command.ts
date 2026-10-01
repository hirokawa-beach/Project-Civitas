import type { SimulationCommand, SimulationCommandResult } from '../simulation/commands';
import type { RoadGraph } from '../roads/roadGraph';
import type { RailCommandData, RailwaySave } from './types';
import type { RailwayInfrastructure } from './infrastructure';

/** Same global Undo history as roads/terrain, with an independent Track Graph. */
export class RailwayCommand implements SimulationCommand {
  readonly label = 'Railway construction';
  readonly domain = 'railway' as const;
  private before?: RailwaySave;
  private after?: RailwaySave;
  private result?: SimulationCommandResult;
  constructor(private system: RailwayInfrastructure, private command: RailCommandData) {}
  execute(_graph: RoadGraph): SimulationCommandResult {
    this.before = this.system.save(); const ids = this.system.mutate(this.command); this.after = this.system.save();
    return this.result = { type: 'railway', ids };
  }
  undo(_graph: RoadGraph): void { this.assertEditable(); this.system.restore(this.before!); }
  redo(_graph: RoadGraph): SimulationCommandResult { this.assertEditable(); this.system.restore(this.after!); return this.result!; }
  private assertEditable() { if ([...this.system.blocks.values()].some(b => b.occupancyOwner || b.reservationOwner)) throw new Error('Stop rail operations before Undo/Redo of infrastructure.'); }
}
