/**
 * 服务端冒烟测试（骨架阶段）。
 *
 * 目的：在没有任何游戏逻辑时，保证 `pnpm test` 与 CI 能够真实通过；
 * 后续各模块（配置、状态、命中判定、审计）请在其对应目录下新增 *.test.ts，
 * 不要删除本文件，它同时充当「测试运行器可用」的基线校验。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GAME_TICK_RATE, MAX_PLAYERS_PER_ROOM, PROJECT_NAME } from "@colyseus-fps/shared";

describe("shared 常量", () => {
  it("逻辑帧率应为 20Hz", () => {
    assert.equal(GAME_TICK_RATE, 20);
  });

  it("房间人数上限应大于 1", () => {
    assert.ok(MAX_PLAYERS_PER_ROOM > 1);
  });

  it("项目名称应为非空字符串", () => {
    assert.equal(typeof PROJECT_NAME, "string");
    assert.ok(PROJECT_NAME.length > 0);
  });
});

describe("运行环境", () => {
  it("应运行在 Node.js 24 及以上", () => {
    const major: number = Number(process.versions.node.split(".")[0]);
    assert.ok(major >= 24, `当前 Node 主版本为 ${major}，要求 >= 24`);
  });
});
