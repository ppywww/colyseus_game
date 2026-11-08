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
  SLOT_LABEL,
  SLOT_ORDER,
  SPAWN_POINTS,
  SWITCH_DURATION_MS,
  TEAM_SPAWN_COUNT,
  WEAPON_SLOTS,
  BASE_SENSITIVITY,
  PISTOL_COOLDOWN_MS,
  PISTOL_MAG_SIZE,
  PISTOL_RANGE,
  PISTOL_RESERVE_AMMO,
  SENSITIVITY_DEFAULT,
  SENSITIVITY_MAX,
  SENSITIVITY_MIN,
  SENSITIVITY_STEP,
  WEAPON_COOLDOWN_MS,
  WEAPON_MAG_SIZE,
  WEAPON_RANGE,
  clampPitch,
  clampSensitivity,
  fireProfileOf,
  formatSensitivity,
  isGunSlot,
  isSlotEnabled,
  nextSlot,
  normalizeYaw,
  parseSensitivity,
  serializeSensitivity,
  slotOfThrowable,
  switchDurationOf,
  teamSpawnPoints,
  throwableTypeOfSlot,
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

/* ------------------------------------------------------------------ *
 * S6：武器槽切换 + 手枪参数
 * ------------------------------------------------------------------ */

describe("武器槽可切性", () => {
  it("0..5 六个槽位都应可用，越界/非整数一律不可用", () => {
    for (const slot of SLOT_ORDER) {
      assert.equal(isSlotEnabled(slot), true, `槽位 ${slot} 应可用`);
    }
    assert.equal(isSlotEnabled(-1), false);
    assert.equal(isSlotEnabled(6), false);
    assert.equal(isSlotEnabled(1.5), false);
    assert.equal(isSlotEnabled(Number.NaN), false);
  });

  it("切枪时长：枪↔枪 350、近战 300、投掷物 250；非法槽位回退 350", () => {
    assert.equal(switchDurationOf(WEAPON_SLOTS.RIFLE), SWITCH_DURATION_MS[0]);
    assert.equal(switchDurationOf(WEAPON_SLOTS.KNIFE), 300);
    assert.equal(switchDurationOf(WEAPON_SLOTS.FRAG), 250);
    assert.equal(switchDurationOf(99), 350);
  });

  it("每个槽位都要有 HUD 图标文字", () => {
    for (const slot of SLOT_ORDER) {
      assert.ok(SLOT_LABEL[slot].length > 0, `槽位 ${slot} 缺少图标文字`);
    }
    assert.equal(SLOT_LABEL[0], "AK");
    assert.equal(SLOT_LABEL[1], "手枪");
    assert.equal(SLOT_LABEL[2], "刀");
  });
});

describe("nextSlot 环形切换", () => {
  const all = (): boolean => true;

  it("向后滚应 +1，从最后一格回到第一格（5 → 0）", () => {
    assert.equal(nextSlot(0, 1, all), 1);
    assert.equal(nextSlot(4, 1, all), 5);
    assert.equal(nextSlot(5, 1, all), 0);
  });

  it("向前滚应 −1，从第一格绕到最后一格（0 → 5）", () => {
    assert.equal(nextSlot(1, -1, all), 0);
    assert.equal(nextSlot(0, -1, all), 5);
  });

  it("应跳过不可用的槽位（数量为 0 的投掷物）", () => {
    // 0 → 1 不可用 → 2
    assert.equal(nextSlot(0, 1, (slot) => slot !== 1), 2);
    // 3 → 4/5 都空 → 绕回 0
    assert.equal(nextSlot(3, 1, (slot) => slot !== 4 && slot !== 5), 0);
  });

  it("整圈都不可用时应原地不动（不能把玩家甩到空槽上）", () => {
    assert.equal(nextSlot(2, 1, () => false), 2);
    assert.equal(nextSlot(4, -1, () => false), 4);
  });

  it("当前槽位自己不参与候选（不可用时也能走出去）", () => {
    assert.equal(nextSlot(3, 1, (slot) => slot === 0), 0);
  });

  it("非法起点应按 0 号槽位处理", () => {
    assert.equal(nextSlot(-5, 1, all), 1);
    assert.equal(nextSlot(Number.NaN, 1, all), 1);
  });
});

describe("手枪参数（槽位 1）", () => {
  it("弹药口径应为 12 / 36，且与步枪完全不同", () => {
    assert.equal(PISTOL_MAG_SIZE, 12);
    assert.equal(PISTOL_RESERVE_AMMO, 36);
    assert.notEqual(PISTOL_MAG_SIZE, WEAPON_MAG_SIZE);
    assert.notEqual(PISTOL_RESERVE_AMMO, 120);
  });

  it("射速应为步枪的一半（300ms vs 150ms），射程 35m < 步枪 60m", () => {
    assert.equal(PISTOL_COOLDOWN_MS, 300);
    assert.equal(PISTOL_COOLDOWN_MS, WEAPON_COOLDOWN_MS * 2);
    assert.equal(PISTOL_RANGE, 35);
    assert.ok(PISTOL_RANGE < WEAPON_RANGE);
  });

  it("只有 0 / 1 走弹道，刀与投掷物没有弹道参数", () => {
    assert.equal(isGunSlot(WEAPON_SLOTS.RIFLE), true);
    assert.equal(isGunSlot(WEAPON_SLOTS.PISTOL), true);
    for (const slot of [WEAPON_SLOTS.KNIFE, WEAPON_SLOTS.FRAG, WEAPON_SLOTS.FLASH, WEAPON_SLOTS.SMOKE]) {
      assert.equal(isGunSlot(slot), false, `槽位 ${slot} 不应走弹道`);
      assert.equal(fireProfileOf(slot), null, `槽位 ${slot} 不应有弹道参数`);
    }
  });

  it("弹道参数表的数值必须与共享常量同源", () => {
    const rifle = fireProfileOf(WEAPON_SLOTS.RIFLE);
    const pistol = fireProfileOf(WEAPON_SLOTS.PISTOL);
    assert.ok(rifle !== null && pistol !== null);
    assert.equal(rifle.cooldownMs, WEAPON_COOLDOWN_MS);
    assert.equal(rifle.range, WEAPON_RANGE);
    assert.equal(rifle.magSize, WEAPON_MAG_SIZE);
    assert.equal(pistol.cooldownMs, PISTOL_COOLDOWN_MS);
    assert.equal(pistol.range, PISTOL_RANGE);
    assert.equal(pistol.magSize, PISTOL_MAG_SIZE);
    assert.equal(pistol.reserveAmmo, PISTOL_RESERVE_AMMO);
  });
});

describe("投掷物 ↔ 槽位映射", () => {
  it("双向映射必须一致（sendThrow 用类型、切枪用槽位）", () => {
    for (const slot of [WEAPON_SLOTS.FRAG, WEAPON_SLOTS.FLASH, WEAPON_SLOTS.SMOKE]) {
      const type = throwableTypeOfSlot(slot);
      assert.ok(type !== null, `槽位 ${slot} 应映射到投掷物`);
      assert.equal(slotOfThrowable(type), slot);
    }
  });

  it("枪与刀没有对应的投掷物类型", () => {
    for (const slot of [WEAPON_SLOTS.RIFLE, WEAPON_SLOTS.PISTOL, WEAPON_SLOTS.KNIFE]) {
      assert.equal(throwableTypeOfSlot(slot), null);
    }
  });
});

/* ------------------------------------------------------------------ *
 * S6：灵敏度
 * ------------------------------------------------------------------ */

describe("灵敏度钳制 clampSensitivity", () => {
  it("低于下限应夹到 0.2，高于上限应夹到 3.0", () => {
    assert.equal(clampSensitivity(0.1), SENSITIVITY_MIN);
    assert.equal(clampSensitivity(0), SENSITIVITY_MIN);
    assert.equal(clampSensitivity(-5), SENSITIVITY_MIN);
    assert.equal(clampSensitivity(5), SENSITIVITY_MAX);
    assert.equal(clampSensitivity(1000), SENSITIVITY_MAX);
  });

  it("非法值一律回退默认 1.0", () => {
    assert.equal(clampSensitivity(Number.NaN), SENSITIVITY_DEFAULT);
    assert.equal(clampSensitivity(Number.POSITIVE_INFINITY), SENSITIVITY_DEFAULT);
    assert.equal(clampSensitivity("abc"), SENSITIVITY_DEFAULT);
    assert.equal(clampSensitivity(null), SENSITIVITY_DEFAULT);
    assert.equal(clampSensitivity(undefined), SENSITIVITY_DEFAULT);
    assert.equal(clampSensitivity({}), SENSITIVITY_DEFAULT);
  });

  it("必须对齐到 0.05 步进（且不留浮点尾巴）", () => {
    assert.equal(clampSensitivity(0.37), 0.35);
    assert.equal(clampSensitivity(1.0), 1);
    assert.equal(clampSensitivity(2.9999), 3);
    // 逐位比较：0.1 + 0.2 这类浮点误差不允许漏进设置
    assert.equal(String(clampSensitivity(0.30000000000000004)), "0.3");
  });

  it("步进常数本身应是 0.05，范围 0.2–3.0，默认 1.0", () => {
    assert.equal(SENSITIVITY_STEP, 0.05);
    assert.equal(SENSITIVITY_MIN, 0.2);
    assert.equal(SENSITIVITY_MAX, 3);
    assert.equal(SENSITIVITY_DEFAULT, 1);
  });
});

describe("灵敏度持久化", () => {
  it("合法 JSON 应被正确读出", () => {
    assert.equal(parseSensitivity('{"sensitivity":2.5}'), 2.5);
    assert.equal(parseSensitivity('{"sensitivity":0.35}'), 0.35);
    // 越界值读出来也要夹住
    assert.equal(parseSensitivity('{"sensitivity":9}'), SENSITIVITY_MAX);
  });

  it("缺失 / 非法 JSON / 结构不对 / 空值都应回退 1.0（不抛错）", () => {
    assert.equal(parseSensitivity(null), SENSITIVITY_DEFAULT);
    assert.equal(parseSensitivity(undefined), SENSITIVITY_DEFAULT);
    assert.equal(parseSensitivity(""), SENSITIVITY_DEFAULT);
    assert.equal(parseSensitivity("not json"), SENSITIVITY_DEFAULT);
    assert.equal(parseSensitivity("[]"), SENSITIVITY_DEFAULT);
    assert.equal(parseSensitivity("42"), SENSITIVITY_DEFAULT);
    assert.equal(parseSensitivity("{}"), SENSITIVITY_DEFAULT);
    assert.equal(parseSensitivity('{"sensitivity":"abc"}'), SENSITIVITY_DEFAULT);
  });

  it("序列化 → 解析应往返一致", () => {
    for (const value of [0.2, 0.75, 1, 1.55, 3]) {
      assert.equal(parseSensitivity(serializeSensitivity(value)), value);
    }
    // 序列化时也必须夹住越界值
    assert.equal(parseSensitivity(serializeSensitivity(9)), SENSITIVITY_MAX);
  });

  it("展示文案应固定两位小数", () => {
    assert.equal(formatSensitivity(1), "1.00");
    assert.equal(formatSensitivity(0.35), "0.35");
    assert.equal(formatSensitivity(3), "3.00");
  });
});

describe("默认灵敏度必须等于旧手感", () => {
  it("BASE_SENSITIVITY 应等于旧版写死的 0.0023", () => {
    assert.equal(BASE_SENSITIVITY, 0.0023);
  });

  it("灵敏度 1.0 时，每像素转角必须与旧版逐位相等", () => {
    const legacy = 0.0023; // 旧版 game.ts 的 LOOK_SENSITIVITY
    for (const movementX of [1, 7, 128, 1024, -333]) {
      assert.equal(movementX * BASE_SENSITIVITY * SENSITIVITY_DEFAULT, movementX * legacy);
    }
  });

  it("灵敏度是线性倍率：2.0 必须正好是 1.0 的两倍", () => {
    const one = 100 * BASE_SENSITIVITY * 1;
    const two = 100 * BASE_SENSITIVITY * 2;
    assert.equal(two, one * 2);
  });
});
