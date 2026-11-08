/**
 * 本地玩家移动物理测试。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MAP_BOUNDS, PLAYER_HEIGHT, PLAYER_HIT_RADIUS } from "@colyseus-fps/shared";

import {
  CONTACT_EPS,
  DEFAULT_PHYSICS,
  MAX_SUBSTEP,
  STEP_HEIGHT,
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

describe("物理默认值与共享常数一致", () => {
  it("DEFAULT_PHYSICS.bounds 必须等于 shared 的 MAP_BOUNDS（单一真相，防止两处漂移）", () => {
    // deepEqual 同时锁住了四个边界值：任何一侧被改动（含改 shared）都会红
    assert.deepEqual(DEFAULT_PHYSICS.bounds, MAP_BOUNDS);
  });
});

describe("物理常量约束（文档 7.1 / 7.3）", () => {
  it("玩家半径必须与 shared 的 PLAYER_HIT_RADIUS 相等（客户端与服务端同口径）", () => {
    assert.equal(DEFAULT_PHYSICS.playerRadius, PLAYER_HIT_RADIUS);
    assert.equal(DEFAULT_PHYSICS.playerHeight, PLAYER_HEIGHT);
  });

  it("单片位移必须小于玩家半径（否则薄墙会隧穿）", () => {
    assert.ok(MAX_SUBSTEP < DEFAULT_PHYSICS.playerRadius, `MAX_SUBSTEP=${MAX_SUBSTEP} 必须 < 0.35`);
  });

  it("台阶高度 0.35m 必须小于最矮的可跳箱（0.9m），不能替代跳跃", () => {
    assert.equal(STEP_HEIGHT, 0.35);
    assert.ok(STEP_HEIGHT < 0.9);
  });
});

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

  it("超出场地边界应被钳制（矩形可玩区）", () => {
    const k = spawn();
    k.x = DEFAULT_PHYSICS.bounds.maxX * 2;
    stepPlayer(k, NO_INPUT, 0.016, []);
    assert.ok(Math.abs(k.x) <= DEFAULT_PHYSICS.bounds.maxX);
  });

  it("矩形边界：走到地图四角应贴住外墙，而不是被拽向中心", () => {
    const k = spawn();
    k.x = DEFAULT_PHYSICS.bounds.maxX + 5;
    k.z = DEFAULT_PHYSICS.bounds.maxZ + 5;
    stepPlayer(k, NO_INPUT, 0.016, []);

    const limitX = DEFAULT_PHYSICS.bounds.maxX - DEFAULT_PHYSICS.playerRadius;
    const limitZ = DEFAULT_PHYSICS.bounds.maxZ - DEFAULT_PHYSICS.playerRadius;
    assert.ok(Math.abs(k.x - limitX) < 1e-6, `期望 x 贴住外墙 ${limitX}，实际 ${k.x}`);
    assert.ok(Math.abs(k.z - limitZ) < 1e-6, `期望 z 贴住外墙 ${limitZ}，实际 ${k.z}`);
    // 圆形钳制会把 (35,35) 拉回到半径 29.65 的圆弧上（约 21m），这里必须仍是 29.65/29.65
    assert.ok(Math.hypot(k.x, k.z) > 40, `角落不应被拽向中心，实际半径 ${Math.hypot(k.x, k.z)}`);
  });

  it("逐轴钳制：单轴越界不影响另一轴", () => {
    const k = spawn();
    k.x = -DEFAULT_PHYSICS.bounds.maxX * 3;
    k.z = 12;
    stepPlayer(k, NO_INPUT, 0.016, []);
    assert.ok(Math.abs(k.x + (DEFAULT_PHYSICS.bounds.maxX - DEFAULT_PHYSICS.playerRadius)) < 1e-6);
    assert.ok(Math.abs(k.z - 12) < 1e-6, "z 不应被边界影响");
  });
});

describe("stepPlayer 碰撞（文档 7.3 验收 6 条）", () => {
  const RADIUS = DEFAULT_PHYSICS.playerRadius;
  const EPS = CONTACT_EPS;

  /** 逐帧推进（60fps），最多 maxFrames 帧，返回期间记录的最大 y。 */
  function run(
    k: PlayerKinematics,
    input: MoveInput,
    colliders: readonly Aabb[],
    frames: number,
    options = DEFAULT_PHYSICS,
  ): number {
    let maxY = k.y;
    for (let i = 0; i < frames; i += 1) {
      stepPlayer(k, input, 1 / 60, colliders, options);
      maxY = Math.max(maxY, k.y);
    }
    return maxY;
  }

  /** 玩家足迹是否与盒体真重叠（用于"不穿模"的断言）。 */
  function overlaps(k: PlayerKinematics, box: Aabb): boolean {
    return (
      k.x + RADIUS > box.minX + 1e-6 &&
      k.x - RADIUS < box.maxX - 1e-6 &&
      k.z + RADIUS > box.minZ + 1e-6 &&
      k.z - RADIUS < box.maxZ - 1e-6 &&
      k.y < box.maxY - 0.02
    );
  }

  const WALL: Aabb = { minX: -2, maxX: 2, minY: 0, maxY: 4, minZ: -2, maxZ: 2 };

  it("① 从 +X 侧贴墙：停在 maxX + 0.35 + EPS（1mm 级贴合，不穿透）", () => {
    const k = spawn();
    k.x = 6;
    k.yaw = Math.PI / 2; // 前进 = −X
    run(k, { ...NO_INPUT, forward: true }, [WALL], 120);
    const expected = WALL.maxX + RADIUS + EPS;
    assert.ok(Math.abs(k.x - expected) < 1e-6, `期望 x=${expected}，实际 ${k.x}`);
    assert.equal(overlaps(k, WALL), false, "不得停在墙里");
  });

  it("①b 从 −X 侧贴墙：停在 minX − 0.35 − EPS", () => {
    const k = spawn();
    k.x = -6;
    k.yaw = -Math.PI / 2; // 前进 = +X
    run(k, { ...NO_INPUT, forward: true }, [WALL], 120);
    const expected = WALL.minX - RADIUS - EPS;
    assert.ok(Math.abs(k.x - expected) < 1e-6, `期望 x=${expected}，实际 ${k.x}`);
    assert.equal(overlaps(k, WALL), false);
  });

  it("② 2.0m 高箱：连跳也上不去（旧版垂直推出会把人顶上去）", () => {
    const tallBox: Aabb = { minX: -1.2, maxX: 1.2, minY: 0, maxY: 2.0, minZ: -1.2, maxZ: 1.2 };
    const k = spawn();
    k.z = 2.0; // 箱子南侧，前进 = −Z
    const maxY = run(k, { ...NO_INPUT, forward: true, jump: true }, [tallBox], 240);
    const apex = (DEFAULT_PHYSICS.jumpSpeed ** 2) / (2 * DEFAULT_PHYSICS.gravity);
    assert.ok(maxY <= apex + 0.02, `最大高度 ${maxY.toFixed(3)} 不应超过跳跃 apex ${apex.toFixed(3)}`);
    assert.ok(maxY < 2.0, "绝不能站到 2.0m 箱顶");
    assert.equal(k.y, 0, "最终应落回地面");
    assert.equal(overlaps(k, tallBox), false, "不得被推进箱体");
  });

  it("③ 1.1m 矮箱：跳上去能站住且不抖", () => {
    const lowBox: Aabb = { minX: -1.2, maxX: 1.2, minY: 0, maxY: 1.1, minZ: -1.2, maxZ: 1.2 };
    const k = spawn();
    k.z = 2.0;
    // 起跳 + 前进 20 帧，然后松手让重力把它吸到箱顶
    for (let i = 0; i < 20; i += 1) {
      stepPlayer(k, { ...NO_INPUT, forward: true, jump: i === 0 }, 1 / 60, [lowBox]);
    }
    run(k, NO_INPUT, [lowBox], 60);
    assert.ok(Math.abs(k.y - 1.1) < 1e-9, `应站在 1.1m 箱顶，实际 y=${k.y}`);
    assert.equal(k.grounded, true);
    // 站住后再跑 120 帧，y 不得抖动
    for (let i = 0; i < 120; i += 1) {
      stepPlayer(k, NO_INPUT, 1 / 60, [lowBox]);
      assert.ok(Math.abs(k.y - 1.1) < 1e-9, `第 ${i} 帧 y 抖到 ${k.y}`);
    }
  });

  it("④ 箱-墙夹角左右横移：不抖动、不落进任何 AABB", () => {
    const boxes: Aabb[] = [
      { minX: -2, maxX: 2, minY: 0, maxY: 2.4, minZ: -2, maxZ: 2 },
      { minX: 2, maxX: 4, minY: 0, maxY: 2.4, minZ: -2, maxZ: 2 },
    ];
    const k = spawn();
    k.x = -4;
    k.yaw = Math.PI / 2; // 先向 −X 前进 → 其实是远离，改用右移贴墙
    // 从西侧贴住第一个箱子的 −X 面
    k.yaw = Math.PI / 2;
    k.x = -2 - RADIUS - EPS;
    // 3 秒横移：左右交替（yaw=0 时 left/right 是 ±X，这里用 strafe 沿 Z 走）
    for (let i = 0; i < 180; i += 1) {
      const right = Math.floor(i / 15) % 2 === 0;
      stepPlayer(k, { ...NO_INPUT, left: !right, right }, 1 / 60, boxes);
      for (const box of boxes) {
        assert.equal(overlaps(k, box), false, `第 ${i} 帧掉进盒体`);
      }
      assert.ok(Math.abs(k.x - (-2 - RADIUS - EPS)) < 1e-3, `第 ${i} 帧 x 抖到 ${k.x}`);
    }
  });

  it("⑤ 单帧位移 5m（异常大位移）不穿过 0.6m 薄墙", () => {
    const thinWall: Aabb = { minX: -0.3, maxX: 0.3, minY: 0, maxY: 4, minZ: -5, maxZ: 5 };
    const fast = { ...DEFAULT_PHYSICS, sprintSpeed: 50 };
    const k = spawn();
    k.x = 3;
    k.z = 0;
    k.yaw = Math.PI / 2; // 前进 = −X，单帧 5m
    stepPlayer(k, { ...NO_INPUT, forward: true, sprint: true }, 0.1, [thinWall], fast);
    const expected = thinWall.maxX + RADIUS + EPS;
    assert.ok(Math.abs(k.x - expected) < 1e-6, `应停在墙前 x=${expected}，实际 ${k.x}`);
    assert.equal(overlaps(k, thinWall), false, "不得穿墙");
  });

  it("⑥ 从箱顶走下：不被横向推开，正常坠落", () => {
    const box: Aabb = { minX: -2, maxX: 2, minY: 0, maxY: 1.1, minZ: -2, maxZ: 2 };
    const k = spawn();
    k.y = 1.1;
    k.grounded = true;
    k.yaw = -Math.PI / 2; // 前进 = +X
    let lastX = k.x;
    for (let i = 0; i < 120; i += 1) {
      stepPlayer(k, { ...NO_INPUT, forward: true }, 1 / 60, [box]);
      assert.ok(k.x >= lastX - 1e-9, `第 ${i} 帧 x 被回推：${lastX} → ${k.x}`);
      lastX = k.x;
    }
    assert.ok(k.x > box.maxX + RADIUS, `应走出箱顶范围，实际 x=${k.x}`);
    assert.equal(k.y, 0, "应已落地");
  });

  it("⑦ 站在盒顶时盒子不再横向挡路（可自由行走）", () => {
    const box: Aabb = { minX: -2, maxX: 2, minY: 0, maxY: 1.1, minZ: -2, maxZ: 2 };
    const k = spawn();
    k.y = 1.1;
    k.grounded = true;
    k.yaw = 0;
    // 只走 12 帧（约 1m），仍在箱顶范围内
    for (let i = 0; i < 12; i += 1) {
      stepPlayer(k, { ...NO_INPUT, forward: true }, 1 / 60, [box]);
    }
    assert.ok(Math.abs(k.y - 1.1) < 1e-9, `在箱顶上走不应下沉/弹起，实际 y=${k.y}`);
    assert.ok(k.z < -0.8, `箱顶上应能自由前进，实际 z=${k.z}`);
    assert.equal(k.grounded, true);
  });

  it("⑧ 从侧下方走进箱底不会被抬升（旧版会「顶」上去）", () => {
    const box: Aabb = { minX: -1, maxX: 1, minY: 0, maxY: 1.5, minZ: -1, maxZ: 1 };
    const k = spawn();
    k.y = 0.6; // 卡在箱体高度中间（模拟贴墙跳起时的瞬时状态）
    k.vy = -2;
    stepPlayer(k, NO_INPUT, 1 / 60, [box]);
    assert.ok(k.y < 0.7, `不应被抬到箱顶，实际 y=${k.y}`);
  });
});

