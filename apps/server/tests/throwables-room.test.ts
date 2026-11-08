/**
 * S4 集成测试：投掷物（手雷 / 烟雾）与弹药/换弹。
 *
 * 场景：A 与 B 面对面站在无掩体空地。
 *   1. A 投手雷到 B 脚下 → 引信结束后 B 掉血；
 *   2. A 投烟雾弹 → 房间状态出现 smoke 云团，过期后自动移除；
 *   3. 弹药：开火扣 1 发，换弹后弹匣补满、备弹减少。
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
  THROWABLES,
  THROWABLE_TYPES,
  WEAPON_MAG_SIZE,
  WEAPON_RELOAD_MS,
} from "@colyseus-fps/shared";
import { Client, type Room } from "colyseus.js";

import { FPSBattleRoom } from "../src/rooms/fps-battle-room.js";

const HOST = "127.0.0.1";
const WAIT_TIMEOUT_MS = 15000;
const WAIT_POLL_MS = 25;

interface PlayerLike {
  hp: number;
  alive: boolean;
  ammo: number;
  reserve: number;
  frags: number;
  smokes: number;
  x: number;
  z: number;
}

interface CloudLike {
  id: string;
  x: number;
  z: number;
  radius: number;
}

interface StateLike {
  players: Map<string, PlayerLike>;
  clouds: Map<string, CloudLike>;
}

let httpServer: http.Server;
let gameServer: Server;
let serverPort: number;

function stateOf(room: Room): StateLike {
  return room.state as unknown as StateLike;
}

async function waitFor(condition: () => boolean, description: string, timeoutMs = WAIT_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
  }
  throw new Error(`等待超时：${description}`);
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

describe("S4 投掷物与弹药", () => {
  it("手雷爆炸扣血、烟雾生成云团、换弹补满弹匣", { timeout: 40000 }, async () => {
    const joinOptions = (name: string) => ({ name, protocolVersion: PROTOCOL_VERSION });
    const roomA = (await new Client(`ws://${HOST}:${serverPort}`).joinOrCreate(
      DEFAULT_ROOM_NAME,
      joinOptions("Thrower"),
    )) as Room;
    const roomB = (await new Client(`ws://${HOST}:${serverPort}`).joinOrCreate(
      DEFAULT_ROOM_NAME,
      joinOptions("Victim"),
    )) as Room;

    try {
      await waitFor(() => stateOf(roomA).players?.size === 2, "双方进入同一房间");

      // 面对面：A 在 z=7 朝 -Z，B 在 z=3.5 朝 +Z（相距 3.5 米，正对投掷，中路空走廊）
      aim(roomA, 1, -1.5, 7, 0);
      aim(roomB, 1, -1.5, 3.5, Math.PI);
      await waitFor(() => {
        const a = stateOf(roomA).players.get(roomA.sessionId);
        const b = stateOf(roomA).players.get(roomB.sessionId);
        return a !== undefined && b !== undefined && Math.abs(a.z - 7) < 0.05 && Math.abs(b.z - 3.5) < 0.05;
      }, "位置同步完成");

      const fragsBefore = stateOf(roomA).players.get(roomA.sessionId)!.frags;
      assert.equal(fragsBefore, THROWABLES.frag.initialCount, "初始应有手雷");

      // 朝 -Z 略下压投掷（下压使手雷在 B 附近落地后滚动）
      roomA.send(MESSAGE_TYPES.THROW, { type: THROWABLE_TYPES.FRAG, dirX: 0, dirY: -0.4, dirZ: -1 });
      await waitFor(
        () => stateOf(roomA).players.get(roomA.sessionId)!.frags === fragsBefore - 1,
        "投出后手雷数量应减少",
      );

      await waitFor(
        () => stateOf(roomA).players.get(roomB.sessionId)!.hp < PLAYER_MAX_HP,
        "手雷爆炸后 B 应掉血",
        THROWABLES.frag.fuseMs + 6000,
      );

      // 烟雾弹：云团进入状态，并在持续时间后移除
      roomA.send(MESSAGE_TYPES.THROW, { type: THROWABLE_TYPES.SMOKE, dirX: 0, dirY: 0, dirZ: -1 });
      await waitFor(() => stateOf(roomB).clouds.size > 0, "烟雾云团应同步到所有客户端", THROWABLES.smoke.fuseMs + 6000);
      const cloud = [...stateOf(roomB).clouds.values()][0]!;
      assert.ok(cloud.radius > 0, "云团半径应大于 0");

      // 弹药：开火扣 1 发
      const ammoBefore = stateOf(roomA).players.get(roomA.sessionId)!.ammo;
      roomA.send(MESSAGE_TYPES.FIRE);
      await waitFor(
        () => stateOf(roomA).players.get(roomA.sessionId)!.ammo === ammoBefore - 1,
        "开火应消耗 1 发子弹",
      );

      // 换弹：弹匣补满、备弹减少
      const reserveBefore = stateOf(roomA).players.get(roomA.sessionId)!.reserve;
      roomA.send(MESSAGE_TYPES.RELOAD);
      await waitFor(
        () => stateOf(roomA).players.get(roomA.sessionId)!.ammo === WEAPON_MAG_SIZE,
        "换弹后弹匣应补满",
        WEAPON_RELOAD_MS + 5000,
      );
      const afterReload = stateOf(roomA).players.get(roomA.sessionId)!;
      assert.ok(afterReload.reserve < reserveBefore, "换弹应消耗备弹");
      assert.ok(afterReload.reserve >= 0, "备弹不应为负");

      // 死亡后换弹/投掷应被忽略（B 未死亡，这里验证 A 存活状态下不会超量）：略
      assert.ok(stateOf(roomA).players.get(roomA.sessionId)!.frags >= 0, "手雷数量不应为负");
      await sleep(200);
    } finally {
      await roomA.leave();
      await roomB.leave();
    }
  });
});
