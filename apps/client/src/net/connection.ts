import { Client, type Room } from "colyseus.js";

import {
  DEFAULT_ROOM_NAME,
  MESSAGE_TYPES,
  PROTOCOL_VERSION,
  type KillMessage,
  type PlayerTransformMessage,
  type PongMessage,
  type ShotMessage,
} from "@colyseus-fps/shared";

import type { BattleRoomState, PlayerState } from "./types.js";

export interface ConnectionInfo {
  roomId: string;
  sessionId: string;
}

export interface ConnectionHandlers {
  onPlayers(players: PlayerState[]): void;
  onPong(message: PongMessage): void;
  onLeave(code: number): void;
  onShot(message: ShotMessage): void;
  onKill(message: KillMessage): void;
}

/** 封装 S1 联机大厅的 Colyseus 连接、状态订阅和消息通道。 */
export class LobbyConnection {
  private readonly client: Client;
  private room: Room<BattleRoomState> | null = null;

  public constructor(serverUrl: string, private readonly handlers: ConnectionHandlers) {
    this.client = new Client(serverUrl);
  }

  public async join(displayName: string): Promise<ConnectionInfo> {
    if (this.room !== null) {
      throw new Error("当前连接已经在房间中");
    }

    const room = await this.client.joinOrCreate<BattleRoomState>(DEFAULT_ROOM_NAME, {
      name: displayName,
      protocolVersion: PROTOCOL_VERSION,
    });

    this.room = room;
    room.onStateChange((state: BattleRoomState) => {
      const players: PlayerState[] = [];
      state.players.forEach((player: PlayerState) => {
        players.push({
          sessionId: player.sessionId,
          displayName: player.displayName,
          joinedAt: player.joinedAt,
          x: player.x,
          y: player.y,
          z: player.z,
          yaw: player.yaw,
          pitch: player.pitch,
          seq: player.seq,
          hp: player.hp,
          alive: player.alive,
          kills: player.kills,
          deaths: player.deaths,
          respawnSeq: player.respawnSeq,
          respawnAt: player.respawnAt,
        });
      });
      players.sort((left, right) => left.joinedAt - right.joinedAt);
      this.handlers.onPlayers(players);
    });
    room.onMessage<PongMessage>(MESSAGE_TYPES.PONG, (message: PongMessage) => {
      this.handlers.onPong(message);
    });
    room.onMessage<ShotMessage>(MESSAGE_TYPES.SHOT, (message: ShotMessage) => {
      this.handlers.onShot(message);
    });
    room.onMessage<KillMessage>(MESSAGE_TYPES.KILL, (message: KillMessage) => {
      this.handlers.onKill(message);
    });
    room.onLeave((code: number) => {
      this.room = null;
      this.handlers.onLeave(code);
    });

    return {
      roomId: room.roomId,
      sessionId: room.sessionId,
    };
  }

  public sendPing(): void {
    if (this.room === null) {
      throw new Error("尚未加入房间");
    }
    this.room.send(MESSAGE_TYPES.PING, { sentAt: Date.now() });
  }

  public get sessionId(): string | null {
    return this.room?.sessionId ?? null;
  }

  /** 上报本地位置/视角；未加入房间时静默忽略（游戏循环无需额外判断）。 */
  public sendTransform(message: PlayerTransformMessage): void {
    if (this.room === null) {
      return;
    }
    this.room.send(MESSAGE_TYPES.PLAYER_TRANSFORM, message);
  }

  /** 上报开火意图；弹道由服务端计算。 */
  public sendFire(): void {
    if (this.room === null) {
      return;
    }
    this.room.send(MESSAGE_TYPES.FIRE);
  }

  public async leave(): Promise<void> {
    const room = this.room;
    this.room = null;
    if (room !== null) {
      await room.leave();
    }
  }
}
