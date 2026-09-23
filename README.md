# Project Civitas — Lots + Buildings (0.8.0)

[English](#english) | [日本語](#日本語)

## English

Project Civitas is an early prototype of a browser-based 3D city-building simulation. It focuses on roads, terrain, zoning, and the first stage of lot and building growth.

The simulation worker owns the authoritative world state. The Preact interface sends commands, and the Babylon.js renderer displays snapshots from the simulation.

### Features

- Draw roads as straight segments, single curves, S-curves, or continuous circular arcs. Road geometry is stored as polylines, independent of the drawing mode. Small Roads have a minimum curve radius of 24 m.
- Zone road-frontage cells for residential, commercial, industrial, and office use (RCIO). Paint with a brush or a drag-to-select box; zoning edits support undo and redo.
- Edit a 1024 m × 1024 m heightmap with raise, lower, flatten, and smooth terrain tools. Terrain is stored at 4 m spacing, and edits update in 256 m chunks. New roads with grades above 12% are rejected.
- Generate deterministic, road-accessible lots from adjacent cells of the same zone. Supported footprints range from 1×1 to 4×4 cells. Buildings progress through Empty, Planned, Constructing, and Occupied states.
- Save and load the world in the browser with IndexedDB, including terrain, lots, buildings, and construction progress. Save schema v5 migrates saves from versions v1–v4.

### Current scope

This is a prototype. Building assets are placeholder boxes, and population, demand, and economy are not implemented. Traffic, water, bridges, elevated roads, tunnels, and railways are also outside the current scope. Roads follow the terrain surface; cut-and-fill, retaining walls, and automatic grade correction are not implemented.

### Run locally

Requirements: Node.js and npm.

```sh
npm install
npm run dev
```

Production build and unit tests:

```sh
npm run build
npm test
```

To explicitly try WebGL2, add `?renderer=webgl2` to the app URL.

### Controls

- `WASD`: move the camera; `Shift`: move faster
- Mouse wheel: zoom; middle mouse drag: orbit
- Left-click: place a road point or confirm a road deletion
- Right-click: remove the last placed point; if only the start point is set, clear it
- `Escape`: cancel the current road operation
- `Ctrl+Z` / `Ctrl+Y`: undo / redo
- **Straight:** choose a start and end point. After placement, continue from the previous endpoint.
- **1-Curve:** choose a start point, its outgoing direction, and an endpoint. The direction point is not a required waypoint.
- **2-Curve:** choose a start point, its outgoing direction, an approach direction, and an endpoint. Useful for S-shaped connections between offset roads.
- **Continuous:** choose a start point, initial direction, and endpoint. The direction click's distance does not affect the arc. A single arc over 180° is not supported.
- Switch road modes while continuing from the previous endpoint and tangent.
- **ZONING:** choose R, C, I, O, or Erase. Brush paints by clicking or dragging; Box selects cells under the dragged rectangle.
- **TERRAIN:** choose Raise, Lower, Flatten, or Smooth and drag to edit. Moving the pointer without dragging does not change terrain. Right-click or press `Escape` to return to road mode. Size controls brush diameter; Strength controls the edit rate. Flatten moves terrain toward the elevation at the start of the drag.
- **FLAT / HILLS:** apply a terrain test preset without removing roads or zoning.
- Zoning drags form one undoable action and share history with road edits.
- In the **SNAP** palette, toggle node, segment, endpoint extension guide, 15° angle, parallel, perpendicular, and 8 m distance snapping independently.
- Road previews show width, centerline, tangent guides, angle, distance, and whether the placement is valid.

### Architecture and world scale

- `src/simulation`, `src/worker`: authoritative state, game clock, command history, and snapshots
- `src/roads`: road graph, curve geometry, validation, snapping, splitting, intersections, and preview spatial index
- `src/renderer`: Babylon.js terrain, road meshes, previews, debug layer, and camera
- `src/terrain`: heightmap, interpolation, normals, brush edits, and chunk patches
- `src/zoning`: road-relative 8 m cell generation, RCIO zones, and hit testing
- `src/lots`: lot packing, terrain suitability, building definitions, and growth states
- `src/save`: versioned save data, migrations, and IndexedDB storage
- `src/ui`: controls and debug HUD; the UI does not modify world state directly

The map is 1024 m square, divided into sixteen 256 m chunks. One world unit equals one metre. A Small Road is 16 m wide, with two opposing lanes and a 40 km/h speed limit; these values are data definitions.

Roadside zoning cells are spaced 8 m apart. Curves use road-width quadrilaterals to reduce overlap. Cells that intersect roads, intersection clearances, or higher-priority cells are excluded. Cell IDs and center alignment remain stable when a road is split.

## 日本語

ブラウザで動作する3D都市開発シミュレーションの第1弾Prototypeです。Simulation Workerが唯一のWorld Stateを所有し、Preact UIはCommandを送り、Babylon.js RendererはSnapshotだけを描画します。

道路施工には直線・1カーブ・2カーブ・連続カーブがあります。1カーブは始終端の接線を使う三次曲線、2カーブは中央で位置と接線を共有する2本の三次曲線、連続カーブは最初に指定した方向と終点から求める円弧で施工します。確定した線形はモードに依存しないPolylineとしてRoad Graphへ保存します。Small Roadの最小曲率半径は24mです。

道路沿いに生成された8mセルには、RCIO（住宅・商業・工業・オフィス）を塗り分けられます。ZONINGパレットで用途とBRUSH／BOXを選びます。BRUSHはクリック・なぞり塗り、BOXは画面上をドラッグした矩形に重なる区画を一括指定します。消去にも両モードを使え、1回の操作を1つのUndo/Redoとして扱います。

地形はWorkerが正本を持つ4m間隔の257×257 Heightmapです。Y座標はメートル単位の標高で、`getHeight(x,z)`／`getNormal(x,z)` を道路・区画表示と今後のシステムが使います。TERRAINツールではRaise／Lower／Flatten／Smoothをドラッグ操作でき、ブラシ径・強度、Flat／Hillsテスト地形を切り替えられます。1ドラッグが1つのUndo/Redoです。編集時は256mチャンク単位の変更だけをWorkerからRendererへ送り、地形・道路面・RCIO区画表示を追従させます。急勾配（12%超）の新規道路は無効です。区画IDと塗り分けは地形編集だけでは変更されません。

同じRCIOの連続セルから道路に接するLotを決定論的に生成します。対応サイズは1×1、1×2、2×1、2×2、2×3、3×2、3×3、4×4セルです。Lotは標高と傾斜をサンプリングし、急斜面では建物を生成しません。建物DefinitionはSimulation側のデータで、現在のAssetはZoneType別の仮Boxです。建物はGameClockによりEmpty→Planned→Constructing→Occupiedと成長し、人口・需要・経済はまだありません。DebugのLot境界・道路側の辺と、カーソル下LotのID・サイズ・傾斜・建物状態を確認できます。

クイックセーブにはHeightmap・地形設定・Terrain versionに加え、Lot、Building、成長状態・タイマー・Definition参照を含めます。Save schemaはv5で、旧v1～v4セーブは移行時にLotを生成します。ゲーム版数とSave schemaは独立して管理します。交通、経済、水系、橋・高架・トンネル、鉄道はまだ対象外です。

## 起動

```powershell
npm install
npm run dev
```

Production buildとUnit Test:

```powershell
npm run build
npm test
```

## 操作

- `WASD`: カメラ移動
- `Shift`: 高速移動
- マウスホイール: Zoom
- 中ボタンドラッグ: Orbit
- 左クリック: 道路の点を指定／削除対象を確定
- 右クリック: 指定済みの点を1段階戻す／始点だけなら解除
- `Escape`: 現在の施工全体をキャンセル
- `Ctrl+Z` / `Ctrl+Y`: Undo / Redo
- Straight: 始点→終点。確定後は終点から連続施工
- 1-Curve: 始点→始点側の方向→終点。2回目のクリック位置は必須通過点ではありません
- 2-Curve: 始点→始点側の方向→終点側の進入方向→終点。平行にずれた道路のS字接続に使用します
- Continuous: 始点→初期方向→終点。方向クリックの距離は曲線形状に影響しません。180°を超える単一円弧は施工できません
- 各モードを切り替えても、前の道路終端と接線方向を引き継いで連続施工できます
- ZONING: R／C／I／OまたはEraseを選択。BRUSHはクリック／なぞり塗り、BOXはドラッグした矩形に重なる区画を一括指定
- TERRAIN: Raise／Lower／Flatten／Smoothを選んで左ドラッグで編集。マウス移動だけでは編集しません。右クリック（またはEscape）で道路モードへ戻ります。SIZEはブラシ直径、STRENGTHは変化速度。Flattenはドラッグ開始点の標高に近づけます
- FLAT／HILLS: 地形テストプリセットを適用。既存の道路・区画は消えません
- ゾーニングのドラッグ操作は1回でUndo/Redo可能。道路のUndo/Redoとも同じ履歴順序で扱います
- SNAP palette: Node／Segment／終端延長Guide／15°／Parallel／Perpendicular／8m距離の各Snapを個別切替
- 作図中は道路幅、破線Centerline、接線Guide、角度、距離、Valid/Invalidを表示します
- `?renderer=webgl2` を付けるとWebGL2を明示的に試せます

## 主な境界

- `src/simulation`, `src/worker`: Authority、GameClock、Command履歴、Snapshot
- `src/roads`: Road Graph、曲線と円弧の線形生成、曲率検証、Snap／Split／Intersection、施工入力、Preview空間Index
- `src/renderer`: Babylon.js Terrain、Road Mesh、Preview、Debug layer、Camera
- `src/terrain`: Authority用Heightmap、補間・法線・ブラシ編集・チャンクパッチ
- `src/zoning`: Road local座標系の8mセル候補、RCIO用途と塗り対象Hit Test
- `src/lots`: Lotパッキング、Terrain適合性、建物Definitionと成長状態
- `src/save`: version付きDTO、v1～v4→v5 migration、IndexedDB quick save
- `src/ui`: World Stateを直接変更しない操作UI／Debug HUD

Mapは1024m四方、Chunkは256m四方の4×4、1 world unit = 1mです。Small Roadは幅16m、対面2車線、速度上限40km/h、最小曲率半径24m、ゾーニング可能としてデータ定義されています。

現段階の道路は地形表面に沿う単純なRoad Meshで、切土・盛土や擁壁はありません。既設道路と路肩のHeightmapはTerrainブラシから保護されます。道路施工後の勾配再評価・自動補修は行いません。

ゾーニング候補は道路に沿った8m間隔で生成します。曲線の内側では幅を道路に合わせた四辺形セルを使い、セル同士の重複を抑えます。道路面、交差点クリアランス、または優先度の高いセルと重なる候補は除外します。道路が任意位置で分割されても、元のroad lineageに対する `4m + 8m × n` の中心位相とCell IDを維持します。
