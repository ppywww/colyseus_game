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

/** 开火视角快照允许偏离已存视角的最大角度（3°）。 */
export const AIM_SNAPSHOT_TOLERANCE_RAD: number = (3 * Math.PI) / 180;

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
 * @returns 采信时返回归一化后的快照；超出 3° 或非法时返回 null（调用方回退已存视角）
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

function clampToArena(value: number): number {
  return clampToRange(value, -ARENA_RADIUS, ARENA_RADIUS);
}

function clampToRange(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
