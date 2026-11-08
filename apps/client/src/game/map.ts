/**
 * 沙漠迷城地图（Dust II 风格城镇）的几何构建。
 *
 * 数据流：所有实心体块来自 `@colyseus-fps/shared` 的 `OBSTACLES`（25 段墙 + 39 个掩体，全 AABB），
 * 客户端渲染、客户端物理（MTA 推出）与服务端弹道遮挡共用同一份数据，保证「所见即所挡」。
 *
 * 性能约定（64 个体块不能变成 64 次 draw call）：
 *   - 每种 `type` 只用一个共享 `Material`，同类体块用 `InstancedMesh` 批量绘制；
 *   - 按「高度 ≥ 1.4m」再拆成投射阴影 / 不投射阴影两组（小箱子不投影，省一半 shadow pass）；
 *   - 不使用 `EdgesGeometry` 描边（旧版的蓝色描边是赛博风，与沙漠不符，且会让 draw call 翻倍）；
 *   - 地面沙地、土墙夯土层、木箱木纹全部用 `CanvasTexture` 程序化生成，不引入任何外部资源。
 */

import * as THREE from "three";

import { MAP_SIZE, OBSTACLES, obstacleColliders, type ObstacleKind, type ObstacleSpec } from "@colyseus-fps/shared";

/** 重新导出，保持既有调用方（Game / 物理）不变。 */
export { obstacleColliders };

/** 沙漠配色（docs/参考-CS2视觉与地图.md 3.8.1）。 */
const PALETTE = {
  sand: "#d9be8a",
  sandDark: "#c7a972",
  sandLight: "#e4cc9c",
  sandPatch: 0xc7a972,
  wall: "#c39a63",
  wallLine: "#a9814c",
  wallTop: 0xb0864f,
  wood: "#a9713a",
  woodLine: "#7c4e22",
  stone: 0xcda976,
  cartCloth: 0xb4372c,
  wheel: 0x5a3a1e,
  barrelRust: 0xb4703a,
  barrelArmy: 0x6b7a5a,
  palmTrunk: 0x7a5c3a,
  palmLeaf: 0x4e7a3c,
  graffiti: 0xc0392b,
  sky: 0xf2d9a8,
  fog: 0xe8c89a,
} as const;

/** 相机背景色（天空）。 */
export const ARENA_SKY_COLOR = PALETTE.sky;

/** 场景雾色与近远平面距离（视模型最远 0.97m，完全不受雾影响）。 */
export const ARENA_FOG = { color: PALETTE.fog, near: 40, far: 120 } as const;

/** 只有高度 ≥ 该值的物件才投射阴影（小箱子投影收益极低，却要跑一遍 shadow pass）。 */
const SHADOW_MIN_HEIGHT = 1.4;

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

function finishTexture(canvas: HTMLCanvasElement, repeat: number): THREE.Texture {
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeat, repeat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/** 沙地：底色 + 400 个 1–3px 噪点 + 20 条细横纹（风蚀痕）。 */
function sandTexture(): THREE.Texture | null {
  const created = createCanvas(256);
  if (created === null) {
    return null;
  }
  const { canvas, context } = created;
  context.fillStyle = PALETTE.sand;
  context.fillRect(0, 0, 256, 256);

  for (let i = 0; i < 400; i += 1) {
    context.fillStyle = i % 2 === 0 ? PALETTE.sandDark : PALETTE.sandLight;
    const size = 1 + Math.random() * 2;
    context.fillRect(Math.random() * 256, Math.random() * 256, size, size);
  }

  context.strokeStyle = "rgba(199,169,114,0.45)";
  context.lineWidth = 0.5;
  for (let i = 0; i < 20; i += 1) {
    const y = Math.random() * 256;
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(256, y + (Math.random() - 0.5) * 6);
    context.stroke();
  }

  return finishTexture(canvas, 24);
}

/** 土墙：夯土层横线 + 噪点。 */
function mudWallTexture(): THREE.Texture | null {
  const created = createCanvas(256);
  if (created === null) {
    return null;
  }
  const { canvas, context } = created;
  context.fillStyle = PALETTE.wall;
  context.fillRect(0, 0, 256, 256);

  for (let i = 0; i < 12; i += 1) {
    context.fillStyle = PALETTE.wallLine;
    context.globalAlpha = 0.35 + Math.random() * 0.3;
    context.fillRect(0, (i / 12) * 256 + Math.random() * 6, 256, 3 + Math.random() * 3);
  }
  context.globalAlpha = 1;

  for (let i = 0; i < 300; i += 1) {
    context.fillStyle = i % 2 === 0 ? "#b0864f" : "#d2ad78";
    context.globalAlpha = 0.5;
    context.fillRect(Math.random() * 256, Math.random() * 256, 1 + Math.random() * 2, 1 + Math.random() * 2);
  }
  context.globalAlpha = 1;

  return finishTexture(canvas, 2);
}

/** 木箱：竖向木纹 + 3 个节疤。 */
function woodTexture(): THREE.Texture | null {
  const created = createCanvas(256);
  if (created === null) {
    return null;
  }
  const { canvas, context } = created;
  context.fillStyle = PALETTE.wood;
  context.fillRect(0, 0, 256, 256);

  context.fillStyle = PALETTE.woodLine;
  for (let i = 0; i < 14; i += 1) {
    context.fillRect((i / 14) * 256 + Math.random() * 3, 0, 2, 256);
  }

  for (let i = 0; i < 3; i += 1) {
    context.beginPath();
    context.fillStyle = "rgba(110,69,31,0.85)";
    context.ellipse(
      40 + Math.random() * 176,
      40 + Math.random() * 176,
      6 + Math.random() * 5,
      10 + Math.random() * 8,
      Math.random() * Math.PI,
      0,
      Math.PI * 2,
    );
    context.fill();
  }

  return finishTexture(canvas, 1);
}

/* ------------------------------------------------------------------ *
 * 共享材质（模块级单例：重新进房时复用，不会重复创建贴图）
 * ------------------------------------------------------------------ */

interface ArenaMaterials {
  sand: THREE.MeshStandardMaterial;
  wall: THREE.MeshStandardMaterial;
  building: THREE.MeshStandardMaterial;
  wallTop: THREE.MeshStandardMaterial;
  crate: THREE.MeshStandardMaterial;
  cart: THREE.MeshStandardMaterial;
  cartCloth: THREE.MeshStandardMaterial;
  wheel: THREE.MeshStandardMaterial;
  barrelRust: THREE.MeshStandardMaterial;
  barrelArmy: THREE.MeshStandardMaterial;
  palmTrunk: THREE.MeshStandardMaterial;
  palmLeaf: THREE.MeshStandardMaterial;
  stone: THREE.MeshStandardMaterial;
  graffiti: THREE.MeshStandardMaterial;
  sandPatch: THREE.MeshBasicMaterial;
}

let cachedMaterials: ArenaMaterials | null = null;

function arenaMaterials(): ArenaMaterials {
  if (cachedMaterials !== null) {
    return cachedMaterials;
  }

  const sand = sandTexture();
  const mud = mudWallTexture();
  const wood = woodTexture();

  cachedMaterials = {
    sand: new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: sand,
      roughness: 0.95,
      metalness: 0,
    }),
    wall: new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: mud,
      roughness: 0.92,
      metalness: 0,
    }),
    building: new THREE.MeshStandardMaterial({
      color: 0xb0864f,
      map: mud,
      roughness: 0.95,
      metalness: 0,
    }),
    wallTop: new THREE.MeshStandardMaterial({ color: PALETTE.wallTop, roughness: 0.95, metalness: 0 }),
    crate: new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: wood,
      roughness: 0.82,
      metalness: 0,
    }),
    cart: new THREE.MeshStandardMaterial({ color: 0x8a5a2b, roughness: 0.85, metalness: 0 }),
    cartCloth: new THREE.MeshStandardMaterial({
      color: PALETTE.cartCloth,
      roughness: 0.9,
      metalness: 0,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
    }),
    wheel: new THREE.MeshStandardMaterial({ color: PALETTE.wheel, roughness: 0.9, metalness: 0 }),
    barrelRust: new THREE.MeshStandardMaterial({
      color: PALETTE.barrelRust,
      roughness: 0.62,
      metalness: 0.28,
    }),
    barrelArmy: new THREE.MeshStandardMaterial({
      color: PALETTE.barrelArmy,
      roughness: 0.68,
      metalness: 0.22,
    }),
    palmTrunk: new THREE.MeshStandardMaterial({ color: PALETTE.palmTrunk, roughness: 0.95, metalness: 0 }),
    palmLeaf: new THREE.MeshStandardMaterial({
      color: PALETTE.palmLeaf,
      roughness: 0.85,
      metalness: 0,
      side: THREE.DoubleSide,
    }),
    stone: new THREE.MeshStandardMaterial({ color: PALETTE.stone, roughness: 0.9, metalness: 0 }),
    graffiti: new THREE.MeshStandardMaterial({
      color: PALETTE.graffiti,
      roughness: 0.7,
      metalness: 0,
      side: THREE.DoubleSide,
    }),
    sandPatch: new THREE.MeshBasicMaterial({
      color: PALETTE.sandPatch,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
    }),
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

/** 复位用单位四元数（装饰件放置时复用，避免每帧 new）。 */
const IDENTITY_QUATERNION = new THREE.Quaternion();

/* ------------------------------------------------------------------ *
 * 装饰件（全部只做视觉，不写进 OBSTACLES、不参与碰撞）
 * ------------------------------------------------------------------ */

/** 地面沙斑：5–8 片半透明大圆，制造脏污感（单个 InstancedMesh）。 */
function addSandPatches(root: THREE.Group): void {
  const count = 8;
  const geometry = new THREE.CircleGeometry(1, 20);
  const mesh = new THREE.InstancedMesh(geometry, arenaMaterials().sandPatch, count);
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();

  for (let i = 0; i < count; i += 1) {
    const radius = 2.2 + Math.random() * 3.4;
    position.set((Math.random() - 0.5) * 44, 0.012 + i * 0.0008, (Math.random() - 0.5) * 44);
    scale.set(radius, radius, 1);
    matrix.compose(position, quaternion, scale);
    mesh.setMatrixAt(i, matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.receiveShadow = false;
  root.add(mesh);
}

/** 土墙/建筑的夯土压顶：墙顶盖一块 0.06m 厚的薄板，让墙体有"夯土分层"的收口。 */
function addWallCaps(root: THREE.Group): void {
  const caps = OBSTACLES.filter(
    (obstacle) =>
      (obstacle.type === "wall" || obstacle.type === "building") && obstacle.height >= SHADOW_MIN_HEIGHT,
  );
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  addInstances(root, geometry, arenaMaterials().wallTop, caps, (spec, position, _quaternion, scale) => {
    position.set(spec.x, spec.height + 0.03, spec.z);
    scale.set(spec.width + 0.06, 0.06, spec.depth + 0.06);
  });
}

/** 市集推车：车体已经由 InstancedMesh 画好，这里补木轮、布篷与篷柱。 */
function addCartDetails(root: THREE.Group, carts: readonly ObstacleSpec[]): void {
  if (carts.length === 0) {
    return;
  }
  const materials = arenaMaterials();

  // 木轮：车轴沿 Z（车轮在 XY 平面内滚动），每车两只，装在偏后的一根车轴上
  const wheelGeometry = new THREE.CylinderGeometry(0.42, 0.42, 0.1, 14);
  const wheelQuaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
  const wheels = new THREE.InstancedMesh(wheelGeometry, materials.wheel, carts.length * 2);
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3(1, 1, 1);
  carts.forEach((cart, index) => {
    const axleX = cart.x - cart.width * 0.28;
    const halfDepth = Math.max(cart.depth / 2 - 0.02, 0.15);
    for (let side = 0; side < 2; side += 1) {
      position.set(axleX, 0.42, cart.z + (side === 0 ? -halfDepth : halfDepth));
      matrix.compose(position, wheelQuaternion, scale);
      wheels.setMatrixAt(index * 2 + side, matrix);
    }
  });
  wheels.instanceMatrix.needsUpdate = true;
  wheels.castShadow = true;
  wheels.receiveShadow = true;
  root.add(wheels);

  // 布篷：车顶一块暗红布（略大出车体，像市集摊棚）
  const canopyGeometry = new THREE.BoxGeometry(1, 1, 1);
  addInstances(root, canopyGeometry, materials.cartCloth, carts, (cart, pos, quat, scl) => {
    pos.set(cart.x, cart.height - 0.06, cart.z);
    scl.set(cart.width + 0.34, 0.05, cart.depth + 0.3);
    quat.identity();
  });

  // 篷柱：每车 4 根细柱撑起布篷
  const postGeometry = new THREE.BoxGeometry(1, 1, 1);
  const posts = new THREE.InstancedMesh(postGeometry, materials.stone, carts.length * 4);
  carts.forEach((cart, index) => {
    const halfX = cart.width / 2 - 0.08;
    const halfZ = cart.depth / 2 - 0.06;
    const corners: Array<[number, number]> = [
      [-halfX, -halfZ],
      [halfX, -halfZ],
      [-halfX, halfZ],
      [halfX, halfZ],
    ];
    corners.forEach(([dx, dz], cornerIndex) => {
      position.set(cart.x + dx, (cart.height - 0.1) / 2, cart.z + dz);
      scale.set(0.06, cart.height - 0.1, 0.06);
      matrix.compose(position, IDENTITY_QUATERNION, scale);
      posts.setMatrixAt(index * 4 + cornerIndex, matrix);
    });
  });
  posts.instanceMatrix.needsUpdate = true;
  posts.castShadow = false;
  posts.receiveShadow = false;
  root.add(posts);
}

/** 棕榈树：树干（圆柱）+ 6–8 片放射状叶片（单片 Box，倾斜 35°–55°）。 */
function addPalms(root: THREE.Group, palms: readonly ObstacleSpec[]): void {
  if (palms.length === 0) {
    return;
  }
  const materials = arenaMaterials();
  const trunkGeometry = new THREE.CylinderGeometry(0.5, 0.62, 1, 10);
  addInstances(root, trunkGeometry, materials.palmTrunk, palms, (spec, position, _quaternion, scale) => {
    position.set(spec.x, spec.height / 2, spec.z);
    scale.set(spec.width, spec.height, spec.depth);
  });

  const leavesPerPalm = 7;
  const leafGeometry = new THREE.BoxGeometry(0.12, 0.02, 1.6);
  const leaves = new THREE.InstancedMesh(leafGeometry, materials.palmLeaf, palms.length * leavesPerPalm);
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3(1, 1, 1);
  const euler = new THREE.Euler();
  const quaternion = new THREE.Quaternion();

  palms.forEach((palm, palmIndex) => {
    for (let i = 0; i < leavesPerPalm; i += 1) {
      const angle = (i / leavesPerPalm) * Math.PI * 2 + palmIndex * 0.4;
      const tilt = (35 + Math.random() * 20) * (Math.PI / 180);
      position.set(
        palm.x + Math.cos(angle) * 0.72,
        palm.height - 0.42 - Math.random() * 0.12,
        palm.z + Math.sin(angle) * 0.72,
      );
      // YXZ：先绕 X 下俯 tilt，再绕 Y 转到该叶片的方位角（叶片长轴沿 +Z，故方位角取 π/2 − angle）
      euler.set(tilt, Math.PI / 2 - angle, 0, "YXZ");
      quaternion.setFromEuler(euler);
      matrix.compose(position, quaternion, scale);
      leaves.setMatrixAt(palmIndex * leavesPerPalm + i, matrix);
    }
  });
  leaves.instanceMatrix.needsUpdate = true;
  leaves.castShadow = true;
  leaves.receiveShadow = false;
  root.add(leaves);
}

/** 红色涂鸦：A 点东墙与 B 点西墙各贴一块 0.6×0.6 的平面（纯装饰）。 */
function addGraffiti(root: THREE.Group): void {
  const material = arenaMaterials().graffiti;
  const geometry = new THREE.PlaneGeometry(0.6, 0.6);

  // A 点：W4 西侧面（x = −11 墙的西表面 x = −12），朝向 −X
  const aTag = new THREE.Mesh(geometry, material);
  aTag.position.set(-12.01, 1.7, -15);
  aTag.rotation.y = -Math.PI / 2;
  root.add(aTag);

  // B 点：W13 东侧面（x = 11 墙的东表面 x = 12），朝向 +X
  const bTag = new THREE.Mesh(geometry, material);
  bTag.position.set(12.01, 1.7, -15);
  bTag.rotation.y = Math.PI / 2;
  root.add(bTag);
}

/** 拱门横梁（T2/T3 之间）：只做视觉，**不写进 OBSTACLES**，因此不会挡子弹也不挡路。 */
function addArchLintel(root: THREE.Group, arches: readonly ObstacleSpec[]): void {
  const tallArches = arches.filter((spec) => spec.height >= 3.5);
  if (tallArches.length < 2) {
    return;
  }
  const sorted = [...tallArches].sort((a, b) => a.x - b.x);
  const left = sorted[0] as ObstacleSpec;
  const right = sorted[sorted.length - 1] as ObstacleSpec;
  const span = Math.abs(right.x - left.x) + left.width;
  const geometry = new THREE.BoxGeometry(span, 0.55, Math.max(left.depth, right.depth) + 0.2);
  const lintel = new THREE.Mesh(geometry, arenaMaterials().stone);
  lintel.position.set((left.x + right.x) / 2, Math.min(left.height, right.height) - 0.2, (left.z + right.z) / 2);
  lintel.castShadow = true;
  lintel.receiveShadow = false;
  root.add(lintel);
}

/* ------------------------------------------------------------------ *
 * 主入口
 * ------------------------------------------------------------------ */

/** 构建沙漠迷城场景，返回可加入 scene 的根节点（含地形、体块、装饰与灯光）。 */
export function buildArena(): THREE.Group {
  const root = new THREE.Group();
  root.name = "arena";
  const materials = arenaMaterials();

  // ---- 地面：一整块 64×64 沙地（贴图 repeat 24×24 ≈ 每 2.7m 一个纹理周期） ----
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(MAP_SIZE, MAP_SIZE), materials.sand);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  root.add(floor);

  addSandPatches(root);

  // ---- 体块：按 type 分派，每种只画 1–2 次 ----
  const boxGeometry = new THREE.BoxGeometry(1, 1, 1);

  // 土墙（含外墙、矮墙、沙袋、平台）
  addInstances(root, boxGeometry, materials.wall, specsOfType("wall"), placeAabb);
  // 建筑体块（市场建筑群、CT 侧建筑、B 侧建筑）
  addInstances(root, boxGeometry, materials.building, specsOfType("building"), placeAabb);
  // 木箱 / 箱堆
  addInstances(root, boxGeometry, materials.crate, specsOfType("crate"), placeAabb);
  // 拱门石柱
  addInstances(root, boxGeometry, materials.stone, specsOfType("arch"), placeAabb);
  // 推车车体
  const carts = specsOfType("cart");
  addInstances(root, boxGeometry, materials.cart, carts, placeAabb);
  // 油桶：锈橙 / 军绿两色交替（同为圆柱体，仍只占 2 次 draw call）
  const barrels = specsOfType("barrel");
  addInstances(
    root,
    new THREE.CylinderGeometry(0.5, 0.5, 1, 14),
    materials.barrelRust,
    barrels.filter((_spec, index) => index % 2 === 0),
    placeAabb,
  );
  addInstances(
    root,
    new THREE.CylinderGeometry(0.5, 0.5, 1, 14),
    materials.barrelArmy,
    barrels.filter((_spec, index) => index % 2 === 1),
    placeAabb,
  );

  // ---- 装饰件 ----
  addWallCaps(root);
  addCartDetails(root, carts);
  addPalms(root, specsOfType("palm"));
  addArchLintel(root, specsOfType("arch"));
  addGraffiti(root);

  // ---- 灯光：沙漠正午偏下午（太阳在西偏北高处 → 阴影朝东南） ----
  const hemisphere = new THREE.HemisphereLight(0xbfd8ee, 0xb0894f, 1.05);
  root.add(hemisphere);

  const sun = new THREE.DirectionalLight(0xfff1d6, 2.0);
  sun.position.set(48, 60, 22);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -36;
  sun.shadow.camera.right = 36;
  sun.shadow.camera.top = 36;
  sun.shadow.camera.bottom = -36;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 160;
  sun.shadow.bias = -0.0006;
  root.add(sun);
  root.add(sun.target);

  return root;
}
