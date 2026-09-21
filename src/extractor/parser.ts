import { URL } from "url";
import { generateNormalizedConfigHash } from "./normalizer.js";
import { ParsedVpnConfig, VpnProtocol } from "./types.js";

function safeBase64Decode(str: string): string {
  // Pad if needed
  let normalized = str.replace(/-/g, "+").replace(/_/g, "/");
  while (normalized.length % 4 !== 0) {
    normalized += "=";
  }
  return Buffer.from(normalized, "base64").toString("utf-8");
}

export function applyCustomRemarks(rawUri: string, customRemarks: string): string {
  if (!customRemarks) return rawUri;

  const trimmed = rawUri.trim();

  if (trimmed.startsWith("vmess://")) {
    try {
      const hashIdx = trimmed.indexOf("#");
      const withoutHash = hashIdx !== -1 ? trimmed.slice(0, hashIdx) : trimmed;
      const rawBase64 = withoutHash.replace(/^vmess:\/\//i, "").trim();
      const decoded = safeBase64Decode(rawBase64);
      const json = JSON.parse(decoded);
      json.ps = customRemarks;
      const reEncoded = Buffer.from(JSON.stringify(json)).toString("base64");
      return `vmess://${reEncoded}#${customRemarks}`;
    } catch {
      return `${trimmed.replace(/#.*$/, "")}#${customRemarks}`;
    }
  }

  // For vless, trojan, ss, hysteria2, tuic:
  const withoutHash = trimmed.replace(/#.*$/, "");
  return `${withoutHash}#${customRemarks}`;
}

export function parseVpnConfig(rawUri: string, customRemarks?: string): ParsedVpnConfig | null {
  try {
    let trimmed = rawUri.trim();
    if (customRemarks) {
      trimmed = applyCustomRemarks(trimmed, customRemarks);
    }

    if (trimmed.startsWith("vless://")) {
      return parseVless(trimmed);
    } else if (trimmed.startsWith("vmess://")) {
      return parseVmess(trimmed);
    } else if (trimmed.startsWith("trojan://")) {
      return parseTrojan(trimmed);
    } else if (trimmed.startsWith("ss://")) {
      return parseShadowsocks(trimmed);
    } else if (trimmed.startsWith("hysteria2://") || trimmed.startsWith("hy2://")) {
      return parseHysteria2(trimmed);
    } else if (trimmed.startsWith("tuic://")) {
      return parseTuic(trimmed);
    } else if (trimmed.includes("proxy?") || trimmed.includes("socks?")) {
      return parseProxyConfig(trimmed);
    }

    return null;
  } catch (err) {
    return null;
  }
}

function parseVless(uri: string): ParsedVpnConfig | null {
  const url = new URL(uri);
  const server = url.hostname;
  const port = parseInt(url.port, 10);
  const uuid = decodeURIComponent(url.username);
  const remarks = url.hash ? decodeURIComponent(url.hash.slice(1)) : undefined;

  if (!server || isNaN(port) || !uuid) return null;

  const params = url.searchParams;
  const security = params.get("security") || undefined;
  const transport = params.get("type") || "tcp";
  const path = params.get("path") || undefined;
  const host = params.get("host") || undefined;
  const sni = params.get("sni") || undefined;
  const publicKey = params.get("pbk") || undefined;
  const shortId = params.get("sid") || undefined;
  const fingerprint = params.get("fp") || undefined;
  const flow = params.get("flow") || undefined;

  const normalizedHash = generateNormalizedConfigHash({
    protocol: "vless",
    server,
    port,
    uuidOrPassword: uuid,
    security,
    transport,
    path,
    host,
    sni,
    publicKey,
  });

  return {
    protocol: "vless",
    server,
    port,
    uuidOrPassword: uuid,
    remarks,
    security,
    transport,
    path,
    host,
    sni,
    publicKey,
    shortId,
    fingerprint,
    flow,
    raw: uri,
    normalizedHash,
  };
}

function parseVmess(uri: string): ParsedVpnConfig | null {
  const rawBase64 = uri.replace(/^vmess:\/\//i, "").trim();
  const decoded = safeBase64Decode(rawBase64);
  let json: Record<string, unknown>;

  try {
    json = JSON.parse(decoded);
  } catch {
    return null;
  }

  const server = String(json.add || "");
  const port = parseInt(String(json.port || "0"), 10);
  const uuid = String(json.id || "");
  const remarks = json.ps ? String(json.ps) : undefined;
  const transport = json.net ? String(json.net) : "tcp";
  const security = json.tls ? String(json.tls) : "none";
  const path = json.path ? String(json.path) : undefined;
  const host = json.host ? String(json.host) : undefined;
  const sni = json.sni ? String(json.sni) : undefined;

  if (!server || isNaN(port) || port <= 0 || !uuid) return null;

  const normalizedHash = generateNormalizedConfigHash({
    protocol: "vmess",
    server,
    port,
    uuidOrPassword: uuid,
    security,
    transport,
    path,
    host,
    sni,
  });

  return {
    protocol: "vmess",
    server,
    port,
    uuidOrPassword: uuid,
    remarks,
    security,
    transport,
    path,
    host,
    sni,
    raw: uri,
    normalizedHash,
    extra: json,
  };
}

function parseTrojan(uri: string): ParsedVpnConfig | null {
  const url = new URL(uri);
  const server = url.hostname;
  const port = parseInt(url.port, 10);
  const password = decodeURIComponent(url.username);
  const remarks = url.hash ? decodeURIComponent(url.hash.slice(1)) : undefined;

  if (!server || isNaN(port) || !password) return null;

  const params = url.searchParams;
  const security = params.get("security") || "tls";
  const transport = params.get("type") || "tcp";
  const sni = params.get("sni") || undefined;
  const path = params.get("path") || undefined;
  const host = params.get("host") || undefined;

  const normalizedHash = generateNormalizedConfigHash({
    protocol: "trojan",
    server,
    port,
    uuidOrPassword: password,
    security,
    transport,
    path,
    host,
    sni,
  });

  return {
    protocol: "trojan",
    server,
    port,
    uuidOrPassword: password,
    remarks,
    security,
    transport,
    path,
    host,
    sni,
    raw: uri,
    normalizedHash,
  };
}

function parseShadowsocks(uri: string): ParsedVpnConfig | null {
  // Format 1: ss://BASE64@server:port#remarks (SIP002)
  // Format 2: ss://BASE64(method:password@server:port)#remarks
  const hashIdx = uri.indexOf("#");
  const remarks = hashIdx !== -1 ? decodeURIComponent(uri.slice(hashIdx + 1)) : undefined;
  const withoutHash = hashIdx !== -1 ? uri.slice(0, hashIdx) : uri;
  const body = withoutHash.replace(/^ss:\/\//i, "");

  let server = "";
  let port = 0;
  let userinfo = "";

  if (body.includes("@")) {
    // Format 1
    const [encodedUserInfo, hostPort] = body.split("@");
    userinfo = safeBase64Decode(encodedUserInfo);
    const parts = hostPort.split(":");
    server = parts[0];
    port = parseInt(parts[1] || "0", 10);
  } else {
    // Format 2
    const decoded = safeBase64Decode(body);
    if (decoded.includes("@")) {
      const [uinfo, hostPort] = decoded.split("@");
      userinfo = uinfo;
      const parts = hostPort.split(":");
      server = parts[0];
      port = parseInt(parts[1] || "0", 10);
    }
  }

  if (!server || isNaN(port) || port <= 0) return null;

  const normalizedHash = generateNormalizedConfigHash({
    protocol: "shadowsocks",
    server,
    port,
    uuidOrPassword: userinfo,
  });

  return {
    protocol: "shadowsocks",
    server,
    port,
    uuidOrPassword: userinfo,
    remarks,
    raw: uri,
    normalizedHash,
  };
}

function parseHysteria2(uri: string): ParsedVpnConfig | null {
  const normalizedUri = uri.replace(/^hy2:\/\//i, "hysteria2://");
  const url = new URL(normalizedUri);
  const server = url.hostname;
  const port = parseInt(url.port, 10);
  const auth = decodeURIComponent(url.username);
  const remarks = url.hash ? decodeURIComponent(url.hash.slice(1)) : undefined;

  if (!server || isNaN(port)) return null;

  const params = url.searchParams;
  const sni = params.get("sni") || undefined;

  const normalizedHash = generateNormalizedConfigHash({
    protocol: "hysteria2",
    server,
    port,
    uuidOrPassword: auth,
    sni,
  });

  return {
    protocol: "hysteria2",
    server,
    port,
    uuidOrPassword: auth,
    remarks,
    sni,
    raw: uri,
    normalizedHash,
  };
}

function parseTuic(uri: string): ParsedVpnConfig | null {
  const url = new URL(uri);
  const server = url.hostname;
  const port = parseInt(url.port, 10);
  const auth = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
  const remarks = url.hash ? decodeURIComponent(url.hash.slice(1)) : undefined;

  if (!server || isNaN(port)) return null;

  const params = url.searchParams;
  const sni = params.get("sni") || undefined;

  const normalizedHash = generateNormalizedConfigHash({
    protocol: "tuic",
    server,
    port,
    uuidOrPassword: auth,
    sni,
  });

  return {
    protocol: "tuic",
    server,
    port,
    uuidOrPassword: auth,
    remarks,
    sni,
    raw: uri,
    normalizedHash,
  };
}

export function parseMtproto(uri: string): ParsedVpnConfig | null {
  try {
    const normalizedUri = uri
      .replace(/^tg:\/\/proxy\?/i, "https://t.me/proxy?")
      .replace(/^http:\/\//i, "https://");
    const url = new URL(normalizedUri);
    const server = url.searchParams.get("server")?.trim();
    const portStr = url.searchParams.get("port")?.trim();
    const secret = url.searchParams.get("secret")?.trim() || "";
    const port = portStr ? parseInt(portStr, 10) : 443;

    if (!server || isNaN(port)) return null;

    const normalizedHash = generateNormalizedConfigHash({
      protocol: "mtproto",
      server,
      port,
      uuidOrPassword: secret,
    });

    const raw = `https://t.me/proxy?server=${encodeURIComponent(server)}&port=${port}&secret=${encodeURIComponent(secret)}`;

    return {
      protocol: "mtproto",
      server,
      port,
      uuidOrPassword: secret,
      raw,
      normalizedHash,
      extra: { secret },
    };
  } catch {
    return null;
  }
}

export function parseSocks(uri: string): ParsedVpnConfig | null {
  try {
    const normalizedUri = uri
      .replace(/^tg:\/\/socks\?/i, "https://t.me/socks?")
      .replace(/^http:\/\//i, "https://");
    const url = new URL(normalizedUri);
    const server = url.searchParams.get("server")?.trim();
    const portStr = url.searchParams.get("port")?.trim();
    const user = url.searchParams.get("user")?.trim() || "";
    const pass = url.searchParams.get("pass")?.trim() || "";
    const port = portStr ? parseInt(portStr, 10) : 1080;

    if (!server || isNaN(port)) return null;

    const auth = user ? `${user}:${pass}` : "";
    const normalizedHash = generateNormalizedConfigHash({
      protocol: "socks5",
      server,
      port,
      uuidOrPassword: auth,
    });

    const raw = user
      ? `https://t.me/socks?server=${encodeURIComponent(server)}&port=${port}&user=${encodeURIComponent(user)}&pass=${encodeURIComponent(pass)}`
      : `https://t.me/socks?server=${encodeURIComponent(server)}&port=${port}`;

    return {
      protocol: "socks5",
      server,
      port,
      uuidOrPassword: auth,
      raw,
      normalizedHash,
      extra: { user, pass },
    };
  } catch {
    return null;
  }
}

export function parseProxyConfig(rawUri: string): ParsedVpnConfig | null {
  const trimmed = rawUri.trim();
  if (trimmed.includes("proxy?")) {
    return parseMtproto(trimmed);
  } else if (trimmed.includes("socks?")) {
    return parseSocks(trimmed);
  }
  return null;
}
