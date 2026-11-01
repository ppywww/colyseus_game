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
