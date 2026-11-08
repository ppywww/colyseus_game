/**
 * 投掷物球-AABB 反弹物理（纯函数，客户端预测与服务端权威共用同一份实现）。
 *
 * 为什么要把这段物理提到 shared：
 *   旧版客户端 `throwables.ts` 只做了重力 + 地面 + 场地边界，**一次掩体求交都没有**，
 *   而服务端 `grenades.ts` 早已按 64 个 AABB 做反弹。两端各写一套的结果是
 *   「玩家看着手雷穿墙飞进掩体，服务端却算它早就撞墙弹回」——爆炸位置与视觉彻底脱节。
 *   现在两端调同一个函数，从结构上消除漂移，而不是靠人工"对齐两份拷贝"。
 *
 * 积分口径（与服务端 S4 一致，改动前请先看三条约束）：
 *   1. 显式欧拉：先 `vy -= g·dt` 再积分位置（顺序不能换，换了两端轨迹就差常量项）；
 *   2. 每个子步都完整跑一遍「重力 → 地面 → 掩体 → 边界」，反弹后的新速度对后续子步立即生效；
 *   3. 子步长上限由 `GRENADE_RADIUS` 反推，保证单子步位移小于碰撞半径，杜绝高速穿墙。
 */

import {
  GRENADE_BOUNCE,
  GRENADE_GRAVITY,
  GRENADE_RADIUS,
  MAP_BOUNDS,
  type Aabb,
} from "./index.js";

/** 参与弹道积分的投掷物状态（`GrenadeState` / 客户端 `LocalGrenade` 结构上都满足它）。 */
export interface GrenadeBody {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
}

/** 撞墙后切向速度的保留系数（CS2 手感：撞墙会"贴墙减速"，不是无摩擦滑冰）。 */
const WALL_FRICTION = 0.85;

/** 地面/箱顶落地时切向速度的保留系数（沿用服务端既有数值，不要与 WALL_FRICTION 混用）。 */
const GROUND_FRICTION = 0.82;

/** 垂直速度低于该值时视为静止，避免在 0 附近无限微小弹跳。 */
const REST_SPEED_Y = 0.6;

/** 单个子步允许的最大位移（米）：取碰撞半径，保证一步不会跨过任何一个 AABB 的厚度。 */
const MAX_SUBSTEP_DISTANCE = GRENADE_RADIUS;

/** 子步数上限：防止异常速度（如被作弊客户端上报的 1000 m/s）把单帧计算量放大。 */
const MAX_SUBSTEPS = 8;

/**
 * 推进一个物理步长（秒）：重力、地面与掩体反弹、场地边界。
 *
 * 大位移会被自动切成若干子步（最多 {@link MAX_SUBSTEPS} 步），否则 60fps 下单帧位移
 * 就能超过 0.4m 厚的墙体，直接"穿"过去。
 */
export function stepGrenadePhysics(
  body: GrenadeBody,
  dtSeconds: number,
  obstacles: readonly Aabb[],
): void {
  if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) {
    return;
  }

  const speed = Math.hypot(body.vx, body.vy, body.vz);
  const distance = Number.isFinite(speed) ? speed * dtSeconds : 0;
  const substeps = Math.max(
    1,
    Math.min(MAX_SUBSTEPS, Math.ceil(distance / MAX_SUBSTEP_DISTANCE)),
  );
  const stepSeconds = dtSeconds / substeps;

  for (let i = 0; i < substeps; i += 1) {
    stepOnce(body, stepSeconds, obstacles);
  }
}

/** 单个子步：与服务端原 `stepGrenade` 逐行等价，只多了撞墙切向摩擦。 */
function stepOnce(body: GrenadeBody, dtSeconds: number, obstacles: readonly Aabb[]): void {
  body.vy -= GRENADE_GRAVITY * dtSeconds;
  body.x += body.vx * dtSeconds;
  body.y += body.vy * dtSeconds;
  body.z += body.vz * dtSeconds;

  // 地面
  if (body.y < GRENADE_RADIUS) {
    body.y = GRENADE_RADIUS;
    if (body.vy < 0) {
      body.vy = -body.vy * GRENADE_BOUNCE;
      body.vx *= GROUND_FRICTION;
      body.vz *= GROUND_FRICTION;
      if (Math.abs(body.vy) < REST_SPEED_Y) {
        body.vy = 0;
      }
    }
  }

  // 掩体：按最小穿透轴推出并反弹对应分量
  for (const box of obstacles) {
    const insideX = body.x > box.minX - GRENADE_RADIUS && body.x < box.maxX + GRENADE_RADIUS;
    const insideZ = body.z > box.minZ - GRENADE_RADIUS && body.z < box.maxZ + GRENADE_RADIUS;
    if (!insideX || !insideZ) {
      continue;
    }

    // 从上方落下：停在箱顶
    if (body.y >= box.maxY && body.y - GRENADE_RADIUS <= box.maxY) {
      body.y = box.maxY + GRENADE_RADIUS;
      body.vy = body.vy < 0 ? -body.vy * GRENADE_BOUNCE : body.vy;
      body.vx *= GROUND_FRICTION;
      body.vz *= GROUND_FRICTION;
      continue;
    }

    if (body.y < box.minY || body.y > box.maxY) {
      continue;
    }

    const pushLeft = body.x - (box.minX - GRENADE_RADIUS);
    const pushRight = box.maxX + GRENADE_RADIUS - body.x;
    const pushBack = body.z - (box.minZ - GRENADE_RADIUS);
    const pushFront = box.maxZ + GRENADE_RADIUS - body.z;
    const minPush = Math.min(pushLeft, pushRight, pushBack, pushFront);

    if (minPush === pushLeft) {
      body.x = box.minX - GRENADE_RADIUS;
      body.vx = -Math.abs(body.vx) * GRENADE_BOUNCE;
      // 切向摩擦：撞 X 面时沿墙滑行的 Z/向上分量要衰减，否则手雷会"滑冰"
      body.vz *= WALL_FRICTION;
      if (body.vy > 0) {
        body.vy *= WALL_FRICTION;
      }
    } else if (minPush === pushRight) {
      body.x = box.maxX + GRENADE_RADIUS;
      body.vx = Math.abs(body.vx) * GRENADE_BOUNCE;
      body.vz *= WALL_FRICTION;
      if (body.vy > 0) {
        body.vy *= WALL_FRICTION;
      }
    } else if (minPush === pushBack) {
      body.z = box.minZ - GRENADE_RADIUS;
      body.vz = -Math.abs(body.vz) * GRENADE_BOUNCE;
      body.vx *= WALL_FRICTION;
      if (body.vy > 0) {
        body.vy *= WALL_FRICTION;
      }
    } else {
      body.z = box.maxZ + GRENADE_RADIUS;
      body.vz = Math.abs(body.vz) * GRENADE_BOUNCE;
      body.vx *= WALL_FRICTION;
      if (body.vy > 0) {
        body.vy *= WALL_FRICTION;
      }
    }
  }

  // 场地边界：矩形的四面外墙（逐轴钳制 + 对应速度分量反向）
  const maxX = MAP_BOUNDS.maxX - GRENADE_RADIUS;
  const minX = MAP_BOUNDS.minX + GRENADE_RADIUS;
  const maxZ = MAP_BOUNDS.maxZ - GRENADE_RADIUS;
  const minZ = MAP_BOUNDS.minZ + GRENADE_RADIUS;
  if (body.x > maxX) {
    body.x = maxX;
    body.vx = -Math.abs(body.vx) * GRENADE_BOUNCE;
  } else if (body.x < minX) {
    body.x = minX;
    body.vx = Math.abs(body.vx) * GRENADE_BOUNCE;
  }
  if (body.z > maxZ) {
    body.z = maxZ;
    body.vz = -Math.abs(body.vz) * GRENADE_BOUNCE;
  } else if (body.z < minZ) {
    body.z = minZ;
    body.vz = Math.abs(body.vz) * GRENADE_BOUNCE;
  }
}
