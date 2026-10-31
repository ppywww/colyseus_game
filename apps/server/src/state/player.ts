import { Schema, type } from "@colyseus/schema";

/** S1 阶段同步给客户端的最小玩家状态。 */
export class Player extends Schema {
  @type("string")
  public sessionId: string = "";

  @type("string")
  public displayName: string = "";

  @type("number")
  public joinedAt: number = 0;
}
