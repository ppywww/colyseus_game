/**
 * HUD：准星、命中标记、血量条、K/D 计分板、击杀播报、死亡遮罩、指针锁定引导。
 * DOM 实现，风格保持深色半透明面板。
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
}

export class Hud {
  private readonly root: HTMLElement;
  private readonly crosshair: HTMLElement;
  private readonly hitmarker: HTMLElement;
  private readonly statusLine: HTMLElement;
  private readonly playerList: HTMLElement;
  private readonly killFeed: HTMLElement;
  private readonly lockOverlay: HTMLElement;
  private readonly positionLine: HTMLElement;
  private readonly hpBar: HTMLElement;
  private readonly hpText: HTMLElement;
  private readonly deathOverlay: HTMLElement;
  private readonly deathCountdown: HTMLElement;
  private hitmarkerTimer = 0;

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

    const bottomBar = document.createElement("div");
    bottomBar.className = "hud-bottom";
    this.positionLine = document.createElement("div");
    this.positionLine.className = "hud-position";
    const hint = document.createElement("div");
    hint.className = "hud-hint";
    hint.textContent = "WASD 移动 · Shift 冲刺 · 空格 跳跃 · 左键 开火 · Esc 释放鼠标";
    bottomBar.append(this.positionLine, hint);

    // 血量条
    const hpWrap = document.createElement("div");
    hpWrap.className = "hud-hp";
    this.hpBar = document.createElement("div");
    this.hpBar.className = "hud-hp-bar";
    this.hpText = document.createElement("div");
    this.hpText.className = "hud-hp-text";
    hpWrap.append(this.hpBar, this.hpText);

    // 死亡遮罩
    this.deathOverlay = document.createElement("div");
    this.deathOverlay.id = "death-overlay";
    const deathText = document.createElement("p");
    deathText.textContent = "你被击杀了";
    this.deathCountdown = document.createElement("p");
    this.deathCountdown.className = "death-countdown";
    this.deathOverlay.append(deathText, this.deathCountdown);

    this.lockOverlay = document.createElement("div");
    this.lockOverlay.id = "lock-overlay";
    const lockText = document.createElement("p");
    lockText.textContent = "点击进入战斗";
    this.lockOverlay.append(lockText);

    this.root.append(
      this.crosshair,
      this.hitmarker,
      topBar,
      hpWrap,
      bottomBar,
      this.deathOverlay,
      this.lockOverlay,
    );
    container.append(this.root);
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

  /** 命中反馈：准星旁短暂显示 ✕。 */
  public flashHitmarker(): void {
    window.clearTimeout(this.hitmarkerTimer);
    this.hitmarker.classList.add("visible");
    this.hitmarkerTimer = window.setTimeout(() => {
      this.hitmarker.classList.remove("visible");
    }, 140);
  }

  public update(snapshot: HudSnapshot): void {
    const { x, y, z } = snapshot.position;
    this.positionLine.textContent = `位置 (${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)})`;
    this.statusLine.textContent = `房间在线 ${snapshot.playerCount} 人 · 远端渲染 ${snapshot.remoteCount} 人`;

    const hp = Math.max(0, Math.round(snapshot.selfHp));
    this.hpText.textContent = `HP ${hp}`;
    this.hpBar.style.width = `${hp}%`;
    this.hpBar.classList.toggle("low", hp <= 30);

    this.deathOverlay.classList.toggle("visible", !snapshot.selfAlive);
    if (!snapshot.selfAlive) {
      const remainMs = Math.max(0, snapshot.selfRespawnAt - Date.now());
      this.deathCountdown.textContent = `${(remainMs / 1000).toFixed(1)} 秒后重生`;
    }
  }

  public dispose(): void {
    window.clearTimeout(this.hitmarkerTimer);
    this.root.remove();
  }
}
