/**
 * 沙漠迷城地图数据校验（纯数据层，不依赖渲染与服务端运行时）。
 *
 * 这些断言对应「改地图时最容易踩的四个坑」：
 *   1. 体块数量掉了（有人误删掩体）或出现退化 AABB（width/depth 为 0，射线求交会得到 NaN）；
 *   2. 出生点落在墙/掩体里（开局卡住、或被物理推出产生橡皮筋）；
 *   3. 出生点跑到可玩区外（服务端 transform 钳制后位置跳变）；
 *   4. 掩体高度落进 1.16–1.39 灰区（玩家反复跳上不去，会当成 bug 反馈）。
 *
 * 数据源是 `@colyseus-fps/shared`，因此本测试同时守住了「客户端物理 / 服务端弹道 / 渲染」三方共用的那一份真相。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAP_BOUNDS,
  MAP_SIZE,
  MAP_ZONES,
  OBSTACLES,
  PLAYER_HIT_RADIUS,
  SPAWN_POINTS,
  WALL_HEIGHT,
  WALL_THICKNESS,
} from "@colyseus-fps/shared";

/** 跳跃最高点：jumpSpeed² / (2 × gravity) = 7.5² / (2 × 22)。 */
const JUMP_APEX_M = 1.278;

/** 可跳上的高度上限（含 20cm 余量）。 */
const JUMPABLE_MAX_M = 1.15;

/** 必须绕行的最小高度。 */
const MUST_CIRCLE_MIN_M = 1.4;

describe("地图尺寸与边界", () => {
  it("外框应为 80×80，可玩区为 ±38，外墙厚 2m / 高 6m", () => {
    assert.equal(MAP_SIZE, 80);
    assert.equal(WALL_THICKNESS, 2);
    assert.equal(WALL_HEIGHT, 6);
    assert.deepEqual(MAP_BOUNDS, { minX: -38, maxX: 38, minZ: -38, maxZ: 38 });
    assert.equal(MAP_BOUNDS.maxX - MAP_BOUNDS.minX, MAP_SIZE - WALL_THICKNESS * 2);
    assert.equal(MAP_BOUNDS.maxZ - MAP_BOUNDS.minZ, MAP_SIZE - WALL_THICKNESS * 2);
  });

  it("四周外墙应完全覆盖可玩区边界（玩家无法绕过外墙走出地图）", () => {
    const outerWalls = OBSTACLES.filter((obstacle) => obstacle.height >= WALL_HEIGHT);
    assert.ok(outerWalls.length >= 4, `外墙段数应 ≥ 4，实际 ${outerWalls.length}`);

    const coveredOnAxis = (axis: "x" | "z"): number => {
      const spans = outerWalls
        .filter((obstacle) => {
          const along = axis === "x" ? obstacle.width : obstacle.depth;
          return along >= MAP_SIZE;
        })
        .map((obstacle) => (axis === "x" ? obstacle.z : obstacle.x))
        .sort((a, b) => a - b);
      return spans.length;
    };

    assert.ok(coveredOnAxis("z") >= 2, "南北外墙各应有一条贯通 x 的外墙");
    assert.ok(coveredOnAxis("x") >= 2, "东西外墙各应有一条贯通 z 的外墙");
  });
});

describe("体块数据完整性", () => {
  it("实心体块总数应 ≥ 90（当前为 50 段墙 + 12 栋建筑 + 35 个掩体）", () => {
    assert.ok(OBSTACLES.length >= 90, `体块数量不足，实际 ${OBSTACLES.length}`);
  });

  it("每个 AABB 都必须是正体积（min < max，且没有 NaN）", () => {
    for (const obstacle of OBSTACLES) {
      const label = `${obstacle.id}(${obstacle.type})`;
      for (const key of ["x", "z", "width", "height", "depth", "color"] as const) {
        assert.ok(Number.isFinite(obstacle[key]), `${label} 的 ${key} 不是有限数`);
      }
      assert.ok(obstacle.width > 0, `${label} 的 width 应 > 0`);
      assert.ok(obstacle.depth > 0, `${label} 的 depth 应 > 0`);
      assert.ok(obstacle.height > 0, `${label} 的 height 应 > 0`);

      const minX = obstacle.x - obstacle.width / 2;
      const maxX = obstacle.x + obstacle.width / 2;
      const minZ = obstacle.z - obstacle.depth / 2;
      const maxZ = obstacle.z + obstacle.depth / 2;
      assert.ok(minX < maxX, `${label} 的 X 轴区间非法`);
      assert.ok(minZ < maxZ, `${label} 的 Z 轴区间非法`);
    }
  });

  it("体块 id 应唯一（便于日志定位与平面图对照）", () => {
    const ids = new Set(OBSTACLES.map((obstacle) => obstacle.id));
    assert.equal(ids.size, OBSTACLES.length, "存在重复 id");
  });

  it("体块应全部落在 80×80 外框内（含外墙自身）", () => {
    const half = MAP_SIZE / 2;
    for (const obstacle of OBSTACLES) {
      assert.ok(Math.abs(obstacle.x) + obstacle.width / 2 <= half + 1e-6, `${obstacle.id} 超出 X 外框`);
      assert.ok(Math.abs(obstacle.z) + obstacle.depth / 2 <= half + 1e-6, `${obstacle.id} 超出 Z 外框`);
    }
  });
});

describe("掩体高度分档（可跳 / 必绕）", () => {
  it("任何体块都不得落在 1.16–1.39 的灰区", () => {
    for (const obstacle of OBSTACLES) {
      const inJumpable = obstacle.height <= JUMPABLE_MAX_M;
      const inMustCircle = obstacle.height >= MUST_CIRCLE_MIN_M;
      assert.ok(
        inJumpable || inMustCircle,
        `${obstacle.id} 的高度 ${obstacle.height}m 落在灰区（1.16–1.39），玩家会反复跳不上去`,
      );
    }
  });

  it("可跳掩体的高度必须低于跳跃最高点（含 0.12m 余量）", () => {
    const jumpables = OBSTACLES.filter((obstacle) => obstacle.height <= JUMPABLE_MAX_M);
    assert.ok(jumpables.length >= 15, `可跳掩体过少，实际 ${jumpables.length}`);
    for (const obstacle of jumpables) {
      assert.ok(
        obstacle.height <= JUMP_APEX_M - 0.12,
        `${obstacle.id} 高度 ${obstacle.height}m 距跳跃最高点 ${JUMP_APEX_M}m 余量不足`,
      );
    }
  });

  it("不应存在 0.2–0.45m 的台阶式体块（物理没有 step-up，会被当成立墙）", () => {
    for (const obstacle of OBSTACLES) {
      assert.ok(
        obstacle.height <= 0.2 || obstacle.height >= 0.46,
        `${obstacle.id} 高度 ${obstacle.height}m 属于台阶区，玩家会被卡住`,
      );
    }
  });
});

describe("出生点", () => {
  it("应有 10 个出生点（5 T + 5 CT），朝向分别面向敌方半场", () => {
    assert.equal(SPAWN_POINTS.length, 10);
    const tSide = SPAWN_POINTS.filter((point) => point.team === "T");
    const ctSide = SPAWN_POINTS.filter((point) => point.team === "CT");
    assert.equal(tSide.length, 5);
    assert.equal(ctSide.length, 5);

    for (const point of tSide) {
      assert.equal(point.yaw, 0, "T 出生应面向 −Z（CT 方向）");
      assert.ok(point.z > 0, "T 出生点应在南半场");
    }
    for (const point of ctSide) {
      assert.ok(Math.abs(point.yaw) === Math.PI, "CT 出生应面向 +Z（T 方向）");
      assert.ok(point.z < 0, "CT 出生点应在北半场");
    }
  });

  it("出生点必须落在可玩区内（含玩家半径内缩）", () => {
    for (const point of SPAWN_POINTS) {
      assert.ok(
        point.x >= MAP_BOUNDS.minX + PLAYER_HIT_RADIUS && point.x <= MAP_BOUNDS.maxX - PLAYER_HIT_RADIUS,
        `(${point.x}, ${point.z}) 的 X 超出可玩区`,
      );
      assert.ok(
        point.z >= MAP_BOUNDS.minZ + PLAYER_HIT_RADIUS && point.z <= MAP_BOUNDS.maxZ - PLAYER_HIT_RADIUS,
        `(${point.x}, ${point.z}) 的 Z 超出可玩区`,
      );
    }
  });

  it("出生点不得落在任何 AABB 内（按 0.35m 玩家半径外扩）", () => {
    for (const point of SPAWN_POINTS) {
      for (const obstacle of OBSTACLES) {
        const minX = obstacle.x - obstacle.width / 2 - PLAYER_HIT_RADIUS;
        const maxX = obstacle.x + obstacle.width / 2 + PLAYER_HIT_RADIUS;
        const minZ = obstacle.z - obstacle.depth / 2 - PLAYER_HIT_RADIUS;
        const maxZ = obstacle.z + obstacle.depth / 2 + PLAYER_HIT_RADIUS;
        const overlapping = point.x > minX && point.x < maxX && point.z > minZ && point.z < maxZ;
        assert.ok(!overlapping, `出生点 (${point.x}, ${point.z}) 与 ${obstacle.id}(${obstacle.type}) 重叠`);
      }
    }
  });

  it("同一队伍内的出生点应彼此分开（≥ 1.5m，避免开局重叠）", () => {
    for (const team of ["T", "CT"] as const) {
      const points = SPAWN_POINTS.filter((point) => point.team === team);
      for (let i = 0; i < points.length; i += 1) {
        for (let j = i + 1; j < points.length; j += 1) {
          const a = points[i]!;
          const b = points[j]!;
          const distance = Math.hypot(a.x - b.x, a.z - b.z);
          assert.ok(distance >= 1.5, `${team} 的出生点 ${i} 与 ${j} 距离仅 ${distance.toFixed(2)}m`);
        }
      }
    }
  });
});

describe("连通性（0.5m 栅格洪泛）", () => {
  /** 按 0.35m 玩家半径把体块外扩后光栅化，再从 T 出生点洪泛。 */
  const buildReachable = (): {
    reachable: (x: number, z: number) => boolean;
    walkableCells: number;
    unreachableCells: number;
  } => {
    const step = 0.5;
    const cols = Math.round((MAP_BOUNDS.maxX - MAP_BOUNDS.minX) / step);
    const rows = Math.round((MAP_BOUNDS.maxZ - MAP_BOUNDS.minZ) / step);
    const blocked = new Uint8Array(cols * rows);

    const toCol = (x: number): number => Math.floor((x - MAP_BOUNDS.minX) / step);
    const toRow = (z: number): number => Math.floor((z - MAP_BOUNDS.minZ) / step);

    for (const obstacle of OBSTACLES) {
      const minX = obstacle.x - obstacle.width / 2 - PLAYER_HIT_RADIUS;
      const maxX = obstacle.x + obstacle.width / 2 + PLAYER_HIT_RADIUS;
      const minZ = obstacle.z - obstacle.depth / 2 - PLAYER_HIT_RADIUS;
      const maxZ = obstacle.z + obstacle.depth / 2 + PLAYER_HIT_RADIUS;
      for (let i = Math.max(0, toCol(minX)); i <= Math.min(cols - 1, toCol(maxX)); i += 1) {
        const x = MAP_BOUNDS.minX + (i + 0.5) * step;
        if (x < minX || x > maxX) {
          continue;
        }
        for (let j = Math.max(0, toRow(minZ)); j <= Math.min(rows - 1, toRow(maxZ)); j += 1) {
          const z = MAP_BOUNDS.minZ + (j + 0.5) * step;
          if (z >= minZ && z <= maxZ) {
            blocked[j * cols + i] = 1;
          }
        }
      }
    }

    const start = toRow(SPAWN_POINTS[0]!.z) * cols + toCol(SPAWN_POINTS[0]!.x);
    assert.equal(blocked[start], 0, "T 出生点自身不应被体块占据");
    const seen = new Uint8Array(cols * rows);
    const queue: number[] = [start];
    seen[start] = 1;
    let walkableCells = 0;
    for (let index = 0; index < blocked.length; index += 1) {
      if (blocked[index] === 0) {
        walkableCells += 1;
      }
    }

    while (queue.length > 0) {
      const current = queue.pop() as number;
      const i = current % cols;
      const j = Math.floor(current / cols);
      const neighbours: Array<[number, number]> = [
        [i + 1, j],
        [i - 1, j],
        [i, j + 1],
        [i, j - 1],
      ];
      for (const [ni, nj] of neighbours) {
        if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) {
          continue;
        }
        const next = nj * cols + ni;
        if (seen[next] === 1 || blocked[next] === 1) {
          continue;
        }
        seen[next] = 1;
        queue.push(next);
      }
    }

    let reached = 0;
    for (let index = 0; index < seen.length; index += 1) {
      if (seen[index] === 1) {
        reached += 1;
      }
    }

    return {
      reachable: (x: number, z: number): boolean => seen[toRow(z) * cols + toCol(x)] === 1,
      walkableCells,
      unreachableCells: walkableCells - reached,
    };
  };

  it("没有任何空地是走不到的（死角 = 0）", () => {
    const { unreachableCells, walkableCells } = buildReachable();
    assert.equal(
      unreachableCells,
      0,
      `有 ${unreachableCells} 格（约 ${(unreachableCells * 0.25).toFixed(1)} m²）空地无法到达，共 ${walkableCells} 格`,
    );
  });

  it("每个分区（A/B 点、三路、两个出生点）都可达", () => {
    const { reachable } = buildReachable();
    for (const zone of MAP_ZONES) {
      // 分区矩形允许压到墙上（例如 B 点的北墙那一带），所以按 1m 采样点
      // 判断"这块区域里有玩家能站的地方"，而不是死盯西南角。
      let found = false;
      for (let x = zone.minX + 0.5; x <= zone.maxX && !found; x += 1) {
        for (let z = zone.minZ + 0.5; z <= zone.maxZ && !found; z += 1) {
          if (reachable(x, z)) {
            found = true;
          }
        }
      }
      assert.ok(found, `分区「${zone.label}」整块都不可达`);
    }
  });

  it("全部出生点可达", () => {
    const { reachable } = buildReachable();
    for (const point of SPAWN_POINTS) {
      assert.ok(reachable(point.x, point.z), `出生点 (${point.x}, ${point.z}) 不可达`);
    }
  });
});
