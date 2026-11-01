/**
 * 前后端共享层（骨架占位版本）。
 *
 * 职责边界：
 *   - 只放「服务端与客户端都必须一致」的常量、枚举与类型；
 *   - 不引用任何 Node 专有模块或浏览器专有对象，保持平台中立；
 *   - 不引入运行时依赖，纯类型 + 常量导出。
 *
 * 后续扩展位置：
 *   - src/protocol/  ：消息类型枚举与消息体接口（客户端上行 / 服务端下行）
 *   - src/types/     ：玩家、武器、对局等公共数据结构
 *   - src/constants/ ：随体量增长后从本文件拆分出去
 */

/** 项目名称，用于日志与监控标签。 */
export const PROJECT_NAME: string = "colyseus-fps-prototype";

/** 服务端逻辑帧率（Hz）：每秒推进的次数，客户端渲染帧率与之解耦。 */
export const GAME_TICK_RATE: number = 20;

/** 单个逻辑帧时长（毫秒），由 GAME_TICK_RATE 推导，避免两处硬编码不一致。 */
export const GAME_TICK_INTERVAL_MS: number = 1000 / GAME_TICK_RATE;

/** 单个房间最大玩家数。 */
export const MAX_PLAYERS_PER_ROOM: number = 10;

/** 客户端状态插值延迟（毫秒）：约等于 2 个逻辑帧，用于平滑远端实体。 */
export const CLIENT_INTERPOLATION_DELAY_MS: number = 100;

/** 单玩家每秒允许发送的消息数量上限（防刷包，服务端据此限流）。 */
export const MAX_MESSAGES_PER_SECOND: number = 30;

/** 协议版本号：客户端与服务端不一致时拒绝连接。 */
export const PROTOCOL_VERSION: number = 1;

/** 默认房间名：客户端与服务端必须保持一致。 */
export const DEFAULT_ROOM_NAME: string = "fps_battle";

/** 默认服务端 WebSocket 端口。 */
export const DEFAULT_SERVER_PORT: number = 2567;

/** 玩家显示名最大长度（按字符截断，避免异常长名称刷爆状态同步）。 */
export const MAX_DISPLAY_NAME_LENGTH: number = 24;

/** S2/S3 阶段的客户端/服务端消息类型。 */
export const MESSAGE_TYPES = {
  PING: "ping",
  PONG: "pong",
  PLAYER_TRANSFORM: "player_transform",
  FIRE: "fire",
  SHOT: "shot",
  KILL: "kill",
  RELOAD: "reload",
  THROW: "throw",
  GRENADE: "grenade_launched",
  EXPLODE: "explode",
  FLASH: "flash",
  DAMAGED: "damaged",
} as const;

export type MessageType = (typeof MESSAGE_TYPES)[keyof typeof MESSAGE_TYPES];

/** 加入房间时客户端提交的选项。 */
export interface JoinRoomOptions {
  name?: string;
  protocolVersion: number;
}

/** 客户端 Ping 消息，用于验证消息通道。 */
export interface PingMessage {
  sentAt: number;
}

/** 服务端 Pong 响应。 */
export interface PongMessage {
  sentAt: number;
  serverTime: number;
  protocolVersion: number;
}

/* ------------------------------------------------------------------ *
 * S2：位置与视角同步
 * ------------------------------------------------------------------ */

/** 场地半径（米）：客户端出生点与移动边界、服务端越界钳制的共同依据。 */
export const ARENA_RADIUS: number = 30;

/** 玩家眼睛高度（米）：本地相机与远端模型头顶标签的共同依据。 */
export const EYE_HEIGHT: number = 1.6;

/** 玩家身高（米）：远端模型与碰撞体的共同依据。 */
export const PLAYER_HEIGHT: number = 1.8;

/** 客户端上报自身位置/视角的频率（Hz）。 */
export const PLAYER_TRANSFORM_RATE_HZ: number = 15;

/** 客户端上行位置/视角消息（seq 单调递增，服务端据此丢弃乱序包）。 */
export interface PlayerTransformMessage {
  seq: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

/** 归一化 yaw 到 (-π, π]。 */
export function normalizeYaw(yaw: number): number {
  const twoPi: number = Math.PI * 2;
  let result: number = yaw % twoPi;
  if (result <= -Math.PI) {
    result += twoPi;
  } else if (result > Math.PI) {
    result -= twoPi;
  }
  return result;
}

/** 钳制 pitch 到 [-π/2, π/2]，防止远端视角翻转。 */
export function clampPitch(pitch: number): number {
  const limit: number = Math.PI / 2;
  return Math.min(limit, Math.max(-limit, pitch));
}

/* ------------------------------------------------------------------ *
 * S3：服务端权威战斗（开火 / 命中 / 血量 / 重生 / 计分）
 * ------------------------------------------------------------------ */

/** 玩家最大血量。 */
export const PLAYER_MAX_HP: number = 100;

/** 单发伤害：4 发击杀。 */
export const WEAPON_DAMAGE: number = 25;

/** 开火最小间隔（毫秒），服务端据此限流，客户端据此做本地预冷却。 */
export const WEAPON_COOLDOWN_MS: number = 150;

/** 武器射程（米）：超过该距离不再命中玩家。 */
export const WEAPON_RANGE: number = 60;

/** 玩家命中判定圆柱半径（米）。 */
export const PLAYER_HIT_RADIUS: number = 0.35;

/** 死亡后重生延迟（毫秒）。 */
export const PLAYER_RESPAWN_DELAY_MS: number = 3000;

/** 服务端广播的弹道结果：所有客户端据此渲染轨迹与命中反馈。 */
export interface ShotMessage {
  shooterId: string;
  origin: { x: number; y: number; z: number };
  hit: { x: number; y: number; z: number };
  /** 被命中的玩家 sessionId；未命中玩家（打空或打在掩体上）为 null。 */
  hitPlayerId: string | null;
}

/** 服务端广播的击杀事件。 */
export interface KillMessage {
  killerId: string;
  victimId: string;
}

/* ------------------------------------------------------------------ *
 * 场地障碍物：渲染（客户端）、碰撞（客户端物理）、弹道遮挡（服务端）
 * 共用同一份数据，保证「所见即所挡」。
 * ------------------------------------------------------------------ */

export interface ObstacleSpec {
  x: number;
  z: number;
  width: number;
  height: number;
  depth: number;
  color: number;
}

/** 轴对齐包围盒（客户端物理与服务端射线遮挡共用）。 */
export interface Aabb {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

/** 掩体布局：中心一块主掩体，四周对称分布（单位：米）。 */
export const OBSTACLES: readonly ObstacleSpec[] = [
  { x: 0, z: 0, width: 6, height: 2.4, depth: 6, color: 0x4a5568 },
  { x: 12, z: 0, width: 3, height: 1.6, depth: 8, color: 0x5a6b7d },
  { x: -12, z: 0, width: 3, height: 1.6, depth: 8, color: 0x5a6b7d },
  { x: 0, z: 12, width: 8, height: 1.6, depth: 3, color: 0x5a6b7d },
  { x: 0, z: -12, width: 8, height: 1.6, depth: 3, color: 0x5a6b7d },
  { x: 9, z: 9, width: 2.4, height: 3, depth: 2.4, color: 0x6b5a7d },
  { x: -9, z: 9, width: 2.4, height: 3, depth: 2.4, color: 0x6b5a7d },
  { x: 9, z: -9, width: 2.4, height: 3, depth: 2.4, color: 0x6b5a7d },
  { x: -9, z: -9, width: 2.4, height: 3, depth: 2.4, color: 0x6b5a7d },
  { x: 20, z: 14, width: 4, height: 2, depth: 2, color: 0x50607a },
  { x: -20, z: -14, width: 4, height: 2, depth: 2, color: 0x50607a },
  { x: -20, z: 14, width: 4, height: 2, depth: 2, color: 0x50607a },
  { x: 20, z: -14, width: 4, height: 2, depth: 2, color: 0x50607a },
];

/** 由障碍数据推导碰撞 AABB。 */
export function obstacleColliders(): Aabb[] {
  return OBSTACLES.map((obstacle) => ({
    minX: obstacle.x - obstacle.width / 2,
    maxX: obstacle.x + obstacle.width / 2,
    minY: 0,
    maxY: obstacle.height,
    minZ: obstacle.z - obstacle.depth / 2,
    maxZ: obstacle.z + obstacle.depth / 2,
  }));
}

/* ------------------------------------------------------------------ *
 * S4：弹药与换弹（服务端权威，客户端只做表现）
 * ------------------------------------------------------------------ */

/** 弹匣容量。 */
export const WEAPON_MAG_SIZE: number = 30;

/** 初始备弹。 */
export const WEAPON_RESERVE_AMMO: number = 120;

/** 换弹耗时（毫秒）。 */
export const WEAPON_RELOAD_MS: number = 1800;

/* ------------------------------------------------------------------ *
 * S4：投掷物（手雷 / 闪光弹 / 烟雾弹）
 * ------------------------------------------------------------------ */

export const THROWABLE_TYPES = {
  FRAG: "frag",
  FLASH: "flash",
  SMOKE: "smoke",
} as const;

export type ThrowableType = (typeof THROWABLE_TYPES)[keyof typeof THROWABLE_TYPES];

export interface ThrowableConfig {
  /** 展示名。 */
  label: string;
  /** 出生携带数量。 */
  initialCount: number;
  /** 引信时长（毫秒，从投出到生效）。 */
  fuseMs: number;
  /** 生效半径（米）。 */
  radius: number;
  /** 客户端渲染颜色。 */
  color: number;
  /** 手雷：中心最大伤害与边缘最小伤害。 */
  maxDamage?: number;
  minDamage?: number;
  /** 闪光弹：正面直视最大致盲时长。 */
  maxBlindMs?: number;
  /** 烟雾弹：云团持续时间。 */
  cloudDurationMs?: number;
}

/** 三种投掷物的统一配置（客户端 HUD 与服务端结算共用）。 */
export const THROWABLES: Record<ThrowableType, ThrowableConfig> = {
  frag: {
    label: "手雷",
    initialCount: 2,
    fuseMs: 2200,
    radius: 6,
    color: 0x4b5563,
    maxDamage: 100,
    minDamage: 20,
  },
  flash: {
    label: "闪光弹",
    initialCount: 2,
    fuseMs: 1600,
    radius: 12,
    color: 0xd1d5db,
    maxBlindMs: 2800,
  },
  smoke: {
    label: "烟雾弹",
    initialCount: 2,
    fuseMs: 1400,
    radius: 5,
    color: 0x9ca3af,
    cloudDurationMs: 15000,
  },
};

/** 投掷初速度（米/秒）：约 14 m/s，配合 18 m/s² 重力形成自然抛物线。 */
export const THROW_SPEED: number = 14;

/** 两次投掷的最小间隔（毫秒）。 */
export const THROW_COOLDOWN_MS: number = 700;

/** 投掷方向的最大俯仰（弧度），防止垂直上抛。 */
export const THROW_MAX_PITCH: number = 0.6;

/** 手雷重力加速度（米/秒²）。 */
export const GRENADE_GRAVITY: number = 18;

/** 手雷落地弹性系数。 */
export const GRENADE_BOUNCE: number = 0.35;

/** 手雷碰撞半径（米）。 */
export const GRENADE_RADIUS: number = 0.11;

/** 手雷脱离手部的位置（相对眼睛）。 */
export const THROW_ORIGIN_FORWARD: number = 0.45;

/** 客户端上行：投掷请求。方向由客户端提供，位置与速度由服务端裁定。 */
export interface ThrowMessage {
  type: ThrowableType;
  dirX: number;
  dirY: number;
  dirZ: number;
}

/** 服务端广播：手雷已投出（客户端据此本地模拟同一条抛物线）。 */
export interface GrenadeLaunchedMessage {
  id: number;
  type: ThrowableType;
  throwerId: string;
  origin: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number };
}

/** 服务端广播：投掷物生效（爆炸 / 闪光 / 起烟）。 */
export interface ExplosionMessage {
  id: number;
  type: ThrowableType;
  throwerId: string;
  x: number;
  y: number;
  z: number;
  radius: number;
}

/** 服务端下发（仅致盲目标本人）：闪光效果强度与时长。 */
export interface FlashEffectMessage {
  intensity: number;
  durationMs: number;
  sourceX: number;
  sourceZ: number;
}

/** 服务端下发（仅受伤者本人）：用于受击方向指示与血量反馈。 */
export interface DamageTakenMessage {
  attackerId: string;
  amount: number;
  hp: number;
  fromX: number;
  fromZ: number;
}

/** 烟雾云团（服务端状态同步，后进玩家也能看到）。 */
export interface SmokeCloudView {
  id: string;
  x: number;
  z: number;
  radius: number;
  expiresAt: number;
}
