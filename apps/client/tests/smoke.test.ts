/**
 * 客户端冒烟测试（骨架阶段）。
 *
 * 目的：
 *   1. 让根命令 `pnpm test`（即 `pnpm -r test`）真正覆盖 client 包，而不是被静默跳过；
 *   2. 在渲染引擎尚未确定时，先锁住「入口占位文件存在 + 共享常量可见」这两条底线。
 *
 * 约束：不引入任何渲染库，只依赖 Node 内置测试运行器。
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  CLIENT_INTERPOLATION_DELAY_MS,
  GAME_TICK_RATE,
  PROJECT_NAME,
  PROTOCOL_VERSION,
} from "@colyseus-fps/shared";

const currentDir: string = dirname(fileURLToPath(import.meta.url));
const clientRoot: string = resolve(currentDir, "..");

describe("客户端入口占位", () => {
  it("index.html 入口页应存在且包含产品标识与画布容器", () => {
    const htmlPath: string = resolve(clientRoot, "index.html");
    assert.ok(existsSync(htmlPath), `缺少客户端入口文件：${htmlPath}`);

    const html: string = readFileSync(htmlPath, "utf8");
    assert.ok(html.includes("<!doctype html>"), "入口文件缺少 HTML 声明");
    // 产品标识随视觉改版变化：断言当前主题名，防止入口页被整体替换成空壳
    assert.ok(html.includes("猫鼠战场"), "入口文件缺少产品标识");
    assert.ok(html.includes('id="game-container"'), "入口文件缺少画布容器");
  });

  it("入口脚本 src/main.ts 应存在", () => {
    const mainPath: string = resolve(clientRoot, "src/main.ts");
    assert.ok(existsSync(mainPath), `缺少客户端入口脚本：${mainPath}`);
  });
});

describe("共享常量在客户端可见", () => {
  it("项目名称应为非空字符串", () => {
    assert.equal(typeof PROJECT_NAME, "string");
    assert.ok(PROJECT_NAME.length > 0);
  });

  it("逻辑帧率应为 20Hz 的正整数", () => {
    assert.equal(GAME_TICK_RATE, 20);
    assert.ok(Number.isInteger(GAME_TICK_RATE));
  });

  it("客户端插值延迟应大于 0 且不超过 500ms", () => {
    assert.ok(CLIENT_INTERPOLATION_DELAY_MS > 0);
    assert.ok(CLIENT_INTERPOLATION_DELAY_MS <= 500);
  });

  it("协议版本应为 2（与 shared 保持同步）", () => {
    assert.equal(PROTOCOL_VERSION, 2);
  });
});
