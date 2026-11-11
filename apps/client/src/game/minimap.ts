/**
 * 左上角圆形雷达。
 *
 * 视觉规则（与整套 UI 同源）：
 *   - 纸底 + 墨线，不透明——沙漠/厨房这类高亮场景上也能看清；
 *   - 只有三种点位颜色：自己（墨黑箭头）、队友（天空蓝）、敌人（番茄红）；
 *   - 视野扇形用奶酪黄，和武器栏选中态是同一个信号。
 *
 * 布局取舍：
 *   - **北朝上固定**：地图不跟着视角旋转，玩家箭头自己转。旋转雷达在快节奏对枪时
 *     容易让人分不清"哪边是 A 点"，而这张图的三路布局本身就是靠方位记的；
 *   - **整张图塞进圆盘**：按地图对角线算缩放（`/√2`），保证四个角不被圆形边框切掉。
 *     代价是地图比"填满圆盘"小一圈，但宁可小也不能丢信息——角落里的包点是能决定胜负的；
 *   - **只画实心体块**：墙体用墨色、矮掩体用淡墨。雷达不是 3D 预览，玩家要的是
 *     "哪条路通、我在哪个拐角"。
 *   - **敌人只在通视时显示**：与 gameplay 一致（没有雷达扫描），用同一条 2D 视线求交，
 *     避免"雷达卖队友位置"变成透视挂；
 *   - **静态层缓存**：97 个体块每帧重绘没必要，墙体只画一次到离屏 canvas，
 *     每帧只 blit 一次 + 画几个点，15Hz 刷新，开销可以忽略。
 */

import { MAP_BOUNDS, MAP_ZONES, OBSTACLES, mapZoneAt } from "@colyseus-fps/shared";
import type { PlayerState } from "../net/types.js";

/** 表盘直径（CSS px），必须与 style.css 的 `.hud-radar-dial` 一致。 */
const PANEL_SIZE = 208;
/** 地图到圆盘边缘的留白（含方位刻度）。 */
const PANEL_PADDING = 14;
/** 重绘频率上限（Hz）。雷达不需要 60fps，15Hz 已经比人眼反应快。 */
const MINIMAP_MAX_FPS = 15;
/** 视线判定时把体块外扩的余量（米）：贴着墙站不至于被自己的墙挡成"看不见"。 */
const LOS_EPSILON = 0.02;
/** 矮于该高度的掩体不挡视线（1.1m 的箱子只到胸口）。 */
const LOS_BLOCK_HEIGHT = 1.3;
/** 视野扇形半角（弧度）与长度（米）。 */
const VIEW_CONE_HALF_ANGLE = (42 * Math.PI) / 180;
const VIEW_CONE_RANGE = 22;

const COLOR = {
  base: "#f3e6ca",
  grid: "rgba(43, 27, 47, 0.05)",
  bound: "rgba(43, 27, 47, 0.38)",
  wall: "#5a4459",
  lowCover: "rgba(90, 68, 89, 0.2)",
  siteFill: "rgba(255, 198, 61, 0.45)",
  siteStroke: "rgba(43, 27, 47, 0.55)",
  siteText: "#2b1b2f",
  label: "rgba(43, 27, 47, 0.62)",
  labelHalo: "rgba(255, 248, 233, 0.9)",
  self: "#2b1b2f",
  teammate: "#3fa9e0",
  teammateDead: "rgba(63, 169, 224, 0.4)",
  enemy: "#e8432f",
  cone: "rgba(255, 198, 61, 0.3)",
} as const;

/**
 * 需要在地图上写字的区域（其余分区只用于播报/查询）。
 *
 * 只保留四个：包点两个、出生点两个。地图塞进圆盘后可用面积很小，
 * 每多一个标签就会和墙块、包点字母挤在一起——"在哪"由下方胶囊回答，
 * 圆盘只回答"往哪走"。
 */
const LABELED_ZONE_IDS: ReadonlySet<string> = new Set([
  "site_a",
  "site_b",
  "spawn_t",
  "spawn_ct",
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
  /** 每米多少 CSS 像素（世界 → 表盘）。 */
  private readonly scale: number;
  /** 世界原点到表盘左上角的偏移（CSS px）。 */
  private readonly offsetX: number;
  private readonly offsetY: number;
  private lastDrawAt = 0;
  private exploded = false;
  /** 自己当前所在分区的名字（HUD 胶囊里显示），由 update 写入。 */
  private zoneLabel = "";

  public constructor(container: HTMLElement) {
    this.dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    this.canvas = document.createElement("canvas");
    this.canvas.id = "minimap";
    this.canvas.className = "minimap";
    this.canvas.width = Math.round(PANEL_SIZE * this.dpr);
    this.canvas.height = Math.round(PANEL_SIZE * this.dpr);
    // 尺寸交给 CSS（100% 撑满表盘）：窄屏下表盘变小，画布跟着等比缩放，
    // 不能写死 208px，否则小屏会把圆盘右下角裁掉一半。
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
    // 按对角线定标：矩形图的对角线 = 圆的内接正方形边长，四角才都落在圆内
    const diagonal = Math.hypot(spanX, spanZ);
    this.scale = drawable / diagonal;
    this.offsetX = PANEL_SIZE / 2 - (spanX * this.scale) / 2;
    this.offsetY = PANEL_SIZE / 2 - (spanZ * this.scale) / 2;

    this.layer = this.buildStaticLayer();
  }

  public get element(): HTMLCanvasElement {
    return this.canvas;
  }

  /** 当前所在分区名（未初始化时为空串）。 */
  public get currentZoneLabel(): string {
    return this.zoneLabel;
  }

  /** 世界坐标 → 表盘 CSS 像素坐标。z 越大越靠下（北在上）。 */
  private project(x: number, z: number): { x: number; y: number } {
    return {
      x: this.offsetX + (x - MAP_BOUNDS.minX) * this.scale,
      y: this.offsetY + (z - MAP_BOUNDS.minZ) * this.scale,
    };
  }

  /**
   * 把墙体/建筑画一次到离屏 canvas。
   *
   * 分层规则：`height >= 1.3` 用墨色（挡视线、挡子弹的主力），更矮的用淡墨
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

    // 地图底：浅纸色矩形，让"可活动区域"从表盘留白里分出来
    const origin = this.project(MAP_BOUNDS.minX, MAP_BOUNDS.minZ);
    const far = this.project(MAP_BOUNDS.maxX, MAP_BOUNDS.maxZ);
    context.fillStyle = COLOR.base;
    context.strokeStyle = COLOR.bound;
    context.lineWidth = 1.5;
    context.beginPath();
    context.rect(origin.x, origin.y, far.x - origin.x, far.y - origin.y);
    context.fill();
    context.stroke();

    // 2m 网格：给距离感一个参照，比纯色块更像"地图"
    context.save();
    context.beginPath();
    context.rect(origin.x, origin.y, far.x - origin.x, far.y - origin.y);
    context.clip();
    context.strokeStyle = COLOR.grid;
    context.lineWidth = 1;
    for (let x = Math.ceil(MAP_BOUNDS.minX / 2) * 2; x < MAP_BOUNDS.maxX; x += 2) {
      const top = this.project(x, MAP_BOUNDS.minZ);
      const bottom = this.project(x, MAP_BOUNDS.maxZ);
      context.beginPath();
      context.moveTo(top.x, top.y);
      context.lineTo(bottom.x, bottom.y);
      context.stroke();
    }
    for (let z = Math.ceil(MAP_BOUNDS.minZ / 2) * 2; z < MAP_BOUNDS.maxZ; z += 2) {
      const left = this.project(MAP_BOUNDS.minX, z);
      const right = this.project(MAP_BOUNDS.maxX, z);
      context.beginPath();
      context.moveTo(left.x, left.y);
      context.lineTo(right.x, right.y);
      context.stroke();
    }
    context.restore();

    // 包点底纹：先铺，让"往哪打"一眼可见
    for (const zone of MAP_ZONES) {
      if (zone.kind !== "site") {
        continue;
      }
      const topLeft = this.project(zone.minX, zone.minZ);
      const bottomRight = this.project(zone.maxX, zone.maxZ);
      context.fillStyle = COLOR.siteFill;
      context.strokeStyle = COLOR.siteStroke;
      context.lineWidth = 1.5;
      context.fillRect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);
      context.strokeRect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);
    }

    // 体块：先画矮掩体，再画高墙（高墙压在上面，轮廓更清楚）
    const sorted = [...OBSTACLES].sort((left, right) => left.height - right.height);
    for (const obstacle of sorted) {
      const topLeft = this.project(obstacle.x - obstacle.width / 2, obstacle.z - obstacle.depth / 2);
      const bottomRight = this.project(obstacle.x + obstacle.width / 2, obstacle.z + obstacle.depth / 2);
      const width = Math.max(1.5, bottomRight.x - topLeft.x);
      const height = Math.max(1.5, bottomRight.y - topLeft.y);
      context.fillStyle = obstacle.height >= LOS_BLOCK_HEIGHT ? COLOR.wall : COLOR.lowCover;
      context.fillRect(topLeft.x, topLeft.y, width, height);
    }

    // 分区文字：先描一圈纸色光晕再填字，压在墙块上也读得清
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.lineJoin = "round";
    const drawLabel = (text: string, x: number, y: number, color: string): void => {
      context.strokeStyle = COLOR.labelHalo;
      context.lineWidth = 3.5;
      context.strokeText(text, x, y);
      context.fillStyle = color;
      context.fillText(text, x, y);
    };

    for (const zone of MAP_ZONES) {
      if (!LABELED_ZONE_IDS.has(zone.id) || zone.kind === "site") {
        continue;
      }
      const center = this.project((zone.minX + zone.maxX) / 2, (zone.minZ + zone.maxZ) / 2);
      context.font = "700 8.5px 'Microsoft YaHei', sans-serif";
      drawLabel(zone.label, center.x, center.y, COLOR.label);
    }

    // 包点字母最后画：它是"往哪打"的最终答案，不能被任何标签盖住
    for (const zone of MAP_ZONES) {
      if (zone.kind !== "site") {
        continue;
      }
      const center = this.project((zone.minX + zone.maxX) / 2, (zone.minZ + zone.maxZ) / 2);
      context.font = "800 16px 'Baloo 2', 'Microsoft YaHei', sans-serif";
      drawLabel(zone.id === "site_a" ? "A" : "B", center.x, center.y, COLOR.siteText);
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
        this.drawDot(context, player, COLOR.enemy, 3.8);
        continue;
      }
      this.drawTeammate(context, player);
    }

    // 自己最后画（永远压在队友/敌人上面）
    this.drawSelf(context, self);

    const zone = mapZoneAt(self.x, self.z);
    this.zoneLabel = zone === null ? "" : zone.label;
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

  /** 点位统一「实心圆 + 墨线描边」，在纸底和深色墙块上都立得住。 */
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
    context.strokeStyle = "rgba(43, 27, 47, 0.85)";
    context.lineWidth = 1.6;
    context.stroke();
  }

  private drawTeammate(context: CanvasRenderingContext2D, player: PlayerState): void {
    if (!player.alive) {
      // 阵亡队友保留空心圈：位置信息在 CS 里也是可见的，方便判断哪条路丢了
      const point = this.project(player.x, player.z);
      context.beginPath();
      context.arc(point.x, point.y, 3, 0, Math.PI * 2);
      context.strokeStyle = COLOR.teammateDead;
      context.lineWidth = 1.6;
      context.stroke();
      return;
    }
    this.drawDot(context, player, COLOR.teammate, 3.8);
    // 朝向短线：判断"他瞄哪边"
    const point = this.project(player.x, player.z);
    context.beginPath();
    context.moveTo(point.x, point.y);
    context.lineTo(point.x + Math.sin(-player.yaw) * 7, point.y - Math.cos(-player.yaw) * 7);
    context.strokeStyle = COLOR.teammate;
    context.lineWidth = 2.2;
    context.stroke();
  }

  private drawSelf(context: CanvasRenderingContext2D, self: PlayerState): void {
    const point = this.project(self.x, self.z);
    context.save();
    context.translate(point.x, point.y);
    // 画布 +y 向下；yaw=0 面向 −Z → 箭头朝上
    context.rotate(-self.yaw);
    context.beginPath();
    context.moveTo(0, -8.4);
    context.lineTo(5.8, 6.4);
    context.lineTo(0, 3.6);
    context.lineTo(-5.8, 6.4);
    context.closePath();
    context.fillStyle = self.alive ? COLOR.self : "rgba(43, 27, 47, 0.45)";
    context.fill();
    // 反向描奶油边，压深色墙块时也能看见箭头轮廓
    context.strokeStyle = "#fff8e9";
    context.lineWidth = 2;
    context.stroke();
    context.restore();
  }

  /**
   * 2D 视线判定：从自己到目标的一条线段是否被"够高的体块"挡住。
   *
   * 只做 XZ 平面的 slab 求交 + 高度过滤，足够回答雷达的问题；真正的弹道遮挡
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
