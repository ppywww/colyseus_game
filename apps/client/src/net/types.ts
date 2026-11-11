import type { SmokeCloudView } from "@colyseus-fps/shared";

export interface PlayerState {
  sessionId: string;
  displayName: string;
  joinedAt: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  seq: number;
  hp: number;
  alive: boolean;
  kills: number;
  deaths: number;
  respawnSeq: number;
  respawnAt: number;
  ammo: number;
  reserve: number;
  reloadEndAt: number;
  /** 手枪弹匣内子弹数（槽位 1，与步枪完全独立）。 */
  pistolAmmo: number;
  /** 手枪备弹数。 */
  pistolReserve: number;
  frags: number;
  flashes: number;
  smokes: number;
  /** 当前手持武器槽位（0=AK 1=手枪 2=小刀 3=手雷 4=闪光 5=烟雾），协议 v2 新增。 */
  weaponSlot: number;
  /** 切枪结束时间戳（Date.now()）；0 表示不在切枪中。 */
  switchEndAt: number;
  /** 是否下蹲（服务端权威）：弹道起点眼高、判定体压缩、远端化身蹲姿共用。 */
  crouch?: boolean;
  /** 队伍（"T" / "CT"）：远端模型配色与出生朝向共用，协议 v2 新增。 */
  team: string;
  /** 角色下标（`CHARACTER_IDS` 的顺序）：只影响外观，决定远端模型与头像。 */
  character: number;
}

/** 与 Colyseus MapSchema 结构兼容的最小只读接口。 */
export interface PlayerMap {
  readonly size: number;
  forEach(callback: (player: PlayerState, sessionId: string) => void): void;
}

/** 与 Colyseus MapSchema 结构兼容的最小只读接口（烟雾云团）。 */
export interface CloudMap {
  readonly size: number;
  forEach(callback: (cloud: SmokeCloudView, id: string) => void): void;
}

export interface BattleRoomState {
  players: PlayerMap;
  clouds: CloudMap;
}
