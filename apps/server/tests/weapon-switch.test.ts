/**
 * S6：武器槽切换（服务端权威）+ 手枪弹道参数。
 *
 * 两部分：
 *   1. **纯函数**：`computeShot(..., maxRange)` 的射程截断 —— 手枪 35m 打不到 40m 外的敌人，
 *      步枪 60m 能打到；伤害仍然走同一张 {@link ZONE_DAMAGE}（胸 25 / 头 100）。
 *   2. **联机集成**：`WEAPON_SWITCH` 的四条校验（槽位范围 / 已在该槽 / 切枪中 / 投掷物为空），
 *      以及 `FIRE` 在切枪期间被忽略、手枪与步枪弹药互不影响。
 */

import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";

import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import {
  DEFAULT_ROOM_NAME,
  MESSAGE_TYPES,
  PISTOL_MAG_SIZE,
  PISTOL_RANGE,
  PROTOCOL_VERSION,
  THROWABLES,
  THROWABLE_TYPES,
  WEAPON_MAG_SIZE,
  WEAPON_RANGE,
  WEAPON_SLOTS,
  ZONE_DAMAGE,
} from "@colyseus-fps/shared";
import { Client, type Room } from "colyseus.js";

import { computeShot, type CombatantView } from "../src/rooms/combat.js";
import { FPSBattleRoom } from "../src/rooms/fps-battle-room.js";

const HOST = "127.0.0.1";
const WAIT_TIMEOUT_MS = 15000;
const WAIT_POLL_MS = 25;

function makePlayer(id: string, x: number, z: number, yaw = 0, pitch = 0): CombatantView {
  return { sessionId: id, x, y: 0, z, yaw, pitch, alive: true };
}

describe("手枪弹道参数（computeShot 射程截断）", () => {
  it("10m 正对平射：手枪命中胸口，伤害与步枪同表（25）", () => {
    const players = [makePlayer("A", 0, 0), makePlayer("B", 0, -10)];
    const pistol = computeShot(players, "A", [], undefined, PISTOL_RANGE);
    const rifle = computeShot(players, "A", [], undefined, WEAPON_RANGE);
    assert.ok(pistol !== null && rifle !== null);
    assert.equal(pistol.hitPlayerId, "B");
    assert.equal(pistol.hitZone, "chest");
    assert.equal(pistol.damage, ZONE_DAMAGE.chest);
    assert.equal(pistol.damage, rifle.damage, "同一张 ZONE_DAMAGE，手枪不打折");
  });

  it("35m 边内可命中，40m 超出射程（步枪 60m 仍能打到）", () => {
    const near = [makePlayer("A", 0, 0), makePlayer("B", 0, -34)];
    assert.equal(computeShot(near, "A", [], undefined, PISTOL_RANGE)?.hitPlayerId, "B");

    const far = [makePlayer("A", 0, 0), makePlayer("B", 0, -40)];
    const pistol = computeShot(far, "A", [], undefined, PISTOL_RANGE);
    const rifle = computeShot(far, "A", [], undefined, WEAPON_RANGE);
    assert.ok(pistol !== null && rifle !== null);
    assert.equal(pistol.hitPlayerId, null, "40m 超出 35m 手枪射程，不应命中");
    assert.equal(pistol.damage, 0);
    assert.equal(rifle.hitPlayerId, "B", "步枪 60m 射程应命中");
  });

  it("手枪爆头同样是一枪（伤害 = 满血 100）", () => {
    const distance = 6;
    // 抬枪把射线抬到 1.70m（头部中段）：pitch = atan((1.70 − 1.60) / 距离)
    const pitch = Math.atan((1.7 - 1.6) / distance);
    const players = [makePlayer("A", 0, 0), makePlayer("B", 0, -distance)];
    const shot = computeShot(players, "A", [], { yaw: 0, pitch }, PISTOL_RANGE);
    assert.ok(shot !== null);
    assert.equal(shot.hitZone, "head");
    assert.equal(shot.damage, 100);
  });

  it("不传 maxRange 时必须退回步枪射程（向后兼容 A1 的调用方）", () => {
    const players = [makePlayer("A", 0, 0), makePlayer("B", 0, -50)];
    const shot = computeShot(players, "A", []);
    assert.ok(shot !== null);
    assert.equal(shot.hitPlayerId, "B", "缺省射程应仍是 60m");
  });
});

/* ------------------------------------------------------------------ *
 * 联机集成：WEAPON_SWITCH 与 FIRE 的联动
 * ------------------------------------------------------------------ */

interface PlayerLike {
  weaponSlot: number;
  switchEndAt: number;
  ammo: number;
  reserve: number;
  pistolAmmo: number;
  pistolReserve: number;
  frags: number;
  hp: number;
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

function self(room: Room): PlayerLike {
  const player = stateOf(room).players.get(room.sessionId);
  assert.ok(player !== undefined, "自己的状态必须存在");
  return player;
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

describe("WEAPON_SWITCH 服务端校验", () => {
  it("切到手枪成功；切枪中开火被忽略；到期后可开火且弹药互不影响", { timeout: 40000 }, async () => {
    const joinOptions = (name: string) => ({ name, protocolVersion: PROTOCOL_VERSION });
    const roomA = (await new Client(`ws://${HOST}:${serverPort}`).joinOrCreate(
      DEFAULT_ROOM_NAME,
      joinOptions("Switcher"),
    )) as Room;
    const roomB = (await new Client(`ws://${HOST}:${serverPort}`).joinOrCreate(
      DEFAULT_ROOM_NAME,
      joinOptions("Bystander"),
    )) as Room;

    try {
      await waitFor(() => (stateOf(roomA).players?.size ?? 0) === 2, "双方进入同一房间");
      // 站在中路空走廊，避免位置上报被障碍物校验丢弃
      roomA.send(MESSAGE_TYPES.PLAYER_TRANSFORM, { seq: 1, x: -1.5, y: 0, z: 8, yaw: 0, pitch: 0 });
      await waitFor(() => Math.abs(self(roomA).hp - 100) <= 100, "玩家状态就绪");

      const rifleMag = self(roomA).ammo;
      assert.equal(rifleMag, WEAPON_MAG_SIZE, "初始应有满弹匣步枪");
      assert.equal(self(roomA).pistolAmmo, PISTOL_MAG_SIZE, "初始应有满弹匣手枪");
      assert.equal(self(roomA).weaponSlot, WEAPON_SLOTS.RIFLE, "初始应拿步枪");

      // ---- ① 正常切换到手枪 ----
      roomA.send(MESSAGE_TYPES.WEAPON_SWITCH, { slot: WEAPON_SLOTS.PISTOL });
      await waitFor(() => self(roomA).weaponSlot === WEAPON_SLOTS.PISTOL, "应切到手枪");
      assert.ok(self(roomA).switchEndAt > Date.now(), "切枪结束时刻应在未来");

      // ---- ② 切枪中开火应被忽略（弹药不变）----
      const pistolBefore = self(roomA).pistolAmmo;
      roomA.send(MESSAGE_TYPES.FIRE);
      await sleep(120);
      assert.equal(self(roomA).pistolAmmo, pistolBefore, "切枪中开火不应消耗手枪子弹");

      // ---- ③ 切枪结束（350ms）后开火生效，且只扣手枪弹药 ----
      await waitFor(() => self(roomA).switchEndAt <= Date.now(), "切枪动画应结束", 3000);
      roomA.send(MESSAGE_TYPES.FIRE);
      await waitFor(() => self(roomA).pistolAmmo === pistolBefore - 1, "手枪应消耗 1 发");
      assert.equal(self(roomA).ammo, rifleMag, "手枪开火绝不能动步枪弹药");

      // ---- ④ 非法槽位一律拒绝 ----
      for (const slot of [-1, 6, 99, 1.5, Number.NaN]) {
        roomA.send(MESSAGE_TYPES.WEAPON_SWITCH, { slot });
      }
      roomA.send(MESSAGE_TYPES.WEAPON_SWITCH, { slot: "abc" });
      roomA.send(MESSAGE_TYPES.WEAPON_SWITCH, {});
      await sleep(150);
      assert.equal(self(roomA).weaponSlot, WEAPON_SLOTS.PISTOL, "非法槽位不应改变当前武器");

      // ---- ⑤ 切回步枪，弹药各自独立 ----
      roomA.send(MESSAGE_TYPES.WEAPON_SWITCH, { slot: WEAPON_SLOTS.RIFLE });
      await waitFor(() => self(roomA).weaponSlot === WEAPON_SLOTS.RIFLE, "应切回步枪");
      assert.equal(self(roomA).ammo, rifleMag, "步枪弹匣未被手枪影响");
      assert.equal(self(roomA).pistolAmmo, pistolBefore - 1, "手枪弹匣保持自己打的数");
    } finally {
      await roomA.leave();
      await roomB.leave();
    }
  });

  it("数量为 0 的投掷物槽不可切，且刀恒可用", { timeout: 40000 }, async () => {
    const joinOptions = (name: string) => ({ name, protocolVersion: PROTOCOL_VERSION });
    const roomA = (await new Client(`ws://${HOST}:${serverPort}`).joinOrCreate(
      DEFAULT_ROOM_NAME,
      joinOptions("Thrower"),
    )) as Room;

    try {
      await waitFor(() => (stateOf(roomA).players?.size ?? 0) === 1, "进入房间");
      roomA.send(MESSAGE_TYPES.PLAYER_TRANSFORM, { seq: 1, x: -1.5, y: 0, z: 8, yaw: 0, pitch: 0 });
      await sleep(120);

      // 手雷初始 2 颗：全部扔光（每次间隔 > THROW_COOLDOWN_MS）
      const initialFrags = self(roomA).frags;
      assert.equal(initialFrags, THROWABLES.frag.initialCount);
      for (let i = 0; i < initialFrags; i += 1) {
        roomA.send(MESSAGE_TYPES.THROW, { type: THROWABLE_TYPES.FRAG, dirX: 0, dirY: 0.2, dirZ: -1 });
        await sleep(THROWABLES.frag.initialCount > 1 ? 780 : 780);
      }
      await waitFor(() => self(roomA).frags === 0, "手雷应已扔光");

      // 切到匕首（恒可用）
      roomA.send(MESSAGE_TYPES.WEAPON_SWITCH, { slot: WEAPON_SLOTS.KNIFE });
      await waitFor(() => self(roomA).weaponSlot === WEAPON_SLOTS.KNIFE, "刀应可用");
      await waitFor(() => self(roomA).switchEndAt <= Date.now(), "切枪结束", 3000);

      // 再切回步枪（否则下面切手雷时会被"已在该槽"以外的原因干扰）
      roomA.send(MESSAGE_TYPES.WEAPON_SWITCH, { slot: WEAPON_SLOTS.RIFLE });
      await waitFor(() => self(roomA).weaponSlot === WEAPON_SLOTS.RIFLE, "切回步枪");
      await waitFor(() => self(roomA).switchEndAt <= Date.now(), "切枪结束", 3000);

      // 空槽必须被拒绝
      roomA.send(MESSAGE_TYPES.WEAPON_SWITCH, { slot: WEAPON_SLOTS.FRAG });
      await sleep(200);
      assert.equal(self(roomA).weaponSlot, WEAPON_SLOTS.RIFLE, "手雷用完后不应能切到手雷槽");

      // 还有货的槽位可以切
      roomA.send(MESSAGE_TYPES.WEAPON_SWITCH, { slot: WEAPON_SLOTS.FLASH });
      await waitFor(() => self(roomA).weaponSlot === WEAPON_SLOTS.FLASH, "闪光弹还有库存，应可切");
      assert.equal(self(roomA).frags, 0, "手雷数量保持为 0");
    } finally {
      await roomA.leave();
    }
  });
});
