/**
 * 玩家位置上报的校验与钳制（纯函数，便于单测）。
 *
 * S2 策略：信任客户端位置但做 sanity 钳制（S3 再改为服务端权威模拟）。
 * 这里只保证进入状态同步的数据一定是有限数、且在场地范围内。
 */

import {
  ARENA_RADIUS,
  clampPitch,
  normalizeYaw,
  type PlayerTransformMessage,
} from "@colyseus-fps/shared";

const MAX_Y: number = 10;

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

function clampToArena(value: number): number {
  return clampToRange(value, -ARENA_RADIUS, ARENA_RADIUS);
}

function clampToRange(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
