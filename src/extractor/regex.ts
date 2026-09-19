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
