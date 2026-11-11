/**
 * 第三人称卡通角色模型（Tom / Jerry / Spike / Butch）。
 *
 * 三条硬约束（改动前请先读）：
 *   1. **尺寸必须由 `PLAYER_HITBOXES` 推导**，不允许在客户端手写第二套数字 ——
 *      判定体、外观、第一人称视模型三条线必须同源，否则又会回到"打不中还击"。
 *      头部判定段是 `[1.63, 1.80] / r0.13`，所以头颅球半径只能取 0.085（下沿正好 1.63）。
 *      想让头"看起来更大"，正确做法是加**口鼻 / 腮帮 / 耳朵**这些不参与判定的部件，
 *      而不是把球画大——画大了就是"瞄着头打却判定成胸"。
 *   2. **模型永远比判定体窄**：躯干半宽 < 胸段半径、耳朵之外的头部 < 头段半径、
 *      体型系数一律 ≤ 1。宁可"判定宽容"，不能"看着打中了却穿过去"。
 *   3. **材质按（角色 × 队伍）共享**：8 种组合各一套 `MeshStandardMaterial`，所有同组合
 *      的 avatar 复用。8 人局每帧 new/dispose 材质会造成 GC 抖动，这条不能破。
 *
 * 坐标系：root 原点 = 脚底中心，前方 = −Z（与 `root.rotation.y = yaw`、yaw=0 朝 −Z 一致）。
 *
 * 主题统一性：身上没有任何真实枪械与战术装具——手里是**高压水枪 / 橡皮筋枪 / 餐叉 /
 * 平底锅 / 胡椒瓶 / 面粉袋**；队伍识别靠**围巾颜色**（T 番茄红 / CT 天空蓝），
 * 这样"选 Jerry 的 CT"和"选 Jerry 的 T"都能一眼分清敌我，同时保住角色辨识度。
 */

import * as THREE from "three";

import {
  PLAYER_HEIGHT,
  PLAYER_HITBOXES,
  THROWABLE_TYPES,
  characterOfIndex,
  type CharacterId,
  type HitCylinder,
  type HitZone,
  type TeamId,
  type ThrowableType,
} from "@colyseus-fps/shared";

/* ------------------------------------------------------------------ *
 * 从判定体推导的尺寸（唯一真相）
 * ------------------------------------------------------------------ */

function zoneOf(zone: HitZone): HitCylinder {
  const found = PLAYER_HITBOXES.find((box) => box.zone === zone);
  if (found === undefined) {
    throw new Error(`PLAYER_HITBOXES 缺少 ${zone} 段`);
  }
  return found;
}

function armZone(): HitCylinder {
  const found = PLAYER_HITBOXES.find((box) => box.zone === "arm" && box.offsetRight > 0);
  if (found === undefined) {
    throw new Error("PLAYER_HITBOXES 缺少右臂段");
  }
  return found;
}

const HEAD: HitCylinder = zoneOf("head");
const CHEST: HitCylinder = zoneOf("chest");
const BELLY: HitCylinder = zoneOf("belly");
const ARM: HitCylinder = armZone();
const LEG: HitCylinder = zoneOf("leg");

/** 头颅球：判定半径 0.13 收窄 4.5cm → 0.085，头顶正好等于 PLAYER_HEIGHT。 */
export const HEAD_RADIUS: number = HEAD.radius - 0.045;
export const HEAD_CENTER_Y: number = PLAYER_HEIGHT - HEAD_RADIUS;

/** 头顶毛簇：压在头颅正上方，顶面也必须正好在 PLAYER_HEIGHT（总高验收项）。 */
export const CREST_HEIGHT: number = 0.05;
export const CREST_RADIUS: number = HEAD.radius - 0.04;
export const CREST_CENTER_Y: number = PLAYER_HEIGHT - CREST_HEIGHT / 2;

/**
 * 口鼻：贴在头颅前下方的浅色椭球（**不参与判定**）。
 *
 * 它承担"脸往前凸"的视觉印象——这么做而不是把头球画大，是因为头球一旦超过
 * 判定半径 0.13 就会出现"瞄着脸打、判定成胸"。口鼻凸出去的部分不结算伤害，
 * 与 CS 里"枪管不算 hitbox"是同一类取舍。
 */
export const MUZZLE_WIDTH: number = 0.115;
export const MUZZLE_HEIGHT: number = 0.08;
export const MUZZLE_DEPTH: number = 0.09;
export const MUZZLE_CENTER_Y: number = HEAD_CENTER_Y - 0.03;
export const MUZZLE_CENTER_Z: number = -HEAD_RADIUS;

/** 颈部饰带（围巾/项圈/领结的带子）的高度：胸段顶端下方，正好卡在"脖子"的位置。 */
export const NECKBAND_Y: number = CHEST.yMax - 0.03;

/** 躯干：宽 = 判定体直径 − 0.2，高 = 胸段高度。 */
export const TORSO_WIDTH: number = CHEST.radius * 2 - 0.2;
export const TORSO_HEIGHT: number = CHEST.yMax - CHEST.yMin;
export const TORSO_DEPTH: number = 0.24;
export const TORSO_CENTER_Y: number = (CHEST.yMin + CHEST.yMax) / 2;

/** 骨盆：压在腹段顶部（腰线），宽度 = 腹段直径 − 0.2。 */
export const PELVIS_WIDTH: number = BELLY.radius * 2 - 0.26;
export const PELVIS_HEIGHT: number = 0.2;
export const PELVIS_DEPTH: number = 0.22;
export const PELVIS_CENTER_Y: number = BELLY.yMin + PELVIS_HEIGHT / 2;

/** 腰线：躯干摆动/侧倾的枢轴高度。 */
export const WAIST_Y: number = BELLY.yMax;

/** 尾根：贴在骨盆背后，尾巴从这里长出去。 */
export const TAIL_BASE_WIDTH: number = 0.14;
export const TAIL_BASE_HEIGHT: number = 0.12;
export const TAIL_BASE_DEPTH: number = 0.14;
export const TAIL_BASE_Z: number = PELVIS_DEPTH / 2 + TAIL_BASE_DEPTH / 2 - 0.03;

/** 手臂：肩枢轴取臂段顶 − 2cm，上臂 + 前臂正好拼回臂段高度（0.28 + 0.24 = 0.52）。 */
export const SHOULDER_Y: number = ARM.yMax - 0.02;
export const UPPER_ARM_HEIGHT: number = 0.28;
export const FOREARM_HEIGHT: number = 0.24;
export const ELBOW_Y: number = SHOULDER_Y - UPPER_ARM_HEIGHT;
/**
 * 臂/腿的粗细系数。
 *
 * 取判定半径的 0.7 / 0.58 而不是 0.55 / 0.5：细了会在肩、髋留下一指宽的缝，
 * 整条胳膊像贴在身体外的棍子。加粗后外沿仍在判定体内
 * （0.3 + 0.14/2 = 0.37 < 臂段外沿 0.40），只是把"看着有缝隙"变成"贴着身体"。
 */
export const UPPER_ARM_WIDTH: number = ARM.radius * 2 * 0.7;
export const FOREARM_WIDTH: number = ARM.radius * 2 * 0.58;
/**
 * 肩枢轴（判定体口径）：臂段圆柱中心在 x = 0.3。
 *
 * 视觉上把手臂往里收到 0.24：卡通角色的手臂是**贴着身子挂**的，
 * 挂在 0.3 会让肩膀比胸还宽出一截，整个人看起来像穿着盔甲。
 * 收进来不会漏判——臂段圆柱半径 0.1，视觉臂外沿 0.31 仍在 0.4 之内。
 */
export const ARM_X: number = ARM.offsetRight;
export const ARM_VISUAL_X: number = ARM.offsetRight - 0.06;

/** 腿：髋枢轴取腹段下沿 + 5cm，大腿/小腿平分（脚高 0.07 从腿段底部让出）。 */
export const HIP_Y: number = BELLY.yMin + 0.05;
export const FOOT_HEIGHT: number = 0.07;
const LEG_AVAILABLE: number = HIP_Y - FOOT_HEIGHT;
export const THIGH_HEIGHT: number = LEG_AVAILABLE / 2;
export const SHIN_HEIGHT: number = LEG_AVAILABLE / 2;
export const KNEE_Y: number = HIP_Y - THIGH_HEIGHT;
export const THIGH_WIDTH: number = LEG.radius * 0.86;
export const SHIN_WIDTH: number = LEG.radius * 0.75;
export const FOOT_WIDTH: number = LEG.radius * 0.74;
export const FOOT_DEPTH: number = 0.28;
export const FOOT_Z: number = -0.05;
export const LEG_X: number = LEG.radius * 0.475;

/** 倒地枢轴：躯干半厚度，倒地后脊柱轴心离地 0.13m，躯干面正好贴地。 */
export const FALL_PIVOT_Y: number = 0.13;

/** 手部挂点的世界位置（规格 2.2 第 14 行：(0.24, 1.12, −0.20)）。 */
export const HAND_ANCHOR_WORLD = { x: ARM_VISUAL_X, y: 1.12, z: -0.2 } as const;

/** 手部挂点相对**肘枢轴**的局部偏移（挂点是右前臂的子节点，所以要减掉臂的 x 与肘的 y）。 */
export const HAND_ANCHOR_LOCAL = {
  x: HAND_ANCHOR_WORLD.x - ARM_VISUAL_X,
  y: HAND_ANCHOR_WORLD.y - ELBOW_Y,
  z: HAND_ANCHOR_WORLD.z,
} as const;

/** 行走摆动幅度（与文档 2.3 一致；第一人称视模型用同一套 bob 口径）。 */
export const LEG_SWING = 0.55;
export const KNEE_BEND = 0.6;
export const ARM_SWING = 0.32;
export const GUN_ARM_SWING = 0.14;
export const TORSO_BOB = 0.02;
export const TORSO_ROLL = 0.03;
/** 相位推进速度（弧度/米）。5 m/s 走 → 7.5 rad/s ≈ 1.19 Hz。 */
export const BOB_RAD_PER_METER = 1.5;
/** 摆幅淡入时间常数（与视模型 advanceBobAmp 相同）。 */
export const BOB_FADE_TAU = 0.12;
/** 倒地时长（毫秒）。 */
export const FALL_DURATION_MS = 600;

/* ------------------------------------------------------------------ *
 * 角色设定（纯外观：毛色 / 耳朵 / 体型 / 配饰）
 * ------------------------------------------------------------------ */

/** 耳朵造型：猫（尖立）/ 鼠（大圆盘）/ 狗（前折耷拉）。 */
export type EarShape = "cat" | "mouse" | "dog";

/** 胸前配饰：围巾 / 项圈 / 领结。 */
export type NeckWear = "scarf" | "collar" | "bow";

export interface CharacterStyle {
  id: CharacterId;
  /** 毛色。 */
  fur: number;
  /** 肚皮/口鼻的浅色。 */
  belly: number;
  /** 耳内。 */
  inner: number;
  /** 鼻头。 */
  nose: number;
  /** 眼睛（Butch 用荧光绿，其余墨黑）。 */
  eye: number;
  /** 爪垫。 */
  paw: number;
  ears: EarShape;
  /**
   * 体型宽度系数（0.84–1.0）。
   *
   * **上界必须是 1**：它乘在 `TORSO_WIDTH` 上，大于 1 就会比判定体宽，
   * 于是"明明穿过去了却没掉血"。Jerry 瘦、Spike 壮，都在这个区间里做差别。
   */
  bodyScale: number;
  /**
   * 头部宽/深系数（1.0–1.5）。
   *
   * **只放大 x/z，不放 y**：头顶必须压在 1.80、下沿必须压在 1.63，纵向一点都不能动。
   * 上界 1.5 来自判定体：0.085 × 1.5 = 0.1275，仍小于头部判定半径 0.13。
   * 卡通头"显大"靠的是**宽扁 + 大耳朵 + 鼓腮**，不是把球吹大。
   */
  headScale: number;
  /** 尾巴长度系数（Spike 短尾 0.55，Butch 长尾 1.05）。 */
  tailLength: number;
  /** 是否有腮帮（老鼠的鼓腮、斗牛犬的下颌）。 */
  jowls: boolean;
  /** 胡须根数（左右各一半）。 */
  whiskers: number;
  neck: NeckWear;
}

/**
 * 四个角色的外观设定。
 *
 * 数值全部落在"判定体以内"：`bodyScale ≤ 1`、`0.085 × headScale < 0.13`。
 * 颜色取自各自在动画里的经典配色，只做致敬，不复制任何官方贴图资源。
 */
export const CHARACTER_STYLES: Record<CharacterId, CharacterStyle> = {
  tom: {
    id: "tom",
    fur: 0x8ca3b8,
    belly: 0xf2ede3,
    inner: 0xffb49a,
    nose: 0xe8735f,
    eye: 0x2b1b2f,
    paw: 0xf2ede3,
    ears: "cat",
    bodyScale: 0.96,
    headScale: 1.45,
    tailLength: 1,
    jowls: true,
    whiskers: 4,
    neck: "scarf",
  },
  jerry: {
    id: "jerry",
    fur: 0xc97b3e,
    belly: 0xf7dcc0,
    inner: 0xffb49a,
    nose: 0xe8432f,
    eye: 0x2b1b2f,
    paw: 0xf7dcc0,
    ears: "mouse",
    bodyScale: 0.84,
    headScale: 1.5,
    tailLength: 0.9,
    jowls: true,
    whiskers: 4,
    neck: "bow",
  },
  spike: {
    id: "spike",
    fur: 0xd9a05b,
    belly: 0xf1d8ac,
    inner: 0xc98a6b,
    nose: 0x2b1b2f,
    eye: 0x2b1b2f,
    paw: 0xf1d8ac,
    ears: "dog",
    bodyScale: 1,
    headScale: 1.48,
    tailLength: 0.55,
    jowls: true,
    whiskers: 2,
    neck: "collar",
  },
  butch: {
    id: "butch",
    fur: 0x3b2c42,
    belly: 0x6a5670,
    inner: 0xe07a8a,
    nose: 0x2b1b2f,
    eye: 0xa6f07a,
    paw: 0x6a5670,
    ears: "cat",
    bodyScale: 0.9,
    headScale: 1.42,
    tailLength: 1.05,
    jowls: true,
    whiskers: 4,
    neck: "bow",
  },
};

/** 队伍识别色（围巾/项圈）：T 番茄红、CT 天空蓝。 */
export const TEAM_ACCENT: Record<TeamId, number> = {
  T: 0xe8432f,
  CT: 0x3fa9e0,
};

/* ------------------------------------------------------------------ *
 * 材质（按 角色 × 队伍 共享）
 * ------------------------------------------------------------------ */

export type AvatarMaterialKind =
  | "fur"
  | "belly"
  | "inner"
  | "nose"
  | "eye"
  | "paw"
  /** 队伍识别色（围巾 / 项圈 / 领结）。 */
  | "accent"
  /** 厨具金属（锅、叉、水枪喷嘴）。 */
  | "metal"
  /** 木柄 / 塑料握把。 */
  | "wood"
  /** 亮银刃口。 */
  | "blade"
  /** 墨色塑料与小件（眼睛高光、绑带）。 */
  | "dark";

export type AvatarMaterials = Record<AvatarMaterialKind, THREE.MeshStandardMaterial>;

const materialCache = new Map<string, AvatarMaterials>();

function materialKey(character: CharacterId, team: TeamId): string {
  return `${character}|${team}`;
}

function createMaterials(character: CharacterId, team: TeamId): AvatarMaterials {
  const style = CHARACTER_STYLES[character];
  // 卡通质感的三个关键：**低金属度**、**高粗糙度**、**无环境反射**。
  // 真实枪械那套 metalness 0.9 / roughness 0.2 放在这种大色块造型上会立刻变成"塑料之外的另一种塑料"，
  // 反而更脏；这里统一按哑光橡胶/毛绒处理，只给厨具留一点金属感。
  const matte = (color: number): THREE.MeshStandardMaterial =>
    new THREE.MeshStandardMaterial({ color, roughness: 0.88, metalness: 0.02 });
  return {
    fur: matte(style.fur),
    belly: matte(style.belly),
    inner: matte(style.inner),
    nose: new THREE.MeshStandardMaterial({ color: style.nose, roughness: 0.42, metalness: 0.05 }),
    eye: new THREE.MeshStandardMaterial({ color: style.eye, roughness: 0.28, metalness: 0.1 }),
    paw: matte(style.paw),
    accent: matte(TEAM_ACCENT[team]),
    metal: new THREE.MeshStandardMaterial({ color: 0x8d97a3, roughness: 0.34, metalness: 0.78 }),
    wood: matte(0x8a5a34),
    blade: new THREE.MeshStandardMaterial({ color: 0xd9e3ee, roughness: 0.18, metalness: 0.9 }),
    dark: matte(0x2b1b2f),
  };
}

/**
 * 取某（角色, 队伍）组合的材质集合（**模块级缓存**：同组合的所有 avatar 共享同一批实例）。
 */
export function avatarMaterials(character: CharacterId, team: TeamId): AvatarMaterials {
  const key: string = materialKey(character, team);
  const cached = materialCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const created: AvatarMaterials = createMaterials(character, team);
  materialCache.set(key, created);
  return created;
}

/** 释放全部共享材质（只在整局销毁时调用，avatar 自身 dispose 不碰材质）。 */
export function disposeAvatarMaterials(): void {
  for (const materials of materialCache.values()) {
    for (const material of Object.values(materials)) {
      material.dispose();
    }
  }
  materialCache.clear();
}

/* ------------------------------------------------------------------ *
 * 部件规格表（16 个参与"造型骨架"的 mesh）
 * ------------------------------------------------------------------ */

export type AvatarPartGeometry = "box" | "sphere" | "cylinder" | "ellipsoid" | "capsule" | "cone";

/**
 * 一切可交给 `createMesh` 的几何描述（骨架件 / 装饰件 / 手持道具共用）。
 *
 * 三者共用同一套字段，是为了让「模型数据」和「构建代码」之间只有一个函数边界：
 * 想加一件东西 = 往数组里加一行，而不是再写一段 new THREE.Mesh。
 */
export interface MeshSpec {
  geometry: AvatarPartGeometry;
  /**
   * box: 全尺寸；sphere: 半径（x 三项相同）；
   * ellipsoid: 全尺寸（直径）；cylinder: 直径/高/直径；capsule: 直径/总高/直径；cone: 底径/高/底径。
   */
  size: { x: number; y: number; z: number };
  /** 相对脚底中心的绝对位置（构树时再换算成父节点局部坐标）。 */
  pos: { x: number; y: number; z: number };
  rotX?: number;
  rotY?: number;
  rotZ?: number;
}

export interface AvatarPartSpec extends MeshSpec {
  /** 部件名（也是 `parts` map 的键）。 */
  name: string;
  /** 中文名，便于报告与调试。 */
  label: string;
  material: AvatarMaterialKind;
}

/**
 * 16 个骨架部件（判定与造型共用同一批尺寸）。
 *
 * 与旧版的差别：`helmet` → `crest`（头顶毛簇）、`visor` → `muzzle`（口鼻）、
 * `backpack` → `tailBase`（尾根）。**数量与位置契约不变**：头的下沿 1.63、
 * 头顶 1.80、脚底 0、手部挂点 1.12 全部照旧，所以判定体一个像素都不用改。
 */
export const AVATAR_PARTS: readonly AvatarPartSpec[] = [
  {
    name: "head",
    label: "头",
    geometry: "ellipsoid",
    // 稍扁稍宽：卡通头不是正球，但整体仍在 0.085 半径以内
    size: { x: HEAD_RADIUS * 2, y: HEAD_RADIUS * 2, z: HEAD_RADIUS * 2 },
    pos: { x: 0, y: HEAD_CENTER_Y, z: 0 },
    material: "fur",
  },
  {
    name: "crest",
    label: "头顶毛簇",
    geometry: "cylinder",
    size: { x: CREST_RADIUS * 2, y: CREST_HEIGHT, z: CREST_RADIUS * 2 },
    pos: { x: 0, y: CREST_CENTER_Y, z: 0 },
    material: "fur",
  },
  {
    name: "muzzle",
    label: "口鼻",
    geometry: "ellipsoid",
    size: { x: MUZZLE_WIDTH, y: MUZZLE_HEIGHT, z: MUZZLE_DEPTH },
    pos: { x: 0, y: MUZZLE_CENTER_Y, z: MUZZLE_CENTER_Z },
    material: "belly",
  },
  {
    name: "torso",
    label: "躯干",
    geometry: "ellipsoid",
    size: { x: TORSO_WIDTH, y: TORSO_HEIGHT, z: TORSO_DEPTH },
    pos: { x: 0, y: TORSO_CENTER_Y, z: 0 },
    material: "fur",
  },
  {
    name: "pelvis",
    label: "骨盆",
    geometry: "ellipsoid",
    size: { x: PELVIS_WIDTH, y: PELVIS_HEIGHT, z: PELVIS_DEPTH },
    pos: { x: 0, y: PELVIS_CENTER_Y, z: 0 },
    material: "fur",
  },
  {
    name: "tailBase",
    label: "尾根",
    geometry: "ellipsoid",
    size: { x: TAIL_BASE_WIDTH, y: TAIL_BASE_HEIGHT, z: TAIL_BASE_DEPTH },
    pos: { x: 0, y: PELVIS_CENTER_Y + 0.02, z: TAIL_BASE_Z },
    material: "fur",
  },
  {
    name: "upperArmL",
    label: "左上臂",
    geometry: "capsule",
    size: { x: UPPER_ARM_WIDTH, y: UPPER_ARM_HEIGHT, z: UPPER_ARM_WIDTH },
    pos: { x: -ARM_X, y: SHOULDER_Y - UPPER_ARM_HEIGHT / 2, z: 0 },
    material: "fur",
  },
  {
    name: "foreArmL",
    label: "左前臂",
    geometry: "capsule",
    size: { x: FOREARM_WIDTH, y: FOREARM_HEIGHT, z: FOREARM_WIDTH },
    pos: { x: -ARM_X, y: ELBOW_Y - FOREARM_HEIGHT / 2, z: 0 },
    material: "fur",
  },
  {
    name: "upperArmR",
    label: "右上臂",
    geometry: "capsule",
    size: { x: UPPER_ARM_WIDTH, y: UPPER_ARM_HEIGHT, z: UPPER_ARM_WIDTH },
    pos: { x: ARM_X, y: SHOULDER_Y - UPPER_ARM_HEIGHT / 2, z: 0 },
    material: "fur",
  },
  {
    name: "foreArmR",
    label: "右前臂",
    geometry: "capsule",
    size: { x: FOREARM_WIDTH, y: FOREARM_HEIGHT, z: FOREARM_WIDTH },
    pos: { x: ARM_X, y: ELBOW_Y - FOREARM_HEIGHT / 2, z: 0 },
    material: "fur",
  },
  {
    name: "thighL",
    label: "左大腿",
    geometry: "capsule",
    size: { x: THIGH_WIDTH, y: THIGH_HEIGHT, z: THIGH_WIDTH },
    pos: { x: -LEG_X, y: HIP_Y - THIGH_HEIGHT / 2, z: 0 },
    material: "fur",
  },
  {
    name: "thighR",
    label: "右大腿",
    geometry: "capsule",
    size: { x: THIGH_WIDTH, y: THIGH_HEIGHT, z: THIGH_WIDTH },
    pos: { x: LEG_X, y: HIP_Y - THIGH_HEIGHT / 2, z: 0 },
    material: "fur",
  },
  {
    name: "shinL",
    label: "左小腿",
    geometry: "capsule",
    size: { x: SHIN_WIDTH, y: SHIN_HEIGHT, z: SHIN_WIDTH },
    pos: { x: -LEG_X, y: KNEE_Y - SHIN_HEIGHT / 2, z: 0 },
    material: "fur",
  },
  {
    name: "shinR",
    label: "右小腿",
    geometry: "capsule",
    size: { x: SHIN_WIDTH, y: SHIN_HEIGHT, z: SHIN_WIDTH },
    pos: { x: LEG_X, y: KNEE_Y - SHIN_HEIGHT / 2, z: 0 },
    material: "fur",
  },
  {
    name: "footL",
    label: "左脚",
    geometry: "ellipsoid",
    size: { x: FOOT_WIDTH, y: FOOT_HEIGHT, z: FOOT_DEPTH },
    pos: { x: -LEG_X, y: FOOT_HEIGHT / 2, z: FOOT_Z },
    material: "paw",
  },
  {
    name: "footR",
    label: "右脚",
    geometry: "ellipsoid",
    size: { x: FOOT_WIDTH, y: FOOT_HEIGHT, z: FOOT_DEPTH },
    pos: { x: LEG_X, y: FOOT_HEIGHT / 2, z: FOOT_Z },
    material: "paw",
  },
];

/* ------------------------------------------------------------------ *
 * 角色装饰件（耳朵 / 眼睛 / 腮帮 / 胡须 / 尾巴 / 配饰 / 爪）
 *
 * **不进入 `parts` 表**：这些件不参与任何判定，也不该被「16 个判定部件」的验收用例卡住。
 * 它们挂在既有骨骼组上（躯干枢轴 / 肘 / 尾根枢轴），跟随行走、下蹲、倒地。
 * ------------------------------------------------------------------ */

/**
 * 装饰件的挂载点。
 *
 * `torso` 的坐标写的是**世界高度**（构树时统一减掉腰线）；
 * 其余全是**该关节的局部坐标**（0,0,0 = 关节心）。
 */
export type AvatarDecorParent =
  | "torso"
  | "shoulderL"
  | "shoulderR"
  | "elbowL"
  | "elbowR"
  | "hipL"
  | "hipR"
  | "kneeL"
  | "kneeR"
  | "foreArmL"
  | "foreArmR";

export interface AvatarDecorSpec extends MeshSpec {
  parent: AvatarDecorParent;
  material: AvatarMaterialKind;
}

/**
 * 生成某角色的**全部非判定装饰件**。
 *
 * 顺序无关紧要（都挂在骨骼上），但数量与造型是"这是谁"的全部信息：
 * 耳朵决定物种、腮帮与胡须决定性格、围巾/领结决定敌我。
 */
export function avatarDecor(character: CharacterId): readonly AvatarDecorSpec[] {
  const style = CHARACTER_STYLES[character];
  const decor: AvatarDecorSpec[] = [];
  const headY: number = HEAD_CENTER_Y;
  // 头是椭球：x/z 被 headScale 放大、y 不动，所以眼鼻的坐标必须跟着走，
  // 否则 Jerry 这种头大的角色会出现"眼睛陷进脸里、鼻头浮在半空"。
  const headHalfW: number = HEAD_RADIUS * style.headScale;
  const eyeX: number = headHalfW * 0.52;
  const eyeY: number = headY + 0.028;
  const eyeZ: number = -headHalfW * 0.8;
  // 口鼻前端（世界 z）与半宽，用来把鼻头、胡须"长"在脸上而不是飘在前面
  const muzzleHalfW: number = (MUZZLE_WIDTH / 2) * style.headScale;
  const muzzleFrontZ: number = MUZZLE_CENTER_Z * style.headScale - MUZZLE_DEPTH / 2;

  // ---- 关节球：整只角色的"骨架感"全靠它们 ----
  // 胶囊段之间一定会有接缝，唯一的低成本解法是在每个关节放一颗比肢体略粗的球，
  // 把两段的端头一起吞掉。没有这一步，肩、肘、髋、膝就是四道一眼可见的断口。
  //
  // **必须乘 bodyScale**：肢体本身被 `narrow()` 按体型收窄了，关节球如果不跟着收，
  // Jerry 那种 0.84 的瘦子就会顶着一圈比自己腿还粗的"护具"，看起来像穿了短裤。
  const w: number = style.bodyScale;
  decor.push(
    { parent: "shoulderL", geometry: "ellipsoid",
      size: { x: UPPER_ARM_WIDTH * w * 1.16, y: UPPER_ARM_WIDTH * w * 1.16, z: UPPER_ARM_WIDTH * w * 1.16 },
      pos: { x: 0, y: 0, z: 0 }, material: "fur" },
    { parent: "shoulderR", geometry: "ellipsoid",
      size: { x: UPPER_ARM_WIDTH * w * 1.16, y: UPPER_ARM_WIDTH * w * 1.16, z: UPPER_ARM_WIDTH * w * 1.16 },
      pos: { x: 0, y: 0, z: 0 }, material: "fur" },
    { parent: "elbowL", geometry: "ellipsoid",
      size: { x: FOREARM_WIDTH * w * 1.08, y: FOREARM_WIDTH * w * 1.08, z: FOREARM_WIDTH * w * 1.08 },
      pos: { x: 0, y: 0, z: 0 }, material: "fur" },
    { parent: "elbowR", geometry: "ellipsoid",
      size: { x: FOREARM_WIDTH * w * 1.08, y: FOREARM_WIDTH * w * 1.08, z: FOREARM_WIDTH * w * 1.08 },
      pos: { x: 0, y: 0, z: 0 }, material: "fur" },
    { parent: "hipL", geometry: "ellipsoid",
      size: { x: THIGH_WIDTH * w * 1.12, y: THIGH_WIDTH * w * 1.12, z: THIGH_WIDTH * w * 1.12 },
      pos: { x: 0, y: 0, z: 0 }, material: "fur" },
    { parent: "hipR", geometry: "ellipsoid",
      size: { x: THIGH_WIDTH * w * 1.12, y: THIGH_WIDTH * w * 1.12, z: THIGH_WIDTH * w * 1.12 },
      pos: { x: 0, y: 0, z: 0 }, material: "fur" },
    { parent: "kneeL", geometry: "ellipsoid",
      size: { x: SHIN_WIDTH * w * 1.06, y: SHIN_WIDTH * w * 1.06, z: SHIN_WIDTH * w * 1.06 },
      pos: { x: 0, y: 0, z: 0 }, material: "fur" },
    { parent: "kneeR", geometry: "ellipsoid",
      size: { x: SHIN_WIDTH * w * 1.06, y: SHIN_WIDTH * w * 1.06, z: SHIN_WIDTH * w * 1.06 },
      pos: { x: 0, y: 0, z: 0 }, material: "fur" },
  );

  // ---- 脖子：头与胸在 1.63 处正好相切，没有这一段就会看到一条镂空的缝 ----
  decor.push({
    parent: "torso", geometry: "cylinder",
    size: { x: 0.17, y: 0.1, z: 0.17 },
    pos: { x: 0, y: CHEST.yMax - 0.01, z: 0 }, material: "fur",
  });

  // ---- 眼睛（两只椭球，稍凸出脸庞）----
  decor.push(
    { parent: "torso", geometry: "ellipsoid", size: { x: 0.03, y: 0.04, z: 0.028 },
      pos: { x: -eyeX, y: eyeY, z: eyeZ }, material: "eye" },
    { parent: "torso", geometry: "ellipsoid", size: { x: 0.03, y: 0.04, z: 0.028 },
      pos: { x: eyeX, y: eyeY, z: eyeZ }, material: "eye" },
  );

  // ---- 鼻头（半嵌在口鼻最前端，露一半）----
  decor.push({
    parent: "torso", geometry: "ellipsoid", size: { x: 0.04, y: 0.03, z: 0.032 },
    pos: { x: 0, y: headY - 0.008, z: muzzleFrontZ + 0.014 }, material: "nose",
  });

  // ---- 耳朵（三种造型；位置跟着头宽走，否则头放大后耳朵会长到脑门上）----
  const earX: number = headHalfW * 0.7;
  const earY: number = headY + HEAD_RADIUS * 0.72;
  if (style.ears === "cat") {
    // 尖立三角耳：外锥 + 内锥，向外倾 18°
    for (const side of [-1, 1] as const) {
      decor.push(
        { parent: "torso", geometry: "cone", size: { x: 0.095, y: 0.13, z: 0.095 },
          pos: { x: side * earX * 0.72, y: earY + 0.03, z: 0.004 }, rotZ: side * -0.24, material: "fur" },
        { parent: "torso", geometry: "cone", size: { x: 0.055, y: 0.085, z: 0.055 },
          pos: { x: side * earX * 0.72, y: earY + 0.026, z: -0.016 }, rotZ: side * -0.24, material: "inner" },
      );
    }
  } else if (style.ears === "mouse") {
    // 大圆盘耳：两片压扁的椭球，几乎横在头两侧
    for (const side of [-1, 1] as const) {
      decor.push(
        { parent: "torso", geometry: "ellipsoid", size: { x: 0.17, y: 0.17, z: 0.05 },
          pos: { x: side * earX * 1.02, y: earY + 0.03, z: 0.012 }, rotY: side * 0.2, material: "fur" },
        { parent: "torso", geometry: "ellipsoid", size: { x: 0.115, y: 0.115, z: 0.035 },
          pos: { x: side * earX * 1.02, y: earY + 0.03, z: -0.006 }, rotY: side * 0.2, material: "inner" },
      );
    }
  } else {
    // 前折的耷拉耳：挂在头两侧下垂
    for (const side of [-1, 1] as const) {
      decor.push(
        { parent: "torso", geometry: "ellipsoid", size: { x: 0.065, y: 0.15, z: 0.08 },
          pos: { x: side * earX, y: earY - 0.035, z: 0.008 }, rotZ: side * 0.26, material: "fur" },
        { parent: "torso", geometry: "ellipsoid", size: { x: 0.04, y: 0.098, z: 0.05 },
          pos: { x: side * earX * 1.06, y: earY - 0.042, z: -0.014 }, rotZ: side * 0.26, material: "inner" },
      );
    }
  }

  // ---- 腮帮（四只全有：卡通脸的体积基本都长在腮上）----
  if (style.jowls) {
    for (const side of [-1, 1] as const) {
      decor.push({
        parent: "torso", geometry: "ellipsoid", size: { x: 0.075, y: 0.066, z: 0.07 },
        pos: { x: side * headHalfW * 0.6, y: headY - 0.048, z: -headHalfW * 0.62 }, material: "belly",
      });
    }
  }

  // ---- 胡须（细杆，左右各一半；只做剪影，不做物理）----
  // 杆的**根**要埋进口鼻侧面，所以中心 x = 口鼻半宽 + 杆长的一半 − 1.5cm 重叠。
  const whiskerLength: number = 0.11;
  const whiskerX: number = muzzleHalfW + whiskerLength / 2 - 0.015;
  const whiskerZ: number = muzzleFrontZ + 0.024;
  const perSide: number = Math.floor(style.whiskers / 2);
  for (const side of [-1, 1] as const) {
    for (let i = 0; i < perSide; i += 1) {
      decor.push({
        parent: "torso", geometry: "box",
        size: { x: whiskerLength, y: 0.006, z: 0.006 },
        pos: { x: side * whiskerX, y: headY - 0.018 - i * 0.019, z: whiskerZ },
        // 上下两根反向倾斜：一根上扬一根下垂，比两根平行自然
        rotZ: side * 0.14 * (i === 0 ? 1 : -0.7),
        material: "dark",
      });
    }
  }

  // ---- 胸前配饰（敌我识别的第一信号）----
  // 带子卡在胸段顶端下方 3cm：这里是"脖子"，再高就跑到脸上去了。
  decor.push({
    parent: "torso", geometry: "cylinder",
    size: { x: 0.21, y: 0.06, z: 0.2 },
    pos: { x: 0, y: NECKBAND_Y, z: 0 }, material: "accent",
  });
  if (style.neck === "scarf") {
    // 围巾的垂尾：两条短带挂在左肩后侧
    decor.push({
      parent: "torso", geometry: "box", size: { x: 0.05, y: 0.17, z: 0.02 },
      pos: { x: -0.062, y: NECKBAND_Y - 0.05, z: 0.086 }, rotZ: 0.16, material: "accent",
    });
  } else if (style.neck === "bow") {
    // 领结：两个三角块 + 中间结
    for (const side of [-1, 1] as const) {
      decor.push({
        parent: "torso", geometry: "cone", size: { x: 0.065, y: 0.08, z: 0.065 },
        pos: { x: side * 0.04, y: NECKBAND_Y, z: -0.078 }, rotZ: side * Math.PI / 2, material: "accent",
      });
    }
    decor.push({
      parent: "torso", geometry: "ellipsoid", size: { x: 0.036, y: 0.036, z: 0.036 },
      pos: { x: 0, y: NECKBAND_Y, z: -0.094 }, material: "accent",
    });
  } else {
    // 项圈：正面挂一块小铜牌（垂在带子下方，不压进胸口）
    decor.push({
      parent: "torso", geometry: "box", size: { x: 0.05, y: 0.045, z: 0.012 },
      pos: { x: 0, y: NECKBAND_Y - 0.044, z: -0.108 }, material: "metal",
    });
  }

  // ---- 爪垫（前臂末端两只圆手）----
  for (const side of [-1, 1] as const) {
    decor.push({
      parent: side < 0 ? "foreArmL" : "foreArmR",
      geometry: "ellipsoid", size: { x: 0.082 * w, y: 0.092 * w, z: 0.082 * w },
      pos: { x: 0, y: -FOREARM_HEIGHT + 0.015, z: 0 }, material: "paw",
    });
  }

  // ---- 脚趾（三颗小凸起；没有它们脚就是两块卵石，剪影完全不像爪子）----
  const toeY: number = -(SHIN_HEIGHT + FOOT_HEIGHT / 2) + 0.004;
  for (const side of [-1, 1] as const) {
    for (const offset of [-1, 0, 1] as const) {
      decor.push({
        parent: side < 0 ? "kneeL" : "kneeR",
        geometry: "ellipsoid", size: { x: 0.05 * w, y: 0.05 * w, z: 0.075 * w },
        pos: { x: offset * 0.042 * w, y: toeY, z: FOOT_Z - FOOT_DEPTH / 2 + 0.018 }, material: "paw",
      });
    }
  }

  return decor;
}

/* ------------------------------------------------------------------ *
 * 手持道具（6 个槽位各一组，挂 handAnchor 下）
 * ------------------------------------------------------------------ */

export interface WeaponMeshSpec extends MeshSpec {
  material: AvatarMaterialKind;
}

/** 高压水枪：厚塑料水箱 + 短喷嘴，轮廓一眼是玩具。 */
const WATER_GUN_MESHES: readonly WeaponMeshSpec[] = [
  { geometry: "box", size: { x: 0.075, y: 0.1, z: 0.34 }, pos: { x: 0, y: 0, z: 0 }, material: "accent" },
  { geometry: "cylinder", size: { x: 0.07, y: 0.18, z: 0.07 }, pos: { x: 0, y: 0.085, z: 0.02 }, material: "metal" },
  { geometry: "cylinder", size: { x: 0.05, y: 0.12, z: 0.05 }, pos: { x: 0, y: 0.012, z: -0.23 }, rotX: Math.PI / 2, material: "wood" },
  { geometry: "box", size: { x: 0.05, y: 0.14, z: 0.07 }, pos: { x: 0, y: -0.1, z: -0.05 }, material: "wood" },
  { geometry: "box", size: { x: 0.05, y: 0.07, z: 0.16 }, pos: { x: 0, y: -0.01, z: 0.2 }, material: "belly" },
];

/** 橡皮筋枪：一根长木夹 + 一截绷起的皮筋。 */
const BAND_GUN_MESHES: readonly WeaponMeshSpec[] = [
  { geometry: "box", size: { x: 0.04, y: 0.06, z: 0.22 }, pos: { x: 0, y: 0, z: -0.05 }, material: "wood" },
  { geometry: "box", size: { x: 0.012, y: 0.012, z: 0.16 }, pos: { x: 0, y: 0.03, z: -0.19 }, material: "dark" },
  { geometry: "box", size: { x: 0.04, y: 0.11, z: 0.05 }, pos: { x: 0, y: -0.075, z: 0.03 }, rotX: 0.28, material: "wood" },
  { geometry: "box", size: { x: 0.026, y: 0.026, z: 0.03 }, pos: { x: 0, y: 0.028, z: -0.26 }, material: "accent" },
];

/**
 * 餐叉（第三人称）：柄 + 四齿。
 *
 * 用「手柄盒 + 横梁 + 4 根细齿」拼，而不是挤出一个真实叉形轮廓：
 * 30m 外只看得见四条竖线，几何越简单越不容易糊成一团黑。
 */
const FORK_MESHES: readonly WeaponMeshSpec[] = [
  { geometry: "box", size: { x: 0.026, y: 0.03, z: 0.13 }, pos: { x: 0, y: 0, z: 0.06 }, material: "wood" },
  { geometry: "box", size: { x: 0.09, y: 0.026, z: 0.022 }, pos: { x: 0, y: 0, z: -0.012 }, material: "blade" },
  { geometry: "box", size: { x: 0.016, y: 0.022, z: 0.13 }, pos: { x: -0.033, y: 0, z: -0.085 }, material: "blade" },
  { geometry: "box", size: { x: 0.016, y: 0.022, z: 0.13 }, pos: { x: -0.011, y: 0, z: -0.085 }, material: "blade" },
  { geometry: "box", size: { x: 0.016, y: 0.022, z: 0.13 }, pos: { x: 0.011, y: 0, z: -0.085 }, material: "blade" },
  { geometry: "box", size: { x: 0.016, y: 0.022, z: 0.13 }, pos: { x: 0.033, y: 0, z: -0.085 }, material: "blade" },
];

/** 平底锅：竖着拎，锅面朝前——这样第一眼就认得出是锅而不是球。 */
const PAN_MESHES: readonly WeaponMeshSpec[] = [
  { geometry: "cylinder", size: { x: 0.17, y: 0.045, z: 0.17 }, pos: { x: 0, y: 0, z: -0.02 }, rotX: Math.PI / 2, material: "metal" },
  { geometry: "cylinder", size: { x: 0.03, y: 0.16, z: 0.03 }, pos: { x: 0, y: 0.1, z: 0.06 }, rotX: 0.5, material: "wood" },
];

/** 胡椒瓶：小圆柱 + 尖顶旋盖。 */
const PEPPER_MESHES: readonly WeaponMeshSpec[] = [
  { geometry: "cylinder", size: { x: 0.06, y: 0.1, z: 0.06 }, pos: { x: 0, y: 0, z: 0 }, material: "belly" },
  { geometry: "cone", size: { x: 0.055, y: 0.05, z: 0.055 }, pos: { x: 0, y: 0.075, z: 0 }, material: "metal" },
  { geometry: "box", size: { x: 0.02, y: 0.02, z: 0.02 }, pos: { x: 0, y: 0.105, z: 0 }, material: "dark" },
];

/** 面粉袋：鼓胀的布袋 + 扎口 + 撒出来的一点面粉。 */
const FLOUR_MESHES: readonly WeaponMeshSpec[] = [
  { geometry: "ellipsoid", size: { x: 0.14, y: 0.17, z: 0.14 }, pos: { x: 0, y: 0, z: 0 }, material: "belly" },
  { geometry: "cylinder", size: { x: 0.06, y: 0.05, z: 0.06 }, pos: { x: 0, y: 0.095, z: 0 }, material: "wood" },
  { geometry: "ellipsoid", size: { x: 0.055, y: 0.04, z: 0.055 }, pos: { x: 0, y: 0.125, z: 0 }, material: "belly" },
];

/** 6 个槽位 → 网格清单（索引 = `WEAPON_SLOTS` 的值）。 */
const WEAPON_SPECS: readonly (readonly WeaponMeshSpec[])[] = [
  WATER_GUN_MESHES,
  BAND_GUN_MESHES,
  FORK_MESHES,
  PAN_MESHES,
  PEPPER_MESHES,
  FLOUR_MESHES,
];

/** 投掷物类型 → 手持模型（`WEAPON_SPECS` 的索引与槽位一一对应，这里只做校验用的映射）。 */
export const THROWABLE_HELD_SPEC: Record<ThrowableType, readonly WeaponMeshSpec[]> = {
  [THROWABLE_TYPES.FRAG]: PAN_MESHES,
  [THROWABLE_TYPES.FLASH]: PEPPER_MESHES,
  [THROWABLE_TYPES.SMOKE]: FLOUR_MESHES,
};

/* ------------------------------------------------------------------ *
 * 构建
 * ------------------------------------------------------------------ */

/**
 * 几何缓存：同一份尺寸只上传一次显存。
 *
 * 为什么要缓存：一个 avatar 现在是 ~70 个 mesh（16 骨架 + 48 装饰 + 手持道具），
 * 8 人局就是 560 份 `BufferGeometry`。这些几何的尺寸**只由角色与体型决定**，
 * 全场最多几十种，逐 avatar 新建等于把同一批顶点上传 7 遍。
 *
 * 代价是几何**不能再按 avatar 释放**——所以 `dispose()` 只清引用，真正的释放在
 * {@link disposeAvatarGeometries}（整局销毁时才调用，和材质同一条规矩）。
 */
const geometryCache = new Map<string, THREE.BufferGeometry>();

/** 椭球用的单位球：全场只有这一份，形状差异全靠 `mesh.scale`。 */
let unitSphere: THREE.SphereGeometry | null = null;

function ellipsoidPrimitive(): THREE.BufferGeometry {
  unitSphere ??= new THREE.SphereGeometry(0.5, 14, 10);
  return unitSphere;
}

function createPrimitive(spec: Pick<MeshSpec, "geometry" | "size">): THREE.BufferGeometry {
  const { x, y, z } = spec.size;
  // 椭球永远是同一个单位球再靠 mesh.scale 变形，天然只有一份，不占缓存
  if (spec.geometry === "ellipsoid") {
    return ellipsoidPrimitive();
  }
  const key: string =
    `${spec.geometry}|${x.toFixed(4)}|${y.toFixed(4)}|${z.toFixed(4)}`;
  const cached = geometryCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const created: THREE.BufferGeometry = (() => {
    if (spec.geometry === "sphere") {
      return new THREE.SphereGeometry(x, 12, 10);
    }
    if (spec.geometry === "capsule") {
      const radius = Math.max(0.002, Math.min(x / 2, y / 2 - 0.001));
      return new THREE.CapsuleGeometry(radius, Math.max(0.002, y - radius * 2), 4, 10);
    }
    if (spec.geometry === "cone") {
      return new THREE.ConeGeometry(Math.max(0.002, x / 2), y, 12);
    }
    if (spec.geometry === "cylinder") {
      // CylinderGeometry(radiusTop, radiusBottom, height, radialSegments)：x/z 传的是直径
      return new THREE.CylinderGeometry(x / 2, z / 2, y, 14);
    }
    return new THREE.BoxGeometry(x, y, z);
  })();
  geometryCache.set(key, created);
  return created;
}

/** 释放共享几何（只在整局销毁时调用，avatar 自身 dispose 不碰几何）。 */
export function disposeAvatarGeometries(): void {
  for (const geometry of geometryCache.values()) {
    geometry.dispose();
  }
  geometryCache.clear();
  unitSphere?.dispose();
  unitSphere = null;
}

function createMesh(spec: MeshSpec & { material: AvatarMaterialKind }, materials: AvatarMaterials): THREE.Mesh {
  const geometry = createPrimitive(spec);
  const mesh = new THREE.Mesh(geometry, materials[spec.material]);
  mesh.position.set(spec.pos.x, spec.pos.y, spec.pos.z);
  if (spec.geometry === "ellipsoid") {
    mesh.scale.set(spec.size.x, spec.size.y, spec.size.z);
  }
  if (typeof spec.rotX === "number") {
    mesh.rotation.x = spec.rotX;
  }
  if (typeof spec.rotY === "number") {
    mesh.rotation.y = spec.rotY;
  }
  if (typeof spec.rotZ === "number") {
    mesh.rotation.z = spec.rotZ;
  }
  mesh.castShadow = true;
  return mesh;
}

/** 化身骨架引用（供动画逐帧写入）。 */
export interface AvatarRig {
  /** 倒地枢轴（绕局部 X 轴 +90° 后仰）。 */
  fallPivot: THREE.Group;
  /** 上身枢轴（腰线，躯干摆动/侧倾）。 */
  torsoPivot: THREE.Group;
  /** 髋关节（旋转 = 大腿摆动）。 */
  hipL: THREE.Group;
  hipR: THREE.Group;
  /** 膝关节（旋转 = 小腿屈曲）。 */
  kneeL: THREE.Group;
  kneeR: THREE.Group;
  /** 肩关节（旋转 = 手臂摆动）。 */
  shoulderL: THREE.Group;
  shoulderR: THREE.Group;
  /** 尾根枢轴（走路时左右甩）。 */
  tail: THREE.Group;
}

/**
 * 角色化身模型。使用方（`remote-players.ts`）只负责喂位置/朝向/速度，
 * 所有骨骼公式都在本类里，便于在 Node 里单测。
 */
export class AvatarModel {
  public readonly root: THREE.Group;
  public readonly rig: AvatarRig;
  public readonly handAnchor: THREE.Object3D;
  /** 16 个骨架部件对应的 mesh。 */
  public readonly parts: ReadonlyMap<string, THREE.Mesh>;
  /** 按槽位索引的 6 组手持道具（同一时刻只有一组 visible）。 */
  public readonly weaponGroups: readonly THREE.Group[];
  public readonly materials: AvatarMaterials;
  public readonly team: TeamId;
  public readonly character: CharacterId;
  /** 视觉总高（由部件实测得出，验收项：必须 === PLAYER_HEIGHT）。 */
  public readonly totalHeight: number;
  private currentSlot = -1;

  public constructor(team: TeamId, character: CharacterId = "tom") {
    this.team = team;
    this.character = character;
    this.materials = avatarMaterials(character, team);
    const style: CharacterStyle = CHARACTER_STYLES[character];
    const widthScale: number = style.bodyScale;

    this.root = new THREE.Group();
    this.root.name = `avatar-${team}-${character}`;

    // 倒地枢轴：y = 0.13，模型整体再下移 0.13 保持脚底在 0
    this.rig = {
      fallPivot: new THREE.Group(),
      torsoPivot: new THREE.Group(),
      hipL: new THREE.Group(),
      hipR: new THREE.Group(),
      kneeL: new THREE.Group(),
      kneeR: new THREE.Group(),
      shoulderL: new THREE.Group(),
      shoulderR: new THREE.Group(),
      tail: new THREE.Group(),
    };
    const { fallPivot, torsoPivot, hipL, hipR, kneeL, kneeR, shoulderL, shoulderR, tail } = this.rig;
    fallPivot.position.y = FALL_PIVOT_Y;
    this.root.add(fallPivot);

    const body = new THREE.Group();
    body.position.y = -FALL_PIVOT_Y;
    fallPivot.add(body);

    const parts = new Map<string, THREE.Mesh>();
    const specByName = new Map<string, AvatarPartSpec>(AVATAR_PARTS.map((spec) => [spec.name, spec]));
    const requirePart = (name: string): AvatarPartSpec => {
      const spec = specByName.get(name);
      if (spec === undefined) {
        throw new Error(`AVATAR_PARTS 缺少 ${name}`);
      }
      return spec;
    };

    /** 按角色体型系数收窄尺寸（只改视觉，不改 `AVATAR_PARTS` 里的基准值）。 */
    const narrow = (spec: AvatarPartSpec): AvatarPartSpec => ({
      ...spec,
      size: { x: spec.size.x * widthScale, y: spec.size.y, z: spec.size.z * widthScale },
    });

    // ---- 躯干组（含头/口鼻/尾根/骨盆，绕腰线枢轴摆动）----
    torsoPivot.position.y = WAIST_Y;
    body.add(torsoPivot);

    const attachTorso = (name: string): THREE.Mesh => {
      const spec = requirePart(name);
      // 头与口鼻按 headScale 单独放大（不乘 bodyScale），身体按 bodyScale 收窄
      const isHead: boolean = name === "head" || name === "crest" || name === "muzzle";
      const scaled: AvatarPartSpec = isHead
        ? {
            ...spec,
            size: {
              x: spec.size.x * style.headScale,
              y: spec.size.y,
              z: spec.size.z * (name === "muzzle" ? 1 : style.headScale),
            },
            pos: { ...spec.pos, z: spec.pos.z * (name === "muzzle" ? style.headScale : 1) },
          }
        : narrow(spec);
      const mesh = createMesh(scaled, this.materials);
      mesh.position.set(scaled.pos.x, scaled.pos.y - WAIST_Y, scaled.pos.z);
      torsoPivot.add(mesh);
      parts.set(name, mesh);
      return mesh;
    };
    attachTorso("torso");
    attachTorso("pelvis");
    attachTorso("tailBase");
    attachTorso("head");
    attachTorso("crest");
    attachTorso("muzzle");

    // ---- 尾巴：尾根枢轴 → 4 节，逐节向后上翘 ----
    tail.position.set(0, PELVIS_CENTER_Y + 0.02, TAIL_BASE_Z + 0.02);
    body.add(tail);
    {
      const segments = 4;
      const segmentLength = 0.115 * style.tailLength;
      const radius = 0.026 * (0.9 + style.tailLength * 0.2);
      let parent: THREE.Object3D = tail;
      for (let i = 0; i < segments; i += 1) {
        const joint = new THREE.Group();
        joint.position.y = i === 0 ? 0 : segmentLength;
        // 每节额外后仰：尾巴先向后、再向上卷，像被风吹起来
        joint.rotation.x = -0.34 - i * 0.1;
        parent.add(joint);
        const mesh = new THREE.Mesh(
          createPrimitive({ geometry: "capsule", size: { x: radius * 2, y: segmentLength + radius, z: radius * 2 } }),
          this.materials.fur,
        );
        mesh.position.y = segmentLength / 2;
        mesh.castShadow = true;
        joint.add(mesh);
        parent = joint;
      }
      // 尾尖：小圆球收口（猫尾比圆柱自然得多）
      const tip = new THREE.Mesh(
        createPrimitive({ geometry: "ellipsoid", size: { x: radius * 2.2, y: radius * 2.6, z: radius * 2.2 } }),
        this.materials.fur,
      );
      tip.scale.set(radius * 2.2, radius * 2.6, radius * 2.2);
      tip.position.y = segmentLength;
      parent.add(tip);
    }

    // ---- 手臂：肩枢轴在 world SHOULDER_Y，肘枢轴再下 UPPER_ARM_HEIGHT ----
    const attachArm = (side: -1 | 1, shoulder: THREE.Group, elbowHolder: { elbow: THREE.Group | null }): void => {
      shoulder.position.set(side * ARM_VISUAL_X * widthScale, SHOULDER_Y - WAIST_Y, 0);
      torsoPivot.add(shoulder);

      const upperSpec = narrow(requirePart(side < 0 ? "upperArmL" : "upperArmR"));
      const upperMesh = createMesh(upperSpec, this.materials);
      upperMesh.position.set(0, -UPPER_ARM_HEIGHT / 2, 0);
      shoulder.add(upperMesh);
      parts.set(side < 0 ? "upperArmL" : "upperArmR", upperMesh);

      const elbow = new THREE.Group();
      elbow.position.set(0, -UPPER_ARM_HEIGHT, 0);
      shoulder.add(elbow);
      elbowHolder.elbow = elbow;

      const foreSpec = narrow(requirePart(side < 0 ? "foreArmL" : "foreArmR"));
      const foreMesh = createMesh(foreSpec, this.materials);
      foreMesh.position.set(0, -FOREARM_HEIGHT / 2, 0);
      elbow.add(foreMesh);
      parts.set(side < 0 ? "foreArmL" : "foreArmR", foreMesh);
    };
    const leftElbow: { elbow: THREE.Group | null } = { elbow: null };
    const rightElbow: { elbow: THREE.Group | null } = { elbow: null };
    attachArm(-1, shoulderL, leftElbow);
    attachArm(1, shoulderR, rightElbow);

    // ---- 腿：髋枢轴 → 大腿；膝枢轴 → 小腿 + 脚 ----
    const attachLeg = (side: -1 | 1, hip: THREE.Group, knee: THREE.Group, thighName: string, shinName: string, footName: string): void => {
      hip.position.set(side * LEG_X * widthScale, HIP_Y, 0);
      body.add(hip);

      const thighSpec = narrow(requirePart(thighName));
      const thighMesh = createMesh(thighSpec, this.materials);
      thighMesh.position.set(0, -THIGH_HEIGHT / 2, 0);
      hip.add(thighMesh);
      parts.set(thighName, thighMesh);

      knee.position.set(0, -THIGH_HEIGHT, 0);
      hip.add(knee);

      const shinSpec = narrow(requirePart(shinName));
      const shinMesh = createMesh(shinSpec, this.materials);
      shinMesh.position.set(0, -SHIN_HEIGHT / 2, 0);
      knee.add(shinMesh);
      parts.set(shinName, shinMesh);

      const footSpec = requirePart(footName);
      const footMesh = createMesh(footSpec, this.materials);
      // 脚底贴地：相对膝枢轴 = −(小腿高 + 脚半高)
      footMesh.position.set(0, -(SHIN_HEIGHT + FOOT_HEIGHT / 2), FOOT_Z);
      knee.add(footMesh);
      parts.set(footName, footMesh);
    };
    attachLeg(-1, hipL, kneeL, "thighL", "shinL", "footL");
    attachLeg(1, hipR, kneeR, "thighR", "shinR", "footR");

    this.parts = parts;

    // ---- 角色装饰件：只挂骨骼、不进 parts 表（不参与判定，也不改总高）----
    const decorGroups: Record<AvatarDecorParent, THREE.Object3D | null> = {
      torso: torsoPivot,
      shoulderL,
      shoulderR,
      elbowL: leftElbow.elbow,
      elbowR: rightElbow.elbow,
      hipL,
      hipR,
      kneeL,
      kneeR,
      foreArmL: leftElbow.elbow,
      foreArmR: rightElbow.elbow,
    };
    for (const decor of avatarDecor(character)) {
      const target = decorGroups[decor.parent];
      if (target === null) {
        continue;
      }
      const mesh = createMesh(decor, this.materials);
      mesh.name = `decor-${decor.parent}`;
      mesh.castShadow = false;
      // 躯干件的 pos.y 写的是**世界高度**，挂到腰线枢轴要减掉 WAIST_Y；关节件是局部坐标，原样
      const offsetY: number = decor.parent === "torso" ? WAIST_Y : 0;
      mesh.position.set(decor.pos.x, decor.pos.y - offsetY, decor.pos.z);
      target.add(mesh);
    }

    // ---- 武器挂点：右前臂子节点 ----
    // 规格要求 `rotation.y = π`；武器模型按「枪口朝 −Z」建模，所以挂点内部再加一层 π 的
    // mount 抵消，净效果 = 道具朝世界 −Z = 角色正前方。
    const handAnchor = new THREE.Object3D();
    handAnchor.name = "handAnchor";
    handAnchor.position.set(HAND_ANCHOR_LOCAL.x, HAND_ANCHOR_LOCAL.y, HAND_ANCHOR_LOCAL.z);
    handAnchor.rotation.y = Math.PI;
    const elbowR = rightElbow.elbow;
    if (elbowR === null) {
      throw new Error("右手肘枢轴未创建");
    }
    elbowR.add(handAnchor);
    const weaponMount = new THREE.Group();
    weaponMount.rotation.y = Math.PI;
    handAnchor.add(weaponMount);
    this.handAnchor = handAnchor;

    // ---- 6 组手持道具（按槽位索引）----
    const weaponGroups: THREE.Group[] = [];
    for (let slot = 0; slot < WEAPON_SPECS.length; slot += 1) {
      const specs = WEAPON_SPECS[slot] as readonly WeaponMeshSpec[];
      const group = new THREE.Group();
      group.name = `weapon-${slot}`;
      for (const weaponSpec of specs) {
        group.add(createMesh(weaponSpec, this.materials));
      }
      group.visible = false;
      weaponMount.add(group);
      weaponGroups.push(group);
    }
    this.weaponGroups = weaponGroups;
    this.setWeaponSlot(0);

    // ---- 实测总高（验收项：必须等于 PLAYER_HEIGHT）----
    let top = 0;
    for (const spec of AVATAR_PARTS) {
      top = Math.max(top, spec.pos.y + spec.size.y / 2);
    }
    this.totalHeight = top;
  }

  /** 切武器：立刻切 visible（不做淡入，切枪由第一人称动画掩盖）。 */
  public setWeaponSlot(slot: number): void {
    const index = Math.max(0, Math.min(this.weaponGroups.length - 1, Math.trunc(slot)));
    if (index === this.currentSlot) {
      return;
    }
    this.currentSlot = index;
    for (let i = 0; i < this.weaponGroups.length; i += 1) {
      (this.weaponGroups[i] as THREE.Group).visible = i === index;
    }
  }

  /** 当前道具槽位。 */
  public get weaponSlot(): number {
    return this.currentSlot;
  }

  /**
   * 行走摆动（文档 2.3 公式 + 尾巴甩动）。
   *
   * @param phase 相位（rad），由 `bobPhase += horizontalSpeed * BOB_RAD_PER_METER * dt` 推进
   * @param amp 摆幅 0–1（带淡入；离地时外部乘 0.5）
   */
  public poseLocomotion(phase: number, amp: number): void {
    const a = Math.max(0, Math.min(1, amp));
    const { hipL, hipR, kneeL, kneeR, shoulderL, shoulderR, torsoPivot, tail } = this.rig;

    hipL.rotation.x = Math.sin(phase) * LEG_SWING * a;
    hipR.rotation.x = Math.sin(phase + Math.PI) * LEG_SWING * a;
    kneeL.rotation.x = -KNEE_BEND * Math.max(0, Math.sin(phase - 0.6)) * a;
    kneeR.rotation.x = -KNEE_BEND * Math.max(0, Math.sin(phase + Math.PI - 0.6)) * a;
    // 左臂与左腿反相，持物臂幅度更小
    shoulderL.rotation.x = Math.sin(phase + Math.PI) * ARM_SWING * a;
    shoulderR.rotation.x = Math.sin(phase) * GUN_ARM_SWING * a;
    torsoPivot.position.y = WAIST_Y + TORSO_BOB * Math.sin(phase * 2) * a;
    torsoPivot.rotation.z = TORSO_ROLL * Math.sin(phase) * a;
    // 尾巴：低频左右甩 + 走动时抬起。频率取相位的一半，避免和腿"同频抖动"看起来像抽筋。
    tail.rotation.y = Math.sin(phase * 0.5) * (0.16 + 0.22 * a);
    tail.rotation.x = -0.06 - 0.12 * a;
  }

  /**
   * 倒地进度。
   *
   * @param progress 0 = 站立，1 = 完全躺平；外部用 600ms 缓出推进
   */
  public poseFall(progress: number): void {
    const p = Math.max(0, Math.min(1, progress));
    // 缓出：前段快、后段慢，落地有重量感
    const eased = 1 - (1 - p) ** 3;
    this.rig.fallPivot.rotation.x = (Math.PI / 2) * eased;
    // 起身/倒下的"膝盖发软"补偿：中途微微抬起 3cm
    this.rig.fallPivot.position.y = FALL_PIVOT_Y + 0.03 * Math.sin(Math.PI * p);
  }

  /** 复位（重生）：站直、四肢归零、保留相位不重置。 */
  public resetFall(): void {
    this.rig.fallPivot.rotation.x = 0;
    this.rig.fallPivot.position.y = FALL_PIVOT_Y;
    this.poseLocomotion(0, 0);
  }

  /**
   * 释放本 avatar 独占的资源。
   *
   * 现在**几何也是共享的**（见 `geometryCache`），所以这里不再 dispose 任何东西：
   * 一局里第一个离场的玩家就会把别人的腿一起释放掉，画面直接变黑。
   * 真正的释放在 `disposeAvatarGeometries` / `disposeAvatarMaterials`，整局销毁时调用。
   * 保留这个方法是为了让调用方（`remote-players`）的接口不用改。
   */
  public dispose(): void {
    this.root.clear();
  }
}

/** 便捷工厂（等价于 `new AvatarModel(team, character)`）。 */
export function buildAvatarModel(team: TeamId, character: CharacterId = "tom"): AvatarModel {
  return new AvatarModel(team, character);
}

/** 下标版工厂：状态同步拿到的是 `uint8`，这里统一转成 id（非法值回退默认角色）。 */
export function buildAvatarModelOfIndex(team: TeamId, characterIndex: number): AvatarModel {
  return new AvatarModel(team, characterOfIndex(characterIndex));
}

/** 手部挂点的世界位置（调试/血雾定位用）。 */
export function handWorldPosition(model: AvatarModel, target: THREE.Vector3): THREE.Vector3 {
  return model.handAnchor.getWorldPosition(target);
}
