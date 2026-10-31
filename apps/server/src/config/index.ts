import { z } from "zod";

import {
  DEFAULT_ROOM_NAME,
  DEFAULT_SERVER_PORT,
  MAX_MESSAGES_PER_SECOND,
  MAX_PLAYERS_PER_ROOM,
} from "@colyseus-fps/shared";

const nodeEnvSchema = z.enum(["development", "test", "production"]);
const logLevelSchema = z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]);

const serverConfigSchema = z.object({
  NODE_ENV: nodeEnvSchema.default("development"),
  SERVER_HOST: z.string().trim().min(1).default("0.0.0.0"),
  SERVER_PORT: z.coerce.number().int().min(0).max(65535).default(DEFAULT_SERVER_PORT),
  ROOM_NAME: z.string().trim().min(1).max(64).default(DEFAULT_ROOM_NAME),
  ROOM_MAX_CLIENTS: z.coerce.number().int().min(2).max(64).default(MAX_PLAYERS_PER_ROOM),
  LOG_LEVEL: logLevelSchema.default("info"),
  AUDIT_DB_PATH: z.string().trim().min(1).default("data/audit.db"),
  METRICS_PORT: z.coerce.number().int().min(0).max(65535).default(9464),
  RATE_LIMIT_PER_SECOND: z.coerce.number().int().positive().default(MAX_MESSAGES_PER_SECOND),
  MAX_MESSAGE_BYTES: z.coerce.number().int().positive().max(64 * 1024).default(2048),
});

export type ServerConfig = z.infer<typeof serverConfigSchema>;

/** 从指定环境变量来源加载并校验服务端配置。 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return serverConfigSchema.parse(env);
}
