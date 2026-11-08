/**
 * shared 层常量与类型测试。
 *
 * 目的：
 *   1. 保证被前后端共同依赖的常量不会在重构中被静默改坏；
 *   2. 让 `pnpm test` 真正覆盖 shared 包，而不是被 pnpm -r 静默跳过。
 *
 * 本包只依赖 Node 内置测试运行器，不引入任何测试框架。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ARENA_RADIUS,
  CLIENT_INTERPOLATION_DELAY_MS,
  GAME_TICK_INTERVAL_MS,
  GAME_TICK_RATE,
  MAX_MESSAGES_PER_SECOND,
  MAX_PLAYERS_PER_ROOM,
  MELEE_ARC,
  MELEE_COOLDOWN_MS,
  MELEE_DAMAGE_BACK,
  MELEE_DAMAGE_FRONT,
  MELEE_RANGE,
  MUZZLE_OFFSET,
  PLAYER_TRANSFORM_RATE_HZ,
  PROJECT_NAME,
  PROTOCOL_VERSION,
  SLOT_ENABLED,
  SLOT_ORDER,
  SPAWN_POINTS,
  SWITCH_DURATION_MS,
  TEAM_SPAWN_COUNT,
  WEAPON_SLOTS,
  clampPitch,
  normalizeYaw,
  teamSpawnPoints,
} from "../src/index.js";

describe("时间与频率常量", () => {
  it("逻辑帧率应为 20Hz", () => {
    assert.equal(GAME_TICK_RATE, 20);
  });

  it("帧间隔应由帧率推导得出（1000 / 20 = 50ms）", () => {
    assert.equal(GAME_TICK_INTERVAL_MS, 50);
    assert.equal(GAME_TICK_INTERVAL_MS, 1000 / GAME_TICK_RATE);
  });

  it("客户端插值延迟应不小于一个帧间隔，且不超过 500ms", () => {
    assert.ok(
      CLIENT_INTERPOLATION_DELAY_MS >= GAME_TICK_INTERVAL_MS,
      "插值延迟小于帧间隔会导致远端实体抖动",
    );
    assert.ok(CLIENT_INTERPOLATION_DELAY_MS <= 500);
  });
});

describe("房间与协议常量", () => {
  it("房间人数上限应为 2 ~ 64 之间", () => {
    assert.ok(MAX_PLAYERS_PER_ROOM >= 2);
    assert.ok(MAX_PLAYERS_PER_ROOM <= 64);
  });

  it("每秒消息上限应为正数", () => {
    assert.ok(MAX_MESSAGES_PER_SECOND > 0);
  });

  it("协议版本应为 2（v2：分区伤害 + 武器槽 + 弹道字段扩展）", () => {
    assert.equal(PROTOCOL_VERSION, 2);
    assert.ok(Number.isInteger(PROTOCOL_VERSION));
  });

  it("项目名称应为非空字符串", () => {
    assert.equal(typeof PROJECT_NAME, "string");
    assert.ok(PROJECT_NAME.length > 0);
  });
});

describe("S2 位置同步常量", () => {
  it("场地半径应为正数", () => {
    assert.ok(ARENA_RADIUS > 0);
  });

  it("上报频率应为正数且不高于逻辑帧率的 2 倍", () => {
    assert.ok(PLAYER_TRANSFORM_RATE_HZ > 0);
    assert.ok(PLAYER_TRANSFORM_RATE_HZ <= GAME_TICK_RATE * 2);
  });
});

describe("S5 体验优化常量（协议 v2）", () => {
  it("房间人数应为 8（4v4），与每队 4 个出生点一一对应", () => {
    assert.equal(MAX_PLAYERS_PER_ROOM, 8);
    assert.equal(TEAM_SPAWN_COUNT, 4);
    assert.equal(MAX_PLAYERS_PER_ROOM, TEAM_SPAWN_COUNT * 2);
  });

  it("视角上报应提到 30Hz，且限流阈值高于它（否则上报会被自己限流）", () => {
    assert.equal(PLAYER_TRANSFORM_RATE_HZ, 30);
    assert.ok(MAX_MESSAGES_PER_SECOND > PLAYER_TRANSFORM_RATE_HZ, "限流阈值必须高于上报频率");
    assert.equal(MAX_MESSAGES_PER_SECOND, 45);
  });

  it("每队随机出生点应取该队前 4 条，且朝向正确", () => {
    const tSide = teamSpawnPoints("T");
    const ctSide = teamSpawnPoints("CT");
    assert.equal(tSide.length, 4);
    assert.equal(ctSide.length, 4);
    for (const point of tSide) {
      assert.equal(point.team, "T");
      assert.equal(point.yaw, 0, "T 出生应面向 −Z");
    }
    for (const point of ctSide) {
      assert.equal(point.team, "CT");
      assert.ok(Math.abs(point.yaw) === Math.PI, "CT 出生应面向 +Z");
    }
    // 数据仍保留 10 条（客户端 spawnYawFor 依赖全表）
    assert.equal(SPAWN_POINTS.length, 10);
  });

  it("武器槽位表应为 0..5，顺序表与之一致", () => {
    assert.deepEqual(SLOT_ORDER, [0, 1, 2, 3, 4, 5]);
    assert.equal(WEAPON_SLOTS.RIFLE, 0);
    assert.equal(WEAPON_SLOTS.PISTOL, 1);
    assert.equal(WEAPON_SLOTS.KNIFE, 2);
    assert.equal(WEAPON_SLOTS.SMOKE, 5);
    for (const slot of SLOT_ORDER) {
      assert.ok(SWITCH_DURATION_MS[slot] > 0);
      assert.equal(SLOT_ENABLED[slot], true, "本期 6 个槽位全部可用（手枪也做）");
    }
  });

  it("枪口偏移应只向前 + 右 + 下，不得为负的 forward", () => {
    assert.ok(MUZZLE_OFFSET.forward > 0);
    assert.ok(MUZZLE_OFFSET.right > 0);
    assert.ok(MUZZLE_OFFSET.down > 0);
  });

  it("小刀数值应为 55 / 100 / 2.0m / 650ms / 70°", () => {
    assert.equal(MELEE_DAMAGE_FRONT, 55);
    assert.equal(MELEE_DAMAGE_BACK, 100);
    assert.equal(MELEE_RANGE, 2.0);
    assert.equal(MELEE_COOLDOWN_MS, 650);
    assert.ok(Math.abs(MELEE_ARC - (35 * Math.PI) / 180) < 1e-9);
  });
});

describe("角度工具函数", () => {
  it("normalizeYaw 应归一化到 (-π, π]", () => {
    assert.ok(normalizeYaw(Math.PI * 3) <= Math.PI);
    assert.ok(normalizeYaw(-Math.PI * 3) > -Math.PI);
    assert.equal(normalizeYaw(0), 0);
    assert.ok(Math.abs(normalizeYaw(Math.PI * 2.5) - (Math.PI * 0.5)) < 1e-9);
  });

  it("clampPitch 应限制在 ±π/2 内", () => {
    assert.equal(clampPitch(10), Math.PI / 2);
    assert.equal(clampPitch(-10), -Math.PI / 2);
    assert.equal(clampPitch(0.3), 0.3);
  });
});
