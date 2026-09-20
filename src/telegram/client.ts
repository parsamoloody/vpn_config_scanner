import fs from "fs";
import path from "path";
import readline from "readline";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Config } from "../config/env.js";
import { logger } from "../logger.js";

let clientInstance: TelegramClient | null = null;

function promptInput(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function saveSessionToEnv(sessionString: string): void {
  const envPath = path.resolve(process.cwd(), ".env");
  let envContent = "";
  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, "utf-8");
  } else if (fs.existsSync(path.resolve(process.cwd(), ".env.example"))) {
    envContent = fs.readFileSync(path.resolve(process.cwd(), ".env.example"), "utf-8");
  }

  if (envContent.includes("TELEGRAM_SESSION=")) {
    envContent = envContent.replace(/TELEGRAM_SESSION=.*$/m, `TELEGRAM_SESSION=${sessionString}`);
  } else {
    envContent += `\nTELEGRAM_SESSION=${sessionString}\n`;
  }

  fs.writeFileSync(envPath, envContent);
  logger.info("Saved new TELEGRAM_SESSION string into .env file!");
}

export async function initTelegramClient(config: Config): Promise<TelegramClient> {
  if (clientInstance) return clientInstance;

  logger.info("Initializing Telegram MTProto user client...");

  const session = new StringSession(config.TELEGRAM_SESSION || "");
  const client = new TelegramClient(session, config.TELEGRAM_API_ID, config.TELEGRAM_API_HASH, {
    connectionRetries: 5,
    useWSS: false,
  });

  await client.connect();

  let isAuth = false;
  if (config.TELEGRAM_SESSION) {
    isAuth = await client.checkAuthorization();
  }

  if (!isAuth) {
    console.log("\n=======================================================");
    console.log("  First-Time Setup: Telegram Account Authentication");
    console.log("=======================================================\n");

    await client.start({
      phoneNumber: async () => await promptInput("Enter your phone number (e.g. +989123456789): "),
      password: async () => await promptInput("Enter your 2FA password (leave empty if not set): "),
      phoneCode: async () => await promptInput("Enter the Telegram verification code received: "),
      onError: (err) => logger.error({ err: err.message }, "Telegram login error"),
    });

    const savedSession = client.session.save() as unknown as string;
    saveSessionToEnv(savedSession);
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
