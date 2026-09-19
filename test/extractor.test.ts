import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractRawConfigsFromText } from "../src/extractor/regex.js";
import { parseVpnConfig } from "../src/extractor/parser.js";
import { generateNormalizedConfigHash } from "../src/extractor/normalizer.js";

describe("VPN Config Extractor & Parser", () => {
  it("should extract multiple protocols from message text", () => {
    const sampleMessage = `
      🔥 New free configs for today:

      vless://11111111-2222-3333-4444-555555555555@example.com:443?security=reality&sni=yahoo.com&fp=chrome&pbk=AbCdEf123456&sid=1234&type=tcp#USA-Reality

      vmess://eyJhZGQiOiIxOTguNTEuMTAwLjEiLCJhaWQiOiIwIiwiaG9zdCI6IiIsImlkIjoiMjIyMjIyMjItMzMzMy00NDQ0LTU1NTUtNjY2NjY2NjY2NjY2IiwibmV0Ijoid3MiLCJwYXRoIjoiL3ZtZXNzIiwicG9ydCI6NDQzLCJwcyI6Ikdlcm1hbnkiLCJzY3kiOiJhdXRvIiwic25pIjoiIiwidGxzIjoidGxzIiwidHlwZSI6Im5vbmUiLCJ2IjoiMiJ9

      trojan://secretpassword123@trojan.example.org:443?security=tls&sni=trojan.example.org#Trojan-Fast

      ss://YWVzLTI1Ni1nY206cGFzc3dvcmRAMTk4LjUxLjEwMC4yOjgzODg=#Shadowsocks-Server

      hy2://authpass999@hy2.example.com:8443?sni=hy2.example.com#Hy2-Fast

      Enjoy!
    `;

    const extracted = extractRawConfigsFromText(sampleMessage);
    assert.strictEqual(extracted.length, 5);
  });

  it("should parse VLESS with Reality parameters correctly", () => {
    const raw = "vless://11111111-2222-3333-4444-555555555555@example.com:443?security=reality&sni=yahoo.com&fp=chrome&pbk=AbCdEf123456&sid=1234&type=tcp#USA-Reality";
    const parsed = parseVpnConfig(raw);

    assert.ok(parsed);
    assert.strictEqual(parsed.protocol, "vless");
    assert.strictEqual(parsed.server, "example.com");
    assert.strictEqual(parsed.port, 443);
    assert.strictEqual(parsed.uuidOrPassword, "11111111-2222-3333-4444-555555555555");
    assert.strictEqual(parsed.security, "reality");
    assert.strictEqual(parsed.sni, "yahoo.com");
    assert.strictEqual(parsed.publicKey, "AbCdEf123456");
    assert.strictEqual(parsed.shortId, "1234");
    assert.strictEqual(parsed.remarks, "USA-Reality");
  });

  it("should parse VMess base64 JSON correctly", () => {
    const raw = "vmess://eyJhZGQiOiIxOTguNTEuMTAwLjEiLCJhaWQiOiIwIiwiaG9zdCI6IiIsImlkIjoiMjIyMjIyMjItMzMzMy00NDQ0LTU1NTUtNjY2NjY2NjY2NjY2IiwibmV0Ijoid3MiLCJwYXRoIjoiL3ZtZXNzIiwicG9ydCI6NDQzLCJwcyI6Ikdlcm1hbnkiLCJzY3kiOiJhdXRvIiwic25pIjoiIiwidGxzIjoidGxzIiwidHlwZSI6Im5vbmUiLCJ2IjoiMiJ9";
    const parsed = parseVpnConfig(raw);

    assert.ok(parsed);
    assert.strictEqual(parsed.protocol, "vmess");
    assert.strictEqual(parsed.server, "198.51.100.1");
    assert.strictEqual(parsed.port, 443);
    assert.strictEqual(parsed.uuidOrPassword, "22222222-3333-4444-5555-666666666666");
    assert.strictEqual(parsed.transport, "ws");
    assert.strictEqual(parsed.path, "/vmess");
    assert.strictEqual(parsed.remarks, "Germany");
  });

  it("should generate the same normalized hash for identical configs with different remarks/tags", () => {
    const raw1 = "vless://11111111-2222-3333-4444-555555555555@example.com:443?security=reality&sni=yahoo.com&fp=chrome&pbk=AbCdEf123456&sid=1234&type=tcp#Channel-A";
    const raw2 = "vless://11111111-2222-3333-4444-555555555555@example.com:443?security=reality&sni=yahoo.com&fp=chrome&pbk=AbCdEf123456&sid=1234&type=tcp#Channel-B-Reposted";

    const parsed1 = parseVpnConfig(raw1);
    const parsed2 = parseVpnConfig(raw2);

    assert.ok(parsed1);
    assert.ok(parsed2);
    assert.strictEqual(parsed1.normalizedHash, parsed2.normalizedHash);
  });

  it("should replace remarks after # and inside VMess JSON ps with @connexy_private", () => {
    const rawVmess = "vmess://eyJ2IjogIjIiLCAicHMiOiAi8J+HqPCfh6YxNzU0MjAgfCDimqHvuI9UZWxlZ3JhbSA9IHQubWUvU09Ta2V5TkVUIiwgImFkZCI6ICJub21pbm8uMTFoaThpdGJhZi53b3JrZXJzLmRldiIsICJwb3J0IjogIjQ0MyIsICJpZCI6ICIzYWE3MTIwMi1hMDk5LTQ5YzEtOTlmYy02NjYyZjMzMzUzNjkiLCAiYWlkIjogIjAiLCAic2N5IjogImF1dG8iLCAibmV0IjogIndzIiwgInR5cGUiOiAiIiwgInRscyI6ICJ0bHMiLCAic25pIjogIm5vbWluby4xMWhpOGl0YmFmLndvcmtlcnMuZGV2IiwgInBhdGgiOiAiL3lvZ2Etc3VnZ2VzdGluZy1yZWNvcmRpbmctY2FsbHMudHJ5Y2xvdWRmbGFyZS5jb20vM2FhNzEyMDItYTA5OS00OWMxLTk5ZmMtNjY2MmYzMzM1MzY5LXZtIiwgImhvc3QiOiAibm9taW5vLjExaGk4aXRiYWYud29ya2Vycy5kZXYiLCAic2tpcC1jZXJ0LXZlcmlmeSI6IHRydWV9#✅@AR14N24b";
    const parsed = parseVpnConfig(rawVmess, "@connexy_private");

    assert.ok(parsed);
    assert.strictEqual(parsed.remarks, "@connexy_private");
    assert.ok(parsed.raw.endsWith("#@connexy_private"));
    assert.strictEqual(parsed.raw.includes("AR14N24b"), false);

    // Also test VLESS
    const rawVless = "vless://uuid@server.com:443?security=tls#OldChannelName";
    const parsedVless = parseVpnConfig(rawVless, "@connexy_private");
    assert.ok(parsedVless);
    assert.strictEqual(parsedVless.remarks, "@connexy_private");
    assert.strictEqual(parsedVless.raw, "vless://uuid@server.com:443?security=tls#@connexy_private");
  });
});
