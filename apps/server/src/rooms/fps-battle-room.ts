import { Room, type Client } from "@colyseus/core";
import type { Logger } from "pino";

import {
  EYE_HEIGHT,
  GAME_TICK_INTERVAL_MS,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_PLAYERS_PER_ROOM,
  MESSAGE_TYPES,
  PLAYER_MAX_HP,
  PLAYER_RESPAWN_DELAY_MS,
  PROTOCOL_VERSION,
  SPAWN_POINTS,
  THROWABLES,
  THROW_COOLDOWN_MS,
  THROW_ORIGIN_FORWARD,
  THROW_SPEED,
  THROWABLE_TYPES,
  WEAPON_COOLDOWN_MS,
  WEAPON_DAMAGE,
  WEAPON_MAG_SIZE,
  WEAPON_RELOAD_MS,
  WEAPON_RESERVE_AMMO,
  obstacleColliders,
  type Aabb,
  type DamageTakenMessage,
  type ExplosionMessage,
  type FlashEffectMessage,
  type GrenadeLaunchedMessage,
  type KillMessage,
  type PingMessage,
  type PongMessage,
  type SpawnPoint,
  type TeamId,
  type ThrowableType,
  type ThrowMessage,
} from "@colyseus-fps/shared";

import { BattleState } from "../state/battle-state.js";
import { Player } from "../state/player.js";
import { SmokeCloud } from "../state/smoke-cloud.js";
import { createLogger } from "../utils/logger.js";
import { computeShot } from "./combat.js";
import {
  clampThrowDirection,
  explosionDamage,
  flashIntensity,
  normalizeVec,
  stepGrenade,
  type GrenadeState,
} from "./grenades.js";
import { sanitizeTransform } from "./transform.js";

export interface FPSBattleRoomOptions {
  maxClients?: number;
  logLevel?: string;
}

interface JoinOptionsPayload {
  name?: unknown;
  protocolVersion?: unknown;
}

function readJoinOptions(options: unknown): JoinOptionsPayload {
  return typeof options === "object" && options !== null ? options as JoinOptionsPayload : {};
}

function sanitizeDisplayName(rawName: unknown, sessionId: string): string {
  if (typeof rawName === "string") {
    const trimmed: string = rawName.trim();
    if (trimmed.length > 0) {
      return Array.from(trimmed).slice(0, MAX_DISPLAY_NAME_LENGTH).join("");
    }
  }
  return `玩家-${sessionId.slice(0, 6)}`;
}

/** 投掷物类型 → 玩家状态上的数量字段。 */
type InventoryField = "frags" | "flashes" | "smokes";

function inventoryFieldOf(type: ThrowableType): InventoryField {
  if (type === THROWABLE_TYPES.FRAG) {
    return "frags";
  }
  return type === THROWABLE_TYPES.FLASH ? "flashes" : "smokes";
}

function countOf(player: Player, type: ThrowableType): number {
  return player[inventoryFieldOf(type)];
}

function setCountOf(player: Player, type: ThrowableType, value: number): void {
  player[inventoryFieldOf(type)] = Math.max(0, Math.min(255, value));
}

/** 出生表异常时的兜底点位（正常不会用到，仅为避免非空断言）。 */
const FALLBACK_SPAWN: SpawnPoint = { team: "T", x: 0, z: 25, yaw: 0 };

/**
 * 按序号从固定出生表取点：偶数序号进 T 侧、奇数进 CT 侧，同队按 `floor(index/2) % 5` 取槽位。
 *
 * 为什么不用旧的「黄金角绕中心撒点」：那张表假设场地是半径 30 的圆形空地，
 * 在沙漠迷城地图里会把玩家生成到市场建筑群（12×24 的实心块）或墙体内部，
 * 客户端物理的 MTA 推出会把人弹出来并产生橡皮筋。固定表每条都已按 0.35m 玩家半径校验过。
 */
export function nextSpawnPoint(index: number): SpawnPoint {
  const team: TeamId = index % 2 === 0 ? "T" : "CT";
  const slots: readonly SpawnPoint[] = SPAWN_POINTS.filter((point) => point.team === team);
  if (slots.length === 0) {
    return FALLBACK_SPAWN;
  }
  const slot: number = Math.floor(index / 2) % slots.length;
  return slots[slot] ?? FALLBACK_SPAWN;
}

/** FPS 对战房间：S1 联机、S2 位置同步、S3 服务端权威战斗、S4 弹药与投掷物。 */
export class FPSBattleRoom extends Room<BattleState> {
  private logger: Logger = createLogger("info");
  private readonly obstacles: readonly Aabb[] = obstacleColliders();
  /** 每玩家上次开火时间戳（服务端限流依据）。 */
  private readonly lastFireAt = new Map<string, number>();
  /** 每玩家上次投掷时间戳（服务端限流依据）。 */
  private readonly lastThrowAt = new Map<string, number>();
  /** 飞行中的投掷物（服务端权威模拟）。 */
  private readonly grenades = new Map<number, GrenadeState>();
  private nextGrenadeId = 1;
  /** 出生点游标：加入与重生共用，保证前 10 次出生互不重叠（之后开始轮转）。 */
  private spawnCursor = 0;

  /** 投掷物模拟步长（毫秒）：比状态同步更密，保证抛物线平滑。 */
  private static readonly GRENADE_STEP_MS = 50;

  public override onCreate(options: FPSBattleRoomOptions = {}): void {
    this.maxClients = options.maxClients ?? MAX_PLAYERS_PER_ROOM;
    this.patchRate = GAME_TICK_INTERVAL_MS;
    this.setState(new BattleState());
    this.logger = createLogger(options.logLevel ?? "info").child({ roomId: this.roomId });

    this.onMessage<PingMessage>(MESSAGE_TYPES.PING, (client: Client, message: PingMessage) => {
      const sentAt: number = Number.isFinite(message?.sentAt) ? message.sentAt : Date.now();
      const response: PongMessage = {
        sentAt,
        serverTime: Date.now(),
        protocolVersion: PROTOCOL_VERSION,
      };
      client.send(MESSAGE_TYPES.PONG, response);
    });

    this.onMessage<unknown>(MESSAGE_TYPES.PLAYER_TRANSFORM, (client: Client, raw: unknown) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) {
        return;
      }

      const transform = sanitizeTransform(raw);
      // 丢弃非法消息与乱序包（seq 回绕按 uint32 比较处理常见情形）
      if (transform === null || transform.seq <= player.seq) {
        return;
      }

      player.seq = transform.seq;
      player.x = transform.x;
      player.y = transform.y;
      player.z = transform.z;
      player.yaw = transform.yaw;
      player.pitch = transform.pitch;
    });

    // S3：开火。弹道完全由服务端状态计算，客户端无法伪造命中。
    this.onMessage(MESSAGE_TYPES.FIRE, (client: Client) => {
      const shooter = this.state.players.get(client.sessionId);
      if (!shooter || !shooter.alive) {
        return;
      }
      // 换弹中或弹匣空：忽略（客户端自行播放空仓音效）
      if (shooter.reloadEndAt > Date.now() || shooter.ammo <= 0) {
        return;
      }

      const now = Date.now();
      const last = this.lastFireAt.get(client.sessionId) ?? 0;
      if (now - last < WEAPON_COOLDOWN_MS) {
        return;
      }
      this.lastFireAt.set(client.sessionId, now);
      shooter.ammo -= 1;

      const shot = computeShot(this.state.players.values(), client.sessionId, this.obstacles);
      if (shot === null) {
        return;
      }
      this.broadcast(MESSAGE_TYPES.SHOT, shot);

      if (shot.hitPlayerId !== null) {
        this.applyDamage(client.sessionId, shot.hitPlayerId, WEAPON_DAMAGE);
      }
    });

    // S4：换弹（服务端结算弹药，客户端只做动画与提示）
    this.onMessage(MESSAGE_TYPES.RELOAD, (client: Client) => {
      this.handleReload(client);
    });

    // S4：投掷手雷 / 闪光弹 / 烟雾弹
    this.onMessage<unknown>(MESSAGE_TYPES.THROW, (client: Client, raw: unknown) => {
      this.handleThrow(client, raw);
    });

    this.setSimulationInterval((deltaMs: number) => {
      this.updateGrenades(deltaMs);
    }, FPSBattleRoom.GRENADE_STEP_MS);

    this.logger.info({ maxClients: this.maxClients, patchRate: this.patchRate }, "房间已创建");
  }

  public override onJoin(client: Client, options: unknown): void {
    const joinOptions: JoinOptionsPayload = readJoinOptions(options);
    if (joinOptions.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error("PROTOCOL_VERSION_MISMATCH");
    }

    const player = new Player();
    player.sessionId = client.sessionId;
    player.displayName = sanitizeDisplayName(joinOptions.name, client.sessionId);
    player.joinedAt = Date.now();

    const spawn = nextSpawnPoint(this.spawnCursor);
    this.spawnCursor += 1;
    player.x = spawn.x;
    player.y = 0;
    player.z = spawn.z;
    // 朝向直接取出生表：T 面向 −Z、CT 面向 +Z，不再让所有人朝地图中心扎堆
    player.yaw = spawn.yaw;

    this.state.players.set(client.sessionId, player);

    this.logger.info(
      { playerId: client.sessionId, displayName: player.displayName, clients: this.clients.length },
      "玩家已加入",
    );
  }

  public override onLeave(client: Client): void {
    this.lastFireAt.delete(client.sessionId);
    this.lastThrowAt.delete(client.sessionId);
    const removed: boolean = this.state.players.delete(client.sessionId);
    this.logger.info({ playerId: client.sessionId, removed, clients: this.clients.length }, "玩家已离开");
  }

  /** 结算伤害；致死时更新计分、广播击杀并安排重生。 */
  private applyDamage(killerId: string, victimId: string, amount: number): void {
    const victim = this.state.players.get(victimId);
    if (!victim || !victim.alive) {
      return;
    }

    victim.hp = Math.max(0, victim.hp - amount);

    // 只发给受伤者本人：用于受击方向指示与屏幕反馈
    const victimClient = this.clients.find((item) => item.sessionId === victimId);
    if (victimClient !== undefined) {
      const attacker = this.state.players.get(killerId);
      const message: DamageTakenMessage = {
        attackerId: killerId,
        amount,
        hp: victim.hp,
        fromX: attacker?.x ?? victim.x,
        fromZ: attacker?.z ?? victim.z,
      };
      victimClient.send(MESSAGE_TYPES.DAMAGED, message);
    }

    if (victim.hp > 0) {
      return;
    }

    victim.alive = false;
    victim.deaths += 1;
    victim.respawnAt = Date.now() + PLAYER_RESPAWN_DELAY_MS;

    const killer = this.state.players.get(killerId);
    if (killer) {
      killer.kills += 1;
    }

    const killMessage: KillMessage = { killerId, victimId };
    this.broadcast(MESSAGE_TYPES.KILL, killMessage);
    this.logger.info({ killerId, victimId, amount }, "玩家被击杀");

    this.clock.setTimeout(() => {
      this.respawn(victimId);
    }, PLAYER_RESPAWN_DELAY_MS);
  }

  /** 换弹：校验后延迟补满弹匣（子弹从备弹扣除）。 */
  private handleReload(client: Client): void {
    const player = this.state.players.get(client.sessionId);
    if (!player || !player.alive) {
      return;
    }
    if (player.ammo >= WEAPON_MAG_SIZE || player.reserve <= 0) {
      return;
    }
    if (player.reloadEndAt > Date.now()) {
      return;
    }

    player.reloadEndAt = Date.now() + WEAPON_RELOAD_MS;
    this.clock.setTimeout(() => {
      const current = this.state.players.get(client.sessionId);
      if (!current || !current.alive) {
        return;
      }
      const need = WEAPON_MAG_SIZE - current.ammo;
      const take = Math.min(need, current.reserve);
      current.ammo += take;
      current.reserve -= take;
      current.reloadEndAt = 0;
    }, WEAPON_RELOAD_MS);
  }

  /** 投掷：校验数量/冷却/方向后创建服务端权威投掷物。 */
  private handleThrow(client: Client, raw: unknown): void {
    const player = this.state.players.get(client.sessionId);
    if (!player || !player.alive) {
      return;
    }

    const payload = raw as Partial<ThrowMessage> | null;
    const type = payload?.type;
    if (type !== THROWABLE_TYPES.FRAG && type !== THROWABLE_TYPES.FLASH && type !== THROWABLE_TYPES.SMOKE) {
      return;
    }

    const remaining = countOf(player, type);
    if (remaining <= 0) {
      return;
    }

    const now = Date.now();
    const last = this.lastThrowAt.get(client.sessionId) ?? 0;
    if (now - last < THROW_COOLDOWN_MS) {
      return;
    }

    const rawDir = normalizeVec(
      Number(payload?.dirX ?? 0),
      Number(payload?.dirY ?? 0),
      Number(payload?.dirZ ?? -1),
    );
    if (rawDir === null) {
      return;
    }
    const dir = clampThrowDirection(rawDir);

    this.lastThrowAt.set(client.sessionId, now);
    setCountOf(player, type, remaining - 1);

    const origin = {
      x: player.x + dir.x * THROW_ORIGIN_FORWARD,
      y: player.y + EYE_HEIGHT - 0.15 + dir.y * THROW_ORIGIN_FORWARD,
      z: player.z + dir.z * THROW_ORIGIN_FORWARD,
    };
    const id = this.nextGrenadeId;
    this.nextGrenadeId += 1;

    const grenade: GrenadeState = {
      id,
      type,
      throwerId: client.sessionId,
      x: origin.x,
      y: origin.y,
      z: origin.z,
      vx: dir.x * THROW_SPEED,
      vy: dir.y * THROW_SPEED,
      vz: dir.z * THROW_SPEED,
      fuseMs: THROWABLES[type].fuseMs,
    };
    this.grenades.set(id, grenade);

    const launched: GrenadeLaunchedMessage = {
      id,
      type,
      throwerId: client.sessionId,
      origin,
      velocity: { x: grenade.vx, y: grenade.vy, z: grenade.vz },
    };
    this.broadcast(MESSAGE_TYPES.GRENADE, launched);
    this.logger.debug({ playerId: client.sessionId, type, id }, "投掷物已投出");
  }

  /** 逐个推进投掷物；引信到期即生效。 */
  private updateGrenades(deltaMs: number): void {
    if (this.grenades.size === 0) {
      return;
    }
    const dtSeconds = Math.min(deltaMs, 100) / 1000;

    for (const [id, grenade] of this.grenades) {
      stepGrenade(grenade, dtSeconds, this.obstacles);
      grenade.fuseMs -= deltaMs;
      if (grenade.fuseMs <= 0) {
        this.grenades.delete(id);
        this.detonate(grenade);
      }
    }
  }

  /** 投掷物生效：广播特效，并按键类型结算伤害/致盲/烟雾。 */
  private detonate(grenade: GrenadeState): void {
    const config = THROWABLES[grenade.type];
    const message: ExplosionMessage = {
      id: grenade.id,
      type: grenade.type,
      throwerId: grenade.throwerId,
      x: grenade.x,
      y: grenade.y,
      z: grenade.z,
      radius: config.radius,
    };
    this.broadcast(MESSAGE_TYPES.EXPLODE, message);

    if (grenade.type === THROWABLE_TYPES.FRAG) {
      const victims = explosionDamage(
        { x: grenade.x, y: grenade.y, z: grenade.z },
        config.radius,
        config.maxDamage ?? 100,
        config.minDamage ?? 20,
        this.state.players.values(),
        this.obstacles,
      );
      for (const victim of victims) {
        this.applyDamage(grenade.throwerId, victim.sessionId, victim.damage);
      }
      return;
    }

    if (grenade.type === THROWABLE_TYPES.FLASH) {
      for (const player of this.state.players.values()) {
        if (!player.alive) {
          continue;
        }
        const intensity = flashIntensity({ x: grenade.x, y: grenade.y, z: grenade.z }, config.radius, player);
        if (intensity <= 0.05) {
          continue;
        }
        const target = this.clients.find((item) => item.sessionId === player.sessionId);
        if (target === undefined) {
          continue;
        }
        const flash: FlashEffectMessage = {
          intensity,
          durationMs: Math.round((config.maxBlindMs ?? 2800) * intensity),
          sourceX: grenade.x,
          sourceZ: grenade.z,
        };
        target.send(MESSAGE_TYPES.FLASH, flash);
      }
      return;
    }

    // 烟雾弹：写入状态，客户端渲染云团；到期后自动移除
    const cloudId = `smoke-${grenade.id}`;
    const cloud = new SmokeCloud();
    cloud.id = cloudId;
    cloud.x = grenade.x;
    cloud.z = grenade.z;
    cloud.radius = config.radius;
    const durationMs = config.cloudDurationMs ?? 15000;
    cloud.expiresAt = Date.now() + durationMs;
    this.state.clouds.set(cloudId, cloud);

    this.clock.setTimeout(() => {
      this.state.clouds.delete(cloudId);
    }, durationMs);
  }

  /** 重生：重置血量/位置/弹药/道具，respawnSeq 自增驱动客户端吸附到出生点。 */
  private respawn(sessionId: string): void {
    const player = this.state.players.get(sessionId);
    if (!player || player.alive) {
      return;
    }

    const spawn = nextSpawnPoint(this.spawnCursor);
    this.spawnCursor += 1;
    player.x = spawn.x;
    player.y = 0;
    player.z = spawn.z;
    player.yaw = spawn.yaw;
    player.hp = PLAYER_MAX_HP;
    player.alive = true;
    player.respawnAt = 0;
    player.respawnSeq += 1;
    player.ammo = WEAPON_MAG_SIZE;
    player.reserve = WEAPON_RESERVE_AMMO;
    player.reloadEndAt = 0;
    player.frags = THROWABLES.frag.initialCount;
    player.flashes = THROWABLES.flash.initialCount;
    player.smokes = THROWABLES.smoke.initialCount;

    this.logger.info({ playerId: sessionId }, "玩家已重生");
  }

  public override onDispose(): void {
    this.logger.info("房间已销毁");
  }
}
