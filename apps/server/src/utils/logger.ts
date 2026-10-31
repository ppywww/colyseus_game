import { pino, type Logger } from "pino";

import { PROJECT_NAME } from "@colyseus-fps/shared";

/** 创建服务端统一使用的结构化日志实例。 */
export function createLogger(level: string): Logger {
  return pino({
    level,
    base: {
      service: PROJECT_NAME,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
