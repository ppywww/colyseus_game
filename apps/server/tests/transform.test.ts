/**
 * 玩家位置上报校验（sanitizeTransform）测试。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ARENA_RADIUS, type Aabb, type PlayerTransformMessage } from "@colyseus-fps/shared";

import {
  AIM_SNAPSHOT_TOLERANCE_RAD,
  FIRE_ORIGIN_MAX_DISTANCE,
  acceptAimSnapshot,
  acceptFireOrigin,
  overlapsObstacle,
  sanitizeTransform,
} from "../src/rooms/transform.js";

/** 一块 4×1.1×1 的矮墙（对应地图 A6，脚底可站上去）。 */
const CRATE: Aabb = { minX: -2, maxX: 2, minY: 0, maxY: 1.1, minZ: -0.5, maxZ: 0.5 };

function validMessage(overrides: Partial<PlayerTransformMessage> = {}): PlayerTransformMessage {
  return { seq: 1, x: 1, y: 0, z: -2, yaw: 0.5, pitch: -0.2, ...overrides };
}

describe("sanitizeTransform 合法消息", () => {
  it("应原样通过（yaw 归一化、seq 取整）", () => {
    const result = sanitizeTransform(validMessage());
    assert.deepEqual(result, { seq: 1, x: 1, y: 0, z: -2, yaw: 0.5, pitch: -0.2, crouch: false });
  });

  it("crouch 只接受布尔 true，其他值一律按站立处理", () => {
    assert.equal(sanitizeTransform(validMessage({ crouch: true }))?.crouch, true);
    assert.equal(sanitizeTransform(validMessage({ crouch: false }))?.crouch, false);
    // 不做隐式类型转换：字符串 "true" / 数字 1 都不能让判定体被压扁 37%
    const loose = sanitizeTransform({ ...validMessage(), crouch: "true" } as unknown);
    assert.equal(loose?.crouch, false);
    const numeric = sanitizeTransform({ ...validMessage(), crouch: 1 } as unknown);
    assert.equal(numeric?.crouch, false);
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

describe("overlapsObstacle（服务端障碍物校验）", () => {
  it("脚底中心落在 AABB 的 XZ 内且低于盒顶 → 视为非法", () => {
    assert.equal(overlapsObstacle(0, 0, 0, [CRATE]), true);
    assert.equal(overlapsObstacle(1.9, 0.4, -0.4, [CRATE]), true);
  });

  it("站在盒顶（footY ≥ maxY − 0.05，含 5cm 容差）→ 合法", () => {
    assert.equal(overlapsObstacle(0, 1.1, 0, [CRATE]), false);
    assert.equal(overlapsObstacle(0, 1.05, 0, [CRATE]), false);
    assert.equal(overlapsObstacle(0, 1.1 - 0.05, 0, [CRATE]), false, "容差边界内合法");
  });

  it("跳到盒子上方 → 合法", () => {
    assert.equal(overlapsObstacle(0, 1.28, 0, [CRATE]), false);
  });

  it("XZ 在盒外 → 合法（贴墙走不算穿模）", () => {
    assert.equal(overlapsObstacle(2.01, 0, 0, [CRATE]), false);
    assert.equal(overlapsObstacle(0, 0, 0.51, [CRATE]), false);
  });

  it("空障碍表永远合法", () => {
    assert.equal(overlapsObstacle(0, 0, 0, []), false);
  });
});

describe("acceptAimSnapshot（开火视角快照 25° 校验）", () => {
  const stored = { yaw: 0, pitch: 0 };

  it("缺失 / 非法 / 非有限数一律不采信", () => {
    assert.equal(acceptAimSnapshot(undefined, stored), null);
    assert.equal(acceptAimSnapshot({}, stored), null);
    assert.equal(acceptAimSnapshot({ yaw: NaN, pitch: 0 }, stored), null);
    assert.equal(acceptAimSnapshot({ yaw: 0, pitch: Infinity }, stored), null);
    assert.equal(acceptAimSnapshot("x", stored), null);
  });

  it("容差以内采信，并做过归一化 / 钳制", () => {
    const inside = acceptAimSnapshot({ yaw: 0.05, pitch: -0.05 }, stored);
    assert.ok(inside !== null);
    assert.ok(Math.abs(inside.yaw - 0.05) < 1e-9);
    assert.ok(Math.abs(inside.pitch + 0.05) < 1e-9);

    const wrapped = acceptAimSnapshot({ yaw: Math.PI * 2, pitch: 9 }, { yaw: 0, pitch: Math.PI / 2 });
    assert.ok(wrapped !== null, "yaw 回绕到 0、pitch 被钳到 π/2 后与已存值一致，应采信");
    assert.ok(Math.abs(wrapped.yaw) < 1e-9);
    assert.equal(wrapped.pitch, Math.PI / 2);
  });

  it("超过容差不采信（防瞬移视野爆头）", () => {
    const tooMuch = AIM_SNAPSHOT_TOLERANCE_RAD + 0.01;
    assert.equal(acceptAimSnapshot({ yaw: tooMuch, pitch: 0 }, stored), null);
    assert.equal(acceptAimSnapshot({ yaw: 0, pitch: -tooMuch }, stored), null);
    assert.equal(acceptAimSnapshot({ yaw: Math.PI, pitch: 0 }, stored), null);
  });

  it("负向回绕的小角度也应被正确测量（不因 ±π 边界误判）", () => {
    const nearPi = { yaw: Math.PI - 0.01, pitch: 0 };
    const wrapped = acceptAimSnapshot({ yaw: -Math.PI + 0.005, pitch: 0 }, nearPi);
    assert.ok(wrapped !== null, "相差 0.015 rad ≈ 0.86°，应采信");
  });
});

describe("acceptFireOrigin（开火位置快照）", () => {
  const stored = { x: 0, y: 0, z: 0 };

  it("缺失 / 非法 / 非有限数一律不采信（调用方回退已存位置）", () => {
    assert.equal(acceptFireOrigin(undefined, stored, []), null);
    assert.equal(acceptFireOrigin({}, stored, []), null);
    assert.equal(acceptFireOrigin({ x: 0, y: 0 }, stored, []), null);
    assert.equal(acceptFireOrigin({ x: NaN, y: 0, z: 0 }, stored, []), null);
    assert.equal(acceptFireOrigin("x", stored, []), null);
  });

  it("合理位移（一个 30Hz 上报周期内）必须采信", () => {
    // 5.5m/s 跑 33ms ≈ 0.18m；留足网络抖动，取 0.4m
    const result = acceptFireOrigin({ x: 0.32, y: 0, z: 0.24 }, stored, []);
    assert.deepEqual(result, { x: 0.32, y: 0, z: 0.24 });
  });

  it("跳得太远必须拒绝（防伪造坐标把射线搬到地图另一边）", () => {
    const tooFar = FIRE_ORIGIN_MAX_DISTANCE + 0.2;
    assert.equal(acceptFireOrigin({ x: tooFar, y: 0, z: 0 }, stored, []), null);
    assert.equal(acceptFireOrigin({ x: 0, y: 0, z: -tooFar }, stored, []), null);
  });

  it("正好卡在上限上应采信（闭区间），越一点点就拒绝", () => {
    assert.ok(acceptFireOrigin({ x: FIRE_ORIGIN_MAX_DISTANCE, y: 0, z: 0 }, stored, []) !== null);
    assert.equal(
      acceptFireOrigin({ x: FIRE_ORIGIN_MAX_DISTANCE + 1e-6, y: 0, z: 0 }, stored, []),
      null,
    );
  });

  it("落在掩体内部必须拒绝（防「把枪口塞进墙里打穿墙」）", () => {
    // CRATE: x ∈ [−2,2], y ∈ [0,1.1], z ∈ [−0.5,0.5]
    assert.equal(acceptFireOrigin({ x: 0, y: 0, z: 0 }, stored, [CRATE]), null);
    // 同一点、没有掩体时是合法的（对照）
    assert.ok(acceptFireOrigin({ x: 0, y: 0, z: 0 }, stored, []) !== null);
  });

  it("站在箱顶（脚底 = 箱高）算合法，不算嵌进去", () => {
    const result = acceptFireOrigin({ x: 0, y: 1.1, z: 0 }, stored, [CRATE]);
    assert.ok(result !== null, "脚底恰好在箱顶平面时是站上去，不是嵌进去");
  });

  it("超出可玩区或高度异常必须拒绝", () => {
    const outside = ARENA_RADIUS + 5;
    assert.equal(acceptFireOrigin({ x: outside, y: 0, z: 0 }, { x: outside - 0.1, y: 0, z: 0 }, []), null);
    assert.equal(acceptFireOrigin({ x: 0, y: -1, z: 0 }, stored, []), null);
    assert.equal(acceptFireOrigin({ x: 0, y: 50, z: 0 }, stored, []), null);
  });
});
