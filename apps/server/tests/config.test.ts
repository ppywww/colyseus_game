/**
 * 服务端配置加载测试。
 *
 * 目的：验证 loadConfig 的默认值、环境变量覆盖与非法值拒绝，
 * 保证服务端启动前就能发现配置错误，而不是运行期才暴露。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_ROOM_NAME,
  DEFAULT_SERVER_PORT,
  MAX_MESSAGES_PER_SECOND,
  MAX_PLAYERS_PER_ROOM,
} from "@colyseus-fps/shared";

import { loadConfig } from "../src/config/index.js";

describe("loadConfig 默认值", () => {
  it("空环境应回退到共享层默认值", () => {
    const config = loadConfig({});

    assert.equal(config.NODE_ENV, "development");
    assert.equal(config.SERVER_HOST, "0.0.0.0");
    assert.equal(config.SERVER_PORT, DEFAULT_SERVER_PORT);
    assert.equal(config.ROOM_NAME, DEFAULT_ROOM_NAME);
    assert.equal(config.ROOM_MAX_CLIENTS, MAX_PLAYERS_PER_ROOM);
    assert.equal(config.LOG_LEVEL, "info");
    assert.equal(config.AUDIT_DB_PATH, "data/audit.db");
    assert.equal(config.RATE_LIMIT_PER_SECOND, MAX_MESSAGES_PER_SECOND);
    assert.equal(config.MAX_MESSAGE_BYTES, 2048);
  });
});

describe("loadConfig 环境变量覆盖", () => {
  it("字符串数字应被正确强制转换", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      SERVER_PORT: "3100",
      ROOM_MAX_CLIENTS: "4",
      METRICS_PORT: "9465",
      RATE_LIMIT_PER_SECOND: "10",
      MAX_MESSAGE_BYTES: "1024",
    });

    assert.equal(config.NODE_ENV, "test");
    assert.equal(config.SERVER_PORT, 3100);
    assert.equal(config.ROOM_MAX_CLIENTS, 4);
    assert.equal(config.METRICS_PORT, 9465);
    assert.equal(config.RATE_LIMIT_PER_SECOND, 10);
    assert.equal(config.MAX_MESSAGE_BYTES, 1024);
  });
});

describe("loadConfig 非法值拒绝", () => {
  it("非法端口应抛错", () => {
    assert.throws(() => loadConfig({ SERVER_PORT: "not-a-number" }));
    assert.throws(() => loadConfig({ SERVER_PORT: "70000" }));
  });

  it("房间人数下限为 2，低于下限应抛错", () => {
    assert.throws(() => loadConfig({ ROOM_MAX_CLIENTS: "1" }));
  });

  it("未知日志级别应抛错", () => {
    assert.throws(() => loadConfig({ LOG_LEVEL: "verbose" }));
  });

  it("未知 NODE_ENV 应抛错", () => {
    assert.throws(() => loadConfig({ NODE_ENV: "staging" }));
  });
});
