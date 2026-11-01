/**
 * 投掷物纯函数单测：抛物线物理、爆炸伤害衰减与遮挡、闪光强度。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PLAYER_HEIGHT,
  THROW_MAX_PITCH,
  type Aabb,
} from "@colyseus-fps/shared";

import {
  clampThrowDirection,
  explosionDamage,
  flashIntensity,
  normalizeVec,
  stepGrenade,
  type GrenadeState,
} from "../src/rooms/grenades.js";

function makeGrenade(overrides: Partial<GrenadeState> = {}): GrenadeState {
  return {
    id: 1,
    type: "frag",
    throwerId: "A",
    x: 0,
    y: 1.5,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    fuseMs: 1000,
    ...overrides,
  };
}

const WALL: Aabb = { minX: -1, maxX: 1, minY: 0, maxY: 3, minZ: -0.5, maxZ: 0.5 };

describe("投掷物物理", () => {
  it("零向量归一化返回 null", () => {
    assert.equal(normalizeVec(0, 0, 0), null);
  });

  it("方向向量会被归一化为单位长度", () => {
    const dir = normalizeVec(0, 3, 4);
    assert.ok(dir !== null);
    assert.ok(Math.abs(Math.hypot(dir.x, dir.y, dir.z) - 1) < 1e-9);
  });

  it("投掷俯仰会被钳制到 THROW_MAX_PITCH 内", () => {
    const clamped = clampThrowDirection({ x: 0, y: 1, z: 0 });
    assert.ok(Math.abs(clamped.y - Math.sin(THROW_MAX_PITCH)) < 1e-6, `实际 ${clamped.y}`);
    assert.ok(Math.abs(Math.hypot(clamped.x, clamped.y, clamped.z) - 1) < 1e-9);
  });

  it("重力使手雷下落并在落地后弹起、最终停在地面", () => {
    const grenade = makeGrenade();
    for (let i = 0; i < 200; i++) {
      stepGrenade(grenade, 0.05, []);
    }
    assert.ok(grenade.y <= 0.13, `应落到地面附近，实际 y=${grenade.y}`);
    assert.ok(grenade.y >= 0.1, `不应穿透地面，实际 y=${grenade.y}`);
  });

  it("撞墙后水平速度反向并衰减", () => {
    const grenade = makeGrenade({ x: -3, y: 1.5, vx: 12, vy: 0, vz: 0 });
    for (let i = 0; i < 40; i++) {
      stepGrenade(grenade, 0.05, [WALL]);
    }
    assert.ok(grenade.x < 0, `应被弹回墙左侧，实际 x=${grenade.x}`);
  });

  it("落地静止后不再水平漂移（摩擦）", () => {
    const grenade = makeGrenade({ y: 0.11, vx: 4, vz: 2 });
    for (let i = 0; i < 120; i++) {
      stepGrenade(grenade, 0.05, []);
    }
    assert.ok(Math.abs(grenade.vx) < 0.6, `水平速度应衰减，实际 ${grenade.vx}`);
  });
});

describe("手雷爆炸伤害", () => {
  const targets = [
    { sessionId: "near", x: 0, y: 0, z: 0.5, alive: true },
    { sessionId: "far", x: 0, y: 0, z: 5.6, alive: true },
    { sessionId: "outside", x: 0, y: 0, z: 9, alive: true },
    { sessionId: "dead", x: 0, y: 0, z: 0.5, alive: false },
  ];

  it("按距离衰减并排除半径外的目标与死亡玩家", () => {
    const victims = explosionDamage({ x: 0, y: 0.5, z: 0 }, 6, 100, 20, targets, []);
    const byId = new Map(victims.map((victim) => [victim.sessionId, victim.damage]));

    assert.ok(!byId.has("outside"), "半径外不应受伤");
    assert.ok(!byId.has("dead"), "死亡玩家不应重复受伤");
    assert.ok((byId.get("near") ?? 0) > (byId.get("far") ?? 0), "近处伤害应更高");
    assert.ok((byId.get("far") ?? 0) >= 20, "远处伤害不应低于最小值");
    assert.ok((byId.get("near") ?? 0) <= 100, "伤害不应超过最大值");
  });

  it("掩体后的目标免疫爆炸伤害", () => {
    const blocked = explosionDamage(
      { x: -3, y: 0.5, z: 0 },
      10,
      100,
      20,
      [{ sessionId: "behind", x: 3, y: 0, z: 0, alive: true }],
      [WALL],
    );
    assert.equal(blocked.length, 0, "墙体后不应受伤");
  });

  it("爆炸点与目标距离按胸口高度计算（不因 y 差误判）", () => {
    const victims = explosionDamage(
      { x: 0, y: 0.11, z: 0 },
      6,
      100,
      20,
      [{ sessionId: "p", x: 0, y: 0, z: 0.2, alive: true }],
      [],
    );
    assert.equal(victims.length, 1);
    assert.ok(victims[0]!.damage >= 80, `近距离应接近满伤，实际 ${victims[0]!.damage}`);
    assert.ok(PLAYER_HEIGHT > 1);
  });
});

describe("闪光弹致盲强度", () => {
  const center = { x: 0, y: 1, z: 0 };

  it("正对闪光比背对更亮", () => {
    const facing = flashIntensity(center, 12, { x: 0, z: 6, yaw: 0 });
    const back = flashIntensity(center, 12, { x: 0, z: 6, yaw: Math.PI });
    assert.ok(facing > back, `正对 ${facing} 应大于背对 ${back}`);
    assert.ok(back > 0 && back < 0.4, `背对仍应有轻微影响，实际 ${back}`);
  });

  it("距离越近强度越高", () => {
    const near = flashIntensity(center, 12, { x: 0, z: 2, yaw: 0 });
    const far = flashIntensity(center, 12, { x: 0, z: 10, yaw: 0 });
    assert.ok(near > far, `近处 ${near} 应大于远处 ${far}`);
  });

  it("超出半径不生效", () => {
    assert.equal(flashIntensity(center, 12, { x: 0, z: 20, yaw: 0 }), 0);
  });
});
