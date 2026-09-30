import { RoadGraph } from '../roads/roadGraph';
import { deserializeWorld, serializeWorld, type SaveFile, type SaveFileV13 } from '../save/serializer';
import { createWorldMetadata, validateWorldMetadata } from '../world/metadata';
import { validateGenerationMetadata, validateMap, type GeneratedMap, type GenerationMetadata } from '../terrain/generator';
import type { WorldSnapshot } from '../shared/protocol';
import type { ZoningCellId } from '../shared/ids';
import { createChunks, worldToChunk, type ChunkDescriptor, type TerrainBrushMode, type TerrainPatch, type TerrainPreset, type Vec2 } from '../world/types';
import { HeightmapTerrain, DEFAULT_TERRAIN_SETTINGS } from '../terrain/heightmap';
import { buildRoadTerrainProtection, protectServiceLots } from '../terrain/roadProtection';
import { isZoneType, type ZoneAssignment, type ZoneType, type ZoningCell } from '../zoning/types';
import { ZoningSystem } from '../zoning/system';
import { isTerrainSuitableForZone } from '../zoning/terrainSuitability';
import { LotSystem } from '../lots/system';
import type { Building, Lot, LotId } from '../lots/types';
import { PopulationSystem } from '../population/system';
import type { PopulationSnapshot } from '../population/types';
import { EconomySystem } from '../economy/system';
import type { EconomySnapshot } from '../economy/types';
import { TrafficSystem } from '../traffic/system';
import type { TrafficSnapshot } from '../traffic/types';
import { ServiceSystem } from '../services/system';
import type { ServiceSnapshot } from '../services/types';
import { TransitSystem } from '../transit/system';
import type { TransitSnapshot } from '../transit/types';
import { StaticWater } from '../water/staticWater';
import { AppliedTerrainStrokeCommand, CommandHistory, TerrainPresetCommand, commandFromData, type SimulationCommandData, type SimulationCommandResult, type TerrainEditBounds } from './commands';
import { GameClock, type GameSpeed } from './gameClock';
import { PerformanceLedger } from '../performance/metrics';

export class SimulationState {
  readonly performance = new PerformanceLedger();
  worldMetadata = createWorldMetadata();
  readonly graph = new RoadGraph();
  readonly clock = new GameClock();
  readonly history = new CommandHistory();
  terrain = new HeightmapTerrain();
  lots = new LotSystem();
  population = new PopulationSystem();
  economy = new EconomySystem();
  traffic = new TrafficSystem(this.graph.snapshot());
  services = new ServiceSystem();
  transit = new TransitSystem(this.graph.snapshot());
  water = new StaticWater();
  generation: GenerationMetadata | null = null;
  private roadTerrainEditWeights = buildRoadTerrainProtection([]);

  private zoningCells: ZoningCell[] = [];
  private readonly zoneAssignments = new Map<ZoningCellId, ZoneType>();
  private readonly zoningSystem = new ZoningSystem();
  private revision = 0;
  private roadRevision = 0;
  private zoningRevision = 0;
  private terrainRevision = 0;
  private lotRevision = 0;
  private terrainUpdatedChunkIds = new Set<ChunkDescriptor['id']>();
  private terrainEditMs = 0;
  private activeTerrainStroke?: { mode: TerrainBrushMode; size: number; strength: number; flattenHeight: number; before: Map<number, number>; chunks: Set<ChunkDescriptor['id']> };
  private zoningUpdatedChunkIds: ChunkDescriptor['id'][] = [];
  private simulationTickMs = 0;
  private citizenPopulationRevision = -1;
  private citizensDirty = true;

  constructor() {
    this.zoningCells = this.withZoneTypes(this.zoningSystem.update(this.graph.snapshot()));
    this.traffic.setTransitSystem(this.transit);
  }

  startGeneratedCity(map: GeneratedMap): void {
    if (this.graph.segments.size || this.clock.gameSeconds > 0 || this.generation) throw new Error('A city is already active.');
    validateGenerationMetadata(map.metadata);
    const metadata = structuredClone(map.world ?? createWorldMetadata());
    validateWorldMetadata(metadata);
    if (!validateMap(map.heights, map.metadata.parameters.seaLevel, metadata).valid) throw new Error('Generated map is not buildable.');
    const terrain = HeightmapTerrain.fromBuffer({ width: metadata.worldWidthMeters, depth: metadata.worldDepthMeters, baseHeight: 0,
      chunkSizeMeters: metadata.chunkSizeMeters, terrainVersion: 1, settings: { ...DEFAULT_TERRAIN_SETTINGS, sampleSpacing: metadata.terrainSampleSpacingMeters } }, map.heights);
    const water = new StaticWater({ version: 1, seaLevel: map.metadata.parameters.seaLevel });
    this.terrain = terrain;
    this.worldMetadata = metadata;
    this.configureWorld();
    // Keep the Authority instance: its revision must not reset across world replacement.
    this.water.restore(water.save());
    this.generation = structuredClone(map.metadata);
    this.worldMetadata.generatorMetadata = structuredClone(map.metadata);
    this.worldMetadata.source.kind = 'procedural';
    this.history.clear();
    this.terrainChanged(createChunks(this.worldMetadata).map((chunk) => chunk.id));
  }

  tick(realSeconds: number): boolean {
    const started = performance.now();
    this.clock.advance(realSeconds);
    const buildingChanged = this.lots.advance(this.clock.gameSeconds, this.population.demandValues);
    if (buildingChanged) {
      this.lotRevision += 1;
      this.syncPopulation();
    }
    const populationRevision = this.population.revision;
    this.performance.measure('populationMs', () => this.population.tick(this.clock.gameSeconds));
    if (populationRevision !== this.population.revision) this.refreshServices();
    this.ensureCitizens();
    if (this.clock.speed !== 0 && this.clock.gameSeconds >= this.economy.nextCycleAtGameSeconds) {
      this.performance.measure('economyMs', () => this.economy.tick(this.clock.gameSeconds, this.population.snapshot().totals, this.graph.snapshot().segments,
        this.services.snapshot().maintenancePerCycle));
    }
    if (this.clock.speed !== 0 && this.traffic.isDue(this.clock.gameSeconds)) {
      this.performance.measure('trafficMs', () => this.traffic.tick(this.clock.gameSeconds, this.population.snapshot(), this.lots.lots));
    }
    if (this.clock.speed !== 0 && this.transit.isDue(this.clock.gameSeconds))
      this.transit.tick(this.clock.gameSeconds, this.traffic.segmentStates);
    this.revision += 1;
    this.simulationTickMs = performance.now() - started;
    this.performance.record('simulationTickMs', this.simulationTickMs);
    return buildingChanged;
  }

  execute(command: SimulationCommandData): SimulationCommandResult {
    let accepted = command;
    if (command.type === 'set-zone') {
      if (command.zoneType !== null && !isZoneType(command.zoneType)) throw new Error('Unknown zoning type.');
      const active = new Set(this.zoningCells.filter((cell) => command.zoneType === null
        || (isTerrainSuitableForZone(cell, (x, z) => this.terrain.getHeight(x, z))
          && !this.services.overlapsCell(cell))).map((cell) => cell.id));
      const cellIds = [...new Set(command.cellIds)];
      if (cellIds.some((id) => !active.has(id))) throw new Error('Zoning cell no longer exists.');
      const changed = cellIds.filter((id) => (this.zoneAssignments.get(id) ?? null) !== command.zoneType);
      if (changed.length === 0) return { type: 'set-zone', cellIds: [], zoneType: command.zoneType };
      accepted = { type: 'set-zone', cellIds: changed, zoneType: command.zoneType };
    }
    const result = this.history.execute(commandFromData(accepted, this.zoneAssignments,
      (x, z) => this.terrain.getHeight(x, z), this.economy, () => this.clock.gameSeconds, this.services,
      () => this.lots.lots, () => this.zoningCells, this.transit, this.water), this.graph);
    if (this.history.lastDomain === 'road') {
      this.roadChanged();
      this.history.finalizeLastRoadCommand();
    } else if (this.history.lastDomain === 'service') { this.refreshServices(); this.refreshTerrainProtection(); this.revision += 1; }
    else if (this.history.lastDomain === 'transit' || this.history.lastDomain === 'water') { this.citizensDirty = true; this.revision += 1; }
    else this.zonesChanged(this.history.lastAffectedCellIds);
    return result;
  }

  undo(): boolean {
    const changed = this.history.undo(this.graph);
    if (changed) {
      if (this.history.lastDomain === 'road') this.roadChanged();
      else if (this.history.lastDomain === 'terrain') this.terrainChanged(this.history.lastAffectedChunkIds, this.history.lastTerrainBounds);
      else if (this.history.lastDomain === 'service') { this.refreshServices(); this.refreshTerrainProtection(); this.revision += 1; }
      else if (this.history.lastDomain === 'transit' || this.history.lastDomain === 'water') { this.citizensDirty = true; this.revision += 1; }
      else this.zonesChanged(this.history.lastAffectedCellIds);
    }
    return changed;
  }

  redo(): boolean {
    const changed = this.history.redo(this.graph);
    if (changed) {
      if (this.history.lastDomain === 'road') this.roadChanged();
      else if (this.history.lastDomain === 'terrain') this.terrainChanged(this.history.lastAffectedChunkIds, this.history.lastTerrainBounds);
      else if (this.history.lastDomain === 'service') { this.refreshServices(); this.refreshTerrainProtection(); this.revision += 1; }
      else if (this.history.lastDomain === 'transit' || this.history.lastDomain === 'water') { this.citizensDirty = true; this.revision += 1; }
      else this.zonesChanged(this.history.lastAffectedCellIds);
    }
    return changed;
  }

  setSpeed(speed: GameSpeed): void {
    this.clock.speed = speed;
    this.revision += 1;
  }

  beginTerrainStroke(point: Vec2, mode: TerrainBrushMode, size: number, strength: number): void {
    if (this.activeTerrainStroke) this.endTerrainStroke();
    this.activeTerrainStroke = { mode, size, strength, flattenHeight: this.terrain.getHeight(point.x, point.z), before: new Map(), chunks: new Set() };
    this.applyTerrainStroke([point], 0.06);
  }

  applyTerrainStroke(points: readonly Vec2[], seconds: number): void {
    const stroke = this.activeTerrainStroke;
    if (!stroke || points.length === 0) return;
    const started = performance.now();
    const stampSeconds = Math.min(0.25, Math.max(0.005, seconds)) / points.length;
    for (const center of points) {
      const chunks = this.terrain.applyBrush({ mode: stroke.mode, center, size: stroke.size, strength: stroke.strength, seconds: stampSeconds, flattenHeight: stroke.flattenHeight }, stroke.before, this.roadTerrainEditWeights);
      for (const id of chunks) stroke.chunks.add(id);
      if (chunks.length > 0) this.terrainChanged(chunks, {
        minX: center.x - stroke.size / 2, maxX: center.x + stroke.size / 2,
        minZ: center.z - stroke.size / 2, maxZ: center.z + stroke.size / 2,
      });
    }
    this.terrainEditMs = performance.now() - started;
  }

  endTerrainStroke(): void {
    const stroke = this.activeTerrainStroke;
    this.activeTerrainStroke = undefined;
    if (!stroke || stroke.before.size === 0) return;
    const after = new Map<number, number>();
    for (const index of stroke.before.keys()) after.set(index, this.terrain.heights[index]);
    this.history.execute(new AppliedTerrainStrokeCommand(this.terrain, stroke.before, after, [...stroke.chunks], this.boundsForVertices(stroke.before)), this.graph);
  }

  cancelTerrainStroke(): void {
    const stroke = this.activeTerrainStroke;
    this.activeTerrainStroke = undefined;
    if (!stroke) return;
    this.terrainChanged(this.terrain.applyValues(stroke.before), this.boundsForVertices(stroke.before));
  }

  setTerrainPreset(preset: TerrainPreset): void {
    this.endTerrainStroke();
    const started = performance.now();
    const before = this.terrain.cloneHeights();
    const beforePreset = this.terrain.settings.preset;
    this.terrainChanged(this.terrain.setPreset(preset, this.roadTerrainEditWeights));
    this.history.execute(new TerrainPresetCommand(this.terrain, before, beforePreset, this.terrain.cloneHeights(), preset), this.graph);
    this.terrainEditMs = performance.now() - started;
  }

  consumeTerrainUpdate(): { patches: TerrainPatch[]; chunkIds: ChunkDescriptor['id'][]; zoneElevations: Array<{ id: string; terrainHeight: number; terrainSuitable: boolean }>; lotRevision: number; lotUpdates: Lot[]; removedLotIds: LotId[]; buildingUpdates: Building[]; removedBuildingIds: Building['id'][]; lotReevaluatedCells: number; messageBytes: number; terrainRevision: number; terrainEditMs: number } | undefined {
    if (this.terrainUpdatedChunkIds.size === 0) return undefined;
    const chunkIds = [...this.terrainUpdatedChunkIds].sort();
    const patches = chunkIds.map((id) => this.terrain.patchForChunk(id));
    const changed = new Set(chunkIds);
    const zoneElevations: Array<{ id: string; terrainHeight: number; terrainSuitable: boolean }> = [];
    this.zoningCells = this.zoningCells.map((cell) => {
      const chunk = worldToChunk(cell.center, this.worldMetadata);
      if (!changed.has(`chunk-${chunk.x}-${chunk.z}`)) return cell;
      zoneElevations.push({ id: cell.id, terrainHeight: cell.terrainHeight ?? this.terrain.getHeight(cell.center.x, cell.center.z),
        terrainSuitable: cell.terrainSuitable ?? isTerrainSuitableForZone(cell, (x, z) => this.terrain.getHeight(x, z)) });
      return cell;
    });
    this.terrainUpdatedChunkIds.clear();
    const delta = this.lots.takeDelta();
    return { patches, chunkIds, zoneElevations, terrainRevision: this.terrainRevision, terrainEditMs: this.terrainEditMs,
      lotRevision: this.lotRevision, lotUpdates: delta.lots, removedLotIds: delta.removedLotIds,
      buildingUpdates: delta.buildings, removedBuildingIds: delta.removedBuildingIds,
      lotReevaluatedCells: this.lots.lastReevaluatedCells,
      messageBytes: patches.reduce((sum, patch) => sum + patch.heights.byteLength, 0) + zoneElevations.length * 17
        + JSON.stringify(delta).length };
  }

  snapshot(includeTerrainHeightmap = true): WorldSnapshot {
    this.ensureCitizens();
    return {
      worldMetadata: structuredClone(this.worldMetadata),
      revision: this.revision,
      roadRevision: this.roadRevision,
      zoningRevision: this.zoningRevision,
      terrainRevision: this.terrainRevision,
      terrain: this.terrain.metadata(),
      terrainHeightmap: includeTerrainHeightmap ? this.terrain.cloneHeights() : undefined,
      terrainUpdatedChunkIds: [...this.terrainUpdatedChunkIds],
      terrainEditMs: this.terrainEditMs,
      water: this.water.snapshot(),
      chunks: createChunks(this.worldMetadata),
      roadGraph: this.graph.snapshot(),
      zoningCells: structuredClone(this.zoningCells),
      lotRevision: this.lotRevision,
      lots: structuredClone(this.lots.lots),
      buildings: structuredClone(this.lots.buildings),
      population: this.population.snapshot(),
      economy: this.economy.snapshot(),
      traffic: this.traffic.snapshot(),
      services: this.services.snapshot(),
      transit: this.transit.snapshot(),
      lotReevaluatedCells: this.lots.lastReevaluatedCells,
      zoningUpdatedChunkIds: [...this.zoningUpdatedChunkIds],
      gameClock: this.clock.snapshot(),
      simulationTickMs: this.simulationTickMs,
    };
  }

  clockUpdate(): Pick<WorldSnapshot, 'revision' | 'gameClock' | 'simulationTickMs'> {
    return {
      revision: this.revision,
      gameClock: this.clock.snapshot(),
      simulationTickMs: this.simulationTickMs,
    };
  }

  populationUpdate(): PopulationSnapshot { return this.population.snapshot(); }
  economyUpdate(): EconomySnapshot { return this.economy.snapshot(); }
  trafficUpdate(): TrafficSnapshot { return this.traffic.snapshot(); }
  serviceUpdate(): ServiceSnapshot { return this.services.snapshot(); }
  transitUpdate(): TransitSnapshot { return this.transit.snapshot(); }

  serialize(): SaveFileV13 {
    this.ensureCitizens();
    const active = new Set(this.zoningCells.map((cell) => cell.id));
    const zoningAssignments: ZoneAssignment[] = [...this.zoneAssignments]
      .filter(([cellId]) => active.has(cellId))
      .map(([cellId, zoneType]) => ({ cellId, zoneType }))
      .sort((left, right) => left.cellId.localeCompare(right.cellId));
    return serializeWorld({ terrain: this.terrain.state(), roadGraph: this.graph.snapshot(), gameClock: this.clock.snapshot(), zoningAssignments,
      lots: this.lots.lots, buildings: this.lots.buildings, population: this.population.save(),
      economy: this.economy.save(), traffic: this.traffic.save(), services: this.services.save(), transit: this.transit.save(),
      water: this.water.save(), generation: this.generation, worldMetadata: this.worldMetadata });
  }

  load(save: SaveFile): void {
    const world = deserializeWorld(save);
    if (
      !Number.isFinite(world.terrain.width) || world.terrain.width <= 0
      || !Number.isFinite(world.terrain.depth) || world.terrain.depth <= 0
      || !Number.isFinite(world.terrain.baseHeight)
    ) throw new Error('Save contains invalid terrain data.');
    if (
      !Number.isFinite(world.gameClock.gameSeconds) || world.gameClock.gameSeconds < 0
      || !([0, 1, 2, 4, 8] as const).includes(world.gameClock.speed)
    ) throw new Error('Save contains an invalid game clock.');

    // Validate into detached instances first. No live Authority state is touched
    // until every save component is known to be safe.
    const validatedGraph = new RoadGraph(world.roadGraph, world.worldMetadata);
    const validatedTerrain = new HeightmapTerrain(world.terrain);
    const validatedWater = new StaticWater(world.water);
    const validatedClock = new GameClock();
    validatedClock.restore(world.gameClock);
    const validCells = new Set(new ZoningSystem(world.worldMetadata).update(validatedGraph.snapshot()).map((cell) => cell.id));
    const loadedAssignments = new Map<ZoningCellId, ZoneType>();
    for (const assignment of world.zoningAssignments) {
      if (!assignment || !validCells.has(assignment.cellId) || !isZoneType(assignment.zoneType)
        || loadedAssignments.has(assignment.cellId)) throw new Error('Save contains invalid zoning assignments.');
      loadedAssignments.set(assignment.cellId, assignment.zoneType);
    }
    const validatedCells = new ZoningSystem(world.worldMetadata).update(validatedGraph.snapshot()).map((cell) => ({ ...cell,
      zoneType: loadedAssignments.get(cell.id),
      terrainSuitable: isTerrainSuitableForZone(cell, (x, z) => validatedTerrain.getHeight(x, z)) }));
    const validatedLots = new LotSystem(world.worldMetadata);
    const validRoadIds = new Set(validatedGraph.snapshot().segments.map((segment) => segment.id));
    if (world.lots.some((lot) => !validRoadIds.has(lot.roadAccess?.roadSegmentId))) throw new Error('Save contains invalid lot road access.');
    if (world.hasLotData) validatedLots.restore(world.lots, world.buildings, validatedCells,
      (x, z) => validatedTerrain.getHeight(x, z), validatedClock.gameSeconds);
    else validatedLots.reconcile(validatedCells, (x, z) => validatedTerrain.getHeight(x, z), validatedClock.gameSeconds);
    const validatedPopulation = new PopulationSystem();
    if (world.hasPopulationData) validatedPopulation.restore(world.population, validatedLots.buildings,
      validatedLots.lots, validatedClock.gameSeconds);
    else validatedPopulation.syncBuildings(validatedLots.buildings, validatedLots.lots, validatedClock.gameSeconds);
    const validatedEconomy = new EconomySystem(undefined, validatedClock.gameSeconds);
    if (world.hasEconomyData) validatedEconomy.restore(world.economy, validatedClock.gameSeconds);
    const validatedTraffic = new TrafficSystem(validatedGraph.snapshot(), undefined, validatedClock.gameSeconds, world.worldMetadata, world.worldMetadata!.outsideConnections);
    validatedTraffic.world = world.worldMetadata!; validatedTraffic.mapConnections = world.worldMetadata!.outsideConnections;
    validatedTraffic.updateGraph(validatedGraph.snapshot());
    if (world.hasTrafficData) validatedTraffic.restore(world.traffic, validatedClock.gameSeconds);
    validatedTraffic.reconcileLots(validatedLots.lots);
    const validatedServices = new ServiceSystem();
    validatedServices.world = world.worldMetadata!;
    if (world.hasServiceData) validatedServices.restore(world.services, validatedGraph.snapshot(),
      (x, z) => validatedTerrain.getHeight(x, z));
    validatedServices.recalculate(validatedGraph.snapshot(), validatedLots.lots, validatedPopulation.snapshot());
    const validatedTransit = new TransitSystem(validatedGraph.snapshot(), undefined, validatedClock.gameSeconds);
    validatedTransit.world = world.worldMetadata!;
    if (world.hasTransitData) validatedTransit.restore(world.transit, validatedClock.gameSeconds);
    validatedTraffic.setTransitSystem(validatedTransit);
    validatedTraffic.syncCitizens(validatedPopulation.households, validatedPopulation.snapshot(), validatedLots.lots, validatedClock.gameSeconds);
    this.graph.world = world.worldMetadata!;
    this.zoningSystem.setWorld(world.worldMetadata!);
    this.graph.restore(validatedGraph.snapshot());
    this.clock.restore(validatedClock.snapshot());
    this.terrain = validatedTerrain;
    this.worldMetadata = structuredClone(world.worldMetadata!);
    this.water.restore(validatedWater.save());
    this.generation = world.generation;
    this.activeTerrainStroke = undefined;
    this.terrainChanged(createChunks(this.worldMetadata).map((chunk) => chunk.id));
    this.zoneAssignments.clear();
    for (const [id, zone] of loadedAssignments) this.zoneAssignments.set(id, zone);
    this.history.clear();
    this.roadChanged();
    this.lots = validatedLots;
    this.population = validatedPopulation;
    this.economy = validatedEconomy;
    this.traffic = validatedTraffic;
    this.services = validatedServices;
    this.transit = validatedTransit;
    this.citizenPopulationRevision = this.population.revision;
    this.citizensDirty = false;
    this.refreshTerrainProtection();
    this.lotRevision += 1;
  }

  private configureWorld(): void {
    this.graph.world = this.worldMetadata; this.zoningSystem.setWorld(this.worldMetadata);
    this.lots.world = this.worldMetadata; this.services.world = this.worldMetadata; this.transit.world = this.worldMetadata;
    this.traffic.world = this.worldMetadata; this.traffic.mapConnections = this.worldMetadata.outsideConnections;
    this.refreshTerrainProtection();
  }

  private roadChanged(): void {
    const graph = this.graph.snapshot();
    this.refreshTerrainProtection();
    const oldCells = new Map(this.zoningCells.map((cell) => [cell.id, cell]));
    const cells = this.zoningSystem.update(graph);
    const active = new Set(cells.map((cell) => cell.id));
    for (const id of this.zoneAssignments.keys()) if (!active.has(id)) this.zoneAssignments.delete(id);
    this.zoningCells = this.withZoneTypes(cells);
    this.zoningUpdatedChunkIds = this.zoningSystem.getUpdatedChunkIds();
    const changedIds = new Set<ZoningCellId>();
    const nextCells = new Map(this.zoningCells.map((cell) => [cell.id, cell]));
    for (const [id, old] of oldCells) {
      const cell = nextCells.get(id);
      if (!cell || old.zoneType !== cell.zoneType || JSON.stringify(old.corners) !== JSON.stringify(cell.corners)) changedIds.add(id);
    }
    for (const id of nextCells.keys()) if (!oldCells.has(id)) changedIds.add(id);
    if (changedIds.size > 0) {
      this.lots.reconcile(this.zoningCells, (x, z) => this.terrain.getHeight(x, z), this.clock.gameSeconds,
        { cellIds: [...changedIds] });
      this.lotRevision += 1;
    }
    const before = this.lots.revision;
    this.lots.refreshRoadAccess(graph.segments);
    if (this.lots.revision !== before) this.lotRevision += 1;
    this.syncPopulation();
    this.traffic.updateGraph(graph);
    this.traffic.reconcileLots(this.lots.lots);
    this.transit.updateGraph(graph, this.clock.gameSeconds);
    this.citizensDirty = true;
    this.roadRevision += 1;
    this.zoningRevision += 1;
    this.revision += 1;
  }

  private terrainChanged(chunkIds: readonly ChunkDescriptor['id'][], bounds?: TerrainEditBounds): void {
    if (chunkIds.length === 0) return;
    const changed = new Set(chunkIds);
    const affectedCellIds: ZoningCellId[] = [];
    this.zoningCells = this.zoningCells.map((cell) => {
      const { x, z } = worldToChunk(cell.center, this.worldMetadata);
      if (!changed.has(`chunk-${x}-${z}`)) return cell;
      if (bounds && (cell.center.x < bounds.minX - 8 || cell.center.x > bounds.maxX + 8
        || cell.center.z < bounds.minZ - 8 || cell.center.z > bounds.maxZ + 8)) return cell;
      affectedCellIds.push(cell.id);
      return { ...cell, terrainHeight: this.terrain.getHeight(cell.center.x, cell.center.z),
        terrainSuitable: isTerrainSuitableForZone(cell, (a, b) => this.terrain.getHeight(a, b)) };
    });
    if (affectedCellIds.length > 0) {
      this.lots.reconcile(this.zoningCells, (x, z) => this.terrain.getHeight(x, z), this.clock.gameSeconds,
        bounds ? { cellIds: affectedCellIds } : { chunkIds });
      this.lotRevision += 1;
      this.syncPopulation();
      this.traffic.reconcileLots(this.lots.lots);
    }
    for (const id of chunkIds) this.terrainUpdatedChunkIds.add(id);
    this.terrainRevision += 1;
    this.revision += 1;
  }

  private zonesChanged(cellIds: readonly ZoningCellId[]): void {
    this.zoningCells = this.withZoneTypes(this.zoningCells);
    const changed = new Set(cellIds);
    this.zoningUpdatedChunkIds = [...new Set(this.zoningCells
      .filter((cell) => changed.has(cell.id))
      .map((cell) => {
        const { x, z } = worldToChunk(cell.center, this.worldMetadata);
        return `chunk-${x}-${z}` as const;
      }))].sort();
    this.lots.reconcile(this.zoningCells, (x, z) => this.terrain.getHeight(x, z), this.clock.gameSeconds, { cellIds });
    this.lots.refreshRoadAccess(this.graph.snapshot().segments);
    this.lotRevision += 1;
    this.syncPopulation();
    this.traffic.reconcileLots(this.lots.lots);
    this.zoningRevision += 1;
    this.revision += 1;
  }

  private withZoneTypes(cells: readonly ZoningCell[]): ZoningCell[] {
    return cells.map((cell) => {
      const { zoneType: _previous, ...geometry } = cell;
      const zoneType = this.zoneAssignments.get(cell.id);
      const terrainHeight = this.terrain.getHeight(cell.center.x, cell.center.z);
      const terrainSuitable = isTerrainSuitableForZone(cell, (x, z) => this.terrain.getHeight(x, z));
      return zoneType ? { ...geometry, zoneType, terrainHeight, terrainSuitable } : { ...geometry, terrainHeight, terrainSuitable };
    });
  }

  private syncPopulation(): void {
    this.population.syncBuildings(this.lots.buildings, this.lots.lots, this.clock.gameSeconds);
    this.refreshServices();
    this.citizensDirty = true;
  }

  private ensureCitizens(): void {
    if (!this.citizensDirty && this.citizenPopulationRevision === this.population.revision) return;
    this.traffic.syncCitizens(this.population.households, this.population.snapshot(), this.lots.lots, this.clock.gameSeconds);
    this.citizenPopulationRevision = this.population.revision; this.citizensDirty = false;
  }

  private refreshServices(): void {
    this.services.recalculate(this.graph.snapshot(), this.lots.lots, this.population.snapshot());
  }

  private refreshTerrainProtection(): void {
    this.roadTerrainEditWeights = buildRoadTerrainProtection(this.graph.snapshot().segments
      .filter((segment) => (segment.structureType ?? 'ground') === 'ground'), this.worldMetadata);
    protectServiceLots(this.roadTerrainEditWeights, this.services.facilities, this.worldMetadata);
  }

  private boundsForVertices(values: ReadonlyMap<number, number>): TerrainEditBounds | undefined {
    if (values.size === 0) return undefined;
    const bounds: TerrainEditBounds = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
    for (const index of values.keys()) {
      const x = index % this.terrain.columns * this.terrain.settings.sampleSpacing - this.terrain.width / 2;
      const z = Math.floor(index / this.terrain.columns) * this.terrain.settings.sampleSpacing - this.terrain.depth / 2;
      bounds.minX = Math.min(bounds.minX, x); bounds.maxX = Math.max(bounds.maxX, x);
      bounds.minZ = Math.min(bounds.minZ, z); bounds.maxZ = Math.max(bounds.maxZ, z);
    }
    return bounds;
  }
}
