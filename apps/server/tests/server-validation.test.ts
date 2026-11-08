/**
 * 服务端位置校验集成测试（文档 7.4 的第 3 步，本批实现为「拒绝 + 保留上一合法位置」）。
 *
 * 场景：真实双客户端，A 先上报一个合法位置，再上报一个**落在墙体 AABB 内部**的位置。
 * 期望：服务端丢弃后者，B 看到的 A 位置与 seq 都不变；随后 A 上报合法位置又能正常生效。
 *
 * 另外验证「站在箱顶」不被误判：A6 矮墙高 1.1m，脚底 y=1.1 应被接受。
 */

import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";

import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { DEFAULT_ROOM_NAME, MESSAGE_TYPES, PROTOCOL_VERSION } from "@colyseus-fps/shared";
import { Client, type Room } from "colyseus.js";

import { FPSBattleRoom } from "../src/rooms/fps-battle-room.js";

const HOST = "127.0.0.1";
const WAIT_TIMEOUT_MS = 6000;
const WAIT_POLL_MS = 25;

interface PlayerLike {
  x: number;
  y: number;
  z: number;
  seq: number;
  team: string;
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

function sendTransform(room: Room, seq: number, x: number, y: number, z: number): void {
  room.send(MESSAGE_TYPES.PLAYER_TRANSFORM, { seq, x, y, z, yaw: 0, pitch: 0 });
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

describe("服务端位置校验", () => {
  it("落在墙体 AABB 内的上报应被丢弃，保留上一合法位置", { timeout: 20000 }, async () => {
    const joinOptions = (name: string) => ({ name, protocolVersion: PROTOCOL_VERSION });
    const roomA = (await new Client(`ws://${HOST}:${serverPort}`).joinOrCreate(
      DEFAULT_ROOM_NAME,
      joinOptions("Mover"),
    )) as Room;
    const roomB = (await new Client(`ws://${HOST}:${serverPort}`).joinOrCreate(
      DEFAULT_ROOM_NAME,
      joinOptions("Watcher"),
    )) as Room;

    try {
      await waitFor(() => stateOf(roomA).players?.size === 2, "双方应进入同一房间");

      // 1) 合法位置：中路空走廊
      sendTransform(roomA, 1, -1.5, 0, 7);
      await waitFor(() => {
        const player = stateOf(roomB).players.get(roomA.sessionId);
        return player !== undefined && Math.abs(player.z - 7) < 0.01;
      }, "A 的合法位置应被采纳");

      // 2) 非法位置：市场建筑群 W2（x −20…−8, z −2…22, 高 4m）正中间
      sendTransform(roomA, 2, -14, 0, 10);
      await sleep(400);

      const afterIllegal = stateOf(roomB).players.get(roomA.sessionId)!;
      assert.ok(Math.abs(afterIllegal.z - 7) < 0.01, `非法上报不应生效，实际 z=${afterIllegal.z}`);
      assert.ok(Math.abs(afterIllegal.x + 1.5) < 0.01, `非法上报不应改动 x，实际 x=${afterIllegal.x}`);
      assert.equal(afterIllegal.seq, 1, "被丢弃的上报不应推进 seq");

      // 3) 又一条合法位置：应立刻生效（不会被"卡死"）
      sendTransform(roomA, 3, -1.5, 0, 3);
      await waitFor(() => {
        const player = stateOf(roomB).players.get(roomA.sessionId);
        return player !== undefined && Math.abs(player.z - 3) < 0.01;
      }, "回到合法位置后应恢复采纳");

      // 4) 站在箱顶（A6 矮墙 x −15.5…−11.5, z −13.5…−12.5, 高 1.1m）不应被误判为"嵌进去"
      sendTransform(roomA, 4, -13.5, 1.1, -13);
      await waitFor(() => {
        const player = stateOf(roomB).players.get(roomA.sessionId);
        return player !== undefined && Math.abs(player.y - 1.1) < 0.01;
      }, "站在 1.1m 箱顶应被接受");
    } finally {
      await roomA.leave();
      await roomB.leave();
    }
  });

  it("加入房间时应写入队伍与出生点", { timeout: 15000 }, async () => {
    const joinOptions = (name: string) => ({ name, protocolVersion: PROTOCOL_VERSION });
    const roomA = (await new Client(`ws://${HOST}:${serverPort}`).joinOrCreate(
      DEFAULT_ROOM_NAME,
      joinOptions("TeamA"),
    )) as Room;

    try {
      await waitFor(() => stateOf(roomA).players?.size === 1, "应看到自己");
      const self = stateOf(roomA).players.get(roomA.sessionId)!;
      assert.ok(self.team === "T" || self.team === "CT", `队伍应为 T/CT，实际 ${self.team}`);
    } finally {
      await roomA.leave();
    }
  });
});
