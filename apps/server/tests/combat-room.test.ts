/**
 * S3 战斗集成测试：双真实客户端验证服务端权威开火/命中/击杀/重生。
 *
 * 场景：A 在 (5,0,8) 朝 -Z（yaw=0），B 在 (5,0,2)，两点间无掩体。
 * A 连续开火 4 次（每次间隔大于冷却），B 应扣血至死、A 计 1 杀，
 * 随后 B 在重生延迟后满血复活且 respawnSeq 自增。
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
  PLAYER_RESPAWN_DELAY_MS,
  PROTOCOL_VERSION,
  WEAPON_COOLDOWN_MS,
  WEAPON_DAMAGE,
  type KillMessage,
  type ShotMessage,
} from "@colyseus-fps/shared";
import { Client, type Room } from "colyseus.js";

import { FPSBattleRoom } from "../src/rooms/fps-battle-room.js";

const HOST = "127.0.0.1";
const WAIT_TIMEOUT_MS = 8000;
const WAIT_POLL_MS = 25;

interface PlayerLike {
  hp: number;
  alive: boolean;
  kills: number;
  deaths: number;
  respawnSeq: number;
  x: number;
  z: number;
}

interface StateLike {
  players: Map<string, PlayerLike>;
}

let httpServer: http.Server;
let gameServer: Server;
let serverPort: number;
let clientA: Client;
let clientB: Client;

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

function sendTransform(room: Room, seq: number, x: number, z: number): void {
  room.send(MESSAGE_TYPES.PLAYER_TRANSFORM, { seq, x, y: 0, z, yaw: 0, pitch: 0 });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  clientA = new Client(`ws://${HOST}:${serverPort}`);
  clientB = new Client(`ws://${HOST}:${serverPort}`);
});

after(async () => {
  await gameServer.gracefullyShutdown(false);
});

describe("S3 服务端权威战斗", () => {
  it("开火限流、命中扣血、击杀计分、死亡重生全链路", { timeout: PLAYER_RESPAWN_DELAY_MS + 15000 }, async () => {
    const joinOptions = (name: string) => ({ name, protocolVersion: PROTOCOL_VERSION });
    const roomA = (await clientA.joinOrCreate(DEFAULT_ROOM_NAME, joinOptions("Shooter"))) as Room;
    const roomB = (await clientB.joinOrCreate(DEFAULT_ROOM_NAME, joinOptions("Target"))) as Room;

    const shots: ShotMessage[] = [];
    const kills: KillMessage[] = [];
    roomA.onMessage(MESSAGE_TYPES.SHOT, (message: ShotMessage) => shots.push(message));
    roomB.onMessage(MESSAGE_TYPES.SHOT, (message: ShotMessage) => shots.push(message));
    roomB.onMessage(MESSAGE_TYPES.KILL, (message: KillMessage) => kills.push(message));

    try {
      await waitFor(() => stateOf(roomA).players?.size === 2, "双方应进入同一房间");

      // 双方上报到无掩体直线位置，A 面向 -Z
      sendTransform(roomA, 1, 5, 8);
      sendTransform(roomB, 1, 5, 2);
      await waitFor(() => {
        const a = stateOf(roomB).players.get(roomA.sessionId);
        return a !== undefined && Math.abs(a.z - 8) < 0.01;
      }, "A 的位置应同步到服务端并下发");

      // 连续两发：第二发在冷却内，应被限流
      roomA.send(MESSAGE_TYPES.FIRE);
      roomA.send(MESSAGE_TYPES.FIRE);
      await waitFor(() => stateOf(roomB).players.get(roomB.sessionId)!.hp < PLAYER_MAX_HP, "B 应被命中扣血");
      await sleep(200);
      assert.equal(
        stateOf(roomB).players.get(roomB.sessionId)!.hp,
        PLAYER_MAX_HP - WEAPON_DAMAGE,
        "冷却内的第二发不应生效",
      );

      // 再补 3 发击杀
      for (let i = 0; i < 3; i++) {
        await sleep(WEAPON_COOLDOWN_MS + 60);
        roomA.send(MESSAGE_TYPES.FIRE);
      }

      await waitFor(() => kills.length === 1, "应广播一次击杀事件");
      assert.equal(kills[0]!.killerId, roomA.sessionId);
      assert.equal(kills[0]!.victimId, roomB.sessionId);

      await waitFor(() => {
        const b = stateOf(roomB).players.get(roomB.sessionId)!;
        const a = stateOf(roomA).players.get(roomA.sessionId)!;
        return !b.alive && b.deaths === 1 && a.kills === 1;
      }, "B 应死亡且 A 计 1 杀");

      // 死亡状态下开火不应产生弹道
      const shotCountBefore = shots.length;
      roomB.send(MESSAGE_TYPES.FIRE);
      await sleep(200);
      assert.equal(shots.length, shotCountBefore, "死亡玩家开火应被忽略");

      // 等待重生
      await waitFor(() => {
        const b = stateOf(roomB).players.get(roomB.sessionId)!;
        return b.alive && b.hp === PLAYER_MAX_HP && b.respawnSeq === 1;
      }, "B 应在延迟后满血重生", );
      const respawned = stateOf(roomB).players.get(roomB.sessionId)!;
      assert.ok(Math.abs(respawned.x) + Math.abs(respawned.z) > 0, "重生应分配新的出生点");

      // 双方均应收到所有弹道广播（4 次有效开火 × 2 客户端）
      assert.ok(shots.length >= 4, `应广播弹道，实际 ${shots.length} 条`);
      assert.ok(shots.some((s) => s.hitPlayerId === roomB.sessionId), "弹道应包含命中信息");
    } finally {
      await roomA.leave();
      await roomB.leave();
    }
  });
});
