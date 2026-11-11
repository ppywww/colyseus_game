/**
 * FPSBattleRoom 双客户端集成测试。
 *
 * 目的：用真实 WebSocket 连接验证 S1 的最小联机闭环：
 *   加入房间 → 状态同步（双方可见）→ 消息往返（Ping/Pong）→ 离开房间。
 *
 * 测试内启动一个独立的 Colyseus Server（随机端口、测试环境），
 * 通过 colyseus.js 客户端连接，避免与开发/生产端口冲突。
 */

import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";

import { matchMaker, Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import {
  DEFAULT_ROOM_NAME,
  MESSAGE_TYPES,
  PROTOCOL_VERSION,
  type PongMessage,
} from "@colyseus-fps/shared";
import { Client, type Room } from "colyseus.js";

import { FPSBattleRoom } from "../src/rooms/fps-battle-room.js";

const HOST = "127.0.0.1";
const WAIT_TIMEOUT_MS = 5000;
const WAIT_POLL_MS = 25;

let httpServer: http.Server;
let gameServer: Server;
let serverPort: number;
let clientA: Client;
let clientB: Client;

interface BattleStateLike {
  players: { size: number };
}

/** 轮询等待条件成立，超时则抛出带上下文的错误。 */
async function waitFor(
  condition: () => boolean,
  description: string,
  timeoutMs: number = WAIT_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
  }
  throw new Error(`等待超时：${description}`);
}

/** 等待房间状态满足条件（依赖 Colyseus 状态补丁推送，容忍首个补丁前的空状态）。 */
async function waitForState(
  room: Room,
  condition: (state: BattleStateLike) => boolean,
  description: string,
): Promise<void> {
  await waitFor(
    () => {
      const state = room.state as unknown as BattleStateLike | undefined;
      return state?.players !== undefined && condition(state);
    },
    description,
  );
}

function joinOptions(name: string): { name: string; protocolVersion: number } {
  return { name, protocolVersion: PROTOCOL_VERSION };
}

before(async () => {
  httpServer = http.createServer();
  const transport = new WebSocketTransport({ server: httpServer, pingInterval: 0 });

  gameServer = new Server({ transport, greet: false, gracefullyShutdown: false });
  gameServer.define(DEFAULT_ROOM_NAME, FPSBattleRoom, { logLevel: "silent" });

  await gameServer.listen(0, HOST);

  const address = httpServer.address();
  assert.ok(address !== null && typeof address === "object", "HTTP server 应已绑定端口");
  serverPort = address.port;

  clientA = new Client(`ws://${HOST}:${serverPort}`);
  clientB = new Client(`ws://${HOST}:${serverPort}`);
});

after(async () => {
  await gameServer.gracefullyShutdown(false);
});

describe("房间创建参数", () => {
  it("应把 maxClients 传入房间实例", async () => {
    const seat = await matchMaker.createRoom(DEFAULT_ROOM_NAME, { maxClients: 2 });
    const room = matchMaker.getLocalRoomById(seat.roomId);

    assert.ok(room instanceof FPSBattleRoom);
    assert.equal(room.maxClients, 2);
  });
});

describe("双客户端联机闭环", () => {
  it("两个客户端应进入同一房间并互相可见", async () => {
    const roomA = (await clientA.joinOrCreate(DEFAULT_ROOM_NAME, joinOptions("Alice"))) as Room;
    const roomB = (await clientB.joinOrCreate(DEFAULT_ROOM_NAME, joinOptions("Bob"))) as Room;

    try {
      assert.equal(roomA.roomId, roomB.roomId, "joinOrCreate 应把双方分配到同一房间");

      await waitForState(roomA, (s) => s.players.size === 2, "A 应看到 2 名玩家");
      await waitForState(roomB, (s) => s.players.size === 2, "B 应看到 2 名玩家");
    } finally {
      await roomA.leave();
      await roomB.leave();
    }
  });

  it("Ping 消息应收到包含协议版本的 Pong 响应", async () => {
    const room = (await clientA.joinOrCreate(DEFAULT_ROOM_NAME, joinOptions("Pinger"))) as Room;

    try {
      const pong = await new Promise<PongMessage>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("等待 Pong 超时")), WAIT_TIMEOUT_MS);
        room.onMessage(MESSAGE_TYPES.PONG, (message: PongMessage) => {
          clearTimeout(timer);
          resolve(message);
        });
        room.send(MESSAGE_TYPES.PING, { sentAt: Date.now() });
      });

      assert.equal(typeof pong.serverTime, "number");
      assert.equal(pong.protocolVersion, PROTOCOL_VERSION);
    } finally {
      await room.leave();
    }
  });

  it("协议版本不匹配应被拒绝加入", async () => {
    await assert.rejects(
      clientB.joinOrCreate(DEFAULT_ROOM_NAME, { name: "Mallory", protocolVersion: PROTOCOL_VERSION + 1 }),
      /PROTOCOL_VERSION_MISMATCH/,
    );
  });

  it("玩家离开后其余客户端应看到状态更新", async () => {
    const roomA = (await clientA.joinOrCreate(DEFAULT_ROOM_NAME, joinOptions("Watcher"))) as Room;
    const roomB = (await clientB.joinOrCreate(DEFAULT_ROOM_NAME, joinOptions("Leaver"))) as Room;

    try {
      await waitForState(roomA, (s) => s.players.size === 2, "离开前应看到 2 名玩家");

      await roomB.leave();

      await waitForState(roomA, (s) => s.players.size === 1, "B 离开后 A 应只看到 1 名玩家");
    } finally {
      await roomA.leave();
    }
  });

  it("出生点应写入玩家状态且各不相同", async () => {
    const roomA = (await clientA.joinOrCreate(DEFAULT_ROOM_NAME, joinOptions("SpawnerA"))) as Room;
    const roomB = (await clientB.joinOrCreate(DEFAULT_ROOM_NAME, joinOptions("SpawnerB"))) as Room;

    try {
      await waitForState(roomA, (s) => s.players.size === 2, "应看到 2 名玩家");
      const state = roomA.state as unknown as {
        players: Map<string, { x: number; z: number }>;
      };
      const [a, b] = [...state.players.values()];
      assert.ok(a && b, "应有两名玩家");
      const distance = Math.hypot(a.x - b.x, a.z - b.z);
      assert.ok(distance > 0.5, `两名玩家出生点应分开，实际距离 ${distance}`);
    } finally {
      await roomA.leave();
      await roomB.leave();
    }
  });

  it("A 的位置上报应同步到 B，乱序与非法消息应被忽略", async () => {
    const roomA = (await clientA.joinOrCreate(DEFAULT_ROOM_NAME, joinOptions("Mover"))) as Room;
    const roomB = (await clientB.joinOrCreate(DEFAULT_ROOM_NAME, joinOptions("Observer"))) as Room;

    try {
      await waitForState(roomB, (s) => s.players.size === 2, "B 应看到 2 名玩家");

      // 非法消息：不应改变状态
      roomA.send(MESSAGE_TYPES.PLAYER_TRANSFORM, { seq: 1, x: NaN, y: 0, z: 0, yaw: 0, pitch: 0 });
      // 乱序消息：seq 相同，不应生效
      roomA.send(MESSAGE_TYPES.PLAYER_TRANSFORM, { seq: 1, x: 5, y: 0, z: 5, yaw: 0, pitch: 0 });
      // 合法消息
      roomA.send(MESSAGE_TYPES.PLAYER_TRANSFORM, { seq: 2, x: 3.5, y: 0, z: 5.5, yaw: 1.2, pitch: 0.1 });

      const stateB = roomB.state as unknown as {
        players: Map<string, { x: number; z: number; seq: number }>;
      };
      const sessionA = roomA.sessionId;
      await waitFor(
        () => {
          const player = stateB.players.get(sessionA);
          return player !== undefined && player.seq === 2;
        },
        "B 应收到 A 的 seq=2 位置更新",
      );

      const player = stateB.players.get(sessionA);
      assert.ok(Math.abs(player!.x - 3.5) < 0.01, `x 应为 3.5，实际 ${player!.x}`);
      assert.ok(Math.abs(player!.z - 5.5) < 0.01, `z 应为 5.5，实际 ${player!.z}`);
    } finally {
      await roomA.leave();
      await roomB.leave();
    }
  });
});

describe("角色外观同步", () => {
  /** 只取需要的字段，避免为了一个断言把整个 Player 类型搬进测试。 */
  type PlayerLook = { character: number };

  /** 首个状态补丁到达前 `room.state` 是 undefined，所以每次都要重新取。 */
  function playersOf(room: Room): Map<string, PlayerLook> | undefined {
    return (room.state as unknown as { players?: Map<string, PlayerLook> } | undefined)?.players;
  }

  it("入房选项里的角色会落到 Player.character（uint8 下标，用于第三人称建模）", async () => {
    const room = (await clientA.joinOrCreate(DEFAULT_ROOM_NAME, {
      ...joinOptions("Chooser"),
      character: "jerry",
    })) as Room;

    try {
      await waitFor(() => playersOf(room)?.get(room.sessionId)?.character === 1, "jerry 应同步为下标 1");
      assert.equal(playersOf(room)!.get(room.sessionId)!.character, 1);
    } finally {
      await room.leave();
    }
  });

  it("不传或传非法角色时回退默认（tom = 0），不能是随机值", async () => {
    const room = (await clientA.joinOrCreate(DEFAULT_ROOM_NAME, {
      ...joinOptions("NoChoice"),
      character: "daffy",
    })) as Room;

    try {
      await waitFor(() => playersOf(room)?.get(room.sessionId)?.character === 0, "非法角色应回退到 tom");
      assert.equal(playersOf(room)!.get(room.sessionId)!.character, 0);
    } finally {
      await room.leave();
    }
  });

  it("角色只影响外观：两方血量/弹药初始值必须完全一致", async () => {
    const roomA = (await clientA.joinOrCreate(DEFAULT_ROOM_NAME, {
      ...joinOptions("Slim"),
      character: "spike",
    })) as Room;
    const roomB = (await clientB.joinOrCreate(DEFAULT_ROOM_NAME, {
      ...joinOptions("Fat"),
      character: "jerry",
    })) as Room;

    try {
      const playersA = (roomA.state as unknown as {
        players: Map<string, { hp: number; ammo: number; reserve: number; character: number }>;
      }).players;
      await waitFor(() => playersA.size === 2 && playersA.get(roomB.sessionId) !== undefined, "应看到两名玩家");

      const spike = playersA.get(roomA.sessionId)!;
      const jerry = playersA.get(roomB.sessionId)!;
      assert.notEqual(spike.character, jerry.character, "两名玩家应确实是不同角色");
      assert.equal(spike.hp, jerry.hp, "血量不能因为角色不同而不同");
      assert.equal(spike.ammo, jerry.ammo, "弹匣不能因为角色不同而不同");
      assert.equal(spike.reserve, jerry.reserve, "备弹不能因为角色不同而不同");
    } finally {
      await roomA.leave();
      await roomB.leave();
    }
  });
});
