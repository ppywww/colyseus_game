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

function makePlayer(id: string, x: number, z: number, yaw = 0, pitch = 0): CombatantView {
  return { sessionId: id, x, y: 0, z, yaw, pitch, alive: true };
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
  it("正对敌人平射命中胸部（眼高 1.60 低于头部下沿 1.63）并给出命中点", () => {
    const players = [makePlayer("A", 0, 0), makePlayer("B", 0, -5)];
    const shot = computeShot(players, "A", []);
    assert.ok(shot !== null);
    assert.equal(shot.hitPlayerId, "B");
    assert.equal(shot.hitZone, "chest");
    assert.equal(shot.damage, ZONE_DAMAGE.chest);
    // 胸部圆柱半径 0.27 → 表面距离 5 − 0.27
    assert.ok(Math.abs(shot.hit.z + 4.73) < 1e-6, `命中点 z 应 −4.73，实际 ${shot.hit.z}`);
  });

  it("抬头约 0.7° 才命中头部（爆头需要主动压枪上抬）", () => {
    const players = [makePlayer("A", 0, 0, 0, 0.0117), makePlayer("B", 0, -5)];
    const shot = computeShot(players, "A", []);
    assert.ok(shot !== null);
    assert.equal(shot.hitZone, "head");
    assert.equal(shot.damage, ZONE_DAMAGE.head);
  });

  it("死亡玩家不可开火、不可被命中", () => {
    const dead = { ...makePlayer("B", 0, -5), alive: false };
    assert.equal(computeShot([makePlayer("A", 0, 0), dead], "A", [])?.hitPlayerId, null);
    assert.equal(computeShot([dead], "B", []), null);
  });

  it("shotSeq 原样回显（客户端靠它把这一发和开火瞬间的枪口配对）", () => {
    const players = [makePlayer("A", 0, 0), makePlayer("B", 0, -5)];
    const shot = computeShot(players, "A", [], undefined, 60, null, null, 42);
    assert.equal(shot?.shotSeq, 42);
    // 客户端没带序号时必须是 0，不能是 NaN/undefined（否则客户端会当成"老服务端"走 FIFO）
    assert.equal(computeShot(players, "A", [])?.shotSeq, 0);
    // 脏数据也要收敛成合法整数：负数/小数/Infinity 都不能原样广播出去
    assert.equal(computeShot(players, "A", [], undefined, 60, null, null, -7)?.shotSeq, 0);
    assert.equal(computeShot(players, "A", [], undefined, 60, null, null, 3.9)?.shotSeq, 3);
    assert.equal(
      computeShot(players, "A", [], undefined, 60, null, null, Number.POSITIVE_INFINITY)?.shotSeq,
      0,
    );
  });

  it("蹲下时射线起点下沉到蹲姿眼高", () => {
    const stand: CombatantView = { ...makePlayer("A", 0, 0), crouch: false };
    const crouched: CombatantView = { ...makePlayer("A", 0, 0), crouch: true };
    const target = makePlayer("B", 0, -6);
    const standingShot = computeShot([stand, target], "A", []);
    const crouchedShot = computeShot([crouched, target], "A", []);
    assert.ok(standingShot !== null && crouchedShot !== null);
    assert.ok(Math.abs(standingShot.rayOrigin.y - 1.6) < 1e-9);
    assert.ok(Math.abs(crouchedShot.rayOrigin.y - 1.02) < 1e-9, `蹲姿眼高应 1.02，实际 ${crouchedShot.rayOrigin.y}`);
    // 蹲姿下判定也应该从更低的位置出发：平射命中的是"腿/腹"而不是"胸"
    assert.equal(crouchedShot.hitZone, "belly");
  });

  it("目标蹲下时判定体被压扁：平射会从他头顶过去", () => {
    const shooter = makePlayer("A", 0, 0);
    const standing = makePlayer("B", 0, -6);
    const crouching: CombatantView = { ...makePlayer("B", 0, -6), crouch: true };
    assert.equal(computeShot([shooter, standing], "A", [])?.hitPlayerId, "B");
    // 站立头顶 1.80 / 蹲下头顶 1.80 × 0.63 = 1.134，1.6m 的水平射线整体越过
    assert.equal(computeShot([shooter, crouching], "A", [])?.hitPlayerId, null);
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

  it("真实地图回归：中路东墙（MID_E）挡住 +X 方向的子弹", () => {
    // 真实地图：MID_E 位于 x 5…7、z −14…24、高 5m，正好横在 (0,4) → (9,4) 这条 +X 枪线上。
    // 这条用例吃的是 shared 的 OBSTACLES 数据，地图一旦被改动（墙挪位/高度不够）会立刻失败。
    const players = [makePlayer("A", 0, 4, -Math.PI / 2), makePlayer("B", 9, 4)];
    const shot = computeShot(players, "A", obstacleColliders());
    assert.ok(shot !== null);
    assert.equal(shot.hitPlayerId, null, "墙后的目标不应被命中");
    // 弹道应止于 MID_E 的西表面 x = 5
    assert.ok(Math.abs(shot.hit.x - 5) < 0.05, `弹道应止于墙前 x≈5，实际 ${shot.hit.x.toFixed(2)}`);
    assert.ok(Math.abs(shot.hit.z - 4) < 1e-6);
  });

  it("真实地图回归：中路空走廊内 10m 对枪应命中（无墙遮挡）", () => {
    // 真实地图：x −4…4、z −11…8 是中路空走廊（W6x/W8x 在 |x| ≥ 4，M1/M5 都在 z < −7）
    const players = [makePlayer("A", -1.5, 7, 0), makePlayer("B", -1.5, -3)];
    const shot = computeShot(players, "A", obstacleColliders());
    assert.ok(shot !== null);
    assert.equal(shot.hitPlayerId, "B", "空走廊内应命中目标");
    // 平射打在胸部圆柱表面：z = −3 + 0.27
    assert.ok(Math.abs(shot.hit.z - (-3 + 0.27)) < 1e-6, `命中点 z 应约 −2.73，实际 ${shot.hit.z}`);
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
