/**
 * S6：小刀（服务端权威扇形判定）。
 *
 * 纯函数部分覆盖规格里的每一条口径：
 *   - 正面 55 / 背刺 100（目标朝向与「目标→攻击者」夹角 > 110°）
 *   - 夹角 100° 不算背刺（边界必须严）
 *   - 扇形 ±35°：40° 打不到
 *   - 水平距离 2.0m：2.05m 打不到（3m 更不用说）
 *   - |Δy| > 1.6m 打不到（隔台/隔层砍人）
 *   - 多人时取最近的一个
 *
 * 集成部分覆盖 handler 的闸门：槽位必须是刀、650ms 冷却内第二次无效、挥空也广播。
 */

import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";

import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import {
  DEFAULT_ROOM_NAME,
  MELEE_COOLDOWN_MS,
  MELEE_DAMAGE_BACK,
  MELEE_DAMAGE_FRONT,
  MELEE_RANGE,
  MESSAGE_TYPES,
  PLAYER_MAX_HP,
  PROTOCOL_VERSION,
  WEAPON_SLOTS,
} from "@colyseus-fps/shared";
import { Client, type Room } from "colyseus.js";

import { resolveKnife } from "../src/rooms/melee.js";
import type { CombatantView } from "../src/rooms/combat.js";
import { FPSBattleRoom } from "../src/rooms/fps-battle-room.js";

function fighter(id: string, x: number, z: number, yaw: number, y = 0): CombatantView {
  return { sessionId: id, x, y, z, yaw, pitch: 0, alive: true, weaponSlot: WEAPON_SLOTS.KNIFE };
}

/** 攻击者站在原点朝 −Z（yaw = 0），目标放在这个极坐标上。 */
function targetAt(distance: number, bearingRad: number, yaw: number, id = "B"): CombatantView {
  // bearing 以攻击者正前方（−Z）为 0，正值偏向 +X
  return fighter(id, Math.sin(bearingRad) * distance, -Math.cos(bearingRad) * distance, yaw);
}

describe("resolveKnife 几何判定", () => {
  it("正面命中：55 伤害、backstab=false", () => {
    // 目标在正前方 1.5m，且面朝攻击者（yaw = π → forward = +Z）
    const result = resolveKnife([fighter("A", 0, 0, 0), targetAt(1.5, 0, Math.PI)], "A");
    assert.ok(result !== null);
    assert.equal(result.hitPlayerId, "B");
    assert.equal(result.damage, MELEE_DAMAGE_FRONT);
    assert.equal(result.damage, 55);
    assert.equal(result.backstab, false);
  });

  it("背刺（夹角 120°）：100 伤害", () => {
    // 目标 yaw = 60°：forward = (−sin60, −cos60)，与「目标→攻击者」(0,+1) 夹角 120°
    const result = resolveKnife([fighter("A", 0, 0, 0), targetAt(1.5, 0, Math.PI / 3)], "A");
    assert.ok(result !== null);
    assert.equal(result.hitPlayerId, "B");
    assert.equal(result.backstab, true);
    assert.equal(result.damage, MELEE_DAMAGE_BACK);
    assert.equal(result.damage, 100);
  });

  it("夹角 100° 不算背刺（阈值 110° 必须严）", () => {
    // 目标 yaw = 80°：与「目标→攻击者」夹角 = 100° < 110°
    const result = resolveKnife([fighter("A", 0, 0, 0), targetAt(1.5, 0, (80 * Math.PI) / 180)], "A");
    assert.ok(result !== null);
    assert.equal(result.backstab, false, "100° 应判正面");
    assert.equal(result.damage, MELEE_DAMAGE_FRONT);
  });

  it("扇形 ±35°：正前方 30° 命中、40° 打不到", () => {
    const inside = resolveKnife(
      [fighter("A", 0, 0, 0), targetAt(1.2, (30 * Math.PI) / 180, Math.PI)],
      "A",
    );
    assert.equal(inside?.hitPlayerId, "B", "30° 在 ±35° 扇形内");

    const outside = resolveKnife(
      [fighter("A", 0, 0, 0), targetAt(1.2, (40 * Math.PI) / 180, Math.PI)],
      "A",
    );
    assert.ok(outside !== null);
    assert.equal(outside.hitPlayerId, null, "40° 超出扇形，不应命中");
    assert.equal(outside.damage, 0);
  });

  it("2.05m 打不到、1.95m 能打到（射程边界 2.0m）", () => {
    assert.equal(MELEE_RANGE, 2);
    const near = resolveKnife([fighter("A", 0, 0, 0), targetAt(1.95, 0, Math.PI)], "A");
    assert.equal(near?.hitPlayerId, "B");

    const far = resolveKnife([fighter("A", 0, 0, 0), targetAt(2.05, 0, Math.PI)], "A");
    assert.equal(far?.hitPlayerId, null, "2.05m 超出 2.0m 射程");
  });

  it("3 米外打不到", () => {
    const result = resolveKnife([fighter("A", 0, 0, 0), targetAt(3, 0, Math.PI)], "A");
    assert.equal(result?.hitPlayerId, null);
  });

  it("|Δy| > 1.6m 打不到（隔台砍人）", () => {
    const target = fighter("B", 0, -1.2, Math.PI);
    target.y = 1.7;
    assert.equal(resolveKnife([fighter("A", 0, 0, 0), target], "A")?.hitPlayerId, null);

    target.y = 1.5;
    assert.equal(resolveKnife([fighter("A", 0, 0, 0), target], "A")?.hitPlayerId, "B");
  });

  it("多人同时在扇形内时取最近的一个", () => {
    const players = [
      fighter("A", 0, 0, 0),
      targetAt(1.8, 0, Math.PI, "far"),
      targetAt(0.9, (10 * Math.PI) / 180, Math.PI, "near"),
    ];
    const result = resolveKnife(players, "A");
    assert.equal(result?.hitPlayerId, "near");
  });

  it("死亡玩家不能被砍，死亡玩家也不能挥刀", () => {
    const dead = fighter("B", 0, -1.2, Math.PI);
    dead.alive = false;
    assert.equal(resolveKnife([fighter("A", 0, 0, 0), dead], "A")?.hitPlayerId, null);

    const deadAttacker = fighter("A", 0, 0, 0);
    deadAttacker.alive = false;
    assert.equal(resolveKnife([deadAttacker, fighter("B", 0, -1.2, Math.PI)], "A"), null);
  });

  it("挥空也返回消息（远端靠它播挥刀动作），刀光起点在攻击者右手", () => {
    const result = resolveKnife([fighter("A", 0, 0, 0)], "A");
    assert.ok(result !== null);
    assert.equal(result.hitPlayerId, null);
    assert.equal(result.damage, 0);
    // 手部位置：右 0.24 / 高 1.12 / 前 0.20（与化身 HAND_ANCHOR_WORLD 一致）
    assert.ok(Math.abs(result.x - 0.24) < 1e-9);
    assert.ok(Math.abs(result.y - 1.12) < 1e-9);
    assert.ok(Math.abs(result.z - -0.2) < 1e-9);
  });

  it("视角快照可覆盖服务端已存朝向（转身挥刀打对面）", () => {
    const players = [fighter("A", 0, 0, 0), fighter("B", 1.2, 0, -Math.PI / 2)];
    // 用已存 yaw（朝 −Z）打不到右侧的目标
    assert.equal(resolveKnife(players, "A")?.hitPlayerId, null);
    // 用快照 yaw = −π/2（朝 +X）就能打到
    assert.equal(resolveKnife(players, "A", { yaw: -Math.PI / 2, pitch: 0 })?.hitPlayerId, "B");
  });
});

/* ------------------------------------------------------------------ *
 * 集成：handler 闸门（槽位 / 冷却）
 * ------------------------------------------------------------------ */

interface PlayerLike {
  hp: number;
  alive: boolean;
  weaponSlot: number;
  switchEndAt: number;
  x: number;
  z: number;
}

interface StateLike {
  players: Map<string, PlayerLike>;
}

let httpServer: http.Server;
let gameServer: Server;
let serverPort: number;

function stateOf(room: Room): StateLike {
  return room.state as unknown as StateLike;
}

async function waitFor(condition: () => boolean, description: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`等待超时：${description}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

before(async () => {
  httpServer = http.createServer();
  const transport = new WebSocketTransport({ server: httpServer, pingInterval: 0 });
  gameServer = new Server({ transport, greet: false, gracefullyShutdown: false });
  gameServer.define(DEFAULT_ROOM_NAME, FPSBattleRoom, { logLevel: "silent" });
  await gameServer.listen(0, "127.0.0.1");

  const address = httpServer.address();
  assert.ok(address !== null && typeof address === "object");
  serverPort = address.port;
});

after(async () => {
  await gameServer.gracefullyShutdown(false);
});

describe("KNIFE handler 闸门", () => {
  it("非刀槽挥刀无效；650ms 冷却内第二次无效；到期后生效", { timeout: 40000 }, async () => {
    const join = (name: string) => ({ name, protocolVersion: PROTOCOL_VERSION });
    const roomA = (await new Client(`ws://127.0.0.1:${serverPort}`).joinOrCreate(
      DEFAULT_ROOM_NAME,
      join("Knifer"),
    )) as Room;
    const roomB = (await new Client(`ws://127.0.0.1:${serverPort}`).joinOrCreate(
      DEFAULT_ROOM_NAME,
      join("Victim"),
    )) as Room;

    const results: Array<{ hitPlayerId: string | null; damage: number }> = [];
    roomA.onMessage(MESSAGE_TYPES.KNIFE_RESULT, (message: { hitPlayerId: string | null; damage: number }) => {
      results.push({ hitPlayerId: message.hitPlayerId, damage: message.damage });
    });

    try {
      await waitFor(() => (stateOf(roomA).players?.size ?? 0) === 2, "双方进入同一房间");

      // A 在 z=8 朝 −Z；B 在 z=6.5 朝 +Z（面对面，相距 1.5m，正面命中 55）
      roomA.send(MESSAGE_TYPES.PLAYER_TRANSFORM, { seq: 1, x: -1.5, y: 0, z: 8, yaw: 0, pitch: 0 });
      roomB.send(MESSAGE_TYPES.PLAYER_TRANSFORM, { seq: 1, x: -1.5, y: 0, z: 6.5, yaw: Math.PI, pitch: 0 });
      await waitFor(() => {
        const b = stateOf(roomA).players.get(roomB.sessionId);
        return b !== undefined && Math.abs(b.z - 6.5) < 0.05;
      }, "位置同步完成");

      // ① 拿枪时挥刀必须无效
      roomA.send(MESSAGE_TYPES.KNIFE, { yaw: 0, pitch: 0 });
      await sleep(250);
      assert.equal(results.length, 0, "步枪槽不应广播 KNIFE_RESULT");
      assert.equal(stateOf(roomA).players.get(roomB.sessionId)!.hp, PLAYER_MAX_HP);

      // ② 切到刀，等切枪结束
      roomA.send(MESSAGE_TYPES.WEAPON_SWITCH, { slot: WEAPON_SLOTS.KNIFE });
      await waitFor(
        () => stateOf(roomA).players.get(roomA.sessionId)!.weaponSlot === WEAPON_SLOTS.KNIFE,
        "应切到小刀",
      );
      await waitFor(
        () => stateOf(roomA).players.get(roomA.sessionId)!.switchEndAt <= Date.now(),
        "切枪动画结束",
        3000,
      );

      // ③ 第一次挥刀：正面命中 55
      roomA.send(MESSAGE_TYPES.KNIFE, { yaw: 0, pitch: 0 });
      await waitFor(
        () => stateOf(roomA).players.get(roomB.sessionId)!.hp === PLAYER_MAX_HP - MELEE_DAMAGE_FRONT,
        "正面命中应扣 55",
      );
      assert.equal(results.length, 1);
      assert.equal(results[0]!.damage, MELEE_DAMAGE_FRONT);
      assert.equal(results[0]!.hitPlayerId, roomB.sessionId);

      // ④ 冷却内立刻再挥：必须被丢弃（hp 不变、也没有新广播）
      roomA.send(MESSAGE_TYPES.KNIFE, { yaw: 0, pitch: 0 });
      await sleep(Math.floor(MELEE_COOLDOWN_MS / 3));
      assert.equal(results.length, 1, "冷却内不应广播第二次挥刀");
      assert.equal(
        stateOf(roomA).players.get(roomB.sessionId)!.hp,
        PLAYER_MAX_HP - MELEE_DAMAGE_FRONT,
        "冷却内第二次挥刀不应扣血",
      );

      // ⑤ 冷却结束后再挥：第二刀致死（55 + 55 > 100）
      await sleep(MELEE_COOLDOWN_MS);
      roomA.send(MESSAGE_TYPES.KNIFE, { yaw: 0, pitch: 0 });
      await waitFor(() => stateOf(roomA).players.get(roomB.sessionId)!.alive === false, "第二刀应击杀");
      assert.equal(results.length, 2);
      assert.equal(stateOf(roomA).players.get(roomB.sessionId)!.hp, 0);
    } finally {
      await roomA.leave();
      await roomB.leave();
    }
  });
});
