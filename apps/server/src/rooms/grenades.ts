/**
 * 投掷物物理与范围结算（纯函数，便于单测）。
 *
 * 权威性说明：
 *   - 抛物线由服务端按固定 50ms 步长积分，客户端只按同一套常量做本地预测渲染；
 *   - 爆炸点、伤害、致盲强度、烟雾位置全部以服务端结果为准。
 */

import {
  ARENA_RADIUS,
  GRENADE_BOUNCE,
  GRENADE_GRAVITY,
  GRENADE_RADIUS,
  PLAYER_HEIGHT,
  THROW_MAX_PITCH,
  type Aabb,
  type ThrowableType,
} from "@colyseus-fps/shared";

import { directionFromYawPitch, rayAabb, type Vec3 } from "./combat.js";

export interface GrenadeState {
  id: number;
  type: ThrowableType;
  throwerId: string;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** 剩余引信时长（毫秒）。 */
  fuseMs: number;
}

export interface ExplosionVictim {
  sessionId: string;
  damage: number;
}

/** 归一化三维向量；零向量返回 null。 */
export function normalizeVec(x: number, y: number, z: number): Vec3 | null {
  const length = Math.hypot(x, y, z);
  if (!Number.isFinite(length) || length < 1e-6) {
    return null;
  }
  return { x: x / length, y: y / length, z: z / length };
}

/** 把投掷方向钳制到允许的俯仰范围内（防止垂直上抛或往下砸）。 */
export function clampThrowDirection(dir: Vec3): Vec3 {
  const maxY = Math.sin(THROW_MAX_PITCH);
  const clampedY = Math.min(maxY, Math.max(-maxY, dir.y));
  const horizontal = Math.hypot(dir.x, dir.z);
  if (horizontal < 1e-6) {
    // 近乎垂直：退化为正前方以外的合法方向（保持水平分量）
    return { x: 0, y: clampedY, z: -Math.sqrt(Math.max(0, 1 - clampedY * clampedY)) };
  }
  const scale = Math.sqrt(Math.max(0, 1 - clampedY * clampedY)) / horizontal;
  return { x: dir.x * scale, y: clampedY, z: dir.z * scale };
}

/** 推进一个物理步长（秒）：重力、地面与掩体反弹、场地边界。 */
export function stepGrenade(
  grenade: GrenadeState,
  dtSeconds: number,
  obstacles: readonly Aabb[],
): void {
  grenade.vy -= GRENADE_GRAVITY * dtSeconds;
  grenade.x += grenade.vx * dtSeconds;
  grenade.y += grenade.vy * dtSeconds;
  grenade.z += grenade.vz * dtSeconds;

  // 地面
  if (grenade.y < GRENADE_RADIUS) {
    grenade.y = GRENADE_RADIUS;
    if (grenade.vy < 0) {
      grenade.vy = -grenade.vy * GRENADE_BOUNCE;
      grenade.vx *= 0.82;
      grenade.vz *= 0.82;
      if (Math.abs(grenade.vy) < 0.6) {
        grenade.vy = 0;
      }
    }
  }

  // 掩体：按最小穿透轴推出并反弹对应分量
  for (const box of obstacles) {
    const insideX = grenade.x > box.minX - GRENADE_RADIUS && grenade.x < box.maxX + GRENADE_RADIUS;
    const insideZ = grenade.z > box.minZ - GRENADE_RADIUS && grenade.z < box.maxZ + GRENADE_RADIUS;
    if (!insideX || !insideZ) {
      continue;
    }

    // 从上方落下：停在箱顶
    if (grenade.y >= box.maxY && grenade.y - GRENADE_RADIUS <= box.maxY) {
      grenade.y = box.maxY + GRENADE_RADIUS;
      grenade.vy = grenade.vy < 0 ? -grenade.vy * GRENADE_BOUNCE : grenade.vy;
      grenade.vx *= 0.82;
      grenade.vz *= 0.82;
      continue;
    }

    if (grenade.y < box.minY || grenade.y > box.maxY) {
      continue;
    }

    const pushLeft = grenade.x - (box.minX - GRENADE_RADIUS);
    const pushRight = box.maxX + GRENADE_RADIUS - grenade.x;
    const pushBack = grenade.z - (box.minZ - GRENADE_RADIUS);
    const pushFront = box.maxZ + GRENADE_RADIUS - grenade.z;
    const minPush = Math.min(pushLeft, pushRight, pushBack, pushFront);

    if (minPush === pushLeft) {
      grenade.x = box.minX - GRENADE_RADIUS;
      grenade.vx = -Math.abs(grenade.vx) * GRENADE_BOUNCE;
    } else if (minPush === pushRight) {
      grenade.x = box.maxX + GRENADE_RADIUS;
      grenade.vx = Math.abs(grenade.vx) * GRENADE_BOUNCE;
    } else if (minPush === pushBack) {
      grenade.z = box.minZ - GRENADE_RADIUS;
      grenade.vz = -Math.abs(grenade.vz) * GRENADE_BOUNCE;
    } else {
      grenade.z = box.maxZ + GRENADE_RADIUS;
      grenade.vz = Math.abs(grenade.vz) * GRENADE_BOUNCE;
    }
  }

  // 场地边界：圆形围墙内反弹
  const radial = Math.hypot(grenade.x, grenade.z);
  const limit = ARENA_RADIUS - GRENADE_RADIUS;
  if (radial > limit) {
    const nx = grenade.x / radial;
    const nz = grenade.z / radial;
    grenade.x = nx * limit;
    grenade.z = nz * limit;
    const vn = grenade.vx * nx + grenade.vz * nz;
    if (vn > 0) {
      grenade.vx -= (1 + GRENADE_BOUNCE) * vn * nx;
      grenade.vz -= (1 + GRENADE_BOUNCE) * vn * nz;
    }
  }
}

/** 视线是否被掩体遮挡（从 from 到 to）。 */
export function isLineBlocked(
  from: Vec3,
  to: Vec3,
  obstacles: readonly Aabb[],
): boolean {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const distance = Math.hypot(dx, dy, dz);
  if (distance < 1e-6) {
    return false;
  }
  const dir: Vec3 = { x: dx / distance, y: dy / distance, z: dz / distance };
  for (const box of obstacles) {
    const t = rayAabb(from, dir, box, distance);
    if (t !== null && t < distance - 0.05) {
      return true;
    }
  }
  return false;
}

interface DamageTarget {
  sessionId: string;
  x: number;
  y: number;
  z: number;
  alive: boolean;
}

/**
 * 手雷爆炸伤害：距离衰减 + 掩体遮挡（挡住的直接免伤）。
 * 返回每个受害者的最终伤害，供房间逐条结算（便于复用击杀/重生逻辑）。
 */
export function explosionDamage(
  center: Vec3,
  radius: number,
  maxDamage: number,
  minDamage: number,
  targets: Iterable<DamageTarget>,
  obstacles: readonly Aabb[],
): ExplosionVictim[] {
  const result: ExplosionVictim[] = [];
  for (const target of targets) {
    if (!target.alive) {
      continue;
    }
    const chest: Vec3 = { x: target.x, y: target.y + PLAYER_HEIGHT / 2, z: target.z };
    const distance = Math.hypot(chest.x - center.x, chest.y - center.y, chest.z - center.z);
    if (distance > radius) {
      continue;
    }
    if (isLineBlocked(center, chest, obstacles)) {
      continue;
    }
    const falloff = 1 - distance / radius;
    const damage = Math.max(minDamage, Math.round(maxDamage * falloff));
    result.push({ sessionId: target.sessionId, damage });
  }
  return result;
}

interface FlashTarget {
  x: number;
  z: number;
  yaw: number;
}

/**
 * 闪光强度（0..1）：距离衰减 × 朝向因子。
 * 背对爆炸只受轻微影响，正对直视时接近 1。
 */
export function flashIntensity(center: Vec3, radius: number, target: FlashTarget): number {
  const dx = center.x - target.x;
  const dz = center.z - target.z;
  const distance = Math.hypot(dx, dz);
  if (distance > radius) {
    return 0;
  }

  const distanceFactor = 1 - distance / radius;
  if (distance < 1e-3) {
    return 1;
  }

  const forward = directionFromYawPitch(target.yaw, 0);
  const dot = (dx / distance) * forward.x + (dz / distance) * forward.z;
  // dot=1 正对光源 → 1；dot=-1 完全背对 → 0.08
  const facing = Math.min(1, Math.max(0.08, (dot + 0.35) / 1.35));

  return Math.min(1, Math.max(0, facing * (0.45 + 0.55 * distanceFactor)));
}
