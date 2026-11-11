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
  FIRE_MODES,
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
  AK_SPRAY_PATTERN,
  clampPitch,
  clampSensitivity,
  fireProfileOf,
  formatSensitivity,
  isGunSlot,
  isSlotEnabled,
  nextSlot,
  normalizeYaw,
  parseSensitivity,
  recoilDeltaOf,
  serializeSensitivity,
  slotOfThrowable,
  spreadHalfAngleDeg,
  spreadToPixels,
  sampleSpread,
  hashString,
  mixShotSeed,
  switchDurationOf,
  teamSpawnPoints,
  throwableTypeOfSlot,
  CROSSHAIR_COLORS,
  CROSSHAIR_DEFAULT,
  CROSSHAIR_DEFAULT_COLOR,
  CROSSHAIR_GAP_DEFAULT,
  CROSSHAIR_GAP_MAX,
  CROSSHAIR_GAP_MIN,
  CROSSHAIR_LENGTH_MAX,
  CROSSHAIR_THICKNESS_MAX,
  CROSSHAIR_THICKNESS_MIN,
  clampCrosshair,
  clampCrosshairColor,
  parseSettings,
  serializeSettings,
  CHARACTER_COUNT,
  CHARACTER_DEFAULT,
  CHARACTER_IDS,
  MAP_ZONES,
  THROWABLES,
  characterIndexOf,
  characterOfIndex,
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

  it("视角上报 30Hz 时，限流阈值必须留出全自动开火的余量", () => {
    assert.equal(PLAYER_TRANSFORM_RATE_HZ, 30);
    assert.ok(MAX_MESSAGES_PER_SECOND > PLAYER_TRANSFORM_RATE_HZ, "限流阈值必须高于上报频率");
    // AK 全自动 600 RPM = 10 发/秒，叠加 30Hz 上报已经是 40/s；45 的阈值会让换弹/切枪
    // 那几帧的合法包被静默丢弃（表现为"打着打着没反应"），所以必须提到 60。
    assert.equal(MAX_MESSAGES_PER_SECOND, 60);
    const akShotsPerSecond: number = 1000 / WEAPON_COOLDOWN_MS;
    assert.ok(
      MAX_MESSAGES_PER_SECOND - PLAYER_TRANSFORM_RATE_HZ >= akShotsPerSecond + 10,
      "留出的余量要够 AK 全自动开火再叠 10 条/秒的换弹切枪",
    );
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
    // 猫和老鼠主题：六个槽位全部是玩具/厨具，不允许出现真实枪械名
    assert.equal(SLOT_LABEL[0], "高压水枪");
    assert.equal(SLOT_LABEL[1], "橡皮筋枪");
    assert.equal(SLOT_LABEL[2], "餐叉");
    assert.equal(SLOT_LABEL[3], "平底锅");
    assert.equal(SLOT_LABEL[4], "胡椒瓶");
    assert.equal(SLOT_LABEL[5], "面粉袋");
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

  it("手枪应是半自动、比步枪慢、射程更短", () => {
    // 170ms（≈353 RPM）对齐 USP-S 量级；AK 是 100ms（600 RPM 全自动）
    assert.equal(PISTOL_COOLDOWN_MS, 170);
    assert.ok(PISTOL_COOLDOWN_MS > WEAPON_COOLDOWN_MS, "手枪必须比步枪慢");
    assert.equal(WEAPON_COOLDOWN_MS, 100);
    assert.equal(PISTOL_RANGE, 35);
    assert.ok(PISTOL_RANGE < WEAPON_RANGE);
  });

  it("开火模式必须区分：长枪全自动、手枪半自动", () => {
    assert.equal(fireProfileOf(WEAPON_SLOTS.RIFLE)?.fireMode, FIRE_MODES.AUTO);
    assert.equal(fireProfileOf(WEAPON_SLOTS.PISTOL)?.fireMode, FIRE_MODES.SEMI);
    // 刀与投掷物没有开火模式（不走弹道）
    assert.equal(fireProfileOf(WEAPON_SLOTS.KNIFE), null);
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
 * 主题层：猫和老鼠
 * ------------------------------------------------------------------ */

describe("角色常量（纯外观）", () => {
  it("四个角色，默认是 tom，下标与数组顺序一致", () => {
    assert.equal(CHARACTER_IDS.length, 4);
    assert.equal(CHARACTER_COUNT, CHARACTER_IDS.length);
    assert.equal(CHARACTER_DEFAULT, "tom");
    assert.equal(CHARACTER_IDS.indexOf(CHARACTER_DEFAULT), 0);
    // 不允许重名（否则索引会静默指向第一个）
    assert.equal(new Set(CHARACTER_IDS).size, CHARACTER_IDS.length);
  });

  it("characterIndexOf 把数字钳制在合法区间内", () => {
    assert.equal(characterIndexOf(0), 0);
    assert.equal(characterIndexOf(3), 3);
    // 越界钳制而不是回退默认：否则最后一个角色永远选不上
    assert.equal(characterIndexOf(99), CHARACTER_COUNT - 1);
    assert.equal(characterIndexOf(-5), 0);
    // 小数截断
    assert.equal(characterIndexOf(2.9), 2);
    // NaN / Infinity 不是有限数 → 回退默认
    assert.equal(characterIndexOf(Number.NaN), CHARACTER_IDS.indexOf(CHARACTER_DEFAULT));
    assert.equal(characterIndexOf(Number.POSITIVE_INFINITY), CHARACTER_IDS.indexOf(CHARACTER_DEFAULT));
  });

  it("characterIndexOf 接受字符串（大小写 / 空格容错），非法值回退默认", () => {
    assert.equal(characterIndexOf("jerry"), 1);
    assert.equal(characterIndexOf("  SPIKE  "), 2);
    assert.equal(characterIndexOf("butch"), 3);
    assert.equal(characterIndexOf("daffy"), CHARACTER_IDS.indexOf(CHARACTER_DEFAULT));
    assert.equal(characterIndexOf(""), CHARACTER_IDS.indexOf(CHARACTER_DEFAULT));
    // 非字符串非数字（含数组、null、对象）一律回退，不能静默变成 0 之外的怪值
    assert.equal(characterIndexOf([]), CHARACTER_IDS.indexOf(CHARACTER_DEFAULT));
    assert.equal(characterIndexOf(null), CHARACTER_IDS.indexOf(CHARACTER_DEFAULT));
    assert.equal(characterIndexOf(undefined), CHARACTER_IDS.indexOf(CHARACTER_DEFAULT));
    assert.equal(characterIndexOf({}), CHARACTER_IDS.indexOf(CHARACTER_DEFAULT));
  });

  it("characterOfIndex 永不返回 undefined（服务端直接赋值给 uint8）", () => {
    for (const index of [-10, 0, 1, 2, 3, 77, 2.5]) {
      const id = characterOfIndex(index);
      assert.ok(CHARACTER_IDS.includes(id), `下标 ${index} 得到了非法角色 ${id}`);
    }
    assert.equal(characterOfIndex(1), "jerry");
  });
});

describe("投掷物换皮为厨房道具", () => {
  it("三种投掷物全部是厨具，且名称不重复、颜色可区分", () => {
    const labels = Object.values(THROWABLES).map((config) => config.label);
    assert.deepEqual(labels, ["平底锅", "胡椒瓶", "面粉袋"]);
    assert.equal(new Set(labels).size, labels.length);
    const colors = Object.values(THROWABLES).map((config) => config.color);
    assert.equal(new Set(colors).size, colors.length, "三件道具的颜色必须能分开");
  });

  it("换皮不改手感：引信与半径仍是原数值", () => {
    assert.equal(THROWABLES.frag.fuseMs, 2200);
    assert.equal(THROWABLES.frag.radius, 9.5);
    assert.equal(THROWABLES.frag.maxDamage, 100);
    assert.equal(THROWABLES.flash.fuseMs, 1600);
    assert.equal(THROWABLES.flash.radius, 16);
    assert.equal(THROWABLES.flash.maxBlindMs, 3200);
    assert.equal(THROWABLES.smoke.fuseMs, 1400);
    assert.equal(THROWABLES.smoke.radius, 7);
    assert.equal(THROWABLES.smoke.cloudDurationMs, 16000);
  });
});

describe("地图分区（只改中文名，id 是契约）", () => {
  it("分区 id 一个都不能变（小地图标签、可达性测试、下包判定都靠它）", () => {
    const expected: readonly string[] = [
      "site_a",
      "site_b",
      "spawn_t",
      "spawn_ct",
      "long_a",
      "outside_long",
      "short_a",
      "catwalk",
      "ct_mid",
      "mid",
      "b_doors",
      "tunnels",
      "lower_tunnel",
      "ct_to_b",
      "ct_to_a",
    ];
    assert.deepEqual(MAP_ZONES.map((zone) => zone.id), expected);
  });

  it("每个分区都有互不重复的中文名（厨房语义）", () => {
    const labels = MAP_ZONES.map((zone) => zone.label);
    assert.equal(new Set(labels).size, labels.length, "分区中文名不能重复，否则小地图无法区分");
    for (const label of labels) {
      assert.ok(/^[\u4e00-\u9fa5]+$/.test(label), `${label} 应为纯中文`);
    }
    // 两个包点、两个出生点必须点题
    assert.equal(MAP_ZONES.find((zone) => zone.id === "site_a")?.label, "灶台");
    assert.equal(MAP_ZONES.find((zone) => zone.id === "site_b")?.label, "水槽");
    assert.equal(MAP_ZONES.find((zone) => zone.id === "spawn_t")?.label, "鼠洞");
    assert.equal(MAP_ZONES.find((zone) => zone.id === "spawn_ct")?.label, "猫窝");
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

/* ------------------------------------------------------------------ *
 * S6.1：准星外观（纯表现，可调可存盘）
 * ------------------------------------------------------------------ */

describe("准星设置钳制 clampCrosshair", () => {
  it("默认值必须是一份自洽的合法设置", () => {
    assert.deepEqual(clampCrosshair(CROSSHAIR_DEFAULT), CROSSHAIR_DEFAULT);
    assert.match(CROSSHAIR_DEFAULT.color, /^#[0-9a-f]{6}$/);
    assert.equal(CROSSHAIR_DEFAULT.gap, CROSSHAIR_GAP_DEFAULT);
    assert.ok(CROSSHAIR_DEFAULT.thickness >= CROSSHAIR_THICKNESS_MIN);
    assert.ok(CROSSHAIR_DEFAULT.thickness <= CROSSHAIR_THICKNESS_MAX);
    assert.ok(CROSSHAIR_DEFAULT.gap >= CROSSHAIR_GAP_MIN);
    assert.ok(CROSSHAIR_DEFAULT.gap <= CROSSHAIR_GAP_MAX);
  });

  it("非对象 / null / 字符串输入一律回退默认（不抛错）", () => {
    for (const raw of [null, undefined, 42, "green", [], true]) {
      assert.deepEqual(clampCrosshair(raw), CROSSHAIR_DEFAULT);
    }
  });

  it("越界尺寸被夹住，不是整包丢弃", () => {
    const huge = clampCrosshair({ ...CROSSHAIR_DEFAULT, length: 999, thickness: 0, gap: -3 });
    assert.equal(huge.length, CROSSHAIR_LENGTH_MAX);
    assert.equal(huge.thickness, CROSSHAIR_THICKNESS_MIN);
    assert.equal(huge.gap, CROSSHAIR_GAP_MIN);
    // 没被改动的字段必须原样保留
    assert.equal(huge.color, CROSSHAIR_DEFAULT.color);
  });

  it("逐字段降级：坏字段只修自己，好字段保留", () => {
    const mixed = clampCrosshair({
      color: "#12AB34",
      length: "8",
      thickness: "粗",
      gap: 6,
      dot: true,
      outline: "yes",
      dynamic: false,
    });
    assert.equal(mixed.color, "#12ab34", "颜色统一小写");
    assert.equal(mixed.length, 8, "数字字符串应收敛成数字");
    assert.equal(mixed.thickness, CROSSHAIR_DEFAULT.thickness, "非法值只回退这一个字段");
    assert.equal(mixed.gap, 6);
    assert.equal(mixed.dot, true);
    assert.equal(mixed.outline, CROSSHAIR_DEFAULT.outline);
    assert.equal(mixed.dynamic, false);
  });

  it("颜色只接受 #rrggbb，其它一律回默认色", () => {
    assert.equal(clampCrosshairColor("#FF0000"), "#ff0000");
    assert.equal(clampCrosshairColor("red"), CROSSHAIR_DEFAULT_COLOR);
    assert.equal(clampCrosshairColor("#f00"), CROSSHAIR_DEFAULT_COLOR);
    assert.equal(clampCrosshairColor("#gg0000"), CROSSHAIR_DEFAULT_COLOR);
    assert.equal(clampCrosshairColor(null), CROSSHAIR_DEFAULT_COLOR);
    // 预设色板里的每个颜色都必须本身合法
    for (const color of CROSSHAIR_COLORS) {
      assert.equal(clampCrosshairColor(color), color);
    }
  });

  it("小数尺寸应取整到像素", () => {
    assert.equal(clampCrosshair({ ...CROSSHAIR_DEFAULT, gap: 4.6 }).gap, 5);
    assert.equal(clampCrosshair({ ...CROSSHAIR_DEFAULT, length: 5.2 }).length, 5);
  });
});

describe("整包设置持久化（灵敏度 + 准星）", () => {
  it("只存了灵敏度的旧记录必须能读，准星用默认值补上", () => {
    const parsed = parseSettings('{"sensitivity":1.85}');
    assert.equal(parsed.sensitivity, 1.85);
    assert.deepEqual(parsed.crosshair, CROSSHAIR_DEFAULT);
  });

  it("只存了准星的记录必须能读，灵敏度回默认", () => {
    const parsed = parseSettings('{"crosshair":{"color":"#00ff00","gap":7}}');
    assert.equal(parsed.sensitivity, SENSITIVITY_DEFAULT);
    assert.equal(parsed.crosshair.color, "#00ff00");
    assert.equal(parsed.crosshair.gap, 7);
    assert.equal(parsed.crosshair.thickness, CROSSHAIR_DEFAULT.thickness);
  });

  it("空 / 非法 JSON / 非对象一律回全默认（不抛错、不清数据）", () => {
    for (const raw of [null, undefined, "", "not json", "42", "[]"]) {
      const parsed = parseSettings(raw);
      assert.equal(parsed.sensitivity, SENSITIVITY_DEFAULT);
      assert.deepEqual(parsed.crosshair, CROSSHAIR_DEFAULT);
    }
  });

  it("序列化 → 解析应往返一致（含越界输入的钳制）", () => {
    const settings = {
      sensitivity: 1.35,
      crosshair: { ...CROSSHAIR_DEFAULT, color: "#38bdf8", gap: 9, dot: true, dynamic: false },
    };
    const roundTrip = parseSettings(serializeSettings(settings));
    assert.equal(roundTrip.sensitivity, 1.35);
    assert.deepEqual(roundTrip.crosshair, settings.crosshair);

    const clamped = parseSettings(serializeSettings({ sensitivity: 99, crosshair: { ...CROSSHAIR_DEFAULT, gap: 999 } }));
    assert.equal(clamped.sensitivity, SENSITIVITY_MAX);
    assert.equal(clamped.crosshair.gap, CROSSHAIR_GAP_MAX);
  });

  it("序列化后的 JSON 必须同时带两个字段（新版结构）", () => {
    const raw = serializeSettings({ sensitivity: 1.2, crosshair: CROSSHAIR_DEFAULT });
    const parsed = JSON.parse(raw) as { sensitivity: number; crosshair: Record<string, unknown> };
    assert.equal(parsed.sensitivity, 1.2);
    assert.equal(parsed.crosshair.gap, CROSSHAIR_GAP_DEFAULT);
    assert.equal(typeof parsed.crosshair.color, "string");
  });
});

describe("默认灵敏度必须等于旧手感", () => {  it("BASE_SENSITIVITY 应等于旧版写死的 0.0023", () => {
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

describe("后坐力：喷弹形与冲量方向", () => {
  const ak = fireProfileOf(0);
  const pistol = fireProfileOf(1);

  it("AK 必须有 30 发喷弹形，手枪没有（半自动靠单发随机）", () => {
    assert.ok(ak !== null);
    assert.ok(pistol !== null);
    assert.equal(ak.sprayPattern.length, 30);
    assert.equal(AK_SPRAY_PATTERN.length, 30);
    assert.equal(pistol.sprayPattern.length, 0);
  });

  it("第一发必须几乎不偏（表头 = 原点），否则「点射第一发」就没有意义", () => {
    const head = AK_SPRAY_PATTERN[0];
    assert.ok(head !== undefined);
    assert.equal(head.x, 0);
    assert.equal(head.y, 0);
  });

  it("连发累计偏移必须严格等于表里第 N 格（图案可练习、可复现）", () => {
    assert.ok(ak !== null);
    let pitch = 0;
    let yaw = 0;
    let index = 0;
    for (let shot = 0; shot < 30; shot += 1) {
      const delta = recoilDeltaOf(ak, index);
      // 方向约定：pitchDeg 正 = 抬头，调用方按 `pitch += pitchDeg` 施加
      pitch += delta.pitchDeg;
      yaw += delta.yawDeg;
      index = delta.nextIndex;

      // 第 N 发打完之后，累计偏移必须等于表里第 N 格（表头是"未开火"状态）
      const expected = AK_SPRAY_PATTERN[Math.min(shot + 1, AK_SPRAY_PATTERN.length - 1)];
      assert.ok(expected !== undefined, `第 ${shot + 1} 发应有表项`);
      assert.ok(
        Math.abs(pitch - expected.y) < 1e-9,
        `第 ${shot + 1} 发垂直累计 ${pitch} 应等于表值 ${expected.y}`,
      );
      assert.ok(
        Math.abs(yaw - expected.x) < 1e-9,
        `第 ${shot + 1} 发水平累计 ${yaw} 应等于表值 ${expected.x}`,
      );
    }
  });

  it("每一发都必须向上（后坐力绝不能把枪口压下去）", () => {
    assert.ok(ak !== null);
    let index = 0;
    for (let shot = 0; shot < 30; shot += 1) {
      const delta = recoilDeltaOf(ak, index);
      assert.ok(delta.pitchDeg >= 0, `第 ${shot + 1} 发上抬量不能为负（实际 ${delta.pitchDeg}）`);
      index = delta.nextIndex;
    }
  });

  it("30 发总上抬应落在 14°–22°（太小学不到，太大不可压）", () => {
    const last = AK_SPRAY_PATTERN[AK_SPRAY_PATTERN.length - 1];
    assert.ok(last !== undefined);
    assert.ok(last.y >= 14 && last.y <= 22, `总上抬 ${last.y}° 超出可玩区间`);
  });

  it("前 5 发必须近乎纯垂直（横向摆幅 ≤ 0.5°），这是 AK 的辨识度", () => {
    for (let i = 0; i < 5; i += 1) {
      const step = AK_SPRAY_PATTERN[i];
      assert.ok(step !== undefined);
      assert.ok(Math.abs(step.x) <= 0.5, `第 ${i + 1} 发横向偏移 ${step.x}° 过大`);
    }
  });

  it("横向必须真的左右摆（曾有实现退化成白噪声/单侧漂移）", () => {
    const xs = AK_SPRAY_PATTERN.map((step) => step.x);
    const min = Math.min(...xs);
    const max = Math.max(...xs);
    assert.ok(min < -2, `向左摆幅不足（min=${min}）`);
    assert.ok(max > 1.5, `向右摆幅不足（max=${max}）`);
  });

  it("手枪单发上跳大、横向在 ±half 内，且不推进游标", () => {
    assert.ok(pistol !== null);
    const delta = recoilDeltaOf(pistol, 0, () => 0);
    assert.equal(delta.pitchDeg, pistol.recoilVertDeg);
    assert.equal(delta.yawDeg, -pistol.recoilHorizDeg);
    assert.equal(delta.nextIndex, 0);

    const high = recoilDeltaOf(pistol, 0, () => 1);
    assert.equal(high.yawDeg, pistol.recoilHorizDeg);
  });

  it("游标越过表长后必须钳在最后一格，不能读越界", () => {
    assert.ok(ak !== null);
    const end = recoilDeltaOf(ak, 999);
    assert.equal(end.nextIndex, 29);
    assert.equal(end.pitchDeg, 0, "已经到最后一格，再打也不应继续上抬");
  });
});

describe("服务端权威扩散（圆锥采样）", () => {
  const ak = fireProfileOf(0);
  const pistol = fireProfileOf(1);

  it("两把枪的扩散参数必须存在且单调（首发 < 封顶）", () => {
    assert.ok(ak !== null);
    assert.ok(pistol !== null);
    for (const profile of [ak, pistol]) {
      assert.ok(profile.spreadFirstDeg > 0, "首发扩散不能为 0（否则等于激光枪）");
      assert.ok(profile.spreadStepDeg > 0);
      assert.ok(profile.spreadMaxDeg > profile.spreadFirstDeg);
    }
  });

  it("扩散半角必须查表而非随机：第 1 发最小、逐发递增、到顶封顶", () => {
    assert.ok(ak !== null);
    assert.equal(spreadHalfAngleDeg(ak, 0), 0.2);
    // 0.20 + 9×0.26 = 2.54（第 10 发）
    assert.ok(Math.abs(spreadHalfAngleDeg(ak, 9) - 2.54) < 1e-9);
    // 第 11 发本该 2.80，被 2.60 封顶
    assert.equal(spreadHalfAngleDeg(ak, 10), 2.6);
    assert.equal(spreadHalfAngleDeg(ak, 29), 2.6);
    // 越界（负数 / 极大值）不能炸，也不能返回 NaN
    assert.equal(spreadHalfAngleDeg(ak, -5), 0.2);
    assert.equal(spreadHalfAngleDeg(ak, 10000), 2.6);
  });

  it("手枪涨得更快、封顶更低（第 7 发到顶 1.80）", () => {
    assert.ok(pistol !== null);
    assert.equal(spreadHalfAngleDeg(pistol, 0), 0.12);
    assert.ok(Math.abs(spreadHalfAngleDeg(pistol, 5) - 1.62) < 1e-9);
    assert.equal(spreadHalfAngleDeg(pistol, 6), 1.8, "第 7 发本该 1.92，应被 1.80 封顶");
  });

  it("首发 30m 处的落点半径必须小于头部判定半径（静止首发能稳定爆头）", () => {
    assert.ok(ak !== null);
    const radius: number = 30 * Math.tan((spreadHalfAngleDeg(ak, 0) * Math.PI) / 180);
    assert.ok(radius < 0.13, `30m 首发半径 ${radius.toFixed(3)}m 超过头部半径 0.13m，首发不再可靠`);
  });

  it("同一颗种子必须得到逐位相同的采样（QA 能断言、争议弹道能回放）", () => {
    assert.ok(ak !== null);
    const seed = mixShotSeed(0xdeadbeef, hashString("session-1"), 7);
    const first = sampleSpread(ak, 7, seed);
    const second = sampleSpread(ak, 7, seed);
    assert.deepEqual(first, second);
  });

  it("种子三要素缺一不可：换房间 / 换玩家 / 换发数都必须换出不同偏移", () => {
    assert.ok(ak !== null);
    const base = mixShotSeed(1, 100, 3);
    assert.notEqual(mixShotSeed(2, 100, 3), base, "换房间种子应改变偏移");
    assert.notEqual(mixShotSeed(1, 200, 3), base, "换玩家盐应改变偏移");
    assert.notEqual(mixShotSeed(1, 100, 4), base, "换发数应改变偏移");
  });

  it("采样必须落在单位盘内（|v| ≤ 1），否则实际扩散会超过标称半角", () => {
    assert.ok(ak !== null);
    for (let i = 0; i < 500; i += 1) {
      const sample = sampleSpread(ak, i % 30, mixShotSeed(0x12345678, hashString(`p${i}`), i % 30));
      const length: number = Math.hypot(sample.x, sample.y);
      assert.ok(length <= 1 + 1e-9, `第 ${i} 次采样 |v| = ${length} 超出单位盘`);
    }
  });

  it("半径分布必须接近均匀圆盘（中位数 ≈ 0.707R，不是集中在中心或边缘）", () => {
    assert.ok(ak !== null);
    const radii: number[] = [];
    for (let i = 0; i < 2000; i += 1) {
      const sample = sampleSpread(ak, 0, mixShotSeed(0x9e3779b9, hashString("sampler"), i));
      radii.push(Math.hypot(sample.x, sample.y));
    }
    radii.sort((a, b) => a - b);
    const median: number = radii[Math.floor(radii.length / 2)] as number;
    assert.ok(median > 0.66 && median < 0.75, `半径中位数 ${median.toFixed(3)} 偏离 0.707 太多`);
    // 均值应接近 2/3（E[√u]）
    const mean: number = radii.reduce((sum, value) => sum + value, 0) / radii.length;
    assert.ok(mean > 0.62 && mean < 0.71, `半径均值 ${mean.toFixed(3)} 偏离 0.667 太多`);
  });

  it("采样方向必须覆盖四个象限（不是只往一个方向偏）", () => {
    assert.ok(ak !== null);
    const quadrants = [0, 0, 0, 0];
    for (let i = 0; i < 400; i += 1) {
      const sample = sampleSpread(ak, 0, mixShotSeed(7, 7, i));
      const index: number = (sample.x >= 0 ? 0 : 1) + (sample.y >= 0 ? 0 : 2);
      quadrants[index] = (quadrants[index] ?? 0) + 1;
    }
    for (const count of quadrants) {
      assert.ok(count > 60, `某个象限只有 ${count} 次采样，分布不均`);
    }
  });

  it("spreadToPixels 必须是单调的、且与 FOV/分辨率线性", () => {
    const low: number = spreadToPixels(0.2, 80, 1080);
    const high: number = spreadToPixels(2.6, 80, 1080);
    assert.ok(high > low * 10, "2.6° 应比 0.2° 张开得多一个量级");
    // 同角度、分辨率翻倍 → 像素翻倍
    assert.ok(Math.abs(spreadToPixels(2.6, 80, 2160) - high * 2) < 1e-9);
    // 0.2° @ FOV 80 / 1080p：tan(0.2°)/tan(40°)×540 ≈ 2.25px
    assert.ok(Math.abs(low - 2.25) < 0.05, `0.2° 应约 2.25px，实际 ${low.toFixed(3)}`);
  });
});
