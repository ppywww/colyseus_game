/**
 * 本地玩家第一人称移动物理（纯逻辑，无渲染依赖，可在 Node 中单测）。
 *
 * 与旧版（最小平移轴 MTA 推出）的区别 —— 旧版有三个真实穿模根因：
 *   1. 只要 `overlapY` 最小就把玩家"顶"到箱顶 → 跳跃 apex 1.278m 能爬上 1.6m 木箱；
 *   2. 单次遍历，A 盒把玩家推进 B 盒后不会回头再检查 A（箱-墙夹角会半个人在箱子里）；
 *   3. 从侧面走进箱体底部时也会被抬升，直接跳过碰撞。
 *
 * 现在的规则（文档 7.3）：
 *   - 水平位移**分片**（单片 ≤ 0.25m）防隧穿；
 *   - 每片内**先 X 后 Z 分轴**推出（每轴最多迭代 3 次），推出目标 = 面 ∓ (r + EPS)；
 *   - 垂直**只做两件事**：① 下落吸附（下落中脚底穿过盒顶 → 贴顶）；② 台阶抬升（≤ 0.35m）。
 *     其余情况盒子对 Y 完全无作用 —— 这就是"跳不上 1.6m 箱子"的保证。
 *   - 保留：场地矩形逐轴钳制（`MAP_BOUNDS`）、`y ≤ 0` 落地、跳跃参数。
 */

import { CROUCH_SPEED_SCALE, MAP_BOUNDS } from "@colyseus-fps/shared";

export interface PlayerKinematics {
  /** 脚底位置（米） */
  x: number;
  y: number;
  z: number;
  /** 垂直速度（米/秒） */
  vy: number;
  yaw: number;
  pitch: number;
  grounded: boolean;
}

export interface MoveInput {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  sprint: boolean;
  jump: boolean;
  /**
   * 是否下蹲（可选，缺省 false）。
   *
   * 只影响移动速度：蹲走 = 走速 × {@link CROUCH_SPEED_SCALE}，且**不能冲刺**。
   * 眼睛高度与判定体不在这里改——那两件事分别由 `Game.tick`（相机）与服务端
   * `computeShot`（射线起点 / 判定体压缩）处理，物理层只负责"慢下来"。
   */
  crouch?: boolean;
}

export interface Aabb {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

/** 可玩区矩形（米，与 shared 的 MAP_BOUNDS 同构）。 */
export interface BoundsRect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface PhysicsOptions {
  /**
   * 可玩区矩形：逐轴钳制，玩家贴到任意一堵外墙都会停下。
   *
   * 旧实现是 `arenaRadius`（圆形边界），在 64×64 的矩形地图里会让四角出现
   * 「被一股力量拽向场地中心」的诡异手感，且与服务端 transform.ts 的逐轴 ±30 钳制不一致。
   */
  bounds: BoundsRect;
  playerRadius: number;
  playerHeight: number;
  walkSpeed: number;
  sprintSpeed: number;
  jumpSpeed: number;
  /** 重力加速度（米/秒²，向下为正效果取负值使用） */
  gravity: number;
}

export const DEFAULT_PHYSICS: PhysicsOptions = {
  // 唯一真相来自 shared 的 MAP_BOUNDS（与服务端 transform.ts、手雷反弹共用同一份常数）
  bounds: { ...MAP_BOUNDS },
  playerRadius: 0.35,
  playerHeight: 1.8,
  walkSpeed: 5,
  sprintSpeed: 8,
  jumpSpeed: 7.5,
  gravity: 22,
};

/** 水平分片的最大单片位移（米）：必须 < playerRadius（0.35），否则可能穿过薄墙。 */
export const MAX_SUBSTEP: number = 0.25;

/**
 * 单片数量上限。
 *
 * 文档写的是 `min(4, …)`，这里放宽到 8：正常移动（8 m/s × 100ms = 0.8m）只需要 4 片，
 * 但异常大位移（断线重连后的第一帧、调试传送）需要更多片才不至于穿过 0.9m 薄墙；
 * 8 片 × 0.25m = 2m 的单帧位移仍能保证不隧穿（最薄盒 0.6m + 2r = 1.3m）。
 */
export const MAX_SUBSTEPS: number = 8;

/** 单轴推出迭代次数上限（箱-墙夹角需要多遍）。 */
export const AXIS_ITERATIONS: number = 3;

/** 贴合容差：推出到「面 ∓ (r + EPS)」，避免浮点误差让下一帧又判重叠（抖动）。 */
export const CONTACT_EPS: number = 0.001;

/** 台阶高度：只影响 ≤ 0.35m 的地形缝隙，不能替代跳跃（地图里没有这种台阶）。 */
export const STEP_HEIGHT: number = 0.35;

/** 落地吸附容差：上一帧脚底在这条线之上，才允许贴到盒顶。 */
const LAND_TOLERANCE: number = 0.02;

/** 垂直重叠容差：脚底已经在盒顶这条线之上时，该盒不再算"横向挡路"。 */
const SURFACE_TOLERANCE: number = 0.02;

/** 推进一步移动模拟；直接原地修改并返回传入的 kinematics。 */
export function stepPlayer(
  kinematics: PlayerKinematics,
  input: MoveInput,
  dtSeconds: number,
  colliders: readonly Aabb[],
  options: PhysicsOptions = DEFAULT_PHYSICS,
): PlayerKinematics {
  const dt = Math.min(dtSeconds, 0.1); // 掉帧保护：单步最长按 100ms 计
  // 蹲下不能冲刺：先取基础速度，再乘蹲走系数。顺序不能反过来（否则冲刺档蹲走仍然 8m/s）。
  const crouched: boolean = input.crouch === true;
  const baseSpeed: number = input.sprint && !crouched ? options.sprintSpeed : options.walkSpeed;
  const speed: number = crouched ? baseSpeed * CROUCH_SPEED_SCALE : baseSpeed;

  // 期望移动方向（yaw=0 朝 -Z，与 three.js 相机约定一致）
  let dirX = 0;
  let dirZ = 0;
  if (input.forward) {
    dirX -= Math.sin(kinematics.yaw);
    dirZ -= Math.cos(kinematics.yaw);
  }
  if (input.backward) {
    dirX += Math.sin(kinematics.yaw);
    dirZ += Math.cos(kinematics.yaw);
  }
  if (input.left) {
    dirX -= Math.cos(kinematics.yaw);
    dirZ += Math.sin(kinematics.yaw);
  }
  if (input.right) {
    dirX += Math.cos(kinematics.yaw);
    dirZ -= Math.sin(kinematics.yaw);
  }

  const length = Math.hypot(dirX, dirZ);
  if (length > 0) {
    dirX = (dirX / length) * speed;
    dirZ = (dirZ / length) * speed;
  }

  const wasGrounded = kinematics.grounded;

  // 跳跃与重力
  if (input.jump && wasGrounded) {
    kinematics.vy = options.jumpSpeed;
    kinematics.grounded = false;
  }
  kinematics.vy -= options.gravity * dt;

  // ---- 第 1 步：水平位移分片 + 分轴推出 ----
  const dx = dirX * dt;
  const dz = dirZ * dt;
  const distance = Math.hypot(dx, dz);
  const steps = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(distance / MAX_SUBSTEP)));
  for (let i = 0; i < steps; i += 1) {
    kinematics.x += dx / steps;
    resolveAxisX(kinematics, colliders, options);
    kinematics.z += dz / steps;
    resolveAxisZ(kinematics, colliders, options);
  }

  // 场地边界（矩形，逐轴钳制并内缩玩家半径）
  const radius = options.playerRadius;
  kinematics.x = Math.min(options.bounds.maxX - radius, Math.max(options.bounds.minX + radius, kinematics.x));
  kinematics.z = Math.min(options.bounds.maxZ - radius, Math.max(options.bounds.minZ + radius, kinematics.z));

  // ---- 第 2 步：垂直只做「落地吸附 + 台阶抬升」 ----
  const prevFootY = kinematics.y;
  kinematics.y += kinematics.vy * dt;

  let grounded = false;
  if (kinematics.y <= 0) {
    kinematics.y = 0;
    kinematics.vy = 0;
    grounded = true;
  }

  for (const box of colliders) {
    // (a) 下落吸附：上一帧脚底已在盒顶之上、这一帧穿到顶面以下 → 贴顶
    if (
      kinematics.vy <= 0 &&
      prevFootY >= box.maxY - LAND_TOLERANCE &&
      kinematics.y < box.maxY &&
      footprintOverlaps(kinematics, box, radius)
    ) {
      kinematics.y = box.maxY;
      kinematics.vy = 0;
      grounded = true;
      continue;
    }

    // (b) 台阶抬升：站着、且盒子够矮（≤ STEP_HEIGHT）且正贴着它 → 抬到盒顶
    if (
      wasGrounded &&
      kinematics.vy <= 0 &&
      box.maxY > kinematics.y + SURFACE_TOLERANCE &&
      box.maxY <= kinematics.y + STEP_HEIGHT &&
      footprintTouches(kinematics, box, radius)
    ) {
      kinematics.y = box.maxY;
      kinematics.vy = 0;
      grounded = true;
    }

    // (c) 其余情况：盒子对 Y 完全无作用（不抬不压）—— 这是"跳不上高箱"的保证
  }

  kinematics.grounded = grounded;

  return kinematics;
}

/** 脚底平面是否与盒子在 Y 上有重叠（站在盒顶/头顶之上时不算重叠）。 */
function verticalOverlaps(k: PlayerKinematics, height: number, box: Aabb): boolean {
  return k.y < box.maxY - SURFACE_TOLERANCE && k.y + height > box.minY + SURFACE_TOLERANCE;
}

/** 玩家的水平足迹是否与盒子在 XZ 上真重叠（用于下落吸附）。 */
function footprintOverlaps(k: PlayerKinematics, box: Aabb, radius: number): boolean {
  return k.x + radius > box.minX && k.x - radius < box.maxX && k.z + radius > box.minZ && k.z - radius < box.maxZ;
}

/** 玩家的水平足迹是否"贴着"盒子（含 2cm 余量，用于台阶抬升）。 */
function footprintTouches(k: PlayerKinematics, box: Aabb, radius: number, slack = 0.02): boolean {
  return (
    k.x + radius > box.minX - slack &&
    k.x - radius < box.maxX + slack &&
    k.z + radius > box.minZ - slack &&
    k.z - radius < box.maxZ + slack
  );
}

/**
 * 沿 X 轴推出（不看 Y 的最小平移，只看"这个轴往哪边推更近"）。
 *
 * 分轴的价值：每轴的最优推出方向唯一（玩家在盒左侧就往 −X 推），
 * 不会出现旧版"该往左推却往上抬"的错解。
 */
function resolveAxisX(k: PlayerKinematics, colliders: readonly Aabb[], options: PhysicsOptions): void {
  const r = options.playerRadius;
  const h = options.playerHeight;
  for (let iteration = 0; iteration < AXIS_ITERATIONS; iteration += 1) {
    let moved = false;
    for (const box of colliders) {
      if (!verticalOverlaps(k, h, box)) {
        continue;
      }
      if (!(k.x + r > box.minX && k.x - r < box.maxX)) {
        continue;
      }
      if (!(k.z + r > box.minZ && k.z - r < box.maxZ)) {
        continue;
      }
      const pushNegative = k.x + r - box.minX; // 推向 −X 的深度
      const pushPositive = box.maxX - (k.x - r); // 推向 +X 的深度
      k.x = pushNegative <= pushPositive ? box.minX - r - CONTACT_EPS : box.maxX + r + CONTACT_EPS;
      moved = true;
    }
    if (!moved) {
      return;
    }
  }
}

/** 沿 Z 轴推出（与 X 轴对称）。 */
function resolveAxisZ(k: PlayerKinematics, colliders: readonly Aabb[], options: PhysicsOptions): void {
  const r = options.playerRadius;
  const h = options.playerHeight;
  for (let iteration = 0; iteration < AXIS_ITERATIONS; iteration += 1) {
    let moved = false;
    for (const box of colliders) {
      if (!verticalOverlaps(k, h, box)) {
        continue;
      }
      if (!(k.x + r > box.minX && k.x - r < box.maxX)) {
        continue;
      }
      if (!(k.z + r > box.minZ && k.z - r < box.maxZ)) {
        continue;
      }
      const pushNegative = k.z + r - box.minZ;
      const pushPositive = box.maxZ - (k.z - r);
      k.z = pushNegative <= pushPositive ? box.minZ - r - CONTACT_EPS : box.maxZ + r + CONTACT_EPS;
      moved = true;
    }
    if (!moved) {
      return;
    }
  }
}
