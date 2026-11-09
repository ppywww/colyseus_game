/**
 * 第三人称人形化身（13 项实体部件 + 1 个武器挂点 + 6 个武器模型）。
 *
 * 两条硬约束（改动前请先读）：
 *   1. **尺寸必须由 `PLAYER_HITBOXES` 推导**，不允许在客户端手写第二套数字 ——
 *      判定体、外观、第一人称视模型三条线必须同源，否则又会回到"打不中还击"。
 *      头部判定段现在是 `[1.63, 1.80] / r0.13`（旧版 1.54 会让眼高 1.60 的平射每发爆头）。
 *   2. **材质按队伍共享**：每个队伍只有 4 个 `MeshStandardMaterial` 实例，所有同队 avatar 复用，
 *      避免 8 人局每帧 new/dispose 造成 GC 抖动。代价是无法逐 avatar 改 opacity
 *      （死亡不做淡出，直接按"重生瞬间复位"处理，见 `resetFall()`）。
 *
 * 坐标系：root 原点 = 脚底中心，前方 = −Z（与 `root.rotation.y = yaw`、yaw=0 朝 −Z 一致）。
 */

import * as THREE from "three";

import {
  PLAYER_HEIGHT,
  PLAYER_HITBOXES,
  THROWABLES,
  THROWABLE_TYPES,
  type HitCylinder,
  type HitZone,
  type TeamId,
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

/** 头（球）：判定体宽 2×0.13，视觉收窄 4.5cm → 直径 0.17，头顶正好等于 PLAYER_HEIGHT。 */
export const HEAD_RADIUS: number = HEAD.radius - 0.045;
export const HEAD_CENTER_Y: number = PLAYER_HEIGHT - HEAD_RADIUS;
/** 头盔：圆柱，顶面必须正好压在 PLAYER_HEIGHT 上（总高验收项）。 */
export const HELMET_HEIGHT: number = 0.05;
export const HELMET_RADIUS: number = HEAD.radius - 0.035;
export const HELMET_CENTER_Y: number = PLAYER_HEIGHT - HELMET_HEIGHT / 2;

/** 躯干：宽 = 判定体直径 − 0.12（判定体比模型宽 1–3cm/侧），高 = 胸段高度。 */
export const TORSO_WIDTH: number = CHEST.radius * 2 - 0.12;
export const TORSO_HEIGHT: number = CHEST.yMax - CHEST.yMin;
export const TORSO_DEPTH: number = 0.26;
export const TORSO_CENTER_Y: number = (CHEST.yMin + CHEST.yMax) / 2;

/** 骨盆：压在腹段顶部（腰线），宽度 = 腹段直径 − 0.16。 */
export const PELVIS_WIDTH: number = BELLY.radius * 2 - 0.16;
export const PELVIS_HEIGHT: number = 0.18;
export const PELVIS_DEPTH: number = 0.24;
export const PELVIS_CENTER_Y: number = BELLY.yMax - PELVIS_HEIGHT / 2;

/** 腰线：躯干摆动/侧倾的枢轴高度。 */
export const WAIST_Y: number = PELVIS_CENTER_Y;

/** 背包：贴着躯干背面。 */
export const BACKPACK_WIDTH: number = TORSO_WIDTH - 0.12;
export const BACKPACK_HEIGHT: number = 0.22;
export const BACKPACK_DEPTH: number = 0.1;
export const BACKPACK_Z: number = TORSO_DEPTH / 2 + BACKPACK_DEPTH / 2;

/** 手臂：肩枢轴取臂段顶 − 2cm，上臂 + 前臂正好拼回臂段高度（0.28 + 0.24 = 0.52）。 */
export const SHOULDER_Y: number = ARM.yMax - 0.02;
export const UPPER_ARM_HEIGHT: number = 0.28;
export const FOREARM_HEIGHT: number = 0.24;
export const ELBOW_Y: number = SHOULDER_Y - UPPER_ARM_HEIGHT;
export const UPPER_ARM_WIDTH: number = ARM.radius * 2 * 0.55;
export const FOREARM_WIDTH: number = ARM.radius * 2 * 0.5;
export const ARM_X: number = ARM.offsetRight;

/** 腿：髋枢轴取腹段下沿 + 5cm，大腿/小腿平分（脚高 0.07 从腿段底部让出）。 */
export const HIP_Y: number = BELLY.yMin + 0.05;
export const FOOT_HEIGHT: number = 0.07;
const LEG_AVAILABLE: number = HIP_Y - FOOT_HEIGHT;
export const THIGH_HEIGHT: number = LEG_AVAILABLE / 2;
export const SHIN_HEIGHT: number = LEG_AVAILABLE / 2;
export const KNEE_Y: number = HIP_Y - THIGH_HEIGHT;
export const THIGH_WIDTH: number = LEG.radius * 0.75;
export const SHIN_WIDTH: number = LEG.radius * 0.65;
export const FOOT_WIDTH: number = LEG.radius * 0.65;
export const FOOT_DEPTH: number = 0.26;
export const FOOT_Z: number = -0.04;
export const LEG_X: number = LEG.radius * 0.475;

/** 倒地枢轴：躯干半厚度，倒地后脊柱轴心离地 0.13m，躯干面正好贴地。 */
export const FALL_PIVOT_Y: number = 0.13;

/** 手部挂点的世界位置（规格 2.2 第 14 行：(0.24, 1.12, −0.20)）。 */
export const HAND_ANCHOR_WORLD = { x: ARM.offsetRight - 0.06, y: 1.12, z: -0.2 } as const;

/** 手部挂点相对**肘枢轴**的局部偏移（挂点是右前臂的子节点，所以要减掉臂的 x 与肘的 y）。 */
export const HAND_ANCHOR_LOCAL = {
  x: HAND_ANCHOR_WORLD.x - ARM.offsetRight,
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
 * 配色与材质（按队伍共享）
 * ------------------------------------------------------------------ */

export type AvatarMaterialKind =
  | "cloth"
  | "skin"
  | "gear"
  | "dark"
  /** 牛仔裤（比夹克深一号的蓝灰，和上衣拉开层次）。 */
  | "denim"
  /** 战术靴（沙色/深棕，脚部一眼能看出不是"黑棍"）。 */
  | "boot"
  /** 高亮识别色（胸前的 FBI 贴条）。 */
  | "accent"
  /** 刀身（蓝色多普勒，两队共用同一抹冷蓝）。 */
  | "blade";

export type AvatarMaterials = Record<AvatarMaterialKind, THREE.MeshStandardMaterial>;

/** 两队可辨识优先：禁止用 sessionId 哈希取色（队友与敌人会撞色）。 */
export const AVATAR_PALETTE: Record<TeamId, Record<AvatarMaterialKind, number>> = {
  // T：沙漠民兵（卡其 / 深棕 / 旧皮革）
  T: {
    cloth: 0xa06b3c,
    gear: 0x4a3a26,
    skin: 0xd9a97f,
    dark: 0x201a14,
    denim: 0x4a3f33,
    boot: 0x3b3027,
    accent: 0xc0392b,
    blade: 0x3f74c8,
  },
  // CT：参考图里的 FBI 特警——藏青夹克 + 黑色战术背心 + 牛仔裤 + 沙色战术靴
  CT: {
    cloth: 0x3c5584,
    gear: 0x232935,
    skin: 0xd9a97f,
    dark: 0x14171e,
    denim: 0x44546f,
    boot: 0x8a7351,
    accent: 0xd8b53f,
    blade: 0x3f74c8,
  },
};

const teamMaterialCache = new Map<TeamId, AvatarMaterials>();
const throwableMaterialCache = new Map<number, THREE.MeshStandardMaterial>();

function createMaterials(team: TeamId): AvatarMaterials {
  const palette = AVATAR_PALETTE[team];
  const make = (color: number): THREE.MeshStandardMaterial =>
    new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.05 });
  return {
    cloth: make(palette.cloth),
    skin: make(palette.skin),
    gear: make(palette.gear),
    dark: make(palette.dark),
    denim: make(palette.denim),
    boot: make(palette.boot),
    accent: make(palette.accent),
    // 刀身单独给金属参数：低粗糙 + 高金属度才有"刀"的反光，不能混进布料的 make()
    blade: new THREE.MeshStandardMaterial({
      color: palette.blade,
      roughness: 0.18,
      metalness: 0.92,
      emissive: 0x0d2a5c,
      emissiveIntensity: 0.35,
    }),
  };
}

/**
 * 取某队伍的材质集合（**模块级缓存**：同队 9 个 avatar 共享同一批实例）。
 */
export function avatarMaterials(team: TeamId): AvatarMaterials {
  const cached = teamMaterialCache.get(team);
  if (cached !== undefined) {
    return cached;
  }
  const created = createMaterials(team);
  teamMaterialCache.set(team, created);
  return created;
}

/** 投掷物颜色（`THROWABLES[type].color`），三种颜色各一个共享材质。 */
function throwableMaterial(color: number): THREE.MeshStandardMaterial {
  const cached = throwableMaterialCache.get(color);
  if (cached !== undefined) {
    return cached;
  }
  const created = new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.1 });
  throwableMaterialCache.set(color, created);
  return created;
}

/** 释放全部共享材质（只在整局销毁时调用，avatar 自身 dispose 不碰材质）。 */
export function disposeAvatarMaterials(): void {
  for (const materials of teamMaterialCache.values()) {
    for (const material of Object.values(materials)) {
      material.dispose();
    }
  }
  teamMaterialCache.clear();
  for (const material of throwableMaterialCache.values()) {
    material.dispose();
  }
  throwableMaterialCache.clear();
}

/* ------------------------------------------------------------------ *
 * 部件规格表（13 项实体部件；脚与小腿同属一行，拆开后是 16 个 mesh）
 * ------------------------------------------------------------------ */

export type AvatarPartGeometry = "box" | "sphere" | "cylinder";

export interface AvatarPartSpec {
  /** 部件名（也是 `parts` map 的键）。 */
  name: string;
  /** 中文名，便于报告与调试。 */
  label: string;
  geometry: AvatarPartGeometry;
  /** box: w/h/d；sphere: r/r/r；cylinder: r/h/r（直径口径与 CylinderGeometry 一致）。 */
  size: { x: number; y: number; z: number };
  /** 相对脚底中心的绝对位置（构树时再换算成父节点局部坐标）。 */
  pos: { x: number; y: number; z: number };
  material: AvatarMaterialKind;
}

/** 13 项部件（规格 2.2 的 1–13 行；脚随小腿，所以 mesh 数是 16）。 */
export const AVATAR_PARTS: readonly AvatarPartSpec[] = [
  {
    name: "head",
    label: "头",
    geometry: "sphere",
    size: { x: HEAD_RADIUS, y: HEAD_RADIUS, z: HEAD_RADIUS },
    pos: { x: 0, y: HEAD_CENTER_Y, z: 0 },
    material: "skin",
  },
  {
    name: "helmet",
    label: "头盔",
    geometry: "cylinder",
    size: { x: HELMET_RADIUS * 2, y: HELMET_HEIGHT, z: HELMET_RADIUS * 2 },
    pos: { x: 0, y: HELMET_CENTER_Y, z: 0 },
    material: "gear",
  },
  {
    name: "visor",
    label: "面罩",
    geometry: "box",
    size: { x: 0.16, y: 0.05, z: 0.04 },
    pos: { x: 0, y: HEAD_CENTER_Y - 0.015, z: -HEAD_RADIUS },
    material: "dark",
  },
  {
    name: "torso",
    label: "躯干",
    geometry: "box",
    size: { x: TORSO_WIDTH, y: TORSO_HEIGHT, z: TORSO_DEPTH },
    pos: { x: 0, y: TORSO_CENTER_Y, z: 0 },
    material: "cloth",
  },
  {
    name: "pelvis",
    label: "骨盆",
    geometry: "box",
    size: { x: PELVIS_WIDTH, y: PELVIS_HEIGHT, z: PELVIS_DEPTH },
    pos: { x: 0, y: PELVIS_CENTER_Y, z: 0 },
    material: "cloth",
  },
  {
    name: "backpack",
    label: "背包",
    geometry: "box",
    size: { x: BACKPACK_WIDTH, y: BACKPACK_HEIGHT, z: BACKPACK_DEPTH },
    pos: { x: 0, y: TORSO_CENTER_Y, z: BACKPACK_Z },
    material: "gear",
  },
  {
    name: "upperArmL",
    label: "左上臂",
    geometry: "box",
    size: { x: UPPER_ARM_WIDTH, y: UPPER_ARM_HEIGHT, z: UPPER_ARM_WIDTH },
    pos: { x: -ARM_X, y: SHOULDER_Y - UPPER_ARM_HEIGHT / 2, z: 0 },
    material: "cloth",
  },
  {
    name: "foreArmL",
    label: "左前臂",
    geometry: "box",
    size: { x: FOREARM_WIDTH, y: FOREARM_HEIGHT, z: FOREARM_WIDTH },
    pos: { x: -ARM_X, y: ELBOW_Y - FOREARM_HEIGHT / 2, z: 0 },
    material: "cloth",
  },
  {
    name: "upperArmR",
    label: "右上臂",
    geometry: "box",
    size: { x: UPPER_ARM_WIDTH, y: UPPER_ARM_HEIGHT, z: UPPER_ARM_WIDTH },
    pos: { x: ARM_X, y: SHOULDER_Y - UPPER_ARM_HEIGHT / 2, z: 0 },
    material: "cloth",
  },
  {
    name: "foreArmR",
    label: "右前臂",
    geometry: "box",
    size: { x: FOREARM_WIDTH, y: FOREARM_HEIGHT, z: FOREARM_WIDTH },
    pos: { x: ARM_X, y: ELBOW_Y - FOREARM_HEIGHT / 2, z: 0 },
    material: "cloth",
  },
  {
    name: "thighL",
    label: "左大腿",
    geometry: "box",
    size: { x: THIGH_WIDTH, y: THIGH_HEIGHT, z: THIGH_WIDTH },
    pos: { x: -LEG_X, y: HIP_Y - THIGH_HEIGHT / 2, z: 0 },
    material: "denim",
  },
  {
    name: "thighR",
    label: "右大腿",
    geometry: "box",
    size: { x: THIGH_WIDTH, y: THIGH_HEIGHT, z: THIGH_WIDTH },
    pos: { x: LEG_X, y: HIP_Y - THIGH_HEIGHT / 2, z: 0 },
    material: "denim",
  },
  {
    name: "shinL",
    label: "左小腿",
    geometry: "box",
    size: { x: SHIN_WIDTH, y: SHIN_HEIGHT, z: SHIN_WIDTH },
    pos: { x: -LEG_X, y: KNEE_Y - SHIN_HEIGHT / 2, z: 0 },
    material: "denim",
  },
  {
    name: "shinR",
    label: "右小腿",
    geometry: "box",
    size: { x: SHIN_WIDTH, y: SHIN_HEIGHT, z: SHIN_WIDTH },
    pos: { x: LEG_X, y: KNEE_Y - SHIN_HEIGHT / 2, z: 0 },
    material: "denim",
  },
  {
    name: "footL",
    label: "左脚",
    geometry: "box",
    size: { x: FOOT_WIDTH, y: FOOT_HEIGHT, z: FOOT_DEPTH },
    pos: { x: -LEG_X, y: FOOT_HEIGHT / 2, z: FOOT_Z },
    material: "boot",
  },
  {
    name: "footR",
    label: "右脚",
    geometry: "box",
    size: { x: FOOT_WIDTH, y: FOOT_HEIGHT, z: FOOT_DEPTH },
    pos: { x: LEG_X, y: FOOT_HEIGHT / 2, z: FOOT_Z },
    material: "boot",
  },
];

/* ------------------------------------------------------------------ *
 * 纯装饰件（参考图细节：棒球帽檐、耳机、战术背心与弹匣袋、FBI 贴条、腿挂枪套）
 *
 * **不进入 `parts` 表**：这些件不参与任何判定，也不该被「16 个判定部件」的
 * 验收用例卡住。它们挂在既有的骨骼组上（躯干枢轴 / 右髋），跟随行走、下蹲、倒地。
 * ------------------------------------------------------------------ */

export type AvatarDecorParent = "torso" | "thighR" | "thighL";

export interface AvatarDecorSpec extends MeshSpecLike {
  /** 挂点：躯干的 y 用世界高度，大腿的 y 用相对髋枢轴的局部坐标（向下为负）。 */
  parent: AvatarDecorParent;
}

export const AVATAR_DECOR: readonly AvatarDecorSpec[] = [
  // ---- 头部：棒球帽檐 + 耳机两侧耳罩 + 麦克风 ----
  { parent: "torso", geometry: "box", size: { x: 0.2, y: 0.016, z: 0.1 },
    pos: { x: 0, y: PLAYER_HEIGHT - 0.052, z: -0.105 }, material: "gear" },
  // 耳罩必须贴在**视觉头半径**（HEAD_RADIUS）外侧，不能用判定半径 0.13 来摆——
  // 判定体比模型宽 4.5cm/侧，照着判定摆会让耳机悬空飞在耳朵外 6cm。
  { parent: "torso", geometry: "box", size: { x: 0.028, y: 0.062, z: 0.056 },
    pos: { x: -(HEAD_RADIUS + 0.012), y: HEAD_CENTER_Y, z: 0.004 }, material: "gear" },
  { parent: "torso", geometry: "box", size: { x: 0.028, y: 0.062, z: 0.056 },
    pos: { x: HEAD_RADIUS + 0.012, y: HEAD_CENTER_Y, z: 0.004 }, material: "gear" },
  // 麦克风：从右耳罩往前下伸，起点同样贴头面
  { parent: "torso", geometry: "box", size: { x: 0.011, y: 0.011, z: 0.085 },
    pos: { x: HEAD_RADIUS - 0.004, y: HEAD_CENTER_Y - 0.052, z: -0.05 }, rotY: -0.5, material: "dark" },

  // ---- 躯干：前后战术背心 + 三个弹匣袋 + 黄色 FBI 贴条 + 肩垫 ----
  { parent: "torso", geometry: "box", size: { x: TORSO_WIDTH - 0.02, y: TORSO_HEIGHT * 0.92, z: 0.05 },
    pos: { x: 0, y: TORSO_CENTER_Y + 0.01, z: -TORSO_DEPTH / 2 - 0.012 }, material: "gear" },
  { parent: "torso", geometry: "box", size: { x: TORSO_WIDTH - 0.02, y: TORSO_HEIGHT * 0.78, z: 0.045 },
    pos: { x: 0, y: TORSO_CENTER_Y - 0.02, z: TORSO_DEPTH / 2 + 0.012 }, material: "gear" },
  { parent: "torso", geometry: "box", size: { x: 0.075, y: 0.085, z: 0.026 },
    pos: { x: -0.088, y: TORSO_CENTER_Y - 0.09, z: -TORSO_DEPTH / 2 - 0.045 }, material: "gear" },
  { parent: "torso", geometry: "box", size: { x: 0.075, y: 0.085, z: 0.026 },
    pos: { x: 0, y: TORSO_CENTER_Y - 0.09, z: -TORSO_DEPTH / 2 - 0.045 }, material: "gear" },
  { parent: "torso", geometry: "box", size: { x: 0.075, y: 0.085, z: 0.026 },
    pos: { x: 0.088, y: TORSO_CENTER_Y - 0.09, z: -TORSO_DEPTH / 2 - 0.045 }, material: "gear" },
  { parent: "torso", geometry: "box", size: { x: 0.092, y: 0.022, z: 0.006 },
    pos: { x: 0.062, y: TORSO_CENTER_Y + 0.105, z: -TORSO_DEPTH / 2 - 0.05 }, material: "accent" },
  { parent: "torso", geometry: "box", size: { x: 0.08, y: 0.06, z: 0.15 },
    pos: { x: -(ARM_X - 0.005), y: SHOULDER_Y - 0.028, z: 0 }, material: "gear" },
  { parent: "torso", geometry: "box", size: { x: 0.08, y: 0.06, z: 0.15 },
    pos: { x: ARM_X - 0.005, y: SHOULDER_Y - 0.028, z: 0 }, material: "gear" },

  // ---- 右腿：腿挂枪套 + 绑带（参考图里最显眼的那块装备） ----
  { parent: "thighR", geometry: "box", size: { x: 0.088, y: 0.15, z: 0.075 },
    pos: { x: 0.025, y: -THIGH_HEIGHT * 0.52, z: -0.045 }, material: "gear" },
  { parent: "thighR", geometry: "box", size: { x: 0.1, y: 0.022, z: 0.085 },
    pos: { x: 0.025, y: -THIGH_HEIGHT * 0.3, z: -0.04 }, material: "dark" },
];

/* ------------------------------------------------------------------ *
 * 手持武器（6 个槽位各一组，挂 handAnchor 下）
 * ------------------------------------------------------------------ */

interface WeaponMeshSpec {
  geometry: "box" | "sphere" | "cylinder";
  size: { x: number; y: number; z: number };
  pos: { x: number; y: number; z: number };
  /** 绕 X 轴旋转（握把前倾、圆柱改朝 Z 等）。 */
  rotX?: number;
  material: AvatarMaterialKind | "throwable";
  /** 投掷物颜色（material === "throwable" 时使用）。 */
  color?: number;
}
const RIFLE_MESHES: readonly WeaponMeshSpec[] = [
  { geometry: "box", size: { x: 0.07, y: 0.1, z: 0.42 }, pos: { x: 0, y: 0, z: 0 }, material: "dark" },
  { geometry: "cylinder", size: { x: 0.028, y: 0.26, z: 0.028 }, pos: { x: 0, y: 0.02, z: -0.34 }, rotX: Math.PI / 2, material: "dark" },
  { geometry: "box", size: { x: 0.05, y: 0.16, z: 0.08 }, pos: { x: 0, y: -0.09, z: -0.06 }, material: "gear" },
  { geometry: "box", size: { x: 0.05, y: 0.08, z: 0.22 }, pos: { x: 0, y: -0.01, z: 0.28 }, material: "gear" },
];

const PISTOL_MESHES: readonly WeaponMeshSpec[] = [
  { geometry: "box", size: { x: 0.035, y: 0.05, z: 0.2 }, pos: { x: 0, y: 0, z: -0.02 }, material: "dark" },
  { geometry: "box", size: { x: 0.035, y: 0.11, z: 0.05 }, pos: { x: 0, y: -0.07, z: 0.06 }, rotX: 0.3, material: "dark" },
];

/**
 * 蝴蝶刀（第三人称）：展开态——刀身朝 −Z 逐段收窄，双柄折在刀根后方并排成握把。
 *
 * 第三人称距离远，只要轮廓对（细长蓝刀 + 明显两根柄 + 轴销）就够，不做刀身倒角。
 * 蓝色的色相来自 `blade` 材质，刀柄用 `dark`（石墨黑），一眼能和步枪/手枪区分开。
 */
const KNIFE_MESHES: readonly WeaponMeshSpec[] = [
  // 刀身：三段收窄 + 刀尖，读起来有"渐薄"的锥度
  { geometry: "box", size: { x: 0.013, y: 0.05, z: 0.1 }, pos: { x: 0, y: 0.004, z: -0.07 }, material: "blade" },
  { geometry: "box", size: { x: 0.011, y: 0.042, z: 0.08 }, pos: { x: 0, y: 0.002, z: -0.155 }, material: "blade" },
  { geometry: "box", size: { x: 0.008, y: 0.026, z: 0.05 }, pos: { x: 0, y: 0, z: -0.215 }, material: "blade" },
  // 轴销（两根柄的转轴）
  { geometry: "box", size: { x: 0.05, y: 0.018, z: 0.02 }, pos: { x: 0, y: 0.002, z: -0.014 }, material: "gear" },
  // 双柄：并排两根，折在刀根后方当握把
  { geometry: "box", size: { x: 0.011, y: 0.044, z: 0.13 }, pos: { x: -0.014, y: 0.002, z: 0.065 }, material: "dark" },
  { geometry: "box", size: { x: 0.011, y: 0.044, z: 0.13 }, pos: { x: 0.014, y: 0.002, z: 0.065 }, material: "dark" },
  // 柄尾保险扣
  { geometry: "box", size: { x: 0.038, y: 0.014, z: 0.022 }, pos: { x: 0, y: 0.002, z: 0.128 }, material: "gear" },
];

function throwableMeshes(color: number): readonly WeaponMeshSpec[] {
  return [
    { geometry: "sphere", size: { x: 0.05, y: 0.05, z: 0.05 }, pos: { x: 0, y: 0, z: 0 }, material: "throwable", color },
    { geometry: "box", size: { x: 0.02, y: 0.02, z: 0.01 }, pos: { x: 0, y: 0.055, z: 0 }, material: "dark" },
  ];
}

/** 6 个槽位 → 网格清单（索引 = `WEAPON_SLOTS` 的值）。 */
const WEAPON_SPECS: readonly (readonly WeaponMeshSpec[])[] = [
  RIFLE_MESHES,
  PISTOL_MESHES,
  KNIFE_MESHES,
  throwableMeshes(THROWABLES[THROWABLE_TYPES.FRAG].color),
  throwableMeshes(THROWABLES[THROWABLE_TYPES.FLASH].color),
  throwableMeshes(THROWABLES[THROWABLE_TYPES.SMOKE].color),
];

/* ------------------------------------------------------------------ *
 * 构建
 * ------------------------------------------------------------------ */

/** 创建网格所需的最小规格（部件与武器共用）。 */
interface MeshSpecLike {
  geometry: AvatarPartGeometry;
  size: { x: number; y: number; z: number };
  pos: { x: number; y: number; z: number };
  rotX?: number;
  rotY?: number;
  rotZ?: number;
  material: AvatarMaterialKind | "throwable";
  color?: number;
}

function createGeometry(spec: { geometry: AvatarPartGeometry; size: { x: number; y: number; z: number } }): THREE.BufferGeometry {
  const { x, y, z } = spec.size;
  if (spec.geometry === "sphere") {
    return new THREE.SphereGeometry(x, 12, 10);
  }
  if (spec.geometry === "cylinder") {
    // CylinderGeometry(radiusTop, radiusBottom, height, radialSegments)：x/z 传的是直径
    return new THREE.CylinderGeometry(x / 2, z / 2, y, 12);
  }
  return new THREE.BoxGeometry(x, y, z);
}

function createMesh(spec: MeshSpecLike, materials: AvatarMaterials): THREE.Mesh {
  const geometry = createGeometry(spec);
  const material = spec.material === "throwable"
    ? throwableMaterial(spec.color ?? 0x9ca3af)
    : materials[spec.material];
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(spec.pos.x, spec.pos.y, spec.pos.z);
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
}

/**
 * 人形化身模型。使用方（`remote-players.ts`）只负责喂位置/朝向/速度，
 * 所有骨骼公式都在本类里，便于在 Node 里单测。
 */
export class AvatarModel {
  public readonly root: THREE.Group;
  public readonly rig: AvatarRig;
  public readonly handAnchor: THREE.Object3D;
  /** 13 项部件对应的 16 个 mesh。 */
  public readonly parts: ReadonlyMap<string, THREE.Mesh>;
  /** 按槽位索引的 6 组武器（同一时刻只有一组 visible）。 */
  public readonly weaponGroups: readonly THREE.Group[];
  public readonly materials: AvatarMaterials;
  public readonly team: TeamId;
  /** 视觉总高（由部件实测得出，验收项：必须 === PLAYER_HEIGHT）。 */
  public readonly totalHeight: number;
  private currentSlot = -1;

  public constructor(team: TeamId) {
    this.team = team;
    this.materials = avatarMaterials(team);
    this.root = new THREE.Group();
    this.root.name = `avatar-${team}`;

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
    };
    const { fallPivot, torsoPivot, hipL, hipR, kneeL, kneeR, shoulderL, shoulderR } = this.rig;
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

    // ---- 躯干组（含头/头盔/面罩/背包/骨盆，绕腰线枢轴摆动）----
    torsoPivot.position.y = WAIST_Y;
    body.add(torsoPivot);

    const attachTorso = (name: string): THREE.Mesh => {
      const spec = requirePart(name);
      const mesh = createMesh(spec, this.materials);
      mesh.position.set(spec.pos.x, spec.pos.y - WAIST_Y, spec.pos.z);
      torsoPivot.add(mesh);
      parts.set(name, mesh);
      return mesh;
    };
    attachTorso("torso");
    attachTorso("pelvis");
    attachTorso("backpack");
    attachTorso("head");
    attachTorso("helmet");
    attachTorso("visor");

    // ---- 手臂：肩枢轴在 world SHOULDER_Y，肘枢轴再下 UPPER_ARM_HEIGHT ----
    const attachArm = (side: -1 | 1, shoulder: THREE.Group, elbowHolder: { elbow: THREE.Group | null }): void => {
      shoulder.position.set(side * ARM_X, SHOULDER_Y - WAIST_Y, 0);
      torsoPivot.add(shoulder);

      const upperSpec = requirePart(side < 0 ? "upperArmL" : "upperArmR");
      const upperMesh = createMesh(upperSpec, this.materials);
      upperMesh.position.set(0, -UPPER_ARM_HEIGHT / 2, 0);
      shoulder.add(upperMesh);
      parts.set(upperSpec.name, upperMesh);

      const elbow = new THREE.Group();
      elbow.position.set(0, -UPPER_ARM_HEIGHT, 0);
      shoulder.add(elbow);
      elbowHolder.elbow = elbow;

      const foreSpec = requirePart(side < 0 ? "foreArmL" : "foreArmR");
      const foreMesh = createMesh(foreSpec, this.materials);
      foreMesh.position.set(0, -FOREARM_HEIGHT / 2, 0);
      elbow.add(foreMesh);
      parts.set(foreSpec.name, foreMesh);
    };
    const leftElbow: { elbow: THREE.Group | null } = { elbow: null };
    const rightElbow: { elbow: THREE.Group | null } = { elbow: null };
    attachArm(-1, shoulderL, leftElbow);
    attachArm(1, shoulderR, rightElbow);

    // ---- 腿：髋枢轴 → 大腿；膝枢轴 → 小腿 + 脚 ----
    const attachLeg = (side: -1 | 1, hip: THREE.Group, knee: THREE.Group, thighName: string, shinName: string, footName: string): void => {
      hip.position.set(side * LEG_X, HIP_Y, 0);
      body.add(hip);

      const thighSpec = requirePart(thighName);
      const thighMesh = createMesh(thighSpec, this.materials);
      thighMesh.position.set(0, -THIGH_HEIGHT / 2, 0);
      hip.add(thighMesh);
      parts.set(thighName, thighMesh);

      knee.position.set(0, -THIGH_HEIGHT, 0);
      hip.add(knee);

      const shinSpec = requirePart(shinName);
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

    // ---- 装饰件：只挂骨骼、不进 parts 表（不参与判定，也不改总高）----
    // 躯干件按世界高度写在 AVATAR_DECOR 里，挂到 torsoPivot 要减掉腰线；
    // 大腿件本身就是相对髋枢轴的局部坐标（向下为负），直接挂。
    for (const decor of AVATAR_DECOR) {
      const mesh = createMesh(decor, this.materials);
      mesh.name = `decor-${decor.parent}`;
      mesh.castShadow = false;
      if (decor.parent === "thighR") {
        mesh.position.set(decor.pos.x, decor.pos.y, decor.pos.z);
        hipR.add(mesh);
      } else if (decor.parent === "thighL") {
        mesh.position.set(decor.pos.x, decor.pos.y, decor.pos.z);
        hipL.add(mesh);
      } else {
        mesh.position.set(decor.pos.x, decor.pos.y - WAIST_Y, decor.pos.z);
        torsoPivot.add(mesh);
      }
    }

    // ---- 武器挂点：右前臂子节点 ----
    // 规格要求 `rotation.y = π`；武器模型按「枪口朝 −Z」建模（与规格 2.4 的 z 偏移一致），
    // 所以挂点内部再加一层 π 的 mount 抵消，净效果 = 枪口朝世界 −Z = 角色正前方。
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

    // ---- 6 组武器（按槽位索引）----
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

  /** 当前武器槽位。 */
  public get weaponSlot(): number {
    return this.currentSlot;
  }

  /**
   * 行走摆动（文档 2.3 公式）。
   *
   * @param phase 相位（rad），由 `bobPhase += horizontalSpeed * BOB_RAD_PER_METER * dt` 推进
   * @param amp 摆幅 0–1（带淡入；离地时外部乘 0.5）
   */
  public poseLocomotion(phase: number, amp: number): void {
    const a = Math.max(0, Math.min(1, amp));
    const { hipL, hipR, kneeL, kneeR, shoulderL, shoulderR, torsoPivot } = this.rig;

    hipL.rotation.x = Math.sin(phase) * LEG_SWING * a;
    hipR.rotation.x = Math.sin(phase + Math.PI) * LEG_SWING * a;
    kneeL.rotation.x = -KNEE_BEND * Math.max(0, Math.sin(phase - 0.6)) * a;
    kneeR.rotation.x = -KNEE_BEND * Math.max(0, Math.sin(phase + Math.PI - 0.6)) * a;
    // 左臂与左腿反相，持枪臂幅度更小
    shoulderL.rotation.x = Math.sin(phase + Math.PI) * ARM_SWING * a;
    shoulderR.rotation.x = Math.sin(phase) * GUN_ARM_SWING * a;
    torsoPivot.position.y = WAIST_Y + TORSO_BOB * Math.sin(phase * 2) * a;
    torsoPivot.rotation.z = TORSO_ROLL * Math.sin(phase) * a;
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

  /** 释放本 avatar 独占的几何体（材质是共享的，不在这里释放）。 */
  public dispose(): void {
    this.root.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose();
      }
    });
  }
}

/** 便捷工厂（等价于 `new AvatarModel(team)`）。 */
export function buildAvatarModel(team: TeamId): AvatarModel {
  return new AvatarModel(team);
}

/** 手部挂点的世界位置（调试/血雾定位用）。 */
export function handWorldPosition(model: AvatarModel, target: THREE.Vector3): THREE.Vector3 {
  return model.handAnchor.getWorldPosition(target);
}
