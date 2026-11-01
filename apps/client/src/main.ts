import {
  DEFAULT_SERVER_PORT,
  PROTOCOL_VERSION,
} from "@colyseus-fps/shared";

import { Game } from "./game/game.js";
import { LobbyConnection } from "./net/connection.js";
import type { PlayerState } from "./net/types.js";
import "./style.css";

const defaultServerUrl: string = import.meta.env.VITE_COLYSEUS_URL ?? `ws://localhost:${DEFAULT_SERVER_PORT}`;

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`缺少页面元素 #${id}`);
  }
  return element as T;
}

const lobby = requiredElement<HTMLElement>("lobby");
const gameContainer = requiredElement<HTMLElement>("game-container");
const serverUrlInput = requiredElement<HTMLInputElement>("server-url");
const playerNameInput = requiredElement<HTMLInputElement>("player-name");
const joinButton = requiredElement<HTMLButtonElement>("join-button");
const statusBadge = requiredElement<HTMLElement>("join-status");
const protocolVersionElement = requiredElement<HTMLElement>("protocol-version");

let connection: LobbyConnection | null = null;
let game: Game | null = null;
/** 最新一次房间状态快照，供出生点查询与游戏初始化使用。 */
let latestPlayers: readonly PlayerState[] = [];

protocolVersionElement.textContent = String(PROTOCOL_VERSION);
serverUrlInput.value = defaultServerUrl;
playerNameInput.value = `玩家-${Math.floor(Math.random() * 900 + 100)}`;

function setStatus(text: string, busy: boolean): void {
  statusBadge.textContent = text;
  statusBadge.classList.toggle("busy", busy);
}

function returnToLobby(message: string): void {
  game?.dispose();
  game = null;
  connection = null;
  latestPlayers = [];
  lobby.classList.remove("hidden");
  gameContainer.classList.add("hidden");
  joinButton.disabled = false;
  setStatus(message, false);
  document.exitPointerLock?.();
}

/** 加入后从房间状态读取自己的出生点（首个状态补丁必达）。 */
function waitForSelfSpawn(selfId: string): Promise<{ x: number; y: number; z: number }> {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const poll = (): void => {
      const self = latestPlayers.find((player) => player.sessionId === selfId);
      if (self) {
        resolve({ x: self.x, y: self.y, z: self.z });
      } else if (performance.now() - startedAt > 8000) {
        reject(new Error("等待出生点超时"));
      } else {
        window.setTimeout(poll, 30);
      }
    };
    poll();
  });
}

joinButton.addEventListener("click", () => {
  void (async () => {
    joinButton.disabled = true;
    setStatus("连接中…", true);

    connection = new LobbyConnection(serverUrlInput.value, {
      onPlayers(players: PlayerState[]): void {
        latestPlayers = players;
        game?.onPlayersChanged(players);
      },
      onPong() {
        // S2 不再需要手动 ping，保留通道供调试
      },
      onLeave(code: number): void {
        returnToLobby(`连接已关闭（代码 ${code}）`);
      },
    });

    try {
      await connection.join(playerNameInput.value);
      const selfId = connection.sessionId;
      if (selfId === null) {
        throw new Error("会话未建立");
      }

      const spawn = await waitForSelfSpawn(selfId);

      // 必须先显示容器再构造 Game：容器带 display:none 时 clientWidth/Height 为 0，
      // 会导致 canvas 初始尺寸为 0，点击/指针锁定全部失效。
      lobby.classList.add("hidden");
      gameContainer.classList.remove("hidden");

      game = new Game(gameContainer, connection, selfId, spawn);
      game.start();
      game.onPlayersChanged(latestPlayers);
    } catch (error: unknown) {
      game?.dispose();
      game = null;
      gameContainer.classList.add("hidden");
      lobby.classList.remove("hidden");
      connection = null;
      joinButton.disabled = false;
      setStatus(error instanceof Error ? `连接失败：${error.message}` : "连接失败", false);
    }
  })();
});
