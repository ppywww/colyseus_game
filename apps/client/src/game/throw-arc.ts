/**
 * 投掷抛物线的**纯几何**部分：不碰 Three.js、不碰 DOM，只负责"从出手点开始，雷会怎么飞"。
 *
 * 为什么要单独拆一个文件：
 *   1. 这套计算每帧都要跑（玩家一拿出投掷物就开算），必须能被单测直接验，
 *      用不到一个 `THREE.Scene`；
 *   2. 表现层（点、落点环）曾经和物理混在一起，导致"点的位置"和"雷的位置"各算各的，
 *      出 bug 时只能靠肉眼猜。现在只有一条真相：{@link computeThrowArc}。
 *
 * **必须用服务端同一个 {@link stepGrenadePhysics}**：预览线的意义就是"画到哪、雷就落到哪"，
 * 自己再写一份近似积分等于骗玩家。
 */

import {
  GRENADE_RADIUS,
  stepGrenadePhysics,
  type Aabb,
} from "@colyseus-fps/shared";

export interface ThrowArcPoint {
  x: number;
  y: number;
  z: number;
}

export interface ThrowArc {
  /** 从出手点向前、沿**弧长**均匀取样的点；第一个点已经越过近处起步距离。 */
  points: ThrowArcPoint[];
  /**
   * **生效点**：引信到点时雷所在的位置——烟雾在这里起烟、手雷在这里炸。
   *
   * 注意不是"滚到哪儿停"：烟雾引信只有 1.4s，而一颗 21m/s 的烟落地后还会滚好几米，
   * 按"最终静止点"画环会告诉玩家一个**雷根本到不了**的位置。
   * `null` 只出现在输入非法时。
   */
  endpoint: ThrowArcPoint | null;
  /** 生效点是否贴地（贴地 → 落点环平铺；在空中 → 环要正对镜头）。 */
  atGround: boolean;
}

/**
 * 相邻两点的**半径比**：第 i+1 个点落在 i 点距出手点半径的 1.2 倍处。
 *
 * 为什么不用等弧长：透视下"等距"的点在屏幕上**完全不均匀**——沿视线飞出去的轨迹，
 * 屏幕间距 ∝ Δr / r²，等弧长会变成"近处一个点贴在脸前、远处几十个点糊成一坨"。
 * 用等比半径，屏幕间距就基本恒定（这正是几何级数在透视投影下的性质），
 * 点的大小又固定 6 像素，整条线看起来才是一条**均匀的珠链**而不是水泡串。
 */
export const ARC_SPACING_RATIO = 1.2;

/** 相邻两点的最小间距（米）：贴着出手点时半径还小，等比步长太短会挤成一片。 */
export const ARC_MIN_GAP = 0.3;

/** 最多画多少个点（等比步长下 34 个点足够铺满 30m 以上）。 */
export const ARC_MAX_POINTS = 34;

/**
 * 起点距出手点的距离（米）。
 *
 * 取 0.5m ≈ 手的位置：点的大小是屏幕像素恒定的，所以贴着手画也不会糊住屏幕，
 * 反而能把"从手里飞出去"这条因果画清楚（旧版是 3D 小球，贴着手就是一块大圆盘）。
 */
export const ARC_START_DISTANCE = 0.5;

/**
 * 积分步长：比服务端 50ms 细两个数量级，曲线才顺；子步逻辑在 stepGrenadePhysics 内部。
 *
 * 它同时是**半隐式欧拉的偏差尺度**：`y` 会比解析解低 `½·g·h·t`（h 越大越明显），
 * 取 1/240 时 0.3 秒处偏差约 6mm——远小于一个手雷半径，不必再上二阶积分。
 * 导出来给测试用：断言里要能算出"允许的离散化偏差"，而不是拍一个魔数。
 */
export const ARC_SIM_STEP_SECONDS = 1 / 240;

/** 最长模拟时长（步数）：4 秒。够一次满力抛投 + 落地弹跳，不会卡住主线程。 */
const ARC_MAX_STEPS = 960;

/** 没传引信时的兜底：取手雷（2.2s），最宽松的那一档，宁可多画一点也不早停。 */
export const ARC_DEFAULT_FUSE_SECONDS = 2.2;

/** 判定"已静止"的阈值：竖直速度 + 水平速度都要足够小，且贴地。 */
const REST_SPEED_Y = 0.25;
const REST_SPEED_H = 0.55;

/** 数值兜底：三个分量都要是有限数，否则整条线直接不画。 */
function isFiniteVec(v: ThrowArcPoint): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

/**
 * 从出手点积分出一条抛物线。
 *
 * @param origin 出手点（世界坐标；两端都用 {@link throwOriginOf} 算，保证一致）
 * @param dir 归一化方向
 * @param speed 初速度（m/s），一般就是 `THROW_SPEED`
 * @param obstacles 掩体 AABB 表（客户端传 `obstacleColliders()` 的结果）
 * @param fuse 引信时长（秒）：到点就停，别画一颗已经不存在的雷
 */
export function computeThrowArc(
  origin: ThrowArcPoint,
  dir: ThrowArcPoint,
  speed: number,
  obstacles: readonly Aabb[],
  fuse: number = ARC_DEFAULT_FUSE_SECONDS,
): ThrowArc {
  if (!isFiniteVec(origin) || !isFiniteVec(dir)) {
    return { points: [], endpoint: null, atGround: false };
  }
  const speedValue = Number.isFinite(speed) ? Math.max(0, speed) : 0;
  const fuseSeconds = Number.isFinite(fuse) && fuse > 0 ? fuse : ARC_DEFAULT_FUSE_SECONDS;

  const body = {
    x: origin.x,
    y: origin.y,
    z: origin.z,
    vx: dir.x * speedValue,
    vy: dir.y * speedValue,
    vz: dir.z * speedValue,
  };

  const points: ThrowArcPoint[] = [];
  let endpoint: ThrowArcPoint = { x: body.x, y: body.y, z: body.z };
  let rested = false;

  let previousX = body.x;
  let previousY = body.y;
  let previousZ = body.z;
  let travelled = 0;
  let nextSampleAt = ARC_START_DISTANCE;
  let seconds = 0;

  for (let step = 0; step < ARC_MAX_STEPS; step += 1) {
    stepGrenadePhysics(body, ARC_SIM_STEP_SECONDS, obstacles);
    seconds += ARC_SIM_STEP_SECONDS;
    endpoint = { x: body.x, y: body.y, z: body.z };

    const dx = body.x - previousX;
    const dy = body.y - previousY;
    const dz = body.z - previousZ;
    travelled += Math.sqrt(dx * dx + dy * dy + dz * dz);
    previousX = body.x;
    previousY = body.y;
    previousZ = body.z;

    // 点数上限到了就不再收点，但**继续积分**：落点环必须有，玩家最需要的就是它。
    if (travelled >= nextSampleAt && points.length < ARC_MAX_POINTS) {
      points.push({ x: body.x, y: body.y, z: body.z });
      // 等比推进 + 最小步长（贴手那段半径太小，等比步长会短到挤成一团）
      nextSampleAt = Math.max(travelled + ARC_MIN_GAP, nextSampleAt * ARC_SPACING_RATIO);
    }

    const horizontal = Math.hypot(body.vx, body.vz);
    const onGround = body.y <= GRENADE_RADIUS + 1e-3;
    if (onGround && Math.abs(body.vy) < REST_SPEED_Y && horizontal < REST_SPEED_H) {
      rested = true;
      break;
    }
    // 引信到点：雷在这里生效，后面的滚动只是"客户端多看了一会儿"，与结果无关
    if (seconds >= fuseSeconds) {
      break;
    }
  }

  // 生效点离地 35cm 以内就当作"贴地"，环平铺；否则（空中引爆）环要正对镜头。
  const atGround = rested || endpoint.y - GRENADE_RADIUS < 0.35;
  return { points, endpoint, atGround };
}
