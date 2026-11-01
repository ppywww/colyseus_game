/**
 * HUD：准星（动态扩散）、命中标记、血量、弹药与换弹进度、道具栏、
 * 击杀播报与击杀横幅、死亡遮罩、闪光致盲遮罩、受击方向提示、指针锁定引导。
 *
 * 全部用 DOM 实现，避免额外渲染库；每帧只更新变化的文本/样式。
 */

export interface HudPlayerRow {
  sessionId: string;
  displayName: string;
  kills: number;
  deaths: number;
  alive: boolean;
}

export interface HudSnapshot {
  position: { x: number; y: number; z: number };
  playerCount: number;
  remoteCount: number;
  selfHp: number;
  selfAlive: boolean;
  selfRespawnAt: number;
  ammo: number;
  reserve: number;
  reloadProgress: number;
  frags: number;
  flashes: number;
  smokes: number;
  spread: number;
}

export class Hud {
  private readonly root: HTMLElement;
  private readonly crosshair: HTMLElement;
  private readonly hitmarker: HTMLElement;
  private readonly statusLine: HTMLElement;
  private readonly playerList: HTMLElement;
  private readonly killFeed: HTMLElement;
  private readonly killBanner: HTMLElement;
  private readonly lockOverlay: HTMLElement;
  private readonly positionLine: HTMLElement;
  private readonly hpBar: HTMLElement;
  private readonly hpText: HTMLElement;
  private readonly ammoText: HTMLElement;
  private readonly reserveText: HTMLElement;
  private readonly reloadBar: HTMLElement;
  private readonly slotFrag: HTMLElement;
  private readonly slotFlash: HTMLElement;
  private readonly slotSmoke: HTMLElement;
  private readonly deathOverlay: HTMLElement;
  private readonly deathCountdown: HTMLElement;
  private readonly flashOverlay: HTMLElement;
  private readonly damageOverlay: HTMLElement;
  private readonly damageArc: HTMLElement;
  private hitmarkerTimer = 0;
  private killBannerTimer = 0;
  private damageTimer = 0;
  private flashUntil = 0;
  private flashPeak = 0;
  private lastSpread = -1;

  public constructor(container: HTMLElement) {
    this.root = document.createElement("div");
    this.root.id = "hud";

    this.crosshair = document.createElement("div");
    this.crosshair.id = "crosshair";
    this.crosshair.innerHTML = "<span></span><span></span><span></span><span></span>";

    this.hitmarker = document.createElement("div");
    this.hitmarker.id = "hitmarker";
    this.hitmarker.textContent = "✕";

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
    hint.textContent =
      "WASD 移动 · Shift 冲刺 · 空格 跳跃 · 左键 开火 · R 换弹 · G 手雷 · F 闪光 · V 烟雾 · Esc 释放鼠标";
    bottomBar.append(this.positionLine, hint);

    // 血量
    const hpWrap = document.createElement("div");
    hpWrap.className = "hud-hp";
    this.hpBar = document.createElement("div");
    this.hpBar.className = "hud-hp-bar";
    this.hpText = document.createElement("div");
    this.hpText.className = "hud-hp-text";
    hpWrap.append(this.hpBar, this.hpText);

    // 道具栏
    const slots = document.createElement("div");
    slots.className = "hud-slots";
    this.slotFrag = this.createSlot("G", "手雷", "frag");
    this.slotFlash = this.createSlot("F", "闪光", "flash");
    this.slotSmoke = this.createSlot("V", "烟雾", "smoke");
    slots.append(this.slotFrag, this.slotFlash, this.slotSmoke);

    // 弹药
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

    this.lockOverlay = document.createElement("div");
    this.lockOverlay.id = "lock-overlay";
    const lockText = document.createElement("p");
    lockText.textContent = "点击进入战斗";
    this.lockOverlay.append(lockText);

    this.root.append(
      this.damageOverlay,
      this.crosshair,
      this.hitmarker,
      this.killBanner,
      topBar,
      hpWrap,
      slots,
      ammoPanel,
      bottomBar,
      this.deathOverlay,
      this.flashOverlay,
      this.damageArc,
      this.lockOverlay,
    );
    container.append(this.root);
  }

  private createSlot(key: string, label: string, kind: string): HTMLElement {
    const slot = document.createElement("div");
    slot.className = `hud-slot hud-slot-${kind}`;
    const keyBadge = document.createElement("span");
    keyBadge.className = "hud-slot-key";
    keyBadge.textContent = key;
    const name = document.createElement("span");
    name.className = "hud-slot-label";
    name.textContent = label;
    const count = document.createElement("span");
    count.className = "hud-slot-count";
    count.textContent = "0";
    slot.append(keyBadge, name, count);
    return slot;
  }

  public setLockOverlayVisible(visible: boolean): void {
    this.lockOverlay.classList.toggle("visible", visible);
  }

  /** 指针锁定引导遮罩（Game 需要在其上监听点击来请求锁定）。 */
  public get lockOverlayElement(): HTMLElement {
    return this.lockOverlay;
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

  /** 命中反馈：准星旁短暂显示 ✕。 */
  public flashHitmarker(): void {
    window.clearTimeout(this.hitmarkerTimer);
    this.hitmarker.classList.add("visible");
    this.hitmarkerTimer = window.setTimeout(() => {
      this.hitmarker.classList.remove("visible");
    }, 140);
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

  public update(snapshot: HudSnapshot): void {
    const { x, y, z } = snapshot.position;
    this.positionLine.textContent = `位置 (${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)})`;
    this.statusLine.textContent = `房间在线 ${snapshot.playerCount} 人 · 远端渲染 ${snapshot.remoteCount} 人`;

    const hp = Math.max(0, Math.round(snapshot.selfHp));
    this.hpText.textContent = `HP ${hp}`;
    this.hpBar.style.width = `${hp}%`;
    this.hpBar.classList.toggle("low", hp <= 30);
    this.root.classList.toggle("low-hp", hp <= 30 && snapshot.selfAlive);

    this.ammoText.textContent = String(snapshot.ammo);
    this.reserveText.textContent = `/ ${snapshot.reserve}`;
    this.ammoText.classList.toggle("empty", snapshot.ammo <= 0);
    this.reloadBar.style.width = `${Math.round(snapshot.reloadProgress * 100)}%`;
    this.reloadBar.classList.toggle("active", snapshot.reloadProgress > 0);

    this.slotFrag.querySelector(".hud-slot-count")!.textContent = String(snapshot.frags);
    this.slotFlash.querySelector(".hud-slot-count")!.textContent = String(snapshot.flashes);
    this.slotSmoke.querySelector(".hud-slot-count")!.textContent = String(snapshot.smokes);
    this.slotFrag.classList.toggle("empty", snapshot.frags <= 0);
    this.slotFlash.classList.toggle("empty", snapshot.flashes <= 0);
    this.slotSmoke.classList.toggle("empty", snapshot.smokes <= 0);

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

  public dispose(): void {
    window.clearTimeout(this.hitmarkerTimer);
    window.clearTimeout(this.killBannerTimer);
    window.clearTimeout(this.damageTimer);
    this.root.remove();
  }
}
