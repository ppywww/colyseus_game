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

/** S2 阶段的客户端/服务端消息类型。 */
export const MESSAGE_TYPES = {
  PING: "ping",
  PONG: "pong",
  PLAYER_TRANSFORM: "player_transform",
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
