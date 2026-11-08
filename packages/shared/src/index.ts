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
 */
export const MAX_MESSAGES_PER_SECOND: number = 45;

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

/** 客户端上行：开火请求（携带视角快照，服务端在 3° 内采用，超出则回退已存视角）。 */
export interface FireMessage {
  /** 开火瞬间的朝向（弧度）。可由服务端 `normalizeYaw` 归一化。 */
  yaw: number;
  /** 开火瞬间的俯仰（弧度）。可由服务端 `clampPitch` 钳制。 */
  pitch: number;
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

/** 开火最小间隔（毫秒），服务端据此限流，客户端据此做本地预冷却。 */
export const WEAPON_COOLDOWN_MS: number = 150;

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
 *   头 [1.54, 1.80]  胸 [1.14, 1.54]  腹 [0.90, 1.14]  臂 [0.98, 1.52]  腿 [0.02, 0.90]
 *
 * 硬约束：
 *   1. 躯干三段（腿→腹→胸→头）必须**首尾相接**（不留缝），缝隙会让垂直下压的子弹从两段之间漏判；
 *   2. 最高段 `yMax` === {@link PLAYER_HEIGHT}，客户端人形模型总高必须与它逐项相等（同源）；
 *   3. 判定体只比模型宽 1–3cm（网络容错方向：宁可判中，不可判漏）。
 */
export const PLAYER_HITBOXES: readonly HitCylinder[] = [
  { zone: "head", offsetRight: 0, yMin: 1.54, yMax: 1.8, radius: 0.14 },
  { zone: "chest", offsetRight: 0, yMin: 1.14, yMax: 1.54, radius: 0.27 },
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
  /** 被命中的玩家 sessionId；未命中玩家（打空或打在掩体上）为 null。 */
  hitPlayerId: string | null;
  /** 命中部位；未命中玩家为 null。 */
  hitZone: HitZone | null;
  /** 实际扣血量（整数，已按 {@link ZONE_DAMAGE} 查表）；未命中为 0。 */
  damage: number;
  /** 开火时使用的武器槽位（{@link WEAPON_SLOTS}）。 */
  weaponSlot: number;
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

/** 投掷方向的最大俯仰（弧度），防止垂直上抛。 */
export const THROW_MAX_PITCH: number = 0.6;

/** 手雷重力加速度（米/秒²）。 */
export const GRENADE_GRAVITY: number = 18;

/** 手雷落地弹性系数。 */
export const GRENADE_BOUNCE: number = 0.35;

/** 手雷碰撞半径（米）。 */
export const GRENADE_RADIUS: number = 0.11;

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
