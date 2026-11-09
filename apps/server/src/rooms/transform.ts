/**
 * 玩家位置上报的校验与钳制（纯函数，便于单测）。
 *
 * 分层：
 *   1. {@link sanitizeTransform} —— 结构校验 + 逐轴钳制（±30 可玩区、y ∈ [0, 10]）；
 *   2. {@link overlapsObstacle} —— 障碍物校验：脚底中心落在某 AABB 的 XZ 内且
 *      `footY < box.maxY − 0.05` 视为"嵌在体块里"，调用方应**丢弃本次上报、保留上一合法位置**；
 *   3. {@link acceptAimSnapshot} —— 开火视角快照的 3° 校验（防"瞬移视野爆头"）。
 *
 * 为什么障碍物校验选择"拒绝 + 保留上一位置"而不是"把玩家推出来"：
 * 推出会与客户端本地物理的推出互相打架，表现为持续的橡皮筋。保留上一合法位置是
 * 单向收敛的——客户端只要还嵌在体块里，服务端就一直不采纳，直到它自己走出来。
 */

import {
  ARENA_RADIUS,
  clampPitch,
  normalizeYaw,
  type Aabb,
  type PlayerTransformMessage,
} from "@colyseus-fps/shared";

/** 开火视角快照（客户端随 FIRE 上行，服务端按 3° 阈值决定是否采信）。 */
export interface AimSnapshot {
  yaw: number;
  pitch: number;
}

const MAX_Y: number = 10;

/** 障碍物校验的垂直容差（米）：脚底比盒顶低这么多以内，视为"站在盒顶"而不是"嵌进去"。 */
export const OBSTACLE_FOOT_TOLERANCE: number = 0.05;

/**
 * 开火视角快照允许偏离已存视角的最大角度。
 *
 * 从 3° 放宽到 25° 的原因（这是「移动/转身时开枪弹道不对」的一半根因）：
 * 服务端保存的视角来自 30Hz 的 transform 上报，最多陈旧 33ms。快速甩枪 700°/s 时
 * 33ms 就是 23°——3° 的阈值会把**合法**的开火视角直接拒掉，回退成 33ms 前的旧朝向，
 * 玩家看到的就是"准星明明对着人，子弹却从旁边飞过去"。25° 对应的转动速率是 757°/s，
 * 正常人甩枪不会持续超过它，而作弊者想靠"瞬移视角"获益也仍然要受位置校验约束。
 */
export const AIM_SNAPSHOT_TOLERANCE_RAD: number = (25 * Math.PI) / 180;

/** 开火位置快照与已存位置之间允许的最大距离（米）。 */
export const FIRE_ORIGIN_MAX_DISTANCE: number = 1.2;

/**
 * 校验并钳制一条客户端上报的位置消息。
 * 返回 null 表示消息非法（非有限数 / 类型错误），调用方应直接丢弃。
 */
export function sanitizeTransform(raw: unknown): PlayerTransformMessage | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }

  const message = raw as Partial<PlayerTransformMessage>;
  const { seq, x, y, z, yaw, pitch } = message;
  const values: Array<number | undefined> = [seq, x, y, z, yaw, pitch];

  for (const value of values) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return null;
    }
  }

  const safeSeq = seq as number;
  const safeX = x as number;
  const safeY = y as number;
  const safeZ = z as number;
  const safeYaw = yaw as number;
  const safePitch = pitch as number;

  return {
    seq: Math.max(0, Math.floor(safeSeq)),
    x: clampToArena(safeX),
    y: clampToRange(safeY, 0, MAX_Y),
    z: clampToArena(safeZ),
    yaw: normalizeYaw(safeYaw),
    pitch: clampPitch(safePitch),
  };
}

/**
 * 判定「脚底中心落在某个障碍 AABB 的 XZ 范围内，且高度低于盒顶 − 容差」。
 *
 * 语义边界（与客户端物理一致的三条）：
 *   - 站在盒顶（`footY ≥ box.maxY − 0.05`）合法 —— 木箱可站立；
 *   - 跳到盒子上方（`footY > box.maxY`）合法 —— 空中；
 *   - 只有"从侧面挤进体块"才返回 true。
 */
export function overlapsObstacle(
  x: number,
  footY: number,
  z: number,
  colliders: readonly Aabb[],
  tolerance: number = OBSTACLE_FOOT_TOLERANCE,
): boolean {
  for (const box of colliders) {
    if (x <= box.minX || x >= box.maxX) {
      continue;
    }
    if (z <= box.minZ || z >= box.maxZ) {
      continue;
    }
    if (footY < box.maxY - tolerance) {
      return true;
    }
  }
  return false;
}

/**
 * 开火视角快照的采信判定。
 *
 * @param raw 客户端随 FIRE 上行的 `{ yaw, pitch }`（可能缺失 / 非法）
 * @param stored 服务端已保存的最近一次 transform 视角
 * @returns 采信时返回归一化后的快照；超出 25° 或非法时返回 null（调用方回退已存视角）
 */
export function acceptAimSnapshot(
  raw: unknown,
  stored: { yaw: number; pitch: number },
): AimSnapshot | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }

  const message = raw as { yaw?: unknown; pitch?: unknown };
  const { yaw, pitch } = message;
  if (typeof yaw !== "number" || typeof pitch !== "number") {
    return null;
  }
  if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) {
    return null;
  }

  const normalizedYaw: number = normalizeYaw(yaw);
  const clampedPitch: number = clampPitch(pitch);
  const yawDelta: number = Math.abs(normalizeYaw(normalizedYaw - stored.yaw));
  const pitchDelta: number = Math.abs(clampedPitch - stored.pitch);

  if (yawDelta > AIM_SNAPSHOT_TOLERANCE_RAD || pitchDelta > AIM_SNAPSHOT_TOLERANCE_RAD) {
    return null;
  }
  return { yaw: normalizedYaw, pitch: clampedPitch };
}

/**
 * 开火位置快照的采信判定（修「移动时弹道不是从枪口出来」）。
 *
 * 判定射线必须从**玩家屏幕上看到的位置**出发。服务端保存的位置来自 30Hz 上报，
 * 最多陈旧 33ms；全速奔跑 5.5m/s 下就是 18cm，冲刺更快。这 18cm 会让弹道的
 * 起点整体偏移——客户端画的 Tracer 从枪口出发，而服务端从背后一点的位置算命中，
 * 表现就是"移动时子弹不是从枪口出、还打不准"。
 *
 * 采信规则（三条都过才用快照，否则调用方回退已存位置）：
 *   1. 三个分量都是有限数、且在可玩区范围内；
 *   2. 与已存位置的直线距离 ≤ {@link FIRE_ORIGIN_MAX_DISTANCE}——防止客户端靠一份
 *      伪造的坐标把射线搬到地图另一边；
 *   3. 快照点不在任何掩体内部——防止"把枪口塞进墙里打穿墙"。
 */
export function acceptFireOrigin(
  raw: unknown,
  stored: { x: number; y: number; z: number },
  colliders: readonly Aabb[],
): { x: number; y: number; z: number } | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }

  const message = raw as { x?: unknown; y?: unknown; z?: unknown };
  const { x, y, z } = message;
  if (typeof x !== "number" || typeof y !== "number" || typeof z !== "number") {
    return null;
  }
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    return null;
  }

  if (Math.abs(x) > ARENA_RADIUS || Math.abs(z) > ARENA_RADIUS) {
    return null;
  }
  if (y < 0 || y > MAX_Y) {
    return null;
  }

  const distance: number = Math.hypot(x - stored.x, y - stored.y, z - stored.z);
  if (distance > FIRE_ORIGIN_MAX_DISTANCE) {
    return null;
  }

  if (overlapsObstacle(x, y, z, colliders)) {
    return null;
  }

  return { x, y, z };
}

function clampToArena(value: number): number {
  return clampToRange(value, -ARENA_RADIUS, ARENA_RADIUS);
}

function clampToRange(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
