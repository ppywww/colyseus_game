import { execSync } from "node:child_process";

import { pino, type Logger } from "pino";

import { PROJECT_NAME } from "@colyseus-fps/shared";

/**
 * Windows 控制台默认 GBK 代码页，会把 UTF-8 日志渲染成乱码。
 * 启动时自动切到 65001（UTF-8）。
 *
 * 注意：不能依赖 process.stdout.isTTY 判断 —— pnpm run 会用管道转发
 * 脚本输出，此时 isTTY 为 false，但日志最终仍由控制台渲染，chcp 依然必要。
 */
export function ensureConsoleUtf8(): void {
  if (process.platform !== "win32") {
    return;
  }
  try {
    execSync("chcp 65001", { stdio: "ignore", windowsHide: true });
  } catch {
    // 无控制台或权限不足：保持原样，仅影响日志显示
  }
}

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
