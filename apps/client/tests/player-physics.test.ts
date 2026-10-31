/**
 * 本地玩家移动物理测试。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_PHYSICS,
  stepPlayer,
  type Aabb,
  type MoveInput,
  type PlayerKinematics,
} from "../src/game/player-physics.js";

const NO_INPUT: MoveInput = {
  forward: false,
  backward: false,
  left: false,
  right: false,
  sprint: false,
  jump: false,
};

function spawn(): PlayerKinematics {
  return { x: 0, y: 0, z: 0, vy: 0, yaw: 0, pitch: 0, grounded: true };
}

describe("stepPlayer 移动", () => {
  it("yaw=0 前进应向 -Z 移动", () => {
    const k = spawn();
    for (let i = 0; i < 5; i++) {
      stepPlayer(k, { ...NO_INPUT, forward: true }, 0.1, []);
    }
    assert.ok(Math.abs(k.x) < 1e-9);
    assert.ok(k.z < -1, `期望向 -Z 移动，实际 z=${k.z}`);
  });

  it("yaw=π/2 前进应向 -X 移动", () => {
    const k = spawn();
    k.yaw = Math.PI / 2;
    for (let i = 0; i < 5; i++) {
      stepPlayer(k, { ...NO_INPUT, forward: true }, 0.1, []);
    }
    assert.ok(k.x < -1, `期望向 -X 移动，实际 x=${k.x}`);
    assert.ok(Math.abs(k.z) < 1e-6);
  });

  it("冲刺速度应快于步行", () => {
    const walk = spawn();
    const run = spawn();
    stepPlayer(walk, { ...NO_INPUT, forward: true }, 1, []);
    stepPlayer(run, { ...NO_INPUT, forward: true, sprint: true }, 1, []);
    assert.ok(Math.abs(run.z) > Math.abs(walk.z) * 1.3);
  });

  it("跳跃后应落回地面", () => {
    const k = spawn();
    stepPlayer(k, { ...NO_INPUT, jump: true }, 0.016, []);
    assert.ok(k.vy > 0);
    assert.equal(k.grounded, false);

    for (let i = 0; i < 120; i++) {
      stepPlayer(k, NO_INPUT, 1 / 60, []);
    }
    assert.equal(k.y, 0);
    assert.equal(k.grounded, true);
  });

  it("超出场地边界应被钳制", () => {
    const k = spawn();
    k.x = DEFAULT_PHYSICS.arenaRadius * 2;
    stepPlayer(k, NO_INPUT, 0.016, []);
    assert.ok(Math.abs(k.x) <= DEFAULT_PHYSICS.arenaRadius);
  });
});

describe("stepPlayer 碰撞", () => {
  const box: Aabb = { minX: -1, maxX: 1, minY: 0, maxY: 2, minZ: -5, maxZ: -3 };

  it("正面撞上箱体应被挡下", () => {
    const k = spawn();
    k.z = 0;
    stepPlayer(k, { ...NO_INPUT, forward: true }, 2, [box]);
    // 玩家半径 0.35，极限 z = box.maxZ + 0.35
    assert.ok(k.z >= box.maxZ - 0.01, `期望被挡在箱体前，实际 z=${k.z}`);
  });

  it("矮箱可站上（垂直推出视为落地）", () => {
    const lowBox: Aabb = { minX: -1, maxX: 1, minY: 0, maxY: 0.5, minZ: -3, maxZ: -1 };
    const k = spawn();
    k.z = -1.3;
    k.vy = -0.1;
    stepPlayer(k, NO_INPUT, 0.016, [lowBox]);
    assert.ok(k.y >= 0.49, `期望站上箱顶，实际 y=${k.y}`);
    assert.equal(k.grounded, true);
  });
});
