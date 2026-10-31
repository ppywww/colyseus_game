/**
 * shared 层常量与类型测试。
 *
 * 目的：
 *   1. 保证被前后端共同依赖的常量不会在重构中被静默改坏；
 *   2. 让 `pnpm test` 真正覆盖 shared 包，而不是被 pnpm -r 静默跳过。
 *
 * 本包只依赖 Node 内置测试运行器，不引入任何测试框架。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CLIENT_INTERPOLATION_DELAY_MS,
  GAME_TICK_INTERVAL_MS,
  GAME_TICK_RATE,
  MAX_MESSAGES_PER_SECOND,
  MAX_PLAYERS_PER_ROOM,
  PROJECT_NAME,
  PROTOCOL_VERSION,
} from "../src/index.js";

describe("时间与频率常量", () => {
  it("逻辑帧率应为 20Hz", () => {
    assert.equal(GAME_TICK_RATE, 20);
  });

  it("帧间隔应由帧率推导得出（1000 / 20 = 50ms）", () => {
    assert.equal(GAME_TICK_INTERVAL_MS, 50);
    assert.equal(GAME_TICK_INTERVAL_MS, 1000 / GAME_TICK_RATE);
  });

  it("客户端插值延迟应不小于一个帧间隔，且不超过 500ms", () => {
    assert.ok(
      CLIENT_INTERPOLATION_DELAY_MS >= GAME_TICK_INTERVAL_MS,
      "插值延迟小于帧间隔会导致远端实体抖动",
    );
    assert.ok(CLIENT_INTERPOLATION_DELAY_MS <= 500);
  });
});

describe("房间与协议常量", () => {
  it("房间人数上限应为 2 ~ 64 之间", () => {
    assert.ok(MAX_PLAYERS_PER_ROOM >= 2);
    assert.ok(MAX_PLAYERS_PER_ROOM <= 64);
  });

  it("每秒消息上限应为正数", () => {
    assert.ok(MAX_MESSAGES_PER_SECOND > 0);
  });

  it("协议版本应从 1 开始的正整数", () => {
    assert.equal(PROTOCOL_VERSION, 1);
    assert.ok(Number.isInteger(PROTOCOL_VERSION));
  });

  it("项目名称应为非空字符串", () => {
    assert.equal(typeof PROJECT_NAME, "string");
    assert.ok(PROJECT_NAME.length > 0);
  });
});
