/**
 * 弹着面测试：法向、地面、打空、以及开火位置快照对判定起点的影响。
 *
 * 这一组守的是「画面与判定一致」的最后一段：
 *   - 客户端要拿 `hitNormal` 铺弹孔，法向错了弹孔就浮空/埋墙；
 *   - 地面不是 AABB（它是渲染层的一个平面），不单独判定的话朝下开枪会穿地；
 *   - 位置快照决定移动中开枪的起点，起点错了 Tracer 就不从枪口出来。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { EYE_HEIGHT, type Aabb } from "@colyseus-fps/shared";

import { computeShot, rayAabbHit, type CombatantView } from "../src/rooms/combat.js";

function shooter(overrides: Partial<CombatantView> = {}): CombatantView {
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

/** 一面位于 z = −4、覆盖 y ∈ [0, 3] 的墙（玩家在原点朝 −Z 看，正对它）。 */
const WALL: Aabb = { minX: -5, maxX: 5, minY: 0, maxY: 3, minZ: -4.2, maxZ: -4 };

describe("rayAabbHit（进入面法向）", () => {
  it("从 +Z 方向射向墙：法向必须是 +Z（指向射线来的一侧）", () => {
    const hit = rayAabbHit({ x: 0, y: 1.5, z: 0 }, { x: 0, y: 0, z: -1 }, WALL, 100);
    assert.ok(hit !== null);
    assert.equal(hit.t, 4);
    assert.deepEqual(hit.normal, { x: 0, y: 0, z: 1 });
  });

  it("从 −Z 方向射向墙：法向必须是 −Z", () => {
    const hit = rayAabbHit({ x: 0, y: 1.5, z: -10 }, { x: 0, y: 0, z: 1 }, WALL, 100);
    assert.ok(hit !== null);
    assert.deepEqual(hit.normal, { x: 0, y: 0, z: -1 });
  });

  it("从上方垂直砸向箱顶：法向必须是 +Y", () => {
    const box: Aabb = { minX: -1, maxX: 1, minY: 0, maxY: 1.5, minZ: -1, maxZ: 1 };
    const hit = rayAabbHit({ x: 0, y: 5, z: 0 }, { x: 0, y: -1, z: 0 }, box, 100);
    assert.ok(hit !== null);
    assert.deepEqual(hit.normal, { x: 0, y: 1, z: 0 });
  });

  it("从侧面砸向箱体：法向是侧面，不是顶面", () => {
    const box: Aabb = { minX: -1, maxX: 1, minY: 0, maxY: 3, minZ: -1, maxZ: 1 };
    const hit = rayAabbHit({ x: -8, y: 1.5, z: 0 }, { x: 1, y: 0, z: 0 }, box, 100);
    assert.ok(hit !== null);
    assert.deepEqual(hit.normal, { x: -1, y: 0, z: 0 });
  });

  it("不相交返回 null", () => {
    assert.equal(rayAabbHit({ x: 0, y: 5, z: 0 }, { x: 0, y: 0, z: -1 }, WALL, 100), null);
  });
});

describe("computeShot 的弹着面", () => {
  it("打墙：hitSurface = wall，hitNormal 是墙面法向", () => {
    const shot = computeShot([shooter()], "A", [WALL]);
    assert.ok(shot !== null);
    assert.equal(shot.hitSurface, "wall");
    assert.equal(shot.hitPlayerId, null);
    assert.deepEqual(shot.hitNormal, { x: 0, y: 0, z: 1 });
    // 眼睛高 1.6m、水平视线，墙面在 z = −4 → 命中点 (0, 1.6, −4)
    assert.ok(Math.abs(shot.hit.z + 4) < 1e-9);
  });

  it("打地面：hitSurface = wall，法向 (0,1,0)，命中点 y≈0", () => {
    // 俯角 0.4 rad（约 23°），从 1.6m 高看向地面
    const shot = computeShot([shooter({ pitch: -0.4 })], "A", []);
    assert.ok(shot !== null);
    assert.equal(shot.hitSurface, "wall");
    assert.deepEqual(shot.hitNormal, { x: 0, y: 1, z: 0 });
    assert.ok(Math.abs(shot.hit.y) < 1e-9, `命中点应在 y=0，实际 ${shot.hit.y}`);
    // 水平距离 = 1.6 / tan(0.4) ≈ 3.69m
    assert.ok(Math.abs(shot.hit.z + 1.6 / Math.tan(0.4)) < 1e-6);
  });

  it("抬头打天空（射程尽头）：hitSurface = none，没有法向", () => {
    const shot = computeShot([shooter({ pitch: 0.3 })], "A", []);
    assert.ok(shot !== null);
    assert.equal(shot.hitSurface, "none");
    assert.equal(shot.hitNormal, null);
  });

  it("掩体比地面更近时，取掩体（法向是墙不是地）", () => {
    // 把墙放低到 y ∈ [0, 0.5]，俯角射击会先撞墙
    const lowWall: Aabb = { minX: -5, maxX: 5, minY: 0, maxY: 0.5, minZ: -2, maxZ: -1.8 };
    const shot = computeShot([shooter({ pitch: -0.6 })], "A", [lowWall]);
    assert.ok(shot !== null);
    assert.equal(shot.hitSurface, "wall");
    assert.deepEqual(shot.hitNormal, { x: 0, y: 0, z: 1 });
  });

  it("命中玩家时不返回法向（客户端画血雾，不画弹孔）", () => {
    const enemy: CombatantView = shooter({ sessionId: "B", z: -3 });
    const shot = computeShot([shooter(), enemy], "A", []);
    assert.ok(shot !== null);
    assert.equal(shot.hitSurface, "player");
    assert.equal(shot.hitNormal, null);
    assert.ok(shot.hitPlayerId === "B");
  });
});

describe("computeShot 的开火位置快照", () => {
  it("不传快照时用服务端保存的位置（旧行为不变）", () => {
    const shot = computeShot([shooter()], "A", []);
    assert.ok(shot !== null);
    assert.deepEqual(shot.rayOrigin, { x: 0, y: EYE_HEIGHT, z: 0 });
  });

  it("传快照时射线起点必须跟着走（修「移动时子弹不从枪口出」）", () => {
    // 服务端存的是 z=0，客户端说"我开枪那一刻在 z=0.5"（全速奔跑 90ms 的位移量级）
    const shot = computeShot([shooter()], "A", [], undefined, 60, { x: 0, y: 0, z: 0.5 });
    assert.ok(shot !== null);
    assert.deepEqual(shot.rayOrigin, { x: 0, y: EYE_HEIGHT, z: 0.5 });
    assert.ok(
      Math.abs(shot.hit.z + (60 - 0.5)) < 1e-9,
      "打空时终点也要从快照起点量起，否则 Tracer 长度会错",
    );
  });

  it("快照只影响自己的起点，不影响其他玩家的判定", () => {
    const enemy: CombatantView = shooter({ sessionId: "B", z: -3 });
    // 从 z=0.5 朝 −Z 打 3m 外的敌人：命中距离应是 3.5 而不是 3
    const shot = computeShot([shooter(), enemy], "A", [], undefined, 60, { x: 0, y: 0, z: 0.5 });
    assert.ok(shot !== null);
    assert.equal(shot.hitPlayerId, "B");
    assert.ok(Math.abs(shot.hit.z + 3) < 0.3, `命中点应在敌人身上（z≈−3），实际 ${shot.hit.z}`);
  });
});
