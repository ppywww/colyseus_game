import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EYE_HEIGHT,
  WEAPON_RANGE,
  ZONE_DAMAGE,
  obstacleColliders,
} from "@colyseus-fps/shared";

import {
  computeShot,
  directionFromYawPitch,
  rayAabb,
  type CombatantView,
  type Vec3,
} from "../src/rooms/combat.js";

const ORIGIN: Vec3 = { x: 0, y: EYE_HEIGHT, z: 0 };

function makePlayer(id: string, x: number, z: number, yaw = 0): CombatantView {
  return { sessionId: id, x, y: 0, z, yaw, pitch: 0, alive: true };
}

describe("directionFromYawPitch", () => {
  it("yaw=0 朝 -Z", () => {
    const dir = directionFromYawPitch(0, 0);
    assert.ok(Math.abs(dir.x) < 1e-9);
    assert.ok(Math.abs(dir.z + 1) < 1e-9);
  });

  it("yaw=π/2 朝 -X；pitch>0 抬头", () => {
    const dir = directionFromYawPitch(Math.PI / 2, 0);
    assert.ok(Math.abs(dir.x + 1) < 1e-9);

    const up = directionFromYawPitch(0, Math.PI / 4);
    assert.ok(up.y > 0.7);
    assert.ok(up.z < 0);
  });
});

describe("rayAabb", () => {
  const box = { minX: -1, maxX: 1, minY: 0, maxY: 2, minZ: -6, maxZ: -4 };

  it("正面命中返回进入距离", () => {
    const t = rayAabb(ORIGIN, { x: 0, y: 0, z: -1 }, box, 60);
    assert.ok(t !== null && Math.abs(t - 4) < 1e-9);
  });

  it("偏离箱体返回 null；超出 maxT 返回 null", () => {
    assert.equal(rayAabb(ORIGIN, { x: 1, y: 0, z: 0 }, box, 60), null);
    assert.equal(rayAabb(ORIGIN, { x: 0, y: 0, z: -1 }, box, 3), null);
  });
});

describe("computeShot", () => {
  it("正对敌人命中头部（眼高水平射击 = 头部判定区）并给出命中点", () => {
    const players = [makePlayer("A", 0, 0), makePlayer("B", 0, -5)];
    const shot = computeShot(players, "A", []);
    assert.ok(shot !== null);
    assert.equal(shot.hitPlayerId, "B");
    assert.equal(shot.hitZone, "head");
    assert.equal(shot.damage, ZONE_DAMAGE.head);
    // 头部圆柱半径 0.14 → 表面距离 5 − 0.14
    assert.ok(Math.abs(shot.hit.z + 4.86) < 1e-6, `命中点 z 应 −4.86，实际 ${shot.hit.z}`);
  });

  it("死亡玩家不可开火、不可被命中", () => {
    const dead = { ...makePlayer("B", 0, -5), alive: false };
    assert.equal(computeShot([makePlayer("A", 0, 0), dead], "A", [])?.hitPlayerId, null);
    assert.equal(computeShot([dead], "B", []), null);
  });

  it("掩体挡住射线时不命中", () => {
    // 显式给一块 6×2.4×6 的掩体（旧版这里读真实地图的中心箱）；
    // 地图改版后 64 个体块的相对位置会变，本用例只校验"射线-AABB 求交"这件事本身。
    const centerBox = { minX: -3, maxX: 3, minY: 0, maxY: 2.4, minZ: -3, maxZ: 3 };
    const players = [makePlayer("A", 0, 8), makePlayer("B", 0, -8)];
    const shot = computeShot(players, "A", [centerBox]);
    assert.ok(shot !== null);
    assert.equal(shot.hitPlayerId, null);
    assert.equal(shot.hitZone, null);
    assert.equal(shot.damage, 0);
    // 弹道应止于掩体前表面 z=3
    assert.ok(Math.abs(shot.hit.z - 3) < 1e-6);
  });

  it("真实地图回归：中路东墙（W8b）挡住 x 方向的子弹", () => {
    // 真实地图：W8b 位于 x 4…6、z 0…8、高 4m，正好横在 (0,4) → (9,4) 这条 +X 枪线上。
    // 这条用例吃的是 shared 的 OBSTACLES 数据，地图一旦被改动（墙挪位/矮到 1.6m 以下）会立刻失败。
    const players = [makePlayer("A", 0, 4, -Math.PI / 2), makePlayer("B", 9, 4)];
    const shot = computeShot(players, "A", obstacleColliders());
    assert.ok(shot !== null);
    assert.equal(shot.hitPlayerId, null, "墙后的目标不应被命中");
    // 弹道应止于 W8b 的西表面 x = 4
    assert.ok(Math.abs(shot.hit.x - 4) < 0.05, `弹道应止于墙前 x≈4，实际 ${shot.hit.x.toFixed(2)}`);
    assert.ok(Math.abs(shot.hit.z - 4) < 1e-6);
  });

  it("真实地图回归：中路空走廊内 10m 对枪应命中（无墙遮挡）", () => {
    // 真实地图：x −4…4、z −11…8 是中路空走廊（W6x/W8x 在 |x| ≥ 4，M1/M5 都在 z < −7）
    const players = [makePlayer("A", -1.5, 7, 0), makePlayer("B", -1.5, -3)];
    const shot = computeShot(players, "A", obstacleColliders());
    assert.ok(shot !== null);
    assert.equal(shot.hitPlayerId, "B", "空走廊内应命中目标");
    // 眼高水平射击打在头部圆柱表面：z = −3 + 0.14
    assert.ok(Math.abs(shot.hit.z - (-3 + 0.14)) < 1e-6, `命中点 z 应约 −2.86，实际 ${shot.hit.z}`);
  });

  it("多名敌人时命中最近的一个", () => {
    const players = [makePlayer("A", 0, 0), makePlayer("B", 0, -10), makePlayer("C", 0, -5)];
    const shot = computeShot(players, "A", []);
    assert.equal(shot?.hitPlayerId, "C");
  });

  it("超出射程不命中", () => {
    const players = [makePlayer("A", 0, 0), makePlayer("B", 0, -(WEAPON_RANGE + 5))];
    const shot = computeShot(players, "A", []);
    assert.equal(shot?.hitPlayerId, null);
  });

  it("弹道字段应包含 rayOrigin / dir / hitZone / damage / weaponSlot（协议 v2）", () => {
    const players = [makePlayer("A", 0, 0), makePlayer("B", 0, -5)];
    const shot = computeShot(players, "A", []);
    assert.ok(shot !== null);
    assert.equal(typeof shot.rayOrigin.x, "number");
    assert.equal(typeof shot.dir.z, "number");
    assert.equal(typeof shot.weaponSlot, "number");
    // 枪口必然与判定起点不同（否则又会画出"从屏幕正中射出"的弹道）
    const offset: number = Math.hypot(
      shot.origin.x - shot.rayOrigin.x,
      shot.origin.y - shot.rayOrigin.y,
      shot.origin.z - shot.rayOrigin.z,
    );
    assert.ok(offset > 0.3, `枪口与眼睛的距离应 > 0.3m，实际 ${offset.toFixed(3)}`);
  });
});
