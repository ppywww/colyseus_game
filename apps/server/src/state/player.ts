import { Schema, type } from "@colyseus/schema";

/** 同步给客户端的玩家状态：身份 + 位置/视角 + 战斗状态（S3）。 */
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

  @type("uint8")
  public hp: number = 100;

  @type("boolean")
  public alive: boolean = true;

  @type("uint16")
  public kills: number = 0;

  @type("uint16")
  public deaths: number = 0;

  /** 重生序号：每次重生 +1，客户端据此把本地位置吸附到服务端出生点。 */
  @type("uint16")
  public respawnSeq: number = 0;

  /** 预计重生的服务端时间戳（Date.now()，毫秒）；0 表示存活或无需倒计时。 */
  @type("float64")
  public respawnAt: number = 0;
}
