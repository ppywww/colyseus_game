/**
 * 服务端权威弹道判定（纯函数，可单测）。
 *
 * 输入只使用服务端保存的玩家位置/朝向，不信任客户端上传的弹道：
 *   客户端发 fire → 服务端取 shooter 的 x/y/z/yaw/pitch → 射线检测
 * 命中规则：
 *   1. 从眼睛位置沿 yaw/pitch 方向发射线（射程 WEAPON_RANGE）；
 *   2. 掩体箱（AABB）遮挡：先求最近遮挡距离 tWall；
 *   3. 其他存活玩家按圆柱体（半径 PLAYER_HIT_RADIUS，高 PLAYER_HEIGHT）求交，
 *      取 t < tWall 的最近目标。
 */

import {
  EYE_HEIGHT,
  PLAYER_HEIGHT,
  PLAYER_HIT_RADIUS,
  WEAPON_RANGE,
  type Aabb,
  type ShotMessage,
} from "@colyseus-fps/shared";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** 参与弹道判定的最小玩家视图（与 Schema Player 结构兼容）。 */
export interface CombatantView {
  sessionId: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  alive: boolean;
}

/** 由 yaw/pitch 计算视线方向（与 three.js YXZ 相机一致：yaw=0 朝 -Z）。 */
export function directionFromYawPitch(yaw: number, pitch: number): Vec3 {
  const cosPitch: number = Math.cos(pitch);
  return {
    x: -Math.sin(yaw) * cosPitch,
    y: Math.sin(pitch),
    z: -Math.cos(yaw) * cosPitch,
  };
}

/** 射线与 AABB 求交（slab 法），返回进入距离 t；不相交返回 null。 */
export function rayAabb(origin: Vec3, dir: Vec3, box: Aabb, maxT: number): number | null {
  let tMin = 0;
  let tMax = maxT;

  const axes: Array<[number, number, number, number]> = [
    [origin.x, dir.x, box.minX, box.maxX],
    [origin.y, dir.y, box.minY, box.maxY],
    [origin.z, dir.z, box.minZ, box.maxZ],
  ];

  for (const [o, d, min, max] of axes) {
    if (Math.abs(d) < 1e-9) {
      // 与该轴平行：起点不在板内则永不相交
      if (o < min || o > max) {
        return null;
      }
      continue;
    }
    const inv = 1 / d;
    let t1 = (min - o) * inv;
    let t2 = (max - o) * inv;
    if (t1 > t2) {
      [t1, t2] = [t2, t1];
    }
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) {
      return null;
    }
  }

  return tMin >= 0 && tMin <= maxT ? tMin : null;
}

/**
 * 射线与竖直圆柱求交（玩家命中体），返回最近命中距离 t。
 * 圆柱以 (target.x, target.y, target.z) 为底面圆心，高 PLAYER_HEIGHT。
 */
export function rayPlayerCylinder(
  origin: Vec3,
  dir: Vec3,
  target: { x: number; y: number; z: number },
  maxT: number,
): number | null {
  const ox = origin.x - target.x;
  const oz = origin.z - target.z;

  const a = dir.x * dir.x + dir.z * dir.z;
  const b = 2 * (ox * dir.x + oz * dir.z);
  const c = ox * ox + oz * oz - PLAYER_HIT_RADIUS * PLAYER_HIT_RADIUS;

  // 视线接近竖直：退化为「头顶/脚下穿过圆盘」判定
  if (a < 1e-9) {
    if (c > 0) {
      return null;
    }
    const t = dir.y > 0
      ? (target.y - origin.y) / dir.y
      : (target.y + PLAYER_HEIGHT - origin.y) / dir.y;
    return t >= 0 && t <= maxT ? t : null;
  }

  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) {
    return null;
  }
  const sqrtDisc = Math.sqrt(discriminant);
  const candidates = [(-b - sqrtDisc) / (2 * a), (-b + sqrtDisc) / (2 * a)];

  for (const t of candidates) {
    if (t < 0 || t > maxT) {
      continue;
    }
    const y = origin.y + dir.y * t;
    if (y >= target.y && y <= target.y + PLAYER_HEIGHT) {
      return t;
    }
  }
  return null;
}

/**
 * 计算一次开火的结果。shooter 必须存活；返回值为可直接广播的 ShotMessage。
 */
export function computeShot(
  players: Iterable<CombatantView>,
  shooterId: string,
  obstacles: readonly Aabb[],
): ShotMessage | null {
  let shooter: CombatantView | null = null;
  for (const player of players) {
    if (player.sessionId === shooterId) {
      shooter = player;
      break;
    }
  }
  if (shooter === null || !shooter.alive) {
    return null;
  }

  const origin: Vec3 = { x: shooter.x, y: shooter.y + EYE_HEIGHT, z: shooter.z };
  const dir = directionFromYawPitch(shooter.yaw, shooter.pitch);

  // 最近掩体遮挡距离
  let wallT = WEAPON_RANGE;
  for (const box of obstacles) {
    const t = rayAabb(origin, dir, box, wallT);
    if (t !== null && t < wallT) {
      wallT = t;
    }
  }

  // 最近被命中玩家（必须比掩体更近才算命中）
  let hitPlayerId: string | null = null;
  let hitT = wallT;
  for (const player of players) {
    if (player.sessionId === shooterId || !player.alive) {
      continue;
    }
    const t = rayPlayerCylinder(origin, dir, player, hitT);
    if (t !== null && t < hitT) {
      hitT = t;
      hitPlayerId = player.sessionId;
    }
  }

  const endT = hitPlayerId === null ? wallT : hitT;
  return {
    shooterId,
    origin,
    hit: {
      x: origin.x + dir.x * endT,
      y: origin.y + dir.y * endT,
      z: origin.z + dir.z * endT,
    },
    hitPlayerId,
  };
}
