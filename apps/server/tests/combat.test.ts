import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { EYE_HEIGHT, WEAPON_RANGE, obstacleColliders } from "@colyseus-fps/shared";

import {
  computeShot,
  directionFromYawPitch,
  rayAabb,
  rayPlayerCylinder,
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

describe("rayPlayerCylinder", () => {
  it("正对胸口命中，距离为表面距离", () => {
    const target = { x: 0, y: 0, z: -5 };
    const t = rayPlayerCylinder(ORIGIN, { x: 0, y: 0, z: -1 }, target, 60);
    // 表面距离 = 5 - 半径 0.35
    assert.ok(t !== null && Math.abs(t - 4.65) < 1e-6);
  });

  it("瞄准头顶之上不命中", () => {
    const target = { x: 0, y: 0, z: -5 };
    const t = rayPlayerCylinder(ORIGIN, { x: 0, y: 1, z: -1 }, target, 60);
    assert.equal(t, null);
  });

  it("侧向偏移超过半径不命中", () => {
    const target = { x: 1, y: 0, z: -5 };
    const t = rayPlayerCylinder(ORIGIN, { x: 0, y: 0, z: -1 }, target, 60);
    assert.equal(t, null);
  });
});

describe("computeShot", () => {
  it("正对敌人命中并给出命中点", () => {
    const players = [makePlayer("A", 0, 0), makePlayer("B", 0, -5)];
    const shot = computeShot(players, "A", []);
    assert.ok(shot !== null);
    assert.equal(shot.hitPlayerId, "B");
    assert.ok(Math.abs(shot.hit.z + 4.65) < 1e-6);
  });

  it("死亡玩家不可开火、不可被命中", () => {
    const dead = { ...makePlayer("B", 0, -5), alive: false };
    assert.equal(computeShot([makePlayer("A", 0, 0), dead], "A", [])?.hitPlayerId, null);
    assert.equal(computeShot([dead], "B", []), null);
  });

  it("掩体挡住射线时不命中", () => {
    // 中心掩体位于 (0,0) 6×2.4×6，A 在 z=8 朝 -Z 打 z=-8 的 B
    const players = [makePlayer("A", 0, 8), makePlayer("B", 0, -8)];
    const shot = computeShot(players, "A", obstacleColliders());
    assert.ok(shot !== null);
    assert.equal(shot.hitPlayerId, null);
    // 弹道应止于掩体前表面 z=3
    assert.ok(Math.abs(shot.hit.z - 3) < 1e-6);
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
});
