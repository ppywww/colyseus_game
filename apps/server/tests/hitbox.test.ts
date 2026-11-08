/**
 * 分区伤害与 6 段判定体测试（文档 1.6 的断言 + 几何自洽性）。
 *
 * 这一组用例的作用是「防三线跑偏」：服务端判定（本次）、客户端模型（下一批）、
 * 客户端物理身高必须引用同一份常量，任何一处改动都会让这些断言失效。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EYE_HEIGHT,
  HIT_ZONES,
  PLAYER_HEIGHT,
  PLAYER_HITBOXES,
  WEAPON_DAMAGE,
  ZONE_DAMAGE,
  ZONE_LABEL,
  ZONE_MULTIPLIER,
  ZONE_PRIORITY,
  type HitZone,
} from "@colyseus-fps/shared";

import {
  computeShot,
  rayPlayerHitboxes,
  rayVerticalCylinder,
  rightFromYaw,
  type CombatantView,
  type Vec3,
} from "../src/rooms/combat.js";

/** 靶子站在原点（y=0），朝向 -Z（yaw=0）。 */
function target(overrides: Partial<{ x: number; y: number; z: number; yaw: number }> = {}): {
  x: number;
  y: number;
  z: number;
  yaw: number;
} {
  return { x: 0, y: 0, z: 0, yaw: 0, ...overrides };
}

/**
 * 构造一条「从 z=+distance 处水平朝 −Z」的射线，期望命中高度为 `aimY`（世界坐标）。
 *
 * 用 pitch 让射线在目标处正好穿过 aimY，而不是把射线平移到某个高度——
 * 后者会连带改变水平距离，测出来的 t 不再是"打到躯干"的那条线。
 */
function aimAtY(aimY: number, distance: number): { origin: Vec3; dir: Vec3 } {
  const dy: number = aimY - EYE_HEIGHT;
  const horizontal: number = Math.sqrt(distance * distance + dy * dy);
  const dir: Vec3 = { x: 0, y: dy / horizontal, z: -distance / horizontal };
  return { origin: { x: 0, y: EYE_HEIGHT, z: distance }, dir };
}

function zoneAt(aimY: number, distance = 6): HitZone | null {
  const { origin, dir } = aimAtY(aimY, distance);
  return rayPlayerHitboxes(origin, dir, target(), 60)?.zone ?? null;
}

describe("ZONE_DAMAGE 数值口径（头 1 / 胸 4 / 腹·臂·腿 6 枪）", () => {
  it("头部一枪致死（伤害 ≥ 满血）", () => {
    assert.ok(ZONE_DAMAGE.head >= 100, "头 100 ≥ 满血 100");
    assert.equal(ZONE_DAMAGE.head, 100);
  });

  it("致死枪数应为 1 / 4 / 6 / 6 / 6", () => {
    assert.equal(Math.ceil(100 / ZONE_DAMAGE.head), 1);
    assert.equal(Math.ceil(100 / ZONE_DAMAGE.chest), 4);
    assert.equal(Math.ceil(100 / ZONE_DAMAGE.belly), 6);
    assert.equal(Math.ceil(100 / ZONE_DAMAGE.arm), 6);
    assert.equal(Math.ceil(100 / ZONE_DAMAGE.leg), 6);
  });

  it("伤害必须是整数（hp 是 uint8，小数会被序列化截断）", () => {
    for (const zone of HIT_ZONES) {
      assert.ok(Number.isInteger(ZONE_DAMAGE[zone]), `${zone} 伤害必须是整数`);
    }
  });

  it("胸伤必须等于 WEAPON_DAMAGE（保持既有 4 枪手感）", () => {
    assert.equal(ZONE_DAMAGE.chest, WEAPON_DAMAGE);
  });

  it("倍率表与伤害表口径一致（仅作展示，误差 < 0.01）", () => {
    for (const zone of HIT_ZONES) {
      const fromTable: number = ZONE_DAMAGE[zone] / WEAPON_DAMAGE;
      assert.ok(
        Math.abs(fromTable - ZONE_MULTIPLIER[zone]) < 0.01,
        `${zone} 倍率 ${ZONE_MULTIPLIER[zone]} 与 ${fromTable.toFixed(3)} 不一致`,
      );
    }
  });

  it("每个部位都要有优先级与中文文案", () => {
    for (const zone of HIT_ZONES) {
      assert.equal(typeof ZONE_PRIORITY[zone], "number");
      assert.ok(ZONE_LABEL[zone].length > 0);
    }
    assert.ok(ZONE_PRIORITY.head < ZONE_PRIORITY.chest, "头部优先级必须最高");
  });
});

describe("PLAYER_HITBOXES 几何自洽", () => {
  it("最低段不低于脚底，最高段顶 === PLAYER_HEIGHT", () => {
    const minY: number = Math.min(...PLAYER_HITBOXES.map((box) => box.yMin));
    const maxY: number = Math.max(...PLAYER_HITBOXES.map((box) => box.yMax));
    assert.ok(minY >= 0);
    assert.equal(maxY, PLAYER_HEIGHT);
  });

  it("躯干三段（腿→腹→胸→头）首尾相接，不留缝", () => {
    const spine: HitZone[] = ["leg", "belly", "chest", "head"];
    const boxes = spine.map((zone) => {
      const found = PLAYER_HITBOXES.find((box) => box.zone === zone);
      assert.ok(found !== undefined, `缺少 ${zone} 段`);
      return found;
    });
    for (let i = 1; i < boxes.length; i += 1) {
      const prev = boxes[i - 1]!;
      const next = boxes[i]!;
      assert.ok(
        Math.abs(next.yMin - prev.yMax) < 1e-6,
        `${prev.zone}(${prev.yMax}) 与 ${next.zone}(${next.yMin}) 之间存在缝隙`,
      );
    }
  });

  it("手臂段必须左右各一个、镜像对称", () => {
    const arms = PLAYER_HITBOXES.filter((box) => box.zone === "arm");
    assert.equal(arms.length, 2);
    const offsets = arms.map((box) => box.offsetRight).sort((a, b) => a - b);
    assert.ok(Math.abs(offsets[0]! + 0.3) < 1e-9);
    assert.ok(Math.abs(offsets[1]! - 0.3) < 1e-9);
  });

  it("所有圆柱半径都为正、且不超过躯干半径（判定不能比身体宽出去太多）", () => {
    const chestRadius: number = PLAYER_HITBOXES.find((box) => box.zone === "chest")!.radius;
    for (const box of PLAYER_HITBOXES) {
      assert.ok(box.radius > 0);
      assert.ok(box.radius <= chestRadius, `${box.zone} 半径 ${box.radius} 大于胸部 ${chestRadius}`);
    }
  });
});

describe("rayVerticalCylinder", () => {
  const origin: Vec3 = { x: 0, y: EYE_HEIGHT, z: 6 };
  const dir: Vec3 = { x: 0, y: 0, z: -1 };

  it("正对圆柱返回表面距离", () => {
    const t = rayVerticalCylinder(origin, dir, 0, 0, 0, 0, 1.8, 0.27, 60);
    assert.ok(t !== null && Math.abs(t - (6 - 0.27)) < 1e-6);
  });

  it("高度超出 [yMin, yMax] 返回 null", () => {
    assert.equal(rayVerticalCylinder(origin, dir, 0, 0, 0, 0, 1.0, 0.27, 60), null);
  });

  it("水平偏移超过半径返回 null；超出 maxT 返回 null", () => {
    assert.equal(rayVerticalCylinder(origin, dir, 1, 0, 0, 0, 1.8, 0.27, 60), null);
    assert.equal(rayVerticalCylinder(origin, dir, 0, 0, 0, 0, 1.8, 0.27, 3), null);
  });

  it("垂直向下射线退化为「穿过圆盘」判定", () => {
    const t = rayVerticalCylinder({ x: 0, y: 3, z: 0 }, { x: 0, y: -1, z: 0 }, 0, 0, 0, 1.54, 1.8, 0.14, 60);
    assert.ok(t !== null && Math.abs(t - (3 - 1.8)) < 1e-6, "应命中头顶 1.80");
  });
});

describe("rayPlayerHitboxes 分段命中", () => {
  it("瞄准头部（1.65m）命中 head", () => {
    assert.equal(zoneAt(1.65), "head");
  });

  it("瞄准胸部（1.34m）命中 chest", () => {
    assert.equal(zoneAt(1.34), "chest");
  });

  it("瞄准腹部（1.02m）命中 belly", () => {
    assert.equal(zoneAt(1.02), "belly");
  });

  it("瞄准腿部（0.4m）命中 leg", () => {
    assert.equal(zoneAt(0.4), "leg");
  });

  it("瞄准右臂（世界 x=+0.30、高 1.3m）命中 arm", () => {
    // 射线从 (0.30, EYE_HEIGHT, 6) 水平朝 −Z，只可能穿过右臂圆柱
    const origin: Vec3 = { x: 0.3, y: 1.3, z: 6 };
    const dir: Vec3 = { x: 0, y: 0, z: -1 };
    assert.equal(rayPlayerHitboxes(origin, dir, target(), 60)?.zone, "arm");
  });

  it("眼高（1.60m）平射 = 胸部；抬头 0.7° 才进头部判定区", () => {
    // 头部下沿 1.63 高于相机眼高 1.60，所以水平对枪默认打胸（身体 4 枪），
    // 想爆头必须主动上抬视线 —— 这是「点头」的操作含义。
    const flat: Vec3 = { x: 0, y: EYE_HEIGHT, z: 6 };
    assert.equal(rayPlayerHitboxes(flat, { x: 0, y: 0, z: -1 }, target(), 60)?.zone, "chest");

    // 6m 外抬 0.0117 rad ≈ 0.67°，射线到目标面时升到 1.67m（头部圆心）
    const aimUp: Vec3 = { x: 0, y: Math.sin(0.0117), z: -Math.cos(0.0117) };
    assert.equal(rayPlayerHitboxes(flat, aimUp, target(), 60)?.zone, "head");
  });

  it("完全打偏（水平偏移 0.6m）不命中任何段", () => {
    const origin: Vec3 = { x: 0.6, y: EYE_HEIGHT, z: 6 };
    const dir: Vec3 = { x: 0, y: 0, z: -1 };
    assert.equal(rayPlayerHitboxes(origin, dir, target(), 60), null);
  });

  it("手臂圆柱随 yaw 旋转：yaw=π/2 时右臂指向 −Z", () => {
    const right = rightFromYaw(Math.PI / 2);
    assert.ok(Math.abs(right.x) < 1e-9);
    assert.ok(Math.abs(right.z + 1) < 1e-9);

    // 目标朝 −X（yaw=π/2），其左右臂因此分别落在世界 (0, −0.30) 与 (0, +0.30)
    const oriented = target({ yaw: Math.PI / 2 });
    // 从 −X 侧平射：先穿过世界 z=−0.30 的那只手臂
    const sideOrigin: Vec3 = { x: 6, y: 1.3, z: -0.3 };
    const sideDir: Vec3 = { x: -1, y: 0, z: 0 };
    assert.equal(rayPlayerHitboxes(sideOrigin, sideDir, oriented, 60)?.zone, "arm");

    // 从 +Z 侧平射：世界 z=+0.30 的手臂挡在躯干前面（侧身时手臂确实在身前）
    const frontOrigin: Vec3 = { x: 0, y: 1.3, z: 6 };
    const frontDir: Vec3 = { x: 0, y: 0, z: -1 };
    assert.equal(rayPlayerHitboxes(frontOrigin, frontDir, oriented, 60)?.zone, "arm");

    // 而正对（yaw=0）时同样的射线打到的是胸部
    assert.equal(rayPlayerHitboxes(frontOrigin, frontDir, target(), 60)?.zone, "chest");
  });

  it("头/胸分界处（1.63m）不漏判：1.62 判胸、1.64 判头", () => {
    // 6m 外按目标高度调俯仰角：y = 1.60 + tan(pitch) * 6
    const shootAtHeight = (height: number): string | undefined => {
      const pitch: number = Math.atan((height - EYE_HEIGHT) / 6);
      const dir: Vec3 = { x: 0, y: Math.sin(pitch), z: -Math.cos(pitch) };
      const hit = rayPlayerHitboxes({ x: 0, y: EYE_HEIGHT, z: 6 }, dir, target(), 60);
      assert.ok(hit !== null, `高度 ${height} 不应打空（分界处漏判）`);
      return hit?.zone;
    };
    assert.equal(shootAtHeight(1.62), "chest");
    assert.equal(shootAtHeight(1.64), "head");
  });
});

describe("computeShot 分区结算", () => {
  function shooter(id: string, x: number, z: number, yaw = 0, pitch = 0): CombatantView {
    return { sessionId: id, x, y: 0, z, yaw, pitch, alive: true };
  }

  it("胸部命中扣 25、头部命中扣 100，且带上 hitZone / weaponSlot", () => {
    const at = (pitch: number): number => {
      const shot = computeShot([shooter("A", 0, 6, 0, pitch), shooter("B", 0, 0)], "A", []);
      assert.ok(shot !== null);
      assert.equal(shot.hitPlayerId, "B");
      return shot.damage;
    };
    // 6m 外把视线压到 1.34m（胸部中心）：atan(0.26/6) ≈ 0.0433 rad
    assert.equal(at(-0.0433), ZONE_DAMAGE.chest);
    // 平视（1.60m）也是胸部 —— 头部下沿 1.63 在眼高之上
    assert.equal(at(0), ZONE_DAMAGE.chest);
    // 抬到 1.67m（头部圆心）：atan(0.07/6) ≈ 0.0117 rad
    assert.equal(at(0.0117), ZONE_DAMAGE.head);
  });

  it("未命中时 damage = 0、hitZone = null", () => {
    const shot = computeShot([shooter("A", 0, 6), shooter("B", 5, 0)], "A", []);
    assert.ok(shot !== null);
    assert.equal(shot.hitPlayerId, null);
    assert.equal(shot.hitZone, null);
    assert.equal(shot.damage, 0);
    assert.equal(shot.weaponSlot, 0);
  });

  it("origin 是枪口、rayOrigin 是眼睛，两者差 = 右手 0.29 / 下 0.20 / 前 0.35", () => {
    const shot = computeShot([shooter("A", 0, 6), shooter("B", 5, 0)], "A", []);
    assert.ok(shot !== null);
    assert.deepEqual(shot.rayOrigin, { x: 0, y: EYE_HEIGHT, z: 6 });
    // yaw=0 时右手方向 = +X、视线上方 = +Y
    assert.ok(Math.abs(shot.origin.x - 0.29) < 1e-9, `枪口 x 应 0.29，实际 ${shot.origin.x}`);
    assert.ok(Math.abs(shot.origin.y - (EYE_HEIGHT - 0.2)) < 1e-9, `枪口 y 应 1.40，实际 ${shot.origin.y}`);
    assert.ok(Math.abs(shot.origin.z - (6 - 0.35)) < 1e-9, `枪口 z 应 5.65，实际 ${shot.origin.z}`);
  });

  it("dir 必须是单位向量", () => {
    const shot = computeShot([shooter("A", 0, 6, 0.7, -0.2), shooter("B", 5, 0)], "A", []);
    assert.ok(shot !== null);
    const length: number = Math.hypot(shot.dir.x, shot.dir.y, shot.dir.z);
    assert.ok(Math.abs(length - 1) < 1e-9);
  });

  it("视角快照可覆盖服务端已存视角（3° 内的「打哪中哪」）", () => {
    const players = [shooter("A", 0, 6, 0, 0), shooter("B", 0, 0)];
    const withoutSnapshot = computeShot(players, "A", []);
    const withSnapshot = computeShot(players, "A", [], { yaw: 0, pitch: 0.0117 });
    assert.equal(withoutSnapshot?.hitZone, "chest");
    assert.equal(withSnapshot?.hitZone, "head");
  });
});
