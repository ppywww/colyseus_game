import { Schema, type } from "@colyseus/schema";

/** S2 阶段同步给客户端的玩家状态：身份 + 位置/视角。 */
export class Player extends Schema {
  @type("string")
  public sessionId: string = "";

  @type("string")
  public displayName: string = "";

  @type("number")
  public joinedAt: number = 0;

  @type("float32")
  public x: number = 0;

  @type("float32")
  public y: number = 0;

  @type("float32")
  public z: number = 0;

  @type("float32")
  public yaw: number = 0;

  @type("float32")
  public pitch: number = 0;

  @type("uint32")
  public seq: number = 0;
}
