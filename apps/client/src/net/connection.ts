import { Client, type Room } from "colyseus.js";

import {
  DEFAULT_ROOM_NAME,
  MESSAGE_TYPES,
  PROTOCOL_VERSION,
  type DamageTakenMessage,
  type ExplosionMessage,
  type FlashEffectMessage,
  type GrenadeLaunchedMessage,
  type KillMessage,
  type PlayerTransformMessage,
  type PongMessage,
  type ShotMessage,
  type SmokeCloudView,
  type ThrowableType,
} from "@colyseus-fps/shared";

import type { BattleRoomState, PlayerState } from "./types.js";

export interface ConnectionInfo {
  roomId: string;
  sessionId: string;
}

export interface ConnectionHandlers {
  onPlayers(players: PlayerState[]): void;
  onClouds(clouds: SmokeCloudView[]): void;
  onPong(message: PongMessage): void;
  onLeave(code: number): void;
  onShot(message: ShotMessage): void;
  onKill(message: KillMessage): void;
  onGrenade(message: GrenadeLaunchedMessage): void;
  onExplosion(message: ExplosionMessage): void;
  onFlash(message: FlashEffectMessage): void;
  onDamaged(message: DamageTakenMessage): void;
}

/** 封装 Colyseus 连接、状态订阅与消息通道。 */
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
          ammo: player.ammo,
          reserve: player.reserve,
          reloadEndAt: player.reloadEndAt,
          frags: player.frags,
          flashes: player.flashes,
          smokes: player.smokes,
          weaponSlot: player.weaponSlot,
          team: player.team,
        });
      });
      players.sort((left, right) => left.joinedAt - right.joinedAt);
      this.handlers.onPlayers(players);

      const clouds: SmokeCloudView[] = [];
      state.clouds.forEach((cloud: SmokeCloudView) => {
        clouds.push({ id: cloud.id, x: cloud.x, z: cloud.z, radius: cloud.radius, expiresAt: cloud.expiresAt });
      });
      this.handlers.onClouds(clouds);
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
    room.onMessage<GrenadeLaunchedMessage>(MESSAGE_TYPES.GRENADE, (message: GrenadeLaunchedMessage) => {
      this.handlers.onGrenade(message);
    });
    room.onMessage<ExplosionMessage>(MESSAGE_TYPES.EXPLODE, (message: ExplosionMessage) => {
      this.handlers.onExplosion(message);
    });
    room.onMessage<FlashEffectMessage>(MESSAGE_TYPES.FLASH, (message: FlashEffectMessage) => {
      this.handlers.onFlash(message);
    });
    room.onMessage<DamageTakenMessage>(MESSAGE_TYPES.DAMAGED, (message: DamageTakenMessage) => {
      this.handlers.onDamaged(message);
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

  /**
   * 上报开火意图；弹道由服务端计算。
   *
   * 携带开火瞬间的视角快照：服务端在 ±3° 内采信它，把"方向陈旧"从 ≤33ms 压到 ~0
   * （协议 v2 的弹道一致性修复之一）。
   */
  public sendFire(yaw: number, pitch: number): void {
    if (this.room === null) {
      return;
    }
    this.room.send(MESSAGE_TYPES.FIRE, { yaw, pitch });
  }

  /** 请求换弹；弹药结算由服务端完成。 */
  public sendReload(): void {
    if (this.room === null) {
      return;
    }
    this.room.send(MESSAGE_TYPES.RELOAD);
  }

  /** 投掷道具：只上报方向，位置与速度由服务端裁定。 */
  public sendThrow(type: ThrowableType, dir: { x: number; y: number; z: number }): void {
    if (this.room === null) {
      return;
    }
    this.room.send(MESSAGE_TYPES.THROW, { type, dirX: dir.x, dirY: dir.y, dirZ: dir.z });
  }

  public async leave(): Promise<void> {
    const room = this.room;
    this.room = null;
    if (room !== null) {
      await room.leave();
    }
  }
}
