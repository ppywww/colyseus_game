export interface PlayerState {
  sessionId: string;
  displayName: string;
  joinedAt: number;
}

/** 与 Colyseus MapSchema 结构兼容的最小只读接口。 */
export interface PlayerMap {
  readonly size: number;
  forEach(callback: (player: PlayerState, sessionId: string) => void): void;
}

export interface BattleRoomState {
  players: PlayerMap;
}
