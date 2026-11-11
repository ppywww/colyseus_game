/**
 * 厨房地图（80×80m，鼠猫尺度）的几何构建。
 *
 * 数据流：所有实心体块来自 `@colyseus-fps-shared` 的 `OBSTACLES`（50 段墙 + 12 栋建筑 +
 * 35 个掩体，全 AABB），客户端渲染、客户端物理（MTA 推出）与服务端弹道遮挡共用同一份数据，
 * 保证「所见即所挡」。
 *
 * **为什么只换皮、不换拓扑**：这张图的三条进攻轴（台面长台 / 中央地砖 / 桌下通道）与两个
 * 包点（灶台 / 水槽）是经过 0.5m 栅格洪泛验证的——每一块空地都可达、每条枪线长度都算过、
 * 10 个出生点都不与体块重叠。重画拓扑等于把这三类验证全部推倒重来，收益只是"看起来更像
 * 厨房"，而换材质 + 加道具同样能做到"一眼是厨房"，风险却为零。
 *
 * 性能约定（97 个体块不能变成 97 次 draw call）：
 *   - 每种 `type` 只用一个共享 `Material`，同类体块用 `InstancedMesh` 批量绘制；
 *   - 按「高度 ≥ 1.4m」再拆成投射阴影 / 不投射阴影两组（小箱子不投影，省一半 shadow pass）；
 *   - 地砖、橱柜、木箱、大理石台面全部用 `CanvasTexture` 程序化生成，零外部资源。
 */

import * as THREE from "three";

import { MAP_SIZE, OBSTACLES, obstacleColliders, type ObstacleKind, type ObstacleSpec } from "@colyseus-fps/shared";

/** 重新导出，保持既有调用方（Game / 物理）不变。 */
export { obstacleColliders };

/**
 * 厨房配色。
 *
 * 明度关系是这张图的"可玩性"基础：地面最亮（米白瓷砖）、橱柜中调（蜂蜜木）、
 * 台面最亮（大理石）、踢脚线最暗。玩家在 30m 外仍能靠明度差读出"哪是地、哪是墙"，
 * 不需要依赖贴图细节。
 */
const PALETTE = {
  tileLight: "#fff6e4",
  tileDark: "#dcc9a8",
  tileGrout: "#b8a184",
  tileScuff: 0xb09b7c,
  cabinet: "#e2bc86",
  cabinetGroove: "#b98d5c",
  cabinetTop: 0xf2eadf,
  marble: 0xf4ede2,
  crate: "#c98a4e",
  crateLine: "#8d5a28",
  steel: 0x8d97a3,
  ceramic: 0xf7ede0,
  terracotta: 0xc4703f,
  leaf: 0x6fa34d,
  cheese: 0xffc63d,
  tomato: 0xe8432f,
  milk: 0xfdfaf2,
  sky: 0xf6e3c4,
  fog: 0xefd9b8,
} as const;

/** 相机背景色（厨房的暖色墙）。 */
export const ARENA_SKY_COLOR = PALETTE.sky;

/** 场景雾色与近远平面距离（视模型最远 0.97m，完全不受雾影响）。 */
export const ARENA_FOG = { color: PALETTE.fog, near: 46, far: 150 } as const;

/** 只有高度 ≥ 该值的物件才投射阴影（小箱子投影收益极低，却要跑一遍 shadow pass）。 */
const SHADOW_MIN_HEIGHT = 1.4;

/**
 * 天花板高度。
 *
 * 取 8.5m 而不是"贴墙 3–5m"：这张图有 12 栋 4–6m 的"建筑"（高柜/冰箱），
 * 天花板压到墙顶高度就会把它们的顶盖切掉，玩家会看到盒子顶面"开口"。
 * 8.5m 是能盖住全部体块、又让镜头抬头还留有压迫感的值。
 */
const CEILING_HEIGHT = 8.5;

/* ------------------------------------------------------------------ *
 * 程序化贴图（CanvasTexture，逻辑与 effects.ts 的 radialTexture 同构）
 * ------------------------------------------------------------------ */

function createCanvas(size: number): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D } | null {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  return context === null ? null : { canvas, context };
}

function finishTexture(canvas: HTMLCanvasElement): THREE.Texture {
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  // repeat 保持 1：真正的平铺密度由 `useWorldUv` 按世界坐标算（下面会解释为什么）
  texture.repeat.set(1, 1);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

/**
 * 让贴图按**世界尺度**平铺，而不是按 UV 在 0–1 之间拉伸。
 *
 * 为什么必须这么做：橱柜墙体和木箱都画在 InstancedMesh 里——**同一份单位立方体几何**
 * 被缩放到 3m 和 30m 两种尺寸。UV 0–1 意味着 30m 的墙上只贴一张门板贴图，
 * 每个"柜门"有 15 米宽，一眼就穿帮（第一版截图里整面墙就是一片木纹）。
 *
 * 解决方案是盒子投影（box projection）：所有体块都是轴对齐矩形，法线只朝 ±X/±Y/±Z，
 * 所以按主轴直接取世界坐标的两个分量做 UV，密度处处 1:1，且仍然只有一个材质、
 * 一次 draw call。比"给每种尺寸克隆一份材质"省得多，也比逐实例传 UV 缩放简单。
 *
 * @param metersPerTile 一个贴图周期对应多少米
 */
function useWorldUv(material: THREE.MeshStandardMaterial, metersPerTile: number): void {
  const scale: number = 1 / metersPerTile;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uUvScale = { value: scale };
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nvarying vec3 vArenaPos;\nvarying vec3 vArenaNormal;",
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        vec4 arenaPos = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          arenaPos = instanceMatrix * arenaPos;
        #endif
        arenaPos = modelMatrix * arenaPos;
        vArenaPos = arenaPos.xyz;
        // 必须过一遍 modelMatrix 的旋转：地面是 PlaneGeometry 转了 −90°，
        // 它的 objectNormal 还是 (0,0,1)，直接用会把"朝上"判定成"朝前"，地砖就贴没了
        vArenaNormal = normalize(mat3(modelMatrix) * objectNormal);`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\nvarying vec3 vArenaPos;\nvarying vec3 vArenaNormal;\nuniform float uUvScale;",
      )
      .replace(
        "#include <map_fragment>",
        `#ifdef USE_MAP
          vec3 arenaAxis = abs(normalize(vArenaNormal));
          vec2 arenaUv = arenaAxis.y > 0.5
            ? vArenaPos.xz
            : (arenaAxis.x > 0.5 ? vArenaPos.zy : vArenaPos.xy);
          diffuseColor *= texture2D(map, arenaUv * uUvScale);
        #endif`,
      );
  };
  // 用了自定义 shader 片段就必须给一个稳定的缓存键，否则 three 会把两套程序混用
  material.customProgramCacheKey = () => `arena-world-uv-${scale}`;
}

/**
 * 地砖：2×2 的棋盘格 + 砖缝 + 若干磨痕。
 *
 * 棋盘格是"厨房"最强的一张底牌——比任何贴图细节都便宜、都管得远。
 * 砖缝画成 3px 的深色十字，是因为远景下砖缝才是"尺度参照"：
 * 有了 1.7m 一格的方格，玩家才能一眼看出台面长台有 9 米宽。
 */
function tileTexture(): THREE.Texture | null {
  const created = createCanvas(256);
  if (created === null) {
    return null;
  }
  const { canvas, context } = created;
  const half = 128;

  for (let ty = 0; ty < 2; ty += 1) {
    for (let tx = 0; tx < 2; tx += 1) {
      const even = (tx + ty) % 2 === 0;
      context.fillStyle = even ? PALETTE.tileLight : PALETTE.tileDark;
      context.fillRect(tx * half, ty * half, half, half);
      // 每块砖内部再画一圈浅色倒角，砖才有厚度而不是色块
      context.strokeStyle = even ? "rgba(255,255,255,0.55)" : "rgba(255,246,228,0.35)";
      context.lineWidth = 3;
      context.strokeRect(tx * half + 5, ty * half + 5, half - 10, half - 10);
    }
  }

  // 砖缝
  context.strokeStyle = PALETTE.tileGrout;
  context.lineWidth = 4;
  for (let i = 0; i <= 2; i += 1) {
    const p = Math.min(255, i * half);
    context.beginPath();
    context.moveTo(p, 0);
    context.lineTo(p, 256);
    context.stroke();
    context.beginPath();
    context.moveTo(0, p);
    context.lineTo(256, p);
    context.stroke();
  }

  // 磨痕与油渍：没有这一层，整片地砖会像"刚铺完的效果图"
  for (let i = 0; i < 26; i += 1) {
    context.fillStyle = "rgba(176,155,124,0.14)";
    const size = 6 + Math.random() * 26;
    context.beginPath();
    context.ellipse(Math.random() * 256, Math.random() * 256, size, size * 0.6, Math.random() * Math.PI, 0, Math.PI * 2);
    context.fill();
  }

  return finishTexture(canvas);
}

/** 橱柜门板：蜂蜜木底 + 竖向门缝 + 一圈凹槽（隔 64px 一道门）。 */
function cabinetTexture(): THREE.Texture | null {
  const created = createCanvas(256);
  if (created === null) {
    return null;
  }
  const { canvas, context } = created;
  context.fillStyle = PALETTE.cabinet;
  context.fillRect(0, 0, 256, 256);

  // 木纹（横向细线）
  for (let i = 0; i < 40; i += 1) {
    context.fillStyle = "rgba(180,118,58,0.18)";
    context.fillRect(0, Math.random() * 256, 256, 1 + Math.random() * 2);
  }

  // 门板：每格 128 宽，画内凹装饰线
  context.strokeStyle = PALETTE.cabinetGroove;
  context.lineWidth = 3;
  for (let x = 0; x < 256; x += 128) {
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, 256);
    context.stroke();
    context.strokeRect(x + 14, 16, 100, 224);
  }
  // 每个门板一颗拉手
  context.fillStyle = "#f2d9a8";
  for (let x = 0; x < 256; x += 128) {
    context.beginPath();
    context.arc(x + 108, 128, 5, 0, Math.PI * 2);
    context.fill();
    context.strokeStyle = "#8d5a28";
    context.lineWidth = 2;
    context.stroke();
  }

  return finishTexture(canvas);
}

/**
 * 墙面小白砖（subway tile）：白底 + 错缝横向长条 + 细灰缝。
 *
 * 为什么不用地面那张棋盘贴图凑合：棋盘格是 50% 明暗交替，贴到 6m 高的立柱上
 * 会变成一面**黑白棋盘**，读起来像国际象棋盘而不是瓷砖。小白砖靠细缝分隔，
 * 远看是"整体发白的一段墙"，正好和蜂蜜木柜体拉开明度差。
 */
function wallTileTexture(): THREE.Texture | null {
  const created = createCanvas(256);
  if (created === null) {
    return null;
  }
  const { canvas, context } = created;
  const rowHeight = 64;
  const brickWidth = 128;

  context.fillStyle = "#f4efe2";
  context.fillRect(0, 0, 256, 256);

  // 错缝：奇数行整体右移半个砖宽
  for (let row = 0; row < 4; row += 1) {
    const offset = row % 2 === 0 ? 0 : brickWidth / 2;
    for (let column = -1; column < 3; column += 1) {
      const x = column * brickWidth + offset + 3;
      const y = row * rowHeight + 3;
      context.fillStyle = "#fbf7ee";
      context.fillRect(x, y, brickWidth - 6, rowHeight - 6);
      // 砖面上沿一道极浅的高光，砖才有釉面的厚度
      context.fillStyle = "rgba(255,255,255,0.75)";
      context.fillRect(x, y, brickWidth - 6, 2);
    }
  }

  // 灰缝
  context.strokeStyle = "rgba(190,178,156,0.55)";
  context.lineWidth = 3;
  for (let row = 0; row <= 4; row += 1) {
    context.beginPath();
    context.moveTo(0, row * rowHeight);
    context.lineTo(256, row * rowHeight);
    context.stroke();
  }

  return finishTexture(canvas);
}

/** 木箱：竖向木纹 + 铁皮包角（厨房里的储物箱）。 */
function crateTexture(): THREE.Texture | null {
  const created = createCanvas(256);
  if (created === null) {
    return null;
  }
  const { canvas, context } = created;
  context.fillStyle = PALETTE.crate;
  context.fillRect(0, 0, 256, 256);

  context.fillStyle = PALETTE.crateLine;
  for (let i = 0; i < 12; i += 1) {
    context.fillRect((i / 12) * 256 + Math.random() * 4, 0, 3, 256);
  }
  // 边框条
  context.fillStyle = "rgba(141,90,40,0.75)";
  context.fillRect(0, 0, 256, 14);
  context.fillRect(0, 242, 256, 14);
  context.fillRect(0, 0, 14, 256);
  context.fillRect(242, 0, 14, 256);

  return finishTexture(canvas);
}

/* ------------------------------------------------------------------ *
 * 共享材质（模块级单例：重新进房时复用，不会重复创建贴图）
 * ------------------------------------------------------------------ */

interface ArenaMaterials {
  tile: THREE.MeshStandardMaterial;
  cabinet: THREE.MeshStandardMaterial;
  marble: THREE.MeshStandardMaterial;
  crate: THREE.MeshStandardMaterial;
  /** 瓷砖墙（高柜/冰箱这一类"白瓷砖立柱"），与地面共用一张贴图但密度更细。 */
  wallTile: THREE.MeshStandardMaterial;
  steel: THREE.MeshStandardMaterial;
  ceramic: THREE.MeshStandardMaterial;
  terracotta: THREE.MeshStandardMaterial;
  leaf: THREE.MeshStandardMaterial;
  cheese: THREE.MeshStandardMaterial;
  tomato: THREE.MeshStandardMaterial;
  milk: THREE.MeshStandardMaterial;
  scuff: THREE.MeshBasicMaterial;
}

let cachedMaterials: ArenaMaterials | null = null;

function arenaMaterials(): ArenaMaterials {
  if (cachedMaterials !== null) {
    return cachedMaterials;
  }

  const tile = tileTexture();
  const cabinet = cabinetTexture();
  const crate = crateTexture();
  const matte = (color: number, roughness = 0.86): THREE.MeshStandardMaterial =>
    new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.02 });

  // 三张程序化贴图全部按世界尺度平铺：地砖一格 0.85m、柜门一块 0.85m、木箱 0.9m
  const tileMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, map: tile, roughness: 0.55, metalness: 0.02 });
  const cabinetMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, map: cabinet, roughness: 0.72, metalness: 0.03 });
  const crateMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, map: crate, roughness: 0.78, metalness: 0.02 });
  // 白瓷砖立柱：和地面同一张棋盘贴图，但密度翻三倍（0.28m 一格），近看才有"墙砖"的小格子
  const wallTileMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: wallTileTexture(),
    roughness: 0.42,
    metalness: 0.02,
  });
  useWorldUv(tileMaterial, 1.7);
  useWorldUv(cabinetMaterial, 1.7);
  useWorldUv(crateMaterial, 0.9);
  useWorldUv(wallTileMaterial, 1.1);

  cachedMaterials = {
    tile: tileMaterial,
    cabinet: cabinetMaterial,
    // 大理石台面：粗糙度低一点才有"抛光"的读感，但不能低到像塑料
    marble: new THREE.MeshStandardMaterial({ color: PALETTE.marble, roughness: 0.34, metalness: 0.04 }),
    crate: crateMaterial,
    wallTile: wallTileMaterial,
    steel: new THREE.MeshStandardMaterial({ color: PALETTE.steel, roughness: 0.3, metalness: 0.7 }),
    ceramic: new THREE.MeshStandardMaterial({ color: PALETTE.ceramic, roughness: 0.24, metalness: 0.02 }),
    terracotta: matte(PALETTE.terracotta, 0.92),
    leaf: new THREE.MeshStandardMaterial({ color: PALETTE.leaf, roughness: 0.85, metalness: 0, side: THREE.DoubleSide }),
    cheese: matte(PALETTE.cheese, 0.6),
    tomato: matte(PALETTE.tomato, 0.55),
    milk: matte(PALETTE.milk, 0.35),
    scuff: new THREE.MeshBasicMaterial({ color: PALETTE.tileScuff, transparent: true, opacity: 0.2, depthWrite: false }),
  };

  return cachedMaterials;
}

/* ------------------------------------------------------------------ *
 * 通用实例化辅助
 * ------------------------------------------------------------------ */

type InstancePlacer = (
  spec: ObstacleSpec,
  position: THREE.Vector3,
  quaternion: THREE.Quaternion,
  scale: THREE.Vector3,
) => void;

/**
 * 把一批同材质体块画成 InstancedMesh：按「高度 ≥ 1.4m」拆成投影 / 不投影两组。
 * 同类物件共享同一份 geometry 与 material，因此 draw call 与数量无关。
 */
function addInstances(
  root: THREE.Group,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  specs: readonly ObstacleSpec[],
  place: InstancePlacer,
): void {
  const groups: Array<{ specs: ObstacleSpec[]; castsShadow: boolean }> = [
    { specs: specs.filter((spec) => spec.height >= SHADOW_MIN_HEIGHT), castsShadow: true },
    { specs: specs.filter((spec) => spec.height < SHADOW_MIN_HEIGHT), castsShadow: false },
  ];

  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3(1, 1, 1);
  const matrix = new THREE.Matrix4();

  for (const group of groups) {
    if (group.specs.length === 0) {
      continue;
    }
    const mesh = new THREE.InstancedMesh(geometry, material, group.specs.length);
    group.specs.forEach((spec, index) => {
      position.set(0, 0, 0);
      quaternion.identity();
      scale.set(1, 1, 1);
      place(spec, position, quaternion, scale);
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(index, matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = group.castsShadow;
    mesh.receiveShadow = group.castsShadow;
    root.add(mesh);
  }
}

/** 以 AABB 尺寸放置一个单位立方 / 单位圆柱（几何体底面在 y=0，故中心抬到 height/2）。 */
function placeAabb(spec: ObstacleSpec, position: THREE.Vector3, _quaternion: THREE.Quaternion, scale: THREE.Vector3): void {
  position.set(spec.x, spec.height / 2, spec.z);
  scale.set(spec.width, spec.height, spec.depth);
}

function specsOfType(type: ObstacleKind): ObstacleSpec[] {
  return OBSTACLES.filter((obstacle) => obstacle.type === type);
}

/* ------------------------------------------------------------------ *
 * 装饰件（全部只做视觉，不写进 OBSTACLES、不参与碰撞）
 * ------------------------------------------------------------------ */

/** 地面油渍：6–8 片半透明浅棕圆，制造使用痕迹（单个 InstancedMesh）。 */
function addFloorScuffs(root: THREE.Group): void {
  const count = 9;
  const geometry = new THREE.CircleGeometry(1, 20);
  const mesh = new THREE.InstancedMesh(geometry, arenaMaterials().scuff, count);
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();

  for (let i = 0; i < count; i += 1) {
    const radius = 1.6 + Math.random() * 2.6;
    position.set((Math.random() - 0.5) * 62, 0.012 + i * 0.0008, (Math.random() - 0.5) * 62);
    scale.set(radius, radius * (0.7 + Math.random() * 0.5), 1);
    matrix.compose(position, quaternion, scale);
    mesh.setMatrixAt(i, matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.receiveShadow = false;
  root.add(mesh);
}

/**
 * 大理石台面压顶 + 踢脚线。
 *
 * 这两条线是"室内感"的骨架：台面压顶让柜体有厚度（不再是一面墙），
 * 踢脚线把墙和地"焊"在一起（没有它，墙像是插在地板上的）。
 * 两者都只比碰撞体大 4cm，视觉上贴合，完全不改玩法的可站面积。
 */
function addKitchenTrim(root: THREE.Group): void {
  const materials = arenaMaterials();
  const cabinets = OBSTACLES.filter(
    (obstacle) => (obstacle.type === "wall" || obstacle.type === "building") && obstacle.height >= SHADOW_MIN_HEIGHT,
  );
  const geometry = new THREE.BoxGeometry(1, 1, 1);

  // 台面压顶：厚度 0.08、外扩 6cm（像真的台面探出柜体）
  addInstances(root, geometry, materials.marble, cabinets, (spec, position, _quaternion, scale) => {
    position.set(spec.x, spec.height + 0.04, spec.z);
    scale.set(spec.width + 0.06, 0.08, spec.depth + 0.06);
  });

  // 踢脚线：高 0.14，外扩 2cm
  addInstances(root, geometry, materials.cabinet, cabinets, (spec, position, _quaternion, scale) => {
    position.set(spec.x, 0.07, spec.z);
    scale.set(spec.width + 0.04, 0.14, spec.depth + 0.04);
  });
}

/**
 * 箱顶摆件：奶酪楔 / 盘子 / 番茄 / 牛奶瓶。
 *
 * 为什么只放在**箱子**顶上：箱子是 1.1–1.6m 的矮掩体，玩家跳上去、蹲在后面，
 * 顶上放东西既合理（厨房里就是随手一放），又能给"这块能跳"一个视觉暗示。
 * 四类物件按箱子序号轮换，只用 4 个 InstancedMesh（4 次 draw call）。
 */
function addCounterProps(root: THREE.Group, crates: readonly ObstacleSpec[]): void {
  if (crates.length === 0) {
    return;
  }
  const materials = arenaMaterials();
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3(1, 1, 1);
  const euler = new THREE.Euler();

  const buckets: Array<{ geometry: THREE.BufferGeometry; material: THREE.Material; specs: ObstacleSpec[]; y: number }> = [
    // 奶酪楔：三棱柱（ConeGeometry 3 边）躺倒
    { geometry: new THREE.ConeGeometry(0.17, 0.13, 3), material: materials.cheese, specs: [], y: 0.2 },
    // 盘子
    { geometry: new THREE.CylinderGeometry(0.16, 0.14, 0.026, 16), material: materials.ceramic, specs: [], y: 0.013 },
    // 番茄
    { geometry: new THREE.SphereGeometry(0.085, 12, 10), material: materials.tomato, specs: [], y: 0.085 },
    // 牛奶瓶
    { geometry: new THREE.CylinderGeometry(0.058, 0.07, 0.25, 12), material: materials.milk, specs: [], y: 0.125 },
  ];
  crates.forEach((crate, index) => {
    (buckets[index % buckets.length] as (typeof buckets)[number]).specs.push(crate);
  });

  for (const bucket of buckets) {
    if (bucket.specs.length === 0) {
      continue;
    }
    const mesh = new THREE.InstancedMesh(bucket.geometry, bucket.material, bucket.specs.length);
    bucket.specs.forEach((crate, index) => {
      // 摆在箱顶靠里一点，且每件略有偏差（整齐排列会像棋盘而不是厨房）
      const offsetX = (Math.random() - 0.5) * (crate.width * 0.4);
      const offsetZ = (Math.random() - 0.5) * (crate.depth * 0.4);
      position.set(crate.x + offsetX, crate.height + bucket.y, crate.z + offsetZ);
      euler.set(0, Math.random() * Math.PI * 2, 0);
      quaternion.setFromEuler(euler);
      if (bucket.material === materials.cheese) {
        // 三棱柱躺倒才是"楔形奶酪"，立着是根柱子
        euler.set(Math.PI / 2, 0, Math.random() * Math.PI);
        quaternion.setFromEuler(euler);
      }
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(index, matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = true;
    root.add(mesh);
  }
}

/**
 * 盆栽香草（替换原来的棕榈树）。
 *
 * 陶盆 + 6 片放射状叶片：在厨房里这是窗台上的那盆罗勒/迷迭香，
 * 在玩法上它仍然是"占一个 0.6m 见方的掩体"——视觉换了，碰撞体一个都没动。
 */
function addHerbPots(root: THREE.Group, pots: readonly ObstacleSpec[]): void {
  if (pots.length === 0) {
    return;
  }
  const materials = arenaMaterials();
  const potGeometry = new THREE.CylinderGeometry(0.34, 0.26, 0.6, 12);
  addInstances(root, potGeometry, materials.terracotta, pots, (spec, position, _quaternion, scale) => {
    position.set(spec.x, 0.3, spec.z);
    scale.set(spec.width / 0.6, 0.5, spec.depth / 0.6);
  });

  const leavesPerPot = 7;
  const leafGeometry = new THREE.BoxGeometry(0.1, 0.02, 0.9);
  const leaves = new THREE.InstancedMesh(leafGeometry, materials.leaf, pots.length * leavesPerPot);
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3(1, 1, 1);
  const euler = new THREE.Euler();
  const quaternion = new THREE.Quaternion();

  pots.forEach((pot, potIndex) => {
    for (let i = 0; i < leavesPerPot; i += 1) {
      const angle = (i / leavesPerPot) * Math.PI * 2 + potIndex * 0.5;
      const tilt = (28 + Math.random() * 26) * (Math.PI / 180);
      position.set(
        pot.x + Math.cos(angle) * 0.3,
        0.56 + Math.random() * 0.12,
        pot.z + Math.sin(angle) * 0.3,
      );
      euler.set(tilt, Math.PI / 2 - angle, 0, "YXZ");
      quaternion.setFromEuler(euler);
      matrix.compose(position, quaternion, scale);
      leaves.setMatrixAt(potIndex * leavesPerPot + i, matrix);
    }
  });
  leaves.instanceMatrix.needsUpdate = true;
  leaves.castShadow = true;
  root.add(leaves);
}

/** 手推餐车（原"市集推车"）：不锈钢车体 + 两只轮 + 上层托盘。 */
function addTrolleys(root: THREE.Group, carts: readonly ObstacleSpec[]): void {
  if (carts.length === 0) {
    return;
  }
  const materials = arenaMaterials();

  const wheelGeometry = new THREE.CylinderGeometry(0.34, 0.34, 0.08, 14);
  const wheelQuaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
  const wheels = new THREE.InstancedMesh(wheelGeometry, materials.steel, carts.length * 2);
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3(1, 1, 1);
  carts.forEach((cart, index) => {
    const axleX = cart.x - cart.width * 0.28;
    const halfDepth = Math.max(cart.depth / 2 - 0.02, 0.15);
    for (let side = 0; side < 2; side += 1) {
      position.set(axleX, 0.34, cart.z + (side === 0 ? -halfDepth : halfDepth));
      matrix.compose(position, wheelQuaternion, scale);
      wheels.setMatrixAt(index * 2 + side, matrix);
    }
  });
  wheels.instanceMatrix.needsUpdate = true;
  wheels.castShadow = true;
  root.add(wheels);

  // 上层托盘：比车体小一圈，读作"推车上那块不锈钢板"
  const trayGeometry = new THREE.BoxGeometry(1, 1, 1);
  addInstances(root, trayGeometry, materials.ceramic, carts, (cart, pos, quat, scl) => {
    pos.set(cart.x, cart.height - 0.04, cart.z);
    scl.set(cart.width + 0.16, 0.06, cart.depth + 0.14);
    quat.identity();
  });
}

/* ------------------------------------------------------------------ *
 * 主入口
 * ------------------------------------------------------------------ */

/** 构建厨房场景，返回可加入 scene 的根节点（含地面、体块、装饰与灯光）。 */
export function buildArena(): THREE.Group {
  const root = new THREE.Group();
  root.name = "arena";
  const materials = arenaMaterials();

  // ---- 地面：一整块 80×80 瓷砖（repeat 24 ≈ 每 3.3m 一个纹理周期 = 4 块 0.83m 砖） ----
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(MAP_SIZE, MAP_SIZE), materials.tile);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  root.add(floor);

  // ---- 天花板：只是"封顶"，不参与任何玩法 ----
  // 没有它，镜头往上一抬就是一片纯色天空——玩家会觉得这是室外靶场而不是厨房。
  // 用不受光材质是故意的：天花板在 8.5m 高，主光从上方打下来，按物理算它应该是全黑的
  // （所以这里显式不许它投影），而在真实厨房里天花板是被漫反射照亮的顶面。
  const ceiling = new THREE.Mesh(
    new THREE.PlaneGeometry(MAP_SIZE, MAP_SIZE),
    new THREE.MeshBasicMaterial({ color: 0xf3e4c8 }),
  );
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = CEILING_HEIGHT;
  ceiling.castShadow = false;
  ceiling.receiveShadow = false;
  root.add(ceiling);

  addFloorScuffs(root);

  // ---- 体块：按 type 分派，每种只画 1–2 次 ----
  const boxGeometry = new THREE.BoxGeometry(1, 1, 1);

  // 橱柜墙体（外墙、隔断、矮柜）
  addInstances(root, boxGeometry, materials.cabinet, specsOfType("wall"), placeAabb);
  // 大件家电/高柜（12 栋建筑）：换成白瓷砖——整张图如果全是木纹，
  // 30m 外根本分不清"这是哪堵墙"，白色立柱是玩家判断位置的第二个锚点
  addInstances(root, boxGeometry, materials.wallTile, specsOfType("building"), placeAabb);
  // 储物木箱
  const crates = specsOfType("crate");
  addInstances(root, boxGeometry, materials.crate, crates, placeAabb);
  // 石台（拱柱位置：改成切菜案台）
  addInstances(root, boxGeometry, materials.marble, specsOfType("arch"), placeAabb);
  // 餐车车体
  const carts = specsOfType("cart");
  addInstances(root, boxGeometry, materials.steel, carts, placeAabb);
  // 陶罐（替代油桶）：圆柱，两种色交替，仍只占 2 次 draw call
  const jars = specsOfType("barrel");
  addInstances(
    root,
    new THREE.CylinderGeometry(0.5, 0.48, 1, 14),
    materials.terracotta,
    jars.filter((_spec, index) => index % 2 === 0),
    placeAabb,
  );
  addInstances(
    root,
    new THREE.CylinderGeometry(0.5, 0.46, 1, 14),
    materials.ceramic,
    jars.filter((_spec, index) => index % 2 === 1),
    placeAabb,
  );

  // ---- 装饰件（全部无碰撞）----
  addKitchenTrim(root);
  addCounterProps(root, crates);
  addHerbPots(root, specsOfType("palm"));
  addTrolleys(root, carts);

  // ---- 灯光：室内暖光（顶部主灯 + 环境反弹）----
  // 比沙漠版更低的天光强度、更高的环境色温：厨房是"白炽灯下"而不是"正午太阳下"，
  // 阴影因此更软、色温更暖，和 UI 的奶油纸是同一个色系。
  const hemisphere = new THREE.HemisphereLight(0xfff4e0, 0xc2a281, 1.25);
  root.add(hemisphere);

  const sun = new THREE.DirectionalLight(0xfff1d6, 1.45);
  sun.position.set(46, 66, 34);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -46;
  sun.shadow.camera.right = 46;
  sun.shadow.camera.top = 46;
  sun.shadow.camera.bottom = -46;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 200;
  sun.shadow.bias = -0.0006;
  root.add(sun);
  root.add(sun.target);

  // 补光：从西侧打一盏弱暖光，避免背光面死黑（室内有墙反弹，不该出现纯黑块）
  const fill = new THREE.DirectionalLight(0xffd9a8, 0.35);
  fill.position.set(-40, 30, -30);
  root.add(fill);

  return root;
}
