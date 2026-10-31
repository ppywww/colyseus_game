/**
 * 玩家位置上报校验（sanitizeTransform）测试。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ARENA_RADIUS, type PlayerTransformMessage } from "@colyseus-fps/shared";

import { sanitizeTransform } from "../src/rooms/transform.js";

function validMessage(overrides: Partial<PlayerTransformMessage> = {}): PlayerTransformMessage {
  return { seq: 1, x: 1, y: 0, z: -2, yaw: 0.5, pitch: -0.2, ...overrides };
}

describe("sanitizeTransform 合法消息", () => {
  it("应原样通过（yaw 归一化、seq 取整）", () => {
    const result = sanitizeTransform(validMessage());
    assert.deepEqual(result, { seq: 1, x: 1, y: 0, z: -2, yaw: 0.5, pitch: -0.2 });
  });

  it("越界坐标应被钳制到场地内", () => {
    const result = sanitizeTransform(validMessage({ x: 9999, z: -9999 }));
    assert.equal(result?.x, ARENA_RADIUS);
    assert.equal(result?.z, -ARENA_RADIUS);
  });

  it("负 y 应被钳制到 0，超高应被钳制到上限", () => {
    assert.equal(sanitizeTransform(validMessage({ y: -5 }))?.y, 0);
    assert.equal(sanitizeTransform(validMessage({ y: 999 }))?.y, 10);
  });

  it("yaw 超过 π 应归一化", () => {
    const result = sanitizeTransform(validMessage({ yaw: Math.PI * 2 + 0.3 }));
    assert.ok(Math.abs((result?.yaw ?? 0) - 0.3) < 1e-6);
  });

  it("pitch 应被钳制到 ±π/2", () => {
    assert.equal(sanitizeTransform(validMessage({ pitch: 5 }))?.pitch, Math.PI / 2);
    assert.equal(sanitizeTransform(validMessage({ pitch: -5 }))?.pitch, -Math.PI / 2);
  });

  it("seq 应向下取整且不为负", () => {
    assert.equal(sanitizeTransform(validMessage({ seq: 3.9 }))?.seq, 3);
    assert.equal(sanitizeTransform(validMessage({ seq: -2 }))?.seq, 0);
  });
});

describe("sanitizeTransform 非法消息", () => {
  it("非对象消息应返回 null", () => {
    assert.equal(sanitizeTransform(null), null);
    assert.equal(sanitizeTransform("x"), null);
    assert.equal(sanitizeTransform(42), null);
  });

  it("缺失字段应返回 null", () => {
    assert.equal(sanitizeTransform({ seq: 1, x: 0, y: 0 }), null);
  });

  it("非有限数（NaN / Infinity）应返回 null", () => {
    assert.equal(sanitizeTransform(validMessage({ x: NaN })), null);
    assert.equal(sanitizeTransform(validMessage({ yaw: Infinity })), null);
  });
});
