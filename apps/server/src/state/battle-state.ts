import { MapSchema, Schema, type } from "@colyseus/schema";

import { Player } from "./player.js";

/** 对战房间状态：S1 仅同步玩家列表，后续扩展位置、血量与比分。 */
export class BattleState extends Schema {
  @type({ map: Player })
  public players = new MapSchema<Player>();
}
