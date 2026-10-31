/**
 * 服务端入口（骨架占位版本）。
 *
 * 当前阶段仅完成「最小可运行」验证：读取环境变量、打印启动信息。
 * 后续各模块的实现位置已在下方注释中标明，按开发阶段逐个填充即可，
 * 请勿在本文件中堆积业务逻辑，保持入口只负责「组装 + 启动」。
 *
 * 实现顺序建议：
 *   1. src/config     ：环境变量加载与校验（zod）
 *   2. src/utils      ：Pino 日志实例
 *   3. src/state      ：Colyseus Schema 状态定义（玩家、房间、对局）
 *   4. src/rooms      ：FPSBattleRoom 生命周期与消息路由
 *   5. src/handlers   ：移动 / 开火 / 命中 / 结算等具体消息处理
 *   6. src/audit      ：SQLite 审计记录（安全增强，占 20% 工作量）
 *   7. src/monitoring ：Prometheus 指标暴露（安全增强）
 */

import { GAME_TICK_RATE, PROJECT_NAME } from "@colyseus-fps/shared";

/** 从环境变量读取数字，缺失时回退到默认值。 */
function readNumber(name: string, fallback: number): number {
  const raw: string | undefined = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parsed: number = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** 从环境变量读取字符串，缺失时回退到默认值。 */
function readString(name: string, fallback: string): string {
  const raw: string | undefined = process.env[name];
  return raw === undefined || raw.trim() === "" ? fallback : raw;
}

const nodeEnv: string = readString("NODE_ENV", "development");
const serverHost: string = readString("SERVER_HOST", "0.0.0.0");
const serverPort: number = readNumber("SERVER_PORT", 2567);
const roomName: string = readString("ROOM_NAME", "fps_battle");
const roomMaxClients: number = readNumber("ROOM_MAX_CLIENTS", 10);
const logLevel: string = readString("LOG_LEVEL", "info");
const auditDbPath: string = readString("AUDIT_DB_PATH", "data/audit.db");
const metricsPort: number = readNumber("METRICS_PORT", 9464);

const startedAt: Date = new Date();

console.log("=========================================================");
console.log(` ${PROJECT_NAME} - Colyseus 服务端（骨架占位）`);
console.log("=========================================================");
console.log(` 运行环境     : ${nodeEnv}`);
console.log(` 监听地址     : ${serverHost}:${serverPort}`);
console.log(` 默认房间     : ${roomName}（最大 ${roomMaxClients} 人）`);
console.log(` 逻辑帧率     : ${GAME_TICK_RATE} Hz`);
console.log(` 日志级别     : ${logLevel}`);
console.log(` 审计数据库   : ${auditDbPath}`);
console.log(` 指标端口     : http://${serverHost === "0.0.0.0" ? "127.0.0.1" : serverHost}:${metricsPort}/metrics`);
console.log(` 启动时间     : ${startedAt.toISOString()}`);
console.log("---------------------------------------------------------");
console.log(" 待实现位置：");
console.log("   - src/config/index.ts      ：环境变量 schema 校验");
console.log("   - src/utils/logger.ts      ：Pino 日志实例");
console.log("   - src/state/*.ts           ：Colyseus 状态 Schema");
console.log("   - src/rooms/fps-battle-room.ts ：房间生命周期与消息路由");
console.log("   - src/handlers/*.ts        ：具体消息处理器");
console.log("   - src/audit/*.ts           ：SQLite 审计记录");
console.log("   - src/monitoring/*.ts      ：Prometheus 指标");
console.log("=========================================================");
console.log(" 骨架验证通过，进程即将退出（真实服务将在此处常驻监听）。");
