/**
 * 出生点随机策略测试（文档 5.2 / 5.3）。
 *
 * 断言三件事：
 *   1. 每队只在该队的 4 个点里出（数据取自 `SPAWN_POINTS` 前 4 条，坐标不新造）；
 *   2. 出生点永远不落在任何障碍 AABB 内（按 0.35m 玩家半径外扩）；
 *   3. 三级过滤与「避免连续同点」的行为符合文档。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  OBSTACLES,
  PLAYER_HIT_RADIUS,
  teamSpawnPoints,
  obstacleColliders,
  type Aabb,
  type TeamId,
} from "@colyseus-fps/shared";

import {
  SPAWN_OCCUPANCY_RADIUS,
  SPAWN_OVERFLOW_OFFSET_X,
  aabbOfSpawn,
  pickSpawnPoint,
  type SpawnPlayerView,
} from "../src/rooms/spawn.js";

const COLLIDERS: readonly Aabb[] = obstacleColliders();

function player(overrides: Partial<SpawnPlayerView> & { sessionId: string }): SpawnPlayerView {
  return { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, alive: true, ...overrides };
}

/** 出生点是否落在某个障碍 AABB（按玩家半径外扩）内部。 */
function insideAnyObstacle(x: number, z: number): boolean {
  for (const obstacle of OBSTACLES) {
    const minX: number = obstacle.x - obstacle.width / 2 - PLAYER_HIT_RADIUS;
    const maxX: number = obstacle.x + obstacle.width / 2 + PLAYER_HIT_RADIUS;
    const minZ: number = obstacle.z - obstacle.depth / 2 - PLAYER_HIT_RADIUS;
    const maxZ: number = obstacle.z + obstacle.depth / 2 + PLAYER_HIT_RADIUS;
    if (x > minX && x < maxX && z > minZ && z < maxZ) {
      return true;
    }
  }
  return false;
}

/** 出生点是否属于该队的 4 个候选点（允许溢出分支的 +X 偏移）。 */
function belongsToTeam(team: TeamId, x: number, z: number): boolean {
  return teamSpawnPoints(team).some(
    (point) =>
      (Math.abs(point.x - x) < 1e-9 || Math.abs(point.x + SPAWN_OVERFLOW_OFFSET_X - x) < 1e-9) &&
      Math.abs(point.z - z) < 1e-9,
  );
}

describe("pickSpawnPoint 每队 4 点随机", () => {
  it("连续 20 次出生都在该队 4 点内，且不落在任何 AABB", () => {
    for (const team of ["T", "CT"] as const) {
      for (let i = 0; i < 20; i += 1) {
        const selection = pickSpawnPoint({ team, selfId: "self", players: [], obstacles: COLLIDERS });
        assert.equal(selection.point.team, team);
        assert.ok(
          belongsToTeam(team, selection.point.x, selection.point.z),
          `${team} 侧出生点 (${selection.point.x}, ${selection.point.z}) 不在该队 4 点内`,
        );
        assert.equal(selection.overflow, false, "空房间不应走溢出分支");
        assert.ok(
          !insideAnyObstacle(selection.point.x, selection.point.z),
          `(${selection.point.x}, ${selection.point.z}) 与体块重叠`,
        );
      }
    }
  });

  it("20 次随机应至少出现 3 个不同的点（不是写死的固定点）", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20; i += 1) {
      const selection = pickSpawnPoint({ team: "T", selfId: "self", players: [], obstacles: COLLIDERS });
      seen.add(`${selection.point.x},${selection.point.z}`);
    }
    assert.ok(seen.size >= 3, `20 次只出现了 ${seen.size} 个不同出生点`);
  });

  it("同队玩家 1.2m 内占用该点后，不会两人同点出生", () => {
    const slots = teamSpawnPoints("T");
    // 前 3 个点都被同队玩家占住，只剩最后 1 个
    const occupied = slots.slice(0, 3).map((point, index) =>
      player({ sessionId: `mate-${index}`, x: point.x, z: point.z }),
    );
    for (let i = 0; i < 10; i += 1) {
      const selection = pickSpawnPoint({
        team: "T",
        selfId: "self",
        players: occupied,
        obstacles: COLLIDERS,
      });
      const last = slots[3]!;
      assert.ok(
        Math.abs(selection.point.x - last.x) < 1e-9 && Math.abs(selection.point.z - last.z) < 1e-9,
        `应只剩 (${last.x}, ${last.z})，实际 (${selection.point.x}, ${selection.point.z})`,
      );
    }
  });

  it("占用判定半径为 1.2m：1.21m 的队友不占用该点", () => {
    const slot = teamSpawnPoints("T")[0]!;
    const near = player({ sessionId: "mate", x: slot.x + 1.21, z: slot.z });
    // 剩余 3 个点全部手动占住，只留下 slot 可用；若占用判定生效，本函数会走溢出分支
    const others = teamSpawnPoints("T")
      .slice(1)
      .map((point, index) => player({ sessionId: `mate-${index + 1}`, x: point.x, z: point.z }));
    const selection = pickSpawnPoint({
      team: "T",
      selfId: "self",
      players: [near, ...others],
      obstacles: COLLIDERS,
    });
    assert.equal(selection.overflow, false);
    assert.ok(Math.abs(selection.point.x - slot.x) < 1e-9);
    assert.ok(SPAWN_OCCUPANCY_RADIUS === 1.2);
  });

  it("四个点全被同队玩家占住时走溢出分支（沿 +X 偏移 0.9m）", () => {
    const occupied = teamSpawnPoints("T").map((point, index) =>
      player({ sessionId: `mate-${index}`, x: point.x, z: point.z }),
    );
    const selection = pickSpawnPoint({
      team: "T",
      selfId: "self",
      players: occupied,
      obstacles: COLLIDERS,
    });
    assert.equal(selection.overflow, true);
    assert.ok(belongsToTeam("T", selection.point.x, selection.point.z));
    assert.equal(selection.point.x, teamSpawnPoints("T")[selection.index]!.x + SPAWN_OVERFLOW_OFFSET_X);
  });

  it("敌人 12m 内通视的点会被否掉", () => {
    // 新地图 T 侧 4 点是 (−6,34) (0,35.5) (6,34) (−10,31)。
    // 把敌人放在 (0, 25) 朝 +Z（yaw=π）：只有 (0,35.5) 落在这条视线上，距离 10.5m < 12m，
    // 中间是空的 T 出生点广场（SN1/SN2 在 z=23 的南侧，不挡视线）→ 该点应被否掉。
    const target = { x: 0, z: 35.5 };
    const facingPlayer = player({ sessionId: "enemy", x: 0, z: 25, yaw: Math.PI });
    let exposedPicked = 0;
    for (let i = 0; i < 30; i += 1) {
      const selection = pickSpawnPoint({
        team: "T",
        selfId: "self",
        players: [facingPlayer],
        obstacles: COLLIDERS,
      });
      assert.equal(selection.overflow, false, "有安全点时不应用溢出分支");
      if (Math.abs(selection.point.x - target.x) < 1e-9 && Math.abs(selection.point.z - target.z) < 1e-9) {
        exposedPicked += 1;
      }
    }
    assert.equal(exposedPicked, 0, "暴露在敌人视线内的出生点不应被选中");

    // 反向对照：敌人背对（yaw=0 朝 −Z）时该点重新可用，60 次里应至少被抽到一次
    const awayPlayer = player({ sessionId: "enemy", x: 0, z: 25, yaw: 0 });
    let pickedWhenSafe = 0;
    for (let i = 0; i < 60; i += 1) {
      const selection = pickSpawnPoint({
        team: "T",
        selfId: "self",
        players: [awayPlayer],
        obstacles: COLLIDERS,
      });
      if (Math.abs(selection.point.x - target.x) < 1e-9 && Math.abs(selection.point.z - target.z) < 1e-9) {
        pickedWhenSafe += 1;
      }
    }
    assert.ok(pickedWhenSafe > 0, "敌人背对时该出生点应可用");
  });

  it("避免连续同一个点：命中 lastIndex 时会重抽", () => {
    // 可控随机源：第一次落在 index 0，重抽时落在 index 3
    const sequence = [0, 0.9, 0.9];
    let cursor = 0;
    const random = (): number => {
      const value = sequence[Math.min(cursor, sequence.length - 1)] ?? 0;
      cursor += 1;
      return value;
    };

    const first = pickSpawnPoint({ team: "T", selfId: "self", players: [], obstacles: COLLIDERS, random });
    assert.equal(first.index, 0);

    cursor = 0;
    const second = pickSpawnPoint({
      team: "T",
      selfId: "self",
      players: [],
      obstacles: COLLIDERS,
      lastIndex: first.index,
      random,
    });
    assert.equal(second.index, 3, "重抽后应换到别的点，而不是和上次同一个");
  });

  it("aabbOfSpawn 与玩家碰撞尺寸一致", () => {
    const box = aabbOfSpawn({ team: "T", x: 1, z: 2, yaw: 0 });
    assert.ok(Math.abs(box.maxX - box.minX - PLAYER_HIT_RADIUS * 2) < 1e-9);
    assert.ok(Math.abs(box.maxZ - box.minZ - PLAYER_HIT_RADIUS * 2) < 1e-9);
    assert.equal(box.minY, 0);
    assert.equal(box.maxY, 1.8);
  });
});
