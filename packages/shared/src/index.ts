/**
 * 前后端共享层（骨架占位版本）。
 *
 * 职责边界：
 *   - 只放「服务端与客户端都必须一致」的常量、枚举与类型；
 *   - 不引用任何 Node 专有模块或浏览器专有对象，保持平台中立；
 *   - 不引入运行时依赖，纯类型 + 常量导出。
 *
 * 后续扩展位置：
 *   - src/protocol/  ：消息类型枚举与消息体接口（客户端上行 / 服务端下行）
 *   - src/types/     ：玩家、武器、对局等公共数据结构
 *   - src/constants/ ：随体量增长后从本文件拆分出去
 */

/** 项目名称，用于日志与监控标签。 */
export const PROJECT_NAME: string = "colyseus-fps-prototype";

/** 服务端逻辑帧率（Hz）：每秒推进的次数，客户端渲染帧率与之解耦。 */
export const GAME_TICK_RATE: number = 20;

/** 单个逻辑帧时长（毫秒），由 GAME_TICK_RATE 推导，避免两处硬编码不一致。 */
export const GAME_TICK_INTERVAL_MS: number = 1000 / GAME_TICK_RATE;

/**
 * 单个房间最大玩家数：4v4 = 8 人。
 *
 * 为什么是 8 而不是 10：出生点改为「每队 4 点随机」（见 {@link TEAM_SPAWN_COUNT}），
 * 4 点 vs 每队 4 人一一对应，**永远不会有两人重叠出生**。
 */
export const MAX_PLAYERS_PER_ROOM: number = 8;

/** 客户端状态插值延迟（毫秒）：约等于 2 个逻辑帧，用于平滑远端实体。 */
export const CLIENT_INTERPOLATION_DELAY_MS: number = 100;

/**
 * 单玩家每秒允许发送的消息数量上限（防刷包，服务端据此限流）。
 *
 * 30 → 45 的原因：{@link PLAYER_TRANSFORM_RATE_HZ} 提到 30Hz 后，位置上报本身就会
 * 卡满 30 msg/s，加上开火/换弹/切枪/投掷，30 的阈值会把玩家自己的合法上报限流丢弃。
 *
 * 45 → 60 的原因：AK 改全自动 600 RPM 后开火本身就是 10 msg/s，30（位置）+ 10（开火）
 * = 40/s 已经贴着 45 的线，再叠加换弹/切枪/投掷就会溢出——溢出的包是**静默丢弃**的，
 * 玩家看到的现象是"打着打着枪突然没反应"。60 留出 20 msg/s 余量，同时仍然远低于
 * 人手能刷出的包量，防刷包的作用不变。
 */
export const MAX_MESSAGES_PER_SECOND: number = 60;

/** 协议版本号：客户端与服务端不一致时拒绝连接。v2 = 分区伤害 + 武器槽 + 弹道字段扩展。 */
export const PROTOCOL_VERSION: number = 2;

/** 默认房间名：客户端与服务端必须保持一致。 */
export const DEFAULT_ROOM_NAME: string = "fps_battle";

/** 默认服务端 WebSocket 端口。 */
export const DEFAULT_SERVER_PORT: number = 2567;

/** 玩家显示名最大长度（按字符截断，避免异常长名称刷爆状态同步）。 */
export const MAX_DISPLAY_NAME_LENGTH: number = 24;

/** S2/S3/S5 阶段的客户端/服务端消息类型。 */
export const MESSAGE_TYPES = {
  PING: "ping",
  PONG: "pong",
  PLAYER_TRANSFORM: "player_transform",
  FIRE: "fire",
  SHOT: "shot",
  KILL: "kill",
  RELOAD: "reload",
  THROW: "throw",
  GRENADE: "grenade_launched",
  EXPLODE: "explode",
  FLASH: "flash",
  DAMAGED: "damaged",
  /** v2 新增：切枪请求（客户端上行 `{ slot }`）。 */
  WEAPON_SWITCH: "weapon_switch",
  /** v2 新增：挥刀请求（客户端上行 `{ yaw, pitch }`，可省略）。 */
  KNIFE: "knife",
  /** v2 新增：挥刀结果广播。 */
  KNIFE_RESULT: "knife_result",
} as const;

export type MessageType = (typeof MESSAGE_TYPES)[keyof typeof MESSAGE_TYPES];

/** 加入房间时客户端提交的选项。 */
export interface JoinRoomOptions {
  name?: string;
  protocolVersion: number;
}

/** 客户端 Ping 消息，用于验证消息通道。 */
export interface PingMessage {
  sentAt: number;
}

/** 服务端 Pong 响应。 */
export interface PongMessage {
  sentAt: number;
  serverTime: number;
  protocolVersion: number;
}

/* ------------------------------------------------------------------ *
 * S2：位置与视角同步
 * ------------------------------------------------------------------ */

/**
 * 可玩区半边长（米）。
 *
 * 语义变更（S5 沙漠迷城）：地图从「半径 30 的圆形竞技场」改为 64×64 的矩形城镇，
 * 本常量保留原名以兼容既有调用方（服务端 transform.ts 的 ±30 逐轴钳制恰好与新可玩区一致），
 * 数值仍是 30，表示「可玩区从中心向四个方向各延伸 30 米」。
 * 需要矩形边界时请使用 {@link MAP_BOUNDS}。
 */
export const ARENA_RADIUS: number = 30;

/** 地图外框边长（米）：含 2m 外墙，x/z ∈ [−32, 32]。 */
export const MAP_SIZE: number = 64;

/** 外墙高度（米）：足够阻断视线，玩家不可能跳出。 */
export const WALL_HEIGHT: number = 6;

/** 外墙厚度（米）。 */
export const WALL_THICKNESS: number = 2;

/** 矩形可玩区（米）：客户端移动钳制、手雷反弹与服务端越界钳制的共同依据。 */
export interface MapBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/**
 * 可玩区矩形（外墙内表面）：与外框 64×64 减去 2m 外墙后完全吻合。
 * 客户端 `stepPlayer` 与服务端 `sanitizeTransform` 都按 ±30 逐轴钳制，两端天然一致。
 */
export const MAP_BOUNDS: MapBounds = { minX: -30, maxX: 30, minZ: -30, maxZ: 30 };

/** 玩家眼睛高度（米）：本地相机与远端模型头顶标签的共同依据。 */
export const EYE_HEIGHT: number = 1.6;

/** 玩家身高（米）：远端模型与碰撞体的共同依据。 */
export const PLAYER_HEIGHT: number = 1.8;

/**
 * 客户端上报自身位置/视角的频率（Hz）。
 *
 * 15 → 30 的原因：服务端 `computeShot` 用的是「最后收到的」yaw/pitch，
 * 15Hz 意味着最差 66ms 的陈旧方向，快速甩枪时在 30m 外交战点会偏 0.5–1.6m。
 * 提到 30Hz 把陈旧压到 ≤33ms；配套把 {@link MAX_MESSAGES_PER_SECOND} 提到 45。
 */
export const PLAYER_TRANSFORM_RATE_HZ: number = 30;

/**
 * 客户端上行：开火请求。
 *
 * 除了视角，还携带**开火瞬间的脚底世界坐标**。原因是服务端保存的位置来自 30Hz 的
 * transform 上报，最多陈旧 33ms；全速奔跑 5.5m/s 下就是 18cm，冲刺更快——射线的起点
 * 因此落后于玩家屏幕上看到的自己，Tracer 看起来"不是从枪口出来"。带上位置快照后，
 * 服务端在合理速度范围内采信快照，判定与画面才对得上。
 */
export interface FireMessage {
  /** 开火瞬间的朝向（弧度）。可由服务端 `normalizeYaw` 归一化。 */
  yaw: number;
  /** 开火瞬间的俯仰（弧度）。可由服务端 `clampPitch` 钳制。 */
  pitch: number;
  /** 开火瞬间的脚底坐标；缺省（或校验不通过）时服务端回退自己保存的位置。 */
  x?: number;
  y?: number;
  z?: number;
}

/** 客户端上行：切枪请求（槽位见 {@link WEAPON_SLOTS}）。 */
export interface WeaponSwitchMessage {
  slot: number;
}

/** 客户端上行：挥刀请求。方向可选，缺省时服务端用自身保存的视角判定。 */
export interface KnifeMessage {
  yaw?: number;
  pitch?: number;
}

/** 客户端上行位置/视角消息（seq 单调递增，服务端据此丢弃乱序包）。 */
export interface PlayerTransformMessage {
  seq: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

/** 归一化 yaw 到 (-π, π]。 */
export function normalizeYaw(yaw: number): number {
  const twoPi: number = Math.PI * 2;
  let result: number = yaw % twoPi;
  if (result <= -Math.PI) {
    result += twoPi;
  } else if (result > Math.PI) {
    result -= twoPi;
  }
  return result;
}

/** 钳制 pitch 到 [-π/2, π/2]，防止远端视角翻转。 */
export function clampPitch(pitch: number): number {
  const limit: number = Math.PI / 2;
  return Math.min(limit, Math.max(-limit, pitch));
}

/* ------------------------------------------------------------------ *
 * S3：服务端权威战斗（开火 / 命中 / 血量 / 重生 / 计分）
 * ------------------------------------------------------------------ */

/** 玩家最大血量。 */
export const PLAYER_MAX_HP: number = 100;

/** 单发基础伤害（胸部伤害）：4 发击杀。 */
export const WEAPON_DAMAGE: number = 25;

/**
 * 开火最小间隔（毫秒），服务端据此限流，客户端据此做本地预冷却。
 *
 * 150（400 RPM 单发）→ 100（600 RPM 全自动）：原值下 AK 只能"点一发等 150ms 再点"，
 * 手感是半自动步枪而不是 CS 的 AK。真实 AK-47 是 600 RPM，折算 100ms；配合
 * {@link FIRE_MODES.AUTO}，按住左键由客户端主循环按冷却逐发驱动，服务端仍逐发限流。
 */
export const WEAPON_COOLDOWN_MS: number = 100;

/** 武器射程（米）：超过该距离不再命中玩家。 */
export const WEAPON_RANGE: number = 60;

/** 玩家命中判定圆柱半径（米）。 */
export const PLAYER_HIT_RADIUS: number = 0.35;

/** 死亡后重生延迟（毫秒）。 */
export const PLAYER_RESPAWN_DELAY_MS: number = 3000;

/* ------------------------------------------------------------------ *
 * S5：分区伤害（CS2 口径：头 1 枪 / 胸 4 枪 / 腹·臂·腿 6 枪）
 * ------------------------------------------------------------------ */

/**
 * 命中部位。数组顺序即「同距离时的优先级」（头部优先，避免擦边球掉血）。
 */
export const HIT_ZONES = ["head", "chest", "belly", "arm", "leg"] as const;

export type HitZone = (typeof HIT_ZONES)[number];

/**
 * 权威单发伤害（整数，直接写进 `Player.hp`，**禁止用倍率现算**）。
 *
 * 为什么必须是整数表而不是 `Math.round(25 × 倍率)`：`Player.hp` 是 Colyseus `uint8`，
 * 写入 `18.75` 会被序列化截断成 `18`，客户端 HUD 与服务端算的致死枪数可能差 1 发。
 * HP=100 时：头 1 枪（100）/ 胸 4 枪（25×4）/ 腹·臂 6 枪（19×6=114）/ 腿 6 枪（18×6=108）。
 */
export const ZONE_DAMAGE: Record<HitZone, number> = {
  head: 100,
  chest: 25,
  belly: 19,
  arm: 19,
  leg: 18,
};

/** 文档口径的倍率（= ZONE_DAMAGE / WEAPON_DAMAGE），仅用于 HUD 文案与文档，不参与结算。 */
export const ZONE_MULTIPLIER: Record<HitZone, number> = {
  head: 4.0,
  chest: 1.0,
  belly: 0.76,
  arm: 0.76,
  leg: 0.72,
};

/** 同 t（相差 ≤1cm）时的部位优先级，数字越小越优先。 */
export const ZONE_PRIORITY: Record<HitZone, number> = {
  head: 0,
  chest: 1,
  belly: 2,
  arm: 3,
  leg: 4,
};

/** HUD / 击杀播报文案。 */
export const ZONE_LABEL: Record<HitZone, string> = {
  head: "头部",
  chest: "胸部",
  belly: "腹部",
  arm: "手臂",
  leg: "腿部",
};

/** 单个判定圆柱。 */
export interface HitCylinder {
  zone: HitZone;
  /** 圆柱轴相对角色中心、沿「右手方向」的水平偏移（米，左臂为负）。 */
  offsetRight: number;
  /** 圆柱下沿相对**脚底**的高度（米）。 */
  yMin: number;
  /** 圆柱上沿相对**脚底**的高度（米）。 */
  yMax: number;
  radius: number;
}

/**
 * 玩家判定体：6 个竖直圆柱，总高 0.02 → 1.80，与 {@link PLAYER_HEIGHT} 一致。
 *
 * 站立时（y=0）各段世界高度：
 *   头 [1.63, 1.80]  胸 [1.14, 1.63]  腹 [0.90, 1.14]  臂 [0.98, 1.52]  腿 [0.02, 0.90]
 *
 * 为什么头部下沿取 1.63 而不是模型头顶下沿 1.54：
 *   相机眼高是 1.60，若头部判定从 1.54 起，平地上水平对枪的**每一发**都会落在头段里
 *   （准星恰好压在眼高线上），全场退化成"见面一枪秒"，身体 4 枪的设定永远触发不到。
 *   把头部下沿抬到 1.63（眼高之上 3cm），玩家必须主动抬枪 2–3° 才能爆头，
 *   平射默认命中胸部 —— 这才是 CS 里"点头"的操作含义。代价是视觉上的下巴/颈部算胸部，
 *   属于射击游戏的常规做法（颈部并入侵伤区），A2 建模时头部球体下沿也取 1.63 对齐。
 *
 * 硬约束：
 *   1. 躯干三段（腿→腹→胸→头）必须**首尾相接**（不留缝），缝隙会让垂直下压的子弹从两段之间漏判；
 *   2. 最高段 `yMax` === {@link PLAYER_HEIGHT}，客户端人形模型总高必须与它逐项相等（同源）；
 *   3. 判定体只比模型宽 1–3cm（网络容错方向：宁可判中，不可判漏）。
 */
export const PLAYER_HITBOXES: readonly HitCylinder[] = [
  { zone: "head", offsetRight: 0, yMin: 1.63, yMax: 1.8, radius: 0.13 },
  { zone: "chest", offsetRight: 0, yMin: 1.14, yMax: 1.63, radius: 0.27 },
  { zone: "belly", offsetRight: 0, yMin: 0.9, yMax: 1.14, radius: 0.25 },
  { zone: "arm", offsetRight: 0.3, yMin: 0.98, yMax: 1.52, radius: 0.1 },
  { zone: "arm", offsetRight: -0.3, yMin: 0.98, yMax: 1.52, radius: 0.1 },
  { zone: "leg", offsetRight: 0, yMin: 0.02, yMax: 0.9, radius: 0.2 },
];

/**
 * 视觉枪口相对**眼睛**的偏移（世界坐标系，按 yaw/pitch 旋转后叠加）。
 *
 * `origin = eye + right * right + up * (−down) + dir * forward`
 * 数值与第一人称视模型姿态换算一致（相机 x=+0.239、y=−0.228，枪口在枪身 −0.6 处）。
 */
export const MUZZLE_OFFSET = {
  /** 沿玩家右手方向的偏移。 */
  right: 0.29,
  /** 沿玩家上方向向下的偏移（取正数表示"向下多少"）。 */
  down: 0.2,
  /** 沿视线方向的偏移（视模型是缩放过的假透视，世界尺度取 0.35）。 */
  forward: 0.35,
} as const;

/* ------------------------------------------------------------------ *
 * S5：武器槽位与小刀（本批只定义常量，切枪/挥刀逻辑见下一批）
 * ------------------------------------------------------------------ */

/** 武器槽位：0=AK 1=手枪 2=小刀 3=手雷 4=闪光 5=烟雾。 */
export const WEAPON_SLOTS = {
  RIFLE: 0,
  PISTOL: 1,
  KNIFE: 2,
  FRAG: 3,
  FLASH: 4,
  SMOKE: 5,
} as const;

export type WeaponSlot = (typeof WEAPON_SLOTS)[keyof typeof WEAPON_SLOTS];

/** 滚轮/数字键的槽位顺序（也是 HUD 从左到右的顺序）。 */
export const SLOT_ORDER: readonly WeaponSlot[] = [0, 1, 2, 3, 4, 5];

/** 各槽位是否已实现（手枪本期做，故 PISTOL 为 true；未实现槽位滚轮跳过）。 */
export const SLOT_ENABLED: Record<WeaponSlot, boolean> = {
  0: true,
  1: true,
  2: true,
  3: true,
  4: true,
  5: true,
};

/** 切枪耗时（毫秒）：枪↔枪 350、到近战 300、到投掷物 250。 */
export const SWITCH_DURATION_MS: Record<WeaponSlot, number> = {
  0: 350,
  1: 350,
  2: 300,
  3: 250,
  4: 250,
  5: 250,
};

/** HUD 武器栏的图标文字（6 格，顺序 = {@link SLOT_ORDER}）。 */
export const SLOT_LABEL: Record<WeaponSlot, string> = {
  0: "AK",
  1: "手枪",
  2: "刀",
  3: "手雷",
  4: "闪光",
  5: "烟雾",
};

/** HUD 武器栏左上角的按键角标（数字键 1–6 直达）。 */
export const SLOT_KEY: Record<WeaponSlot, string> = {
  0: "1",
  1: "2",
  2: "3",
  3: "4",
  4: "5",
  5: "6",
};

/** 槽位是否可用：必须是 0..5 的整数，且 {@link SLOT_ENABLED} 为真。 */
export function isSlotEnabled(slot: number): boolean {
  return Number.isInteger(slot) && slot >= 0 && slot < SLOT_ORDER.length && SLOT_ENABLED[slot as WeaponSlot] === true;
}

/** 切到该槽位的耗时（毫秒）；非法槽位回退到最长的 350ms（宁可慢一拍，不要瞬切）。 */
export function switchDurationOf(slot: number): number {
  if (!Number.isInteger(slot) || slot < 0 || slot >= SLOT_ORDER.length) {
    return 350;
  }
  return SWITCH_DURATION_MS[slot as WeaponSlot];
}

/**
 * 环形取「下一个可用槽位」。
 *
 * @param current 当前槽位（非法值按第一个槽位处理）
 * @param direction +1 向后滚（下一把）/ −1 向前滚（上一把）
 * @param isAvailable 该槽位当前是否可切（数量为 0 的投掷物返回 false）
 * @returns 下一个可用槽位；整圈都不可用时返回 `current`（不变）
 *
 * 为什么要「整圈不可用就返回原值」而不是随便挑一个：满弹耗尽时滚轮不该把玩家
 * 甩到某个空槽上，保持不动比乱跳更可控。
 */
export function nextSlot(
  current: number,
  direction: 1 | -1,
  isAvailable: (slot: WeaponSlot) => boolean,
): WeaponSlot {
  const total: number = SLOT_ORDER.length;
  const safeCurrent: number = Number.isInteger(current) && current >= 0 && current < total ? current : 0;
  const start: number = SLOT_ORDER.indexOf(safeCurrent as WeaponSlot);
  const from: number = start < 0 ? 0 : start;

  for (let step = 1; step <= total; step += 1) {
    const index: number = (((from + direction * step) % total) + total) % total;
    const candidate: WeaponSlot = SLOT_ORDER[index] as WeaponSlot;
    if (candidate !== safeCurrent && isAvailable(candidate)) {
      return candidate;
    }
  }
  return safeCurrent as WeaponSlot;
}

/** 小刀正面伤害（满血 2 刀）。 */
export const MELEE_DAMAGE_FRONT: number = 55;

/** 小刀背刺伤害（= 满血上限，数字上不越界）。 */
export const MELEE_DAMAGE_BACK: number = 100;

/** 小刀有效距离（米，水平）：含 0.35m 半径容差 + 陈旧位置延迟预算。 */
export const MELEE_RANGE: number = 2.0;

/** 小刀冷却（毫秒）：DPS 恰为步枪的一半，定位是"没子弹时的应急"。 */
export const MELEE_COOLDOWN_MS: number = 650;

/** 小刀扇形半角（弧度，共 70°）：避免"背后路过被砍到"。 */
export const MELEE_ARC: number = (35 * Math.PI) / 180;

/** 小刀垂直容差（米）：`|Δy|` 上限。 */
export const MELEE_VERTICAL_TOLERANCE: number = 1.6;

/** 背刺判定：目标朝向与"目标→攻击者"方向的夹角超过该值（110°）即视为背刺。 */
export const MELEE_BACKSTAB_ANGLE: number = (110 * Math.PI) / 180;

/** 服务端广播的弹道结果：所有客户端据此渲染轨迹与命中反馈。 */
export interface ShotMessage {
  shooterId: string;
  /**
   * **视觉枪口**（世界坐标）：判定射线其实从眼睛出发（见 rayOrigin），
   * 客户端画弹道线必须用它，否则线会从屏幕正中"凭空"出现。
   */
  origin: { x: number; y: number; z: number };
  /** 判定射线起点（= 眼睛），仅供调试与法线计算，客户端不要拿它画线。 */
  rayOrigin: { x: number; y: number; z: number };
  /** 单位方向向量（= normalize(hit − rayOrigin)）。 */
  dir: { x: number; y: number; z: number };
  /** 弹道终点：命中玩家 / 掩体 / 最大射程处。 */
  hit: { x: number; y: number; z: number };
  /**
   * 命中表面的真实单位法向（由 AABB 的进入面求出）；打空或命中玩家时为 null。
   *
   * 客户端弹孔必须贴着这个法向铺，否则斜着打墙时弹孔会浮在空中或埋进墙里——
   * 旧实现拿"弹道反方向"当法向，只对正对墙面成立，一斜就错。
   */
  hitNormal: { x: number; y: number; z: number } | null;
  /** 命中类型：玩家 / 掩体或地面 / 打空（到达射程尽头）。客户端据此决定画血雾还是弹孔。 */
  hitSurface: "player" | "wall" | "none";
  /** 被命中的玩家 sessionId；未命中玩家（打空或打在掩体上）为 null。 */
  hitPlayerId: string | null;
  /** 命中部位；未命中玩家为 null。 */
  hitZone: HitZone | null;
  /** 实际扣血量（整数，已按 {@link ZONE_DAMAGE} 查表）；未命中为 0。 */
  damage: number;
  /** 开火时使用的武器槽位（{@link WEAPON_SLOTS}）。 */
  weaponSlot: number;
  /**
   * 这一发实际使用的扩散半角（度）；0 表示无扩散（刀/投掷物或功能被关闭）。
   *
   * **不广播随机种子**：种子等于"下一发偏多少"的答案，发出去就等于给作弊客户端
   * 提供了"等偏到人身上再开枪"的能力。只发结果角度，足够客户端画准星和调试。
   */
  spreadDeg: number;
}

/** 服务端广播的击杀事件。 */
export interface KillMessage {
  killerId: string;
  victimId: string;
  /** 致命一击使用的武器槽位（{@link WEAPON_SLOTS}）。 */
  weaponSlot: number;
  /** 致命一击是否爆头。 */
  headshot: boolean;
}

/**
 * 服务端广播的挥刀结果（`KNIFE_RESULT`）。
 *
 * 小刀不做圆柱求交（刀是"扫过一片空间"而不是"射出一条线"），所以没有 `dir` / `hitZone`：
 * 判定依据是「扇形 + 距离」，服务端把所有参数都摊平在消息里，客户端只负责播表现，
 * 不需要自己再算一遍几何（避免两边口径漂移）。
 */
export interface KnifeResultMessage {
  /** 挥刀者 sessionId。 */
  attackerId: string;
  /** 被砍中的玩家 sessionId；挥空为 null。 */
  hitPlayerId: string | null;
  /** 实际扣血（正面 {@link MELEE_DAMAGE_FRONT} / 背刺 {@link MELEE_DAMAGE_BACK}）；挥空为 0。 */
  damage: number;
  /** 是否背刺：命中客户端据此播更重的音效与更大的准心反馈。 */
  backstab: boolean;
  /** 挥刀者当时的**手部**世界坐标（客户端从这里画刀光，不用自己算位置）。 */
  x: number;
  y: number;
  z: number;
  /** 挥刀者当时的朝向（弧度）：客户端据此决定刀光是"从右向左"还是"从左向右"。 */
  yaw: number;
}

/* ------------------------------------------------------------------ *
 * 场地障碍物：渲染（客户端）、碰撞（客户端物理）、弹道遮挡（服务端）
 * 共用同一份数据，保证「所见即所挡」。
 * ------------------------------------------------------------------ */

/**
 * 障碍物类型：只用于客户端渲染分派（几何体 + 材质 + 装饰件），
 * 服务端弹道遮挡与客户端物理都只读 AABB，不关心 type。
 */
export type ObstacleKind = "wall" | "crate" | "cart" | "barrel" | "palm" | "arch" | "building";

export interface ObstacleSpec {
  /** 便于日志/调试与平面图核对的语义 id（如 "W2"、"M1"）。 */
  id: string;
  x: number;
  z: number;
  width: number;
  height: number;
  depth: number;
  color: number;
  type: ObstacleKind;
}

/** 轴对齐包围盒（客户端物理与服务端射线遮挡共用）。 */
export interface Aabb {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

/** 各类障碍物的基准渲染色（地貌配色见 docs/参考-CS2视觉与地图.md 3.8.1）。 */
const OBSTACLE_COLORS: Record<ObstacleKind, number> = {
  wall: 0xc39a63,
  building: 0xb0864f,
  crate: 0xa9713a,
  cart: 0x8a5a2b,
  barrel: 0xb4703a,
  palm: 0x7a5c3a,
  arch: 0xcda976,
};

/** 障碍物定义（不含颜色，颜色由 type 推导），便于逐条对照平面图核对。 */
interface ObstacleSeed {
  id: string;
  type: ObstacleKind;
  x: number;
  z: number;
  width: number;
  height: number;
  depth: number;
}

/**
 * 沙漠迷城（Dust II 风格）实心体块：25 段墙 + 39 个掩体 = 64 个轴对齐盒。
 *
 * 硬约束（不要破坏）：
 *   1. **只允许 AABB**：服务端射线遮挡（rayAabb）与客户端 MTA 推出都只认轴对齐盒；
 *   2. 高度必须落在「≤1.15m 可跳」或「≥1.4m 必绕」两档，1.16–1.39 是灰区（会表现成跳不上去的黏滑手感）；
 *   3. 门洞（中门 4m、A 坡道 4m、B 门 4m、A 小道门 2m、下沉通道 3m、B 洞出口 10m）由相邻墙段之间的空隙形成，
 *      挪动任何一段墙都会改掉枪线长度，改动前请重跑栅格化平面图。
 *
 * 与设计表的两处偏差（均为满足上面的第 2 条，视觉与玩法不变）：
 *   - 油桶 L2 / M3 / T4 的高度取 **1.4m**（真实油桶 42×42×56u ≈ 1.42m），设计表写 1.2m 落在 1.16–1.30 灰区；
 *   - 出生点 T1 的 z 取 25.0（设计表 26.0），否则与 P1 木箱有 0.15m 重叠。
 */
const OBSTACLE_SEEDS: readonly ObstacleSeed[] = [
  /* ---------------- 3.4 墙体清单（25 条） ---------------- */
  // 外墙：外表面 x/z ∈ [−32, 32]，内表面 ±30，高 6m
  { id: "N", type: "wall", x: 0, z: -31, width: 64, height: 6, depth: 2 },
  { id: "S", type: "wall", x: 0, z: 31, width: 64, height: 6, depth: 2 },
  { id: "W", type: "wall", x: -31, z: 0, width: 2, height: 6, depth: 64 },
  { id: "E", type: "wall", x: 31, z: 0, width: 2, height: 6, depth: 64 },
  // A 大道东墙（长门 → 拐角）
  { id: "W1", type: "wall", x: -21, z: 7, width: 2, height: 4, depth: 30 },
  // 市场建筑群：全图最大实心块，把中路与 A 侧彻底隔开
  { id: "W2", type: "building", x: -14, z: 10, width: 12, height: 4, depth: 24 },
  // A 小道北墙：两段之间留出 x −17…−15 的 2m 门洞
  // width 5 → 4.96：西面从 x=−22 退到 x=−21.98，与 W1 西面错开 2cm，避免共面 z-fighting（东侧 2m 门洞因此变 2.02m，玩法无感）
  { id: "W3a", type: "wall", x: -19.5, z: -8, width: 4.96, height: 4, depth: 2 },
  { id: "W3b", type: "wall", x: -13.5, z: -8, width: 3, height: 4, depth: 2 },
  { id: "W4", type: "wall", x: -11, z: -15, width: 2, height: 4, depth: 14 },
  { id: "W5", type: "building", x: -8, z: -15, width: 4, height: 4, depth: 14 },
  // 中路西墙：南段 z −22…−7，北段 z −2…8，中间 z −7…−2 为 A 小道口
  { id: "W6a", type: "wall", x: -5, z: -14.5, width: 2, height: 4, depth: 15 },
  { id: "W6b", type: "wall", x: -5, z: 3, width: 2, height: 4, depth: 10 },
  // 中门：左右扇之间留出 x −2…2 的 4m 门洞（全图最长 31.3m 枪线）
  { id: "W7a", type: "wall", x: -3.5, z: -12, width: 3, height: 4, depth: 1 },
  { id: "W7b", type: "wall", x: 3.5, z: -12, width: 3, height: 4, depth: 1 },
  // 中路东墙：南段 z −22…−6，北段 z 0…8，中间 z −6…0 为下沉通道口
  { id: "W8a", type: "wall", x: 5, z: -14, width: 2, height: 4, depth: 16 },
  { id: "W8b", type: "wall", x: 5, z: 4, width: 2, height: 4, depth: 8 },
  { id: "W9", type: "building", x: 8, z: -15, width: 4, height: 4, depth: 14 },
  // 上层通道西墙：北段 z −1…22，南段 z −6…−4，中间 z −4…−1 为洞口
  { id: "W10a", type: "wall", x: 11, z: 10.5, width: 2, height: 4, depth: 23 },
  { id: "W10c", type: "wall", x: 11, z: -5, width: 2, height: 4, depth: 2 },
  // B 侧建筑体块（东侧长条）
  { id: "W11", type: "building", x: 27, z: 10, width: 6, height: 6, depth: 40 },
  // B 点南墙：西残段 + 东段，之间 x 14…24 为 10m 宽的 B 洞出口
  { id: "W12a", type: "wall", x: 13, z: -8, width: 2, height: 4, depth: 2 },
  // width 6 → 5.96：W12b 整体被 W11（x 24…30, z −10…30, h 6）包住，两侧 x 面原本与 W11 共面会 z-fighting；
  // 内缩 2cm 后它的面全部落在 W11 体内（对外不可见），碰撞体与弹道遮挡由 W11 覆盖，玩法零影响。
  { id: "W12b", type: "wall", x: 27, z: -8, width: 5.96, height: 4, depth: 2 },
  { id: "W13", type: "wall", x: 11, z: -15, width: 2, height: 4, depth: 14 },
  // A 坡道东侧、B 门南侧：只在 z −26…−22 开门洞
  { id: "W14", type: "wall", x: -11, z: -28, width: 2, height: 4, depth: 4 },
  { id: "W15", type: "wall", x: 11, z: -28, width: 2, height: 4, depth: 4 },

  /* ---------------- 3.5 掩体清单（39 条） ---------------- */
  // A 点：A1 电梯箱 + A3 箱堆夹出 Ninja 角；A6 矮墙是 A 点唯一可跳掩体
  { id: "A1", type: "crate", x: -24, z: -18, width: 2.4, height: 2.0, depth: 2.4 },
  { id: "A2", type: "crate", x: -27, z: -24, width: 1.8, height: 1.1, depth: 1.8 },
  { id: "A3", type: "crate", x: -19, z: -22, width: 2.0, height: 1.6, depth: 2.0 },
  { id: "A4", type: "palm", x: -15, z: -27, width: 0.6, height: 5.0, depth: 0.6 },
  { id: "A5", type: "cart", x: -28, z: -12, width: 2.2, height: 1.5, depth: 1.2 },
  { id: "A6", type: "wall", x: -13.5, z: -13, width: 4.0, height: 1.1, depth: 1.0 },
  // A 小道：S1 箱 + S2 油桶把 14m 通视切成 9.3m
  { id: "S1", type: "crate", x: -16, z: -5, width: 1.6, height: 0.9, depth: 1.6 },
  { id: "S2", type: "barrel", x: -19.5, z: -3.5, width: 0.9, height: 1.0, depth: 0.9 },
  { id: "S3", type: "arch", x: -9, z: -3, width: 0.8, height: 3.0, depth: 0.8 },
  // A 大道：L1 蓝箱把 29m 长道切成 16.3m + 10.0m
  { id: "L1", type: "crate", x: -27, z: 12, width: 2.5, height: 1.6, depth: 2.5 },
  { id: "L2", type: "barrel", x: -29, z: 4, width: 1.2, height: 1.4, depth: 1.2 },
  { id: "L3", type: "crate", x: -23, z: 18, width: 1.6, height: 1.1, depth: 1.6 },
  { id: "L4", type: "wall", x: -24, z: -2, width: 3.0, height: 2.4, depth: 1.0 },
  { id: "L5", type: "crate", x: -24.5, z: 6, width: 1.8, height: 1.1, depth: 1.8 },
  // 中路：M1 Xbox 是中路唯一能跳上去的箱子（上猫道的踏脚石）
  { id: "M1", type: "crate", x: 0.5, z: -8.5, width: 1.8, height: 1.1, depth: 1.8 },
  { id: "M2", type: "crate", x: 3.2, z: -9.5, width: 1.4, height: 0.9, depth: 1.4 },
  { id: "M3", type: "barrel", x: -3.5, z: 2, width: 0.9, height: 1.4, depth: 0.9 },
  { id: "M4", type: "wall", x: 2.5, z: 6, width: 2.4, height: 0.9, depth: 1.0 },
  { id: "M5", type: "crate", x: -2, z: -16, width: 1.6, height: 1.1, depth: 1.6 },
  { id: "M6", type: "crate", x: 1, z: 12, width: 2.0, height: 1.6, depth: 2.0 },
  { id: "M7", type: "wall", x: -4, z: -4, width: 0.9, height: 2.4, depth: 2.0 },
  // 上层通道：T2/T3 拱门柱净宽 5.8m，构成 B 侧唯一长廊视野
  { id: "T1", type: "crate", x: 16, z: 10, width: 1.8, height: 1.1, depth: 1.8 },
  { id: "T2", type: "arch", x: 12.6, z: 3, width: 1.0, height: 4.0, depth: 1.0 },
  { id: "T3", type: "arch", x: 19.4, z: 3, width: 1.0, height: 4.0, depth: 1.0 },
  { id: "T4", type: "barrel", x: 18, z: 17, width: 1.1, height: 1.4, depth: 1.1 },
  { id: "T5", type: "cart", x: 22, z: 14, width: 2.2, height: 1.4, depth: 1.2 },
  // B 点：B2 平台（0.9m，5×4）是 B 点唯一的低台，制造「高打低」
  { id: "B1", type: "crate", x: 20, z: -14, width: 2.6, height: 1.6, depth: 2.6 },
  { id: "B2", type: "wall", x: 26, z: -20, width: 5.0, height: 0.9, depth: 4.0 },
  { id: "B3", type: "cart", x: 15, z: -12, width: 2.4, height: 1.4, depth: 1.2 },
  { id: "B4", type: "crate", x: 17, z: -24, width: 1.8, height: 1.1, depth: 1.8 },
  { id: "B5", type: "palm", x: 28, z: -11, width: 0.6, height: 5.0, depth: 0.6 },
  { id: "B6", type: "crate", x: 23, z: -26, width: 2.0, height: 2.0, depth: 2.0 },
  { id: "B7", type: "wall", x: 14, z: -19, width: 1.0, height: 1.1, depth: 3.0 },
  // CT 出生点两侧与 T 出生点周边的散件
  { id: "C1", type: "crate", x: -8.5, z: -23.5, width: 1.6, height: 1.1, depth: 1.6 },
  { id: "C2", type: "crate", x: 8.5, z: -23.5, width: 1.6, height: 1.1, depth: 1.6 },
  { id: "P1", type: "crate", x: -7, z: 27, width: 1.6, height: 1.1, depth: 1.6 },
  { id: "P2", type: "cart", x: 7, z: 26, width: 2.2, height: 1.4, depth: 1.2 },
  { id: "P3", type: "palm", x: 9.5, z: 29, width: 0.6, height: 5.0, depth: 0.6 },
  { id: "P4", type: "wall", x: -9, z: 23, width: 1.0, height: 1.1, depth: 3.0 },
];

/** 全图实心体块（64 条 = 25 段墙 + 39 个掩体），渲染/物理/弹道共用同一份数据。 */
export const OBSTACLES: readonly ObstacleSpec[] = OBSTACLE_SEEDS.map((seed) => ({
  ...seed,
  color: OBSTACLE_COLORS[seed.type],
}));

/* ------------------------------------------------------------------ *
 * 出生点：固定出生表（服务端按加入顺序取，重生轮转）
 * ------------------------------------------------------------------ */

export type TeamId = "T" | "CT";

export interface SpawnPoint {
  /** 队伍：T 侧在南（+Z），CT 侧在北（−Z）。 */
  team: TeamId;
  x: number;
  z: number;
  /** 出生朝向（弧度）：T 为 0（面向 −Z），CT 为 π（面向 +Z）。 */
  yaw: number;
}

/**
 * 10 个固定出生点（已按 0.35m 玩家半径校验，不与任何 AABB 重叠）。
 *
 * 与旧版「黄金角绕中心」相比，固定表的价值是：不会生成在墙体/建筑内部，
 * 同队玩家不会重叠，且朝向是「面向敌方半场」而不是「面向地图中心」。
 * 注：T1 的 z 从设计表的 26.0 微调到 25.0，避开 P1 木箱（−7, 27, 1.6×1.6）的 0.15m 重叠。
 */
export const SPAWN_POINTS: readonly SpawnPoint[] = [
  { team: "T", x: -6, z: 25.0, yaw: 0 },
  { team: "T", x: -2, z: 27.5, yaw: 0 },
  { team: "T", x: 2, z: 26.0, yaw: 0 },
  { team: "T", x: 6, z: 27.5, yaw: 0 },
  { team: "T", x: 0, z: 29.0, yaw: 0 },
  { team: "CT", x: -6, z: -26.0, yaw: Math.PI },
  { team: "CT", x: -2, z: -27.5, yaw: Math.PI },
  { team: "CT", x: 2, z: -26.0, yaw: Math.PI },
  { team: "CT", x: 6, z: -27.5, yaw: Math.PI },
  { team: "CT", x: 0, z: -28.5, yaw: Math.PI },
];

/**
 * 服务端随机出生时每队使用的点数：4。
 *
 * 与 {@link MAX_PLAYERS_PER_ROOM} = 8（4v4）一一对应，因此"每队 4 点 + 每队 4 人"
 * 天然不会出现两人重叠出生。取点顺序 = 下面 {@link SPAWN_POINTS} 中该队的前 4 条，
 * 即文档 5.2 的 8 个坐标（第 5 条 (0, ±29) 因为贴外墙、视野过窄被排除，数据保留不删）。
 */
export const TEAM_SPAWN_COUNT: number = 4;

/** 取某队参与随机的那几个出生点（前 {@link TEAM_SPAWN_COUNT} 条，坐标原样）。 */
export function teamSpawnPoints(team: TeamId): readonly SpawnPoint[] {
  return SPAWN_POINTS.filter((point) => point.team === team).slice(0, TEAM_SPAWN_COUNT);
}

/** 由障碍数据推导碰撞 AABB。 */
export function obstacleColliders(): Aabb[] {
  return OBSTACLES.map((obstacle) => ({
    minX: obstacle.x - obstacle.width / 2,
    maxX: obstacle.x + obstacle.width / 2,
    minY: 0,
    maxY: obstacle.height,
    minZ: obstacle.z - obstacle.depth / 2,
    maxZ: obstacle.z + obstacle.depth / 2,
  }));
}

/* ------------------------------------------------------------------ *
 * S4：弹药与换弹（服务端权威，客户端只做表现）
 * ------------------------------------------------------------------ */

/** 弹匣容量。 */
export const WEAPON_MAG_SIZE: number = 30;

/** 初始备弹。 */
export const WEAPON_RESERVE_AMMO: number = 120;

/** 换弹耗时（毫秒）。 */
export const WEAPON_RELOAD_MS: number = 1800;

/* ------------------------------------------------------------------ *
 * S6：手枪（槽位 1）—— 独立弹药与独立手感参数
 * ------------------------------------------------------------------ */

/** 手枪弹匣容量（= 12 发，比步枪少一半多，逼玩家打点射）。 */
export const PISTOL_MAG_SIZE: number = 12;

/** 手枪初始备弹（3 个弹匣）。 */
export const PISTOL_RESERVE_AMMO: number = 36;

/**
 * 手枪开火间隔（毫秒）：170（≈353 RPM，对齐 USP-S 的射速量级）。
 *
 * 为什么比步枪（100ms）慢近一倍：手枪伤害走同一张 {@link ZONE_DAMAGE}（胸 25），
 * 若射速与步枪相同，手枪就成了"弹匣更小的步枪"，AK 完全没有存在意义。
 * 170ms 下手枪 DPS≈147、AK≈250，手枪仍是步枪的 59%，定位是"点射 / 主武器空弹匣时的过渡"。
 * 与射速同样重要的是 {@link FIRE_MODES.SEMI}：手枪一次点击只出一发，按住不放不会连发。
 */
export const PISTOL_COOLDOWN_MS: number = 170;

/** 手枪射程（米）：35m，约为步枪（60m）的 58%，中门这种 31m 长枪线刚好够用。 */
export const PISTOL_RANGE: number = 35;

/**
 * 开火模式。
 *
 * - `auto`：按住左键持续射击（长枪）。客户端主循环按 `cooldownMs` 逐发驱动，
 *   服务端仍逐发限流——"全自动"不是允许超频，只是允许客户端自动补发。
 * - `semi`：一次点击只出一发（手枪）。按住不放**不会**连发。
 */
export const FIRE_MODES = {
  AUTO: "auto",
  SEMI: "semi",
} as const;

export type FireMode = (typeof FIRE_MODES)[keyof typeof FIRE_MODES];

/**
 * 服务端开火冷却容差（倍数）。
 *
 * 判定用 `now - last >= cooldownMs * TOLERANCE` 而不是严格的 `cooldownMs`：
 * 客户端全自动按"刚好 cooldownMs"驱动，网络到达时间会前后抖动几毫秒，严格判定会把
 * 抖动偏早的那一发**静默丢弃**，玩家感受到的是"连发中间断了一拍"。
 * 0.8 让 AK 的硬上限从 10 发/秒放宽到 12.5 发/秒——不足以构成作弊优势，但能吸收抖动。
 */
export const FIRE_COOLDOWN_TOLERANCE: number = 0.8;

/**
 * 喷弹形的一格：相对**第一发**的累计偏移（度）。
 *
 * `x` 为正 = 向右，`y` 为正 = 向上。客户端把相邻两格的差值作为该发的视角冲量，
 * 于是第 N 发之后的总偏移恰好等于表里第 N 格——图案可复现、可学习，这就是压枪的物理基础。
 */
export interface SprayStep {
  x: number;
  y: number;
}

/**
 * AK-47 的 30 发喷弹形（对照 CS2 的实际图案校准）。
 *
 * 形状来源：CS2 的 AK 前 4–5 发几乎**纯垂直**上抬，第 6 发开始向左漂，第 12 发前后
 * 到达最左（约 −3.2°），随后向右回摆，第 24 发到最右（约 +2.5°），最后 6 发收在中间。
 * 整体垂直累计 17.35°、横向摆幅 5.7°——比旧实现「每发固定上抬 0.85° + 随机横移」
 * 强一个量级，因为旧实现在 600 RPM 下稳定值只有约 2.0°，屏幕上几乎看不出来。
 *
 * 为什么必须是**固定表**而不是随机：随机 = 白噪声，玩家学不会也压不住，打十局也不会变准；
 * 固定表 = 可练习的技能曲线，这才是 CS 的立身之本。
 */
export const AK_SPRAY_PATTERN: readonly SprayStep[] = [
  { x: 0.0, y: 0.0 },
  { x: 0.0, y: 1.6 },
  { x: -0.05, y: 3.15 },
  { x: -0.1, y: 4.6 },
  { x: -0.05, y: 5.95 },
  { x: -0.3, y: 7.15 },
  { x: -0.7, y: 8.25 },
  { x: -1.2, y: 9.25 },
  { x: -1.75, y: 10.15 },
  { x: -2.3, y: 10.95 },
  { x: -2.75, y: 11.65 },
  { x: -3.05, y: 12.3 },
  { x: -3.2, y: 12.9 },
  { x: -3.15, y: 13.45 },
  { x: -2.9, y: 13.95 },
  { x: -2.45, y: 14.4 },
  { x: -1.85, y: 14.8 },
  { x: -1.15, y: 15.15 },
  { x: -0.4, y: 15.45 },
  { x: 0.35, y: 15.75 },
  { x: 1.05, y: 16.0 },
  { x: 1.65, y: 16.25 },
  { x: 2.1, y: 16.45 },
  { x: 2.4, y: 16.6 },
  { x: 2.5, y: 16.75 },
  { x: 2.4, y: 16.9 },
  { x: 2.1, y: 17.05 },
  { x: 1.65, y: 17.15 },
  { x: 1.1, y: 17.25 },
  { x: 0.55, y: 17.35 },
];

/** 单把枪的完整手感参数（服务端结算与客户端本地预测共用同一份，杜绝两端漂移）。 */
export interface WeaponFireProfile {
  /** 槽位（{@link WEAPON_SLOTS}）。 */
  slot: WeaponSlot;
  /** 开火模式：auto = 按住连发，semi = 一次点击一发。 */
  fireMode: FireMode;
  /** 开火最小间隔（毫秒）。 */
  cooldownMs: number;
  /** 射程（米）。 */
  range: number;
  /** 弹匣容量。 */
  magSize: number;
  /** 初始备弹。 */
  reserveAmmo: number;
  /** 展示名（HUD 用）。 */
  label: string;
  /**
   * 这一串**第一发**的扩散半角（度）。
   *
   * 这是"服务端圆锥"的半径，不是准星的像素宽度——准星的像素宽度由
   * {@link spreadToPixels} 从同一个角度换算，两者必须同源，否则就是"准星撒谎"。
   */
  spreadFirstDeg: number;
  /** 每多打一发，半角增加多少度（线性递增到 {@link spreadMaxDeg} 封顶）。 */
  spreadStepDeg: number;
  /** 扩散半角的上限（度）。到顶后再怎么扫都不会更散。 */
  spreadMaxDeg: number;
  /** 单发上跳（度，正数 = 抬头）。玩家必须自己向下压枪来抵消。 */
  recoilVertDeg: number;
  /** 单发横向抖动半幅（度）。 */
  recoilHorizDeg: number;
  /**
   * 后坐偏移的回正速率（每秒，客户端按 `exp(-dt * rate)` 衰减）。
   *
   * 枪越重、回正越慢：AK 5.5（压枪窗口约 400ms，必须持续压）、手枪 12（打一枪立刻复位）。
   */
  recoilRecoverRate: number;
  /**
   * 确定性喷弹形（见 {@link SprayStep}）；空数组表示"每发独立随机"（手枪、以及半自动枪）。
   *
   * 有表的枪：第 N 发的视角冲量 = `pattern[N] - pattern[N-1]`，总偏移等于 `pattern[N]`。
   * 无表的枪：直接用 {@link recoilVertDeg} / {@link recoilHorizDeg} 生成一发随机冲量。
   */
  sprayPattern: readonly SprayStep[];
  /**
   * 停火后喷弹形游标归零的时间（毫秒）。
   *
   * 与 {@link recoilRecoverRate} 是两件事：前者是"下一发接第几格"（决定图案接续），
   * 后者是"当前视角偏移多快归零"（决定准星回落）。
   *
   * 取 3~4 个射击间隔：AK 320ms ≈ 3.2 发，也就是"松手稍微停一下，下一串从头开始"。
   * 这正是 CS 里点射能重置图案的原因——玩家靠控制节奏把随机性压到最低。
   */
  sprayResetMs: number;
}

/** 有弹道（走射线判定）的槽位参数；刀与投掷物不在表内。 */
export const WEAPON_FIRE_PROFILES: Record<number, WeaponFireProfile> = {
  0: {
    slot: 0,
    fireMode: FIRE_MODES.AUTO,
    cooldownMs: WEAPON_COOLDOWN_MS,
    range: WEAPON_RANGE,
    magSize: WEAPON_MAG_SIZE,
    reserveAmmo: WEAPON_RESERVE_AMMO,
    label: "AK",
    // 扩散：0.20° 起、每发 +0.26°、第 11 发封顶 2.60°。
    // 换算：30m 处首发半径 0.105m（< 头判定 0.13m，所以静止首发 30m 能稳定爆头），
    // 封顶时 30m 半径 1.36m（直径 2.72m），命中率约 19% —— "30m 别扫，要么点要么短点"。
    spreadFirstDeg: 0.2,
    spreadStepDeg: 0.26,
    spreadMaxDeg: 2.6,
    // 有表时 recoilVertDeg / recoilHorizDeg 不再逐发生效（改由 AK_SPRAY_PATTERN 决定），
    // 保留数值只作为"该枪的单发量级"参考与无表分支的兜底。
    recoilVertDeg: 1.6,
    recoilHorizDeg: 0.35,
    recoilRecoverRate: 5.5,
    sprayPattern: AK_SPRAY_PATTERN,
    sprayResetMs: 320,
  },
  1: {
    slot: 1,
    fireMode: FIRE_MODES.SEMI,
    cooldownMs: PISTOL_COOLDOWN_MS,
    range: PISTOL_RANGE,
    magSize: PISTOL_MAG_SIZE,
    reserveAmmo: PISTOL_RESERVE_AMMO,
    label: "手枪",
    // 扩散：首发 0.12° 比步枪更准（手枪的价值就在"每一发都准"），
    // 但每发 +0.30° 涨得更快、1.80° 封顶 —— 第 7 发就到顶。
    // 封顶时 30m 半径 0.94m、命中率约 39%：远距离 spam 会失准，逼玩家点射。
    spreadFirstDeg: 0.12,
    spreadStepDeg: 0.3,
    spreadMaxDeg: 1.8,
    // 手枪单发上跳比 AK 更大（1.60 vs 1.60 的单发量级），但回正快一倍多（12 vs 5.5）：
    // 打一枪立刻复位，逼玩家一发一发点，而不是像 AK 那样压着扫。
    recoilVertDeg: 1.6,
    recoilHorizDeg: 0.2,
    recoilRecoverRate: 12,
    // 半自动枪没有"图案"可言：每次点击都是独立一发，用随机更符合直觉。
    sprayPattern: [],
    sprayResetMs: 220,
  },
};

/** 该槽位是否走枪械弹道（只有 AK 与手枪）。 */
export function isGunSlot(slot: number): boolean {
  return slot === WEAPON_SLOTS.RIFLE || slot === WEAPON_SLOTS.PISTOL;
}

/** 取该槽位的弹道参数；刀 / 投掷物返回 null（它们各有各的 handler）。 */
export function fireProfileOf(slot: number): WeaponFireProfile | null {
  return isGunSlot(slot) ? WEAPON_FIRE_PROFILES[slot] ?? null : null;
}

/** 一发子弹带来的后坐冲量（度）与下一枪的喷弹形游标。 */
export interface RecoilDelta {
  /** 抬头角（度，**正数 = 视线向上**）。调用方按 `pitch += pitchDeg` 施加。 */
  pitchDeg: number;
  /** 右偏角（度，正数 = 视线向右）。 */
  yawDeg: number;
  /** 下一发的游标（已按表长钳制）。 */
  nextIndex: number;
}

/**
 * 计算一发的后坐冲量（纯函数，便于单测——方向搞反过一次，肉眼极难发现）。
 *
 * 有喷弹形的枪：冲量 = 相邻两格之差，于是**连发累计偏移严格等于表里第 N 格**。
 * 没有表（半自动手枪）：用单发固定上跳 + 单发随机横移，每次点击独立。
 *
 * @param shotIndex 这一发之前已经打出的发数（0 = 这一串的第一发）
 * @param random 随机源，测试可注入确定性序列
 */
export function recoilDeltaOf(
  profile: WeaponFireProfile,
  shotIndex: number,
  random: () => number = Math.random,
): RecoilDelta {
  const pattern: readonly SprayStep[] = profile.sprayPattern;
  if (pattern.length > 0) {
    const last: number = pattern.length - 1;
    const index: number = Math.min(Math.max(shotIndex, 0) + 1, last);
    const prev: SprayStep = pattern[Math.min(Math.max(shotIndex, 0), last)] as SprayStep;
    const cur: SprayStep = pattern[index] as SprayStep;
    return { pitchDeg: cur.y - prev.y, yawDeg: cur.x - prev.x, nextIndex: index };
  }
  return {
    pitchDeg: profile.recoilVertDeg,
    yawDeg: (random() - 0.5) * profile.recoilHorizDeg * 2,
    nextIndex: 0,
  };
}

/* ------------------------------------------------------------------ *
 * S3b：服务端权威扩散（圆锥采样）
 *
 * 为什么扩散必须由服务端算：如果客户端算，作弊客户端把 spread 置 0 就是激光枪。
 * 但扩散又不能随机到"不可复现"——那样 QA 无法断言、争议弹道无法回放。
 * 所以用**确定性 PRNG**：种子 = 房间种子 ^ 玩家 ^ 发数，同一发生的偏移永远一致，
 * 而玩家不知道房间种子 → 无法预测下一发偏到哪。
 * ------------------------------------------------------------------ */

/**
 * 第 `shotIndex` 发（0 = 这一串的第一发）的扩散半角（度）。
 *
 * 线性递增到上限封顶：`min(spreadMaxDeg, spreadFirstDeg + shotIndex × spreadStepDeg)`。
 * **确定性**是关键——第 5 发一定比第 1 发散，玩家才能学会"打几发要停"。
 */
export function spreadHalfAngleDeg(profile: WeaponFireProfile, shotIndex: number): number {
  const index: number = Math.max(0, Math.floor(shotIndex));
  return Math.min(profile.spreadMaxDeg, profile.spreadFirstDeg + index * profile.spreadStepDeg);
}

/** FNV-1a 32 位字符串哈希：把 sessionId 折成种子的一部分（同一玩家每局盐值相同）。 */
export function hashString(value: string): number {
  let hash: number = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * 混合出这一发的种子：`mix(roomSeed, playerSalt, shotIndex)`。
 *
 * 三个输入缺一不可——
 * - `roomSeed`：每局房间随机生成、**永不广播**，所以玩家无法预先算出偏移；
 * - `playerSalt`：同一发数下不同玩家偏得不一样，避免"A 站哪最准"这种位置迷信；
 * - `shotIndex`：同一玩家每一发都不同，否则整个弹匣打在同一个点上。
 */
export function mixShotSeed(roomSeed: number, playerSalt: number, shotIndex: number): number {
  let hash: number = roomSeed >>> 0;
  hash = Math.imul(hash ^ (playerSalt >>> 0), 0x01000193) >>> 0;
  hash = Math.imul(hash ^ ((shotIndex + 0x9e3779b9) >>> 0), 0x85ebca6b) >>> 0;
  hash ^= hash >>> 16;
  return hash >>> 0;
}

/** xorshift32 推进一步：返回 [0,1) 的均匀值与新状态。 */
function xorshiftUnit(state: number): { value: number; next: number } {
  let s: number = state >>> 0;
  // 0 是 xorshift 的不动点，必须换一个非零常量
  if (s === 0) {
    s = 0x9e3779b9;
  }
  s ^= s << 13;
  s >>>= 0;
  s ^= s >>> 17;
  s ^= s << 5;
  s >>>= 0;
  return { value: s / 0x100000000, next: s };
}

/** 圆锥采样结果：单位盘内坐标（已乘 √u）+ 本次使用的半角。 */
export interface SpreadSample {
  /** 右向偏移系数；实际切向位移 = `x × tan(halfAngleDeg)`。 */
  x: number;
  /** 上向偏移系数；同上。 */
  y: number;
  /** 本次使用的扩散半角（度），便于广播给客户端画准星与调试。 */
  halfAngleDeg: number;
}

/**
 * 采样一发的圆锥偏移（均匀圆盘分布）。
 *
 * 用 `r = √u`、`φ = 2πv` 而不是矩形或高斯采样：均匀圆盘的落点是"圆内任何一块
 * 等面积的区域命中概率相同"，这样 `docs/武器手感规格-CS2校准.md` 里的命中率表
 * 可以直接套用；矩形采样会让对角方向明显偏得多，高斯采样会让"运气枪"过多。
 *
 * @param shotIndex 这一发之前已经打出的发数（0 = 这一串的第一发）
 * @param seed 由 {@link mixShotSeed} 预先混合好的 32 位种子
 */
export function sampleSpread(
  profile: WeaponFireProfile,
  shotIndex: number,
  seed: number,
): SpreadSample {
  const halfAngleDeg: number = spreadHalfAngleDeg(profile, shotIndex);
  const first = xorshiftUnit(seed);
  const second = xorshiftUnit(first.next);
  const radius: number = Math.sqrt(first.value);
  const angle: number = Math.PI * 2 * second.value;
  return {
    x: Math.cos(angle) * radius,
    y: Math.sin(angle) * radius,
    halfAngleDeg,
  };
}

/**
 * 把扩散半角换算成屏幕像素半径（准星张开多少 px）。
 *
 * `px = tan(半角) / tan(竖直 FOV / 2) × (视口高度 / 2)`
 *
 * 客户端准星必须用这个函数，而不是自己维护一套 `SPREAD_BASE / SPREAD_PER_SHOT`——
 * 上一轮"弹道不对"的根因之一就是准星在抖、服务端射线是直线，两者毫无关系。
 */
export function spreadToPixels(halfAngleDeg: number, fovYDeg: number, viewportHeight: number): number {
  const halfFov: number = (fovYDeg * Math.PI) / 360;
  const angle: number = (halfAngleDeg * Math.PI) / 180;
  return (Math.tan(angle) / Math.tan(halfFov)) * (viewportHeight / 2);
}

/* ------------------------------------------------------------------ *
 * S4：投掷物（手雷 / 闪光弹 / 烟雾弹）
 * ------------------------------------------------------------------ */

export const THROWABLE_TYPES = {
  FRAG: "frag",
  FLASH: "flash",
  SMOKE: "smoke",
} as const;

export type ThrowableType = (typeof THROWABLE_TYPES)[keyof typeof THROWABLE_TYPES];

export interface ThrowableConfig {
  /** 展示名。 */
  label: string;
  /** 出生携带数量。 */
  initialCount: number;
  /** 引信时长（毫秒，从投出到生效）。 */
  fuseMs: number;
  /** 生效半径（米）。 */
  radius: number;
  /** 客户端渲染颜色。 */
  color: number;
  /** 手雷：中心最大伤害与边缘最小伤害。 */
  maxDamage?: number;
  minDamage?: number;
  /** 闪光弹：正面直视最大致盲时长。 */
  maxBlindMs?: number;
  /** 烟雾弹：云团持续时间。 */
  cloudDurationMs?: number;
}

/** 三种投掷物的统一配置（客户端 HUD 与服务端结算共用）。 */
export const THROWABLES: Record<ThrowableType, ThrowableConfig> = {
  frag: {
    label: "手雷",
    initialCount: 2,
    fuseMs: 2200,
    radius: 6,
    color: 0x4b5563,
    maxDamage: 100,
    minDamage: 20,
  },
  flash: {
    label: "闪光弹",
    initialCount: 2,
    fuseMs: 1600,
    radius: 12,
    color: 0xd1d5db,
    maxBlindMs: 2800,
  },
  smoke: {
    label: "烟雾弹",
    initialCount: 2,
    fuseMs: 1400,
    radius: 5,
    color: 0x9ca3af,
    cloudDurationMs: 15000,
  },
};

/** 投掷初速度（米/秒）：约 14 m/s，配合 18 m/s² 重力形成自然抛物线。 */
export const THROW_SPEED: number = 14;

/** 两次投掷的最小间隔（毫秒）。 */
export const THROW_COOLDOWN_MS: number = 700;

/** 投掷物类型 → 武器槽位（G/F/V 快捷投掷与滚轮都靠它对齐）。 */
export function slotOfThrowable(type: ThrowableType): WeaponSlot {
  if (type === THROWABLE_TYPES.FRAG) {
    return WEAPON_SLOTS.FRAG;
  }
  return type === THROWABLE_TYPES.FLASH ? WEAPON_SLOTS.FLASH : WEAPON_SLOTS.SMOKE;
}

/** 武器槽位 → 投掷物类型；枪 / 刀返回 null。 */
export function throwableTypeOfSlot(slot: number): ThrowableType | null {
  if (slot === WEAPON_SLOTS.FRAG) {
    return THROWABLE_TYPES.FRAG;
  }
  if (slot === WEAPON_SLOTS.FLASH) {
    return THROWABLE_TYPES.FLASH;
  }
  if (slot === WEAPON_SLOTS.SMOKE) {
    return THROWABLE_TYPES.SMOKE;
  }
  return null;
}

/** 投掷方向的最大俯仰（弧度），防止垂直上抛。 */
export const THROW_MAX_PITCH: number = 0.6;

/** 手雷重力加速度（米/秒²）。 */
export const GRENADE_GRAVITY: number = 18;

/** 手雷落地弹性系数。 */
export const GRENADE_BOUNCE: number = 0.35;

/** 手雷碰撞半径（米）。 */
export const GRENADE_RADIUS: number = 0.11;

/**
 * 投掷物球-AABB 反弹物理：客户端预测与服务端权威共用同一实现。
 *
 * 为什么必须放在 shared：
 *   旧版客户端 `throwables.ts` 只做了重力 + 地面 + 场地边界，**一次掩体求交都没有**，
 *   而服务端 `grenades.ts` 早已按 64 个 AABB 做反弹。两端各写一套的结果是
 *   「玩家看着手雷穿墙飞进掩体，服务端却算它早就撞墙弹回」——爆炸位置与视觉彻底脱节。
 *   现在两端调同一个函数，从结构上消除漂移，而不是靠人工"对齐两份拷贝"。
 *
 * 为什么**不**拆成独立文件再 `export ... from "./xxx.js"`（踩过的坑）：
 *   本包在生产环境是按 `main: src/index.ts` 直接由 Node 24 做类型剥离运行的（不经过 tsc），
 *   Node 的类型剥离**不会**把 `./xxx.js` 映射到磁盘上的 `xxx.ts`，于是启动即
 *   `ERR_MODULE_NOT_FOUND`。本地测试用 tsx 会自动映射，所以本地全绿、线上必崩。
 *   本包因此坚持单文件，任何新增内容都直接写在这里。
 *
 * 积分口径（与服务端 S4 一致，改动前请先看三条约束）：
 *   1. 显式欧拉：先 `vy -= g·dt` 再积分位置（顺序不能换，换了两端轨迹就差常量项）；
 *   2. 每个子步都完整跑一遍「重力 → 地面 → 掩体 → 边界」，反弹后的新速度对后续子步立即生效；
 *   3. 子步长上限由 {@link GRENADE_RADIUS} 反推，保证单子步位移小于碰撞半径，杜绝高速穿墙。
 */

/** 参与弹道积分的投掷物状态（`GrenadeState` / 客户端 `LocalGrenade` 结构上都满足它）。 */
export interface GrenadeBody {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
}

/** 撞墙后切向速度的保留系数（CS2 手感：撞墙会"贴墙减速"，不是无摩擦滑冰）。 */
const GRENADE_WALL_FRICTION: number = 0.85;

/** 地面/箱顶落地时切向速度的保留系数（沿用服务端既有数值，不要与 WALL_FRICTION 混用）。 */
const GRENADE_GROUND_FRICTION: number = 0.82;

/** 垂直速度低于该值时视为静止，避免在 0 附近无限微小弹跳。 */
const GRENADE_REST_SPEED_Y: number = 0.6;

/** 子步数上限：防止异常速度（如被作弊客户端上报的 1000 m/s）把单帧计算量放大。 */
const GRENADE_MAX_SUBSTEPS: number = 8;

/**
 * 推进一个物理步长（秒）：重力、地面与掩体反弹、场地边界。
 *
 * 大位移会被自动切成若干子步（最多 {@link GRENADE_MAX_SUBSTEPS} 步），否则 60fps 下
 * 单帧位移就能超过 0.4m 厚的墙体，直接"穿"过去。
 */
export function stepGrenadePhysics(
  body: GrenadeBody,
  dtSeconds: number,
  obstacles: readonly Aabb[],
): void {
  if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) {
    return;
  }

  const speed: number = Math.hypot(body.vx, body.vy, body.vz);
  const distance: number = Number.isFinite(speed) ? speed * dtSeconds : 0;
  const substeps: number = Math.max(
    1,
    Math.min(GRENADE_MAX_SUBSTEPS, Math.ceil(distance / GRENADE_RADIUS)),
  );
  const stepSeconds: number = dtSeconds / substeps;

  for (let i = 0; i < substeps; i += 1) {
    stepGrenadeOnce(body, stepSeconds, obstacles);
  }
}

/** 单个子步：与服务端原 `stepGrenade` 逐行等价，只多了撞墙切向摩擦。 */
function stepGrenadeOnce(body: GrenadeBody, dtSeconds: number, obstacles: readonly Aabb[]): void {
  body.vy -= GRENADE_GRAVITY * dtSeconds;
  body.x += body.vx * dtSeconds;
  body.y += body.vy * dtSeconds;
  body.z += body.vz * dtSeconds;

  // 地面
  if (body.y < GRENADE_RADIUS) {
    body.y = GRENADE_RADIUS;
    if (body.vy < 0) {
      body.vy = -body.vy * GRENADE_BOUNCE;
      body.vx *= GRENADE_GROUND_FRICTION;
      body.vz *= GRENADE_GROUND_FRICTION;
      if (Math.abs(body.vy) < GRENADE_REST_SPEED_Y) {
        body.vy = 0;
      }
    }
  }

  // 掩体：按最小穿透轴推出并反弹对应分量
  for (const box of obstacles) {
    const insideX: boolean = body.x > box.minX - GRENADE_RADIUS && body.x < box.maxX + GRENADE_RADIUS;
    const insideZ: boolean = body.z > box.minZ - GRENADE_RADIUS && body.z < box.maxZ + GRENADE_RADIUS;
    if (!insideX || !insideZ) {
      continue;
    }

    // 从上方落下：停在箱顶
    if (body.y >= box.maxY && body.y - GRENADE_RADIUS <= box.maxY) {
      body.y = box.maxY + GRENADE_RADIUS;
      body.vy = body.vy < 0 ? -body.vy * GRENADE_BOUNCE : body.vy;
      body.vx *= GRENADE_GROUND_FRICTION;
      body.vz *= GRENADE_GROUND_FRICTION;
      continue;
    }

    if (body.y < box.minY || body.y > box.maxY) {
      continue;
    }

    const pushLeft: number = body.x - (box.minX - GRENADE_RADIUS);
    const pushRight: number = box.maxX + GRENADE_RADIUS - body.x;
    const pushBack: number = body.z - (box.minZ - GRENADE_RADIUS);
    const pushFront: number = box.maxZ + GRENADE_RADIUS - body.z;
    const minPush: number = Math.min(pushLeft, pushRight, pushBack, pushFront);

    if (minPush === pushLeft) {
      body.x = box.minX - GRENADE_RADIUS;
      body.vx = -Math.abs(body.vx) * GRENADE_BOUNCE;
      // 切向摩擦：撞 X 面时沿墙滑行的 Z/向上分量要衰减，否则手雷会"滑冰"
      body.vz *= GRENADE_WALL_FRICTION;
      if (body.vy > 0) {
        body.vy *= GRENADE_WALL_FRICTION;
      }
    } else if (minPush === pushRight) {
      body.x = box.maxX + GRENADE_RADIUS;
      body.vx = Math.abs(body.vx) * GRENADE_BOUNCE;
      body.vz *= GRENADE_WALL_FRICTION;
      if (body.vy > 0) {
        body.vy *= GRENADE_WALL_FRICTION;
      }
    } else if (minPush === pushBack) {
      body.z = box.minZ - GRENADE_RADIUS;
      body.vz = -Math.abs(body.vz) * GRENADE_BOUNCE;
      body.vx *= GRENADE_WALL_FRICTION;
      if (body.vy > 0) {
        body.vy *= GRENADE_WALL_FRICTION;
      }
    } else {
      body.z = box.maxZ + GRENADE_RADIUS;
      body.vz = Math.abs(body.vz) * GRENADE_BOUNCE;
      body.vx *= GRENADE_WALL_FRICTION;
      if (body.vy > 0) {
        body.vy *= GRENADE_WALL_FRICTION;
      }
    }
  }

  // 场地边界：矩形的四面外墙（逐轴钳制 + 对应速度分量反向）
  const maxX: number = MAP_BOUNDS.maxX - GRENADE_RADIUS;
  const minX: number = MAP_BOUNDS.minX + GRENADE_RADIUS;
  const maxZ: number = MAP_BOUNDS.maxZ - GRENADE_RADIUS;
  const minZ: number = MAP_BOUNDS.minZ + GRENADE_RADIUS;
  if (body.x > maxX) {
    body.x = maxX;
    body.vx = -Math.abs(body.vx) * GRENADE_BOUNCE;
  } else if (body.x < minX) {
    body.x = minX;
    body.vx = Math.abs(body.vx) * GRENADE_BOUNCE;
  }
  if (body.z > maxZ) {
    body.z = maxZ;
    body.vz = -Math.abs(body.vz) * GRENADE_BOUNCE;
  } else if (body.z < minZ) {
    body.z = minZ;
    body.vz = Math.abs(body.vz) * GRENADE_BOUNCE;
  }
}

/** 手雷脱离手部的位置（相对眼睛）。 */
export const THROW_ORIGIN_FORWARD: number = 0.45;

/** 客户端上行：投掷请求。方向由客户端提供，位置与速度由服务端裁定。 */
export interface ThrowMessage {
  type: ThrowableType;
  dirX: number;
  dirY: number;
  dirZ: number;
}

/** 服务端广播：手雷已投出（客户端据此本地模拟同一条抛物线）。 */
export interface GrenadeLaunchedMessage {
  id: number;
  type: ThrowableType;
  throwerId: string;
  origin: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number };
}

/** 服务端广播：投掷物生效（爆炸 / 闪光 / 起烟）。 */
export interface ExplosionMessage {
  id: number;
  type: ThrowableType;
  throwerId: string;
  x: number;
  y: number;
  z: number;
  radius: number;
}

/** 服务端下发（仅致盲目标本人）：闪光效果强度与时长。 */
export interface FlashEffectMessage {
  intensity: number;
  durationMs: number;
  sourceX: number;
  sourceZ: number;
}

/** 服务端下发（仅受伤者本人）：用于受击方向指示与血量反馈。 */
export interface DamageTakenMessage {
  attackerId: string;
  amount: number;
  hp: number;
  fromX: number;
  fromZ: number;
  /** 命中部位；手雷等"不吃部位倍率"的伤害为 null。 */
  zone: HitZone | null;
}

/** 烟雾云团（服务端状态同步，后进玩家也能看到）。 */
export interface SmokeCloudView {
  id: string;
  x: number;
  z: number;
  radius: number;
  expiresAt: number;
}

/* ------------------------------------------------------------------ *
 * S6：设置（鼠标灵敏度）
 * ------------------------------------------------------------------ */

/**
 * 基础灵敏度：`yaw -= movementX * BASE_SENS * sensitivity`。
 *
 * 这就是旧版写死在 `game.ts` 里的 `LOOK_SENSITIVITY = 0.0023`。
 * **默认灵敏度 1.0 必须与旧手感逐位相等**——所以这个常数只允许搬家，不允许调值，
 * 否则所有老玩家的肌肉记忆会被一次性改写。
 */
export const BASE_SENSITIVITY: number = 0.0023;

/** 灵敏度下限：再低就完全转不动视角（0.2 × 0.0023 ≈ 0.46 mrad/px）。 */
export const SENSITIVITY_MIN: number = 0.2;

/** 灵敏度上限：3.0 是 180° 甩枪能在 ~140px 内完成的档位。 */
export const SENSITIVITY_MAX: number = 3.0;

/** 滑块步进。 */
export const SENSITIVITY_STEP: number = 0.05;

/** 默认灵敏度（= 旧版手感）。 */
export const SENSITIVITY_DEFAULT: number = 1.0;

/** localStorage 键名：整包设置放在同一个 JSON 里，后续加音量/画质不用再开新键。 */
export const SETTINGS_STORAGE_KEY: string = "fps.settings.v1";

/**
 * 把任意输入钳制/对齐成合法灵敏度。
 *
 * 规则（与 UI 的 range 完全一致，防止"滑块显示 3.0 但实际生效 2.9999"）：
 *   1. 非数字 / NaN / Infinity → 默认值 1.0；
 *   2. 夹到 [{@link SENSITIVITY_MIN}, {@link SENSITIVITY_MAX}]；
 *   3. 对齐到 {@link SENSITIVITY_STEP} 的整数倍，并保留两位小数（消除 0.30000000000000004）。
 */
export function clampSensitivity(raw: unknown): number {
  const value: number = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : Number.NaN;
  if (!Number.isFinite(value)) {
    return SENSITIVITY_DEFAULT;
  }
  const clamped: number = Math.min(SENSITIVITY_MAX, Math.max(SENSITIVITY_MIN, value));
  const steps: number = Math.round(clamped / SENSITIVITY_STEP);
  return Math.round(steps * SENSITIVITY_STEP * 100) / 100;
}

/**
 * 从原始 JSON 文本解析灵敏度；任何异常都回退到默认值，**不抛错、不清除原记录**。
 *
 * 为什么强调"不清除原记录"：用户可能手改过 localStorage，或者旧版本存了别的结构。
 * 直接 `localStorage.clear()` 或 `removeItem` 会连带删掉他还没升级的其他设置，
 * 只读不写才是安全的降级方式。
 */
export function parseSensitivity(raw: string | null | undefined): number {
  if (raw === null || raw === undefined || raw.length === 0) {
    return SENSITIVITY_DEFAULT;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return SENSITIVITY_DEFAULT;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return SENSITIVITY_DEFAULT;
  }
  const value: unknown = (parsed as { sensitivity?: unknown }).sensitivity;
  return value === undefined ? SENSITIVITY_DEFAULT : clampSensitivity(value);
}

/** 序列化成要写进 localStorage 的字符串（固定两位小数，便于人眼核对）。 */
export function serializeSensitivity(sensitivity: number): string {
  return JSON.stringify({ sensitivity: clampSensitivity(sensitivity) });
}

/** 灵敏度 → 滑块可用的字符串（`1.00` / `0.35`）。 */
export function formatSensitivity(sensitivity: number): string {
  return clampSensitivity(sensitivity).toFixed(2);
}
