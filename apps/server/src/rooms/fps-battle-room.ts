import { Room, type Client } from "@colyseus/core";
import type { Logger } from "pino";

import {
  ARENA_RADIUS,
  GAME_TICK_INTERVAL_MS,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_PLAYERS_PER_ROOM,
  MESSAGE_TYPES,
  PLAYER_MAX_HP,
  PLAYER_RESPAWN_DELAY_MS,
  PROTOCOL_VERSION,
  WEAPON_COOLDOWN_MS,
  WEAPON_DAMAGE,
  obstacleColliders,
  type Aabb,
  type KillMessage,
  type PingMessage,
  type PongMessage,
} from "@colyseus-fps/shared";

import { BattleState } from "../state/battle-state.js";
import { Player } from "../state/player.js";
import { createLogger } from "../utils/logger.js";
import { computeShot } from "./combat.js";
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

/**
 * 确定性出生点：按加入顺序绕场地中心均匀散开（黄金角分布），
 * 避免玩家重叠出生；S4 可替换为自定义重生逻辑。
 */
function nextSpawnPoint(index: number): { x: number; y: number; z: number } {
  const goldenAngle: number = Math.PI * (3 - Math.sqrt(5));
  const angle: number = index * goldenAngle;
  const radius: number = Math.min(ARENA_RADIUS * 0.4, 4 + index * 1.5);
  return {
    x: Math.cos(angle) * radius,
    y: 0,
    z: Math.sin(angle) * radius,
  };
}

/** FPS 对战房间：S1 联机、S2 位置同步、S3 服务端权威战斗。 */
export class FPSBattleRoom extends Room<BattleState> {
  private logger: Logger = createLogger("info");
  private readonly obstacles: readonly Aabb[] = obstacleColliders();
  /** 每玩家上次开火时间戳（服务端限流依据）。 */
  private readonly lastFireAt = new Map<string, number>();

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

      const now = Date.now();
      const last = this.lastFireAt.get(client.sessionId) ?? 0;
      if (now - last < WEAPON_COOLDOWN_MS) {
        return;
      }
      this.lastFireAt.set(client.sessionId, now);

      const shot = computeShot(this.state.players.values(), client.sessionId, this.obstacles);
      if (shot === null) {
        return;
      }
      this.broadcast(MESSAGE_TYPES.SHOT, shot);

      if (shot.hitPlayerId !== null) {
        this.applyDamage(client.sessionId, shot.hitPlayerId);
      }
    });

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

    const spawn = nextSpawnPoint(this.state.players.size);
    player.x = spawn.x;
    player.y = spawn.y;
    player.z = spawn.z;

    this.state.players.set(client.sessionId, player);

    this.logger.info(
      { playerId: client.sessionId, displayName: player.displayName, clients: this.clients.length },
      "玩家已加入",
    );
  }

  public override onLeave(client: Client): void {
    this.lastFireAt.delete(client.sessionId);
    const removed: boolean = this.state.players.delete(client.sessionId);
    this.logger.info({ playerId: client.sessionId, removed, clients: this.clients.length }, "玩家已离开");
  }

  /** 结算伤害；致死时更新计分、广播击杀并安排重生。 */
  private applyDamage(killerId: string, victimId: string): void {
    const victim = this.state.players.get(victimId);
    if (!victim || !victim.alive) {
      return;
    }

    victim.hp = Math.max(0, victim.hp - WEAPON_DAMAGE);
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
    this.logger.info({ killerId, victimId }, "玩家被击杀");

    this.clock.setTimeout(() => {
      this.respawn(victimId);
    }, PLAYER_RESPAWN_DELAY_MS);
  }

  /** 重生：重置血量/位置，respawnSeq 自增驱动客户端吸附到出生点。 */
  private respawn(sessionId: string): void {
    const player = this.state.players.get(sessionId);
    if (!player || player.alive) {
      return;
    }

    const spawn = nextSpawnPoint(player.deaths + this.state.players.size);
    player.x = spawn.x;
    player.y = spawn.y;
    player.z = spawn.z;
    player.hp = PLAYER_MAX_HP;
    player.alive = true;
    player.respawnAt = 0;
    player.respawnSeq += 1;

    this.logger.info({ playerId: sessionId }, "玩家已重生");
  }

  public override onDispose(): void {
    this.logger.info("房间已销毁");
  }
}
