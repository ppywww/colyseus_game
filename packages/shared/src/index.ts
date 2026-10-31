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
