/**
 * 服务端权威近战判定（纯函数，可单测）。
 *
 * 为什么小刀**不做圆柱求交**：枪是"射出一条线"，刀是"扫过一片扇面"。
 * 用射线判刀会得到两个荒谬结果——贴身站着但角度偏 5° 就砍不到、
 * 而远处一条细线上的敌人反而被砍中。所以这里用的是 CS 的口径：
 *
 *   命中条件（三条同时满足）：
 *     1. 水平距离 ≤ {@link MELEE_RANGE}（2.0m，含 0.35m 半径容差与陈旧位置预算）
 *     2. 与攻击者朝向的夹角 ≤ {@link MELEE_ARC}（±35°，共 70°）
 *     3. `|Δy| ≤ MELEE_VERTICAL_TOLERANCE`（1.6m，防止隔层/隔台砍人）
 *
 *   背刺：**目标自己的朝向**与「目标 → 攻击者」方向的夹角 > {@link MELEE_BACKSTAB_ANGLE}
 *   （110°）。用目标朝向而不是攻击者位置，是因为"绕到背后"的本质是
 *   "对方看不到你"，而不是"你站在某个坐标上"。
 *
 * 与枪械的另一个差别：刀不吃部位倍率（`ZONE_DAMAGE`），只有两档——正面 55 / 背刺 100，
 * 所以 `applyDamage` 的 `zone` 传 null。
 */

import {
  MELEE_ARC,
  MELEE_BACKSTAB_ANGLE,
  MELEE_DAMAGE_BACK,
  MELEE_DAMAGE_FRONT,
  MELEE_RANGE,
  MELEE_VERTICAL_TOLERANCE,
  type KnifeResultMessage,
} from "@colyseus-fps/shared";

import type { AimSnapshot, CombatantView } from "./combat.js";

/**
 * 挥刀起点（相对攻击者脚底的手部位置）。
 *
 * 数值与客户端化身 `avatar-model.ts` 的 `HAND_ANCHOR_WORLD` 一致（0.24, 1.12, −0.20），
 * 这样刀光的起点正好落在模型手上，而不是屏幕正中。
 */
const KNIFE_HAND = { right: 0.24, up: 1.12, forward: 0.2 } as const;

/** 由 yaw 求水平朝向（与 three.js YXZ 相机一致：yaw=0 朝 −Z）。 */
function forwardOf(yaw: number): { x: number; z: number } {
  return { x: -Math.sin(yaw), z: -Math.cos(yaw) };
}

/** 把向量归一化；零向量返回 null（避免除零）。 */
function normalize2D(x: number, z: number): { x: number; z: number } | null {
  const length: number = Math.hypot(x, z);
  if (length < 1e-6) {
    return null;
  }
  return { x: x / length, z: z / length };
}

/** 两个水平单位向量的夹角（弧度，0–π）。 */
function angleBetween(
  a: { x: number; z: number },
  b: { x: number; z: number },
): number {
  const dot: number = Math.max(-1, Math.min(1, a.x * b.x + a.z * b.z));
  return Math.acos(dot);
}

/**
 * 结算一次挥刀。
 *
 * @param players 房间内全部玩家
 * @param attackerId 挥刀者 sessionId
 * @param aim 挥刀瞬间的视角快照（可省；已由调用方做 3° 校验）
 * @returns 可直接广播的 `KNIFE_RESULT`；挥刀者非法（不存在 / 已死亡）时返回 null。
 *          **挥空也返回消息**（`hitPlayerId = null`）——远端玩家靠它播"他在挥刀"的动画。
 */
export function resolveKnife(
  players: Iterable<CombatantView>,
  attackerId: string,
  aim?: AimSnapshot,
): KnifeResultMessage | null {
  const all: CombatantView[] = Array.from(players);

  let attacker: CombatantView | null = null;
  for (const player of all) {
    if (player.sessionId === attackerId) {
      attacker = player;
      break;
    }
  }
  if (attacker === null || !attacker.alive) {
    return null;
  }

  const yaw: number = aim?.yaw ?? attacker.yaw;
  const forward = forwardOf(yaw);
  const right = { x: Math.cos(yaw), z: -Math.sin(yaw) };

  let nearest: { player: CombatantView; distance: number; backstab: boolean } | null = null;

  for (const target of all) {
    if (target.sessionId === attackerId || !target.alive) {
      continue;
    }
    const dx: number = target.x - attacker.x;
    const dz: number = target.z - attacker.z;
    const distance: number = Math.hypot(dx, dz);
    if (distance > MELEE_RANGE) {
      continue;
    }
    if (Math.abs(target.y - attacker.y) > MELEE_VERTICAL_TOLERANCE) {
      continue;
    }

    const toTarget = normalize2D(dx, dz);
    // 完全重叠（distance ≈ 0）时方向无意义，视为正前方命中
    const angle: number = toTarget === null ? 0 : angleBetween(forward, toTarget);
    if (angle > MELEE_ARC) {
      continue;
    }

    // 背刺：目标朝向 vs「目标 → 攻击者」
    const targetForward = forwardOf(target.yaw);
    const toAttacker = normalize2D(-dx, -dz);
    const behindAngle: number = toAttacker === null ? Math.PI : angleBetween(targetForward, toAttacker);
    const backstab: boolean = behindAngle > MELEE_BACKSTAB_ANGLE;

    if (nearest === null || distance < nearest.distance) {
      nearest = { player: target, distance, backstab };
    }
  }

  return {
    attackerId,
    hitPlayerId: nearest === null ? null : nearest.player.sessionId,
    damage: nearest === null ? 0 : nearest.backstab ? MELEE_DAMAGE_BACK : MELEE_DAMAGE_FRONT,
    backstab: nearest === null ? false : nearest.backstab,
    x: attacker.x + right.x * KNIFE_HAND.right + forward.x * KNIFE_HAND.forward,
    y: attacker.y + KNIFE_HAND.up,
    z: attacker.z + right.z * KNIFE_HAND.right + forward.z * KNIFE_HAND.forward,
    yaw,
  };
}
