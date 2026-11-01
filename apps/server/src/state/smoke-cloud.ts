import { Schema, type } from "@colyseus/schema";

/**
 * 烟雾云团：服务端权威存在，进入状态的玩家都能看到（含中途加入者）。
 * 客户端按 expiresAt 自行淡出，并在过期后由服务端从状态中移除。
 */
export class SmokeCloud extends Schema {
  @type("string")
  public id: string = "";

  @type("float32")
  public x: number = 0;

  @type("float32")
  public z: number = 0;

  @type("float32")
  public radius: number = 0;

  /** 服务端过期时间戳（Date.now() 毫秒）。 */
  @type("float64")
  public expiresAt: number = 0;
}
