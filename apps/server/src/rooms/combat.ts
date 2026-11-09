/**
 * 服务端权威弹道判定（纯函数，可单测）。
 *
 * 输入只使用服务端保存的玩家位置/朝向（可被"开火视角快照"在 3° 内覆盖），
 * 不信任客户端上传的弹道：
 *   客户端发 fire → 服务端取 shooter 的 x/y/z/yaw/pitch → 射线检测
 * 命中规则：
 *   1. 判定射线从**眼睛**（y + EYE_HEIGHT）沿 yaw/pitch 出发（射程 WEAPON_RANGE）；
 *   2. 掩体箱（AABB）遮挡：先求最近遮挡距离 tWall；
 *   3. 其他存活玩家按 6 段竖直圆柱（{@link PLAYER_HITBOXES}）求交，取 t < tWall 的最近目标，
 *      并按命中段给出 {@link HitZone} 与 {@link ZONE_DAMAGE} 表里的整数伤害。
 *
 * 广播给客户端的 `origin` 是**视觉枪口**（眼睛 + {@link MUZZLE_OFFSET}），不是判定起点：
 * 判定起点留在眼睛，是为了贴脸时不至于先打中自己枪口的模型/掩体边角；
 * 而客户端画弹道线必须从枪口出发，否则线会从屏幕正中"凭空"出现（历史手感问题②）。
 */

import {
  EYE_HEIGHT,
  MUZZLE_OFFSET,
  PLAYER_HITBOXES,
  WEAPON_RANGE,
  ZONE_DAMAGE,
  ZONE_PRIORITY,
  type Aabb,
  type HitZone,
  type ShotMessage,
  type SpreadSample,
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
  /** 当前武器槽位；缺省按 0（步枪）处理，便于纯函数测试。 */
  weaponSlot?: number;
}

/** 命中体求交目标：只需要位置与朝向（朝向用于把手臂圆柱按 yaw 旋转到世界坐标）。 */
export interface HitboxTarget {
  x: number;
  y: number;
  z: number;
  yaw?: number;
}

/** 命中体求交结果：最近命中距离与命中部位。 */
export interface HitboxHit {
  t: number;
  zone: HitZone;
}

/** 开火视角快照（客户端随 FIRE 上行）。 */
export interface AimSnapshot {
  yaw: number;
  pitch: number;
}

/** 同一目标多个圆柱的 t 相差在 1cm 以内时，按 {@link ZONE_PRIORITY} 取优先部位。 */
const ZONE_TIE_EPSILON: number = 0.01;

/** 由 yaw/pitch 计算视线方向（与 three.js YXZ 相机一致：yaw=0 朝 -Z）。 */
export function directionFromYawPitch(yaw: number, pitch: number): Vec3 {
  const cosPitch: number = Math.cos(pitch);
  return {
    x: -Math.sin(yaw) * cosPitch,
    y: Math.sin(pitch),
    z: -Math.cos(yaw) * cosPitch,
  };
}

/** 由 yaw 计算水平「右手方向」单位向量（yaw=0 朝 −Z 时右手边为 +X）。 */
export function rightFromYaw(yaw: number): Vec3 {
  return { x: Math.cos(yaw), y: 0, z: -Math.sin(yaw) };
}

/** 射线与 AABB 求交的结果：进入距离 + 命中面的外法向。 */
export interface AabbHit {
  /** 从射线起点到进入面的距离。 */
  t: number;
  /** 命中面的单位外法向（指向射线来的一侧）。 */
  normal: Vec3;
}

/**
 * 射线与 AABB 求交（slab 法），同时求出**命中面的法向**。
 *
 * 法向是弹孔贴合的前提：只知道命中点、不知道贴哪个面，斜着打墙时弹孔会浮空或埋进墙里。
 * 实现上记录"是哪个轴把 tMin 顶上去的"，该轴按射线方向的符号取反即为外法向。
 *
 * 起点落在盒内（`axis === -1`）时没有有意义的外法向，退化为 −dir（迎着射线），
 * 这样弹孔仍然贴在玩家这一侧的表面上，而不是消失。
 */
export function rayAabbHit(origin: Vec3, dir: Vec3, box: Aabb, maxT: number): AabbHit | null {
  let tMin = 0;
  let tMax = maxT;
  let axis = -1;

  const axes: Array<[number, number, number, number]> = [
    [origin.x, dir.x, box.minX, box.maxX],
    [origin.y, dir.y, box.minY, box.maxY],
    [origin.z, dir.z, box.minZ, box.maxZ],
  ];

  for (let i = 0; i < axes.length; i += 1) {
    const [o, d, min, max] = axes[i] as [number, number, number, number];
    if (Math.abs(d) < 1e-9) {
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
    if (t1 > tMin) {
      tMin = t1;
      axis = i;
    }
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) {
      return null;
    }
  }

  if (tMin < 0 || tMin > maxT) {
    return null;
  }

  if (axis === -1) {
    return { t: tMin, normal: { x: -dir.x, y: -dir.y, z: -dir.z } };
  }
  const normal: Vec3 = { x: 0, y: 0, z: 0 };
  if (axis === 0) {
    normal.x = dir.x > 0 ? -1 : 1;
  } else if (axis === 1) {
    normal.y = dir.y > 0 ? -1 : 1;
  } else {
    normal.z = dir.z > 0 ? -1 : 1;
  }
  return { t: tMin, normal };
}

/** 射线与 AABB 求交（slab 法），返回进入距离 t；不相交返回 null。 */
export function rayAabb(origin: Vec3, dir: Vec3, box: Aabb, maxT: number): number | null {
  const hit: AabbHit | null = rayAabbHit(origin, dir, box, maxT);
  return hit === null ? null : hit.t;
}

/**
 * 射线与单个竖直圆柱求交，返回最近命中距离 t；不相交返回 null。
 *
 * @param centerX 圆柱轴的世界 X
 * @param baseY 圆柱所在玩家的**脚底**世界 Y（yMin/yMax 是相对脚底的高度）
 * @param centerZ 圆柱轴的世界 Z
 * @param yMin 圆柱下沿（相对脚底）
 * @param yMax 圆柱上沿（相对脚底）
 * @param radius 圆柱半径
 * @param maxT 射线上限（超过即视为未命中）
 */
export function rayVerticalCylinder(
  origin: Vec3,
  dir: Vec3,
  centerX: number,
  baseY: number,
  centerZ: number,
  yMin: number,
  yMax: number,
  radius: number,
  maxT: number,
): number | null {
  const ox: number = origin.x - centerX;
  const oz: number = origin.z - centerZ;

  const a: number = dir.x * dir.x + dir.z * dir.z;
  const c: number = ox * ox + oz * oz - radius * radius;

  // 视线接近竖直：退化为「穿过圆盘」判定（与旧实现同样的兜底分支）
  if (a < 1e-9) {
    if (c > 0) {
      return null;
    }
    const targetY: number = dir.y > 0 ? baseY + yMin : baseY + yMax;
    const t: number = (targetY - origin.y) / dir.y;
    return t >= 0 && t <= maxT ? t : null;
  }

  const b: number = 2 * (ox * dir.x + oz * dir.z);
  const discriminant: number = b * b - 4 * a * c;
  if (discriminant < 0) {
    return null;
  }

  const sqrtDisc: number = Math.sqrt(discriminant);
  const candidates: number[] = [(-b - sqrtDisc) / (2 * a), (-b + sqrtDisc) / (2 * a)];

  for (const t of candidates) {
    if (t < 0 || t > maxT) {
      continue;
    }
    const y: number = origin.y + dir.y * t;
    if (y >= baseY + yMin && y <= baseY + yMax) {
      return t;
    }
  }
  return null;
}

/**
 * 射线 vs 玩家 6 段判定体：返回最近的「命中距离 + 部位」。
 *
 * 同距离取舍：若多个圆柱的 t 相差 ≤1cm（擦边同时挂住头和胸），按 {@link ZONE_PRIORITY}
 * 取高优先级者（头优先）——否则擦边球会按"更低伤害的部位"结算，玩家会觉得"打头不掉血"。
 */
export function rayPlayerHitboxes(
  origin: Vec3,
  dir: Vec3,
  target: HitboxTarget,
  maxT: number,
): HitboxHit | null {
  const yaw: number = target.yaw ?? 0;
  const right: Vec3 = rightFromYaw(yaw);

  let best: HitboxHit | null = null;
  for (const box of PLAYER_HITBOXES) {
    const centerX: number = target.x + right.x * box.offsetRight;
    const centerZ: number = target.z + right.z * box.offsetRight;
    const t: number | null = rayVerticalCylinder(
      origin,
      dir,
      centerX,
      target.y,
      centerZ,
      box.yMin,
      box.yMax,
      box.radius,
      maxT,
    );
    if (t === null) {
      continue;
    }
    if (best === null || t < best.t - ZONE_TIE_EPSILON) {
      best = { t, zone: box.zone };
      continue;
    }
    if (Math.abs(t - best.t) <= ZONE_TIE_EPSILON && ZONE_PRIORITY[box.zone] < ZONE_PRIORITY[best.zone]) {
      best = { t, zone: box.zone };
    }
  }
  return best;
}

/**
 * 把扩散偏移施加到单位方向上（返回新的单位方向）。
 *
 * 做法：在垂直于 `dir` 的 (right, up) 平面内平移 `tan(半角) × 单位盘坐标`，再归一化。
 * 偏移量与 `dir` 垂直，所以偏移后的夹角正好是 `atan(tan(半角) × |sample|)`，
 * `|sample| = 1` 时**精确等于**半角——不是小角近似，30m 处误差 < 1mm。
 */
function applySpread(dir: Vec3, right: Vec3, sample: SpreadSample): Vec3 {
  // up = right × dir（右手系，与客户端的相机 up 同向）
  const up: Vec3 = {
    x: right.y * dir.z - right.z * dir.y,
    y: right.z * dir.x - right.x * dir.z,
    z: right.x * dir.y - right.y * dir.x,
  };
  const tan: number = Math.tan((sample.halfAngleDeg * Math.PI) / 180);
  const dx: number = (right.x * sample.x + up.x * sample.y) * tan;
  const dy: number = (right.y * sample.x + up.y * sample.y) * tan;
  const dz: number = (right.z * sample.x + up.z * sample.y) * tan;
  const length: number = Math.hypot(dir.x + dx, dir.y + dy, dir.z + dz) || 1;
  return {
    x: (dir.x + dx) / length,
    y: (dir.y + dy) / length,
    z: (dir.z + dz) / length,
  };
}

/**
 * 计算一次开火的完整结果（返回值可直接广播，也是 `ShotMessage` 结构）。
 *
 * @param players 房间内全部玩家（任意 Iterable，函数内部先物化，避免耗尽一次性迭代器）
 * @param shooterId 开火者 sessionId
 * @param obstacles 掩体 AABB 清单（64 条，来自 shared `obstacleColliders()`）
 * @param aim 开火视角快照（已在调用方做过 3° 校验与归一化）；缺省用服务端已存视角
 * @param maxRange 本次开火的射程上限（米）；缺省 {@link WEAPON_RANGE}（步枪）
 * @param originOverride 开火瞬间的脚底坐标（已在调用方做过速度合理性校验）；
 *   缺省用服务端保存的位置。移动中开火必须用它，否则判定起点落后于画面
 * @param spread 服务端权威扩散采样（单位盘坐标 + 半角），缺省为无扩散。
 *   **必须由服务端生成**：客户端算扩散等于让作弊端把 spread 置 0 变激光枪。
 *   采样只改方向、不改起点——扩散是"打偏"，不是"从别的地方开枪"。
 * @param shotSeq 客户端开火序号（原样回显）。客户端用它把这一发和自己抠扳机瞬间
 *   记下的枪口快照对上号，缺省 0。服务端只负责搬运，不做任何校验——
 *   它不参与判定，乱填也只会让作弊者自己的曳光画歪。
 */
export function computeShot(
  players: Iterable<CombatantView>,
  shooterId: string,
  obstacles: readonly Aabb[],
  aim?: AimSnapshot,
  maxRange: number = WEAPON_RANGE,
  originOverride?: { x: number; y: number; z: number } | null,
  spread?: SpreadSample | null,
  shotSeq: number = 0,
): ShotMessage | null {
  const all: CombatantView[] = Array.from(players);

  let shooter: CombatantView | null = null;
  for (const player of all) {
    if (player.sessionId === shooterId) {
      shooter = player;
      break;
    }
  }
  if (shooter === null || !shooter.alive) {
    return null;
  }

  const yaw: number = aim?.yaw ?? shooter.yaw;
  const pitch: number = aim?.pitch ?? shooter.pitch;
  const feetX: number = originOverride?.x ?? shooter.x;
  const feetY: number = originOverride?.y ?? shooter.y;
  const feetZ: number = originOverride?.z ?? shooter.z;

  const right: Vec3 = rightFromYaw(yaw);
  const baseDir: Vec3 = directionFromYawPitch(yaw, pitch);
  // 扩散：在 (right, up) 平面里按 tan(半角) 偏移，再归一化。
  // 只旋转方向、不移动起点——否则"打偏"会变成"从旁边开枪"，贴墙时会打到不同的掩体。
  const dir: Vec3 = spread === undefined || spread === null || spread.halfAngleDeg <= 0
    ? baseDir
    : applySpread(baseDir, right, spread);
  // 判定射线起点 = 眼睛（不能挪到枪口：贴脸时会先打中自己的枪口模型/掩体边角）
  const rayOrigin: Vec3 = { x: feetX, y: feetY + EYE_HEIGHT, z: feetZ };
  // 广播用视觉枪口 = 眼睛 + 右向偏移 + 向下偏移 + 前向偏移（与第一人称视模型姿态对齐）
  const up: Vec3 = {
    x: right.y * dir.z - right.z * dir.y,
    y: right.z * dir.x - right.x * dir.z,
    z: right.x * dir.y - right.y * dir.x,
  };
  const muzzle: Vec3 = {
    x: rayOrigin.x + right.x * MUZZLE_OFFSET.right + up.x * -MUZZLE_OFFSET.down + dir.x * MUZZLE_OFFSET.forward,
    y: rayOrigin.y + right.y * MUZZLE_OFFSET.right + up.y * -MUZZLE_OFFSET.down + dir.y * MUZZLE_OFFSET.forward,
    z: rayOrigin.z + right.z * MUZZLE_OFFSET.right + up.z * -MUZZLE_OFFSET.down + dir.z * MUZZLE_OFFSET.forward,
  };

  // 最近遮挡距离：先在掩体里找，再单独算地面。
  //
  // 地面必须单独算：地板不是 AABB（它是渲染层的一个平面），不在 `obstacleColliders()` 里。
  // 漏掉它的后果不是"弹孔少一点"，而是朝下开枪时射线穿过地板一直飞到 maxRange，
  // 弹着点出现在地图外——玩家看到的是"打地面什么反应都没有"。
  let wallT: number = maxRange;
  let wallNormal: Vec3 | null = null;
  for (const box of obstacles) {
    const hit: AabbHit | null = rayAabbHit(rayOrigin, dir, box, wallT);
    if (hit !== null && hit.t < wallT) {
      wallT = hit.t;
      wallNormal = hit.normal;
    }
  }
  if (dir.y < -1e-6) {
    const groundT: number = (0 - rayOrigin.y) / dir.y;
    if (groundT > 0 && groundT < wallT) {
      wallT = groundT;
      wallNormal = { x: 0, y: 1, z: 0 };
    }
  }

  // 最近被命中玩家（必须比掩体更近才算命中）
  let hitPlayerId: string | null = null;
  let hitZone: HitZone | null = null;
  let hitT: number = wallT;
  for (const player of all) {
    if (player.sessionId === shooterId || !player.alive) {
      continue;
    }
    const hit: HitboxHit | null = rayPlayerHitboxes(rayOrigin, dir, player, hitT);
    if (hit !== null && hit.t < hitT) {
      hitT = hit.t;
      hitPlayerId = player.sessionId;
      hitZone = hit.zone;
    }
  }

  const damage: number = hitZone === null ? 0 : ZONE_DAMAGE[hitZone];
  const endT: number = hitPlayerId === null ? wallT : hitT;
  const hitSurface: ShotMessage["hitSurface"] =
    hitPlayerId !== null ? "player" : wallNormal === null ? "none" : "wall";

  return {
    shooterId,
    origin: muzzle,
    rayOrigin,
    dir,
    hit: {
      x: rayOrigin.x + dir.x * endT,
      y: rayOrigin.y + dir.y * endT,
      z: rayOrigin.z + dir.z * endT,
    },
    hitNormal: hitPlayerId === null ? wallNormal : null,
    hitSurface,
    hitPlayerId,
    hitZone,
    damage,
    weaponSlot: shooter.weaponSlot ?? 0,
    spreadDeg: spread === undefined || spread === null ? 0 : spread.halfAngleDeg,
    shotSeq: Number.isFinite(shotSeq) ? Math.max(0, Math.trunc(shotSeq)) : 0,
  };
}
