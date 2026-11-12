/**
 * 第三人称卡通角色模型（Tom / Jerry / Spike / Butch）。
 *
 * 造型基准：`docs/角色阵容.png`（四只并排的定妆图）。这份代码是它的**低模转译**，
 * 不是"照着颜色捏一个大概"——下面每条尺寸都能在那张图里找到出处。
 *
 * 三条硬约束（改动前请先读）：
 *   1. **纵向尺寸必须由 `PLAYER_HITBOXES` 推导**：头顶 1.80、肩 1.50、髋 0.90、
 *      脚底 0。判定体、外观、第一人称视模型三条线共用同一批数字。
 *   2. **横向必须收在判定体内**（唯二例外见下）：躯干最大半径 < 胸段 0.27、
 *      肩枢轴 + 上臂半宽 < 臂段外沿 0.40。宁可"判定宽容"，不能"看着打中却穿过去"。
 *   3. **材质按（角色 × 队伍）共享**：同组合的所有 avatar 复用一套材质，
 *      8 人局每帧 new/dispose 材质会造成 GC 抖动。
 *
 * 两个被**有意**允许探出判定体的例外：
 *   · **耳朵**：探出的是剪影，不是体积。Jerry 的大圆耳、Tom 的尖耳都靠它，
 *     少了耳朵四只角色立刻退化成"四个球头人"。
 *   · **头部整体比头段判定略宽**：头段判定是 r0.13 的圆柱（26cm），卡通头做到
 *     30cm。多出来的腮帮在判定外，代价是"擦着腮帮打不算爆头"——比反过来
 *     （看着没打中却爆头）可接受得多，且与"下巴算胸部"是同一条取舍。
 *
 * 坐标系：root 原点 = 脚底中心，前方 = −Z（与 `root.rotation.y = yaw` 一致）。
 *
 * 主题统一性：身上没有任何真实枪械与战术装具——手里是**高压水枪 / 橡皮筋枪 / 餐叉 /
 * 平底锅 / 胡椒瓶 / 面粉袋**；敌我识别靠**颈部饰带颜色**（T 番茄红 / CT 天空蓝），
 * 不交给毛色，这样"选 Jerry 的 CT"和"选 Jerry 的 T"都能一眼分清。
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

/**
 * 头颅椭球**视觉**基准半径（基准体型；头宽 = 2 × HEAD_RADIUS × headScale）。
 *
 * 它不是判定半径：判定圆柱取 {@link HEAD}.radius（0.175），比这个基准宽 4cm。
 * 两者关系是"模型的头被 headScale 放大 22–28% 之后仍然塞得进判定圆柱"，
 * 也就是 `0.135 × 1.28 < 0.175` —— 这条不等式由 `tests/avatar-model.test.ts` 守着。
 * 谁把 headScale 调大、或把判定半径调小，测试立刻会红。
 */
export const HEAD_RADIUS: number = HEAD.radius * 0.75;

/**
 * 头颅中心高度。
 *
 * 取 1.65 而不是"头顶减半径"：头顶必须给**毛簇**留 5cm，毛簇顶面正好压在 1.80
 * （总高验收项）。头球本身 1.5325–1.7675，把头部判定段（1.63–1.80）整个包在里面——
 * 所以"打在看得见的头上"必定算头，唯一漏判的是下巴那 10cm，而它还落在胸段里。
 */
export const HEAD_CENTER_Y: number = 1.625;
/** 头颅垂直半径（横向再乘 headScale）。头球 1.49–1.76，比判定段高 13cm。 */
export const HEAD_HALF_HEIGHT: number = 0.135;

/** 头顶毛簇：Tom / Butch 的几撮呆毛，顶面必须正好等于 PLAYER_HEIGHT。 */
export const CREST_HEIGHT: number = 0.05;
export const CREST_CENTER_Y: number = PLAYER_HEIGHT - CREST_HEIGHT / 2;

/**
 * 口鼻（**不参与判定**）。
 *
 * 卡通脸"往前凸"靠的是这一块白色口鼻，而不是把头球吹大——头球一旦超过判定半径，
 * 就会出现"瞄着脸打、判定成胸"。凸出去的部分不结算伤害，与"枪管不算 hitbox"同理。
 */
export const MUZZLE_WIDTH: number = 0.2;
export const MUZZLE_HEIGHT: number = 0.135;
export const MUZZLE_DEPTH: number = 0.15;
export const MUZZLE_CENTER_Y: number = 1.565;
export const MUZZLE_CENTER_Z: number = -0.088;

/** 颈部饰带高度：胸段顶端下方 1cm，正好是"脖子"。 */
/** 脖子半径（饰带半径由它推出来，不许再写死数字）。 */
export const NECK_RADIUS: number = 0.072;
export const NECKBAND_Y: number = HEAD_CENTER_Y - HEAD_HALF_HEIGHT - 0.028;

/** 躯干（旋转体）：高度从髋 0.82 到锁骨 1.458，最粗处半径 0.174。 */
export const TORSO_HEIGHT: number = 0.638;
export const TORSO_CENTER_Y: number = 1.139;
/**
 * 躯干最粗处半径 = **胸段判定半径的 60%**（0.27 × 0.6 = 0.162）。
 *
 * 为什么不是 100%：判定体是个圆柱，模型是个有腰的旋转体，按圆柱做满就会变成
 * 一只桶。60% 意味着"最胖的角色（Spike，bodyScale 1.24）也只到 0.20"，
 * 离 0.27 还有 7cm 容错——宁可判定宽容，也不会出现"看着穿过去了却没掉血"。
 */
export const TORSO_MAX_RADIUS: number = CHEST.radius * 0.6;
export const TORSO_WIDTH: number = TORSO_MAX_RADIUS * 2;
export const TORSO_DEPTH: number = TORSO_MAX_RADIUS * 2 * 0.86;

/** 骨盆：压在髋线上的球，把旋转体躯干的平底封住。 */
export const PELVIS_WIDTH: number = 0.27;
export const PELVIS_HEIGHT: number = 0.2;
export const PELVIS_DEPTH: number = 0.235;
export const PELVIS_CENTER_Y: number = 0.88;

/** 腰线：躯干摆动/侧倾的枢轴高度。 */
export const WAIST_Y: number = BELLY.yMax;

/** 尾根：贴在骨盆背后。 */
export const TAIL_BASE_WIDTH: number = 0.12;
export const TAIL_BASE_HEIGHT: number = 0.11;
export const TAIL_BASE_DEPTH: number = 0.12;
export const TAIL_BASE_Z: number = PELVIS_DEPTH / 2 - 0.02;

/** 手臂：肩 1.50 → 肘 1.255 → 腕 1.04。 */
export const SHOULDER_Y: number = ARM.yMax - 0.1;
export const UPPER_ARM_HEIGHT: number = 0.25;
export const FOREARM_HEIGHT: number = 0.21;
export const ELBOW_Y: number = SHOULDER_Y - UPPER_ARM_HEIGHT;
/** 上臂 / 前臂基准直径（乘 `limbScale`）。前臂更细，读起来才是"手臂"不是"管子"。 */
export const UPPER_ARM_WIDTH: number = 0.13;
export const FOREARM_WIDTH: number = 0.11;
/** 肩枢轴（判定体口径）。 */
export const ARM_X: number = ARM.offsetRight;
/**
 * 视觉肩宽。
 *
 * 收进判定体内 6.5cm：卡通角色的手臂是**贴着身子挂**的，挂在 0.30 会让肩膀
 * 比胸还宽一截，整个人像穿盔甲。收进来不漏判——臂段半径 0.1，视觉臂外沿
 * 0.235 + 0.049 = 0.284，仍在 0.40 内。
 */
/**
 * 视觉肩枢轴。
 *
 * 手臂**不能**嵌进躯干：一旦重叠，手臂的描边壳会在躯干表面划出一道拱形黑线，
 * 看起来像"手臂从身上长出来的洞"。宁可留一条窄缝——那条缝本身就是
 * 手绘动画里手臂与身体之间的轮廓线。
 */
export const ARM_VISUAL_X: number = ARM.offsetRight - 0.115;

/** 腿：髋 0.90 → 膝 → 踝 0.075。 */
export const HIP_Y: number = BELLY.yMin;
export const FOOT_HEIGHT: number = 0.075;
const LEG_AVAILABLE: number = HIP_Y - FOOT_HEIGHT;
export const THIGH_HEIGHT: number = LEG_AVAILABLE / 2;
export const SHIN_HEIGHT: number = LEG_AVAILABLE / 2;
export const KNEE_Y: number = HIP_Y - THIGH_HEIGHT;
export const THIGH_WIDTH: number = 0.178;
export const SHIN_WIDTH: number = 0.128;
/** 脚掌：宽度由腿段判定半径推出来（0.2 × 0.88 = 0.176），不是随手写的数。 */
export const FOOT_WIDTH: number = LEG.radius * 1.02;
export const FOOT_DEPTH: number = 0.258;
export const FOOT_Z: number = -0.052;
/** 两腿间距：贴在腿段判定半径的 0.47 处（0.094），膝盖略分开的站姿。 */
export const LEG_X: number = LEG.radius * 0.38;

/**
 * 右手持物姿态。
 *
 * 参考图里每只角色都是"手臂自然垂、小臂前抬把家伙端在腰前"。做法是把肘弯到
 * {@link CARRY_ELBOW}，腕正好落在腰前方 20cm——武器挂点接在腕上，于是
 * "手在哪、家伙就在哪"，不再是"枪浮在身体旁边"。
 */
export const CARRY_SHOULDER: number = 0.05;
export const CARRY_ELBOW: number = 1.05;

/** 倒地枢轴：躯干半厚度，倒地后脊柱轴心离地 0.13m。 */
export const FALL_PIVOT_Y: number = 0.13;

/** 手部挂点的世界位置（武器握把原点）。 */
export const HAND_ANCHOR_WORLD = { x: ARM_VISUAL_X, y: 1.15, z: -0.2 } as const;

/** 行走摆动幅度（与第一人称 bob 同一套口径）。 */
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
 * 角色设定（纯外观：毛色 / 耳朵 / 体型 / 五官 / 配饰）
 * ------------------------------------------------------------------ */

/** 耳朵造型：猫（尖立）/ 鼠（大圆盘）/ 狗（前折耷拉）。 */
export type EarShape = "cat" | "mouse" | "dog";

/** 颈部配饰：围巾 / 项圈 / 领结。 */
export type NeckWear = "scarf" | "collar" | "bow";

/**
 * 五官参数。
 *
 * 全部是**相对量**（乘在头宽/口鼻宽上），这样换角色时脸会跟着头一起放大，
 * 不会出现"头变大了、眼睛还是原来那么小"。
 */
export interface FaceStyle {
  /** 眼睛宽度（米，世界尺度）。 */
  eyeW: number;
  eyeH: number;
  /** 虹膜直径。 */
  iris: number;
  /** 瞳孔直径。 */
  pupil: number;
  /** 上眼睑覆盖比例：0 = 瞪圆，0.5 = 半闭（Tom 的招牌困倦脸）。 */
  lid: number;
  /** 眼睛外倾角（弧度）：正数 = 外眼角上扬。 */
  tilt: number;
  /** 眉毛：宽 / 粗 / 倾角（正数 = 内低外高）。 */
  browW: number;
  browH: number;
  browTilt: number;
  /** 口鼻缩放（1 = 基准 17cm 宽）。 */
  muzzle: number;
  /** 腮帮半径（0 = 没有）。 */
  jowl: number;
  /** 腮帮下垂量（米）。 */
  jowlDrop: number;
  /** 露齿笑（Jerry）与獠牙（Spike）。 */
  grin: boolean;
  fang: boolean;
}

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
  /** 虹膜（Butch 荧光绿、Tom 淡黄绿、Jerry/Spike 近黑）。 */
  iris: number;
  /** 爪垫。 */
  paw: number;
  /** 眼白（略带暖调，纯白会像塑料珠）。 */
  sclera: number;
  ears: EarShape;
  /**
   * 体型宽度系数（0.86–1.24）。
   *
   * 上界不是 1：判定体是"最宽 0.27 的胸段"，卡通体块做到 0.17 × 1.24 = 0.21
   * 仍然安全。Spike 的桶状胸靠它，Jerry 的竹竿身也靠它。
   */
  bodyScale: number;
  /** 四肢粗细系数（0.85–1.3）：Spike 的粗胳膊、Jerry 的细腿。 */
  limbScale: number;
  /** 头宽系数（0.95–1.14）：只放大 x/z，纵向不动（头顶必须压在 1.80）。 */
  headScale: number;
  /** 尾巴长度系数（Spike 短尾 0.5，Butch 长尾 1.15）。 */
  tailLength: number;
  /** 尾巴粗细系数。 */
  tailThickness: number;
  /** 胡须根数（左右各一半）。 */
  whiskers: number;
  neck: NeckWear;
  /** 胸前奶油色补丁的宽度系数（0 = 没有）。 */
  bellyPatch: number;
  /** 腰的填充度：0 = 明显收腰（猫），1 = 桶状（斗牛犬）。 */
  waistFill: number;
  face: FaceStyle;
}

/**
 * 四个角色的外观设定（配色取自定妆图）。
 *
 * 数值全部落在"判定体以内"：`TORSO_MAX_RADIUS × bodyScale < 0.27`、
 * 臂外沿 < 0.40。角色之间**零数值差异**，只有外观。
 */
export const CHARACTER_STYLES: Record<CharacterId, CharacterStyle> = {
  tom: {
    id: "tom",
    fur: 0x9aacbc,
    belly: 0xfbf8f1,
    inner: 0xf2a695,
    nose: 0xe4786b,
    iris: 0xd8db8c,
    paw: 0xfbf8f1,
    sclera: 0xfdfbf4,
    ears: "cat",
    bodyScale: 0.94,
    limbScale: 0.95,
    headScale: 1.32,
    tailLength: 1,
    tailThickness: 1,
    whiskers: 6,
    neck: "scarf",
    bellyPatch: 0.96,
    waistFill: 0.12,
    face: {
      eyeW: 0.072, eyeH: 0.08, iris: 0.042, pupil: 0.02,
      lid: 0.38, tilt: 0.14,
      browW: 0.062, browH: 0.013, browTilt: 0.1,
      muzzle: 1, jowl: 0.052, jowlDrop: 0.012,
      grin: false, fang: false,
    },
  },
  jerry: {
    id: "jerry",
    fur: 0xc9854a,
    belly: 0xedc79a,
    inner: 0xe29a8a,
    nose: 0x2b1b2f,
    iris: 0x2b1b2f,
    paw: 0xedc79a,
    sclera: 0xfdfbf4,
    ears: "mouse",
    bodyScale: 0.86,
    limbScale: 0.88,
    headScale: 1.3,
    tailLength: 0.95,
    tailThickness: 0.72,
    whiskers: 6,
    neck: "bow",
    bellyPatch: 0.6,
    waistFill: 0.14,
    face: {
      eyeW: 0.078, eyeH: 0.09, iris: 0.046, pupil: 0.028,
      lid: 0, tilt: 0,
      browW: 0.046, browH: 0.012, browTilt: 0.3,
      muzzle: 0.88, jowl: 0.046, jowlDrop: 0.008,
      grin: true, fang: false,
    },
  },
  spike: {
    id: "spike",
    fur: 0xddab63,
    belly: 0xf3dfb8,
    inner: 0xc8846b,
    nose: 0x2b1b2f,
    iris: 0x2b1b2f,
    paw: 0xf3dfb8,
    sclera: 0xfbf3e2,
    ears: "dog",
    bodyScale: 1.24,
    limbScale: 1.3,
    headScale: 1.33,
    tailLength: 0.5,
    tailThickness: 1.15,
    whiskers: 4,
    neck: "collar",
    bellyPatch: 0.82,
    waistFill: 0.82,
    face: {
      eyeW: 0.05, eyeH: 0.044, iris: 0.024, pupil: 0.014,
      lid: 0.3, tilt: -0.2,
      browW: 0.062, browH: 0.022, browTilt: -0.34,
      muzzle: 1.16, jowl: 0.095, jowlDrop: 0.05,
      grin: false, fang: true,
    },
  },
  butch: {
    id: "butch",
    fur: 0x635b76,
    belly: 0x7b7288,
    inner: 0xdb7186,
    nose: 0x2b1b2f,
    iris: 0x9fe06b,
    paw: 0x6b6376,
    sclera: 0xf7f2e4,
    ears: "cat",
    bodyScale: 0.9,
    limbScale: 0.9,
    headScale: 1.3,
    tailLength: 1.15,
    tailThickness: 0.86,
    whiskers: 6,
    neck: "collar",
    bellyPatch: 0.46,
    waistFill: 0.2,
    face: {
      eyeW: 0.064, eyeH: 0.054, iris: 0.038, pupil: 0.018,
      lid: 0.5, tilt: -0.16,
      browW: 0.054, browH: 0.014, browTilt: -0.24,
      muzzle: 0.9, jowl: 0.055, jowlDrop: 0.015,
      grin: false, fang: false,
    },
  },
};

/** 队伍识别色（颈部饰带）：T 番茄红、CT 天空蓝。 */
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
  | "iris"
  | "pupil"
  | "paw"
  | "sclera"
  /** 队伍识别色（围巾 / 项圈 / 领结）。 */
  | "accent"
  /** 厨具金属。 */
  | "metal"
  /** 木柄 / 塑料握把。 */
  | "wood"
  /** 亮银刃口。 */
  | "blade"
  /** 墨色：眉毛、胡须、嘴线。 */
  | "dark"
  /** 金色奖牌 / 铜牌。 */
  | "gold"
  /** 躯干专用：顶点色（把奶白色的胸口直接烘焙进几何，见 `torsoGeometryOf`）。 */
  | "torso";

/**
 * 角色表面材质。卡通件用 `MeshToonMaterial`（分阶明暗），只有厨具留在 PBR 上。
 *
 * 用联合类型而不是统一成 `THREE.Material`，是为了让调用方还能安全读 `.color`
 * （描边、调试配色、截图工具都要读它）。
 */
export type AvatarSurfaceMaterial = THREE.MeshStandardMaterial | THREE.MeshToonMaterial;

export type AvatarMaterials = Record<AvatarMaterialKind, AvatarSurfaceMaterial>;

const materialCache = new Map<string, AvatarMaterials>();

function materialKey(character: CharacterId, team: TeamId): string {
  return `${character}|${team}`;
}

/**
 * 卡通分阶渐变（4 阶）。
 *
 * 这是"看起来像动画"的真正开关，比描边更关键：PBR 的连续明暗无论配色多准，
 * 出来都是**塑料/橡皮泥**；把明暗压成 4 级台阶之后，同一批几何立刻变成"画"。
 *
 * `NearestFilter` 是重点：一旦插值，台阶又被抹平回渐变。
 */
let toonGradient: THREE.DataTexture | null = null;

function avatarToonGradient(): THREE.DataTexture {
  if (toonGradient !== null) {
    return toonGradient;
  }
  // 只要两阶：受光面 / 背光面。
  //
  // 4 阶试过，问题是躯干是圆柱、法线连续扫过 180°，NdotL 会依次跨过每一个
  // 阈值，于是在胸口画出一圈"竖椭圆"色带——像肚皮上破了个洞。
  // 手绘动画从来不画这种中间调：一条明暗线把形体分成两半就够了。
  const steps = new Uint8Array([148, 255]);
  const texture = new THREE.DataTexture(steps, steps.length, 1, THREE.RedFormat);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  toonGradient = texture;
  return texture;
}

function createMaterials(character: CharacterId, team: TeamId): AvatarMaterials {
  const style = CHARACTER_STYLES[character];
  const gradientMap = avatarToonGradient();
  /**
   * 卡通材质：分阶明暗 + 无金属度 + 无高光。
   *
   * 只有厨具（金属、刀刃、金牌）留在 `MeshStandardMaterial` 上——
   * 卡通角色身上的毛、布、皮肤一旦有高光，就会退回"塑料玩偶"。
   */
  /**
   * `toneMapped: false` 是卡通角色必须打开的一票否决权。
   *
   * 场景用 ACES 压高光（沙漠暖阳需要它），但 ACES 会把 1.0 的白压到 0.8 左右
   * 再吃掉饱和——于是白肚皮永远是一块浅灰、橙色毛永远发土。
   * 卡通要的是**平涂原色**，干脆不让它进色调映射这一环。
   */
  const toon = (color: number): THREE.MeshToonMaterial =>
    new THREE.MeshToonMaterial({ color, gradientMap, toneMapped: false });
  return {
    fur: toon(style.fur),
    belly: toon(style.belly),
    inner: toon(style.inner),
    nose: toon(style.nose),
    iris: toon(style.iris),
    pupil: toon(0x141018),
    paw: toon(style.paw),
    // 眼白带一点自发光：卡通角色的眼睛永远比周围亮一档，纯漫反射在阴影里会灰掉
    sclera: new THREE.MeshToonMaterial({
      color: style.sclera,
      gradientMap,
      emissive: style.sclera,
      emissiveIntensity: 0.22,
      toneMapped: false,
    }),
    accent: toon(TEAM_ACCENT[team]),
    metal: new THREE.MeshStandardMaterial({ color: 0x8d97a3, roughness: 0.34, metalness: 0.78 }),
    wood: toon(0x8a5a34),
    blade: new THREE.MeshStandardMaterial({ color: 0xd9e3ee, roughness: 0.18, metalness: 0.9 }),
    dark: toon(0x241a28),
    gold: new THREE.MeshStandardMaterial({ color: 0xe8b93c, roughness: 0.3, metalness: 0.72 }),
    // 顶点色材质：底色必须是白的，否则会和烘焙进去的颜色相乘变脏
    torso: new THREE.MeshToonMaterial({ color: 0xffffff, vertexColors: true, gradientMap, toneMapped: false }),
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
  toonGradient?.dispose();
  toonGradient = null;
}

/* ------------------------------------------------------------------ *
 * 部件规格表
 * ------------------------------------------------------------------ */

export type AvatarPartGeometry =
  | "box"
  | "sphere"
  | "ellipsoid"
  | "capsule"
  | "cone"
  | "cylinder"
  /** 半球（穹顶）：上眼睑、头顶的圆弧块。size.y = 穹顶高度。 */
  | "dome"
  /** 圆环（项圈）：size.x = 外径、size.y = 管径。 */
  | "ring"
  /** 旋转体：母线由 `profile` 给出，size 是三个方向的**缩放系数**。 */
  | "lathe";

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
   * ellipsoid / dome: 全尺寸（直径 / 直径 + 穹顶高）；
   * cylinder: 直径/高/直径；capsule: 直径/总高/直径；cone: 底径/高/底径；
   * ring: 外径/管径/外径；lathe: 三个方向的缩放系数。
   */
  size: { x: number; y: number; z: number };
  /** 相对父节点原点（躯干件写世界高度，构树时统一减掉父节点高度）。 */
  pos: { x: number; y: number; z: number };
  rotX?: number;
  rotY?: number;
  rotZ?: number;
  /** 仅 `lathe` 使用：母线点，[半径, 高度]，按顺序首尾相接。 */
  profile?: readonly (readonly [number, number])[];
  /**
   * 这个部件的描边宽度（世界单位）。不填用 `OUTLINE_WIDTH`。
   *
   * 手绘动画的线宽是统一的，但**眼睛**是个例外：眼球只有 9cm，用身体那条
   * 1.3cm 的粗线去描，会把眼白包成一副黑框眼镜。脸部的线必须细一档。
   */
  outlineWidth?: number;
  /**
   * 强制描边开关。不填时按尺寸自动判断（见 `OUTLINE_MIN_SIZE`）。
   *
   * 眼睛必须显式打开：眼白只有 8cm 宽，按尺寸会被跳过，但它是整张脸的
   * 视觉中心——没有轮廓线的眼白会"飘"在脸上，像贴了两块白胶布。
   */
  outline?: boolean;
}

export interface AvatarPartSpec extends MeshSpec {
  /** 部件名（也是 `parts` map 的键）。 */
  name: string;
  /** 中文名，便于报告与调试。 */
  label: string;
  material: AvatarMaterialKind;
}

/**
 * 躯干母线（旋转体）。
 *
 * 一条曲线决定"这是只猫还是只桶"：髋部微微外扩 → 腰最细 → 胸最宽 → 肩头收口。
 * 没有这条腰线，躯干就是一个蛋，正面看和背面看一样——参考图里四只角色全都
 * 有明显的收腰（Spike 是相反的：腰最粗）。
 */
const TORSO_PROFILE: readonly (readonly [number, number])[] = [
  [0.02, 0.82],
  [0.1, 0.834],
  [0.142, 0.868],
  [0.152, 0.905],
  [0.15, 0.95],
  [0.137, 1.01],
  [0.126, 1.06],
  [0.134, 1.12],
  [0.15, 1.2],
  [0.172, 1.27],
  [0.174, 1.315],
  [0.166, 1.365],
  [0.146, 1.398],
  // 斜方肌：再往上收一段，肩枢轴（1.42）才落在躯干里。
  // 不收这一段的话，两只手臂是"贴"在躯干顶上的，正面看没有肩、只有两根吊着的管子。
  [0.118, 1.432],
  [0.07, 1.458],
];

/**
 * 躯干整体收窄系数。
 *
 * 之前躯干的直径 0.35m 配上 0.34m 的头，正面看是"一个桶顶着一个球"——
 * 肩宽 0.55m 对 1.8m 的身高已经接近真人比例，而卡通角色要的是**窄肩细长条**。
 * 收到 0.82 之后肩宽约 0.46m，头/肩比接近参考图。
 */
const TORSO_SLENDERNESS = 0.82;

/**
 * 按角色微调后的躯干母线。
 *
 * `waistFill` 把腰（y≈1.06）往最粗处抬：斗牛犬是**桶**，没有腰；猫是明显的沙漏。
 * 这不是"通用体型缩放"能表达的——它是形状差异，不是尺寸差异。
 *
 * 注意这里同时乘了 `bodyScale`：躯干是唯一由母线直接生成的部件，漏掉 bodyScale
 * 的话 Spike 的桶身会和 Tom 一样宽，只有手脚变大（上一版就是这个毛病）。
 */
export function torsoProfileOf(style: CharacterStyle): (readonly [number, number])[] {
  const maxR = Math.max(...TORSO_PROFILE.map(([r]) => r));
  return TORSO_PROFILE.map(([r, y]) => {
    // 高斯窗：只在腰那一带生效，胸、髋一个像素都不动
    const weight = Math.exp(-(((y - 1.062) / 0.062) ** 2));
    const filled = r + (maxR - r) * style.waistFill * weight;
    return [filled * TORSO_SLENDERNESS * style.bodyScale, y] as const;
  });
}

/**
 * 16 个骨架部件（判定与造型共用同一批尺寸）。
 *
 * **数量与位置契约不变**：头顶 1.80、髋 0.90、脚底 0、手部挂点 1.15 全部照旧，
 * 所以判定体一个像素都不用改。变的是每件的形状——胶囊管换成了**锥台**，
 * 四肢才有"上粗下细"的走向；躯干换成了旋转体，才有腰。
 */
export const AVATAR_PARTS: readonly AvatarPartSpec[] = [
  {
    name: "head",
    label: "头",
    geometry: "ellipsoid",
    size: { x: 0.27, y: HEAD_HALF_HEIGHT * 2, z: 0.255 },
    pos: { x: 0, y: HEAD_CENTER_Y, z: 0.004 },
    material: "fur",
  },
  {
    name: "crest",
    label: "头顶毛簇",
    geometry: "ellipsoid",
    size: { x: 0.108, y: CREST_HEIGHT, z: 0.096 },
    pos: { x: 0, y: CREST_CENTER_Y, z: 0.01 },
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
    geometry: "lathe",
    size: { x: 1, y: 1, z: 0.86 },
    pos: { x: 0, y: 0, z: 0 },
    profile: TORSO_PROFILE,
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
    geometry: "cylinder",
    size: { x: UPPER_ARM_WIDTH, y: UPPER_ARM_HEIGHT, z: UPPER_ARM_WIDTH * 0.78 },
    pos: { x: -ARM_X, y: SHOULDER_Y - UPPER_ARM_HEIGHT / 2, z: 0 },
    material: "fur",
  },
  {
    name: "foreArmL",
    label: "左前臂",
    geometry: "cylinder",
    size: { x: FOREARM_WIDTH, y: FOREARM_HEIGHT, z: FOREARM_WIDTH * 0.74 },
    pos: { x: -ARM_X, y: ELBOW_Y - FOREARM_HEIGHT / 2, z: 0 },
    material: "fur",
  },
  {
    name: "upperArmR",
    label: "右上臂",
    geometry: "cylinder",
    size: { x: UPPER_ARM_WIDTH, y: UPPER_ARM_HEIGHT, z: UPPER_ARM_WIDTH * 0.78 },
    pos: { x: ARM_X, y: SHOULDER_Y - UPPER_ARM_HEIGHT / 2, z: 0 },
    material: "fur",
  },
  {
    name: "foreArmR",
    label: "右前臂",
    geometry: "cylinder",
    size: { x: FOREARM_WIDTH, y: FOREARM_HEIGHT, z: FOREARM_WIDTH * 0.74 },
    pos: { x: ARM_X, y: ELBOW_Y - FOREARM_HEIGHT / 2, z: 0 },
    material: "fur",
  },
  {
    name: "thighL",
    label: "左大腿",
    geometry: "cylinder",
    size: { x: THIGH_WIDTH, y: THIGH_HEIGHT, z: THIGH_WIDTH * 0.72 },
    pos: { x: -LEG_X, y: HIP_Y - THIGH_HEIGHT / 2, z: 0 },
    material: "fur",
  },
  {
    name: "thighR",
    label: "右大腿",
    geometry: "cylinder",
    size: { x: THIGH_WIDTH, y: THIGH_HEIGHT, z: THIGH_WIDTH * 0.72 },
    pos: { x: LEG_X, y: HIP_Y - THIGH_HEIGHT / 2, z: 0 },
    material: "fur",
  },
  {
    name: "shinL",
    label: "左小腿",
    geometry: "cylinder",
    size: { x: SHIN_WIDTH, y: SHIN_HEIGHT, z: SHIN_WIDTH * 0.8 },
    pos: { x: -LEG_X, y: KNEE_Y - SHIN_HEIGHT / 2, z: 0 },
    material: "fur",
  },
  {
    name: "shinR",
    label: "右小腿",
    geometry: "cylinder",
    size: { x: SHIN_WIDTH, y: SHIN_HEIGHT, z: SHIN_WIDTH * 0.8 },
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
 * 角色装饰件（耳朵 / 五官 / 腮帮 / 胡须 / 配饰 / 爪）
 *
 * **不进入 `parts` 表**：这些件不参与任何判定，也不该被「16 个判定部件」的验收用例卡住。
 * 它们挂在既有骨骼组上（头 / 躯干 / 肩 / 肘 / 髋 / 膝），跟随行走、下蹲、倒地。
 * ------------------------------------------------------------------ */

/**
 * 装饰件的挂载点。
 *
 * `pos` 的坐标口径：
 *   · `head`   → 头心局部（原点 = 头颅中心）；
 *   · `torso`  → **世界高度**（构树时统一减掉腰线）；
 *   · 关节件   → 该关节的局部坐标（0,0,0 = 关节心）。
 */
export type AvatarDecorParent =
  | "head"
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

/** 头颅表面在给定 (x, y) 处的 z（负值 = 前方）。眼睛、腮帮靠它"长在脸上"。 */
function skullSurfaceZ(x: number, y: number, rx: number, rz: number): number {
  const t = 1 - (x / rx) ** 2 - (y / HEAD_HALF_HEIGHT) ** 2;
  return -rz * Math.sqrt(Math.max(0.12, t));
}

/** 关节球：肩 / 肘 / 髋 / 膝各一颗，把两段锥台的接缝吞掉。 */
function jointDecor(w: number, limb: number): AvatarDecorSpec[] {
  /**
   * 肩球比手臂粗 24%，肘/膝关节球则略细于肢体。
   *
   * 职责完全不同：
   *   · **肩要"盖住"**——手臂的描边壳在躯干表面会画出一道拱形黑线，
   *     只有让肩部有一团比手臂更大的体积，那道拱才会变成"肩膀的轮廓"；
   *   · **肘/膝要"填缝"**——只负责吞掉两段锥台的接缝，一大就成串珠。
   */
  const armR = UPPER_ARM_WIDTH * limb * 0.52 * 1.04;
  const foreR = FOREARM_WIDTH * limb * 0.52 * 0.92;
  const thighR = THIGH_WIDTH * limb * 0.52 * 1.08;
  const shinR = SHIN_WIDTH * limb * 0.52 * 0.92;
  const ball = (parent: AvatarDecorParent, r: number): AvatarDecorSpec => ({
    parent,
    geometry: "ellipsoid",
    size: { x: r * 2 * w, y: r * 2 * w, z: r * 2 * w },
    pos: { x: 0, y: 0, z: 0 },
    material: "fur",
  });
  return [
    ball("shoulderL", armR),
    ball("shoulderR", armR),
    ball("elbowL", foreR),
    ball("elbowR", foreR),
    ball("hipL", thighR),
    ball("hipR", thighR),
    ball("kneeL", shinR),
    ball("kneeR", shinR),
  ];
}

/** 头部软装：耳朵 / 眼睛 / 眉毛 / 鼻 / 嘴 / 腮帮 / 胡须。 */
function headDecor(style: CharacterStyle): AvatarDecorSpec[] {
  const d: AvatarDecorSpec[] = [];
  const face = style.face;
  const hs = style.headScale;
  const rx = 0.135 * hs;
  const rz = 0.1275 * hs;
  // 口鼻在世界里的前后位置（头枢轴 z = 0，所以世界 z 就是头局部 z）
  const muzzleK = face.muzzle;
  const mw = MUZZLE_WIDTH * muzzleK * hs;
  const mh = MUZZLE_HEIGHT * muzzleK;
  const muzzleLocalY = MUZZLE_CENTER_Y - HEAD_CENTER_Y;
  const muzzleFront = MUZZLE_CENTER_Z - (MUZZLE_DEPTH * muzzleK) / 2;
  /**
   * 口鼻椭球在 (x, 局部y) 处的前表面 z。
   *
   * 嘴线、鼻子如果一律用「最前端的那个 z」，在椭球边缘就会悬空——
   * 上一版的嘴是三条直条贴在固定 z 上，两侧直接飞出脸外，看起来像
   * 画在空气里的电路图。贴面必须按 x 逐点算。
   */
  const muzzleRx = mw / 2;
  const muzzleRy = mh / 2;
  const muzzleRz = (MUZZLE_DEPTH * muzzleK) / 2;
  const muzzleSurfaceZ = (x: number, localY: number): number => {
    const k = 1 - (x / muzzleRx) ** 2 - ((localY - muzzleLocalY) / muzzleRy) ** 2;
    return MUZZLE_CENTER_Z - muzzleRz * Math.sqrt(Math.max(0.04, k));
  };

  /* ---- 腮帮：卡通脸的体积基本都长在腮上 ----
     用**毛色**而不是奶白色：奶白留给口鼻那一块，否则脸会变成三颗白球 */
  if (face.jowl > 0) {
    for (const side of [-1, 1] as const) {
      d.push({
        parent: "head", geometry: "ellipsoid",
        size: { x: face.jowl * 2.3 * hs, y: face.jowl * 1.9, z: face.jowl * 2.1 * hs },
        pos: { x: side * rx * 0.66, y: muzzleLocalY - 0.012 - face.jowlDrop, z: -rz * 0.26 },
        material: "fur",
      });
    }
  }

  /* ---- 耳朵 ---- */
  const earX = rx * 0.72;
  if (style.ears === "cat") {
    // 尖立三角耳：外锥 + 内锥，外倾 16°，耳尖压在 1.79 附近
    for (const side of [-1, 1] as const) {
      d.push(
        {
          parent: "head", geometry: "cone",
          size: { x: 0.175 * hs, y: 0.19, z: 0.072 * hs },
          pos: { x: side * earX * 1.04, y: 0.098, z: 0.006 },
          rotZ: side * -0.34, rotX: 0.06, material: "fur",
        },
        {
          parent: "head", geometry: "cone",
          size: { x: 0.1 * hs, y: 0.132, z: 0.05 },
          pos: { x: side * earX * 1.02, y: 0.094, z: -0.018 },
          rotZ: side * -0.34, rotX: 0.06, material: "inner",
        },
      );
    }
  } else if (style.ears === "mouse") {
    // 大圆盘耳：两片压扁的椭球，几乎横在头两侧（Jerry 的辨识度全在这）
    for (const side of [-1, 1] as const) {
      d.push(
        {
          parent: "head", geometry: "ellipsoid",
          size: { x: 0.255, y: 0.265, z: 0.05 },
          pos: { x: side * (rx * 0.9), y: 0.115, z: -0.005 },
          rotY: side * -0.5, rotZ: side * -0.42, material: "fur",
        },
        {
          parent: "head", geometry: "ellipsoid",
          size: { x: 0.172, y: 0.184, z: 0.038 },
          pos: { x: side * (rx * 0.92), y: 0.113, z: -0.026 },
          rotY: side * -0.46, rotZ: side * -0.42, material: "inner",
        },
      );
    }
  } else {
    // 前折的耷拉耳：挂在头两侧往下垂（Spike 的耳朵是贴着脸的）
    for (const side of [-1, 1] as const) {
      d.push(
        {
          parent: "head", geometry: "ellipsoid",
          size: { x: 0.1, y: 0.185, z: 0.12 },
          pos: { x: side * (rx * 0.99), y: -0.03, z: -0.02 },
          rotZ: side * 0.55, rotX: -0.16, material: "fur",
        },
        {
          parent: "head", geometry: "ellipsoid",
          size: { x: 0.056, y: 0.12, z: 0.07 },
          pos: { x: side * (rx * 1.02), y: -0.038, z: -0.056 },
          rotZ: side * 0.55, rotX: -0.16, material: "inner",
        },
      );
    }
  }

  /* ---- 眼睛 ----
     四层：眼白（半嵌进颅骨）→ 虹膜 → 瞳孔 + 高光 → 上眼睑（皮肤色压下来）。
     上一版把整颗眼白贴在脸外，正面看就是"脸上贴了两个鸡蛋"：眼球必须有
     一部分埋在头里，边缘才会产生"眼皮包住眼睛"的厚度，而不是贴纸感。 */
  const eyeX = rx * 0.42;
  const eyeLocalY = 0.05;
  const eyeZ = skullSurfaceZ(eyeX, eyeLocalY, rx, rz) + 0.019;
  /**
   * 五官尺寸一律乘 `hs`。
   *
   * 头被 headScale 放大，眼睛却不跟着放大的话，头越大眼睛越小——上一版把
   * 头从 1.22 提到 1.32 之后，脸就变成了"大脸配小眼睛"。这里把 style 里的
   * 五官尺寸定义成**相对基准头**的值，实际大小由 hs 推出来，比例才锁得住。
   */
  const fw = face.eyeW * hs;
  const fh = face.eyeH * hs;
  const fi = face.iris * hs;
  const fp = face.pupil * hs;
  /** 眼白接近正球：扁的眼白从侧面看会变成一片薄片。 */
  const eyeD = Math.max(fw, fh) * 1.02;
  for (const side of [-1, 1] as const) {
    const tilt = side * face.tilt;
    d.push({
      parent: "head", geometry: "ellipsoid",
      size: { x: fw, y: fh, z: eyeD },
      pos: { x: side * eyeX, y: eyeLocalY, z: eyeZ },
      rotZ: tilt, material: "sclera", outline: true, outlineWidth: 0.0042,
    });
    // 虹膜贴在眼球前极点稍后：贴太前会像"眼珠凸出眼眶"
    const irisZ = eyeZ - eyeD * 0.5 + 0.011;
    d.push({
      parent: "head", geometry: "ellipsoid",
      size: { x: fi, y: fi, z: 0.026 * hs },
      pos: { x: side * eyeX, y: eyeLocalY - 0.003, z: irisZ },
      rotZ: tilt, material: "iris",
    });
    d.push({
      parent: "head", geometry: "ellipsoid",
      size: { x: fp, y: fp, z: 0.02 * hs },
      pos: { x: side * eyeX, y: eyeLocalY - 0.003, z: irisZ - 0.009 },
      material: "pupil",
    });
    // 高光：一颗偏心的小白点，是"眼睛活了"和"玻璃珠子"的分界线
    d.push({
      parent: "head", geometry: "ellipsoid",
      size: { x: fp * 0.5, y: fp * 0.5, z: 0.012 },
      pos: { x: side * (eyeX - 0.008 * hs), y: eyeLocalY + 0.012 * hs, z: irisZ - 0.014 },
      material: "sclera",
    });
    // 上眼睑：一层皮肤色的穹顶从上方压下来。
    // lid=0（Jerry 瞪圆眼）时不画；lid 越大，底边越低、眼睛越困。
    if (face.lid > 0.02) {
      const lidY = eyeLocalY + fh * (0.5 - face.lid);
      // 眼睑本身就是那条"线"：它的细描边压在眼白上，就是上眼睑的轮廓。
      // 之前这里另外加了一条墨色横条，结果眼睛变成"黑框眼镜"——线叠了两层。
      d.push({
        parent: "head", geometry: "dome",
        size: { x: fw * 1.14, y: fh * 0.92, z: eyeD * 1.03 },
        pos: { x: side * eyeX, y: lidY, z: eyeZ - 0.002 },
        rotZ: tilt, material: "fur", outline: true, outlineWidth: 0.0042,
      });
    }
    // 眉毛：贴着额头的一道细长条
    const browY = Math.min(
      eyeLocalY + fh * 0.62 + 0.014 * hs,
      HEAD_HALF_HEIGHT * 0.86,
    );
    /**
     * 眉毛的 z 不能在颅面上算：眼球是凸出来的球，上半部会把后面的眉毛
     * 整个挡住（"眉毛消失"就是这么来的）。取颅面与眼球前缘里更靠前的那个。
     */
    const browZ = Math.min(
      skullSurfaceZ(eyeX + 0.004 * hs, browY, rx, rz) + 0.005,
      eyeZ - eyeD * 0.42,
    );
    d.push({
      parent: "head", geometry: "box",
      size: { x: face.browW * hs, y: face.browH * hs * 0.72, z: 0.011 },
      pos: { x: side * (eyeX + 0.004 * hs), y: browY, z: browZ },
      rotZ: side * face.browTilt, material: "dark",
    });
  }

  /* ---- 鼻头：倒三角，尖端朝下（猫的鼻子不是一颗球） ---- */
  const noseW = mw * 0.23;
  const noseH = noseW * 0.8;
  const noseY = muzzleLocalY + 0.03;
  d.push({
    parent: "head", geometry: "cone",
    size: { x: noseW, y: noseH, z: noseW * 0.6 },
    pos: { x: 0, y: noseY, z: muzzleSurfaceZ(0, noseY) + noseH * 0.16 },
    rotX: Math.PI, material: "nose",
  });

  /* ---- 嘴 ---- */
  if (face.grin) {
    // 露齿笑：墨色口腔 + 两颗大门牙。Jerry 的辨识点就是这两颗牙，
    // 一排均匀的白牙会变成"星星笑"，反而谁都不像。
    const mouthY = muzzleLocalY - 0.042;
    d.push({
      parent: "head", geometry: "ellipsoid",
      size: { x: mw * 0.74, y: mh * 0.44, z: 0.04 },
      pos: { x: 0, y: mouthY, z: muzzleSurfaceZ(0, mouthY) + 0.012 },
      material: "dark",
    });
    for (const side of [-1, 1] as const) {
      d.push({
        parent: "head", geometry: "box",
        size: { x: mw * 0.17, y: mh * 0.34, z: 0.03 },
        pos: {
          x: side * mw * 0.09,
          y: mouthY - 0.026,
          z: muzzleSurfaceZ(side * mw * 0.09, mouthY - 0.026) + 0.008,
        },
        material: "sclera",
      });
    }
  } else {
    /**
     * 微笑线：9 段极短的小条拼一条下弯弧。
     *
     * 上一版只有 3 段、每段 2cm 长，拼出来是"Z 字折线"——嘴的弧度靠**段数**
     * 和每段的倾角渐变，段越碎越顺。每段的 z 都按自己的 x 重算，所以整条
     * 弧线贴着口鼻表面，不会在两端飞出去。
     */
    const segments = 9;
    const halfSpan = mw * 0.36;
    for (let i = 0; i < segments; i += 1) {
      const t = (i / (segments - 1)) * 2 - 1;
      const px = t * halfSpan;
      const py = muzzleLocalY - 0.026 - (1 - t * t) * 0.02;
      d.push({
        parent: "head", geometry: "box",
        size: { x: (halfSpan * 2) / (segments - 1) * 1.35, y: 0.006, z: 0.011 },
        pos: { x: px, y: py, z: muzzleSurfaceZ(px, py) + 0.006 },
        rotZ: -t * 0.42, material: "dark",
      });
    }
  }
  if (face.fang) {
    for (const side of [-1, 1] as const) {
      d.push({
        parent: "head", geometry: "cone",
        size: { x: 0.024, y: 0.044, z: 0.02 },
        pos: { x: side * mw * 0.24, y: muzzleLocalY - 0.048, z: muzzleFront + 0.008 },
        material: "sclera",
      });
    }
  }

  /* ---- 胡须：只做剪影，不做物理 ---- */
  /**
   * 胡须：细胶囊，从吻部两侧斜着向外上方挑出去。
   *
   * 三条踩过的坑：
   *   1. 用 `box` 做——正面看是"三根黑铁丝横穿脸颊"；
   *   2. `rotY` 给了负值——胡须朝前翘，更糟；
   *   3. 三根挤在 2cm 内——正面糊成一个黑块。
   * 现在：每侧两根、间距 3.5cm、根部直径 5mm、沿 X 轴横放，
   * 正面看就是两条细线，才是胡须该有的存在感。
   */
  const whiskerLength = 0.098 * (0.75 + hs * 0.25);
  const whiskerCount = 2;
  for (const side of [-1, 1] as const) {
    for (let x = 0; x < whiskerCount; x += 1) {
      const spread = (x - (whiskerCount - 1) / 2) * 0.036;
      // 越靠下的那根越平：三根从吻部侧面呈扇形挑开
      const tilt = 1.42 - x * 0.13;
      const by = muzzleLocalY + 0.018 + spread;
      const bx = side * mw * 0.42;
      d.push({
        parent: "head", geometry: "capsule",
        size: { x: 0.0045, y: whiskerLength, z: 0.0045 },
        // capsule 沿局部 Y 轴，rotZ 把它转到接近水平；
        // 中心点要沿这个方向推半个长度，否则会有一半埋进脸里
        pos: {
          x: bx + side * Math.sin(tilt) * whiskerLength * 0.5,
          y: by + Math.cos(tilt) * whiskerLength * 0.5,
          z: muzzleSurfaceZ(mw * 0.4, by) + 0.012,
        },
        rotZ: side * -tilt,
        material: "dark",
      });
    }
  }

  return d;
}

/** 颈部饰带与随身小件（敌我识别的第一信号）。 */
function neckDecor(style: CharacterStyle, w: number): AvatarDecorSpec[] {
  const d: AvatarDecorSpec[] = [];
  const bandY = NECKBAND_Y;
  // 环半径必须由脖子半径推出来：写死一个数就会变成"悬空的呼啦圈"
  const bandR = NECK_RADIUS * w + 0.012;
  d.push({
    parent: "torso", geometry: "ring",
    size: { x: bandR * 2, y: 0.03, z: bandR * 2 },
    pos: { x: 0, y: bandY, z: 0 },
    rotX: Math.PI / 2, material: "accent",
  });

  if (style.neck === "scarf") {
    // 围巾垂尾：两条短带挂在左肩后侧
    d.push({
      parent: "torso", geometry: "box", size: { x: 0.05, y: 0.16, z: 0.018 },
      pos: { x: -0.058, y: bandY - 0.06, z: 0.072 }, rotZ: 0.18, material: "accent",
    });
    d.push({
      parent: "torso", geometry: "box", size: { x: 0.042, y: 0.1, z: 0.016 },
      pos: { x: -0.086, y: bandY - 0.036, z: 0.062 }, rotZ: 0.34, material: "accent",
    });
  } else if (style.neck === "bow") {
    // 领结：两个三角块 + 中间结
    for (const side of [-1, 1] as const) {
      d.push({
        parent: "torso", geometry: "cone", size: { x: 0.058, y: 0.07, z: 0.05 },
        pos: { x: side * 0.036, y: bandY - 0.006, z: -0.074 },
        rotZ: side * (Math.PI / 2), material: "accent",
      });
    }
    d.push({
      parent: "torso", geometry: "ellipsoid", size: { x: 0.03, y: 0.03, z: 0.026 },
      pos: { x: 0, y: bandY - 0.006, z: -0.086 }, material: "accent",
    });
  } else if (style.id === "spike") {
    // 斗牛犬的金牌：正面一枚大圆牌，反光的黄铜是它最好认的记号
    d.push({
      parent: "torso", geometry: "cylinder", size: { x: 0.062, y: 0.016, z: 0.062 },
      pos: { x: 0, y: bandY - 0.055, z: -0.095 }, rotX: Math.PI / 2, material: "gold",
    });
  } else {
    // 黑猫的小铜牌
    d.push({
      parent: "torso", geometry: "ellipsoid", size: { x: 0.034, y: 0.03, z: 0.014 },
      pos: { x: 0, y: bandY - 0.036, z: -0.078 }, material: "gold",
    });
  }
  return d;
}

/** 手：掌 + 四指。远看只是一颗圆手，近看才有"抓握"的指节。 */
function handDecor(w: number): AvatarDecorSpec[] {
  const d: AvatarDecorSpec[] = [];
  for (const side of [-1, 1] as const) {
    const parent: AvatarDecorParent = side < 0 ? "foreArmL" : "foreArmR";
    const y = -FOREARM_HEIGHT + 0.012;
    // 连指手套：一整块掌 + 一整块指排 + 三颗指尖。
    // 上一版是三根分开的胶囊当手指，远看像"三根白香肠"——
    // 卡通手不是三根独立管子，是一块有指尖起伏的手套。
    d.push({
      parent, geometry: "ellipsoid", size: { x: 0.1 * w, y: 0.088 * w, z: 0.108 * w },
      pos: { x: 0, y, z: 0 }, material: "paw",
    });
    d.push({
      parent, geometry: "ellipsoid", size: { x: 0.094 * w, y: 0.082 * w, z: 0.084 * w },
      pos: { x: 0, y: y - 0.052 * w, z: -0.012 * w },
      rotX: -0.22, material: "paw",
    });
    for (const i of [-1, 0, 1] as const) {
      d.push({
        parent, geometry: "ellipsoid", size: { x: 0.03 * w, y: 0.034 * w, z: 0.034 * w },
        pos: {
          x: i * 0.028 * w,
          y: y - 0.086 * w + Math.abs(i) * 0.004 * w,
          z: -0.028 * w,
        },
        material: "paw",
      });
    }
    // 拇指：从掌的内侧斜着伸出来，剪影上才有"抓握"的方向
    d.push({
      parent, geometry: "ellipsoid", size: { x: 0.036 * w, y: 0.058 * w, z: 0.04 * w },
      pos: { x: side * 0.052 * w, y: y - 0.018 * w, z: -0.026 * w },
      rotZ: side * 0.72, rotX: -0.34, material: "paw",
    });
  }
  return d;
}

/** 脚趾：三颗小凸起，剪影才像爪子而不是两块卵石。 */
function toeDecor(w: number): AvatarDecorSpec[] {
  const d: AvatarDecorSpec[] = [];
  const toeY = -(SHIN_HEIGHT + FOOT_HEIGHT / 2) + 0.006;
  for (const side of [-1, 1] as const) {
    for (const offset of [-1, 0, 1] as const) {
      d.push({
        parent: side < 0 ? "kneeL" : "kneeR", geometry: "ellipsoid",
        size: { x: 0.05 * w, y: 0.056 * w, z: 0.078 * w },
        pos: { x: offset * 0.042 * w, y: toeY, z: FOOT_Z - FOOT_DEPTH / 2 + 0.028 },
        material: "paw",
      });
    }
  }
  return d;
}

/**
 * 生成某角色的**全部非判定装饰件**。
 *
 * 顺序无关紧要（都挂在骨骼上），但数量与造型是"这是谁"的全部信息：
 * 耳朵决定物种、眼睑与眉毛决定性格、腮帮决定脸型、饰带颜色决定敌我。
 */
/**
 * 躯干几何（带顶点色）。
 *
 * **胸口的奶白色是"长在皮肤上"的，不是套上去的一块壳。** 早期用"比躯干大 2% 的
 * 同形曲面"去贴，边缘照样 z-fighting 出一圈白毛刺——只要两个面之间还有深度缓冲的
 * 精度量级，就一定会打架。顶点色从根上没有第二个面：颜色直接写在旋转体的顶点上，
 * 再用 smoothstep 做软过渡，看起来才是毛色分界而不是贴纸。
 *
 * 几何按角色缓存（4 只各一份），因为顶点色是烘进去的。
 */
const torsoGeometryCache = new Map<string, THREE.BufferGeometry>();

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * 把 14 点母线插值成密母线。
 *
 * 顶点色是**逐顶点**的：如果母线只有 14 行，胸口的水平分界线只能落在行与行之间，
 * 就会在整条带子上留下台阶——远看像给人穿了件白背心。插到 4 倍密度（~50 行）后，
 * 上下过渡的 smoothstep 才有足够的采样点，边界才会变成一条软弧。
 */
function densifyProfile(
  profile: readonly (readonly [number, number])[],
  subdiv: number,
): THREE.Vector2[] {
  const out: THREE.Vector2[] = [];
  for (let i = 0; i < profile.length - 1; i += 1) {
    const [r0, y0] = profile[i]!;
    const [r1, y1] = profile[i + 1]!;
    for (let s = 0; s < subdiv; s += 1) {
      const t = s / subdiv;
      out.push(new THREE.Vector2(r0 + (r1 - r0) * t, y0 + (y1 - y0) * t));
    }
  }
  const last = profile[profile.length - 1]!;
  out.push(new THREE.Vector2(last[0], last[1]));
  return out;
}

export function torsoGeometryOf(style: CharacterStyle): THREE.BufferGeometry {
  const cached = torsoGeometryCache.get(style.id);
  if (cached !== undefined) {
    return cached;
  }
  const geometry = new THREE.LatheGeometry(densifyProfile(torsoProfileOf(style), 4), 96);
  const position = geometry.getAttribute("position");
  const colors = new Float32Array(position.count * 3);
  const fur = new THREE.Color(style.fur);
  const belly = new THREE.Color(style.belly);
  const mixed = new THREE.Color();
  // 胸口补丁的范围：斗牛犬从胯一直铺到锁骨，猫只到胸骨
  const big = style.id === "spike";
  const patchTop = big ? 1.37 : 1.38;
  const patchBottom = big ? 0.93 : 1.0;
  // bellyPatch 是"强度同时也是开关"：0 表示这只角色胸口没有浅色块
  const intensity = style.bellyPatch;
  const halfArc = 0.98 + 0.3 * intensity;
  /**
   * 弧宽随高度变化：这才是"围兜"而不是"胸前贴了一块白纸"。
   *
   * 直边的白块永远是错的——真实的毛色分界在胸口是**尖底 + 宽中段 + 收到锁骨**。
   * t=0 在补丁底端、t=1 在顶端：底端收成尖，t≈0.45 最宽，顶端再收一点。
   */
  const arcAt = (t: number): number => {
    const bump = Math.sin(Math.PI * Math.min(1, 0.1 + t * 0.86));
    return halfArc * (0.3 + 0.7 * Math.pow(bump, 0.55));
  };
  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    // LatheGeometry：phi=0 在 +Z（背面），所以正面 −Z 对应 atan2(x, −z) = 0
    const phi = Math.abs(Math.atan2(x, -z));
    const t = (y - patchBottom) / (patchTop - patchBottom);
    const arc = arcAt(Math.min(1, Math.max(0, t)));
    const across = 1 - smoothstep(arc * 0.42, arc, phi);
    const along =
      smoothstep(patchBottom, patchBottom + 0.1, y) *
      (1 - smoothstep(patchTop - 0.11, patchTop, y));
    mixed.copy(fur).lerp(belly, Math.min(1, across * along * intensity * 1.6));
    colors[i * 3] = mixed.r;
    colors[i * 3 + 1] = mixed.g;
    colors[i * 3 + 2] = mixed.b;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  torsoGeometryCache.set(style.id, geometry);
  return geometry;
}

export function avatarDecor(character: CharacterId): readonly AvatarDecorSpec[] {
  const style = CHARACTER_STYLES[character];
  const w = style.bodyScale;
  return [
    ...jointDecor(w, style.limbScale),
    // 脖子：头与胸之间那一段。没有它，下巴底下会露出一个镂空的洞
    {
      parent: "torso", geometry: "cylinder",
      size: { x: NECK_RADIUS * w * 2, y: 0.2, z: NECK_RADIUS * w * 2 },
      pos: { x: 0, y: 1.44, z: 0.006 }, material: "fur",
    },
    ...headDecor(style),
    ...neckDecor(style, w),
    ...handDecor(w),
    ...toeDecor(w),
  ];
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
 * 一个 avatar 现在是 ~90 个 mesh（16 骨架 + 70 装饰 + 手持道具），
 * 8 人局就是 700 份 `BufferGeometry`。这些几何的尺寸**只由角色与体型决定**，
 * 全场最多几十种，逐 avatar 新建等于把同一批顶点上传 7 遍。
 *
 * 代价是几何**不能再按 avatar 释放**——所以 `dispose()` 只清引用，真正的释放在
 * {@link disposeAvatarGeometries}（整局销毁时才调用，和材质同一条规矩）。
 */
const geometryCache = new Map<string, THREE.BufferGeometry>();

/** 椭球/穹顶用的单位球：全场只有这一份，形状差异全靠 `mesh.scale`。 */
let unitSphere: THREE.SphereGeometry | null = null;
let unitDome: THREE.SphereGeometry | null = null;

function ellipsoidPrimitive(): THREE.BufferGeometry {
  unitSphere ??= new THREE.SphereGeometry(0.5, 26, 20);
  return unitSphere;
}

function domePrimitive(): THREE.BufferGeometry {
  unitDome ??= new THREE.SphereGeometry(0.5, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  return unitDome;
}

function profileKey(profile: readonly (readonly [number, number])[]): string {
  return profile.map(([r, y]) => `${r.toFixed(4)}:${y.toFixed(4)}`).join(",");
}

function createPrimitive(
  spec: Pick<MeshSpec, "geometry" | "size"> & { profile?: MeshSpec["profile"] },
): THREE.BufferGeometry {
  const { x, y, z } = spec.size;
  // 椭球/穹顶永远是同一个单位球再靠 mesh.scale 变形，天然只有一份，不占缓存
  if (spec.geometry === "ellipsoid") {
    return ellipsoidPrimitive();
  }
  if (spec.geometry === "dome") {
    return domePrimitive();
  }
  if (spec.geometry === "lathe") {
    const key = `lathe|${profileKey(spec.profile ?? [])}`;
    const cached = geometryCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const points = (spec.profile ?? []).map(([r, h]) => new THREE.Vector2(r, h));
    const created = new THREE.LatheGeometry(points, 96);
    geometryCache.set(key, created);
    return created;
  }
  const key: string =
    `${spec.geometry}|${x.toFixed(4)}|${y.toFixed(4)}|${z.toFixed(4)}`;
  const cached = geometryCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const created: THREE.BufferGeometry = (() => {
    if (spec.geometry === "sphere") {
      return new THREE.SphereGeometry(x, 14, 12);
    }
    if (spec.geometry === "capsule") {
      const radius = Math.max(0.002, Math.min(x / 2, y / 2 - 0.001));
      return new THREE.CapsuleGeometry(radius, Math.max(0.002, y - radius * 2), 4, 12);
    }
    if (spec.geometry === "cone") {
      return new THREE.ConeGeometry(Math.max(0.002, x / 2), y, 14);
    }
    if (spec.geometry === "cylinder") {
      // CylinderGeometry(radiusTop, radiusBottom, height, radialSegments)：x/z 传的是直径
      return new THREE.CylinderGeometry(x / 2, z / 2, y, 16, 1);
    }
    if (spec.geometry === "ring") {
      const tube = Math.max(0.002, y / 2);
      return new THREE.TorusGeometry(Math.max(tube, (x - y) / 2), tube, 8, 24);
    }
    return new THREE.BoxGeometry(x, y, z);
  })();
  geometryCache.set(key, created);
  return created;
}

/* ------------------------------------------------------------------ *
 * 卡通描边（inverted hull）
 * ------------------------------------------------------------------ */

/**
 * 描边的世界厚度（米）。
 *
 * 这是**世界空间**的固定值，不是百分比：1.8m 高的角色、屏幕上约 2.3mm/px，
 * 0.007 就是 3px 左右的一条线。按百分比做的话，细手指的边会比躯干粗十倍。
 */
const OUTLINE_WIDTH = 0.013;

/**
 * 描边材质：只画**背面**的纯色壳，没有光照。
 *
 * 为什么必须有它：卡通角色的"读得像动画"有一半来自轮廓线。没有描边的 3D 造型
 * 无论配色多准，看上去都是一块塑料——这是上一版被说"丑"的第一原因
 * （不是配色错，是没有边界，所有面糊在一起）。
 *
 * 不用后期 Sobel：那要额外 RenderTarget + 全屏 pass，而这里是低模、硬边少，
 * 壳法足够，还能跟着骨骼一起变形。
 */
let outlineMaterial: THREE.MeshBasicMaterial | null = null;

function avatarOutlineMaterial(): THREE.MeshBasicMaterial {
  outlineMaterial ??= new THREE.MeshBasicMaterial({
    color: 0x1c1522,
    side: THREE.BackSide,
    // 描边也要吃雾，否则远处角色是一团纯黑剪影
    fog: true,
  });
  return outlineMaterial;
}

/** 外扩后的旋转体几何（躯干的壳）。母线半径整体 +w，高度不变。 */
const outlineGeometryCache = new Map<string, THREE.BufferGeometry>();

function outlineLathe(profile: readonly (readonly [number, number])[], segments: number): THREE.BufferGeometry {
  const key = `outline-lathe|${segments}|${profileKey(profile)}`;
  const cached = outlineGeometryCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const points = profile.map(([r, y]) => new THREE.Vector2(r + OUTLINE_WIDTH, y));
  const created = new THREE.LatheGeometry(points, segments);
  outlineGeometryCache.set(key, created);
  return created;
}

/**
 * 这个部件值不值得描边。
 *
 * 只给"占据轮廓"的大件加壳：眼睛、牙、胡须、领结这些 8.5cm 以下的小件
 * 本来就整块落在别的描边里，加壳纯粹白饶一遍 draw call —— 而且一旦壳比本体
 * 还厚，瞳孔会被自己的描边糊成一团黑。
 */
const OUTLINE_MIN_SIZE = 0.085;

/** 释放共享几何（只在整局销毁时调用，avatar 自身 dispose 不碰几何）。 */
export function disposeAvatarGeometries(): void {
  outlineMaterial?.dispose();
  outlineMaterial = null;
  for (const geometry of outlineGeometryCache.values()) {
    geometry.dispose();
  }
  outlineGeometryCache.clear();
  for (const geometry of geometryCache.values()) {
    geometry.dispose();
  }
  geometryCache.clear();
  unitSphere?.dispose();
  unitSphere = null;
  unitDome?.dispose();
  unitDome = null;
  for (const geometry of torsoGeometryCache.values()) {
    geometry.dispose();
  }
  torsoGeometryCache.clear();
}

function createMesh(spec: MeshSpec & { material: AvatarMaterialKind }, materials: AvatarMaterials): THREE.Mesh {
  const geometry = createPrimitive(spec);
  const mesh = new THREE.Mesh(geometry, materials[spec.material]);
  mesh.position.set(spec.pos.x, spec.pos.y, spec.pos.z);
  if (spec.geometry === "ellipsoid") {
    mesh.scale.set(spec.size.x, spec.size.y, spec.size.z);
  } else if (spec.geometry === "dome") {
    // 单位穹顶半径 0.5、高 0.5：scale.y 乘 2 才能让"高度 = size.y"
    mesh.scale.set(spec.size.x, spec.size.y * 2, spec.size.z);
  } else if (spec.geometry === "lathe") {
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
  // 描边壳：和本体共享同一份几何/同一个父变换，只靠"再放大一圈"推到轮廓外。
  //
  // 挂在 mesh 底下而不是并列，是为了**自动继承**位置/旋转——加描边不用在
  // 任何别处再对齐一次坐标。放大倍数按 spec.size 反推，于是每个部件的壳
  // 在世界空间里都是**同样的厚度**：手指的边和躯干的边一样粗，才像一支笔画的。
  const footprint = Math.max(spec.size.x, spec.size.y, spec.size.z);
  if (spec.outline ?? footprint >= OUTLINE_MIN_SIZE) {
    const lathe = spec.geometry === "lathe";
    const shell = new THREE.Mesh(
      lathe ? outlineLathe(spec.profile ?? [], 96) : geometry,
      avatarOutlineMaterial(),
    );
    shell.name = `outline:${spec.material}`;
    if (!lathe) {
      // ×2：spec.size 是**直径**，要让轮廓外每侧各厚一个线宽，
      // 直径就得加两倍（之前只加了 1 倍，线条细成 1px，等于没有）
      const grow = (spec.outlineWidth ?? OUTLINE_WIDTH) * 2;
      shell.scale.set(
        (spec.size.x + grow) / spec.size.x,
        (spec.size.y + grow) / spec.size.y,
        (spec.size.z + grow) / spec.size.z,
      );
    }
    shell.castShadow = false;
    shell.receiveShadow = false;
    shell.renderOrder = -1;
    mesh.add(shell);
  }
  return mesh;
}

/** 化身骨架引用（供动画逐帧写入）。 */
export interface AvatarRig {
  /** 倒地枢轴（绕局部 X 轴 +90° 后仰）。 */
  fallPivot: THREE.Group;
  /** 上身枢轴（腰线，躯干摆动/侧倾）。 */
  torsoPivot: THREE.Group;
  /** 头部枢轴（五官都挂在这里）。 */
  headPivot: THREE.Group;
  /** 髋关节（旋转 = 大腿摆动）。 */
  hipL: THREE.Group;
  hipR: THREE.Group;
  /** 膝关节（旋转 = 小腿屈曲）。 */
  kneeL: THREE.Group;
  kneeR: THREE.Group;
  /** 肩关节（旋转 = 手臂摆动）。 */
  shoulderL: THREE.Group;
  shoulderR: THREE.Group;
  /** 肘关节（旋转 = 前臂屈曲，右手默认端在腰前）。 */
  elbowL: THREE.Group;
  elbowR: THREE.Group;
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
    const limbScale: number = style.limbScale;

    this.root = new THREE.Group();
    this.root.name = `avatar-${team}-${character}`;

    // 倒地枢轴：y = 0.13，模型整体再下移 0.13 保持脚底在 0
    this.rig = {
      fallPivot: new THREE.Group(),
      torsoPivot: new THREE.Group(),
      headPivot: new THREE.Group(),
      hipL: new THREE.Group(),
      hipR: new THREE.Group(),
      kneeL: new THREE.Group(),
      kneeR: new THREE.Group(),
      shoulderL: new THREE.Group(),
      shoulderR: new THREE.Group(),
      elbowL: new THREE.Group(),
      elbowR: new THREE.Group(),
      tail: new THREE.Group(),
    };
    const { fallPivot, torsoPivot, headPivot, hipL, hipR, kneeL, kneeR, shoulderL, shoulderR, elbowL, elbowR, tail } =
      this.rig;
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

    /** 按角色体型收窄尺寸（只改视觉，不改 `AVATAR_PARTS` 里的基准值）。 */
    const widthOf = (name: string): number => {
      if (name.startsWith("upperArm") || name.startsWith("foreArm")) {
        return widthScale * limbScale;
      }
      if (name.startsWith("thigh") || name.startsWith("shin") || name.startsWith("foot")) {
        return widthScale * limbScale;
      }
      return widthScale;
    };
    const narrow = (spec: AvatarPartSpec): AvatarPartSpec => {
      if (spec.geometry === "lathe") {
        // 旋转体：size 是缩放系数，躯干深度再压扁 14%（正面宽、侧面薄）
        return { ...spec, size: { x: widthScale, y: 1, z: spec.size.z * widthScale } };
      }
      const k = widthOf(spec.name);
      return { ...spec, size: { x: spec.size.x * k, y: spec.size.y, z: spec.size.z * k } };
    };

    // ---- 躯干组（含头/骨盆/尾根，绕腰线枢轴摆动）----
    torsoPivot.position.y = WAIST_Y;
    body.add(torsoPivot);

    const attachTorso = (name: string): THREE.Mesh => {
      const spec = requirePart(name);
      // 头 / 毛簇 / 口鼻按 headScale 放大（不乘 bodyScale）
      const isHead: boolean = name === "head" || name === "crest" || name === "muzzle";
      const muzzleK: number = style.face.muzzle;
      const base: AvatarPartSpec = name === "torso" ? { ...spec, profile: torsoProfileOf(style) } : spec;
      const scaled: AvatarPartSpec = isHead
        ? {
            ...spec,
            size: {
              x: base.size.x * style.headScale * (name === "muzzle" ? muzzleK : 1),
              y: base.size.y * (name === "muzzle" ? muzzleK : 1),
              z: base.size.z * (name === "muzzle" ? muzzleK : style.headScale),
            },
            pos: {
              x: base.pos.x,
              y: base.pos.y,
              z: name === "muzzle" ? MUZZLE_CENTER_Z : base.pos.z,
            },
          }
        : narrow(base);
      const mesh =
        name === "torso"
          ? (() => {
              const torsoMesh = new THREE.Mesh(torsoGeometryOf(style), this.materials.torso);
              torsoMesh.castShadow = true;
              return torsoMesh;
            })()
          : createMesh(scaled, this.materials);
      // 躯干件挂腰线枢轴，头三件挂头枢轴（坐标从世界高度换成局部）
      if (isHead) {
        mesh.position.set(scaled.pos.x, scaled.pos.y - HEAD_CENTER_Y, scaled.pos.z);
        headPivot.add(mesh);
      } else if (name === "torso") {
        // 母线是绝对尺寸，这里只叠体型系数（size 三个分量就是缩放系数）
        mesh.scale.set(scaled.size.x, 1, scaled.size.z);
        mesh.position.set(0, -WAIST_Y, 0);
        torsoPivot.add(mesh);
      } else {
        mesh.position.set(scaled.pos.x, scaled.pos.y - WAIST_Y, scaled.pos.z);
        torsoPivot.add(mesh);
      }
      parts.set(name, mesh);
      return mesh;
    };
    headPivot.position.y = HEAD_CENTER_Y - WAIST_Y;
    torsoPivot.add(headPivot);
    attachTorso("torso");
    attachTorso("pelvis");
    attachTorso("tailBase");
    attachTorso("head");
    attachTorso("crest");
    attachTorso("muzzle");

    // ---- 尾巴：尾根枢轴 → 6 节，先向后、再向上卷 ----
    tail.position.set(0, PELVIS_CENTER_Y + 0.02, TAIL_BASE_Z + 0.02);
    body.add(tail);
    {
      const segmentCount = 6;
      const segmentLength = 0.095 * style.tailLength;
      const baseRadius = 0.026 * style.tailThickness;
      /**
       * 每节的相对转角。正角度绕 X 轴把本节末端推向 +Z（身后）。
       *
       * 这里曾经是 `[-1.12, 0.34, ...]`——符号反了，第一节把尾巴朝 **−Z（身前）**
       * 折过去，整条尾巴从背后穿过躯干、在胸口露出四节，看起来像"肚子上插了根棍子"。
       * 这是四个角色共有的 bug，也是"丑"里最扎眼的一处。
       */
      const curl = [1.12, -0.34, -0.34, -0.32, -0.3, -0.26];
      let parent: THREE.Object3D = tail;
      for (let i = 0; i < segmentCount; i += 1) {
        const joint = new THREE.Group();
        joint.position.y = i === 0 ? 0 : segmentLength;
        joint.rotation.x = curl[Math.min(i, curl.length - 1)] as number;
        parent.add(joint);
        const radius = baseRadius * (1 - (i / segmentCount) * 0.45);
        const mesh = new THREE.Mesh(
          createPrimitive({ geometry: "cylinder", size: { x: radius * 2, y: segmentLength + radius, z: radius * 2 } }),
          this.materials.fur,
        );
        // 圆柱默认中点在原点，抬到"上一节末端 → 本节末端"的正中
        mesh.position.y = (segmentLength + radius) / 2;
        mesh.castShadow = true;
        joint.add(mesh);
        parent = joint;
      }
      // 尾尖：小圆球收口（猫尾比圆柱自然得多）
      const tipRadius = baseRadius * 0.58;
      const tip = new THREE.Mesh(
        createPrimitive({ geometry: "ellipsoid", size: { x: 1, y: 1, z: 1 } }),
        this.materials.fur,
      );
      tip.scale.set(tipRadius * 2, tipRadius * 2.4, tipRadius * 2);
      tip.position.y = segmentLength;
      parent.add(tip);
    }

    // ---- 手臂：肩枢轴 → 上臂；肘枢轴 → 前臂 ----
    const attachArm = (side: -1 | 1, shoulder: THREE.Group, elbow: THREE.Group): void => {
      shoulder.position.set(side * ARM_VISUAL_X * widthScale, SHOULDER_Y - WAIST_Y, 0);
      torsoPivot.add(shoulder);

      const upperSpec = narrow(requirePart(side < 0 ? "upperArmL" : "upperArmR"));
      const upperMesh = createMesh(upperSpec, this.materials);
      upperMesh.position.set(0, -UPPER_ARM_HEIGHT / 2, 0);
      shoulder.add(upperMesh);
      parts.set(side < 0 ? "upperArmL" : "upperArmR", upperMesh);

      elbow.position.set(0, -UPPER_ARM_HEIGHT, 0);
      shoulder.add(elbow);

      const foreSpec = narrow(requirePart(side < 0 ? "foreArmL" : "foreArmR"));
      const foreMesh = createMesh(foreSpec, this.materials);
      foreMesh.position.set(0, -FOREARM_HEIGHT / 2, 0);
      elbow.add(foreMesh);
      parts.set(side < 0 ? "foreArmL" : "foreArmR", foreMesh);
    };
    attachArm(-1, shoulderL, elbowL);
    attachArm(1, shoulderR, elbowR);
    // 持物姿态：右臂垂、小臂前抬，腕落在腰前；左臂只弯一点点，看起来是自然站姿
    // 手臂不外倾：外倾会让肩球与上臂错位，关节处露出一道台阶，
    // 手掌也跟着朝外翻（像举手投降）。肩膀的斜线交给躯干的斜方肌段去做。
    shoulderR.rotation.x = CARRY_SHOULDER;
    elbowR.rotation.x = CARRY_ELBOW;
    elbowL.rotation.x = 0.22;

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

      const footSpec = narrow(requirePart(footName));
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
    const decorGroups: Record<AvatarDecorParent, THREE.Object3D> = {
      head: headPivot,
      torso: torsoPivot,
      shoulderL,
      shoulderR,
      elbowL,
      elbowR,
      hipL,
      hipR,
      kneeL,
      kneeR,
      foreArmL: elbowL,
      foreArmR: elbowR,
    };
    for (const decor of avatarDecor(character)) {
      const target = decorGroups[decor.parent];
      const mesh = createMesh(decor, this.materials);
      mesh.name = `decor-${decor.parent}`;
      mesh.castShadow = false;
      // 躯干件写的是世界高度 → 减腰线；头部件写的是头心局部 → 原样；关节件 → 原样
      let offsetY = 0;
      if (decor.parent === "torso") {
        offsetY = WAIST_Y;
      }
      mesh.position.set(decor.pos.x, decor.pos.y - offsetY, decor.pos.z);
      target.add(mesh);
    }

    // ---- 武器挂点：右前臂末端（腕），并把枪身扳回水平 ----
    const handAnchor = new THREE.Object3D();
    handAnchor.name = "handAnchor";
    handAnchor.position.set(0, -FOREARM_HEIGHT, 0);
    // 只做一件事：抵消肩 + 肘的屈曲，让"手里那件"重新回到水平。
    // 早期这里还套了一个 rotation.y = π，再在 mount 上套一个 π 去抵消——
    // 净旋转虽然是 0，但叠上 X 之后**枪会倒过来拿**（up 变成 -Y）。
    handAnchor.rotation.x = -(CARRY_SHOULDER + CARRY_ELBOW);
    elbowR.add(handAnchor);
    const weaponMount = new THREE.Group();
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
    const { hipL, hipR, kneeL, kneeR, shoulderL, shoulderR, torsoPivot, tail, headPivot, elbowL } = this.rig;

    hipL.rotation.x = Math.sin(phase) * LEG_SWING * a;
    hipR.rotation.x = Math.sin(phase + Math.PI) * LEG_SWING * a;
    kneeL.rotation.x = -KNEE_BEND * Math.max(0, Math.sin(phase - 0.6)) * a;
    kneeR.rotation.x = -KNEE_BEND * Math.max(0, Math.sin(phase + Math.PI - 0.6)) * a;
    // 左臂与左腿反相，持物臂幅度更小（端着的家伙不该跟着甩）
    shoulderL.rotation.x = Math.sin(phase + Math.PI) * ARM_SWING * a;
    shoulderR.rotation.x = CARRY_SHOULDER + Math.sin(phase) * GUN_ARM_SWING * a;
    elbowL.rotation.x = 0.22 + Math.max(0, Math.sin(phase + Math.PI)) * 0.12 * a;
    torsoPivot.position.y = WAIST_Y + TORSO_BOB * Math.sin(phase * 2) * a;
    torsoPivot.rotation.z = TORSO_ROLL * Math.sin(phase) * a;
    // 头部反向微摆：抵消躯干侧倾，视线才不会跟着身体一起晃
    headPivot.rotation.z = -TORSO_ROLL * 0.6 * Math.sin(phase) * a;
    headPivot.rotation.x = 0.02 * Math.sin(phase * 2) * a;
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
