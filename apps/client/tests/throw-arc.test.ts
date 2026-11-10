/**
 * 投掷抛物线（`throw-arc`）的几何约定测试。
 *
 * 这组用例守护的是"**预览线就是真实弹道**"这条承诺：
 *   1. 点必须等弧长分布（旧版按 0.1s 采样，出手处 2.1m 一个点、落地前 0.1m 一个点，
 *      画出来是"一串水泡"，根本看不出弧）；
 *   2. 第一个点必须已经越过近处起步距离（旧版第一个点就在脸前 45cm，
 *      3D 小球在那个距离会画成一块盖住半个屏幕的大圆盘——用户反馈的"抛物线显示有问题"）；
 *   3. 落点必须贴地，且朝墙扔时不能穿墙；
 *   4. 自由飞行段必须真的符合 y = y0 − ½gt²（用闭合解反查，防止积分配错重力）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CROUCH_EYE_HEIGHT,
  EYE_HEIGHT,
  GRENADE_RADIUS,
  GRENADE_GRAVITY,
  THROW_ORIGIN_DROP,
  THROW_ORIGIN_FORWARD,
  THROW_ORIGIN_SIDE,
  THROW_SPEED,
  throwOriginOf,
  type Aabb,
} from "@colyseus-fps/shared";

import {
  ARC_MAX_POINTS,
  ARC_MIN_GAP,
  ARC_SIM_STEP_SECONDS,
  ARC_SPACING_RATIO,
  ARC_START_DISTANCE,
  computeThrowArc,
} from "../src/game/throw-arc.js";

const NO_OBSTACLES: readonly Aabb[] = [];

/** 一面 2m 厚、3m 高的墙：x ∈ [0, 2], z ∈ [−4, 4]。 */
const WALL: Aabb = { minX: 0, maxX: 2, minY: 0, maxY: 3, minZ: -4, maxZ: 4 };

/** 站立平视投掷的出手点（与 `Game#throwDirection` 的水平方向一致：朝 −Z）。 */
function levelOrigin(): { x: number; y: number; z: number } {
  return throwOriginOf(0, 0, 0, { x: 0, y: 0, z: -1 }, EYE_HEIGHT);
}

function distance(
  left: { x: number; y: number; z: number },
  right: { x: number; y: number; z: number },
): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

describe("投掷抛物线几何", () => {
  it("平视投掷：必须落到地面，且不再是「一串越来越小的点」", () => {
    const origin = levelOrigin();
    const arc = computeThrowArc(origin, { x: 0, y: 0, z: -1 }, THROW_SPEED, NO_OBSTACLES);

    assert.ok(arc.endpoint !== null);
    // 手雷引信 2.2s，平视投掷在 0.5s 就落地 → 生效点必然贴地
    assert.ok(
      Math.abs(arc.endpoint.y - GRENADE_RADIUS) < 0.02,
      `生效点应贴地，实际 y=${arc.endpoint.y.toFixed(3)}`,
    );
    assert.ok(arc.atGround, "贴地的生效点必须标记 atGround（环才能平铺）");
    assert.ok(arc.endpoint.z < origin.z, "必须朝前（−Z）落，不能落在身后");
    assert.ok(arc.points.length >= 6, `点数过少（${arc.points.length}），看不出弧`);
    assert.ok(arc.points.length <= ARC_MAX_POINTS);
  });

  it("第一个点必须越过起步距离（不能糊在镜头前）", () => {
    const origin = levelOrigin();
    const arc = computeThrowArc(origin, { x: 0, y: 0, z: -1 }, THROW_SPEED, NO_OBSTACLES);
    const first = arc.points[0];
    assert.ok(first !== undefined);
    const offset = distance(first, origin);
    assert.ok(
      offset >= ARC_START_DISTANCE - 1e-6,
      `第一个点离出手点只有 ${offset.toFixed(2)}m，会糊在屏幕上`,
    );
    // 也不能让出太多，否则手上那一段"断掉"了
    assert.ok(offset < ARC_START_DISTANCE + ARC_MIN_GAP, `第一个点太远：${offset.toFixed(2)}m`);
  });

  it("相邻点的半径按等比递增（贴手那段受最小间距保护）", () => {
    const origin = levelOrigin();
    const arc = computeThrowArc(origin, { x: 0, y: 0, z: -1 }, THROW_SPEED, NO_OBSTACLES);
    const radii = arc.points.map((point) => distance(point, origin));
    for (let index = 1; index < radii.length; index += 1) {
      const gap = radii[index]! - radii[index - 1]!;
      // 贴手那几段由最小间距兜底（约 0.35m 一步），要到 r≈1.5m 之后才吃得下等比步长，
      // 所以等比只查后段；量化误差（每隔 6ms 才判一次）留 3% 余量。
      if (index >= 6) {
        const ratio = radii[index]! / radii[index - 1]!;
        assert.ok(
          ratio <= ARC_SPACING_RATIO + 0.03,
          `第 ${index} 段半径比 ${ratio.toFixed(3)} 超过 ${ARC_SPACING_RATIO}（会跳点）`,
        );
      }
      assert.ok(gap >= ARC_MIN_GAP - 0.02, `第 ${index} 段间距 ${gap.toFixed(3)}m 太密，会挤成一片`);
    }
  });

  it("自由飞行段必须符合 y = y₀ − ½gt²（重力不能被写错）", () => {
    const origin = levelOrigin();
    const speed = THROW_SPEED;
    const arc = computeThrowArc(origin, { x: 0, y: 0, z: -1 }, speed, NO_OBSTACLES);

    let checked = 0;
    for (const point of arc.points) {
      // 水平速度恒为 −speed（无阻力），因此时间可由 z 反解
      const seconds = (origin.z - point.z) / speed;
      const expected = origin.y - 0.5 * GRENADE_GRAVITY * seconds * seconds;
      // 落地前才成立；落地弹跳之后不再适用
      if (expected < GRENADE_RADIUS) {
        break;
      }
      // 半隐式欧拉在"恒定重力"下会稳定低于解析解 ½·g·h·t，这是离散化的固有偏差，
      // 不是 bug：容差就按这个尺度给，写死一个魔数反而看不出它从哪来。
      const discretization = 0.5 * GRENADE_GRAVITY * ARC_SIM_STEP_SECONDS * seconds;
      assert.ok(
        Math.abs(point.y - expected) <= discretization + 2e-3,
        `t=${seconds.toFixed(3)}s 时高度 ${point.y.toFixed(3)} 与闭合解 ${expected.toFixed(3)} 不符` +
          `（允许离散化偏差 ${(discretization * 1000).toFixed(1)}mm）`,
      );
      checked += 1;
    }
    assert.ok(checked >= 3, `只校验到 ${checked} 个点，样本不足`);
  });

  it("上抛：弧必须先升后降，且顶点高于出手点", () => {
    const origin = levelOrigin();
    const dir = { x: 0, y: Math.sin(0.6), z: -Math.cos(0.6) };
    const arc = computeThrowArc(origin, dir, THROW_SPEED, NO_OBSTACLES);

    const apex = Math.max(...arc.points.map((point) => point.y));
    assert.ok(apex > origin.y + 1, `上抛顶点只到 ${apex.toFixed(2)}m，没抬起来`);
    assert.ok(arc.endpoint !== null && arc.endpoint.y < apex, "生效点必须低于顶点");
  });

  it("朝墙扔：不得穿墙，落点在墙面这一侧", () => {
    // 从 x=−6 朝 +X 平抛，墙在 x ∈ [0, 2]
    const origin = { x: -6, y: EYE_HEIGHT - THROW_ORIGIN_DROP, z: 0 };
    const arc = computeThrowArc(origin, { x: 1, y: 0, z: 0 }, THROW_SPEED, [WALL]);

    for (const point of arc.points) {
      assert.ok(
        point.x <= WALL.minX - GRENADE_RADIUS + 1e-2,
        `点穿进墙里了：x=${point.x.toFixed(3)}`,
      );
    }
    assert.ok(arc.endpoint !== null, "撞墙后应当回弹落地");
    assert.ok(arc.endpoint.x < WALL.minX, `生效点在墙里：x=${arc.endpoint.x.toFixed(3)}`);
  });

  it("超长轨迹也不越界，且必须给出生效点", () => {
    // 6 倍速 + 长引信：半径增长极快，点数会贴近上限
    const arc = computeThrowArc(levelOrigin(), { x: 0, y: 0, z: -1 }, THROW_SPEED * 6, NO_OBSTACLES, 20);
    assert.ok(arc.points.length <= ARC_MAX_POINTS, `点数必须封顶，实际 ${arc.points.length}`);
    assert.ok(arc.points.length >= 8, `长轨迹的点太少（${arc.points.length}），线会断成一截`);
    assert.ok(arc.endpoint !== null, "封顶后也必须继续积分到生效点");
  });

  it("非法输入必须安全（NaN / 无穷 / 零速）", () => {
    const broken = computeThrowArc({ x: Number.NaN, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, THROW_SPEED, NO_OBSTACLES);
    assert.deepEqual(broken.points, []);
    assert.equal(broken.endpoint, null);

    const badDir = computeThrowArc({ x: 0, y: 1.4, z: 0 }, { x: Infinity, y: 0, z: 0 }, THROW_SPEED, NO_OBSTACLES);
    assert.deepEqual(badDir.points, []);

    // 零速 = 原地掉落：落点几乎就在脚下，不能抛异常也不能画出一堆点
    const dropped = computeThrowArc({ x: 3, y: 1.4, z: 7 }, { x: 0, y: 0, z: -1 }, 0, NO_OBSTACLES);
    assert.ok(dropped.endpoint !== null);
    assert.ok(Math.abs(dropped.endpoint.y - GRENADE_RADIUS) < 0.02);
    assert.ok(Math.abs(dropped.endpoint.x - 3) < 0.01 && Math.abs(dropped.endpoint.z - 7) < 0.01);
    // 垂直下落只有竖直位移：点必须是"一根竖线"，不能因为取样逻辑跑偏
    for (const point of dropped.points) {
      assert.ok(Math.abs(point.x - 3) < 1e-9 && Math.abs(point.z - 7) < 1e-9);
    }
    assert.ok(dropped.points.length <= 6, `零速不该画出 ${dropped.points.length} 个点`);
  });
});

describe("投掷出手点（两端共用）", () => {
  it("沿视线前伸、比眼睛低 THROW_ORIGIN_DROP、并向右偏移一个手宽", () => {
    // 朝 −Z 时右手 = +X
    const origin = throwOriginOf(1, 0.5, 2, { x: 0, y: 0, z: -1 }, EYE_HEIGHT);
    assert.equal(origin.z, 2 - THROW_ORIGIN_FORWARD);
    assert.equal(origin.y, 0.5 + EYE_HEIGHT - THROW_ORIGIN_DROP);
    assert.ok(
      Math.abs(origin.x - (1 + THROW_ORIGIN_SIDE)) < 1e-9,
      `朝 −Z 时出手点应向 +X 偏 ${THROW_ORIGIN_SIDE}m，实际 x=${origin.x}`,
    );
  });

  it("转身 90° 后右手方向跟着转（不能永远往 +X 偏）", () => {
    // 朝 −X 时，右手 = −Z
    const origin = throwOriginOf(0, 0, 0, { x: -1, y: 0, z: 0 }, EYE_HEIGHT);
    assert.ok(Math.abs(origin.x - (-THROW_ORIGIN_FORWARD)) < 1e-9);
    assert.ok(
      Math.abs(origin.z - (-THROW_ORIGIN_SIDE)) < 1e-9,
      `朝 −X 时右手应是 −Z，实际 z=${origin.z}`,
    );
  });

  it("抬枪投掷时出手点跟着抬高（旧版漏了 dir.y 那一项）", () => {
    const level = throwOriginOf(0, 0, 0, { x: 0, y: 0, z: -1 }, EYE_HEIGHT);
    const upward = throwOriginOf(0, 0, 0, { x: 0, y: 0.5, z: -0.866 }, EYE_HEIGHT);
    assert.ok(
      Math.abs(upward.y - (level.y + 0.5 * THROW_ORIGIN_FORWARD)) < 1e-9,
      "竖直分量必须参与出手点计算",
    );
  });

  it("蹲下投掷的出手点必须跟着下沉（旧版硬写站立眼高）", () => {
    const standing = throwOriginOf(0, 0, 0, { x: 0, y: 0, z: -1 }, EYE_HEIGHT);
    const crouched = throwOriginOf(0, 0, 0, { x: 0, y: 0, z: -1 }, CROUCH_EYE_HEIGHT);
    assert.ok(standing.y - crouched.y > 0.5, "蹲投的雷不能从头顶飞出去");
  });
});

describe("引信截断（生效点 ≠ 滚到哪儿停）", () => {
  it("高抛时烟雾引信先到点：生效点必须远早于「滚到停」的位置", () => {
    // 45° 满力：静止在 ~36m/2.7s，但烟雾 1.4s 就要起烟（此时才 21m 左右）。
    // 若按"最终静止点"画环，等于告诉玩家一个雷根本到不了的位置。
    const dir = { x: 0, y: Math.sin(Math.PI / 4), z: -Math.cos(Math.PI / 4) };
    const smoke = computeThrowArc(levelOrigin(), dir, THROW_SPEED, NO_OBSTACLES, 1.4);
    const rested = computeThrowArc(levelOrigin(), dir, THROW_SPEED, NO_OBSTACLES, 5);
    assert.ok(smoke.endpoint !== null && rested.endpoint !== null);
    const gap = Math.hypot(smoke.endpoint.x - rested.endpoint.x, smoke.endpoint.z - rested.endpoint.z);
    assert.ok(gap > 5, `1.4s 生效点与静止点只差 ${gap.toFixed(2)}m，引信没生效`);
    assert.equal(smoke.atGround, false, "45° 高抛 1.4s 时还在空中，环不能平铺");
  });

  it("很短引信：生效点必须离地（空中引爆 → 环要正对镜头）", () => {
    const arc = computeThrowArc(
      levelOrigin(),
      { x: 0, y: Math.sin(0.5), z: -Math.cos(0.5) },
      THROW_SPEED,
      NO_OBSTACLES,
      0.25,
    );
    assert.ok(arc.endpoint !== null);
    assert.ok(arc.endpoint.y > 1, `0.25s 时雷还在空中，y=${arc.endpoint.y.toFixed(2)}`);
    assert.equal(arc.atGround, false);
  });
});
