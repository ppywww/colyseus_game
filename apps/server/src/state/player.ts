import { Schema, type } from "@colyseus/schema";

import {
  THROWABLES,
  WEAPON_MAG_SIZE,
  WEAPON_RESERVE_AMMO,
} from "@colyseus-fps/shared";

/** 同步给客户端的玩家状态：身份 + 位置/视角 + 战斗状态（S3）+ 弹药/道具（S4）。 */
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

  /* ---------------- S4：弹药与投掷物 ---------------- */

  /** 当前弹匣内子弹数。 */
  @type("uint8")
  public ammo: number = WEAPON_MAG_SIZE;

  /** 备弹数。 */
  @type("uint16")
  public reserve: number = WEAPON_RESERVE_AMMO;

  /** 换弹完成时间戳（Date.now()，毫秒）；0 表示未在换弹。 */
  @type("float64")
  public reloadEndAt: number = 0;

  @type("uint8")
  public frags: number = THROWABLES.frag.initialCount;

  @type("uint8")
  public flashes: number = THROWABLES.flash.initialCount;

  @type("uint8")
  public smokes: number = THROWABLES.smoke.initialCount;

  /* ---------------- S5：武器槽位与护甲（协议 v2） ---------------- */

  /** 当前手持武器槽位：0=AK 1=手枪 2=小刀 3=手雷 4=闪光 5=烟雾。 */
  @type("uint8")
  public weaponSlot: number = 0;

  /** 切枪结束时间戳（Date.now()，毫秒）；0 表示不在切枪中。 */
  @type("float64")
  public switchEndAt: number = 0;

  /** 护甲值（本期恒 0，预留字段避免下期二次改协议）。 */
  @type("uint8")
  public armor: number = 0;

  /**
   * 队伍（"T" / "CT"）。
   *
   * 为什么进状态同步：出生点候选集（服务端）与下一批的人物模型配色（客户端，两队不同颜色、
   * 禁止用 sessionId 哈希取色）都要用它。类型保持 `string` 而不是 `TeamId`，
   * 是为了让 Colyseus 的 `@type("string")` 序列化不做额外假设。
   */
  @type("string")
  public team: string = "T";

  /* ---------------- 仅服务端使用（不同步） ---------------- */

  /** 上次出生使用的队内下标（出生点"避免连续同点"用），-1 表示尚未出生。 */
  public lastSpawnIndex: number = -1;
}
