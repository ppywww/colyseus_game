import { Client, type Room } from "colyseus.js";

import {
  CHARACTER_DEFAULT,
  DEFAULT_ROOM_NAME,
  MESSAGE_TYPES,
  PROTOCOL_VERSION,
  type DamageTakenMessage,
  type ExplosionMessage,
  type FlashEffectMessage,
  type GrenadeLaunchedMessage,
  type KillMessage,
  type KnifeResultMessage,
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
  onKnifeResult(message: KnifeResultMessage): void;
}

/** 封装 Colyseus 连接、状态订阅与消息通道。 */
export class LobbyConnection {
  private readonly client: Client;
  private room: Room<BattleRoomState> | null = null;

  public constructor(serverUrl: string, private readonly handlers: ConnectionHandlers) {
    this.client = new Client(serverUrl);
  }

  public async join(displayName: string, character: string = CHARACTER_DEFAULT): Promise<ConnectionInfo> {
    if (this.room !== null) {
      throw new Error("当前连接已经在房间中");
    }

    const room = await this.client.joinOrCreate<BattleRoomState>(DEFAULT_ROOM_NAME, {
      name: displayName,
      protocolVersion: PROTOCOL_VERSION,
      // 角色随入房选项上送：服务端写进 `Player.character` 再同步回来，
      // 于是"别人看你"和"你看自己"永远是同一个角色。
      character,
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
          pistolAmmo: player.pistolAmmo,
          pistolReserve: player.pistolReserve,
          frags: player.frags,
          flashes: player.flashes,
          smokes: player.smokes,
          weaponSlot: player.weaponSlot,
          switchEndAt: player.switchEndAt,
          team: player.team,
          character: player.character ?? 0,
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
    room.onMessage<KnifeResultMessage>(MESSAGE_TYPES.KNIFE_RESULT, (message: KnifeResultMessage) => {
      this.handlers.onKnifeResult(message);
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
   * 携带两个快照：
   *   - 视角（yaw/pitch）：把"方向陈旧"从 ≤33ms 压到 ~0；
   *   - 位置（x/y/z）：把"起点陈旧"同样压到 ~0。少了它，全速奔跑时服务端算出的
   *     射线起点会落后约 18cm，表现为移动中开枪"子弹不是从枪口出来、还打不准"。
   *     服务端会做距离/掩体校验，不合法就忽略这三个字段、回退自己的位置。
   *   - 序号（seq）：服务端原样回显到 SHOT 广播里，客户端据此把"这一发"和
   *     "抠扳机那一刻的枪口坐标"精确配对（见 `Game#pendingShots`）。
   */
  public sendFire(
    yaw: number,
    pitch: number,
    origin?: { x: number; y: number; z: number } | null,
    seq: number = 0,
  ): void {
    if (this.room === null) {
      return;
    }
    const payload: {
      yaw: number;
      pitch: number;
      x?: number;
      y?: number;
      z?: number;
      seq: number;
    } = { yaw, pitch, seq };
    if (origin !== undefined && origin !== null) {
      payload.x = origin.x;
      payload.y = origin.y;
      payload.z = origin.z;
    }
    this.room.send(MESSAGE_TYPES.FIRE, payload);
  }

  /** 请求换弹；弹药结算由服务端完成。 */
  public sendReload(): void {
    if (this.room === null) {
      return;
    }
    this.room.send(MESSAGE_TYPES.RELOAD);
  }

  /**
   * 请求切换武器槽（滚轮 / 数字键 / 快捷投掷共用）。
   *
   * 只发意图：是否允许切（切枪中、槽位为空、未启用）由服务端裁定，
   * 客户端本地只做乐观高亮，收到状态同步后以服务端 `weaponSlot` 为准。
   */
  public sendWeaponSwitch(slot: number): void {
    if (this.room === null) {
      return;
    }
    this.room.send(MESSAGE_TYPES.WEAPON_SWITCH, { slot });
  }

  /** 投掷道具：只上报方向，位置与速度由服务端裁定。 */
  public sendThrow(type: ThrowableType, dir: { x: number; y: number; z: number }): void {
    if (this.room === null) {
      return;
    }
    this.room.send(MESSAGE_TYPES.THROW, { type, dirX: dir.x, dirY: dir.y, dirZ: dir.z });
  }

  /**
   * 请求挥刀。只上报视角快照，扇形判定与伤害全部由服务端 `melee.ts` 结算。
   *
   * 与 `sendFire` 一样携带开火瞬间的 yaw/pitch：刀是"朝哪砍哪"，
   * 用服务端存的上一次 yaw 会让快速转身挥刀砍到自己身后。
   */
  public sendKnife(yaw: number, pitch: number): void {
    if (this.room === null) {
      return;
    }
    this.room.send(MESSAGE_TYPES.KNIFE, { yaw, pitch });
  }

  public async leave(): Promise<void> {
    const room = this.room;
    this.room = null;
    if (room !== null) {
      await room.leave();
    }
  }
}
