import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Config } from "../config/env.js";
import { logger } from "../logger.js";

let clientInstance: TelegramClient | null = null;

export async function initTelegramClient(config: Config): Promise<TelegramClient> {
  if (clientInstance) return clientInstance;

  logger.info("Initializing Telegram MTProto user client...");

  const session = new StringSession(config.TELEGRAM_SESSION);
  const client = new TelegramClient(session, config.TELEGRAM_API_ID, config.TELEGRAM_API_HASH, {
    connectionRetries: 5,
    useWSS: false,
  });

  await client.connect();

  const isAuth = await client.checkAuthorization();
  if (!isAuth) {
    throw new Error(
      "Telegram client is not authorized. The provided TELEGRAM_SESSION is invalid or expired. Run 'npm run auth' to log in."
    );
  }

  const me = await client.getMe();
  logger.info(
    {
      userId: me.id?.toString(),
      username: (me as any).username || "no_username",
      firstName: (me as any).firstName,
    },
    "Telegram user client connected successfully!"
  );

  clientInstance = client;
  return client;
}

export function getTelegramClient(): TelegramClient {
  if (!clientInstance) {
    throw new Error("Telegram client is not initialized. Call initTelegramClient() first.");
  }
  return clientInstance;
}

export async function disconnectTelegramClient(): Promise<void> {
  if (clientInstance) {
    try {
      await clientInstance.disconnect();
      logger.info("Telegram client disconnected.");
    } catch (err: any) {
      logger.warn({ err: err.message }, "Error during Telegram disconnect");
    } finally {
      clientInstance = null;
    }
  }
}
