/**
 * 出生点选择（纯函数，可单测）。
 *
 * 策略（文档 5.3）：每队 4 个固定点里随机，按三级过滤：
 *   1. **占位过滤**：同队其他存活玩家 1.2m 内的点排除（避免两人重叠出生）；
 *   2. **视线过滤**：12m 内、看向该点且中间**没有**掩体遮挡的敌人，会否掉这个点；
 *      有遮挡 = 安全（复用 combat.ts 的 `rayAabb`，与弹道判定同一份 AABB 数据）；
 *   3. **三级回退**：safe → free → 全部候选；再做一个"避免连续同一人同一点"的重抽（最多 2 次）；
 *      全部被占（8 人房不会发生）时按文档 5.4 沿 +X 偏移 0.9m，而不是直接重叠。
 *
 * 加入与重生共用同一个入口，避免"开局站位好、重生乱站"。
 */

import {
  EYE_HEIGHT,
  PLAYER_HEIGHT,
  PLAYER_HIT_RADIUS,
  teamSpawnPoints,
  type Aabb,
  type SpawnPoint,
  type TeamId,
} from "@colyseus-fps/shared";

import { directionFromYawPitch, rayAabb, type Vec3 } from "./combat.js";

/** 出生点占用半径（米）：同队玩家落在这个距离内即视为该点被占。 */
export const SPAWN_OCCUPANCY_RADIUS: number = 1.2;

/** 敌人视线威胁半径（米）：超过该距离即使通视也不算威胁（枪口太远，出生瞬间不会被打）。 */
export const SPAWN_DANGER_RADIUS: number = 12;

/** 视线检测的最大长度（米）。 */
const SPAWN_SIGHT_RANGE: number = 40;

/** 全部候选都被占时的溢出偏移（米，沿 +X，取自文档 5.4 的实测坐标）。 */
export const SPAWN_OVERFLOW_OFFSET_X: number = 0.9;

/** 重抽次数上限（避免连续两次出生在同一个点）。 */
const RESAMPLE_ATTEMPTS: number = 2;

/** 出生点选择所需的最小玩家视图。 */
export interface SpawnPlayerView {
  sessionId: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  alive: boolean;
}

/** 候选点（带它在队内列表中的下标，用于"避免连续同点"）。 */
export interface SpawnCandidate {
  point: SpawnPoint;
  index: number;
}

/** 出生点选择结果。 */
export interface SpawnSelection {
  point: SpawnPoint;
  /** 队内下标（服务端记到 `Player.lastSpawnIndex`，下次重抽时避开）。 */
  index: number;
  /** 是否走了"全部被占"的溢出分支（便于日志与测试断言）。 */
  overflow: boolean;
}

export interface PickSpawnOptions {
  team: TeamId;
  selfId: string;
  /** 上一次出生用的队内下标；-1 表示没有（首次加入）。 */
  lastIndex?: number;
  players: Iterable<SpawnPlayerView>;
  obstacles: readonly Aabb[];
  /** 随机源（单测注入固定序列，生产用 `Math.random`）。 */
  random?: () => number;
}

/** 以出生点为中心、按玩家碰撞尺寸构造的 AABB（用于"敌人是否看得见这个点"）。 */
export function aabbOfSpawn(point: SpawnPoint): Aabb {
  return {
    minX: point.x - PLAYER_HIT_RADIUS,
    maxX: point.x + PLAYER_HIT_RADIUS,
    minY: 0,
    maxY: PLAYER_HEIGHT,
    minZ: point.z - PLAYER_HIT_RADIUS,
    maxZ: point.z + PLAYER_HIT_RADIUS,
  };
}

/** 该点是否被同队其他存活玩家占用（1.2m 内）。 */
function isOccupied(point: SpawnPoint, selfId: string, players: readonly SpawnPlayerView[]): boolean {
  for (const player of players) {
    if (player.sessionId === selfId || !player.alive) {
      continue;
    }
    const distance: number = Math.hypot(player.x - point.x, player.z - point.z);
    if (distance <= SPAWN_OCCUPANCY_RADIUS) {
      return true;
    }
  }
  return false;
}

/** 该点是否暴露在某个敌人的视野里（12m 内 + 通视 = 危险）。 */
function isExposed(
  point: SpawnPoint,
  selfId: string,
  players: readonly SpawnPlayerView[],
  obstacles: readonly Aabb[],
): boolean {
  const target: Aabb = aabbOfSpawn(point);
  for (const player of players) {
    if (player.sessionId === selfId || !player.alive) {
      continue;
    }
    const distance: number = Math.hypot(player.x - point.x, player.z - point.z);
    if (distance > SPAWN_DANGER_RADIUS) {
      continue;
    }
    const eye: Vec3 = { x: player.x, y: player.y + EYE_HEIGHT, z: player.z };
    const dir: Vec3 = directionFromYawPitch(player.yaw, player.pitch);

    // 先看敌人视线是否真的穿过这个出生点的判定盒（没朝向它就谈不上威胁）
    const targetT: number | null = rayAabb(eye, dir, target, SPAWN_SIGHT_RANGE);
    if (targetT === null) {
      continue;
    }

    // 再求最近掩体距离：掩体比出生点更近 = 被挡住 = 安全
    let wallT: number = SPAWN_SIGHT_RANGE;
    for (const box of obstacles) {
      const t: number | null = rayAabb(eye, dir, box, wallT);
      if (t !== null && t < wallT) {
        wallT = t;
      }
    }

    if (targetT < wallT) {
      return true;
    }
  }
  return false;
}

/**
 * 选一个出生点。
 *
 * 三级回退的语义（不要让空数组漏到返回值里）：
 *   `safe`（不被占 + 不在敌人视线内）→ `free`（不被占）→ 全部候选。
 */
export function pickSpawnPoint(options: PickSpawnOptions): SpawnSelection {
  const random: () => number = options.random ?? Math.random;
  const players: readonly SpawnPlayerView[] = Array.from(options.players);
  const candidates: SpawnCandidate[] = teamSpawnPoints(options.team).map((point, index) => ({ point, index }));

  if (candidates.length === 0) {
    // 出生表被清空的兜底（正常不会发生）：退回地图中心，保证调用方永远拿得到坐标
    return { point: { team: options.team, x: 0, z: 0, yaw: 0 }, index: 0, overflow: true };
  }

  const free: SpawnCandidate[] = candidates.filter(
    ({ point }) => !isOccupied(point, options.selfId, players),
  );
  const safe: SpawnCandidate[] = free.filter(
    ({ point }) => !isExposed(point, options.selfId, players, options.obstacles),
  );

  if (safe.length === 0 && free.length === 0) {
    // 全部被占：允许重叠，但沿 +X 偏移，避免两人完全同点（图省事的重叠会让两人完全卡在一起）
    const pick: SpawnCandidate = candidates[Math.floor(random() * candidates.length)] ?? candidates[0]!;
    return {
      point: { team: pick.point.team, x: pick.point.x + SPAWN_OVERFLOW_OFFSET_X, z: pick.point.z, yaw: pick.point.yaw },
      index: pick.index,
      overflow: true,
    };
  }

  const pool: SpawnCandidate[] = safe.length > 0 ? safe : free;
  const lastIndex: number = options.lastIndex ?? -1;

  let pick: SpawnCandidate = pool[Math.floor(random() * pool.length)] ?? pool[0]!;
  for (let attempt = 0; attempt < RESAMPLE_ATTEMPTS; attempt += 1) {
    if (pool.length <= 1 || pick.index !== lastIndex) {
      break;
    }
    pick = pool[Math.floor(random() * pool.length)] ?? pick;
  }

  return { point: pick.point, index: pick.index, overflow: false };
}
