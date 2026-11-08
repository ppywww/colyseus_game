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
  frags: number;
  flashes: number;
  smokes: number;
  /** 当前手持武器槽位（0=AK 1=手枪 2=小刀 3=手雷 4=闪光 5=烟雾），协议 v2 新增。 */
  weaponSlot: number;
  /** 队伍（"T" / "CT"）：远端模型配色与出生朝向共用，协议 v2 新增。 */
  team: string;
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
