import { describe, it } from "node:test";
import assert from "node:assert/strict";
import net from "net";
import { TcpTester } from "../src/tester/tcp-tester.js";
import { ParsedVpnConfig } from "../src/extractor/types.js";

describe("Connectivity Tester", () => {
  it("should detect open socket and measure latency", async () => {
    // Spin up a mock local TCP server
    const server = net.createServer((socket) => {
      socket.end();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;

    const tester = new TcpTester(2000);
    const mockConfig: ParsedVpnConfig = {
      protocol: "vless",
      server: "127.0.0.1",
      port,
      raw: "vless://...",
      normalizedHash: "test-hash",
      security: "none",
    };

    const result = await tester.test(mockConfig);
    server.close();

    assert.strictEqual(result.isHealthy, true);
    assert.strictEqual(typeof result.latencyMs, "number");
    assert.ok(result.latencyMs! >= 0);
  });

  it("should fail gracefully on unreachable port", async () => {
    const tester = new TcpTester(500);
    // Port 19999 should not have anything listening
    const mockConfig: ParsedVpnConfig = {
      protocol: "vless",
      server: "127.0.0.1",
      port: 19999,
      raw: "vless://...",
      normalizedHash: "test-hash-dead",
      security: "none",
    };

    const result = await tester.test(mockConfig);
    assert.strictEqual(result.isHealthy, false);
    assert.ok(result.errorMessage);
  });
});
