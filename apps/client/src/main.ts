import {
  DEFAULT_SERVER_PORT,
  PROTOCOL_VERSION,
} from "@colyseus-fps/shared";

import { Game } from "./game/game.js";
import { LobbyConnection } from "./net/connection.js";
import type { PlayerState } from "./net/types.js";
import { loadCharacter, mountCharacterPicker } from "./ui/character.js";
import { getSettingsStore, mountSettingsPanel } from "./ui/settings.js";
import type {
  CharacterId,
  DamageTakenMessage,
  ExplosionMessage,
  FlashEffectMessage,
  GrenadeLaunchedMessage,
  KillMessage,
  KnifeResultMessage,
  ShotMessage,
  SmokeCloudView,
} from "@colyseus-fps/shared";
import "./style.css";

/**
 * 默认服务端地址的推导顺序：
 * 1. 构建时显式注入的 VITE_COLYSEUS_URL 优先（可指向任意独立部署的服务端）；
 * 2. 本地开发（localhost / 127.0.0.1）直连本机服务端端口；
 * 3. 线上部署（页面由 nginx 托管）走同源 /fps-ws 反向代理，自动跟随 http/https 切换 ws/wss，
 *    这样换域名、加 HTTPS、迁移服务器都不需要重新构建前端。
 */
function resolveDefaultServerUrl(): string {
  const injected: string | undefined = import.meta.env.VITE_COLYSEUS_URL;
  if (injected !== undefined && injected.trim().length > 0) {
    return injected.trim();
  }

  const { protocol, hostname, host } = window.location;
  const isLocal: boolean = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  if (isLocal) {
    return `ws://localhost:${DEFAULT_SERVER_PORT}`;
  }

  const wsProtocol: string = protocol === "https:" ? "wss:" : "ws:";
  return `${wsProtocol}//${host}/fps-ws`;
}

const defaultServerUrl: string = resolveDefaultServerUrl();

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

// 大厅「设置」折叠区：与游戏内 Esc 遮罩共用同一个组件与同一个 SettingsStore。
// 只挂一次，页面生命周期内一直有效（折叠区关掉也不会卸载，值不会丢）。
mountSettingsPanel(requiredElement<HTMLElement>("settings-body"), getSettingsStore());

/**
 * 大厅阵容条：四张可选卡片，头像是 `ui/art.ts` 里的同一份 SVG，
 * 和 HUD 生命面板、第三人称模型完全一致（选谁就变成谁）。
 *
 * 选择存在 localStorage，进房前再随 join 选项上送，由服务端写进 `Player.character`
 * 同步给所有人——所以"我选了 Tom、你眼里我是 Jerry"这件事不会发生。
 */
let selectedCharacter: CharacterId = loadCharacter();

const rosterHost = document.getElementById("roster-list");
if (rosterHost !== null) {
  mountCharacterPicker(rosterHost, selectedCharacter, (id: CharacterId) => {
    selectedCharacter = id;
  });
}

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
      onShot(message: ShotMessage): void {
        game?.handleShot(message);
      },
      onKill(message: KillMessage): void {
        game?.handleKill(message);
      },
      onKnifeResult(message: KnifeResultMessage): void {
        game?.handleKnifeResult(message);
      },
      onClouds(clouds: SmokeCloudView[]): void {
        game?.handleClouds(clouds);
      },
      onGrenade(message: GrenadeLaunchedMessage): void {
        game?.handleGrenade(message);
      },
      onExplosion(message: ExplosionMessage): void {
        game?.handleExplosion(message);
      },
      onFlash(message: FlashEffectMessage): void {
        game?.handleFlash(message);
      },
      onDamaged(message: DamageTakenMessage): void {
        game?.handleDamaged(message);
      },
      onLeave(code: number): void {
        returnToLobby(`连接已关闭（代码 ${code}）`);
      },
    });

    try {
      await connection.join(playerNameInput.value, selectedCharacter);
      const selfId = connection.sessionId;
      if (selfId === null) {
        throw new Error("会话未建立");
      }

      const spawn = await waitForSelfSpawn(selfId);

      // 必须先显示容器再构造 Game：容器带 display:none 时 clientWidth/Height 为 0，
      // 会导致 canvas 初始尺寸为 0，点击/指针锁定全部失效。
      lobby.classList.add("hidden");
      gameContainer.classList.remove("hidden");

      game = new Game(gameContainer, connection, selfId, spawn, selectedCharacter);
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
