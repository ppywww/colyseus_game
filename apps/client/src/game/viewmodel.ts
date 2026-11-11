/**
 * 第一人称持枪视模型（CS2 风格：可见前臂与手套、枪身右下斜置）。
 *
 * 层级（与 docs/参考-CS2视觉与地图.md 2.1 一致）：
 *
 *   camera
 *   └── holder            ← 只做动画：位置 = BASE_POS + Σ增量，旋转 = BASE_ROT + Σ增量
 *       └── gunGroup      ← 静止姿态的枪体容器（以下 25 个部件全部挂在它下面）
 *           ├── receiver / handguardUp / … / charging（机匣到拉机柄，共 25 个部件）
 *           └── muzzleAnchor ← 枪口火光与点光源的挂载点，跟着后坐/换弹一起动
 *
 * 两个「改了就崩」的要点：
 *   1. `holder.rotation` 每帧必须写成 **BASE_ROT + 增量**。旧实现每帧 `rotation.set(增量)` 会把
 *      静态的 z = 0.13（7.4° 斜置）吃掉，枪永远是正的，怎么调参数都不像截图。
 *   2. 所有动画都是**叠加式**的：idle + walk + fire + reload + throw 的增量相加，
 *      任何一环改成「直接赋值」都会互相打架。
 *
 * 纯函数 {@link computeViewmodelPose} 不依赖 three.js，便于在 Node 里单测构图与动画曲线。
 */

import * as THREE from "three";

import {
  THROW_COOLDOWN_MS,
  WEAPON_SLOTS,
  characterOfIndex,
  throwableTypeOfSlot,
} from "@colyseus-fps/shared";

import { CHARACTER_STYLES } from "./avatar-model.js";

/* ------------------------------------------------------------------ *
 * 静态姿态与枪口挂点（数值来自参考文档 2.3.1 / 2.6.1，不要随手改）
 * ------------------------------------------------------------------ */

/** 枪根（握把顶端 / 机匣后端交点）在相机坐标系中的位置。 */
export const VIEWMODEL_BASE_POSITION = { x: 0.2387, y: -0.228, z: -0.4 };

/**
 * 枪根静态旋转：(x) 枪口微抬 2.9°、(y) 枪口微左 2.9°、(z) 枪身右滚 7.4°。
 * z 就是「枪身斜置」的来源，必须是 +0.13 且每帧以 BASE + 增量形式写回。
 */
export const VIEWMODEL_BASE_ROTATION = { x: 0.05, y: 0.05, z: 0.13 };

/** 枪口挂点（相对枪根，−Z 为枪口方向）。比枪口帽外沿再出 25mm。 */
export const VIEWMODEL_MUZZLE_LOCAL = { x: 0, y: 0.03, z: -0.6 };

/** idle 呼吸：角频率（4.0s 周期）与半频（李萨如轨迹，避免机械感）。 */
const IDLE_OMEGA = 1.571;
const IDLE_OMEGA_HALF = 0.785;

/** walk 摆动：相位推进速度（rad/s）、摆幅淡入时间常数（秒）。 */
const WALK_BOB_RATE = 9.0;
const SPRINT_BOB_RATE = 12.0;
const BOB_AMP_TAU = 0.12;

/** fire 后坐：位移/角度的回弹时间常数与连发上限。 */
const RECOIL_POS_TAU = 0.09;
const RECOIL_ROT_TAU = 0.11;
const RECOIL_POS_STEP = 0.045;
const RECOIL_POS_MAX = 0.08;
const RECOIL_ROT_STEP = 0.055;
const RECOIL_ROT_MAX = 0.1;

/** 落地冲击：冲击位移与回弹时间常数（秒）。 */
const LANDING_IMPACT = 0.02;
const LANDING_TAU = 0.13;
/** 触发落地冲击的最低落差速度（米/秒）。 */
const LANDING_MIN_SPEED = 6;

/** reload 关键帧分界（归一化进度）。 */
const RELOAD_PRESS_END = 0.15;
const RELOAD_MAG_OUT_END = 0.35;
const RELOAD_MAG_IN_END = 0.55;
const RELOAD_CHARGE_END = 0.8;

/** throw 三段分界（毫秒）。 */
const THROW_SWING_END_MS = 180;
const THROW_HOLD_END_MS = 420;

/* ---------------- 切枪（下压再抬回） ---------------- */

/**
 * 切枪时枪身的下沉量（米）与抬头角（弧度）。
 *
 * 数值取"看得见但不挡准心"：0.22m 大约等于屏幕高度的 1/5，
 * 配合 0.25rad（14°）的抬头，滚动切枪时玩家能明确感到"换了一把"，
 * 但准心位置始终可见（不会被枪身遮住，否则切枪过程中完全没法对枪）。
 */
const SWITCH_DIP_POS = 0.22;
const SWITCH_DIP_ROT = 0.25;
/** 切枪时向后收的位移（米），避免枪身下沉时穿进画面下边缘。 */
const SWITCH_DIP_BACK = 0.04;

/* ---------------- 挥刀（前挥 120ms + 回位 140ms） ---------------- */

/** 前挥阶段时长（毫秒）：这一段必须快，否则手感变"推刀"。 */
export const KNIFE_SWING_FORWARD_MS = 120;
/** 单次挥砍总时长（毫秒）：由服务端 `MELEE_COOLDOWN_MS`（650ms）留出余量。 */
export const KNIFE_SWING_TOTAL_MS = 260;

/* ---------------- 蝴蝶刀花式转刀（待机表演） ---------------- */

/** 一次完整 360° 转刀用时（毫秒）：太慢像坏掉，太快看不清刃口。 */
export const KNIFE_TWIRL_MS = 620;
/** 两次转刀之间的静置时长（毫秒）。 */
export const KNIFE_TWIRL_GAP_MS = 3000;
/** 一个完整转刀周期。 */
export const KNIFE_TWIRL_CYCLE_MS = KNIFE_TWIRL_GAP_MS + KNIFE_TWIRL_MS;

/**
 * 投掷出手的时机（占整个 700ms 投掷动作的比例）：`0.45 × 700 = 315ms`，
 * 正好落在投掷动作第二段（180–420ms 的"甩出/停顿"）里，看起来是球从手心飞出去。
 */
export const THROW_RELEASE_RATIO = 0.45;

/* ------------------------------------------------------------------ *
 * 纯函数：构图与动画曲线（不依赖 three.js）
 * ------------------------------------------------------------------ */

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** 视模型姿态求解所需的全部输入（累加量由 {@link ViewModel} 维护，便于纯函数复用与单测）。 */
export interface ViewmodelPoseState {
  /** 是否在移动（决定 bob 摆幅目标）。 */
  moving: boolean;
  /** 是否踩在地面上（离开地面时摆幅自然减弱，落地冲击另算）。 */
  grounded: boolean;
  /** 换弹归一化进度 0→1，0 表示未换弹。 */
  reloadProgress: number;
  /** 投掷归一化进度 0→1，0 表示未投掷。 */
  throwProgress: number;
  /** walk 摆动相位（弧度）。 */
  bobPhase: number;
  /** walk 摆幅系数 0→1（由 {@link advanceBobAmp} 逐帧淡入淡出）。 */
  bobAmp: number;
  /** 后坐力位移累加（米，沿 +Z 后退）。 */
  recoilPos: number;
  /** 后坐力 pitch 累加（弧度，枪口上跳）。 */
  recoilRot: number;
  /** 后坐力 roll 累加（弧度，每发随机）。 */
  recoilRoll: number;
  /** 落地冲击的垂直位移（负值 = 下沉），由外部按 τ=130ms 回弹。 */
  landing: number;
  /** 切枪归一化进度 0→1（0 / 1 都是零增量，只有中途下压）。 */
  switchProgress?: number;
  /** 挥刀已进行的毫秒数（刀专用；其他武器传 0）。 */
  knifeSwingMs?: number;
}

export interface ViewmodelPose {
  position: Vec3Like;
  rotation: Vec3Like;
}

/** 单位阶跃平滑（smoothstep），输入自动钳制到 [0,1]。 */
export function smoothstep(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return clamped * clamped * (3 - 2 * clamped);
}

/**
 * 推进 bob 摆幅系数：`amp = lerp(amp, moving ? 1 : 0, 1 − exp(−dt/τ))`。
 *
 * τ = 120ms 的淡入淡出是「停走瞬间枪不跳一下」的唯一保证，不能省。
 */
export function advanceBobAmp(current: number, moving: boolean, dtSeconds: number): number {
  const target = moving ? 1 : 0;
  const alpha = 1 - Math.exp(-Math.min(dtSeconds, 0.1) / BOB_AMP_TAU);
  const next = current + (target - current) * alpha;
  return Math.min(1, Math.max(0, next));
}

/** 推进 bob 相位：走 9.0 rad/s，冲刺 12.0 rad/s，停下时不推进。 */
export function advanceBobPhase(current: number, moving: boolean, sprinting: boolean, dtSeconds: number): number {
  if (!moving) {
    return current;
  }
  const rate = sprinting ? SPRINT_BOB_RATE : WALK_BOB_RATE;
  const next = current + Math.min(dtSeconds, 0.1) * rate;
  // 防止长时间对局后相位数值过大导致精度下降
  return next % (Math.PI * 2);
}

/**
 * reload 姿态包络：0→1 表示「下压换弹姿态」的强度。
 * 分四段：入位下压（0–0.15）→ 保持（0.15–0.55）→ 回抬（0.55–0.80）→ 收尾（0.80–1.00）。
 */
function reloadPoseEase(progress: number): number {
  const p = Math.min(1, Math.max(0, progress));
  if (p <= 0) {
    return 0;
  }
  if (p < RELOAD_PRESS_END) {
    return smoothstep(p / RELOAD_PRESS_END);
  }
  if (p < RELOAD_MAG_IN_END) {
    return 1;
  }
  if (p < RELOAD_CHARGE_END) {
    return 1 - smoothstep((p - RELOAD_MAG_IN_END) / (RELOAD_CHARGE_END - RELOAD_MAG_IN_END));
  }
  return 0;
}

/** throw 姿态包络：0→1→0（甩出 / 空手停顿 / 回位三段）。 */
function throwPoseEase(progress: number): number {
  const p = Math.min(1, Math.max(0, progress));
  const ms = p * THROW_COOLDOWN_MS;
  if (ms <= 0) {
    return 0;
  }
  if (ms <= THROW_SWING_END_MS) {
    return smoothstep(ms / THROW_SWING_END_MS);
  }
  if (ms <= THROW_HOLD_END_MS) {
    return 1;
  }
  return 1 - smoothstep((ms - THROW_HOLD_END_MS) / (THROW_COOLDOWN_MS - THROW_HOLD_END_MS));
}

/**
 * 切枪姿态包络：`sin(πp)`，p=0 / p=1 时都是 0，中途升到 1。
 *
 * 为什么用正弦而不是 smoothstep：切枪必须是"下压 → 抬回"的往返，
 * smoothstep 单调递增只能做"压下去不动"，回位会在 p=1 处突跳。
 */
export function switchPoseEase(progress: number): number {
  const p = Math.min(1, Math.max(0, progress));
  return Math.sin(Math.PI * p);
}

/** 挥刀姿态增量（相对静止姿态）。 */
export interface KnifeSwingPose {
  dx: number;
  dy: number;
  dz: number;
  rx: number;
  ry: number;
  rz: number;
}

/**
 * 花式转刀的旋转角（弧度）。
 *
 * 静置段返回 0；进入转刀段后用 smoothstep 跑满 2π，首尾角速度都是 0，
 * 所以"开始转"和"转完停下"都不会有突兀的急停。非法输入一律按 0 处理。
 *
 * @param twirlMs 周期内相位（0 … {@link KNIFE_TWIRL_CYCLE_MS}）
 */
export function knifeTwirlAngle(twirlMs: number): number {
  if (!Number.isFinite(twirlMs)) {
    return 0;
  }
  const t = Math.min(1, Math.max(0, (twirlMs - KNIFE_TWIRL_GAP_MS) / KNIFE_TWIRL_MS));
  if (t <= 0) {
    return 0;
  }
  if (t >= 1) {
    return Math.PI * 2;
  }
  return t * t * (3 - 2 * t) * Math.PI * 2;
}

/**
 * 求某一时刻的挥刀姿态增量。
 *
 * 曲线设计：0–120ms 用 smoothstep 快速"左下横扫 + 抬腕"，
 * 120–260ms 用 smoothstep 反向回到零。两端增量都是 0，所以连点挥刀不会跳帧。
 *
 * @param elapsedMs 距离本次挥刀开始的毫秒数（超出 {@link KNIFE_SWING_TOTAL_MS} 后返回全零）
 */
export function computeKnifeSwingPose(elapsedMs: number): KnifeSwingPose {
  const zero: KnifeSwingPose = { dx: 0, dy: 0, dz: 0, rx: 0, ry: 0, rz: 0 };
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0 || elapsedMs >= KNIFE_SWING_TOTAL_MS) {
    return zero;
  }

  const forward: number =
    elapsedMs <= KNIFE_SWING_FORWARD_MS
      ? smoothstep(elapsedMs / KNIFE_SWING_FORWARD_MS)
      : 1 - smoothstep((elapsedMs - KNIFE_SWING_FORWARD_MS) / (KNIFE_SWING_TOTAL_MS - KNIFE_SWING_FORWARD_MS));

  return {
    // 向左下横扫并往前推：刀的"够到"感来自 dz
    dx: -0.16 * forward,
    dy: -0.03 * forward,
    dz: -0.1 * forward,
    // 抬腕 + 刀身左倾 49°，这是"斜劈"而不是"直捅"
    rx: 0.35 * forward,
    ry: 0.22 * forward,
    rz: -0.85 * forward,
  };
}

/**
 * 求某一时刻的视模型姿态（枪根在相机空间的位置与欧拉角）。
 *
 * @param state 累加量快照（bob 相位/幅度、后坐、落地冲击、换弹/投掷/切枪/挥刀进度）。
 * @param tSeconds 动画累计时间（秒），只驱动 idle 呼吸这一项。
 * @returns 最终 position / rotation，已包含 BASE 静态姿态。
 */
export function computeViewmodelPose(state: ViewmodelPoseState, tSeconds: number): ViewmodelPose {
  // ---- idle 呼吸：±4mm 垂直 + ±2.5mm 水平（半频），角度 ≤0.35° ----
  let dx = Math.sin(tSeconds * IDLE_OMEGA_HALF) * 0.0025;
  let dy = Math.sin(tSeconds * IDLE_OMEGA) * 0.004;
  let dz = 0;
  let rx = Math.sin(tSeconds * IDLE_OMEGA) * 0.004;
  let ry = 0;
  let rz = Math.sin(tSeconds * IDLE_OMEGA_HALF + 1.2) * 0.006;

  // ---- walk 摆动：全部乘 bobAmp（淡入淡出），避免停走瞬间跳枪 ----
  const amp = Math.min(1, Math.max(0, state.bobAmp));
  // 空中没有步伐支撑，摆动减半（只影响 bob，不影响后坐/换弹/呼吸）
  const airDamp = state.grounded ? 1 : 0.5;
  dx += Math.sin(state.bobPhase) * 0.01 * amp * airDamp;
  dy += -Math.abs(Math.cos(state.bobPhase)) * 0.012 * amp * airDamp;
  dz += Math.sin(state.bobPhase * 2) * 0.006 * amp * airDamp;
  rz += Math.sin(state.bobPhase) * 0.02 * amp * airDamp;
  ry += Math.sin(state.bobPhase * 0.5) * 0.012 * amp * airDamp;

  // ---- fire 后坐：位移 + 上跳 + 随机滚转（衰减由外部完成，这里只叠加） ----
  dz += state.recoilPos;
  rx += state.recoilRot;
  rz += state.recoilRoll;

  // ---- 落地冲击：一次性下沉后指数回弹 ----
  dy += state.landing;

  // ---- reload：枪身下压 + 右倾 + 侧转（把弹匣井朝向玩家，才看得见"换弹匣"） ----
  // 幅度按 CS2 的换弹幅度给：枪身整体转 24°、右倾 46°、下沉 15cm。
  // 太小（旧值 17°/31°/10cm）在 1080p 下会被枪身自身遮住，玩家读不到"正在换弹"。
  const reloadEase = reloadPoseEase(state.reloadProgress);
  if (reloadEase > 0) {
    rx += -0.42 * reloadEase;
    ry += -0.3 * reloadEase;
    rz += 0.8 * reloadEase;
    dy += -0.15 * reloadEase;
    dz += 0.08 * reloadEase;
    const progress = Math.min(1, state.reloadProgress);
    // 弹匣入位的那一下：0.55–0.70 之间补一个快速下沉 + 上抬，动作才有"节奏点"。
    // 没有它的话整个换弹是一条平缓的曲线，看起来像"枪自己慢慢沉下去"，不像人在操作。
    if (progress > 0.55 && progress < 0.7) {
      const shove = Math.sin(((progress - 0.55) / 0.15) * Math.PI);
      dy += -0.022 * shove;
      rx += -0.06 * shove;
      dz += 0.012 * shove;
    }
    // 收尾缓冲：末 8% 追加一次 6mm 的下沉再回弹
    const tail = (progress - 0.92) / 0.08;
    if (tail > 0 && tail < 1) {
      dy += -0.006 * Math.sin(Math.PI * tail);
    }
  }

  // ---- throw：向左下甩出，空手停顿带轻微抖动 ----
  const throwEase = throwPoseEase(state.throwProgress);
  if (throwEase > 0) {
    dx += -0.1 * throwEase;
    dy += -0.12 * throwEase;
    dz += 0.05 * throwEase;
    rz += -0.35 * throwEase;
    rx += 0.3 * throwEase;
    const ms = state.throwProgress * THROW_COOLDOWN_MS;
    if (ms > THROW_SWING_END_MS && ms <= THROW_HOLD_END_MS) {
      dy += Math.sin(tSeconds * 20) * 0.004;
    }
  }

  // ---- 未落地时摆幅折半已在上面的 airDamp 里处理 ----

  // ---- 切枪：整枪下沉 + 抬头（0→1→0 往返，首尾零增量） ----
  const switchEase = switchPoseEase(state.switchProgress ?? 0);
  if (switchEase > 0) {
    dy += -SWITCH_DIP_POS * switchEase;
    rx += SWITCH_DIP_ROT * switchEase;
    dz += SWITCH_DIP_BACK * switchEase;
    rz += 0.06 * switchEase;
  }

  // ---- 挥刀：左下横扫 + 抬腕（只在持刀时由 Game 喂进度） ----
  const knife = computeKnifeSwingPose(state.knifeSwingMs ?? 0);
  if (knife.dx !== 0 || knife.rx !== 0) {
    dx += knife.dx;
    dy += knife.dy;
    dz += knife.dz;
    rx += knife.rx;
    ry += knife.ry;
    rz += knife.rz;
  }

  return {
    position: {
      x: VIEWMODEL_BASE_POSITION.x + dx,
      y: VIEWMODEL_BASE_POSITION.y + dy,
      z: VIEWMODEL_BASE_POSITION.z + dz,
    },
    rotation: {
      x: VIEWMODEL_BASE_ROTATION.x + rx,
      y: VIEWMODEL_BASE_ROTATION.y + ry,
      z: VIEWMODEL_BASE_ROTATION.z + rz,
    },
  };
}

/**
 * reload 期间弹匣组的局部偏移（相对静止位置），供 {@link ViewModel} 驱动部件动画。
 * 卸弹匣（0.15–0.35）→ 插新弹匣（0.35–0.55，含 p=0.5 的 15mm 过冲）→ 之后归零。
 */
export function computeReloadMagazineOffset(progress: number): { y: number; rotX: number } {
  const p = Math.min(1, Math.max(0, progress));
  const dropDistance = 0.16; // −0.100 → −0.260
  const baseY = -0.1;
  const baseRotX = -0.22;

  if (p < RELOAD_PRESS_END) {
    return { y: baseY, rotX: baseRotX };
  }
  if (p < RELOAD_MAG_OUT_END) {
    const t = smoothstep((p - RELOAD_PRESS_END) / (RELOAD_MAG_OUT_END - RELOAD_PRESS_END));
    return { y: baseY - dropDistance * t, rotX: baseRotX - 0.16 * t };
  }
  if (p < RELOAD_MAG_IN_END) {
    const t = smoothstep((p - RELOAD_MAG_OUT_END) / (RELOAD_MAG_IN_END - RELOAD_MAG_OUT_END));
    // p = 0.50 附近过冲 15mm 再回位（60ms 阻尼振荡的近似）
    const overshoot = p > 0.46 && p < 0.54 ? -0.015 * Math.sin((Math.PI * (p - 0.46)) / 0.08) : 0;
    return { y: baseY - dropDistance * (1 - t) + overshoot, rotX: baseRotX - 0.16 * (1 - t) };
  }
  return { y: baseY, rotX: baseRotX };
}

/**
 * reload 期间拉机柄的局部 z 偏移：0.55–0.80 后拉 40mm 再回位。
 * 返回相对静止位置（z = −0.050）的**增量**。
 */
export function computeReloadChargeOffset(progress: number): number {
  const p = Math.min(1, Math.max(0, progress));
  const start = RELOAD_MAG_IN_END;
  const end = RELOAD_CHARGE_END;
  if (p <= start || p >= end) {
    return 0;
  }
  const t = (p - start) / (end - start);
  // 前半程后拉 40mm，后半程回位
  const pull = t < 0.5 ? smoothstep(t / 0.5) : 1 - smoothstep((t - 0.5) / 0.5);
  return 0.04 * pull;
}

/* ------------------------------------------------------------------ *
 * 视模型：几何体装配 + 每帧动画
 * ------------------------------------------------------------------ */

/**
 * 共享材质组：所有部件只引用这一小组实例（不要每个 part new 一个）。
 *
 * **主题层（v2）**：整套第一人称道具从"真枪 + 多普勒刀"换成**塑料玩具与餐具**。
 * 卡通质感的判据不是"画得圆"，而是**反照率**：金属度压到 0.06、粗糙度提到 0.55 以上，
 * 高光面积小、颜色才会像注塑件；留着 0.9 金属度就算涂成黄色也还是"镀金 AK"。
 * 字段名沿用旧名（gold / wood / gunmetal）以免大面积改动几何代码，语义见每行注释。
 */
interface ViewmodelMaterials {
  /** 主壳：奶酪黄注塑。 */
  gold: THREE.MeshStandardMaterial;
  /** 高光件：浅奶酪。 */
  goldHi: THREE.MeshStandardMaterial;
  /** 阴影件：深奶酪（原「磨损金属」）。 */
  worn: THREE.MeshStandardMaterial;
  /** 配件塑料：天空蓝（握把 / 护木 / 枪托）。 */
  wood: THREE.MeshStandardMaterial;
  /** 深蓝塑料：弹匣 / 内衬。 */
  mag: THREE.MeshStandardMaterial;
  /** 爪垫（跟角色毛色一起变）。 */
  glove: THREE.MeshStandardMaterial;
  gloveHi: THREE.MeshStandardMaterial;
  /** 袖口 = 角色毛色。 */
  sleeve: THREE.MeshStandardMaterial;
  /** 墨色塑料：枪管、小件、叉颈。 */
  gunmetal: THREE.MeshStandardMaterial;
  /** 水箱：半透明天空蓝，玩具水枪的灵魂部件。 */
  tank: THREE.MeshStandardMaterial;
  /** 刀身四段渐变（现在是餐叉的四根齿：不锈钢的明暗过渡）。 */
  dopplerDeep: THREE.MeshStandardMaterial;
  dopplerMid: THREE.MeshStandardMaterial;
  dopplerHi: THREE.MeshStandardMaterial;
  /** 刃口：几乎白的高光条。 */
  dopplerEdge: THREE.MeshStandardMaterial;
  /** 柄：深蓝塑料。 */
  dopplerGrip: THREE.MeshStandardMaterial;
  /* ---- 投掷道具：配色必须与 `throwables.ts` 的 `propTemplates` 逐项对齐 ---- */
  /** 锅身：深板岩灰（不粘锅涂层）。 */
  panMetal: THREE.MeshStandardMaterial;
  /** 锅沿/高光环：亮不锈钢。 */
  panRim: THREE.MeshStandardMaterial;
  /** 锅柄与面粉袋扎口：熟木色。 */
  panHandle: THREE.MeshStandardMaterial;
}

/** {@link ViewModel#update} 的入参：全部来自本地游戏状态，纯表现，不影响弹道。 */
export interface ViewmodelUpdateState {
  /** 是否在水平移动（决定 walk 摆幅）。 */
  moving: boolean;
  /** 是否冲刺（摆幅频率更高）。 */
  sprinting?: boolean;
  /** 是否踩在地面上。 */
  grounded: boolean;
  /** 垂直速度（米/秒），用于判断落地冲击。 */
  verticalSpeed?: number;
  /** 换弹归一化进度 0→1，0 表示未换弹。 */
  reloadProgress: number;
  /** 是否处于投掷动作窗口内（内部计时器据此推进 throw 进度）。 */
  throwing: boolean;
  /** 最近一次开火的时间戳（performance.now）；用于兜底去重，避免重复叠加后坐。 */
  firingAt: number;
  /** 切枪归一化进度 0→1（由 Game 按 `switchEndAt − now` 与槽位时长算出）。 */
  switchProgress?: number;
}

export class ViewModel {
  private readonly holder: THREE.Group;
  private readonly gunGroup: THREE.Group;
  private readonly pistolGroup: THREE.Group;
  private readonly knifeGroup: THREE.Group;
  /** 蝴蝶刀的刀身 + 双柄组件，绕轴销做 360° 花式转刀（待机表演）。 */
  private readonly knifeSpin: THREE.Group;
  private readonly throwableGroup: THREE.Group;
  private readonly muzzleAnchor: THREE.Object3D;
  private readonly pistolMuzzle: THREE.Object3D;
  /** 手里那件道具的根节点：出手瞬间（t≈45%）整组隐藏，切回该槽位时复位。 */
  private readonly throwableBall: THREE.Group;
  /** 平底锅 / 胡椒瓶 / 面粉袋：按槽位切 visible（索引 0–2 ↔ 槽位 3–5）。 */
  private readonly throwableProps: THREE.Group[] = [];
  private readonly magazineGroup: THREE.Group;
  private readonly charging: THREE.Mesh;
  private readonly materials: ViewmodelMaterials;

  /** 当前显示的武器槽位（0–5）。 */
  private currentSlot = -1;

  /** idle / 投掷抖动共用的动画时钟（秒）。 */
  private clock = 0;
  private bobPhase = 0;
  private bobAmp = 0;
  private recoilPos = 0;
  private recoilRot = 0;
  private recoilRoll = 0;
  private landing = 0;
  private throwElapsedMs = 0;
  /** 挥刀已进行的毫秒数；≥ {@link KNIFE_SWING_TOTAL_MS} 表示本次挥砍结束。 */
  private knifeSwingMs = KNIFE_SWING_TOTAL_MS;
  /** 花式转刀的周期内相位；只在"持刀且没在挥"时推进。 */
  private knifeTwirlMs = KNIFE_TWIRL_GAP_MS;
  private previousGrounded = true;
  private previousVerticalSpeed = 0;
  /** 已经处理过的开火时间戳，避免 update 与 recoil 重复叠加。 */
  private handledFiringAt = 0;

  public constructor(private readonly camera: THREE.Camera) {
    // 注塑件：metalness 一律 0.06，roughness 0.5–0.62 —— 只留一点点镜面，高光小而硬
    const plastic = (color: number, roughness = 0.58): THREE.MeshStandardMaterial =>
      new THREE.MeshStandardMaterial({ color, metalness: 0.06, roughness });
    this.materials = {
      gold: plastic(0xffc63d, 0.52),
      goldHi: plastic(0xffe08a, 0.46),
      worn: plastic(0xe0a21a, 0.62),
      wood: plastic(0x3fa9e0, 0.55),
      mag: plastic(0x2b6f96, 0.6),
      glove: plastic(0xfff3e0, 0.86),
      gloveHi: plastic(0xffd9b8, 0.82),
      sleeve: plastic(0x8ca3b8, 0.9),
      gunmetal: plastic(0x2b1b2f, 0.5),
      tank: new THREE.MeshStandardMaterial({
        color: 0x7fd4f5,
        metalness: 0.04,
        roughness: 0.24,
        transparent: true,
        opacity: 0.72,
      }),

      // ---- 餐叉：不锈钢四齿。金属度保留（餐具就该反光），但粗糙度提一点避免"镜面塑料" ----
      dopplerDeep: new THREE.MeshStandardMaterial({ color: 0x7d8894, metalness: 0.7, roughness: 0.42 }),
      dopplerMid: new THREE.MeshStandardMaterial({ color: 0xb9c6d2, metalness: 0.72, roughness: 0.34 }),
      dopplerHi: new THREE.MeshStandardMaterial({ color: 0xdde7f0, metalness: 0.74, roughness: 0.26 }),
      dopplerEdge: new THREE.MeshStandardMaterial({ color: 0xf6fbff, metalness: 0.76, roughness: 0.16 }),
      dopplerGrip: plastic(0x2b6f96, 0.62),

      // ---- 投掷道具：与 `throwables.ts` 里飞出去那三件同色，
      //      "手里拿的"和"扔出去的"必须是同一个东西，颜色不一致比没有模型更伤 ----
      panMetal: plastic(0x5b5262, 0.46),
      panRim: new THREE.MeshStandardMaterial({ color: 0x8b93a3, metalness: 0.55, roughness: 0.38 }),
      panHandle: plastic(0x8a5a34, 0.8),
    };

    this.holder = new THREE.Group();
    this.holder.name = "viewmodel-holder";
    this.holder.position.set(VIEWMODEL_BASE_POSITION.x, VIEWMODEL_BASE_POSITION.y, VIEWMODEL_BASE_POSITION.z);
    this.holder.rotation.set(VIEWMODEL_BASE_ROTATION.x, VIEWMODEL_BASE_ROTATION.y, VIEWMODEL_BASE_ROTATION.z);

    this.gunGroup = new THREE.Group();
    this.gunGroup.name = "viewmodel-gun";
    this.holder.add(this.gunGroup);

    // ---- 1–9：机匣 / 护木 / 枪管 / 准星 ----
    this.gunGroup.add(this.box(0.07, 0.1, 0.32, this.materials.gold, 0, 0.015, -0.06)); // 1 机匣
    // 磨损暗部贴片（0.002m 厚，贴在机匣两侧；只做观感，不参与动画）
    this.gunGroup.add(this.box(0.002, 0.052, 0.18, this.materials.worn, 0.0352, 0.015, -0.06));
    this.gunGroup.add(this.box(0.002, 0.052, 0.18, this.materials.worn, -0.0352, 0.015, -0.06));
    this.gunGroup.add(this.box(0.062, 0.07, 0.26, this.materials.wood, 0, 0.045, -0.33)); // 2 上护木
    this.gunGroup.add(this.box(0.058, 0.048, 0.2, this.materials.wood, 0, -0.01, -0.33)); // 3 下护木
    this.gunGroup.add(
      this.cylinder(0.009, 0.2, this.materials.gunmetal, 0, 0.058, -0.4, Math.PI / 2), // 4 导气管
    );
    this.gunGroup.add(
      this.cylinder(0.014, 0.33, this.materials.gunmetal, 0, 0.03, -0.385, Math.PI / 2), // 5 枪管
    );
    this.gunGroup.add(this.box(0.03, 0.03, 0.045, this.materials.goldHi, 0, 0.03, -0.575)); // 6 枪口帽
    this.gunGroup.add(this.box(0.012, 0.055, 0.014, this.materials.gunmetal, 0, 0.062, -0.5)); // 7 前准星
    this.gunGroup.add(this.box(0.02, 0.022, 0.016, this.materials.gunmetal, 0, 0.078, -0.24)); // 8 后照门
    this.gunGroup.add(this.box(0.024, 0.01, 0.15, this.materials.gunmetal, 0, 0.07, -0.15)); // 9 瞄具座

    // ---- 10–11：弹匣组（换弹时整组下沉，故用一个空 Group 承载） ----
    this.magazineGroup = new THREE.Group();
    this.magazineGroup.name = "viewmodel-magazine";
    this.magazineGroup.position.set(0, -0.1, -0.1);
    this.magazineGroup.rotation.x = -0.22;
    // 子件坐标 = 世界局部坐标 − 组原点（组原点取弹匣中心 (0, −0.100, −0.100)）
    this.magazineGroup.add(this.box(0.055, 0.16, 0.085, this.materials.mag, 0, 0, 0)); // 10 弹匣
    this.magazineGroup.add(this.box(0.06, 0.014, 0.09, this.materials.gunmetal, 0, -0.078, 0.018)); // 11 弹匣底板
    this.gunGroup.add(this.magazineGroup);

    // ---- 12–15：握把 / 扳机护圈 / 枪托 ----
    this.gunGroup.add(this.box(0.045, 0.115, 0.055, this.materials.wood, 0, -0.095, 0.01, 0.3)); // 12 握把
    this.gunGroup.add(this.box(0.006, 0.03, 0.07, this.materials.gunmetal, 0, -0.062, -0.045)); // 13 扳机护圈
    this.gunGroup.add(this.box(0.055, 0.085, 0.24, this.materials.wood, 0, -0.01, 0.2, -0.06)); // 14 枪托
    this.gunGroup.add(this.box(0.058, 0.1, 0.016, this.materials.gunmetal, 0, -0.018, 0.32)); // 15 枪托底板

    // ---- 16：拉机柄（换弹时沿 +Z 后拉） ----
    this.charging = this.box(0.014, 0.014, 0.04, this.materials.goldHi, 0.04, 0.048, -0.05);
    this.gunGroup.add(this.charging);

    // ---- 16b：玩具水枪的两件"灵魂部件" ----
    // 只靠改颜色是骗不了人的：真枪的护木/导气管轮廓 + 黄色 = 一把涂黄的 AK。
    // 加一只**半透明水箱**和一个**喷嘴圆环**之后，剪影才从"枪"变成"水枪"。
    this.gunGroup.add(
      this.cylinder(0.042, 0.2, this.materials.tank, 0, 0.098, -0.12, Math.PI / 2),
    );
    // 水箱的绑带（两道深蓝塑料，把透明件"绑"在枪身上，不然像浮在空中）
    this.gunGroup.add(this.box(0.096, 0.014, 0.016, this.materials.mag, 0, 0.074, -0.05));
    this.gunGroup.add(this.box(0.096, 0.014, 0.016, this.materials.mag, 0, 0.074, -0.19));
    // 喷嘴圆环：正对镜头，读作"这是出水口"
    const nozzle = new THREE.Mesh(new THREE.TorusGeometry(0.027, 0.009, 8, 18), this.materials.mag);
    nozzle.position.set(0, 0.03, -0.582);
    this.gunGroup.add(nozzle);

    // ---- 17–19：右手套（掌背 / 四指 / 拇指） ----
    this.gunGroup.add(this.box(0.062, 0.075, 0.085, this.materials.glove, 0.005, -0.088, 0.015, 0.3, 0, 0.1));
    this.gunGroup.add(this.box(0.058, 0.05, 0.032, this.materials.gloveHi, 0, -0.1, -0.03, 0.3, 0, 0.06));
    this.gunGroup.add(this.box(0.024, 0.048, 0.03, this.materials.glove, -0.03, -0.072, 0.03, 0.2, 0, -0.2));

    // ---- 20：右前臂（腕 → 肘，大部分在屏幕右下方之外） ----
    this.gunGroup.add(
      this.limb(
        new THREE.Vector3(0.02, -0.115, 0.085),
        new THREE.Vector3(0.1, -0.285, 0.3),
        0.042,
        this.materials.sleeve,
      ),
    );

    // ---- 21–23：左手套（托住护木，这是画面里最显眼的那只手） ----
    this.gunGroup.add(this.box(0.07, 0.07, 0.095, this.materials.glove, -0.012, -0.048, -0.33, 0.1, 0, -0.12));
    this.gunGroup.add(this.box(0.062, 0.03, 0.09, this.materials.gloveHi, -0.005, -0.006, -0.34, 0.1, 0, -0.1));
    this.gunGroup.add(this.box(0.022, 0.045, 0.028, this.materials.glove, 0.03, -0.03, -0.32, 0.1, 0, 0.15));

    // ---- 24–25：左前臂 + 左袖口 ----
    const leftWrist = new THREE.Vector3(-0.045, -0.085, -0.245);
    const leftElbow = new THREE.Vector3(-0.15, -0.24, -0.1);
    this.gunGroup.add(this.limb(leftWrist, leftElbow, 0.04, this.materials.sleeve));
    this.gunGroup.add(this.cuff(leftWrist, leftElbow, 0.048, 0.06, this.materials.sleeve));

    // ---- 枪口挂点：挂在 gunGroup 下，后坐/换弹时火光自动跟随 ----
    this.muzzleAnchor = new THREE.Object3D();
    this.muzzleAnchor.name = "viewmodel-muzzle";
    this.muzzleAnchor.position.set(
      VIEWMODEL_MUZZLE_LOCAL.x,
      VIEWMODEL_MUZZLE_LOCAL.y,
      VIEWMODEL_MUZZLE_LOCAL.z,
    );
    this.gunGroup.add(this.muzzleAnchor);

    // ---- 手枪（槽位 1）：与步枪同一坐标系，只是部件不同 ----
    this.pistolGroup = new THREE.Group();
    this.pistolGroup.name = "viewmodel-pistol";
    this.holder.add(this.pistolGroup);
    this.buildPistol(this.pistolGroup);
    this.pistolMuzzle = new THREE.Object3D();
    this.pistolMuzzle.name = "viewmodel-pistol-muzzle";
    this.pistolMuzzle.position.set(0, 0.022, -0.252);
    this.pistolGroup.add(this.pistolMuzzle);

    // ---- 小刀（槽位 2）----
    this.knifeGroup = new THREE.Group();
    this.knifeGroup.name = "viewmodel-knife";
    this.knifeSpin = new THREE.Group();
    this.knifeSpin.name = "viewmodel-knife-spin";
    this.knifeGroup.add(this.knifeSpin);
    this.holder.add(this.knifeGroup);
    this.buildKnife(this.knifeSpin, this.knifeGroup);

    // ---- 投掷物（槽位 3/4/5）：持握手 + 道具球 ----
    this.throwableGroup = new THREE.Group();
    this.throwableGroup.name = "viewmodel-throwable";
    this.holder.add(this.throwableGroup);
    this.throwableBall = this.buildThrowable(this.throwableGroup);

    // 默认拿步枪（与服务端 `weaponSlot = 0` 一致）
    this.setWeaponSlot(WEAPON_SLOTS.RIFLE);

    // 视模型不参与阴影，也不应被主相机 near 平面裁切（最近点 z ≈ −0.32，near = 0.1）
    this.holder.traverse((object) => {
      object.castShadow = false;
      object.receiveShadow = false;
    });

    this.camera.add(this.holder);
  }

  /**
   * 手枪视模型（槽位 1）。
   *
   * 构图取「右手单持、滑套略高于准心线」：部件直接摆在 holder 坐标系里，
   * 这样 idle / walk / 后坐 / 切枪全部复用同一套动画，不需要第二套骨骼。
   */
  private buildPistol(group: THREE.Group): void {
    // 滑套 + 套筒座
    group.add(this.box(0.046, 0.05, 0.2, this.materials.gunmetal, 0, 0.022, -0.142));
    group.add(this.box(0.04, 0.028, 0.15, this.materials.mag, 0, -0.014, -0.1));
    // 枪管口（露出滑套前端 1.2cm，枪口火光挂在这里）
    group.add(this.cylinder(0.011, 0.03, this.materials.goldHi, 0, 0.022, -0.252, Math.PI / 2));
    // 握把 + 弹匣底板
    group.add(this.box(0.042, 0.11, 0.052, this.materials.wood, 0, -0.082, 0, 0.3));
    group.add(this.box(0.046, 0.012, 0.056, this.materials.gunmetal, 0, -0.138, 0.014));
    // 扳机护圈
    group.add(this.box(0.006, 0.026, 0.05, this.materials.gunmetal, 0, -0.044, -0.038));
    // 持握手（掌背 + 四指）与右前臂
    group.add(this.box(0.062, 0.072, 0.082, this.materials.glove, 0.004, -0.082, 0.006, 0.3, 0, 0.1));
    group.add(this.box(0.056, 0.046, 0.03, this.materials.gloveHi, 0, -0.094, -0.036, 0.3, 0, 0.06));
    group.add(
      this.limb(new THREE.Vector3(0.02, -0.11, 0.06), new THREE.Vector3(0.1, -0.28, 0.3), 0.042, this.materials.sleeve),
    );
    // 左手托握（双手持枪姿态，画面里更稳）
    group.add(this.box(0.058, 0.062, 0.07, this.materials.glove, -0.032, -0.078, 0, 0.2, 0, -0.15));
    group.add(
      this.limb(new THREE.Vector3(-0.04, -0.1, 0.02), new THREE.Vector3(-0.16, -0.25, 0.24), 0.04, this.materials.sleeve),
    );
  }

  /**
   * 小刀视模型（槽位 2）：参考图里的**蓝色多普勒蝴蝶刀**（展开态）。
   *
   * 结构分两层，是为了一眼能看出"这是蝴蝶刀"：
   *   - `spin`（刀身 + 双柄 + 轴销）挂在轴销上，可绕轴销整圈自转 → 待机花式转刀；
   *   - 持握手与前臂挂在 `hand`（**不跟着转**），否则整只手跟着刀一起转，像断手风车。
   *
   * 刀身用四段收窄 + 一条亮刃口：多普勒的"渐变蓝"靠材质分段实现，
   * 比给盒子打顶点色便宜，也比贴图稳（无外部资源依赖）。
   */
  private buildKnife(spin: THREE.Group, hand: THREE.Group): void {
    // ---- 持刀姿态 ----
    // 不用欧拉角，直接构造基向量：刀轴斜指左上、刀面法线正对镜头。
    // 试欧拉角时踩过两个坑：① 绕 Y 转多了，手柄正对镜头被压成一根黑棒；
    // ② 绕刀轴滚过头，只看得见一条白刃口，蓝色刀面整个侧过去。
    const bladeAxis = new THREE.Vector3(-0.46, 0.82, -0.24).normalize();
    const zAxis = bladeAxis.clone().negate();                       // 局部 +Z = 刀根方向
    const facing = new THREE.Vector3(0, 0, 1);
    const xAxis = facing.clone().addScaledVector(bladeAxis, -facing.dot(bladeAxis)).normalize();
    const yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis).normalize();
    this.knifeGroup.position.set(-0.026, 0.126, 0.03);
    this.knifeGroup.quaternion.setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis),
    );
    // 再滚 10°：完全正对会显得"贴图一样平"，露出一点厚度才像实物
    this.knifeGroup.rotateZ(-0.18);

    // ---- 叉头：一根颈 + 一根横梁 + 四根齿 ----
    // 为什么用积木拼而不是挤出真实叉形轮廓：挤出的叉齿在斜视角下会出现"叠片台阶"，
    // 而且 4 根 8mm 的齿挤出来是 4 个薄壁面，近看像纸片。用胶囊感的方齿反而更"道具"。
    // 局部 +Z = 柄的方向，所以齿朝 −Z、柄朝 +Z，和旧刀身一致（转刀动画不用改）。
    const tineCount = 4;
    const tineGap = 0.0165;
    const tineLength = 0.16;
    // 颈：从柄到叉头的过渡
    spin.add(this.box(0.016, 0.014, 0.05, this.materials.dopplerDeep, 0, 0, -0.035));
    // 横梁：四根齿的根座
    spin.add(this.box(tineGap * (tineCount - 1) + 0.022, 0.013, 0.016, this.materials.dopplerMid, 0, 0, -0.066));
    for (let i = 0; i < tineCount; i += 1) {
      const x = (i - (tineCount - 1) / 2) * tineGap;
      // 中间两根略长，端部收一点：真叉子的齿是等长的，但等长在透视下会"糊成一块"，
      // 中间加长 4mm 能让剪影一眼数得出 4 根。
      const length = tineLength + (i === 1 || i === 2 ? 0.008 : 0);
      spin.add(this.box(0.0085, 0.0095, length, this.materials.dopplerHi, x, 0, -0.074 - length / 2));
      // 齿尖：一小段更亮的斜切，模拟刃口反光
      spin.add(this.box(0.0075, 0.0085, 0.02, this.materials.dopplerEdge, x, 0, -0.074 - length));
    }

    // ---- 柄：一体式握把（不再是蝴蝶刀的双柄 V 形）----
    spin.add(this.box(0.017, 0.022, 0.135, this.materials.dopplerGrip, 0, 0, 0.062));
    // 柄上的防滑纹：三条深色细条，近看才有细节
    for (let i = 0; i < 3; i += 1) {
      spin.add(this.box(0.019, 0.007, 0.008, this.materials.gunmetal, 0, 0, 0.03 + i * 0.028));
    }
    // 柄尾配重块（让重心读起来在手上，不是"一根签子"）
    spin.add(this.box(0.023, 0.026, 0.016, this.materials.dopplerDeep, 0, 0, 0.133));

    // ---- 持握手 + 右前臂（挂在 knifeGroup 上，不参与转刀）----
    // 手比枪模的手小一号：刀的握把只有 3cm 宽，用枪的手会把刀身整段遮掉。
    // 位置抓在柄的中后段（z≈0.115），把手柄前段和轴销让出来——那块是"这是蝴蝶刀"的关键信息。
    hand.add(this.box(0.048, 0.058, 0.072, this.materials.glove, 0.004, 0.002, 0.1, 0.14, 0, 0.1));
    hand.add(this.box(0.044, 0.026, 0.064, this.materials.gloveHi, 0.002, -0.026, 0.096, 0.14, 0, 0.1));
    // 食指压在柄侧（朝镜头一侧，打破"方块手"）
    hand.add(this.box(0.02, 0.028, 0.05, this.materials.gloveHi, 0.028, 0.022, 0.074, 0.1, 0.2, 0.35));
    hand.add(
      this.limb(new THREE.Vector3(0.014, -0.018, 0.16), new THREE.Vector3(0.115, -0.25, 0.4), 0.04, this.materials.sleeve),
    );
  }

  /**
   * 投掷物视模型（槽位 3/4/5）：握拳 + 道具。
   *
   * 手里这件东西**必须和飞出去的那件一模一样**（平底锅 / 胡椒瓶 / 面粉袋）：
   * 形状与配色都对齐 `throwables.ts` 的 `propTemplates`，
   * 否则"我明明扔的是锅，飞出去是个球"——这种不一致比没有模型更伤。
   * 三个道具都挂在同一个握点上，按槽位切 `visible`。
   *
   * 构图三条硬约束（动数字前先读）：
   *   1. **道具必须高于拳头**。旧版把锅心放在拳心正后方 7cm，锅被手套整块吃掉，
   *      画面里只剩一圈黑边——"看不见"的根因不是尺寸，是遮挡。
   *   2. **距离压在 0.6m 上下**。80° FOV 下 17cm 的锅在 0.75m 处只有 43px，
   *      再远就退化成一个小点，读不出"是口锅"。
   *   3. **锅面朝镜头微斜，不正对**。正对是一块纯色圆饼；斜 15° 才看得见锅沿厚度
   *      和锅底那颗煎蛋，而煎蛋是"这是锅"的唯一视觉证据。
   *
   * @returns 道具组的根（出手瞬间整组隐藏）
   */
  private buildThrowable(group: THREE.Group): THREE.Group {
    // 握点（拳心）。三个道具都以它为原点摆放，所以切槽位时只有 visible 变化，
    // 手不会跟着跳；位置也对齐 `THROW_ORIGIN_SIDE / THROW_ORIGIN_DROP`，
    // 抛物线辅助线从这只手起飞，对不齐会看到"线从手旁边飞出去"。
    const grip = new THREE.Vector3(0.105, -0.162, -0.16);

    // ---- 拳：浑圆的拳头 + 三道指节 + 压在上面的拇指 ----
    // 掌背用**球**不用盒：盒子在这套平光下就是个木箱，球才是动画片里的拳头。
    // 指节做成横过镜头方向的三道浅色棱，而不是一整块"掌上板"：
    // 柄是竖着穿过拳心的，指节必须**横**过来才读得出"握"。
    const fist = new THREE.Mesh(new THREE.SphereGeometry(0.052, 14, 10), this.materials.glove);
    fist.scale.set(1.05, 1.16, 0.98);
    fist.position.copy(grip);
    fist.rotation.set(0.12, 0, -0.06);
    group.add(fist);
    for (let band = 0; band < 3; band += 1) {
      group.add(
        this.box(0.064, 0.021, 0.032, this.materials.gloveHi, grip.x, grip.y + 0.027 - band * 0.027, grip.z + 0.038, 0.12, 0, -0.06),
      );
    }
    const thumb = new THREE.Mesh(new THREE.SphereGeometry(0.023, 10, 8), this.materials.gloveHi);
    thumb.scale.set(1, 1.5, 1);
    thumb.position.set(grip.x - 0.044, grip.y + 0.016, grip.z + 0.016);
    thumb.rotation.z = -0.3;
    group.add(thumb);

    // 右前臂 + 袖口：从手腕往后下方伸出画面（粗细与枪模那条一致）
    const wrist = new THREE.Vector3(grip.x + 0.004, grip.y - 0.03, grip.z + 0.032);
    const elbow = new THREE.Vector3(grip.x + 0.062, grip.y - 0.2, grip.z + 0.3);
    group.add(this.limb(wrist, elbow, 0.042, this.materials.sleeve));
    group.add(this.cuff(wrist, elbow, 0.05, 0.058, this.materials.sleeve));

    const root = new THREE.Group();
    root.name = "viewmodel-throwable-prop";
    root.position.copy(grip);
    group.add(root);

    // ---- 0 · 平底锅：锅面朝镜头、锅柄垂到拳心 ----
    // 定位不是拍脑袋：锅柄末端（锅局部 −0.23 处）绕自身旋转后落在
    // (0.040, −0.211, 0.083)，取反就是锅心的位置——这样"柄尾正好被拳握住"。
    const pan = new THREE.Group();
    pan.position.set(-0.04, 0.211, -0.083);
    pan.rotation.set(-0.32, -0.2, 0.18);
    // 锅身：上沿比锅底大 1cm 的浅锥（圆柱看着像罐头盖，锥台才像锅）
    const panBody = new THREE.Mesh(new THREE.CylinderGeometry(0.098, 0.086, 0.032, 22), this.materials.panMetal);
    panBody.rotation.x = Math.PI / 2;
    pan.add(panBody);
    // 锅沿亮环：一圈高光把圆形轮廓"描"出来，深色锅在深色袖口前才不糊
    const panRim = new THREE.Mesh(new THREE.TorusGeometry(0.096, 0.0062, 8, 26), this.materials.panRim);
    panRim.position.z = 0.015;
    pan.add(panRim);
    // 煎蛋：蛋白是**锥台圆盘**，不是压扁的球——球压到 0.2 倍厚时外缘与锅面几乎平行，
    // 两片近乎共面的面必然 z-fighting，屏幕上就是一圈放射状黑刺（改了三轮才定位到）。
    // 三段 z 依次抬起：锅面 0.016 → 蛋白盘 0.019–0.033 → 蛋黄 0.032–0.048。
    const eggWhite = new THREE.Mesh(new THREE.CylinderGeometry(0.056, 0.05, 0.014, 18), this.materials.glove);
    eggWhite.rotation.x = Math.PI / 2;
    eggWhite.position.set(-0.004, -0.008, 0.026);
    pan.add(eggWhite);
    // 蛋黄用**扁球**（穹顶）不用圆盘：圆盘底面和蛋白正面是两片平行面，
    // 差 1mm 就会在交界圆上炸出一圈黑刺；球的底只是一个点，怎么咬都不会打架。
    const yolk = new THREE.Mesh(new THREE.SphereGeometry(0.024, 16, 12), this.materials.gold);
    yolk.scale.set(1, 1, 0.55);
    yolk.position.set(0.006, 0.01, 0.039);
    pan.add(yolk);
    // 锅柄：木色，从锅沿下缘伸到拳心
    pan.add(this.box(0.023, 0.15, 0.02, this.materials.panHandle, 0, -0.155, 0.004));

    // ---- 1 · 胡椒瓶：奶白瓶身 + 奶酪黄标环 + 灰旋盖 ----
    const pepper = new THREE.Group();
    pepper.position.set(-0.012, 0.092, -0.045);
    const bottle = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.045, 0.115, 16), this.materials.glove);
    pepper.add(bottle);
    // 标环：远处认"这是胡椒瓶不是保温杯"全靠这一圈黄
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.0465, 0.0465, 0.048, 16), this.materials.gold);
    band.position.y = -0.006;
    pepper.add(band);
    const cap = new THREE.Mesh(new THREE.ConeGeometry(0.042, 0.046, 16), this.materials.panMetal);
    cap.position.y = 0.079;
    pepper.add(cap);

    // ---- 2 · 面粉袋：鼓袋 + 木色扎口 + 顶上一撮粉 ----
    const flour = new THREE.Group();
    flour.position.set(-0.01, 0.098, -0.04);
    const sack = new THREE.Mesh(new THREE.SphereGeometry(0.078, 16, 12), this.materials.glove);
    sack.scale.set(1, 1.12, 0.94);
    flour.add(sack);
    const tie = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.039, 0.038, 12), this.materials.panHandle);
    tie.position.y = 0.088;
    flour.add(tie);
    const puff = new THREE.Mesh(new THREE.SphereGeometry(0.036, 12, 8), this.materials.gloveHi);
    puff.scale.set(1, 0.68, 1);
    puff.position.y = 0.113;
    flour.add(puff);
    // 袋身标签：朝镜头一侧（飞出去的那件标签在 −Z，手里的必须朝 +Z 才看得见）
    flour.add(this.box(0.072, 0.058, 0.016, this.materials.gold, 0, -0.006, 0.068));

    this.throwableProps.push(pan, pepper, flour);
    root.add(pan, pepper, flour);
    return root;
  }

  /**
   * 切换手持武器：只切 `visible`，不做淡入（切枪动画由 `switchProgress` 负责掩盖）。
   *
   * @param slot 槽位 0–5；非法值按步枪处理
   */
  public setWeaponSlot(slot: number): void {
    const index: number = Math.max(WEAPON_SLOTS.RIFLE, Math.min(WEAPON_SLOTS.SMOKE, Math.trunc(slot)));
    if (index === this.currentSlot) {
      return;
    }
    this.currentSlot = index;
    this.gunGroup.visible = index === WEAPON_SLOTS.RIFLE;
    this.pistolGroup.visible = index === WEAPON_SLOTS.PISTOL;
    this.knifeGroup.visible = index === WEAPON_SLOTS.KNIFE;
    this.throwableGroup.visible = throwableTypeOfSlot(index) !== null;
    // 切回投掷物时道具必须回到手上（上一次投掷可能已经把它藏了）
    this.throwableBall.visible = true;
    // 只显示当前槽位对应的那一件（平底锅 / 胡椒瓶 / 面粉袋）
    const throwableIndex: number = index - WEAPON_SLOTS.FRAG;
    this.throwableProps.forEach((prop, propIndex) => {
      prop.visible = propIndex === throwableIndex;
    });
  }

  /**
   * 应用角色配色：袖口换成毛色、手套换成爪垫色。
   *
   * 第一人称只看得到前臂与手，但这两块正好占了屏幕右下角的 1/4；
   * 手套还是深灰、袖口还是藏青的话，"我选的是 Jerry"这件事在画面上完全读不出来。
   */
  public setCharacter(characterIndex: number): void {
    const style = CHARACTER_STYLES[characterOfIndex(characterIndex)];
    this.materials.sleeve.color.setHex(style.fur);
    this.materials.glove.color.setHex(style.paw);
    // 指节略深一档，避免整只手是一块纯色（卡通里"分不开手指"就是这种感觉）
    this.materials.gloveHi.color.setHex(style.belly);
  }

  /** 当前显示的武器槽位。 */
  public get weaponSlot(): number {
    return this.currentSlot;
  }

  /**
   * 视模型根节点（**只读诊断用**：离线出图工具 `scripts/preview-viewmodel.mts` 靠它遍历几何）。
   *
   * 运行时不要用它改姿态 —— 所有姿态都必须经 {@link ViewModel#update} 求解，
   * 否则 idle / walk / 后坐会互相打架。
   */
  public get visualRoot(): THREE.Object3D {
    return this.holder;
  }

  /**
   * 触发一次挥刀（0–120ms 前挥、120–260ms 回位）。
   *
   * 不停用旧计时器：连点挥刀时直接从头开始，手感是"一刀接一刀"而不是"排队播放"。
   */
  public swing(): void {
    this.knifeSwingMs = 0;
  }

  /** 开火后坐：枪身后顶 45mm + 上跳 3.15°，指数回弹（连发累加有上限）。 */
  public recoil(nowMs: number): void {
    this.handledFiringAt = nowMs;
    this.recoilPos = Math.min(this.recoilPos + RECOIL_POS_STEP, RECOIL_POS_MAX);
    this.recoilRot = Math.min(this.recoilRot + RECOIL_ROT_STEP, RECOIL_ROT_MAX);
    this.recoilRoll = (Math.random() - 0.5) * 0.024;
  }

  /**
   * 枪口在**相机坐标系**中的位置（跟随后坐/换弹/投掷/切枪动画）。
   * 供 {@link CombatEffects} 摆放火光 sprite 与点光源，保证「火光永远在枪口帽正前方」。
   *
   * 手枪用自己那根枪管口的挂点；刀与投掷物返回步枪挂点（调用方按槽位决定要不要画火光）。
   */
  public getMuzzleWorldOffset(): Vec3Like {
    const anchor: THREE.Object3D = this.currentSlot === WEAPON_SLOTS.PISTOL ? this.pistolMuzzle : this.muzzleAnchor;
    const world = anchor.getWorldPosition(new THREE.Vector3());
    const local = this.camera.worldToLocal(world);
    return { x: local.x, y: local.y, z: local.z };
  }

  /**
   * 枪口在**世界坐标系**中的位置（同样跟随后坐/换弹/投掷/切枪动画）。
   *
   * 供弹道线使用：Tracer 必须从玩家屏幕上看到的枪口出发。用服务端回的 `origin`
   * （眼睛 + 固定偏移）在移动/后坐/换弹时都会和实际枪口错开，看起来就是"子弹从
   * 别处飞出来"。
   */
  public getMuzzleWorldPosition(): Vec3Like {
    const anchor: THREE.Object3D = this.currentSlot === WEAPON_SLOTS.PISTOL ? this.pistolMuzzle : this.muzzleAnchor;
    const world = anchor.getWorldPosition(new THREE.Vector3());
    return { x: world.x, y: world.y, z: world.z };
  }

  /** 每帧推进动画并写回 holder（位置与旋转都是 BASE + 增量，绝不覆盖基准姿态）。 */
  public update(dtSeconds: number, state: ViewmodelUpdateState): void {
    const dt = Math.min(Math.max(dtSeconds, 0), 0.1);
    this.clock += dt;
    const moving = state.moving && state.grounded;

    // ---- walk 摆幅：τ=120ms 淡入淡出；停下不推进相位 ----
    this.bobAmp = advanceBobAmp(this.bobAmp, moving, dt);
    this.bobPhase = advanceBobPhase(this.bobPhase, moving, state.sprinting === true, dt);

    // ---- fire 后坐衰减：位移 τ=90ms、角度 τ=110ms ----
    if (state.firingAt > 0 && state.firingAt !== this.handledFiringAt) {
      // 兜底：调用方忘了调 recoil() 时也能出后坐
      this.recoil(state.firingAt);
    }
    this.recoilPos *= Math.exp(-dt / RECOIL_POS_TAU);
    this.recoilRot *= Math.exp(-dt / RECOIL_ROT_TAU);
    this.recoilRoll *= Math.exp(-dt / RECOIL_ROT_TAU);

    // ---- 落地冲击：空 → 地 且上一帧下落够快 ----
    const verticalSpeed = state.verticalSpeed ?? 0;
    if (!this.previousGrounded && state.grounded && this.previousVerticalSpeed < -LANDING_MIN_SPEED) {
      this.landing = -LANDING_IMPACT;
    }
    this.landing *= Math.exp(-dt / LANDING_TAU);

    // ---- 投掷进度：窗口内推进；窗口关闭即复位 ----
    // p=1（回位结束）与 p=0（未投掷）的姿态都是零增量，所以复位不会造成跳变。
    if (state.throwing) {
      if (this.throwElapsedMs >= THROW_COOLDOWN_MS) {
        // 连续投掷（700ms 冷却恰好等于动画时长）：窗口重新开始
        this.throwElapsedMs = 0;
      }
      this.throwElapsedMs = Math.min(THROW_COOLDOWN_MS, this.throwElapsedMs + dt * 1000);
    } else {
      this.throwElapsedMs = 0;
    }

    // ---- reload 部件动画：弹匣整组下沉再回位、拉机柄后拉再回位 ----
    const reloadProgress = Math.min(1, Math.max(0, state.reloadProgress));
    const magazine = computeReloadMagazineOffset(reloadProgress);
    this.magazineGroup.position.y = magazine.y;
    this.magazineGroup.rotation.x = magazine.rotX;
    this.charging.position.z = -0.05 + computeReloadChargeOffset(reloadProgress);

    // ---- 挥刀计时（内部推进，调用方只需在按键时调 swing()） ----
    this.knifeSwingMs = Math.min(KNIFE_SWING_TOTAL_MS, this.knifeSwingMs + dt * 1000);

    // ---- 蝴蝶刀待机花式转刀：只在「持刀 + 没在挥」时推进 ----
    // 挥刀/切枪期间冻结相位（不归零）：刀组此时正在快速位移，冻结看不出来；
    // 归零反而会让转了一半的刀瞬间弹回原位，出现"跳帧"。
    if (this.currentSlot === WEAPON_SLOTS.KNIFE && this.knifeSwingMs >= KNIFE_SWING_TOTAL_MS) {
      this.knifeTwirlMs = (this.knifeTwirlMs + dt * 1000) % KNIFE_TWIRL_CYCLE_MS;
    }
    // 绕**刀轴**（局部 Z）转，不是绕轴销转：
    // 绕轴销转 360° 会让刀身扫出一个 26cm 半径的圆，其中半圈刀会整个甩出画面下沿，
    // 看起来像"刀凭空消失 300ms"。绕刀轴转则刀身朝向不变，只是刃面在闪——既安全又有表演感。
    this.knifeSpin.rotation.z = knifeTwirlAngle(this.knifeTwirlMs);

    // ---- 投掷命中"离手"帧：t ≈ 45% 时道具球消失，之后随切枪/复位回到手上 ----
    // 这一条只在持投掷物时生效；枪/刀组整体不可见，球的真假无所谓。
    this.throwableBall.visible =
      !(state.throwing && this.throwElapsedMs > THROW_COOLDOWN_MS * THROW_RELEASE_RATIO);

    // ---- 求解姿态并写回 ----
    const pose = computeViewmodelPose(
      {
        moving,
        grounded: state.grounded,
        reloadProgress,
        throwProgress: this.throwElapsedMs / THROW_COOLDOWN_MS,
        bobPhase: this.bobPhase,
        bobAmp: this.bobAmp,
        recoilPos: this.recoilPos,
        recoilRot: this.recoilRot,
        recoilRoll: this.recoilRoll,
        landing: this.landing,
        switchProgress: Math.min(1, Math.max(0, state.switchProgress ?? 0)),
        knifeSwingMs: this.knifeSwingMs,
      },
      this.clock,
    );

    this.holder.position.set(pose.position.x, pose.position.y, pose.position.z);
    this.holder.rotation.set(pose.rotation.x, pose.rotation.y, pose.rotation.z);

    this.previousGrounded = state.grounded;
    this.previousVerticalSpeed = verticalSpeed;
  }

  public dispose(): void {
    this.camera.remove(this.holder);
    this.holder.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose();
      }
    });
    for (const material of Object.values(this.materials)) {
      material.dispose();
    }
  }

  /* ---------------- 几何体工厂（全部共享材质） ---------------- */

  private box(
    width: number,
    height: number,
    depth: number,
    material: THREE.Material,
    x: number,
    y: number,
    z: number,
    rotX = 0,
    rotY = 0,
    rotZ = 0,
  ): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
    mesh.position.set(x, y, z);
    mesh.rotation.set(rotX, rotY, rotZ);
    return mesh;
  }

  private cylinder(
    radius: number,
    height: number,
    material: THREE.Material,
    x: number,
    y: number,
    z: number,
    rotX = 0,
  ): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, height, 12), material);
    mesh.position.set(x, y, z);
    mesh.rotation.x = rotX;
    return mesh;
  }

  /**
   * 前臂：把沿 +Y 的 Capsule 转到「腕 → 肘」方向。
   * `CapsuleGeometry` 的 length 不含两端半球，所以要把半径扣掉。
   */
  private limb(from: THREE.Vector3, to: THREE.Vector3, radius: number, material: THREE.Material): THREE.Mesh {
    const dir = new THREE.Vector3().subVectors(to, from);
    const length = Math.max(dir.length() - radius * 2, 0.01);
    const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(radius, length, 4, 8), material);
    mesh.position.copy(from).addScaledVector(dir, 0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    return mesh;
  }

  /** 袖口：沿前臂方向的短圆柱，套在腕部。 */
  private cuff(
    from: THREE.Vector3,
    to: THREE.Vector3,
    radius: number,
    height: number,
    material: THREE.Material,
  ): THREE.Mesh {
    const dir = new THREE.Vector3().subVectors(to, from).normalize();
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, height, 12), material);
    mesh.position.copy(from).addScaledVector(dir, height * 0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    return mesh;
  }
}
