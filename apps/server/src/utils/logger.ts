import { execSync } from "node:child_process";

import { pino, type Logger } from "pino";

import { PROJECT_NAME } from "@colyseus-fps/shared";

/**
 * Windows 控制台默认 GBK 代码页，会把 pino 输出的 UTF-8 中文渲染成乱码。
 * 在交互式终端中启动时自动切到 65001（UTF-8）。非 Windows 或输出被重定向时不做任何事。
 */
export function ensureConsoleUtf8(): void {
  if (process.platform !== "win32" || !process.stdout.isTTY) {
    return;
  }
  try {
    execSync("chcp 65001", { stdio: "ignore", windowsHide: true });
  } catch {
    // 权限不足或非交互环境：保持原样，仅影响日志显示
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
