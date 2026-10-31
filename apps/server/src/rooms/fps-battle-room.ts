import { Room, type Client } from "@colyseus/core";
import type { Logger } from "pino";

import {
  GAME_TICK_INTERVAL_MS,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_PLAYERS_PER_ROOM,
  MESSAGE_TYPES,
  PROTOCOL_VERSION,
  type PingMessage,
  type PongMessage,
} from "@colyseus-fps/shared";

import { BattleState } from "../state/battle-state.js";
import { Player } from "../state/player.js";
import { createLogger } from "../utils/logger.js";

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

/** FPS 对战房间：S1 先验证加入、离开、状态同步与消息往返。 */
export class FPSBattleRoom extends Room<BattleState> {
  private logger: Logger = createLogger("info");

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
    this.state.players.set(client.sessionId, player);

    this.logger.info(
      { playerId: client.sessionId, displayName: player.displayName, clients: this.clients.length },
      "玩家已加入",
    );
  }

  public override onLeave(client: Client): void {
    const removed: boolean = this.state.players.delete(client.sessionId);
    this.logger.info({ playerId: client.sessionId, removed, clients: this.clients.length }, "玩家已离开");
  }

  public override onDispose(): void {
    this.logger.info("房间已销毁");
  }
}
