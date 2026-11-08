/**
 * 本地玩家第一人称移动物理（纯逻辑，无渲染依赖，可在 Node 中单测）。
 *
 * 参考 threejs-fps-controls 的基本碰撞思路：WASD 平面移动 + 重力跳跃，
 * 玩家视为 AABB，与地图箱体做最小平移轴（MTA）推出。
 * 场地边界是矩形（逐轴钳制），与 shared 的 MAP_BOUNDS / 服务端 transform.ts 保持一致。
 * S2 客户端权威移动；S3 将改为服务端权威模拟，这里保留纯函数形态便于迁移。
 */

import { MAP_BOUNDS } from "@colyseus-fps/shared";

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

/** 推进一步移动模拟；直接原地修改并返回传入的 kinematics。 */
export function stepPlayer(
  kinematics: PlayerKinematics,
  input: MoveInput,
  dtSeconds: number,
  colliders: readonly Aabb[],
  options: PhysicsOptions = DEFAULT_PHYSICS,
): PlayerKinematics {
  const dt = Math.min(dtSeconds, 0.1); // 掉帧保护：单步最长按 100ms 计
  const speed = input.sprint ? options.sprintSpeed : options.walkSpeed;

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

  // 跳跃与重力
  if (input.jump && kinematics.grounded) {
    kinematics.vy = options.jumpSpeed;
    kinematics.grounded = false;
  }
  kinematics.vy -= options.gravity * dt;

  kinematics.x += dirX * dt;
  kinematics.z += dirZ * dt;
  kinematics.y += kinematics.vy * dt;

  // 地面
  if (kinematics.y <= 0) {
    kinematics.y = 0;
    kinematics.vy = 0;
    kinematics.grounded = true;
  }

  // 场地边界（矩形，逐轴钳制并内缩玩家半径）
  const radius = options.playerRadius;
  kinematics.x = Math.min(options.bounds.maxX - radius, Math.max(options.bounds.minX + radius, kinematics.x));
  kinematics.z = Math.min(options.bounds.maxZ - radius, Math.max(options.bounds.minZ + radius, kinematics.z));

  // 箱体碰撞：最小平移轴推出
  for (const box of colliders) {
    resolveBox(kinematics, box, options);
  }

  return kinematics;
}

function resolveBox(k: PlayerKinematics, box: Aabb, options: PhysicsOptions): void {
  const r = options.playerRadius;
  const h = options.playerHeight;

  const minX = k.x - r;
  const maxX = k.x + r;
  const minY = k.y;
  const maxY = k.y + h;
  const minZ = k.z - r;
  const maxZ = k.z + r;

  const overlapX = Math.min(maxX, box.maxX) - Math.max(minX, box.minX);
  if (overlapX <= 0) {
    return;
  }
  const overlapY = Math.min(maxY, box.maxY) - Math.max(minY, box.minY);
  if (overlapY <= 0) {
    return;
  }
  const overlapZ = Math.min(maxZ, box.maxZ) - Math.max(minZ, box.minZ);
  if (overlapZ <= 0) {
    return;
  }

  // 推出代价最小的轴
  if (overlapY <= overlapX && overlapY <= overlapZ) {
    // 垂直推出：优先向上（踩到箱子顶）
    const pushUp = box.maxY - minY;
    const pushDown = maxY - box.minY;
    if (pushUp <= pushDown) {
      k.y += pushUp;
      k.vy = 0;
      k.grounded = true;
    } else {
      k.y -= pushDown;
      if (k.vy > 0) {
        k.vy = 0;
      }
    }
    return;
  }

  if (overlapX <= overlapZ) {
    const centerBox = (box.minX + box.maxX) / 2;
    k.x += k.x < centerBox ? -overlapX : overlapX;
  } else {
    const centerBox = (box.minZ + box.maxZ) / 2;
    k.z += k.z < centerBox ? -overlapZ : overlapZ;
  }
}
