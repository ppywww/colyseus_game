import {
  DEFAULT_SERVER_PORT,
  MESSAGE_TYPES,
  PROTOCOL_VERSION,
  type PongMessage,
} from "@colyseus-fps/shared";

import { LobbyConnection, type ConnectionInfo } from "./net/connection.js";
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

const serverUrlInput = requiredElement<HTMLInputElement>("server-url");
const playerNameInput = requiredElement<HTMLInputElement>("player-name");
const joinButton = requiredElement<HTMLButtonElement>("join-button");
const pingButton = requiredElement<HTMLButtonElement>("ping-button");
const leaveButton = requiredElement<HTMLButtonElement>("leave-button");
const statusBadge = requiredElement<HTMLSpanElement>("status-badge");
const roomIdElement = requiredElement<HTMLElement>("room-id");
const sessionIdElement = requiredElement<HTMLElement>("session-id");
const protocolVersionElement = requiredElement<HTMLElement>("protocol-version");
const playerCountElement = requiredElement<HTMLSpanElement>("player-count");
const playerList = requiredElement<HTMLUListElement>("player-list");
const eventLog = requiredElement<HTMLOListElement>("event-log");

let connection: LobbyConnection | null = null;
let knownPlayerIds = new Set<string>();

serverUrlInput.value = defaultServerUrl;
playerNameInput.value = `玩家-${Math.floor(Math.random() * 900 + 100)}`;
protocolVersionElement.textContent = String(PROTOCOL_VERSION);

function appendLog(message: string): void {
  const item = document.createElement("li");
  const time = document.createElement("time");
  time.dateTime = new Date().toISOString();
  time.textContent = new Date().toLocaleTimeString();
  item.append(time, document.createTextNode(message));
  eventLog.prepend(item);
}

function setStatus(text: string, connected: boolean): void {
  statusBadge.textContent = text;
  statusBadge.classList.toggle("connected", connected);
}

function setConnectedUI(connected: boolean): void {
  joinButton.disabled = connected;
  pingButton.disabled = !connected;
  leaveButton.disabled = !connected;
  serverUrlInput.disabled = connected;
  playerNameInput.disabled = connected;
}

function renderPlayers(players: PlayerState[]): void {
  playerList.replaceChildren();
  playerCountElement.textContent = `${players.length} 人`;

  const nextPlayerIds = new Set(players.map((player) => player.sessionId));
  for (const player of players) {
    if (!knownPlayerIds.has(player.sessionId)) {
      appendLog(`${player.displayName} 加入了房间`);
    }

    const item = document.createElement("li");
    const name = document.createElement("strong");
    const session = document.createElement("span");
    name.textContent = player.displayName;
    session.textContent = player.sessionId;
    item.append(name, session);
    playerList.append(item);
  }

  for (const playerId of knownPlayerIds) {
    if (!nextPlayerIds.has(playerId)) {
      appendLog(`玩家 ${playerId} 离开了房间`);
    }
  }
  knownPlayerIds = nextPlayerIds;
}

function resetRoomInfo(): void {
  roomIdElement.textContent = "—";
  sessionIdElement.textContent = "—";
  playerList.replaceChildren();
  playerCountElement.textContent = "0 人";
  knownPlayerIds = new Set<string>();
}

function handleLeave(code: number): void {
  connection = null;
  setConnectedUI(false);
  setStatus("未连接", false);
  resetRoomInfo();
  appendLog(`连接已关闭（代码 ${code}）`);
}

joinButton.addEventListener("click", () => {
  void (async () => {
    joinButton.disabled = true;
    setStatus("连接中…", false);
    appendLog(`正在连接 ${serverUrlInput.value}`);

    connection = new LobbyConnection(serverUrlInput.value, {
      onPlayers: renderPlayers,
      onPong(message: PongMessage) {
        const latency = Date.now() - message.sentAt;
        appendLog(`${MESSAGE_TYPES.PING}/${MESSAGE_TYPES.PONG} 往返约 ${latency}ms`);
      },
      onLeave: handleLeave,
    });

    try {
      const info: ConnectionInfo = await connection.join(playerNameInput.value);
      roomIdElement.textContent = info.roomId;
      sessionIdElement.textContent = info.sessionId;
      setStatus("已连接", true);
      setConnectedUI(true);
      appendLog("加入房间成功");
    } catch (error: unknown) {
      connection = null;
      joinButton.disabled = false;
      setStatus("连接失败", false);
      appendLog(error instanceof Error ? `连接失败：${error.message}` : "连接失败");
    }
  })();
});

leaveButton.addEventListener("click", () => {
  void (async () => {
    leaveButton.disabled = true;
    try {
      await connection?.leave();
    } finally {
      handleLeave(1000);
    }
  })();
});

pingButton.addEventListener("click", () => {
  try {
    connection?.sendPing();
  } catch (error: unknown) {
    appendLog(error instanceof Error ? error.message : "发送测试消息失败");
  }
});

appendLog("页面已就绪");
