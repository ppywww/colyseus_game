/**
 * 服务端权威扩散测试。
 *
 * 这一组守的是「准星与判定同源」的最后一环：
 *   - 扩散**只改方向、不改起点**（否则"打偏"会变成"从别处开枪"，贴墙时会打到另一面墙）；
 *   - 偏移量必须精确等于 `tan(半角)`，否则 30m 处的落点和标称扩散对不上；
 *   - 同一颗种子必须逐位复现，否则 QA 无法断言、争议弹道无法回放。
 *
 * 历史背景：上一轮"弹道不对"的根因之一，就是客户端准星在抖、服务端射线是零扩散——
 * 准星画的是一套，判定走的是另一套。本文件就是为了让这种漂移不可能再发生。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { spreadHalfAngleDeg, fireProfileOf, type SpreadSample } from "@colyseus-fps/shared";

import { computeShot, directionFromYawPitch, type CombatantView, type Vec3 } from "../src/rooms/combat.js";

function player(overrides: Partial<CombatantView> = {}): CombatantView {
  return {
    sessionId: "A",
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    pitch: 0,
    alive: true,
    weaponSlot: 0,
    ...overrides,
  };
}

/** 两个单位向量的夹角（度）。 */
function angleBetweenDeg(a: Vec3, b: Vec3): number {
  const dot = a.x * b.x + a.y * b.y + a.z * b.z;
  return (Math.acos(Math.min(1, Math.max(-1, dot))) * 180) / Math.PI;
}

describe("computeShot 的扩散采样", () => {
  it("不传扩散时方向不变、spreadDeg = 0（旧行为完全保留）", () => {
    const shot = computeShot([player()], "A", []);
    assert.ok(shot !== null);
    const expected: Vec3 = directionFromYawPitch(0, 0);
    assert.ok(angleBetweenDeg(shot.dir, expected) < 1e-9);
    assert.equal(shot.spreadDeg, 0);
  });

  it("采样为圆心时方向不变，但仍然记录本次半角", () => {
    const centered: SpreadSample = { x: 0, y: 0, halfAngleDeg: 2.6 };
    const shot = computeShot([player()], "A", [], undefined, 60, null, centered);
    assert.ok(shot !== null);
    assert.ok(angleBetweenDeg(shot.dir, directionFromYawPitch(0, 0)) < 1e-9);
    assert.equal(shot.spreadDeg, 2.6);
  });

  it("偏移量为 1 时，实际夹角必须精确等于半角（不是小角近似）", () => {
    const halfAngleDeg = 2.6;
    const edge: SpreadSample = { x: 1, y: 0, halfAngleDeg };
    const shot = computeShot([player()], "A", [], undefined, 60, null, edge);
    assert.ok(shot !== null);
    const actual: number = angleBetweenDeg(shot.dir, directionFromYawPitch(0, 0));
    assert.ok(Math.abs(actual - halfAngleDeg) < 1e-6, `实际夹角 ${actual}° 应等于半角 ${halfAngleDeg}°`);
  });

  it("扩散只改方向、不改判定起点（枪口跟着枪管微移，但起点绝不能动）", () => {
    const plain = computeShot([player()], "A", []);
    const spread = computeShot([player()], "A", [], undefined, 60, null, {
      x: 0.6,
      y: -0.8,
      halfAngleDeg: 1.3,
    });
    assert.ok(plain !== null);
    assert.ok(spread !== null);
    // 判定起点是"眼睛"，必须一字不差——否则贴墙时会从墙里开枪
    assert.deepEqual(spread.rayOrigin, plain.rayOrigin);
    // 视觉枪口由 `dir` 推导（枪管朝哪、枪口就在哪），所以会跟着偏，
    // 但偏移量必须远小于枪身长度（MUZZLE_OFFSET 总计约 0.5m）
    const shift = Math.hypot(
      spread.origin.x - plain.origin.x,
      spread.origin.y - plain.origin.y,
      spread.origin.z - plain.origin.z,
    );
    assert.ok(shift < 0.02, `枪口偏移 ${shift.toFixed(3)}m 过大，说明扩散被错误地施加到了位置上`);
  });

  it("方向必须是单位向量（客户端拿它画 Tracer，长度不为 1 会画出错误的线段）", () => {
    const shot = computeShot([player({ yaw: 0.9, pitch: -0.2 })], "A", [], undefined, 60, null, {
      x: -0.3,
      y: 0.9,
      halfAngleDeg: 2,
    });
    assert.ok(shot !== null);
    const length = Math.hypot(shot.dir.x, shot.dir.y, shot.dir.z);
    assert.ok(Math.abs(length - 1) < 1e-9, `|dir| = ${length} 应为 1`);
  });

  it("扩散能在 30m 处把一发从「打空」变成「命中」（真的按 tan 换算，不是只转了零点几度）", () => {
    const halfAngleDeg = 2.6;
    // 30m 处 tan(2.6°) × 30 = 1.36m。把敌人放在 +1.3m 侧向：
    // 不扩散时射线在 x=0 掠过（胸半径 0.27 → 完全打空），向右偏满则命中。
    const enemy: CombatantView = player({ sessionId: "B", x: 1.3, z: -30 });
    const miss = computeShot([player(), enemy], "A", []);
    const hit = computeShot([player(), enemy], "A", [], undefined, 60, null, {
      x: 1,
      y: 0,
      halfAngleDeg,
    });
    assert.ok(miss !== null);
    assert.ok(hit !== null);
    assert.equal(miss.hitPlayerId, null, "不扩散时应打空（x=1.3 超出胸口 0.27m）");
    assert.equal(hit.hitPlayerId, "B", "向右偏 1.36m 后应命中");
  });

  it("扩散取自武器参数表：第 1 发与第 11 发的圆锥半径必须差一个量级", () => {
    const profile = fireProfileOf(0);
    assert.ok(profile !== null);
    const first: number = spreadHalfAngleDeg(profile, 0);
    const capped: number = spreadHalfAngleDeg(profile, 10);
    assert.ok(Math.abs(first - 0.2) < 1e-9);
    assert.ok(Math.abs(capped - 2.6) < 1e-9);
    // 30m 处半径：0.105m vs 1.36m
    const firstRadius: number = 30 * Math.tan((first * Math.PI) / 180);
    const cappedRadius: number = 30 * Math.tan((capped * Math.PI) / 180);
    assert.ok(cappedRadius > firstRadius * 10);
  });
});
