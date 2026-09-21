// Regular expressions for extracting VPN configuration links from message texts

export const VPN_REGEX = {
  // vless://uuid@host:port?query#remarks
  vless: /\bvless:\/\/[a-zA-Z0-9\-]+@[^:\s\/?#]+:[0-9]+(?:\?[^\s\r\n#]*)?(?:#[^\s\r\n]*)?/gi,

  // vmess://base64
  vmess: /\bvmess:\/\/[a-zA-Z0-9+/=_\-]+/gi,

  // trojan://password@host:port?query#remarks
  trojan: /\btrojan:\/\/[^@\s\/?#]+@[^:\s\/?#]+:[0-9]+(?:\?[^\s\r\n#]*)?(?:#[^\s\r\n]*)?/gi,

  // ss://base64@host:port#remarks OR ss://base64#remarks
  // Must use \b so it doesn't match inside vless:// or vmess://
  shadowsocks: /\bss:\/\/(?:[a-zA-Z0-9+/=_\-]+@[^:\s\/?#]+:[0-9]+|[a-zA-Z0-9+/=_\-]+)(?:#[^\s\r\n]*)?/gi,

  // hysteria2://auth@host:port?query#remarks or hy2://...
  hysteria2: /\b(?:hysteria2|hy2):\/\/[^@\s\/?#]+@[^:\s\/?#]+:[0-9]+(?:\?[^\s\r\n#]*)?(?:#[^\s\r\n]*)?/gi,

  // tuic://uuid:password@host:port?query#remarks
  tuic: /\btuic:\/\/[^@\s\/?#]+@[^:\s\/?#]+:[0-9]+(?:\?[^\s\r\n#]*)?(?:#[^\s\r\n]*)?/gi,
};

export const PROXY_REGEX = {
  // tg://proxy?server=HOST&port=PORT&secret=SECRET
  tgMtproto: /\btg:\/\/proxy\?[^\s\r\n<>"')\]]+/gi,
  // https://t.me/proxy?server=HOST&port=PORT&secret=SECRET
  tmeMtproto: /\b(?:https?:\/\/)?t\.me\/proxy\?[^\s\r\n<>"')\]]+/gi,
  // tg://socks?server=HOST&port=PORT
  tgSocks: /\btg:\/\/socks\?[^\s\r\n<>"')\]]+/gi,
  // https://t.me/socks?server=HOST&port=PORT
  tmeSocks: /\b(?:https?:\/\/)?t\.me\/socks\?[^\s\r\n<>"')\]]+/gi,
};

export function extractRawConfigsFromText(text: string): string[] {
  if (!text || typeof text !== "string") return [];

  const found = new Set<string>();

  for (const regex of Object.values(VPN_REGEX)) {
    // Reset regex state since it has /g flag
    regex.lastIndex = 0;
    const matches = text.match(regex);
    if (matches) {
      for (const match of matches) {
        const cleaned = match.trim();
        if (cleaned.length > 10) {
          found.add(cleaned);
        }
      }
    }
  }

  return Array.from(found);
}

export function extractRawProxiesFromText(text: string, entities?: any[]): string[] {
  const found = new Set<string>();

  // 1. Extract from Telegram native MessageEntityTextUrl entities if provided
  if (Array.isArray(entities)) {
    for (const ent of entities) {
      const url = ent.url || (ent.className === "MessageEntityTextUrl" ? ent.url : null);
      if (url && typeof url === "string") {
        let cleaned = url.trim();
        if (cleaned.startsWith("t.me/")) {
          cleaned = "https://" + cleaned;
        }
        if (cleaned.length > 10 && (cleaned.includes("proxy?") || cleaned.includes("socks?"))) {
          found.add(cleaned);
        }
      }
    }
  }

  if (!text || typeof text !== "string") return Array.from(found);

  // 2. Extract from markdown link destinations: [text](https://t.me/proxy?...)
  const mdLinkRegex = /\[([^\]]*)\]\(((?:https?:\/\/|tg:\/\/)[^\s\)]+)\)/gi;
  let mdMatch: RegExpExecArray | null;
  while ((mdMatch = mdLinkRegex.exec(text)) !== null) {
    const destUrl = mdMatch[2].trim();
    if (destUrl.length > 10 && (destUrl.includes("proxy?") || destUrl.includes("socks?"))) {
      let cleaned = destUrl;
      if (cleaned.startsWith("t.me/")) {
        cleaned = "https://" + cleaned;
      }
      found.add(cleaned);
    }
  }

  // 3. Extract from raw regex matches in text
  for (const regex of Object.values(PROXY_REGEX)) {
    regex.lastIndex = 0;
    const matches = text.match(regex);
    if (matches) {
      for (let match of matches) {
        let cleaned = match.trim();
        // Normalize t.me to https://t.me if missing scheme
        if (cleaned.startsWith("t.me/")) {
          cleaned = "https://" + cleaned;
        }
        if (cleaned.length > 10) {
          found.add(cleaned);
        }
      }
    }
  }

  return Array.from(found);
}
