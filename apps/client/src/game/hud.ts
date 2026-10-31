/**
 * HUD：准星、状态栏、玩家列表、操作提示、指针锁定引导。
 * DOM 实现，风格保持深色半透明面板。
 */

export interface HudSnapshot {
  position: { x: number; y: number; z: number };
  playerCount: number;
  remoteCount: number;
}

export class Hud {
  private readonly root: HTMLElement;
  private readonly crosshair: HTMLElement;
  private readonly statusLine: HTMLElement;
  private readonly playerList: HTMLElement;
  private readonly lockOverlay: HTMLElement;
  private readonly positionLine: HTMLElement;

  public constructor(container: HTMLElement) {
    this.root = document.createElement("div");
    this.root.id = "hud";

    this.crosshair = document.createElement("div");
    this.crosshair.id = "crosshair";
    this.crosshair.innerHTML = "<span></span><span></span><span></span><span></span>";

    const topBar = document.createElement("div");
    topBar.className = "hud-top";

    this.statusLine = document.createElement("div");
    this.statusLine.className = "hud-status";

    this.playerList = document.createElement("div");
    this.playerList.className = "hud-players";

    topBar.append(this.statusLine, this.playerList);

    const bottomBar = document.createElement("div");
    bottomBar.className = "hud-bottom";
    this.positionLine = document.createElement("div");
    this.positionLine.className = "hud-position";
    const hint = document.createElement("div");
    hint.className = "hud-hint";
    hint.textContent = "WASD 移动 · Shift 冲刺 · 空格 跳跃 · Esc 释放鼠标";
    bottomBar.append(this.positionLine, hint);

    this.lockOverlay = document.createElement("div");
    this.lockOverlay.id = "lock-overlay";
    const lockText = document.createElement("p");
    lockText.textContent = "点击进入战斗";
    this.lockOverlay.append(lockText);

    this.root.append(this.crosshair, topBar, bottomBar, this.lockOverlay);
    container.append(this.root);
  }

  public setLockOverlayVisible(visible: boolean): void {
    this.lockOverlay.classList.toggle("visible", visible);
  }

  public setPlayers(players: readonly { displayName: string; sessionId: string }[], selfId: string): void {
    this.playerList.replaceChildren();
    for (const player of players) {
      const row = document.createElement("div");
      row.className = "hud-player-row";
      if (player.sessionId === selfId) {
        row.classList.add("self");
        row.textContent = `${player.displayName}（我）`;
      } else {
        row.textContent = player.displayName;
      }
      this.playerList.append(row);
    }
  }

  public update(snapshot: HudSnapshot): void {
    const { x, y, z } = snapshot.position;
    this.positionLine.textContent = `位置 (${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)})`;
    this.statusLine.textContent = `房间在线 ${snapshot.playerCount} 人 · 远端渲染 ${snapshot.remoteCount} 人`;
  }

  public dispose(): void {
    this.root.remove();
  }
}
