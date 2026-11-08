/**
 * 回归测试：双向对射必须对称扣血。
 *
 * 背景：实际联机中出现「玩家1 打玩家2 有伤害，玩家2 打玩家1 不扣血」。
 * 本用例把双方摆在同一直线上互相面对，交替开火，验证两个方向都扣血。
 *
 * 场景：A(−1.5,0,7) yaw=0 朝 -Z；B(−1.5,0,1) yaw=π 朝 +Z；中间无掩体（中路空走廊）。
 */

import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";

import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import {
  DEFAULT_ROOM_NAME,
  MESSAGE_TYPES,
  PLAYER_MAX_HP,
  PROTOCOL_VERSION,
  WEAPON_COOLDOWN_MS,
  WEAPON_DAMAGE,
} from "@colyseus-fps/shared";
import { Client, type Room } from "colyseus.js";

import { FPSBattleRoom } from "../src/rooms/fps-battle-room.js";

const HOST = "127.0.0.1";
const WAIT_TIMEOUT_MS = 8000;
const WAIT_POLL_MS = 25;

interface PlayerLike {
  hp: number;
  alive: boolean;
  x: number;
  z: number;
  yaw: number;
  pitch: number;
}

interface StateLike {
  players: Map<string, PlayerLike>;
}

let httpServer: http.Server;
let gameServer: Server;
let serverPort: number;

async function waitFor(condition: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
  }
  throw new Error(`等待超时：${description}`);
}

function stateOf(room: Room): StateLike {
  return room.state as unknown as StateLike;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function aim(room: Room, seq: number, x: number, z: number, yaw: number): void {
  room.send(MESSAGE_TYPES.PLAYER_TRANSFORM, { seq, x, y: 0, z, yaw, pitch: 0 });
}

before(async () => {
  httpServer = http.createServer();
  const transport = new WebSocketTransport({ server: httpServer, pingInterval: 0 });
  gameServer = new Server({ transport, greet: false, gracefullyShutdown: false });
  gameServer.define(DEFAULT_ROOM_NAME, FPSBattleRoom, { logLevel: "silent" });
  await gameServer.listen(0, HOST);

  const address = httpServer.address();
  assert.ok(address !== null && typeof address === "object");
  serverPort = address.port;
});

after(async () => {
  await gameServer.gracefullyShutdown(false);
});

describe("双向对射", () => {
  it("A 打 B 与 B 打 A 都应扣血", { timeout: 20000 }, async () => {
    const joinOptions = (name: string) => ({ name, protocolVersion: PROTOCOL_VERSION });
    const roomA = (await new Client(`ws://${HOST}:${serverPort}`).joinOrCreate(
      DEFAULT_ROOM_NAME,
      joinOptions("PlayerOne"),
    )) as Room;
    const roomB = (await new Client(`ws://${HOST}:${serverPort}`).joinOrCreate(
      DEFAULT_ROOM_NAME,
      joinOptions("PlayerTwo"),
    )) as Room;

    try {
      await waitFor(() => stateOf(roomA).players?.size === 2, "双方进入同一房间");

      // 面对面：A 在 z=7 朝 -Z，B 在 z=1 朝 +Z
      aim(roomA, 1, -1.5, 7, 0);
      aim(roomB, 1, -1.5, 1, Math.PI);
      await waitFor(() => {
        const a = stateOf(roomB).players.get(roomA.sessionId);
        const b = stateOf(roomB).players.get(roomB.sessionId);
        return a !== undefined && b !== undefined && Math.abs(a.z - 7) < 0.01 && Math.abs(b.z - 1) < 0.01;
      }, "位置同步完成");

      // 方向一：A 打 B
      roomA.send(MESSAGE_TYPES.FIRE);
      await waitFor(
        () => stateOf(roomA).players.get(roomB.sessionId)!.hp < PLAYER_MAX_HP,
        "A 打 B 应扣血",
      );
      const bHp = stateOf(roomA).players.get(roomB.sessionId)!.hp;
      assert.equal(bHp, PLAYER_MAX_HP - WEAPON_DAMAGE, "B 应掉一发伤害");

      // 方向二：B 打 A（等冷却窗口过去）
      await sleep(WEAPON_COOLDOWN_MS + 80);
      roomB.send(MESSAGE_TYPES.FIRE);
      await waitFor(
        () => stateOf(roomB).players.get(roomA.sessionId)!.hp < PLAYER_MAX_HP,
        "B 打 A 应扣血",
      );
      const aHp = stateOf(roomB).players.get(roomA.sessionId)!.hp;
      assert.equal(aHp, PLAYER_MAX_HP - WEAPON_DAMAGE, "A 应掉一发伤害");
    } finally {
      await roomA.leave();
      await roomB.leave();
    }
  });
});
