import { Client, type Room } from "colyseus.js";

import {
  DEFAULT_ROOM_NAME,
  MESSAGE_TYPES,
  PROTOCOL_VERSION,
  type PongMessage,
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
        players.push({ ...player });
      });
      players.sort((left, right) => left.joinedAt - right.joinedAt);
      this.handlers.onPlayers(players);
    });
    room.onMessage<PongMessage>(MESSAGE_TYPES.PONG, (message: PongMessage) => {
      this.handlers.onPong(message);
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

  public async leave(): Promise<void> {
    const room = this.room;
    this.room = null;
    if (room !== null) {
      await room.leave();
    }
  }
}
