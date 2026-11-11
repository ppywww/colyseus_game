/**
 * HUD：准星（动态扩散）、命中标记、部位伤害读数、血量、弹药与换弹进度、
 * 6 格武器栏、击杀播报与击杀横幅、死亡遮罩、闪光致盲遮罩、受击方向提示、
 * 指针锁定引导（含设置面板）。
 *
 * 全部用 DOM 实现，避免额外渲染库；每帧只更新变化的文本/样式。
 */

import { Minimap } from "./minimap.js";
import type { PlayerState } from "../net/types.js";
import { HEADS, WEAPON_ICONS } from "../ui/art.js";
import {
  CROSSHAIR_DEFAULT,
  SLOT_KEY,
  SLOT_LABEL,
  SLOT_ORDER,
  THROWABLE_TYPES,
  WEAPON_SLOTS,
  throwableTypeOfSlot,
  type CrosshairSettings,
  type WeaponSlot,
} from "@colyseus-fps/shared";

export interface HudPlayerRow {
  sessionId: string;
  displayName: string;
  kills: number;
  deaths: number;
  alive: boolean;
}

/** 命中标记种类：普通命中 / 爆头 / 击杀。 */
export type HitmarkerKind = "body" | "head" | "kill";

export interface HudSnapshot {
  position: { x: number; y: number; z: number };
  playerCount: number;
  remoteCount: number;
  selfHp: number;
  selfAlive: boolean;
  selfRespawnAt: number;
  /** 当前武器槽位（0–5）：决定武器栏高亮与右下弹药面板显示哪把枪的弹药。 */
  weaponSlot: number;
  ammo: number;
  reserve: number;
  pistolAmmo: number;
  pistolReserve: number;
  reloadProgress: number;
  frags: number;
  flashes: number;
  smokes: number;
  spread: number;
}

/** 操作提示（大厅与游戏内共用同一句，改一处即可）。 */
export const HUD_HINT_TEXT =
  "WASD 移动 · Shift 冲刺 · Ctrl/C 下蹲 · 空格 跳跃 · 左键 开火/投掷/挥叉 · 滚轮/123456 切槽位 · R 换弹 · G/F/V 平底锅/胡椒瓶/面粉袋 · Esc 设置";

/** 武器栏格子数（= 槽位数量，顺序与 `SLOT_ORDER` 一致）。 */
const WEAPON_CELL_COUNT: number = SLOT_ORDER.length;

export class Hud {
  private readonly root: HTMLElement;
  private readonly crosshair: HTMLElement;
  private readonly hitmarker: HTMLElement;
  private readonly zoneDamage: HTMLElement;
  private readonly statusLine: HTMLElement;
  private readonly playerList: HTMLElement;
  private readonly killFeed: HTMLElement;
  private readonly killBanner: HTMLElement;
  /** 爆头击杀的「NICE!」奖励横幅（与普通击杀横幅分层，可以同时出现）。 */
  private readonly niceBanner: HTMLElement;
  /** 左上角雷达的容器（面板本身由 {@link Minimap} 负责绘制）。 */
  private readonly minimap: Minimap;
  /** 雷达下方的区域胶囊（「厨房 · 中央地砖」）。 */
  private readonly radarZone: HTMLElement;
  /** 雷达需要完整玩家状态（位置/朝向/队伍），与击杀面板用的 `HudPlayerRow` 是两套。 */
  private radarPlayers: readonly PlayerState[] = [];
  private radarSelfId = "";
  private readonly lockOverlay: HTMLElement;
  private readonly lockSettings: HTMLElement;
  private readonly positionLine: HTMLElement;
  private readonly hpBar: HTMLElement;
  private readonly hpText: HTMLElement;
  private readonly ammoTag: HTMLElement;
  private readonly ammoText: HTMLElement;
  private readonly reserveText: HTMLElement;
  private readonly reloadBar: HTMLElement;
  private readonly weaponCells: HTMLElement[] = [];
  private readonly weaponCounts: HTMLElement[] = [];
  private readonly lastWeaponCountText: string[] = [];
  private readonly deathOverlay: HTMLElement;
  private readonly deathCountdown: HTMLElement;
  private readonly flashOverlay: HTMLElement;
  private readonly damageOverlay: HTMLElement;
  private readonly damageArc: HTMLElement;
  private hitmarkerTimer = 0;
  private zoneDamageTimer = 0;
  private killBannerTimer = 0;
  private niceBannerTimer = 0;
  private damageTimer = 0;
  private weaponPulseTimer = 0;
  private flashUntil = 0;
  private flashPeak = 0;
  private lastSpread = -1;
  private lastWeaponSlot = -1;
  /** 当前准星外观（玩家在设置里调的），只读副本。 */
  private crosshairSettings: CrosshairSettings = { ...CROSSHAIR_DEFAULT };

  public constructor(container: HTMLElement) {
    this.root = document.createElement("div");
    this.root.id = "hud";

    this.crosshair = document.createElement("div");
    this.crosshair.id = "crosshair";
    // 类名 `.xh` 与设置面板里的预览框共用同一套 CSS：改一处两处都对，
    // 不会出现"面板里看着是绿的，进游戏准星还是白的"。
    this.crosshair.className = "xh";
    // 四个方向的臂 + 中心点（中心点默认隐藏，由 `.has-dot` 控制）
    this.crosshair.innerHTML =
      "<span></span><span></span><span></span><span></span><span class=\"xh-dot\"></span>";

    // 命中标记：四道外扩斜杠，中心留空——不能盖住准星正中，
    // 否则爆头瞬间反而看不见自己瞄在哪儿。墨线在外、彩色在内，浅色墙上也读得出。
    this.hitmarker = document.createElement("div");
    this.hitmarker.id = "hitmarker";
    this.hitmarker.innerHTML = `<svg viewBox="0 0 56 56" aria-hidden="true">
      <g stroke="#2b1b2f" stroke-width="7" stroke-linecap="round">
        <path d="M13 13l6.5 6.5M43 13l-6.5 6.5M13 43l6.5-6.5M43 43l-6.5-6.5"/>
      </g>
      <g stroke="currentColor" stroke-width="3.6" stroke-linecap="round">
        <path d="M13 13l6.5 6.5M43 13l-6.5 6.5M13 43l6.5-6.5M43 43l-6.5-6.5"/>
      </g>
    </svg>`;

    // 部位伤害提示：准星下方 40px，显示「头部 −100」500ms
    this.zoneDamage = document.createElement("div");
    this.zoneDamage.id = "zone-damage";

    // ---- 顶栏：玩家列表 + 击杀播报 ----
    const topBar = document.createElement("div");
    topBar.className = "hud-top";

    this.playerList = document.createElement("div");
    this.playerList.className = "hud-players";

    this.killFeed = document.createElement("div");
    this.killFeed.className = "hud-killfeed";

    topBar.append(this.playerList, this.killFeed);

    // ---- 左上圆形雷达：表盘 + 下方区域胶囊 ----
    const radarWrap = document.createElement("div");
    radarWrap.className = "hud-radar";

    const radarDial = document.createElement("div");
    radarDial.className = "hud-radar-dial";
    this.minimap = new Minimap(radarDial);

    // 方位靠 CSS 画（不跟着画布重绘），只保留 N/S 两个，避免圆盘上文字太吵
    const tickN = document.createElement("span");
    tickN.className = "hud-radar-tick n";
    tickN.textContent = "N";
    const tickS = document.createElement("span");
    tickS.className = "hud-radar-tick s";
    tickS.textContent = "S";
    radarDial.append(tickN, tickS);

    this.radarZone = document.createElement("span");
    this.radarZone.textContent = "";
    const radarName = document.createElement("div");
    radarName.className = "hud-radar-name";
    const mapTag = document.createElement("b");
    mapTag.textContent = "厨房";
    radarName.append(mapTag, this.radarZone);

    radarWrap.append(radarDial, radarName);

    this.killBanner = document.createElement("div");
    this.killBanner.id = "kill-banner";

    // 爆头奖励：奶酪黄「NICE!」，位置比击杀横幅更靠上，避免两者重叠
    this.niceBanner = document.createElement("div");
    this.niceBanner.id = "nice-banner";

    // ---- 调试信息：雷达下方，小字低对比（不是给玩家看的信息） ----
    const debugStack = document.createElement("div");
    debugStack.className = "hud-debug";
    this.statusLine = document.createElement("div");
    this.statusLine.className = "hud-status";
    this.positionLine = document.createElement("div");
    this.positionLine.className = "hud-position";
    debugStack.append(this.statusLine, this.positionLine);

    // ---- 生命：头像 + 大数字 + 分段条 ----
    const hpWrap = document.createElement("div");
    hpWrap.className = "hud-vitals";

    const hpFace = document.createElement("div");
    hpFace.className = "hud-vitals-face";
    hpFace.innerHTML = HEADS.jerry;

    const hpMain = document.createElement("div");
    hpMain.className = "hud-vitals-main";

    const hpRow = document.createElement("div");
    hpRow.className = "hud-vitals-row";
    this.hpText = document.createElement("div");
    this.hpText.className = "hud-hp-text";
    const hpUnit = document.createElement("span");
    hpUnit.className = "hud-vitals-unit";
    hpUnit.textContent = "生命";
    hpRow.append(this.hpText, hpUnit);

    const hpTrack = document.createElement("div");
    hpTrack.className = "hud-hp-track";
    this.hpBar = document.createElement("div");
    this.hpBar.className = "hud-hp-bar";
    hpTrack.append(this.hpBar);

    hpMain.append(hpRow, hpTrack);
    hpWrap.append(hpFace, hpMain);

    // ---- 武器栏（底部中央 6 格） ----
    const weaponBar = document.createElement("div");
    weaponBar.className = "hud-weaponbar";
    for (const slot of SLOT_ORDER) {
      const cell: HTMLElement = this.createWeaponCell(slot);
      this.weaponCells.push(cell);
      this.weaponCounts.push(cell.querySelector(".hud-weapon-count") as HTMLElement);
      this.lastWeaponCountText.push("");
      weaponBar.append(cell);
    }

    // ---- 弹药（右下，显示当前武器） ----
    const ammoPanel = document.createElement("div");
    ammoPanel.className = "hud-ammo";

    this.ammoTag = document.createElement("div");
    this.ammoTag.className = "hud-ammo-tag";

    const ammoLine = document.createElement("div");
    ammoLine.className = "hud-ammo-line";
    this.ammoText = document.createElement("span");
    this.ammoText.className = "hud-ammo-current";
    this.reserveText = document.createElement("span");
    this.reserveText.className = "hud-ammo-reserve";
    ammoLine.append(this.ammoText, this.reserveText);

    this.reloadBar = document.createElement("div");
    this.reloadBar.className = "hud-ammo-reload";
    ammoPanel.append(this.ammoTag, ammoLine, this.reloadBar);

    // 死亡遮罩
    this.deathOverlay = document.createElement("div");
    this.deathOverlay.id = "death-overlay";
    const deathText = document.createElement("p");
    deathText.textContent = "你被击杀了";
    this.deathCountdown = document.createElement("p");
    this.deathCountdown.className = "death-countdown";
    this.deathOverlay.append(deathText, this.deathCountdown);

    // 闪光致盲遮罩
    this.flashOverlay = document.createElement("div");
    this.flashOverlay.id = "flash-overlay";

    // 受击遮罩 + 方向指示
    this.damageOverlay = document.createElement("div");
    this.damageOverlay.id = "damage-overlay";
    this.damageArc = document.createElement("div");
    this.damageArc.id = "damage-arc";

    // 指针锁定引导（Esc 后出现）：战斗提示 + 设置面板
    this.lockOverlay = document.createElement("div");
    this.lockOverlay.id = "lock-overlay";
    const lockPanel = document.createElement("div");
    lockPanel.className = "lock-panel";
    const lockText = document.createElement("p");
    lockText.textContent = "点击进入战斗";
    lockText.className = "lock-title";
    const lockHint = document.createElement("p");
    lockHint.className = "lock-hint";
    lockHint.textContent = HUD_HINT_TEXT;
    this.lockSettings = document.createElement("div");
    this.lockSettings.id = "lock-settings";
    lockPanel.append(lockText, lockHint, this.lockSettings);
    this.lockOverlay.append(lockPanel);

    this.root.append(
      this.damageOverlay,
      this.crosshair,
      this.hitmarker,
      this.zoneDamage,
      this.niceBanner,
      this.killBanner,
      topBar,
      radarWrap,
      debugStack,
      hpWrap,
      weaponBar,
      ammoPanel,
      this.deathOverlay,
      this.flashOverlay,
      this.damageArc,
      this.lockOverlay,
    );
    container.append(this.root);
  }

  /**
   * 武器栏单格：键盘角标 + 图标（SVG）+ 数量角标。
   *
   * 图标用 SVG 而不是文字：中文单字（刀/雷/闪）在 12px 下几乎无法分辨，
   * 而这个游戏 6 个槽位里有 4 个是投掷物——图标是唯一能一眼区分的信号。
   */
  private createWeaponCell(slot: WeaponSlot): HTMLElement {
    const cell = document.createElement("div");
    cell.className = "hud-weapon";
    cell.dataset.slot = String(slot);
    cell.title = SLOT_LABEL[slot];

    const key = document.createElement("span");
    key.className = "hud-weapon-key";
    key.textContent = SLOT_KEY[slot];

    const icon = document.createElement("span");
    icon.className = "hud-weapon-icon";
    icon.setAttribute("role", "img");
    icon.setAttribute("aria-label", SLOT_LABEL[slot]);
    icon.innerHTML = WEAPON_ICONS[slot] ?? "";

    const count = document.createElement("span");
    count.className = "hud-weapon-count";
    count.textContent = "—";

    cell.append(key, icon, count);
    return cell;
  }

  public setLockOverlayVisible(visible: boolean): void {
    this.lockOverlay.classList.toggle("visible", visible);
  }

  /** 指针锁定引导遮罩（Game 需要在其上监听点击来请求锁定）。 */
  public get lockOverlayElement(): HTMLElement {
    return this.lockOverlay;
  }

  /**
   * 游戏内设置面板的挂载点（Esc 遮罩里）。
   *
   * 与大厅设置共用 `mountSensitivitySlider` 与同一个 `SettingsStore`，
   * 因此在大厅拖动的值进游戏后立刻生效，反之亦然。
   */
  public get settingsContainer(): HTMLElement {
    return this.lockSettings;
  }

  /**
   * 应用准星外观（设置面板 / 大厅滑块改动后立刻调用）。
   *
   * 全部走 CSS 变量：只改 5 个自定义属性 + 2 个类名，不重建 DOM、不触发整棵子树重排，
   * 所以拖动滑块时每一帧都能安全调用。
   */
  public setCrosshair(settings: CrosshairSettings): void {
    this.crosshairSettings = { ...settings };
    const style = this.crosshair.style;
    style.setProperty("--xh-color", settings.color);
    style.setProperty("--xh-len", `${settings.length}px`);
    style.setProperty("--xh-thick", `${settings.thickness}px`);
    style.setProperty("--xh-gap", `${settings.gap}px`);
    this.crosshair.classList.toggle("has-dot", settings.dot);
    this.crosshair.classList.toggle("outline", settings.outline);
    // 间距/动态开关变化后要强制重算一次 --spread，否则要等下一次扩散值变化才生效
    this.lastSpread = -1;
  }

  /**
   * 把完整玩家状态交给雷达（位置、朝向、队伍、存活）。
   *
   * 与 {@link setPlayers} 分开：击杀面板只需要行数据，雷达需要每帧的连续位置，
   * 混成一个接口会让两边的字段需求互相绑架。
   */
  public setRadarPlayers(players: readonly PlayerState[], selfId: string): void {
    this.radarPlayers = players;
    this.radarSelfId = selfId;
  }

  public setPlayers(players: readonly HudPlayerRow[], selfId: string): void {
    this.playerList.replaceChildren();
    for (const player of players) {
      const row = document.createElement("div");
      row.className = "hud-player-row";
      if (player.sessionId === selfId) {
        row.classList.add("self");
      }
      if (!player.alive) {
        row.classList.add("dead");
      }
      const name = player.sessionId === selfId ? `${player.displayName}（我）` : player.displayName;
      row.textContent = `${name}  ${player.kills}杀/${player.deaths}死`;
      this.playerList.append(row);
    }
  }

  /** 击杀播报：保留最近 4 条，每条 5 秒后自动消失。 */
  public pushKillFeed(text: string): void {
    const item = document.createElement("div");
    item.className = "hud-killfeed-item";
    item.textContent = text;
    this.killFeed.prepend(item);
    while (this.killFeed.childElementCount > 4) {
      this.killFeed.lastElementChild?.remove();
    }
    window.setTimeout(() => item.remove(), 5000);
  }

  /** 屏幕中央的击杀横幅（自己击杀时更醒目）。 */
  public showKillBanner(text: string): void {
    window.clearTimeout(this.killBannerTimer);
    this.killBanner.textContent = text;
    this.killBanner.classList.add("visible");
    this.killBannerTimer = window.setTimeout(() => {
      this.killBanner.classList.remove("visible");
    }, 1200);
  }

  /**
   * 爆头击杀奖励横幅（金色 NICE!）。
   *
   * 独立于 {@link showKillBanner}：两者同时出现时，普通横幅说"杀了谁"，
   * 这条说"这一枪值得炫耀"。约 1.5 秒后淡出，不与下一杀叠加。
   */
  public showNiceBanner(text: string): void {
    window.clearTimeout(this.niceBannerTimer);
    this.niceBanner.textContent = text;
    this.niceBanner.classList.remove("visible");
    // 强制回流：连续爆头时也要重新播一次放大动画
    void this.niceBanner.offsetWidth;
    this.niceBanner.classList.add("visible");
    this.niceBannerTimer = window.setTimeout(() => {
      this.niceBanner.classList.remove("visible");
    }, 1500);
  }

  /**
   * 命中反馈（三级）：
   *   body = 白色小 ✕（140ms）
   *   head = 红色大 ✕ + 更长的停留（220ms）—— 爆头必须有"手感差异"
   *   kill = 红色大 ✕ 放大 1.6 倍（320ms），由击杀广播驱动
   */
  public flashHitmarker(kind: HitmarkerKind = "body"): void {
    window.clearTimeout(this.hitmarkerTimer);
    this.hitmarker.classList.remove("visible", "hitmarker-head", "hitmarker-kill");
    // 强制回流，让同一种 kind 连续命中也能重新触发 CSS 过渡
    void this.hitmarker.offsetWidth;
    if (kind === "head") {
      this.hitmarker.classList.add("hitmarker-head");
    } else if (kind === "kill") {
      this.hitmarker.classList.add("hitmarker-kill");
    }
    this.hitmarker.classList.add("visible");
    const durationMs = kind === "kill" ? 320 : kind === "head" ? 220 : 140;
    this.hitmarkerTimer = window.setTimeout(() => {
      this.hitmarker.classList.remove("visible", "hitmarker-head", "hitmarker-kill");
    }, durationMs);
  }

  /**
   * 部位伤害提示：`头部 −100` / `腿部 −18`（只有自己开火命中时才调用）。
   *
   * 数值来自服务端 `SHOT.damage`（权威整数），客户端不重新查表，避免两边口径漂移。
   */
  public showZoneDamage(label: string, damage: number): void {
    window.clearTimeout(this.zoneDamageTimer);
    this.zoneDamage.textContent = `${label} −${Math.round(damage)}`;
    this.zoneDamage.classList.remove("visible");
    void this.zoneDamage.offsetWidth;
    this.zoneDamage.classList.add("visible");
    this.zoneDamageTimer = window.setTimeout(() => {
      this.zoneDamage.classList.remove("visible");
    }, 500);
  }

  /** 闪光致盲：白色遮罩按强度峰值出现，再按时长缓慢消退。 */
  public blind(intensity: number, durationMs: number): void {
    const now = performance.now();
    const peak = Math.min(1, Math.max(0, intensity));
    this.flashPeak = peak;
    this.flashUntil = now + Math.max(300, durationMs);
    this.flashOverlay.style.opacity = String(0.35 + peak * 0.65);
  }

  /** 受击：红色边缘闪烁 + 指向攻击者的弧形指示（angleRadians 为屏幕平面角）。 */
  public showDamage(angleRadians: number): void {
    window.clearTimeout(this.damageTimer);
    this.damageOverlay.classList.add("visible");
    this.damageArc.style.transform = `rotate(${angleRadians}rad)`;
    this.damageArc.classList.add("visible");
    this.damageTimer = window.setTimeout(() => {
      this.damageOverlay.classList.remove("visible");
      this.damageArc.classList.remove("visible");
    }, 700);
  }

  /** 某个槽位当前显示的数量文本（枪 = `弹匣/备弹`，投掷物 = 剩余数，刀 = `—`）。 */
  private static weaponCountTextOf(snapshot: HudSnapshot, slot: WeaponSlot): string {
    if (slot === WEAPON_SLOTS.RIFLE) {
      return `${snapshot.ammo}/${snapshot.reserve}`;
    }
    if (slot === WEAPON_SLOTS.PISTOL) {
      return `${snapshot.pistolAmmo}/${snapshot.pistolReserve}`;
    }
    if (slot === WEAPON_SLOTS.KNIFE) {
      return "—";
    }
    if (slot === WEAPON_SLOTS.FRAG) {
      return String(snapshot.frags);
    }
    if (slot === WEAPON_SLOTS.FLASH) {
      return String(snapshot.flashes);
    }
    return String(snapshot.smokes);
  }

  /** 投掷物槽当前是否有货（枪 / 刀恒为 true）。 */
  private static slotHasStock(snapshot: HudSnapshot, slot: WeaponSlot): boolean {
    const type = throwableTypeOfSlot(slot);
    if (type === null) {
      return true;
    }
    if (type === THROWABLE_TYPES.FRAG) {
      return snapshot.frags > 0;
    }
    return type === THROWABLE_TYPES.FLASH ? snapshot.flashes > 0 : snapshot.smokes > 0;
  }

  public update(snapshot: HudSnapshot): void {
    this.minimap.update(this.radarPlayers, this.radarSelfId, performance.now());
    // 区域名写进雷达下方的胶囊，不画在圆盘里——圆盘内每多一行字就少一分可读性
    const zone: string = this.minimap.currentZoneLabel;
    if (this.radarZone.textContent !== zone) {
      this.radarZone.textContent = zone;
    }

    const { x, y, z } = snapshot.position;
    this.positionLine.textContent = `${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)}`;
    this.statusLine.textContent = `在线 ${snapshot.playerCount} · 远端 ${snapshot.remoteCount}`;

    const hp = Math.max(0, Math.round(snapshot.selfHp));
    this.hpText.textContent = String(hp);
    this.hpBar.style.width = `${hp}%`;
    this.hpBar.classList.toggle("low", hp <= 30);
    this.root.classList.toggle("low-hp", hp <= 30 && snapshot.selfAlive);

    // ---- 武器栏：数量 + 当前槽高亮（切换瞬间 120ms 脉冲）----
    for (let slot = 0; slot < WEAPON_CELL_COUNT; slot += 1) {
      const typed: WeaponSlot = slot as WeaponSlot;
      const text: string = Hud.weaponCountTextOf(snapshot, typed);
      if (this.lastWeaponCountText[slot] !== text) {
        this.lastWeaponCountText[slot] = text;
        (this.weaponCounts[slot] as HTMLElement).textContent = text;
      }
      const cell = this.weaponCells[slot] as HTMLElement;
      cell.classList.toggle("active", slot === snapshot.weaponSlot);
      cell.classList.toggle("empty", !Hud.slotHasStock(snapshot, typed));
    }
    if (snapshot.weaponSlot !== this.lastWeaponSlot) {
      this.lastWeaponSlot = snapshot.weaponSlot;
      this.pulseWeaponCell(snapshot.weaponSlot);
    }

    // ---- 右下弹药面板：跟随当前武器 ----
    const current: WeaponSlot = (snapshot.weaponSlot as WeaponSlot) ?? WEAPON_SLOTS.RIFLE;
    const weaponName: string = SLOT_LABEL[current] ?? "";
    if (this.ammoTag.textContent !== weaponName) {
      this.ammoTag.textContent = weaponName;
    }
    if (current === WEAPON_SLOTS.RIFLE || current === WEAPON_SLOTS.PISTOL) {
      const mag: number = current === WEAPON_SLOTS.PISTOL ? snapshot.pistolAmmo : snapshot.ammo;
      const reserve: number = current === WEAPON_SLOTS.PISTOL ? snapshot.pistolReserve : snapshot.reserve;
      this.ammoText.textContent = String(mag);
      this.reserveText.textContent = `/ ${reserve}`;
      this.ammoText.classList.toggle("empty", mag <= 0);
      this.reloadBar.style.width = `${Math.round(snapshot.reloadProgress * 100)}%`;
      this.reloadBar.classList.toggle("active", snapshot.reloadProgress > 0);
    } else if (current === WEAPON_SLOTS.KNIFE) {
      this.ammoText.textContent = "—";
      this.reserveText.textContent = "近战";
      this.ammoText.classList.remove("empty");
      this.reloadBar.style.width = "0";
      this.reloadBar.classList.remove("active");
    } else {
      const text: string = Hud.weaponCountTextOf(snapshot, current);
      this.ammoText.textContent = text;
      this.reserveText.textContent = SLOT_LABEL[current] ?? "";
      this.ammoText.classList.toggle("empty", text === "0");
      this.reloadBar.style.width = "0";
      this.reloadBar.classList.remove("active");
    }

    // 动态准星扩散（只在不同值时写样式，避免每帧重排）
    //
    // `snapshot.spread` 是**含静态间距的总开口**（`max(gap, 动态值)`，见
    // `Game#crosshairSpreadPx`）。CSS 里 `--xh-gap` 已经是 gap 了，
    // 所以这里只传"超出 gap 的部分"，否则会写成 gap + 总开口 = gap 被算两遍。
    const dynamicSpread: number = this.crosshairSettings.dynamic
      ? Math.max(0, Math.round(snapshot.spread) - this.crosshairSettings.gap)
      : 0;
    if (dynamicSpread !== this.lastSpread) {
      this.lastSpread = dynamicSpread;
      this.crosshair.style.setProperty("--spread", `${dynamicSpread}px`);
    }

    this.deathOverlay.classList.toggle("visible", !snapshot.selfAlive);
    if (!snapshot.selfAlive) {
      const remainMs = Math.max(0, snapshot.selfRespawnAt - Date.now());
      this.deathCountdown.textContent = `${(remainMs / 1000).toFixed(1)} 秒后重生`;
    }

    // 闪光遮罩衰减（指数回落到 0）
    if (this.flashPeak > 0) {
      const remain = this.flashUntil - performance.now();
      if (remain <= 0) {
        this.flashPeak = 0;
        this.flashOverlay.style.opacity = "0";
      } else {
        const ratio = Math.min(1, remain / 1600);
        this.flashOverlay.style.opacity = String((0.35 + this.flashPeak * 0.65) * ratio);
      }
    }
  }

  /** 切槽脉冲：120ms 的 scale(1.12) → 1（先移除再回流，连续切枪也能重播）。 */
  private pulseWeaponCell(slot: number): void {
    const cell = this.weaponCells[slot];
    if (cell === undefined) {
      return;
    }
    window.clearTimeout(this.weaponPulseTimer);
    cell.classList.remove("pulse");
    void cell.offsetWidth;
    cell.classList.add("pulse");
    this.weaponPulseTimer = window.setTimeout(() => {
      cell.classList.remove("pulse");
    }, 140);
  }

  public dispose(): void {
    window.clearTimeout(this.hitmarkerTimer);
    window.clearTimeout(this.zoneDamageTimer);
    window.clearTimeout(this.killBannerTimer);
    window.clearTimeout(this.niceBannerTimer);
    window.clearTimeout(this.damageTimer);
    window.clearTimeout(this.weaponPulseTimer);
    this.root.remove();
  }
}
