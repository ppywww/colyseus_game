/**
 * 投掷物球-AABB 反弹物理测试（shared 层纯函数）。
 *
 * 这些用例守护三件事：
 *   1. 手雷撞掩体后**不穿模**（含高速 + 大 dt 的极端情况，靠子步进保证）；
 *   2. 落点行为与旧服务端一致（地面高度 = GRENADE_RADIUS、箱顶 = maxY + GRENADE_RADIUS）；
 *   3. 客户端与服务端调的是同一个函数，因此这里的断言同时约束两端轨迹。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GRENADE_RADIUS, MAP_BOUNDS, type Aabb } from "../src/index.js";
// 直接引用物理模块而不是 index 的再导出：这样本文件在"物理模块先落地"的提交里就能独立跑绿，
// 应用层经由 index.js 的再导出路径由 `pnpm -r typecheck` 覆盖。
import { stepGrenadePhysics, type GrenadeBody } from "../src/grenade-physics.js";

/** 一面 2m 厚、3m 高的墙：x ∈ [0, 2], z ∈ [-2, 2]。 */
const WALL: Aabb = { minX: 0, maxX: 2, minY: 0, maxY: 3, minZ: -2, maxZ: 2 };

/** 一块 2m 高的箱体：x/z ∈ [-1, 1]。 */
const CRATE: Aabb = { minX: -1, maxX: 1, minY: 0, maxY: 2, minZ: -1, maxZ: 1 };

function makeBody(overrides: Partial<GrenadeBody> = {}): GrenadeBody {
  return { x: 0, y: 1.5, z: 0, vx: 0, vy: 0, vz: 0, ...overrides };
}

describe("stepGrenadePhysics 撞墙反弹", () => {
  it("水平投向墙面：速度反向，且全程停在 maxX + 半径 之外（不穿模）", () => {
    // 从墙的 +X 侧向 -X 投出（墙的 maxX 面 = 2）
    const body = makeBody({ x: 2.6, y: 1.5, vx: -6, vy: 0, vz: 0 });
    const limit = WALL.maxX + GRENADE_RADIUS;
    let sawApproach = false;

    for (let i = 0; i < 20; i += 1) {
      stepGrenadePhysics(body, 1 / 60, [WALL]);
      assert.ok(
        body.x >= limit - 1e-9,
        `第 ${i} 步穿进墙里：x=${body.x}，应 ≥ ${limit}`,
      );
      if (body.vx < 0) {
        sawApproach = true;
      }
    }

    assert.ok(sawApproach, "被弹回前应先朝墙运动（用例本身应真的撞到墙）");
    assert.ok(body.vx > 0, `撞墙后 vx 应变正，实际 ${body.vx}`);
    assert.ok(body.x > limit, `撞墙后应远离墙面，实际 x=${body.x}`);
  });

  it("高速 + 薄墙 + 大 dt（vx=40, 0.4m 厚, dt=1/30）仍然不穿透", () => {
    // 单帧位移 1.33m，若不分片会直接跨过 0.4m 厚的墙
    const thinWall: Aabb = { minX: 5, maxX: 5.4, minY: 0, maxY: 3, minZ: -2, maxZ: 2 };
    const body = makeBody({ x: 0, y: 1.2, vx: 40, vy: 0, vz: 0 });
    const limit = thinWall.minX - GRENADE_RADIUS;

    for (let i = 0; i < 12; i += 1) {
      stepGrenadePhysics(body, 1 / 30, [thinWall]);
      assert.ok(
        body.x <= limit + 1e-6,
        `第 ${i} 步穿过薄墙：x=${body.x}，应 ≤ ${limit}（单帧位移 1.33m > 墙厚 0.4m，靠子步进拦住）`,
      );
    }

    assert.ok(body.vx < 0, `撞薄墙后 vx 应变负，实际 ${body.vx}`);
  });

  it("斜向撞墙时切向速度按 WALL_FRICTION 衰减（不沿墙滑冰）", () => {
    const body = makeBody({ x: 2.6, y: 1.5, vx: -6, vy: 0, vz: 5 });
    for (let i = 0; i < 20; i += 1) {
      stepGrenadePhysics(body, 1 / 60, [WALL]);
    }
    assert.ok(body.vx > 0, "法向速度应反向");
    assert.ok(Math.abs(body.vz) < 5, `切向速度应被摩擦衰减，实际 vz=${body.vz}`);
  });
});

describe("stepGrenadePhysics 落地行为", () => {
  it("从箱体正上方落下：停在 maxY + 半径，且垂直速度被反弹过", () => {
    const body = makeBody({ x: 0, y: 4, vx: 0, vy: 0, vz: 0 });
    const restY = CRATE.maxY + GRENADE_RADIUS;
    let bounced = false;

    for (let i = 0; i < 90; i += 1) {
      stepGrenadePhysics(body, 1 / 60, [CRATE]);
      assert.ok(
        body.y >= restY - 1e-6,
        `第 ${i} 步穿进箱体：y=${body.y}，应 ≥ ${restY}`,
      );
      if (body.vy > 0) {
        bounced = true;
      }
    }

    assert.ok(bounced, "落到箱顶应产生一次向上反弹");
    assert.ok(Math.abs(body.y - restY) < 1e-6, `最终应静止在箱顶 ${restY}，实际 ${body.y}`);
    assert.ok(Math.abs(body.x) < 1e-9 && Math.abs(body.z) < 1e-9, "垂直落下不应产生水平位移");
  });

  it("自由落体到地面：停在 GRENADE_RADIUS，不下沉", () => {
    const body = makeBody({ x: 0, y: 3, vx: 0, vy: 0, vz: 0 });
    for (let i = 0; i < 120; i += 1) {
      stepGrenadePhysics(body, 1 / 60, []);
      assert.ok(body.y >= GRENADE_RADIUS - 1e-9, `第 ${i} 步沉入地面：y=${body.y}`);
    }
    assert.ok(Math.abs(body.y - GRENADE_RADIUS) < 1e-9, `应停在地面高度 ${GRENADE_RADIUS}，实际 ${body.y}`);
  });

  it("静置在地面：多步后不漂移、不下沉", () => {
    const body = makeBody({ x: 0, y: GRENADE_RADIUS, vx: 0, vy: 0, vz: 0 });
    for (let i = 0; i < 200; i += 1) {
      stepGrenadePhysics(body, 1 / 60, []);
    }
    assert.ok(Math.abs(body.x) < 1e-9, `静置不应漂移，实际 x=${body.x}`);
    assert.ok(Math.abs(body.z) < 1e-9, `静置不应漂移，实际 z=${body.z}`);
    assert.ok(body.y >= GRENADE_RADIUS - 1e-9, `静置不应下沉，实际 y=${body.y}`);
    assert.ok(Math.abs(body.vy) < 1e-9, `静置垂直速度应为 0，实际 ${body.vy}`);
  });
});

describe("stepGrenadePhysics 场地边界", () => {
  it("飞出场地时被矩形外墙钳制并反向（不会跑到 MAP_BOUNDS 之外）", () => {
    const body = makeBody({ x: MAP_BOUNDS.maxX - 3, y: 1, vx: 20, vy: 0, vz: 0 });
    const limit = MAP_BOUNDS.maxX - GRENADE_RADIUS;

    for (let i = 0; i < 120; i += 1) {
      stepGrenadePhysics(body, 1 / 60, []);
      assert.ok(body.x <= limit + 1e-9, `第 ${i} 步越界：x=${body.x}，应 ≤ ${limit}`);
      assert.ok(body.x >= MAP_BOUNDS.minX + GRENADE_RADIUS - 1e-9, `第 ${i} 步越界：x=${body.x}`);
      assert.ok(body.z <= MAP_BOUNDS.maxZ - GRENADE_RADIUS + 1e-9, `第 ${i} 步越界：z=${body.z}`);
      assert.ok(body.z >= MAP_BOUNDS.minZ + GRENADE_RADIUS - 1e-9, `第 ${i} 步越界：z=${body.z}`);
    }

    assert.ok(body.vx < 0, `撞到边界后 vx 应变负，实际 ${body.vx}`);
  });
});

describe("stepGrenadePhysics 异常输入", () => {
  it("dt ≤ 0 或非有限数时不做任何修改", () => {
    const body = makeBody({ x: 1, y: 2, z: 3, vx: 4, vy: 5, vz: 6 });
    stepGrenadePhysics(body, 0, []);
    stepGrenadePhysics(body, -1, []);
    stepGrenadePhysics(body, Number.NaN, []);
    assert.deepEqual(body, { x: 1, y: 2, z: 3, vx: 4, vy: 5, vz: 6 });
  });

  it("真实地图：朝 W2 市场建筑群投出不会穿进建筑内部", () => {
    // W2: x −20…−8, z −2…22, 高 4m（shared 的 OBSTACLES 数据）
    const W2: Aabb = { minX: -20, maxX: -8, minY: 0, maxY: 4, minZ: -2, maxZ: 22 };
    const body = makeBody({ x: -4, y: 1.4, vx: -14, vy: 2, vz: 0 });

    for (let i = 0; i < 240; i += 1) {
      stepGrenadePhysics(body, 1 / 60, [W2]);
      const insideX = body.x > W2.minX - GRENADE_RADIUS + 1e-6 && body.x < W2.maxX + GRENADE_RADIUS - 1e-6;
      const insideZ = body.z > W2.minZ - GRENADE_RADIUS + 1e-6 && body.z < W2.maxZ + GRENADE_RADIUS - 1e-6;
      const insideY = body.y > W2.minY + 1e-6 && body.y < W2.maxY - 1e-6;
      assert.ok(
        !(insideX && insideZ && insideY),
        `第 ${i} 步手雷位于 W2 内部：(${body.x.toFixed(2)}, ${body.y.toFixed(2)}, ${body.z.toFixed(2)})`,
      );
    }
  });
});
