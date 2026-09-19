export type VpnProtocol = "vless" | "vmess" | "trojan" | "shadowsocks" | "hysteria2" | "tuic";

export interface ParsedVpnConfig {
  protocol: VpnProtocol;
  server: string;
  port: number;
  uuidOrPassword?: string;
  remarks?: string;
  security?: string; // tls, reality, none
  transport?: string; // tcp, ws, grpc, http, kcp
  path?: string;
  host?: string;
  sni?: string;
  publicKey?: string; // Reality pbk
  shortId?: string; // Reality sid
  fingerprint?: string; // fp
  flow?: string; // xtls-rprx-vision
  raw: string;
  normalizedHash: string;
  extra?: Record<string, unknown>;
}

export interface ExtractedConfigItem {
  raw: string;
  protocol: VpnProtocol;
  parsed?: ParsedVpnConfig;
}
