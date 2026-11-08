/**
 * HUD：准星（动态扩散）、命中标记、部位伤害读数、血量、弹药与换弹进度、
 * 6 格武器栏、击杀播报与击杀横幅、死亡遮罩、闪光致盲遮罩、受击方向提示、
 * 指针锁定引导（含设置面板）。
 *
 * 全部用 DOM 实现，避免额外渲染库；每帧只更新变化的文本/样式。
 */

import {
  SLOT_KEY,
  SLOT_LABEL,
  SLOT_ORDER,
  THROWABLE_TYPES,
  WEAPON_SLOTS,
  throwableTypeOfSlot,
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
  "WASD 移动 · Shift 冲刺 · 空格 跳跃 · 左键 开火/投掷/挥刀 · 滚轮/123456 切武器 · R 换弹 · G/F/V 快捷投掷 · Esc 设置";

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
  private readonly lockOverlay: HTMLElement;
  private readonly lockSettings: HTMLElement;
  private readonly positionLine: HTMLElement;
  private readonly hpBar: HTMLElement;
  private readonly hpText: HTMLElement;
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
  private damageTimer = 0;
  private weaponPulseTimer = 0;
  private flashUntil = 0;
  private flashPeak = 0;
  private lastSpread = -1;
  private lastWeaponSlot = -1;

  public constructor(container: HTMLElement) {
    this.root = document.createElement("div");
    this.root.id = "hud";

    this.crosshair = document.createElement("div");
    this.crosshair.id = "crosshair";
    this.crosshair.innerHTML = "<span></span><span></span><span></span><span></span>";

    this.hitmarker = document.createElement("div");
    this.hitmarker.id = "hitmarker";
    this.hitmarker.textContent = "✕";

    // 部位伤害提示：准星下方 40px，显示「头部 −100」500ms
    this.zoneDamage = document.createElement("div");
    this.zoneDamage.id = "zone-damage";

    const topBar = document.createElement("div");
    topBar.className = "hud-top";

    this.statusLine = document.createElement("div");
    this.statusLine.className = "hud-status";

    this.playerList = document.createElement("div");
    this.playerList.className = "hud-players";

    this.killFeed = document.createElement("div");
    this.killFeed.className = "hud-killfeed";

    topBar.append(this.statusLine, this.playerList, this.killFeed);

    this.killBanner = document.createElement("div");
    this.killBanner.id = "kill-banner";

    const bottomBar = document.createElement("div");
    bottomBar.className = "hud-bottom";
    this.positionLine = document.createElement("div");
    this.positionLine.className = "hud-position";
    const hint = document.createElement("div");
    hint.className = "hud-hint";
    hint.textContent = HUD_HINT_TEXT;
    bottomBar.append(this.positionLine, hint);

    // 血量
    const hpWrap = document.createElement("div");
    hpWrap.className = "hud-hp";
    this.hpBar = document.createElement("div");
    this.hpBar.className = "hud-hp-bar";
    this.hpText = document.createElement("div");
    this.hpText.className = "hud-hp-text";
    hpWrap.append(this.hpBar, this.hpText);

    // 武器栏（底部中央 6 格）
    const weaponBar = document.createElement("div");
    weaponBar.className = "hud-weaponbar";
    for (const slot of SLOT_ORDER) {
      const cell: HTMLElement = this.createWeaponCell(slot);
      this.weaponCells.push(cell);
      this.weaponCounts.push(cell.querySelector(".hud-weapon-count") as HTMLElement);
      this.lastWeaponCountText.push("");
      weaponBar.append(cell);
    }

    // 弹药（右下，显示当前武器）
    const ammoPanel = document.createElement("div");
    ammoPanel.className = "hud-ammo";
    this.ammoText = document.createElement("span");
    this.ammoText.className = "hud-ammo-current";
    this.reserveText = document.createElement("span");
    this.reserveText.className = "hud-ammo-reserve";
    this.reloadBar = document.createElement("div");
    this.reloadBar.className = "hud-ammo-reload";
    ammoPanel.append(this.ammoText, this.reserveText, this.reloadBar);

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
      this.killBanner,
      topBar,
      hpWrap,
      weaponBar,
      ammoPanel,
      bottomBar,
      this.deathOverlay,
      this.flashOverlay,
      this.damageArc,
      this.lockOverlay,
    );
    container.append(this.root);
  }

  /** 武器栏单格：键盘角标 + 图标文字 + 数量角标。 */
  private createWeaponCell(slot: WeaponSlot): HTMLElement {
    const cell = document.createElement("div");
    cell.className = "hud-weapon";
    cell.dataset.slot = String(slot);

    const key = document.createElement("span");
    key.className = "hud-weapon-key";
    key.textContent = SLOT_KEY[slot];

    const icon = document.createElement("span");
    icon.className = "hud-weapon-icon";
    icon.textContent = SLOT_LABEL[slot];

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
    const { x, y, z } = snapshot.position;
    this.positionLine.textContent = `位置 (${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)})`;
    this.statusLine.textContent = `房间在线 ${snapshot.playerCount} 人 · 远端渲染 ${snapshot.remoteCount} 人`;

    const hp = Math.max(0, Math.round(snapshot.selfHp));
    this.hpText.textContent = `HP ${hp}`;
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
    const spread = Math.round(snapshot.spread);
    if (spread !== this.lastSpread) {
      this.lastSpread = spread;
      this.crosshair.style.setProperty("--spread", `${spread}px`);
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
    window.clearTimeout(this.damageTimer);
    window.clearTimeout(this.weaponPulseTimer);
    this.root.remove();
  }
}
