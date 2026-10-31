import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";

import { loadConfig, type ServerConfig } from "./config/index.js";
import { FPSBattleRoom } from "./rooms/fps-battle-room.js";
import { createLogger } from "./utils/logger.js";

const config: ServerConfig = loadConfig();
const logger = createLogger(config.LOG_LEVEL);

const gameServer = new Server({
  transport: new WebSocketTransport({ maxPayload: config.MAX_MESSAGE_BYTES }),
  greet: config.NODE_ENV !== "test",
  gracefullyShutdown: false,
});

gameServer.define(config.ROOM_NAME, FPSBattleRoom, {
  maxClients: config.ROOM_MAX_CLIENTS,
  logLevel: config.LOG_LEVEL,
});

await gameServer.listen(config.SERVER_PORT, config.SERVER_HOST);

logger.info(
  {
    host: config.SERVER_HOST,
    port: config.SERVER_PORT,
    roomName: config.ROOM_NAME,
    maxClients: config.ROOM_MAX_CLIENTS,
  },
  "Colyseus 服务端已启动",
);

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  logger.info({ signal }, "收到退出信号，正在关闭服务端");
  await gameServer.gracefullyShutdown(false);
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});
