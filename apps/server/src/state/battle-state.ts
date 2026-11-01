import { MapSchema, Schema, type } from "@colyseus/schema";

import { Player } from "./player.js";
import { SmokeCloud } from "./smoke-cloud.js";

/** 对战房间状态：玩家列表 + 烟雾云团（S4）。 */
export class BattleState extends Schema {
  @type({ map: Player })
  public players = new MapSchema<Player>();

  @type({ map: SmokeCloud })
  public clouds = new MapSchema<SmokeCloud>();
}
