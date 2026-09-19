import crypto from "crypto";
import { ParsedVpnConfig } from "./types.js";

export function generateNormalizedConfigHash(config: {
  protocol: string;
  server: string;
  port: number;
  uuidOrPassword?: string;
  security?: string;
  transport?: string;
  path?: string;
  host?: string;
  sni?: string;
  publicKey?: string;
}): string {
  // Normalize key fields that define the proxy server identity
  const normalized = [
    config.protocol.toLowerCase(),
    config.server.toLowerCase(),
    config.port,
    config.uuidOrPassword || "",
    (config.security || "none").toLowerCase(),
    (config.transport || "tcp").toLowerCase(),
    (config.path || "").trim(),
    (config.host || "").toLowerCase().trim(),
    (config.sni || "").toLowerCase().trim(),
    config.publicKey || "",
  ].join("|");

  return crypto.createHash("sha256").update(normalized).digest("hex");
}
