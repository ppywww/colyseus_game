import { Room, type Client } from "@colyseus/core";
import type { Logger } from "pino";

import {
  EYE_HEIGHT,
  GAME_TICK_INTERVAL_MS,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_PLAYERS_PER_ROOM,
  MELEE_COOLDOWN_MS,
  FIRE_COOLDOWN_TOLERANCE,
  MESSAGE_TYPES,
  PISTOL_MAG_SIZE,
  PISTOL_RESERVE_AMMO,
  PLAYER_MAX_HP,
  PLAYER_RESPAWN_DELAY_MS,
  PROTOCOL_VERSION,
  THROWABLES,
  THROW_COOLDOWN_MS,
  THROW_ORIGIN_FORWARD,
  THROW_SPEED,
  THROWABLE_TYPES,
  WEAPON_MAG_SIZE,
  WEAPON_RELOAD_MS,
  WEAPON_RESERVE_AMMO,
  WEAPON_SLOTS,
  fireProfileOf,
  hashString,
  isSlotEnabled,
  mixShotSeed,
  obstacleColliders,
  sampleSpread,
  slotOfThrowable,
  switchDurationOf,
  throwableTypeOfSlot,
  type Aabb,
  type DamageTakenMessage,
  type ExplosionMessage,
  type FlashEffectMessage,
  type GrenadeLaunchedMessage,
  type HitZone,
  type KillMessage,
  type KnifeResultMessage,
  type PingMessage,
  type PongMessage,
  type TeamId,
  type ThrowableType,
  type ThrowMessage,
} from "@colyseus-fps/shared";

import { BattleState } from "../state/battle-state.js";
import { Player } from "../state/player.js";
import { SmokeCloud } from "../state/smoke-cloud.js";
import { createLogger } from "../utils/logger.js";
import { computeShot } from "./combat.js";
import {
  clampThrowDirection,
  explosionDamage,
  flashIntensity,
  normalizeVec,
  stepGrenade,
  type GrenadeState,
} from "./grenades.js";
import { pickSpawnPoint, type SpawnSelection } from "./spawn.js";
import { resolveKnife } from "./melee.js";
import {
  acceptAimSnapshot,
  acceptFireOrigin,
  overlapsObstacle,
  sanitizeTransform,
  type AimSnapshot,
} from "./transform.js";

export interface FPSBattleRoomOptions {
  maxClients?: number;
  logLevel?: string;
}

interface JoinOptionsPayload {
  name?: unknown;
  protocolVersion?: unknown;
}

function readJoinOptions(options: unknown): JoinOptionsPayload {
  return typeof options === "object" && options !== null ? options as JoinOptionsPayload : {};
}

function sanitizeDisplayName(rawName: unknown, sessionId: string): string {
  if (typeof rawName === "string") {
    const trimmed: string = rawName.trim();
    if (trimmed.length > 0) {
      return Array.from(trimmed).slice(0, MAX_DISPLAY_NAME_LENGTH).join("");
    }
  }
  return `玩家-${sessionId.slice(0, 6)}`;
}

/** 投掷物类型 → 玩家状态上的数量字段。 */
type InventoryField = "frags" | "flashes" | "smokes";

function inventoryFieldOf(type: ThrowableType): InventoryField {
  if (type === THROWABLE_TYPES.FRAG) {
    return "frags";
  }
  return type === THROWABLE_TYPES.FLASH ? "flashes" : "smokes";
}

function countOf(player: Player, type: ThrowableType): number {
  return player[inventoryFieldOf(type)];
}

function setCountOf(player: Player, type: ThrowableType, value: number): void {
  player[inventoryFieldOf(type)] = Math.max(0, Math.min(255, value));
}

/**
 * 槽位 → `Player` 上的弹匣/备弹字段名。
 *
 * 步枪与手枪各有一套完全独立的弹药（协议 v2 的硬要求：手枪打完步枪仍有 30 发），
 * 把字段名收敛到一个函数里，`FIRE` / `RELOAD` / 重生三处就不会各写一遍分支。
 */
interface SlotAmmoFields {
  mag: "ammo" | "pistolAmmo";
  reserve: "reserve" | "pistolReserve";
}

function ammoFieldsOf(slot: number): SlotAmmoFields {
  return slot === 1
    ? { mag: "pistolAmmo", reserve: "pistolReserve" }
    : { mag: "ammo", reserve: "reserve" };
}

/** 读该槽位的剩余投掷物数量（枪 / 刀返回 −1，表示"不适用"）。 */
function throwableCountOf(player: Player, slot: number): number {
  const type = throwableTypeOfSlot(slot);
  return type === null ? -1 : countOf(player, type);
}

/**
 * 由「加入序号」决定队伍：偶数进 T 侧、奇数进 CT 侧。
 *
 * 为什么队伍仍然按序号而不是让玩家自选：本期没有选边 UI，序号交替是最稳定的
 * 4v4 切分方式；出生点本身已改为「每队 4 点随机」（见 `spawn.ts` 的 `pickSpawnPoint`），
 * 所以队伍只决定候选点集合，不再决定具体站位。
 */
export function teamOfJoinIndex(index: number): TeamId {
  return index % 2 === 0 ? "T" : "CT";
}

/** 读回玩家的队伍（`Player.team` 是同步字段，非法值一律按 T 处理）。 */
export function teamOfPlayer(player: { team: string }): TeamId {
  return player.team === "CT" ? "CT" : "T";
}

/** FPS 对战房间：S1 联机、S2 位置同步、S3 服务端权威战斗、S4 弹药与投掷物。 */
export class FPSBattleRoom extends Room<BattleState> {
  private logger: Logger = createLogger("info");
  private readonly obstacles: readonly Aabb[] = obstacleColliders();
  /** 每玩家上次开火时间戳（服务端限流依据）。 */
  private readonly lastFireAt = new Map<string, number>();
  /** 每玩家上次投掷时间戳（服务端限流依据）。 */
  private readonly lastThrowAt = new Map<string, number>();
  /** 每玩家上次挥刀时间戳（服务端限流依据，{@link MELEE_COOLDOWN_MS}）。 */
  private readonly lastKnifeAt = new Map<string, number>();
  /**
   * 每玩家当前这一串连发的发数（0 = 下一发是第一发）。
   *
   * 扩散半角由它查表、随机偏移由它当种子的一部分，所以它必须**严格等于**客户端
   * 用来画准星的那个游标，两边都按「成功开火 +1 / 停火 sprayResetMs 归零 /
   * 切枪·换弹·死亡·重生归零」维护。不一致的具体后果是：准星张到 2.6° 了，
   * 服务端还按 0.2° 结算 —— 玩家觉得"扫射比点射还准"。
   */
  private readonly sprayIndex = new Map<string, number>();
  /**
   * 本房间的扩散随机种子（**永不广播**）。
   *
   * 每局房间随机生成：作弊者只能猜到"偏移是确定的"，猜不到具体偏到哪，
   * 因此无法"等偏到人身上再开枪"；而服务端可以凭它完整回放任何一发争议弹道。
   */
  private readonly roomSeed: number = (Math.random() * 0x100000000) >>> 0;
  /** 飞行中的投掷物（服务端权威模拟）。 */
  private readonly grenades = new Map<number, GrenadeState>();
  private nextGrenadeId = 1;
  /** 加入序号游标：只用来交替分配队伍（出生位置由 `pickSpawnPoint` 随机决定）。 */
  private spawnCursor = 0;

  /** 投掷物模拟步长（毫秒）：比状态同步更密，保证抛物线平滑。 */
  private static readonly GRENADE_STEP_MS = 50;

  public override onCreate(options: FPSBattleRoomOptions = {}): void {
    this.maxClients = options.maxClients ?? MAX_PLAYERS_PER_ROOM;
    this.patchRate = GAME_TICK_INTERVAL_MS;
    this.setState(new BattleState());
    this.logger = createLogger(options.logLevel ?? "info").child({ roomId: this.roomId });

    this.onMessage<PingMessage>(MESSAGE_TYPES.PING, (client: Client, message: PingMessage) => {
      const sentAt: number = Number.isFinite(message?.sentAt) ? message.sentAt : Date.now();
      const response: PongMessage = {
        sentAt,
        serverTime: Date.now(),
        protocolVersion: PROTOCOL_VERSION,
      };
      client.send(MESSAGE_TYPES.PONG, response);
    });

    this.onMessage<unknown>(MESSAGE_TYPES.PLAYER_TRANSFORM, (client: Client, raw: unknown) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) {
        return;
      }

      const transform = sanitizeTransform(raw);
      // 丢弃非法消息与乱序包（seq 回绕按 uint32 比较处理常见情形）
      if (transform === null || transform.seq <= player.seq) {
        return;
      }

      // 障碍物校验：脚底中心嵌在任何体块里 → 拒绝本次上报，保留上一合法位置。
      // 之所以"拒绝"而不是"推出"：推出会和客户端物理互相打架（橡皮筋），
      // 单向不采纳则客户端自己走出来的那一帧立刻就被接受。
      if (overlapsObstacle(transform.x, transform.y, transform.z, this.obstacles)) {
        this.logger.debug(
          { playerId: client.sessionId, x: transform.x, y: transform.y, z: transform.z },
          "位置上报嵌在障碍物内，已丢弃并保留上一合法位置",
        );
        return;
      }

      player.seq = transform.seq;
      player.x = transform.x;
      player.y = transform.y;
      player.z = transform.z;
      player.yaw = transform.yaw;
      player.pitch = transform.pitch;
      // 下蹲：弹道起点眼高与判定体压缩都读它，因此必须与位置同一包更新，
      // 不能另开一条低频消息（否则蹲下的那一瞬间会有一发"站着的高度"）。
      player.crouch = transform.crouch === true;
    });

    // S3：开火。弹道完全由服务端状态计算，客户端无法伪造命中。
    // v2：上行可携带视角快照 `{ yaw, pitch }`，服务端在 ±3° 内采信（把方向陈旧从 ≤66ms 压到 ~0），
    //     超出 3° 或非法则回退到已存视角（防"瞬移视野爆头"）。
    // v3（本批）：按 `weaponSlot` 取手感参数——只有 0/1 走弹道，刀与投掷物由各自的 handler 处理。
    this.onMessage<unknown>(MESSAGE_TYPES.FIRE, (client: Client, raw: unknown) => {
      const shooter = this.state.players.get(client.sessionId);
      if (!shooter || !shooter.alive) {
        return;
      }

      const profile = fireProfileOf(shooter.weaponSlot);
      // 刀（2）与投掷物（3/4/5）没有弹道：左键那一下由 KNIFE / THROW handler 负责
      if (profile === null) {
        return;
      }

      const now = Date.now();
      // 换弹中、切枪中或弹匣空：忽略（客户端自行播放空仓音效）
      if (shooter.reloadEndAt > now || shooter.switchEndAt > now) {
        return;
      }

      const fields: SlotAmmoFields = ammoFieldsOf(shooter.weaponSlot);
      if (shooter[fields.mag] <= 0) {
        return;
      }

      // 冷却按武器各自的口径（AK 100ms / 手枪 170ms），不能共用一张表。
      //
      // 留 20% 容差的原因：客户端全自动按"刚好 cooldownMs"驱动，而网络抖动的到达时间
      // 是前后浮动几个毫秒的——用严格 `>= cooldownMs` 判定，抖动到早一点的那一发会被
      // **静默丢弃**，玩家感受到的是"连发中间断了一拍"。20% 容差让 AK 的硬上限变成
      // 12.5 发/秒（真实 10 发/秒），不足以成为作弊优势，但足够吸收网络抖动。
      const last = this.lastFireAt.get(client.sessionId) ?? 0;
      if (now - last < profile.cooldownMs * FIRE_COOLDOWN_TOLERANCE) {
        return;
      }
      // 停火超过 sprayResetMs → 这一发算第一发，扩散回到 spreadFirstDeg。
      // 与客户端画准星用的是同一个规则、同一个游标，否则准星张开的幅度和真实圆锥无关。
      const sprayShotIndex: number =
        now - last > profile.sprayResetMs ? 0 : this.sprayIndex.get(client.sessionId) ?? 0;
      this.sprayIndex.set(client.sessionId, sprayShotIndex + 1);
      this.lastFireAt.set(client.sessionId, now);
      shooter[fields.mag] -= 1;

      // 服务端权威扩散：种子 = 房间种子 ^ 玩家盐 ^ 发数。
      // 同发可复现（QA 能断言、争议弹道能回放），但房间种子不广播 → 作弊者无法预测。
      const spread = sampleSpread(
        profile,
        sprayShotIndex,
        mixShotSeed(this.roomSeed, hashString(client.sessionId), sprayShotIndex),
      );

      const aim: AimSnapshot | null = acceptAimSnapshot(raw, { yaw: shooter.yaw, pitch: shooter.pitch });
      // 开火瞬间的位置快照：判定射线必须从玩家屏幕上看到的位置出发，否则移动中开枪
      // 的起点会落后一个 30Hz 上报周期（全速奔跑约 18cm），表现为"子弹不是从枪口出来"。
      const fireOrigin = acceptFireOrigin(
        raw,
        { x: shooter.x, y: shooter.y, z: shooter.z },
        this.obstacles,
      );
      // 客户端开火序号：只做回显，不参与判定。客户端靠它把这一发和"抠扳机那一刻
      // 的枪口坐标"对上号——服务端在上面任何一个 return 里丢掉的那一发，
      // 都不会让后面每一发的曳光错位一格。
      const rawSeq: number = Number((raw as { seq?: unknown } | null)?.seq);
      const shotSeq: number = Number.isFinite(rawSeq) ? Math.max(0, Math.trunc(rawSeq)) : 0;
      const shot = computeShot(
        this.state.players.values(),
        client.sessionId,
        this.obstacles,
        aim ?? undefined,
        profile.range,
        fireOrigin,
        spread,
        shotSeq,
      );
      if (shot === null) {
        return;
      }
      this.broadcast(MESSAGE_TYPES.SHOT, shot);

      if (shot.hitPlayerId !== null) {
        this.applyDamage(client.sessionId, shot.hitPlayerId, shot.damage, shot.hitZone);
      }
    });

    // v3：切枪（滚轮 / 数字键）。服务端权威——客户端只发"我想切到第几号槽"。
    this.onMessage<unknown>(MESSAGE_TYPES.WEAPON_SWITCH, (client: Client, raw: unknown) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || !player.alive) {
        return;
      }

      const requested: number = Number((raw as { slot?: unknown } | null)?.slot);
      // 1) 槽位必须是 0..5 的整数，且本期已实现（SLOT_ENABLED）
      if (!isSlotEnabled(requested)) {
        return;
      }
      // 2) 已经在这个槽位上：不用再切（避免重复播切枪动画）
      if (requested === player.weaponSlot) {
        return;
      }
      const now = Date.now();
      // 3) 上一次切枪还没结束：拒绝（这是"连滚三格瞬间到位"的唯一防线）
      if (player.switchEndAt > now) {
        return;
      }
      // 4) 数量为 0 的投掷物槽不可切（枪 / 刀恒可用，throwableCountOf 返回 −1）
      if (throwableCountOf(player, requested) === 0) {
        return;
      }

      player.weaponSlot = requested;
      player.switchEndAt = now + switchDurationOf(requested);
      // 换枪必须重置扩散游标：否则切到手枪的第一发会继承 AK 扫了 20 发后的 2.6° 扩散
      this.sprayIndex.delete(client.sessionId);
      this.logger.debug(
        { playerId: client.sessionId, slot: requested, switchEndAt: player.switchEndAt },
        "玩家切换武器槽",
      );
    });

    // S6：挥刀（小刀是服务端权威的扇形判定，见 `melee.ts`）
    this.onMessage<unknown>(MESSAGE_TYPES.KNIFE, (client: Client, raw: unknown) => {
      const attacker = this.state.players.get(client.sessionId);
      if (!attacker || !attacker.alive) {
        return;
      }
      // 只有手里拿着刀才能挥（防止用枪的槽位触发近战）
      if (attacker.weaponSlot !== WEAPON_SLOTS.KNIFE) {
        return;
      }
      const now = Date.now();
      // 切枪中不能挥刀（与服务端 `switchEndAt` 语义保持一致）
      if (attacker.switchEndAt > now) {
        return;
      }
      const last = this.lastKnifeAt.get(client.sessionId) ?? 0;
      if (now - last < MELEE_COOLDOWN_MS) {
        return;
      }
      this.lastKnifeAt.set(client.sessionId, now);

      const aim: AimSnapshot | null = acceptAimSnapshot(raw, { yaw: attacker.yaw, pitch: attacker.pitch });
      const result: KnifeResultMessage | null = resolveKnife(
        this.state.players.values(),
        client.sessionId,
        aim ?? undefined,
      );
      if (result === null) {
        return;
      }
      // 挥空也要广播：远端玩家靠这条消息播"他正在挥刀"的手臂动画
      this.broadcast(MESSAGE_TYPES.KNIFE_RESULT, result);

      if (result.hitPlayerId !== null) {
        // 刀不吃部位倍率（只有正面/背刺两档），zone 传 null
        this.applyDamage(client.sessionId, result.hitPlayerId, result.damage, null);
      }
    });

    // S4：换弹（服务端结算弹药，客户端只做动画与提示）
    this.onMessage(MESSAGE_TYPES.RELOAD, (client: Client) => {
      this.handleReload(client);
    });

    // S4：投掷手雷 / 闪光弹 / 烟雾弹
    this.onMessage<unknown>(MESSAGE_TYPES.THROW, (client: Client, raw: unknown) => {
      this.handleThrow(client, raw);
    });

    this.setSimulationInterval((deltaMs: number) => {
      this.updateGrenades(deltaMs);
    }, FPSBattleRoom.GRENADE_STEP_MS);

    this.logger.info({ maxClients: this.maxClients, patchRate: this.patchRate }, "房间已创建");
  }

  public override onJoin(client: Client, options: unknown): void {
    const joinOptions: JoinOptionsPayload = readJoinOptions(options);
    if (joinOptions.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error("PROTOCOL_VERSION_MISMATCH");
    }

    const player = new Player();
    player.sessionId = client.sessionId;
    player.displayName = sanitizeDisplayName(joinOptions.name, client.sessionId);
    player.joinedAt = Date.now();

    const team: TeamId = teamOfJoinIndex(this.spawnCursor);
    this.spawnCursor += 1;
    player.team = team;
    this.state.players.set(client.sessionId, player);
    this.placeAtSpawn(player, team);

    this.logger.info(
      {
        playerId: client.sessionId,
        displayName: player.displayName,
        team,
        spawnIndex: player.lastSpawnIndex,
        clients: this.clients.length,
      },
      "玩家已加入",
    );
  }

  /**
   * 把玩家放到一个新出生点（加入与重生共用）。
   *
   * 出生点由 `pickSpawnPoint` 在同队 4 点里随机，并做「占位 / 敌人视线 / 避免连续同点」三级过滤，
   * 见 `spawn.ts` 的文件头注释。
   */
  private placeAtSpawn(player: Player, team: TeamId): void {
    const selection: SpawnSelection = pickSpawnPoint({
      team,
      selfId: player.sessionId,
      lastIndex: player.lastSpawnIndex,
      players: this.state.players.values(),
      obstacles: this.obstacles,
    });
    player.x = selection.point.x;
    player.y = 0;
    player.z = selection.point.z;
    // 朝向直接取出生表：T 面向 −Z、CT 面向 +Z，不再让所有人朝地图中心扎堆
    player.yaw = selection.point.yaw;
    player.lastSpawnIndex = selection.index;
    if (selection.overflow) {
      this.logger.debug({ playerId: player.sessionId, team }, "同队 4 点全被占用，使用 +X 偏移兜底出生点");
    }
  }

  public override onLeave(client: Client): void {
    this.lastFireAt.delete(client.sessionId);
    this.lastThrowAt.delete(client.sessionId);
    this.lastKnifeAt.delete(client.sessionId);
    this.sprayIndex.delete(client.sessionId);
    const removed: boolean = this.state.players.delete(client.sessionId);
    this.logger.info({ playerId: client.sessionId, removed, clients: this.clients.length }, "玩家已离开");
  }

  /**
   * 结算伤害；致死时更新计分、广播击杀并安排重生。
   *
   * @param zone 命中部位（枪械来自弹道判定）；手雷等"不吃部位倍率"的伤害传 null。
   */
  private applyDamage(killerId: string, victimId: string, amount: number, zone: HitZone | null): void {
    const victim = this.state.players.get(victimId);
    if (!victim || !victim.alive) {
      return;
    }

    victim.hp = Math.max(0, victim.hp - amount);

    // 只发给受伤者本人：用于受击方向指示与屏幕反馈
    const victimClient = this.clients.find((item) => item.sessionId === victimId);
    if (victimClient !== undefined) {
      const attacker = this.state.players.get(killerId);
      const message: DamageTakenMessage = {
        attackerId: killerId,
        amount,
        hp: victim.hp,
        fromX: attacker?.x ?? victim.x,
        fromZ: attacker?.z ?? victim.z,
        zone,
      };
      victimClient.send(MESSAGE_TYPES.DAMAGED, message);
    }

    if (victim.hp > 0) {
      return;
    }

    victim.alive = false;
    victim.deaths += 1;
    victim.respawnAt = Date.now() + PLAYER_RESPAWN_DELAY_MS;
    // 死亡清空扩散游标：重生后第一发必须是准的（否则玩家"刚复活就散得打不中人"）
    this.sprayIndex.delete(victimId);

    const killer = this.state.players.get(killerId);
    if (killer) {
      killer.kills += 1;
    }

    const killMessage: KillMessage = {
      killerId,
      victimId,
      weaponSlot: killer?.weaponSlot ?? 0,
      headshot: zone === "head",
    };
    this.broadcast(MESSAGE_TYPES.KILL, killMessage);
    this.logger.info({ killerId, victimId, amount, zone, headshot: killMessage.headshot }, "玩家被击杀");

    this.clock.setTimeout(() => {
      this.respawn(victimId);
    }, PLAYER_RESPAWN_DELAY_MS);
  }

  /**
   * 换弹：校验后延迟补满**当前槽位**的弹匣（子弹从该枪自己的备弹扣除）。
   *
   * 为什么按槽位而不是按 `ammo` 字段：手枪换弹时步枪的 30 发必须保持不动，
   * 否则玩家切回 AK 会发现弹匣莫名其妙被填满了（等于无限子弹）。
   */
  private handleReload(client: Client): void {
    const player = this.state.players.get(client.sessionId);
    if (!player || !player.alive) {
      return;
    }

    const profile = fireProfileOf(player.weaponSlot);
    if (profile === null) {
      // 刀 / 投掷物没有弹匣，R 键无效
      return;
    }
    const fields: SlotAmmoFields = ammoFieldsOf(player.weaponSlot);
    if (player[fields.mag] >= profile.magSize || player[fields.reserve] <= 0) {
      return;
    }
    if (player.reloadEndAt > Date.now()) {
      return;
    }

    const slot: number = player.weaponSlot;
    player.reloadEndAt = Date.now() + WEAPON_RELOAD_MS;
    // 换弹期间夹具复位，换完第一发必须回到首发精度（CS 里换弹确实会重置喷弹形）
    this.sprayIndex.delete(client.sessionId);
    this.clock.setTimeout(() => {
      const current = this.state.players.get(client.sessionId);
      if (!current || !current.alive) {
        return;
      }
      const target: SlotAmmoFields = ammoFieldsOf(slot);
      const need: number = profile.magSize - current[target.mag];
      const take: number = Math.min(need, current[target.reserve]);
      current[target.mag] += take;
      current[target.reserve] -= take;
      current.reloadEndAt = 0;
    }, WEAPON_RELOAD_MS);
  }

  /** 投掷：校验数量/冷却/方向后创建服务端权威投掷物。 */
  private handleThrow(client: Client, raw: unknown): void {
    const player = this.state.players.get(client.sessionId);
    if (!player || !player.alive) {
      return;
    }

    const payload = raw as Partial<ThrowMessage> | null;
    const type = payload?.type;
    if (type !== THROWABLE_TYPES.FRAG && type !== THROWABLE_TYPES.FLASH && type !== THROWABLE_TYPES.SMOKE) {
      return;
    }

    const remaining = countOf(player, type);
    if (remaining <= 0) {
      return;
    }

    const now = Date.now();
    const last = this.lastThrowAt.get(client.sessionId) ?? 0;
    if (now - last < THROW_COOLDOWN_MS) {
      return;
    }

    const rawDir = normalizeVec(
      Number(payload?.dirX ?? 0),
      Number(payload?.dirY ?? 0),
      Number(payload?.dirZ ?? -1),
    );
    if (rawDir === null) {
      return;
    }
    const dir = clampThrowDirection(rawDir);

    this.lastThrowAt.set(client.sessionId, now);
    setCountOf(player, type, remaining - 1);

    // 快捷投掷（G/F/V）自动切到该投掷物槽位：远端玩家才能看到"他手里拿着手雷"，
    // 而不是"空着手凭空飞出一颗雷"。switchEndAt 置 0 表示这次切槽不参与切枪拦截
    // （客户端同一帧就发出了 THROW，不能被自己刚设的 250ms 冷却吞掉）。
    player.weaponSlot = slotOfThrowable(type);
    player.switchEndAt = 0;

    const origin = {
      x: player.x + dir.x * THROW_ORIGIN_FORWARD,
      y: player.y + EYE_HEIGHT - 0.15 + dir.y * THROW_ORIGIN_FORWARD,
      z: player.z + dir.z * THROW_ORIGIN_FORWARD,
    };
    const id = this.nextGrenadeId;
    this.nextGrenadeId += 1;

    const grenade: GrenadeState = {
      id,
      type,
      throwerId: client.sessionId,
      x: origin.x,
      y: origin.y,
      z: origin.z,
      vx: dir.x * THROW_SPEED,
      vy: dir.y * THROW_SPEED,
      vz: dir.z * THROW_SPEED,
      fuseMs: THROWABLES[type].fuseMs,
    };
    this.grenades.set(id, grenade);

    const launched: GrenadeLaunchedMessage = {
      id,
      type,
      throwerId: client.sessionId,
      origin,
      velocity: { x: grenade.vx, y: grenade.vy, z: grenade.vz },
    };
    this.broadcast(MESSAGE_TYPES.GRENADE, launched);
    this.logger.debug({ playerId: client.sessionId, type, id }, "投掷物已投出");
  }

  /** 逐个推进投掷物；引信到期即生效。 */
  private updateGrenades(deltaMs: number): void {
    if (this.grenades.size === 0) {
      return;
    }
    const dtSeconds = Math.min(deltaMs, 100) / 1000;

    for (const [id, grenade] of this.grenades) {
      stepGrenade(grenade, dtSeconds, this.obstacles);
      grenade.fuseMs -= deltaMs;
      if (grenade.fuseMs <= 0) {
        this.grenades.delete(id);
        this.detonate(grenade);
      }
    }
  }

  /** 投掷物生效：广播特效，并按键类型结算伤害/致盲/烟雾。 */
  private detonate(grenade: GrenadeState): void {
    const config = THROWABLES[grenade.type];
    const message: ExplosionMessage = {
      id: grenade.id,
      type: grenade.type,
      throwerId: grenade.throwerId,
      x: grenade.x,
      y: grenade.y,
      z: grenade.z,
      radius: config.radius,
    };
    this.broadcast(MESSAGE_TYPES.EXPLODE, message);

    if (grenade.type === THROWABLE_TYPES.FRAG) {
      const victims = explosionDamage(
        { x: grenade.x, y: grenade.y, z: grenade.z },
        config.radius,
        config.maxDamage ?? 100,
        config.minDamage ?? 20,
        this.state.players.values(),
        this.obstacles,
      );
      for (const victim of victims) {
        // 手雷不吃部位倍率（按爆炸距离线性衰减，对全身生效），因此 zone 传 null
        this.applyDamage(grenade.throwerId, victim.sessionId, victim.damage, null);
      }
      return;
    }

    if (grenade.type === THROWABLE_TYPES.FLASH) {
      for (const player of this.state.players.values()) {
        if (!player.alive) {
          continue;
        }
        const intensity = flashIntensity(
          { x: grenade.x, y: grenade.y, z: grenade.z },
          config.radius,
          player,
          // 视线遮挡：躲在掩体后不吃闪（CS2 规则）
          this.obstacles,
        );
        if (intensity <= 0.05) {
          continue;
        }
        const target = this.clients.find((item) => item.sessionId === player.sessionId);
        if (target === undefined) {
          continue;
        }
        const flash: FlashEffectMessage = {
          intensity,
          durationMs: Math.round((config.maxBlindMs ?? 2800) * intensity),
          sourceX: grenade.x,
          sourceZ: grenade.z,
        };
        target.send(MESSAGE_TYPES.FLASH, flash);
      }
      return;
    }

    // 烟雾弹：写入状态，客户端渲染云团；到期后自动移除
    const cloudId = `smoke-${grenade.id}`;
    const cloud = new SmokeCloud();
    cloud.id = cloudId;
    cloud.x = grenade.x;
    cloud.z = grenade.z;
    cloud.radius = config.radius;
    const durationMs = config.cloudDurationMs ?? 15000;
    cloud.expiresAt = Date.now() + durationMs;
    this.state.clouds.set(cloudId, cloud);

    this.clock.setTimeout(() => {
      this.state.clouds.delete(cloudId);
    }, durationMs);
  }

  /** 重生：重置血量/位置/弹药/道具，respawnSeq 自增驱动客户端吸附到出生点。 */
  private respawn(sessionId: string): void {
    const player = this.state.players.get(sessionId);
    if (!player || player.alive) {
      return;
    }

    this.placeAtSpawn(player, teamOfPlayer(player));
    player.hp = PLAYER_MAX_HP;
    player.alive = true;
    player.respawnAt = 0;
    player.respawnSeq += 1;
    player.ammo = WEAPON_MAG_SIZE;
    player.reserve = WEAPON_RESERVE_AMMO;
    player.pistolAmmo = PISTOL_MAG_SIZE;
    player.pistolReserve = PISTOL_RESERVE_AMMO;
    player.reloadEndAt = 0;
    player.frags = THROWABLES.frag.initialCount;
    player.flashes = THROWABLES.flash.initialCount;
    player.smokes = THROWABLES.smoke.initialCount;
    player.weaponSlot = 0;
    this.sprayIndex.delete(sessionId);
    player.switchEndAt = 0;
    player.armor = 0;
    // 重生站直：否则上一局蹲着死，复活后仍是蹲姿（判定体压扁 37%，白赚一次对枪优势）
    player.crouch = false;

    this.logger.info({ playerId: sessionId }, "玩家已重生");
  }

  public override onDispose(): void {
    this.logger.info("房间已销毁");
  }
}
