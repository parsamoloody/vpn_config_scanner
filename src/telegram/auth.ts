import fs from "fs";
import path from "path";
import readline from "readline";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { getConfig } from "../config/env.js";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

async function main() {
  console.log("\n=======================================================");
  console.log("  Telegram MTProto User Account Authenticator");
  console.log("=======================================================\n");

  let config: ReturnType<typeof getConfig> | null = null;
  try {
    config = getConfig(true);
  } catch {
    console.log("Could not load full configuration from environment.");
  }

  let apiId = config?.TELEGRAM_API_ID;
  let apiHash = config?.TELEGRAM_API_HASH;

  if (!apiId) {
    const inputId = await ask("Enter your Telegram API_ID (from https://my.telegram.org): ");
    apiId = parseInt(inputId, 10);
  }

  if (!apiHash) {
    apiHash = await ask("Enter your Telegram API_HASH (from https://my.telegram.org): ");
  }

  if (!apiId || isNaN(apiId) || !apiHash) {
    console.error("Invalid API_ID or API_HASH. Aborting.");
    process.exit(1);
  }

  const stringSession = new StringSession("");
  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => await ask("Enter your phone number (with country code, e.g. +123456789): "),
    password: async () => await ask("Enter your 2FA password (leave empty if not set): "),
    phoneCode: async () => await ask("Enter the Telegram verification code received: "),
    onError: (err) => console.error("Telegram Login Error:", err),
  });

  const sessionString = client.session.save() as unknown as string;
  const me = await client.getMe();

  console.log("\n=======================================================");
  console.log("Authentication successful!");
  console.log(`Logged in as: ${(me as any).firstName} (@${(me as any).username || "no_username"})`);
  console.log("=======================================================\n");

  // Update or append to .env
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

  if (envContent.includes("TELEGRAM_API_ID=")) {
    envContent = envContent.replace(/TELEGRAM_API_ID=.*$/m, `TELEGRAM_API_ID=${apiId}`);
  } else {
    envContent += `\nTELEGRAM_API_ID=${apiId}\n`;
  }

  if (envContent.includes("TELEGRAM_API_HASH=")) {
    envContent = envContent.replace(/TELEGRAM_API_HASH=.*$/m, `TELEGRAM_API_HASH=${apiHash}`);
  } else {
    envContent += `\nTELEGRAM_API_HASH=${apiHash}\n`;
  }

  fs.writeFileSync(envPath, envContent);
  console.log(`Updated .env with your TELEGRAM_SESSION string.`);
  console.log("\nYou can now start the monitor using: npm start\n");

  await client.disconnect();
  rl.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("Authentication failed:", err);
  rl.close();
  process.exit(1);
});
