import dotenv from "dotenv";
import path from "path";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  TELEGRAM_API_ID: z.coerce.number({
    required_error: "TELEGRAM_API_ID is required. Obtain it from https://my.telegram.org",
  }),
  TELEGRAM_API_HASH: z.string().min(1, "TELEGRAM_API_HASH is required. Obtain it from https://my.telegram.org"),
  TELEGRAM_SESSION: z.string().default(""),
  TARGET_CHANNEL_ID: z.string().default("@my_vpn_channel"),
  SCAN_INTERVAL_MINUTES: z.coerce.number().default(10),
  INITIAL_CHANNEL_SCAN_LIMIT: z.coerce.number().default(30),
  SUBSEQUENT_CHANNEL_SCAN_LIMIT: z.coerce.number().default(50),
  TESTER_CONCURRENCY: z.coerce.number().default(5),
  TESTER_TIMEOUT_MS: z.coerce.number().default(5000),
  TESTER_MODE: z.enum(["xray", "tcp"]).default("xray"),
  TESTER_PING_URL: z.string().url().default("http://cp.cloudflare.com/generate_204"),
  MAX_HEALTHY_LATENCY_MS: z.coerce.number().default(3500),
  MAX_POSTS_PER_CYCLE: z.coerce.number().default(5),
  ALLOWED_CHANNELS: z
    .string()
    .default("")
    .transform((str) => (str ? str.split(",").map((s) => s.trim()).filter(Boolean) : [])),
  EXCLUDED_CHANNELS: z
    .string()
    .default("")
    .transform((str) => (str ? str.split(",").map((s) => s.trim()).filter(Boolean) : [])),
  DATABASE_PATH: z.string().default(path.resolve(process.cwd(), "data/vpn_monitor.sqlite")),
  CUSTOM_CONFIG_REMARKS: z.string().default("@connexy_private"),
  INCLUDE_PING_IN_POST: z
    .union([z.boolean(), z.string()])
    .default(false)
    .transform((val) => {
      if (typeof val === "boolean") return val;
      return val.toLowerCase() === "true" || val === "1";
    }),
  TELEGRAM_BOT_TOKEN: z.string().default(""),
  ADMIN_USER_IDS: z
    .string()
    .default("")
    .transform((str) => (str ? str.split(",").map((s) => s.trim()).filter(Boolean) : [])),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
});

export type Config = z.infer<typeof envSchema>;

let parsedConfig: Config | null = null;

export function getConfig(): Config {
  if (parsedConfig) return parsedConfig;

  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const errors = result.error.errors.map((e) => `[${e.path.join(".")}]: ${e.message}`).join("\n");
    throw new Error(`Configuration Validation Error:\n${errors}`);
  }

  parsedConfig = result.data;
  return parsedConfig;
}
