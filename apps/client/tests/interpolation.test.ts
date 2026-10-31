/**
 * 远端玩家插值缓冲测试。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { InterpolationBuffer, lerpAngle, type TransformSample } from "../src/game/interpolation.js";

function sample(t: number, overrides: Partial<TransformSample> = {}): TransformSample {
  return { t, x: t, y: 0, z: 0, yaw: 0, pitch: 0, ...overrides };
}

describe("lerpAngle", () => {
  it("应走最短弧（±π 边界不回绕）", () => {
    const result = lerpAngle(Math.PI - 0.1, -Math.PI + 0.1, 0.5);
    // 期望接近 π（或 -π，同角度），而不是 0
    assert.ok(Math.abs(Math.abs(result) - Math.PI) < 1e-6, `实际 ${result}`);
  });

  it("普通角度应线性插值", () => {
    assert.ok(Math.abs(lerpAngle(0, 1, 0.5) - 0.5) < 1e-9);
  });
});

describe("InterpolationBuffer", () => {
  it("空缓冲应返回 null", () => {
    const buffer = new InterpolationBuffer(100);
    assert.equal(buffer.sample(1000), null);
  });

  it("单样本应原样返回", () => {
    const buffer = new InterpolationBuffer(100);
    buffer.push(sample(500, { x: 7, yaw: 0.3 }));
    const result = buffer.sample(1000);
    assert.equal(result?.x, 7);
    assert.equal(result?.yaw, 0.3);
  });

  it("两样本之间应按比例插值", () => {
    const buffer = new InterpolationBuffer(100);
    buffer.push(sample(0, { x: 0 }));
    buffer.push(sample(100, { x: 10 }));
    const result = buffer.sample(150); // 目标时刻 50
    assert.equal(result?.x, 5);
  });

  it("目标早于首个样本应钳制到首样本（不做外推）", () => {
    const buffer = new InterpolationBuffer(100);
    buffer.push(sample(500, { x: 1 }));
    buffer.push(sample(600, { x: 2 }));
    const result = buffer.sample(550); // 目标 450 < 500
    assert.equal(result?.x, 1);
  });

  it("目标晚于最新样本应回退到最新样本（不做外推）", () => {
    const buffer = new InterpolationBuffer(100);
    buffer.push(sample(0, { x: 1 }));
    buffer.push(sample(100, { x: 2 }));
    const result = buffer.sample(5000);
    assert.equal(result?.x, 2);
  });

  it("乱序样本应被丢弃", () => {
    const buffer = new InterpolationBuffer(100);
    buffer.push(sample(200, { x: 2 }));
    buffer.push(sample(100, { x: 1 }));
    assert.equal(buffer.size(), 1);
  });

  it("超出容量应丢弃最旧样本", () => {
    const buffer = new InterpolationBuffer(100, 4);
    for (let i = 0; i < 6; i++) {
      buffer.push(sample(i * 100, { x: i }));
    }
    assert.equal(buffer.size(), 4);
    assert.equal(buffer.newest()?.x, 5);
  });
});
