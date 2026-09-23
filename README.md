# Project Civitas — Lots + Buildings (0.8.0)

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
