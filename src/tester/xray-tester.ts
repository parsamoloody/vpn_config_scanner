import { spawn } from "child_process";
import fs from "fs";
import http from "http";
import net from "net";
import os from "os";
import path from "path";
import { SocksProxyAgent } from "socks-proxy-agent";
import { ParsedVpnConfig } from "../extractor/types.js";
import { IVpnTester, TestResult } from "./types.js";

export class XrayTester implements IVpnTester {
  private xrayBinary: string;
  private timeoutMs: number;
  private pingUrl: string;

  constructor(xrayBinary: string, timeoutMs = 5000, pingUrl = "http://cp.cloudflare.com/generate_204") {
    this.xrayBinary = xrayBinary;
    this.timeoutMs = timeoutMs;
    this.pingUrl = pingUrl;
  }

  async test(config: ParsedVpnConfig): Promise<TestResult> {
    const localPort = await this.getAvailablePort();
    const tempConfigFile = path.join(os.tmpdir(), `xray_test_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);

    try {
      const xrayConfig = this.buildXrayConfig(config, localPort);
      fs.writeFileSync(tempConfigFile, JSON.stringify(xrayConfig));

      const child = spawn(this.xrayBinary, ["run", "-c", tempConfigFile], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      // Wait 300ms for Xray to initialize local inbound
      await new Promise((r) => setTimeout(r, 300));

      const startTime = performance.now();
      try {
        await this.httpPingThroughSocks(localPort, this.pingUrl, this.timeoutMs);
        const latencyMs = Math.round(performance.now() - startTime);

        return {
          isHealthy: true,
          latencyMs,
          testedAt: Date.now(),
          mode: "xray",
        };
      } catch (err: any) {
        return {
          isHealthy: false,
          errorMessage: err.message || "Ping failed",
          testedAt: Date.now(),
          mode: "xray",
        };
      } finally {
        child.kill("SIGKILL");
      }
    } catch (err: any) {
      return {
        isHealthy: false,
        errorMessage: err.message || "Failed to configure Xray",
        testedAt: Date.now(),
        mode: "xray",
      };
    } finally {
      if (fs.existsSync(tempConfigFile)) {
        try {
          fs.unlinkSync(tempConfigFile);
        } catch {
          // ignore
        }
      }
    }
  }

  private httpPingThroughSocks(socksPort: number, targetUrl: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const agent = new SocksProxyAgent(`socks5://127.0.0.1:${socksPort}`);
      const url = new URL(targetUrl);

      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port || 80,
          path: url.pathname + (url.search || ""),
          method: "GET",
          agent,
          timeout: timeoutMs,
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
          },
        },
        (res) => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 400) {
            resolve();
          } else {
            reject(new Error(`HTTP status ${res.statusCode}`));
          }
          res.resume();
        }
      );

      req.on("timeout", () => {
        req.destroy(new Error("HTTP request timed out"));
      });

      req.on("error", (err) => {
        reject(err);
      });

      req.end();
    });
  }

  private getAvailablePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.listen(0, "127.0.0.1", () => {
        const address = server.address() as net.AddressInfo;
        const port = address.port;
        server.close(() => resolve(port));
      });
      server.on("error", reject);
    });
  }

  private buildXrayConfig(config: ParsedVpnConfig, localPort: number): Record<string, unknown> {
    const outbound: Record<string, unknown> = {
      protocol: config.protocol,
      tag: "proxy",
    };

    const streamSettings: Record<string, unknown> = {
      network: config.transport || "tcp",
      security: config.security || "none",
    };

    if (config.security === "tls") {
      streamSettings.tlsSettings = {
        serverName: config.sni || config.server,
        allowInsecure: true,
        fingerprint: config.fingerprint || "chrome",
      };
    } else if (config.security === "reality") {
      streamSettings.realitySettings = {
        serverName: config.sni || config.server,
        fingerprint: config.fingerprint || "chrome",
        publicKey: config.publicKey || "",
        shortId: config.shortId || "",
        spiderX: "",
      };
    }

    if (config.transport === "ws") {
      streamSettings.wsSettings = {
        path: config.path || "/",
        headers: config.host ? { Host: config.host } : undefined,
      };
    } else if (config.transport === "grpc") {
      streamSettings.grpcSettings = {
        serviceName: config.path || "",
        multiMode: false,
      };
    }

    if (config.protocol === "vless") {
      outbound.settings = {
        vnext: [
          {
            address: config.server,
            port: config.port,
            users: [
              {
                id: config.uuidOrPassword,
                encryption: "none",
                flow: config.flow || "",
              },
            ],
          },
        ],
      };
      outbound.streamSettings = streamSettings;
    } else if (config.protocol === "vmess") {
      outbound.settings = {
        vnext: [
          {
            address: config.server,
            port: config.port,
            users: [
              {
                id: config.uuidOrPassword,
                alterId: 0,
                security: "auto",
              },
            ],
          },
        ],
      };
      outbound.streamSettings = streamSettings;
    } else if (config.protocol === "trojan") {
      outbound.settings = {
        servers: [
          {
            address: config.server,
            port: config.port,
            password: config.uuidOrPassword,
          },
        ],
      };
      outbound.streamSettings = streamSettings;
    } else if (config.protocol === "shadowsocks") {
      const parts = (config.uuidOrPassword || "").split(":");
      const method = parts[0] || "aes-256-gcm";
      const password = parts.slice(1).join(":");

      outbound.settings = {
        servers: [
          {
            address: config.server,
            port: config.port,
            method,
            password,
          },
        ],
      };
    }

    return {
      log: { loglevel: "none" },
      inbounds: [
        {
          port: localPort,
          listen: "127.0.0.1",
          protocol: "socks",
          settings: {
            auth: "noauth",
            udp: false,
          },
        },
      ],
      outbounds: [
        outbound,
        {
          protocol: "freedom",
          tag: "direct",
        },
      ],
    };
  }
}
