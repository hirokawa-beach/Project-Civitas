import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import type { ArcRotateCameraPointersInput } from '@babylonjs/core/Cameras/Inputs/arcRotateCameraPointersInput';
import '@babylonjs/core/Culling/ray';
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine';
import { Engine } from '@babylonjs/core/Engines/engine';
import '@babylonjs/core/Engines/Extensions/engine.dynamicTexture';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { CreateCylinder } from '@babylonjs/core/Meshes/Builders/cylinderBuilder';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder';
import { CreateDashedLines, CreateLineSystem } from '@babylonjs/core/Meshes/Builders/linesBuilder';
import { CreatePlane } from '@babylonjs/core/Meshes/Builders/planeBuilder';
import { CreateRibbon } from '@babylonjs/core/Meshes/Builders/ribbonBuilder';
import { CreateSphere } from '@babylonjs/core/Meshes/Builders/sphereBuilder';
import { CreateTorus } from '@babylonjs/core/Meshes/Builders/torusBuilder';
import type { LinesMesh } from '@babylonjs/core/Meshes/linesMesh';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { Scene } from '@babylonjs/core/scene';
import type { RoadNodeId, RoadSegmentId } from '../shared/ids';
import { buildingDefinition } from '../lots/definitions';
import type { Building, BuildingId, Lot } from '../lots/types';
import type { WorldSnapshot } from '../shared/protocol';
import { createChunks, worldToChunk, CHUNK_SIZE, HALF_WORLD_SIZE, type ChunkCoordinate, type ChunkDescriptor, type Vec2 } from '../world/types';
import { HeightmapTerrain, TERRAIN_SAMPLE_SPACING } from '../terrain/heightmap';
import { distance, normalize, subtract } from '../roads/geometry';
import type { RoadSegment } from '../roads/types';
import type { ConstructionGuide } from '../roads/snapping';
import { ZONE_TYPES, type ZoneBrush, type ZoneType, type ZoningCell } from '../zoning/types';
import type { ScreenPoint } from '../zoning/interaction';

const ZONE_COLORS: Record<ZoneType, string> = {
  residential: '#67bd78',
  commercial: '#5b99e8',
  industrial: '#e7ae54',
  office: '#a77acf',
};

export interface RoadPreviewVisual {
  points: Vec2[];
  width: number;
  valid: boolean;
  snapPosition?: Vec2;
  intersections: Vec2[];
  guides: ConstructionGuide[];
  anchors: Array<{ position: Vec2; kind: 'start' | 'direction' | 'end' }>;
  labels: Array<{ position: Vec2; text: string }>;
  angleArcs: Array<{ center: Vec2; fromDirection: Vec2; toDirection: Vec2; radius: number }>;
}

export class GameRenderer {
  readonly scene: Scene;
  readonly camera: ArcRotateCamera;
  readonly rendererName: 'WebGPU' | 'WebGL2';

  private readonly roadMeshes = new Map<RoadSegmentId, Mesh>();
  private readonly roadSignatures = new Map<RoadSegmentId, string>();
  private readonly intersectionMeshes = new Map<RoadNodeId, Mesh>();
  private readonly intersectionSignatures = new Map<RoadNodeId, string>();
  private readonly keys = new Set<string>();
  private readonly roadMaterial: StandardMaterial;
  private readonly terrainMaterial: StandardMaterial;
  private terrain?: HeightmapTerrain;
  private readonly terrainMeshes = new Map<ChunkDescriptor['id'], Mesh>();
  private appliedTerrainRevision = -1;
  private terrainMeshUpdateMs = 0;
  private terrainUpdateFrameMs = 0;
  private chunkGrid?: LinesMesh;
  private brushRing?: LinesMesh;
  private readonly intersectionMaterial: StandardMaterial;
  private readonly previewValidMaterial: StandardMaterial;
  private readonly previewInvalidMaterial: StandardMaterial;
  private readonly snapMaterial: StandardMaterial;
  private readonly hoverMaterial: StandardMaterial;
  private readonly zoneMaterials = {} as Record<ZoneType, StandardMaterial>;
  private readonly zonePreviewMaterials = {} as Record<ZoneType | 'erase', StandardMaterial>;
  private readonly frameSamples: number[] = [];
  private snapshot?: WorldSnapshot;
  private debugVisible = true;
  private appliedRoadRevision = -1;
  private appliedZoningRevision = -1;
  private readonly zoneMeshes = new Map<string, Mesh>();
  private readonly buildingMeshes = new Map<BuildingId, Mesh[]>();
  private readonly buildingSignatures = new Map<BuildingId, string>();
  private readonly buildingMaterials = {} as Record<ZoneType | 'planned' | 'constructing' | 'foundation', StandardMaterial>;
  private appliedLotRevision = -1;
  private readonly lotDebugMeshes = new Map<ChunkDescriptor['id'], LinesMesh[]>();
  private readonly lotDebugSignatures = new Map<ChunkDescriptor['id'], string>();
  private zonePreviewMesh?: Mesh;
  private previewMesh?: Mesh;
  private previewCenterlineMesh?: LinesMesh;
  private previewEdgeMesh?: LinesMesh;
  private snapMesh?: Mesh;
  private previewIntersectionMeshes: Mesh[] = [];
  private previewGuideMeshes: Mesh[] = [];
  private previewAnchorMeshes: Mesh[] = [];
  private previewAngleMeshes: LinesMesh[] = [];
  private previewLabelMeshes: Mesh[] = [];
  private graphDebugMeshes: Mesh[] = [];
  private readonly roadCenterlineMeshes = new Map<RoadSegmentId, LinesMesh>();
  private readonly zoningDebugMeshes = new Map<ChunkDescriptor['id'], LinesMesh>();
  private hoveredSegmentId?: RoadSegmentId;
  private disposed = false;

  private constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly engine: AbstractEngine,
    rendererName: 'WebGPU' | 'WebGL2',
  ) {
    this.rendererName = rendererName;
    this.scene = new Scene(engine);
    this.scene.clearColor = new Color4(0.055, 0.085, 0.078, 1);
    this.scene.ambientColor = new Color3(0.28, 0.31, 0.28);

    this.camera = new ArcRotateCamera('city-camera', -Math.PI / 4, 0.92, 360, Vector3.Zero(), this.scene);
    this.camera.lowerRadiusLimit = 40;
    this.camera.upperRadiusLimit = 900;
    this.camera.lowerBetaLimit = 0.2;
    this.camera.upperBetaLimit = 1.45;
    this.camera.wheelPrecision = 1.4;
    this.camera.panningSensibility = 0;
    this.camera.inertia = 0.82;
    this.camera.attachControl(canvas, true);
    const pointerInput = this.camera.inputs.attached.pointers as ArcRotateCameraPointersInput | undefined;
    if (pointerInput) pointerInput.buttons = [1];

    new HemisphericLight('sky-light', new Vector3(0.2, 1, 0.1), this.scene).intensity = 0.78;
    const sun = new DirectionalLight('sun', new Vector3(-0.55, -1, 0.35), this.scene);
    sun.intensity = 1.2;

    this.terrainMaterial = new StandardMaterial('terrain-material', this.scene);
    this.terrainMaterial.diffuseColor = Color3.FromHexString('#66765f');
    this.terrainMaterial.specularColor = Color3.Black();
    this.terrainMaterial.backFaceCulling = false;

    this.roadMaterial = new StandardMaterial('road-material', this.scene);
    this.roadMaterial.diffuseColor = Color3.FromHexString('#303735');
    this.roadMaterial.specularColor = Color3.Black();
    this.intersectionMaterial = new StandardMaterial('intersection-material', this.scene);
    this.intersectionMaterial.diffuseColor = Color3.FromHexString('#333a38');
    this.intersectionMaterial.specularColor = Color3.Black();
    this.hoverMaterial = new StandardMaterial('road-hover-material', this.scene);
    this.hoverMaterial.diffuseColor = Color3.FromHexString('#d48745');
    this.hoverMaterial.emissiveColor = Color3.FromHexString('#4a2411');
    this.hoverMaterial.specularColor = Color3.Black();

    this.previewValidMaterial = new StandardMaterial('preview-valid', this.scene);
    this.previewValidMaterial.diffuseColor = Color3.FromHexString('#45bff2');
    this.previewValidMaterial.emissiveColor = Color3.FromHexString('#123f5a');
    this.previewValidMaterial.alpha = 0.72;
    this.previewInvalidMaterial = new StandardMaterial('preview-invalid', this.scene);
    this.previewInvalidMaterial.diffuseColor = Color3.FromHexString('#ee6b61');
    this.previewInvalidMaterial.emissiveColor = Color3.FromHexString('#5b1717');
    this.previewInvalidMaterial.alpha = 0.8;
    this.snapMaterial = new StandardMaterial('snap-material', this.scene);
    this.snapMaterial.diffuseColor = Color3.FromHexString('#d8f8ff');
    this.snapMaterial.emissiveColor = Color3.FromHexString('#2b7898');

    for (const type of ZONE_TYPES) {
      this.zoneMaterials[type] = this.makeZoneMaterial(`zone-${type}`, ZONE_COLORS[type], 0.82);
      this.zonePreviewMaterials[type] = this.makeZoneMaterial(`zone-preview-${type}`, ZONE_COLORS[type], 0.9);
      const buildingMaterial = new StandardMaterial(`building-${type}`, this.scene);
      buildingMaterial.diffuseColor = Color3.FromHexString(ZONE_COLORS[type]);
      buildingMaterial.specularColor = Color3.Black();
      this.buildingMaterials[type] = buildingMaterial;
    }
    for (const [key, color] of Object.entries({ planned: '#d9c984', constructing: '#c79164', foundation: '#88867b' })) {
      const material = new StandardMaterial(`building-${key}`, this.scene);
      material.diffuseColor = Color3.FromHexString(color);
      material.specularColor = Color3.Black();
      this.buildingMaterials[key as 'planned' | 'constructing' | 'foundation'] = material;
    }
    this.zonePreviewMaterials.erase = this.makeZoneMaterial('zone-preview-erase', '#ef6c64', 0.88);

    this.createChunkGrid();
    this.bindCameraKeys();
    this.scene.onBeforeRenderObservable.add(() => this.updateCamera());
    this.engine.runRenderLoop(() => {
      if (this.disposed) return;
      const started = performance.now();
      this.scene.render();
      this.frameSamples.push(performance.now() - started);
      if (this.frameSamples.length > 90) this.frameSamples.shift();
    });
    window.addEventListener('resize', this.resize);
  }

  static async create(canvas: HTMLCanvasElement): Promise<GameRenderer> {
    try {
      const forceWebGl2 = new URLSearchParams(window.location.search).get('renderer') === 'webgl2';
      if (!forceWebGl2 && 'gpu' in navigator) {
        const { WebGPUEngine } = await import('@babylonjs/core/Engines/webgpuEngine');
        await import('@babylonjs/core/Engines/WebGPU/Extensions/engine.dynamicTexture');
        if (await WebGPUEngine.IsSupportedAsync) {
          const engine = new WebGPUEngine(canvas, { antialias: true });
          await engine.initAsync();
          return new GameRenderer(canvas, engine, 'WebGPU');
        }
      }
    } catch {
      // WebGL2 is the supported fallback; rendererName exposes the selected backend.
    }
    const engine = new Engine(canvas, true, { preserveDrawingBuffer: false, stencil: true, disableWebGL2Support: false });
    if (engine.webGLVersion < 2) {
      engine.dispose();
      throw new Error('Project Civitas requires WebGPU or WebGL 2.');
    }
    return new GameRenderer(canvas, engine, 'WebGL2');
  }

  updateSnapshot(snapshot: WorldSnapshot): void {
    const updateStarted = performance.now();
    this.snapshot = snapshot;
    const terrainChanged = snapshot.terrainRevision !== this.appliedTerrainRevision;
    const terrainChunks = terrainChanged ? this.syncTerrain(snapshot) : [];
    const roadChanged = snapshot.roadRevision !== this.appliedRoadRevision;
    const zoningChanged = snapshot.zoningRevision !== this.appliedZoningRevision;
    const lotChanged = snapshot.lotRevision !== this.appliedLotRevision;
    if (!roadChanged && !zoningChanged && !terrainChanged && !lotChanged) return;
    const affectedRoadIds = terrainChanged && !roadChanged ? this.invalidateRoadsInChunks(terrainChunks) : [];
    if (roadChanged) {
      this.appliedRoadRevision = snapshot.roadRevision;
    }
    if (roadChanged || terrainChanged) {
      this.syncRoadMeshes(snapshot.roadGraph.segments);
      this.syncIntersections(snapshot);
    }
    if (zoningChanged || terrainChanged) {
      this.appliedZoningRevision = snapshot.zoningRevision;
      this.syncZones(snapshot.zoningCells, zoningChanged ? createChunks().map((chunk) => chunk.id) : terrainChunks);
    }
    if (lotChanged || terrainChanged) {
      this.syncBuildings(snapshot.lots, snapshot.buildings);
      this.appliedLotRevision = snapshot.lotRevision;
    }
    if (this.debugVisible) {
      if (roadChanged || zoningChanged) this.rebuildDebugGeometry();
      else if (terrainChanged) {
        this.rebuildDebugZones(terrainChunks);
        this.rebuildDebugCenterlines(snapshot.roadGraph.segments.filter((segment) => affectedRoadIds.includes(segment.id)));
      }
      if (lotChanged || terrainChanged) this.rebuildDebugLots(snapshot.lots);
    }
    if (terrainChanged) this.terrainUpdateFrameMs = performance.now() - updateStarted;
  }

  getHeight(x: number, z: number): number { return this.terrain?.getHeight(x, z) ?? 0; }
  getNormal(x: number, z: number): { x: number; y: number; z: number } { return this.terrain?.getNormal(x, z) ?? { x: 0, y: 1, z: 0 }; }
  getTerrainMeshUpdateMs(): number { return this.terrainMeshUpdateMs; }
  getTerrainUpdateFrameMs(): number { return this.terrainUpdateFrameMs; }
  private toVector(point: Vec2, offset = 0.22): Vector3 { return new Vector3(point.x, this.getHeight(point.x, point.z) + offset, point.z); }

  private syncTerrain(snapshot: WorldSnapshot): ChunkDescriptor['id'][] {
    const started = performance.now();
    let changed: ChunkDescriptor['id'][] = [];
    if (snapshot.terrainPatches && this.terrain) {
      for (const patch of snapshot.terrainPatches) this.terrain.applyPatch(patch);
      this.terrain.settings.preset = snapshot.terrain.settings.preset;
      changed = snapshot.terrainUpdatedChunkIds;
    } else if (snapshot.terrainHeightmap) {
      this.terrain = HeightmapTerrain.fromBuffer(snapshot.terrain, snapshot.terrainHeightmap);
      changed = createChunks().map((chunk) => chunk.id);
    }
    for (const id of changed) this.rebuildTerrainChunk(id);
    if (changed.length > 0) this.createChunkGrid();
    this.appliedTerrainRevision = snapshot.terrainRevision;
    this.terrainMeshUpdateMs = performance.now() - started;
    return changed;
  }

  private rebuildTerrainChunk(id: ChunkDescriptor['id']): void {
    this.terrainMeshes.get(id)?.dispose();
    const terrain = this.terrain;
    if (!terrain) return;
    const chunk = createChunks().find((item) => item.id === id)!;
    const steps = CHUNK_SIZE / TERRAIN_SAMPLE_SPACING;
    const positions: number[] = [];
    const normals: number[] = [];
    const indices: number[] = [];
    for (let row = 0; row <= steps; row += 1) {
      for (let column = 0; column <= steps; column += 1) {
        const x = -HALF_WORLD_SIZE + chunk.x * CHUNK_SIZE + column * TERRAIN_SAMPLE_SPACING;
        const z = -HALF_WORLD_SIZE + chunk.z * CHUNK_SIZE + row * TERRAIN_SAMPLE_SPACING;
        const normal = terrain.getNormal(x, z);
        positions.push(x, terrain.getHeight(x, z), z);
        normals.push(normal.x, normal.y, normal.z);
        if (row < steps && column < steps) {
          const index = row * (steps + 1) + column;
          indices.push(index, index + steps + 1, index + 1, index + 1, index + steps + 1, index + steps + 2);
        }
      }
    }
    const mesh = new Mesh(`terrain-${id}`, this.scene);
    const data = new VertexData();
    data.positions = positions;
    data.normals = normals;
    data.indices = indices;
    data.applyToMesh(mesh);
    mesh.material = this.terrainMaterial;
    mesh.metadata = { type: 'terrain', chunkId: id };
    mesh.isPickable = true;
    this.terrainMeshes.set(id, mesh);
  }

  private syncZones(cells: readonly ZoningCell[], chunkIds: readonly ChunkDescriptor['id'][]): void {
    for (const id of chunkIds) {
      for (const type of ZONE_TYPES) {
        const key = `${id}:${type}`;
        this.zoneMeshes.get(key)?.dispose();
        this.zoneMeshes.delete(key);
        const mesh = this.createZoneMesh(`zoning-${key}`, cells.filter((cell) => cell.terrainSuitable !== false && cell.zoneType === type &&
          `chunk-${worldToChunk(cell.center).x}-${worldToChunk(cell.center).z}` === id), 0.27);
        if (mesh) { mesh.material = this.zoneMaterials[type]; this.zoneMeshes.set(key, mesh); }
      }
    }
  }

  private syncBuildings(lots: readonly Lot[], buildings: readonly Building[]): void {
    const lotById = new Map(lots.map((lot) => [lot.id, lot]));
    const active = new Set(buildings.map((building) => building.id));
    for (const [id, meshes] of this.buildingMeshes) if (!active.has(id)) {
      for (const mesh of meshes) mesh.dispose();
      this.buildingMeshes.delete(id);
      this.buildingSignatures.delete(id);
    }
    for (const building of buildings) {
      const lot = lotById.get(building.lotId);
      const definition = buildingDefinition(building.definitionId);
      if (!lot || !definition) continue;
      const signature = JSON.stringify([building.state, building.definitionId, lot.position, lot.rotation,
        lot.width, lot.depth, lot.minElevation, lot.maxElevation, lot.baseElevation]);
      if (this.buildingSignatures.get(building.id) === signature) continue;
      for (const mesh of this.buildingMeshes.get(building.id) ?? []) mesh.dispose();
      const meshes: Mesh[] = [];
      if (building.state !== 'Empty') {
        const foundationHeight = Math.max(0.4, lot.maxElevation - lot.minElevation + 0.35);
        const foundation = CreateBox(`foundation-${building.id}`, {
          width: Math.max(2, lot.width - 0.8), depth: Math.max(2, lot.depth - 0.8), height: foundationHeight,
        }, this.scene);
        foundation.position = new Vector3(lot.position.x, lot.maxElevation + 0.2 - foundationHeight / 2, lot.position.z);
        foundation.rotation.y = -lot.rotation;
        foundation.material = this.buildingMaterials.foundation;
        foundation.isPickable = false;
        meshes.push(foundation);
        const height = building.state === 'Planned' ? 0.6
          : building.state === 'Constructing' ? definition.height * 0.55 : definition.height;
        const body = CreateBox(`building-${building.id}`, {
          width: Math.max(2, lot.width - 2), depth: Math.max(2, lot.depth - 2), height,
        }, this.scene);
        body.position = new Vector3(lot.position.x, lot.maxElevation + 0.2 + height / 2, lot.position.z);
        body.rotation.y = -lot.rotation;
        body.material = this.buildingMaterials[building.state === 'Planned' ? 'planned'
          : building.state === 'Constructing' ? 'constructing' : lot.zoneType];
        body.isPickable = false;
        meshes.push(body);
      }
      this.buildingMeshes.set(building.id, meshes);
      this.buildingSignatures.set(building.id, signature);
    }
  }

  private invalidateRoadsInChunks(ids: readonly ChunkDescriptor['id'][]): RoadSegmentId[] {
    const changed = new Set(ids);
    if (!this.snapshot) return [];
    const affected = new Set<RoadSegmentId>();
    for (const segment of this.snapshot.roadGraph.segments) {
      const points = segment.geometry.points;
      const minX = Math.min(...points.map((point) => point.x)) - segment.width;
      const maxX = Math.max(...points.map((point) => point.x)) + segment.width;
      const minZ = Math.min(...points.map((point) => point.z)) - segment.width;
      const maxZ = Math.max(...points.map((point) => point.z)) + segment.width;
      const a = worldToChunk({ x: minX, z: minZ });
      const b = worldToChunk({ x: maxX, z: maxZ });
      for (let z = a.z; z <= b.z; z += 1) for (let x = a.x; x <= b.x; x += 1) {
        if (changed.has(`chunk-${x}-${z}`)) {
          this.roadSignatures.delete(segment.id);
          affected.add(segment.id);
        }
      }
    }
    for (const node of this.snapshot.roadGraph.nodes) {
      const chunk = worldToChunk(node.position);
      if (changed.has(`chunk-${chunk.x}-${chunk.z}`)) this.intersectionSignatures.delete(node.id);
    }
    return [...affected];
  }

  setZonePreview(cells: readonly ZoningCell[], brush: ZoneBrush): void {
    this.zonePreviewMesh?.dispose();
    this.zonePreviewMesh = this.createZoneMesh('zoning-brush-preview', cells, 0.42);
    if (this.zonePreviewMesh) this.zonePreviewMesh.material = this.zonePreviewMaterials[brush ?? 'erase'];
  }

  private makeZoneMaterial(name: string, hex: string, alpha: number): StandardMaterial {
    const material = new StandardMaterial(name, this.scene);
    material.diffuseColor = Color3.Black();
    material.emissiveColor = Color3.FromHexString(hex);
    material.disableLighting = true;
    material.backFaceCulling = false;
    material.alpha = alpha;
    return material;
  }

  pickGround(clientX: number, clientY: number): Vec2 | undefined {
    const rect = this.canvas.getBoundingClientRect();
    const pick = this.scene.pick(clientX - rect.left, clientY - rect.top, (mesh) => mesh.metadata?.type === 'terrain');
    return pick?.hit && pick.pickedPoint ? { x: pick.pickedPoint.x, z: pick.pickedPoint.z } : undefined;
  }

  projectGround(point: Vec2): ScreenPoint | undefined {
    const projected = Vector3.Project(
      this.toVector(point, 0), Matrix.Identity(), this.scene.getTransformMatrix(),
      this.camera.viewport.toGlobal(this.engine.getRenderWidth(), this.engine.getRenderHeight()),
    );
    if (!Number.isFinite(projected.x) || !Number.isFinite(projected.y) || projected.z < 0 || projected.z > 1) return undefined;
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: projected.x * rect.width / this.engine.getRenderWidth(),
      y: projected.y * rect.height / this.engine.getRenderHeight(),
    };
  }

  setPreview(preview?: RoadPreviewVisual): void {
    this.previewMesh?.dispose();
    this.previewMesh = undefined;
    this.previewCenterlineMesh?.dispose();
    this.previewCenterlineMesh = undefined;
    this.previewEdgeMesh?.dispose();
    this.previewEdgeMesh = undefined;
    this.snapMesh?.dispose();
    this.snapMesh = undefined;
    for (const mesh of this.previewIntersectionMeshes) mesh.dispose();
    this.previewIntersectionMeshes = [];
    for (const mesh of this.previewGuideMeshes) mesh.dispose();
    this.previewGuideMeshes = [];
    for (const mesh of this.previewAnchorMeshes) mesh.dispose();
    this.previewAnchorMeshes = [];
    for (const mesh of this.previewAngleMeshes) mesh.dispose();
    this.previewAngleMeshes = [];
    for (const mesh of this.previewLabelMeshes) mesh.dispose(false, true);
    this.previewLabelMeshes = [];
    if (!preview) return;
    if (preview.points.length >= 2) {
      this.previewMesh = this.createRoadRibbon('road-preview', preview.points, preview.width + 0.4, 0.38);
      this.previewMesh.material = preview.valid ? this.previewValidMaterial : this.previewInvalidMaterial;
      this.previewMesh.isPickable = false;
      const previewLength = this.polylineLength(preview.points);
      if (previewLength > 0.01) {
        let longestStep = 0;
        for (let index = 1; index < preview.points.length; index += 1) {
          longestStep = Math.max(longestStep, distance(preview.points[index - 1], preview.points[index]));
        }
        // Babylon apportions dashes within each sampled edge. A dash step longer
        // than every edge yields an empty mesh even when the whole road is long.
        const dashStep = Math.min(2.5, longestStep);
        this.previewCenterlineMesh = CreateDashedLines('road-preview-centerline', {
          points: preview.points.map((point) => this.toVector(point, 0.84)),
          dashSize: 3.5,
          gapSize: 2.4,
          dashNb: Math.max(1, Math.ceil(previewLength / dashStep)),
        }, this.scene);
        this.previewCenterlineMesh.color = preview.valid
          ? Color3.FromHexString('#d8fff2')
          : Color3.FromHexString('#ffd1cd');
        this.previewCenterlineMesh.alpha = 0.95;
        this.previewCenterlineMesh.isPickable = false;
      }
      const [left, right] = this.roadSidePaths(preview.points, preview.width + 0.5, 0.8);
      this.previewEdgeMesh = CreateLineSystem('road-preview-edges', { lines: [left, right] }, this.scene);
      this.previewEdgeMesh.color = preview.valid ? Color3.FromHexString('#bcf2ff') : Color3.FromHexString('#ffd1cd');
      this.previewEdgeMesh.alpha = 0.95;
      this.previewEdgeMesh.isPickable = false;
    }
    if (preview.snapPosition) {
      this.snapMesh = CreateTorus('snap-target', { diameter: 8, thickness: 0.75, tessellation: 24 }, this.scene);
      this.snapMesh.position = this.toVector(preview.snapPosition, 0.72);
      this.snapMesh.rotation.x = Math.PI / 2;
      this.snapMesh.material = this.snapMaterial;
      this.snapMesh.isPickable = false;
    }
    for (const point of preview.intersections) {
      const marker = CreateCylinder('planned-intersection', { diameter: 7, height: 0.5, tessellation: 24 }, this.scene);
      marker.position = this.toVector(point, 0.56);
      marker.material = this.snapMaterial;
      marker.isPickable = false;
      this.previewIntersectionMeshes.push(marker);
    }
    for (const anchor of preview.anchors) {
      const marker = anchor.kind === 'direction'
        ? CreateSphere('curve-direction-point', { diameter: 4.8, segments: 12 }, this.scene)
        : CreateTorus(`curve-${anchor.kind}-point`, {
          diameter: preview.width + 9,
          thickness: 0.8,
          tessellation: 40,
        }, this.scene);
      marker.position = this.toVector(anchor.position, anchor.kind === 'direction' ? 1.05 : 0.88);
      if (anchor.kind !== 'direction') marker.rotation.x = Math.PI / 2;
      marker.material = this.snapMaterial;
      marker.isPickable = false;
      this.previewAnchorMeshes.push(marker);
    }
    for (const guide of preview.guides) {
      if (distance(guide.from, guide.to) <= 0.01) continue;
      const line = CreateDashedLines(`guide-${guide.kind}`, {
        points: [this.toVector(guide.from, 0.62), this.toVector(guide.to, 0.62)],
        dashSize: 4,
        gapSize: 2.5,
        dashNb: Math.max(4, Math.ceil(distance(guide.from, guide.to) / 7)),
      }, this.scene);
      line.color = guide.kind === 'distance' || guide.kind === 'tangent'
        ? Color3.FromHexString('#a9eaff')
        : Color3.FromHexString('#67c9f4');
      line.alpha = 0.9;
      line.isPickable = false;
      this.previewGuideMeshes.push(line);
    }
    for (const arc of preview.angleArcs) {
      const startAngle = Math.atan2(arc.fromDirection.z, arc.fromDirection.x);
      const endAngle = Math.atan2(arc.toDirection.z, arc.toDirection.x);
      let sweep = endAngle - startAngle;
      while (sweep > Math.PI) sweep -= Math.PI * 2;
      while (sweep < -Math.PI) sweep += Math.PI * 2;
      if (Math.abs(Math.abs(sweep) - Math.PI) < 0.001) sweep = Math.PI;
      const points = Array.from({ length: 25 }, (_, index) => {
        const angle = startAngle + sweep * index / 24;
        return this.toVector({
          x: arc.center.x + Math.cos(angle) * arc.radius,
          z: arc.center.z + Math.sin(angle) * arc.radius,
        }, 0.92);
      });
      const line = CreateLineSystem('road-preview-angle', { lines: [points] }, this.scene);
      line.color = Color3.FromHexString('#d9f8ff');
      line.alpha = 0.95;
      line.isPickable = false;
      this.previewAngleMeshes.push(line);
      const middleAngle = startAngle + sweep / 2;
      const degrees = Math.round(Math.abs(sweep) * 180 / Math.PI);
      this.previewLabelMeshes.push(this.createPreviewLabel({
        x: arc.center.x + Math.cos(middleAngle) * (arc.radius + 6),
        z: arc.center.z + Math.sin(middleAngle) * (arc.radius + 6),
      }, `${degrees}°`));
    }
    for (const label of preview.labels) this.previewLabelMeshes.push(this.createPreviewLabel(label.position, label.text));
  }

  setHoveredSegment(segmentId?: RoadSegmentId): void {
    if (this.hoveredSegmentId) {
      const previous = this.roadMeshes.get(this.hoveredSegmentId);
      if (previous) previous.material = this.roadMaterial;
    }
    this.hoveredSegmentId = segmentId;
    if (segmentId) {
      const next = this.roadMeshes.get(segmentId);
      if (next) next.material = this.hoverMaterial;
    }
  }

  setDebugVisible(visible: boolean): void {
    this.debugVisible = visible;
    if (visible) this.rebuildDebugGeometry();
    else this.disposeDebugGeometry();
  }

  setTerrainBrushPreview(center?: Vec2, size = 40): void {
    this.brushRing?.dispose();
    this.brushRing = undefined;
    if (!center) return;
    const radius = size / 2;
    const points = Array.from({ length: 65 }, (_, index) => {
      const angle = index * Math.PI * 2 / 64;
      return this.toVector({ x: center.x + Math.cos(angle) * radius, z: center.z + Math.sin(angle) * radius }, 0.55);
    });
    this.brushRing = CreateLineSystem('terrain-brush-range', { lines: [points] }, this.scene);
    this.brushRing.color = Color3.FromHexString('#f2d47a');
    this.brushRing.alpha = 0.95;
    this.brushRing.isPickable = false;
  }

  getDebugVisible(): boolean { return this.debugVisible; }
  getFps(): number { return this.engine.getFps(); }
  getFrameTime(): number {
    return this.frameSamples.length === 0 ? 0 : this.frameSamples.reduce((sum, value) => sum + value, 0) / this.frameSamples.length;
  }
  getCurrentChunk(): ChunkCoordinate { return worldToChunk({ x: this.camera.target.x, z: this.camera.target.z }); }

  dispose(): void {
    this.disposed = true;
    window.removeEventListener('resize', this.resize);
    this.scene.dispose();
    this.engine.dispose();
  }

  private readonly resize = (): void => this.engine.resize();

  private bindCameraKeys(): void {
    window.addEventListener('keydown', (event) => this.keys.add(event.code));
    window.addEventListener('keyup', (event) => this.keys.delete(event.code));
  }

  private updateCamera(): void {
    const delta = Math.min(0.05, this.engine.getDeltaTime() / 1000);
    const fast = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    const speed = (fast ? 135 : 52) * delta * Math.max(0.6, this.camera.radius / 320);
    const forward3 = this.camera.getForwardRay().direction;
    const forward = normalize({ x: forward3.x, z: forward3.z });
    const right = { x: -forward.z, z: forward.x };
    let movement = { x: 0, z: 0 };
    if (this.keys.has('KeyW')) movement = { x: movement.x + forward.x, z: movement.z + forward.z };
    if (this.keys.has('KeyS')) movement = { x: movement.x - forward.x, z: movement.z - forward.z };
    if (this.keys.has('KeyD')) movement = { x: movement.x + right.x, z: movement.z + right.z };
    if (this.keys.has('KeyA')) movement = { x: movement.x - right.x, z: movement.z - right.z };
    const direction = normalize(movement);
    if (Math.abs(direction.x) + Math.abs(direction.z) > 0) {
      this.camera.target.x = Math.max(-HALF_WORLD_SIZE, Math.min(HALF_WORLD_SIZE, this.camera.target.x + direction.x * speed));
      this.camera.target.z = Math.max(-HALF_WORLD_SIZE, Math.min(HALF_WORLD_SIZE, this.camera.target.z + direction.z * speed));
    }
  }

  private syncRoadMeshes(segments: RoadSegment[]): void {
    const incoming = new Set(segments.map((segment) => segment.id));
    for (const [id, mesh] of this.roadMeshes) {
      if (!incoming.has(id)) {
        mesh.dispose();
        this.roadMeshes.delete(id);
        this.roadSignatures.delete(id);
      }
    }
    for (const segment of segments) {
      const signature = JSON.stringify([segment.width, segment.geometry.kind, segment.geometry.points]);
      if (this.roadSignatures.get(segment.id) === signature) continue;
      const existing = this.roadMeshes.get(segment.id);
      existing?.dispose();
      const mesh = this.createRoadRibbon(segment.id, segment.geometry.points, segment.width, 0.18);
      mesh.material = segment.id === this.hoveredSegmentId ? this.hoverMaterial : this.roadMaterial;
      mesh.metadata = { type: 'road', segmentId: segment.id };
      this.roadMeshes.set(segment.id, mesh);
      this.roadSignatures.set(segment.id, signature);
    }
  }

  private syncIntersections(snapshot: WorldSnapshot): void {
    const degree = new Map<RoadNodeId, number>();
    for (const segment of snapshot.roadGraph.segments) {
      degree.set(segment.startNodeId, (degree.get(segment.startNodeId) ?? 0) + 1);
      degree.set(segment.endNodeId, (degree.get(segment.endNodeId) ?? 0) + 1);
    }
    const intersections = snapshot.roadGraph.nodes.filter((node) => (degree.get(node.id) ?? 0) >= 3);
    const incoming = new Set(intersections.map((node) => node.id));
    for (const [id, mesh] of this.intersectionMeshes) {
      if (!incoming.has(id)) {
        mesh.dispose();
        this.intersectionMeshes.delete(id);
        this.intersectionSignatures.delete(id);
      }
    }
    for (const node of intersections) {
      const signature = `${node.position.x}:${node.position.z}:${degree.get(node.id)}`;
      if (this.intersectionSignatures.get(node.id) === signature) continue;
      this.intersectionMeshes.get(node.id)?.dispose();
      const mesh = CreateCylinder(`intersection-${node.id}`, { diameter: 17, height: 0.24, tessellation: 32 }, this.scene);
      mesh.position = this.toVector(node.position, 0.19);
      mesh.material = this.intersectionMaterial;
      mesh.isPickable = false;
      this.intersectionMeshes.set(node.id, mesh);
      this.intersectionSignatures.set(node.id, signature);
    }
  }

  private createRoadRibbon(name: string, points: Vec2[], width: number, y: number): Mesh {
    const [left, right] = this.roadSidePaths(points, width, y);
    const crossSteps = Math.max(1, Math.ceil(width / TERRAIN_SAMPLE_SPACING));
    const paths = Array.from({ length: crossSteps + 1 }, (_, cross) => {
      const t = cross / crossSteps;
      return left.map((start, index) => {
        const end = right[index];
        const x = start.x + (end.x - start.x) * t;
        const z = start.z + (end.z - start.z) * t;
        return new Vector3(x, this.getHeight(x, z) + y, z);
      });
    });
    return CreateRibbon(name, { pathArray: paths, sideOrientation: Mesh.DOUBLESIDE }, this.scene);
  }

  private createZoneMesh(name: string, cells: readonly ZoningCell[], height: number): Mesh | undefined {
    if (cells.length === 0) return undefined;
    const positions: number[] = [];
    const normals: number[] = [];
    const indices: number[] = [];
    for (const cell of cells) {
      const offset = positions.length / 3;
      for (let row = 0; row <= 2; row += 1) {
        const v = row / 2;
        for (let column = 0; column <= 2; column += 1) {
          const u = column / 2;
          const near = { x: cell.corners[0].x * (1 - u) + cell.corners[1].x * u,
            z: cell.corners[0].z * (1 - u) + cell.corners[1].z * u };
          const far = { x: cell.corners[3].x * (1 - u) + cell.corners[2].x * u,
            z: cell.corners[3].z * (1 - u) + cell.corners[2].z * u };
          const x = near.x * (1 - v) + far.x * v;
          const z = near.z * (1 - v) + far.z * v;
          positions.push(x, this.getHeight(x, z) + height, z);
          const normal = this.getNormal(x, z);
          normals.push(normal.x, normal.y, normal.z);
        }
      }
      for (let row = 0; row < 2; row += 1) for (let column = 0; column < 2; column += 1) {
        const index = offset + row * 3 + column;
        indices.push(index, index + 1, index + 3, index + 1, index + 4, index + 3);
      }
    }
    const mesh = new Mesh(name, this.scene);
    const data = new VertexData();
    data.positions = positions;
    data.normals = normals;
    data.indices = indices;
    data.applyToMesh(mesh);
    mesh.isPickable = false;
    return mesh;
  }

  private roadSidePaths(points: Vec2[], width: number, y: number): [Vector3[], Vector3[]] {
    const left: Vector3[] = [];
    const right: Vector3[] = [];
    const sampled = this.sampleRoadPolyline(points);
    for (let index = 0; index < sampled.length; index += 1) {
      const previous = sampled[Math.max(0, index - 1)];
      const next = sampled[Math.min(sampled.length - 1, index + 1)];
      const tangent = normalize(subtract(next, previous));
      const normal = { x: -tangent.z, z: tangent.x };
      const leftX = sampled[index].x + normal.x * width / 2;
      const leftZ = sampled[index].z + normal.z * width / 2;
      const rightX = sampled[index].x - normal.x * width / 2;
      const rightZ = sampled[index].z - normal.z * width / 2;
      left.push(new Vector3(leftX, this.getHeight(leftX, leftZ) + y, leftZ));
      right.push(new Vector3(rightX, this.getHeight(rightX, rightZ) + y, rightZ));
    }
    return [left, right];
  }

  private sampleRoadPolyline(points: readonly Vec2[]): Vec2[] {
    const sampled: Vec2[] = [];
    for (let index = 0; index < points.length - 1; index += 1) {
      const start = points[index];
      const end = points[index + 1];
      const steps = Math.max(1, Math.ceil(distance(start, end) / TERRAIN_SAMPLE_SPACING));
      for (let step = 0; step < steps; step += 1) {
        const t = step / steps;
        sampled.push({ x: start.x + (end.x - start.x) * t, z: start.z + (end.z - start.z) * t });
      }
    }
    sampled.push(points[points.length - 1]);
    return sampled;
  }

  private polylineLength(points: Vec2[]): number {
    let total = 0;
    for (let index = 1; index < points.length; index += 1) total += distance(points[index - 1], points[index]);
    return total;
  }

  private createPreviewLabel(position: Vec2, text: string): Mesh {
    const texture = new DynamicTexture(`preview-label-${text}`, { width: 512, height: 128 }, this.scene, false);
    const context = texture.getContext() as unknown as CanvasRenderingContext2D;
    context.clearRect(0, 0, 512, 128);
    context.fillStyle = 'rgba(12, 22, 28, 0.88)';
    context.fillRect(10, 12, 492, 104);
    context.strokeStyle = 'rgba(174, 239, 255, 0.9)';
    context.lineWidth = 5;
    context.strokeRect(10, 12, 492, 104);
    context.fillStyle = '#f3fcff';
    context.font = '600 52px Arial';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(text, 256, 65);
    texture.hasAlpha = true;
    texture.update();
    const material = new StandardMaterial(`preview-label-material-${text}`, this.scene);
    material.diffuseTexture = texture;
    material.emissiveTexture = texture;
    material.opacityTexture = texture;
    material.disableLighting = true;
    material.backFaceCulling = false;
    const plane = CreatePlane(`preview-label-${text}`, { width: Math.max(8, text.length * 1.8), height: 3.6 }, this.scene);
    plane.position = this.toVector(position, 5.2);
    plane.billboardMode = Mesh.BILLBOARDMODE_ALL;
    plane.material = material;
    plane.isPickable = false;
    return plane;
  }

  private createChunkGrid(): void {
    this.chunkGrid?.dispose();
    const lines: Vector3[][] = [];
    for (let coordinate = -HALF_WORLD_SIZE; coordinate <= HALF_WORLD_SIZE; coordinate += 256) {
      lines.push(Array.from({ length: 65 }, (_, index) => this.toVector({ x: coordinate, z: -HALF_WORLD_SIZE + index * 16 }, 0.035)));
      lines.push(Array.from({ length: 65 }, (_, index) => this.toVector({ x: -HALF_WORLD_SIZE + index * 16, z: coordinate }, 0.035)));
    }
    const grid = CreateLineSystem('chunk-grid', { lines }, this.scene);
    this.chunkGrid = grid;
    grid.color = Color3.FromHexString('#8ca285');
    grid.alpha = 0.28;
    grid.isPickable = false;
  }

  private rebuildDebugGeometry(): void {
    this.disposeDebugGeometry();
    if (!this.snapshot) return;
    this.rebuildDebugCenterlines(this.snapshot.roadGraph.segments);
    for (const node of this.snapshot.roadGraph.nodes) {
      const degree = this.snapshot.roadGraph.segments.filter((segment) => segment.startNodeId === node.id || segment.endNodeId === node.id).length;
      const marker = CreateSphere(`debug-${node.id}`, { diameter: degree >= 3 ? 3.8 : 2.6, segments: 8 }, this.scene);
      marker.position = this.toVector(node.position, 1);
      const material = new StandardMaterial(`debug-${node.id}-material`, this.scene);
      material.diffuseColor = degree >= 3 ? Color3.FromHexString('#ff8d69') : Color3.FromHexString('#f8db83');
      material.emissiveColor = material.diffuseColor.scale(0.5);
      marker.material = material;
      marker.isPickable = false;
      this.graphDebugMeshes.push(marker);
    }
    this.rebuildDebugZones(createChunks().map((chunk) => chunk.id));
    this.rebuildDebugLots(this.snapshot.lots);
  }

  private rebuildDebugCenterlines(segments: readonly RoadSegment[]): void {
    for (const segment of segments) {
      this.roadCenterlineMeshes.get(segment.id)?.dispose();
      const points = this.sampleRoadPolyline(segment.geometry.points).map((point) => this.toVector(point, 0.5));
      if (points.length < 2) continue;
      const line = CreateLineSystem(`debug-centerline-${segment.id}`, { lines: [points] }, this.scene);
      line.color = Color3.FromHexString('#f0c765');
      line.alpha = 0.95;
      line.isPickable = false;
      this.roadCenterlineMeshes.set(segment.id, line);
    }
  }

  private rebuildDebugZones(chunkIds: readonly ChunkDescriptor['id'][]): void {
    if (!this.snapshot) return;
    for (const id of chunkIds) {
      this.zoningDebugMeshes.get(id)?.dispose();
      this.zoningDebugMeshes.delete(id);
      const zoningLines = this.snapshot.zoningCells.filter((cell) => {
        const chunk = worldToChunk(cell.center);
        return cell.terrainSuitable !== false && `chunk-${chunk.x}-${chunk.z}` === id;
      }).map((cell) => {
        const corners = cell.corners.map((corner) => this.toVector(corner, 0.3));
        return [...corners, corners[0]];
      });
      if (zoningLines.length === 0) continue;
      const zones = CreateLineSystem(`debug-zoning-${id}`, { lines: zoningLines }, this.scene);
      zones.color = Color3.FromHexString('#78c0ad');
      zones.alpha = 0.44;
      zones.isPickable = false;
      this.zoningDebugMeshes.set(id, zones);
    }
  }

  private rebuildDebugLots(lots: readonly Lot[]): void {
    for (const chunk of createChunks()) {
      const local = lots.filter((lot) => {
        const owner = worldToChunk(lot.position);
        return owner.x === chunk.x && owner.z === chunk.z;
      });
      const signature = JSON.stringify(local.map((lot) => [lot.id, lot.corners, lot.roadAccess.frontage, lot.buildable]));
      if (this.lotDebugSignatures.get(chunk.id) === signature) continue;
      for (const mesh of this.lotDebugMeshes.get(chunk.id) ?? []) mesh.dispose();
      this.lotDebugMeshes.delete(chunk.id);
      this.lotDebugSignatures.set(chunk.id, signature);
      if (local.length === 0) continue;
      const outlines = CreateLineSystem(`debug-lots-${chunk.id}`, { lines: local.map((lot) =>
        [...lot.corners, lot.corners[0]].map((point) => this.toVector(point, 0.72))) }, this.scene);
      outlines.color = Color3.FromHexString('#f2e6b5');
      outlines.alpha = 0.82;
      outlines.isPickable = false;
      const frontages = CreateLineSystem(`debug-frontages-${chunk.id}`, { lines: local.map((lot) =>
        lot.roadAccess.frontage.map((point) => this.toVector(point, 0.85))) }, this.scene);
      frontages.color = Color3.FromHexString('#f9a45f');
      frontages.alpha = 0.96;
      frontages.isPickable = false;
      this.lotDebugMeshes.set(chunk.id, [outlines, frontages]);
    }
  }

  private disposeDebugGeometry(): void {
    for (const mesh of this.roadCenterlineMeshes.values()) mesh.dispose();
    this.roadCenterlineMeshes.clear();
    for (const mesh of this.zoningDebugMeshes.values()) mesh.dispose();
    this.zoningDebugMeshes.clear();
    for (const meshes of this.lotDebugMeshes.values()) for (const mesh of meshes) mesh.dispose();
    this.lotDebugMeshes.clear();
    this.lotDebugSignatures.clear();
    for (const mesh of this.graphDebugMeshes) {
      mesh.material?.dispose();
      mesh.dispose();
    }
    this.graphDebugMeshes = [];
  }
}
