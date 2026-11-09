/**
 * 左上角小地图（雷达）。
 *
 * 设计取舍（参照 CS / COD 这类战术射击游戏的常见做法）：
 *   - **北朝上固定**：地图不跟着视角旋转，玩家箭头自己转。旋转雷达在快节奏对枪时
 *     容易让人分不清"哪边是 A 点"，而这张图的三路布局本身就是靠方位记的；
 *   - **只画实心体块**：墙体/建筑用亮色、1.1m 矮掩体用暗色。小地图不是 3D 预览，
 *     玩家需要的是"哪条路是通的、我在哪个拐角"，不是复刻场景；
 *   - **敌人只在通视时显示**：与 gameplay 一致（没有雷达扫描/听声辨位），
 *     用同一条 2D 视线求交判断，避免"小地图卖队友位置"变成透视挂；
 *   - **静态层缓存**：97 个体块每帧重绘没有必要，墙体只画一次到离屏 canvas，
 *     每帧只 blit 一次 + 画几个点，15Hz 刷新，开销可以忽略。
 */

import { MAP_BOUNDS, MAP_ZONES, OBSTACLES, mapZoneAt } from "@colyseus-fps/shared";
import type { PlayerState } from "../net/types.js";

/** 面板边长（CSS px）。 */
const PANEL_SIZE = 196;
/** 面板内边距：留出方位标记与描边。 */
const PANEL_PADDING = 7;
/** 重绘频率上限（Hz）。小地图不需要 60fps，15Hz 已经比人眼反应快。 */
const MINIMAP_MAX_FPS = 15;
/** 视线判定时把体块外扩的余量（米）：贴着墙站不至于被自己的墙挡成"看不见"。 */
const LOS_EPSILON = 0.02;
/** 矮于该高度的掩体不挡视线（1.1m 的箱子只到胸口，小地图上不当作遮挡）。 */
const LOS_BLOCK_HEIGHT = 1.3;
/** 视野扇形半角（弧度）与长度（米）：与 80° 竖直 FOV、16:9 下的水平视场接近。 */
const VIEW_CONE_HALF_ANGLE = (42 * Math.PI) / 180;
const VIEW_CONE_RANGE = 22;

const COLOR = {
  frame: "rgba(148, 163, 184, 0.5)",
  frameSoft: "rgba(148, 163, 184, 0.22)",
  wall: "rgba(226, 232, 240, 0.72)",
  lowCover: "rgba(148, 163, 184, 0.34)",
  siteFill: "rgba(245, 158, 11, 0.1)",
  siteStroke: "rgba(245, 158, 11, 0.55)",
  siteText: "rgba(253, 230, 138, 0.95)",
  label: "rgba(203, 213, 225, 0.72)",
  self: "#7dd3fc",
  teammate: "#38bdf8",
  teammateDead: "rgba(56, 189, 248, 0.3)",
  enemy: "#f87171",
  cone: "rgba(125, 211, 252, 0.16)",
} as const;

/** 需要在地图上写字的区域（其余分区只用于播报/查询）。 */
const LABELED_ZONE_IDS: ReadonlySet<string> = new Set([
  "site_a",
  "site_b",
  "spawn_t",
  "spawn_ct",
  "mid",
  "long_a",
  "tunnels",
  "ct_mid",
]);

interface StaticLayers {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
}

export class Minimap {
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly layer: StaticLayers;
  private readonly dpr: number;
  /** 每米多少 CSS 像素（世界 → 面板）。 */
  private readonly scale: number;
  /** 世界原点到面板左上角的偏移（CSS px）。 */
  private readonly offsetX: number;
  private readonly offsetY: number;
  private lastDrawAt = 0;
  private exploded = false;

  public constructor(container: HTMLElement) {
    this.dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    this.canvas = document.createElement("canvas");
    this.canvas.id = "minimap";
    this.canvas.className = "minimap";
    this.canvas.width = Math.round(PANEL_SIZE * this.dpr);
    this.canvas.height = Math.round(PANEL_SIZE * this.dpr);
    this.canvas.style.width = `${PANEL_SIZE}px`;
    this.canvas.style.height = `${PANEL_SIZE}px`;
    container.appendChild(this.canvas);

    const context = this.canvas.getContext("2d");
    if (context === null) {
      // 没有 2D 上下文就什么也不做（极端环境），调用方仍可安全 update
      this.exploded = true;
      this.context = null as unknown as CanvasRenderingContext2D;
      this.layer = { canvas: this.canvas, width: 0, height: 0 };
      this.scale = 1;
      this.offsetX = 0;
      this.offsetY = 0;
      return;
    }
    this.context = context;

    const spanX = MAP_BOUNDS.maxX - MAP_BOUNDS.minX;
    const spanZ = MAP_BOUNDS.maxZ - MAP_BOUNDS.minZ;
    const drawable = PANEL_SIZE - PANEL_PADDING * 2;
    this.scale = drawable / Math.max(spanX, spanZ);
    this.offsetX = PANEL_PADDING + (drawable - spanX * this.scale) / 2;
    this.offsetY = PANEL_PADDING + (drawable - spanZ * this.scale) / 2;

    this.layer = this.buildStaticLayer();
  }

  public get element(): HTMLCanvasElement {
    return this.canvas;
  }

  /** 世界坐标 → 面板 CSS 像素坐标。z 越大越靠下（北在上，与 CS 雷达同向）。 */
  private project(x: number, z: number): { x: number; y: number } {
    return {
      x: this.offsetX + (x - MAP_BOUNDS.minX) * this.scale,
      y: this.offsetY + (z - MAP_BOUNDS.minZ) * this.scale,
    };
  }

  /**
   * 把墙体/建筑画一次到离屏 canvas。
   *
   * 分层规则：`height >= 1.3` 用亮色（挡视线、挡子弹的主力），更矮的用暗色
   * （能跳过去、也能被子弹穿过上半身）。这比"一律同色"更能读出可走性。
   */
  private buildStaticLayer(): StaticLayers {
    const canvas = document.createElement("canvas");
    canvas.width = this.canvas.width;
    canvas.height = this.canvas.height;
    const context = canvas.getContext("2d");
    if (context === null) {
      return { canvas, width: 0, height: 0 };
    }
    context.scale(this.dpr, this.dpr);

    // 包点底纹：先铺 A/B 两块，让"往哪打"一眼可见
    for (const zone of MAP_ZONES) {
      if (zone.kind !== "site") {
        continue;
      }
      const topLeft = this.project(zone.minX, zone.minZ);
      const bottomRight = this.project(zone.maxX, zone.maxZ);
      context.fillStyle = COLOR.siteFill;
      context.strokeStyle = COLOR.siteStroke;
      context.lineWidth = 1;
      context.fillRect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);
      context.strokeRect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);
    }

    // 体块：先画矮掩体，再画高墙（高墙压在上面，轮廓更清楚）
    const sorted = [...OBSTACLES].sort((left, right) => left.height - right.height);
    for (const obstacle of sorted) {
      const topLeft = this.project(obstacle.x - obstacle.width / 2, obstacle.z - obstacle.depth / 2);
      const bottomRight = this.project(obstacle.x + obstacle.width / 2, obstacle.z + obstacle.depth / 2);
      const width = Math.max(1, bottomRight.x - topLeft.x);
      const height = Math.max(1, bottomRight.y - topLeft.y);
      context.fillStyle = obstacle.height >= LOS_BLOCK_HEIGHT ? COLOR.wall : COLOR.lowCover;
      context.fillRect(topLeft.x, topLeft.y, width, height);
    }

    // 分区文字
    context.textAlign = "center";
    context.textBaseline = "middle";
    for (const zone of MAP_ZONES) {
      if (!LABELED_ZONE_IDS.has(zone.id)) {
        continue;
      }
      const center = this.project((zone.minX + zone.maxX) / 2, (zone.minZ + zone.maxZ) / 2);
      if (zone.kind === "site") {
        context.font = "700 13px 'Segoe UI', system-ui, sans-serif";
        context.fillStyle = COLOR.siteText;
        context.fillText(zone.id === "site_a" ? "A" : "B", center.x, center.y);
      } else {
        context.font = "500 8.5px 'Segoe UI', system-ui, sans-serif";
        context.fillStyle = COLOR.label;
        // 出生点贴边写，避免盖住通道
        const y = zone.kind === "spawn" ? center.y : center.y;
        context.fillText(zone.label, center.x, y);
      }
    }

    return { canvas, width: PANEL_SIZE, height: PANEL_SIZE };
  }

  /**
   * 每帧调用（内部限流到 {@link MINIMAP_MAX_FPS}）。
   *
   * @param players 全部玩家（含自己），带队伍与存活状态
   * @param selfId  自己的 sessionId
   * @param nowMs   当前时间戳（performance.now）
   */
  public update(players: readonly PlayerState[], selfId: string, nowMs: number): void {
    if (this.exploded) {
      return;
    }
    if (nowMs - this.lastDrawAt < 1000 / MINIMAP_MAX_FPS) {
      return;
    }
    this.lastDrawAt = nowMs;

    const self = players.find((player) => player.sessionId === selfId);
    if (self === undefined) {
      return;
    }

    const context = this.context;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    context.scale(this.dpr, this.dpr);

    // 底板（比纯黑更透气，能看到背后的场景）
    context.fillStyle = "rgba(9, 14, 22, 0.62)";
    context.fillRect(0, 0, PANEL_SIZE, PANEL_SIZE);

    context.drawImage(this.layer.canvas, 0, 0, PANEL_SIZE, PANEL_SIZE);

    // 视野扇形：自己朝向的前方 22m
    this.drawViewCone(context, self);

    // 玩家点位
    for (const player of players) {
      if (player.sessionId === selfId) {
        continue;
      }
      const sameTeam: boolean = player.team === self.team;
      if (!sameTeam) {
        // 敌人只在通视时出现。和"听声辨位"一样是公平信息，不做雷达扫描。
        if (!player.alive || !this.hasLineOfSight(self, player)) {
          continue;
        }
        this.drawDot(context, player, COLOR.enemy, 2.6);
        continue;
      }
      this.drawTeammate(context, player);
    }

    // 自己最后画（永远压在队友/敌人上面）
    this.drawSelf(context, self);

    // 外框 + 方位标记
    context.strokeStyle = COLOR.frame;
    context.lineWidth = 1;
    context.strokeRect(0.5, 0.5, PANEL_SIZE - 1, PANEL_SIZE - 1);

    context.font = "700 9px 'Segoe UI', system-ui, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "top";
    context.fillStyle = COLOR.frame;
    context.fillText("N", PANEL_SIZE / 2, 2);

    // 当前所在区域：写在地图下沿，回答"我在哪"
    const zone = mapZoneAt(self.x, self.z);
    if (zone !== null) {
      context.textBaseline = "bottom";
      context.fillStyle = "rgba(226, 232, 240, 0.9)";
      context.font = "500 9.5px 'Segoe UI', system-ui, sans-serif";
      context.fillText(zone.label, PANEL_SIZE / 2, PANEL_SIZE - 4);
    }
  }

  private drawViewCone(
    context: CanvasRenderingContext2D,
    self: PlayerState,
  ): void {
    const origin = this.project(self.x, self.z);
    // yaw = 0 面向 −Z（画布上方）；three.js 里 forward = (−sin yaw, −cos yaw)，
    // 画布坐标里"上方"是 −y，所以屏幕角度 = −yaw。
    const heading = -self.yaw;
    context.beginPath();
    context.moveTo(origin.x, origin.y);
    const steps = 12;
    for (let i = 0; i <= steps; i += 1) {
      const angle = heading - VIEW_CONE_HALF_ANGLE + (VIEW_CONE_HALF_ANGLE * 2 * i) / steps;
      const distance = VIEW_CONE_RANGE * this.scale;
      context.lineTo(origin.x + Math.sin(angle) * distance, origin.y - Math.cos(angle) * distance);
    }
    context.closePath();
    context.fillStyle = COLOR.cone;
    context.fill();
  }

  private drawDot(
    context: CanvasRenderingContext2D,
    player: PlayerState,
    color: string,
    radius: number,
  ): void {
    const point = this.project(player.x, player.z);
    context.beginPath();
    context.arc(point.x, point.y, radius, 0, Math.PI * 2);
    context.fillStyle = color;
    context.fill();
  }

  private drawTeammate(context: CanvasRenderingContext2D, player: PlayerState): void {
    if (!player.alive) {
      // 阵亡队友保留一个空心圈：位置信息在 CS 里也是可见的，方便判断哪条路丢了
      const point = this.project(player.x, player.z);
      context.beginPath();
      context.arc(point.x, point.y, 2.4, 0, Math.PI * 2);
      context.strokeStyle = COLOR.teammateDead;
      context.lineWidth = 1;
      context.stroke();
      return;
    }
    this.drawDot(context, player, COLOR.teammate, 2.6);
    // 朝向短线：判断"他瞄哪边"
    const point = this.project(player.x, player.z);
    context.beginPath();
    context.moveTo(point.x, point.y);
    context.lineTo(point.x + Math.sin(-player.yaw) * 5.5, point.y - Math.cos(-player.yaw) * 5.5);
    context.strokeStyle = COLOR.teammate;
    context.lineWidth = 1;
    context.stroke();
  }

  private drawSelf(context: CanvasRenderingContext2D, self: PlayerState): void {
    const point = this.project(self.x, self.z);
    context.save();
    context.translate(point.x, point.y);
    // 画布 +y 向下；yaw=0 面向 −Z → 箭头朝上。rotate(−yaw) 把 −Z 方向转到箭头的 +Y 前
    context.rotate(-self.yaw);
    context.beginPath();
    context.moveTo(0, -5.4);
    context.lineTo(3.6, 4.2);
    context.lineTo(0, 2.2);
    context.lineTo(-3.6, 4.2);
    context.closePath();
    context.fillStyle = self.alive ? COLOR.self : "rgba(125, 211, 252, 0.45)";
    context.fill();
    context.strokeStyle = "rgba(8, 12, 18, 0.85)";
    context.lineWidth = 1;
    context.stroke();
    context.restore();
  }

  /**
   * 2D 视线判定：从自己到目标的一条线段是否被"够高的体块"挡住。
   *
   * 只做 XZ 平面的 slab 求交 + 高度过滤，足够回答小地图的问题；真正的弹道遮挡
   * 由服务端 `rayAabb` 负责（那里是 3D，还带命中点与法向）。
   */
  private hasLineOfSight(from: PlayerState, to: PlayerState): boolean {
    const ax = from.x;
    const az = from.z;
    const bx = to.x;
    const bz = to.z;
    const dx = bx - ax;
    const dz = bz - az;
    for (const obstacle of OBSTACLES) {
      if (obstacle.height < LOS_BLOCK_HEIGHT) {
        continue;
      }
      const minX = obstacle.x - obstacle.width / 2 - LOS_EPSILON;
      const maxX = obstacle.x + obstacle.width / 2 + LOS_EPSILON;
      const minZ = obstacle.z - obstacle.depth / 2 - LOS_EPSILON;
      const maxZ = obstacle.z + obstacle.depth / 2 + LOS_EPSILON;

      let tMin = 0;
      let tMax = 1;
      if (Math.abs(dx) < 1e-6) {
        if (ax < minX || ax > maxX) {
          continue;
        }
      } else {
        const t1 = (minX - ax) / dx;
        const t2 = (maxX - ax) / dx;
        tMin = Math.max(tMin, Math.min(t1, t2));
        tMax = Math.min(tMax, Math.max(t1, t2));
        if (tMin > tMax) {
          continue;
        }
      }
      if (Math.abs(dz) < 1e-6) {
        if (az < minZ || az > maxZ) {
          continue;
        }
      } else {
        const t1 = (minZ - az) / dz;
        const t2 = (maxZ - az) / dz;
        tMin = Math.max(tMin, Math.min(t1, t2));
        tMax = Math.min(tMax, Math.max(t1, t2));
        if (tMin > tMax) {
          continue;
        }
      }
      if (tMax > 0 && tMin < 1) {
        return false;
      }
    }
    return true;
  }

  public dispose(): void {
    this.canvas.remove();
  }
}
