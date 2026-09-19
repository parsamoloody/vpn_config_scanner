import net from "net";
import tls from "tls";
import { ParsedVpnConfig } from "../extractor/types.js";
import { IVpnTester, TestResult } from "./types.js";

export class TcpTester implements IVpnTester {
  private timeoutMs: number;

  constructor(timeoutMs = 4000) {
    this.timeoutMs = timeoutMs;
  }

  async test(config: ParsedVpnConfig): Promise<TestResult> {
    const startTime = performance.now();
    const isTls = config.security === "tls" || config.security === "reality" || config.port === 443;

    try {
      if (isTls) {
        await this.testTlsHandshake(config.server, config.port, config.sni || config.server);
      } else {
        await this.testTcpConnection(config.server, config.port);
      }

      const latencyMs = Math.round(performance.now() - startTime);

      return {
        isHealthy: true,
        latencyMs,
        testedAt: Date.now(),
        mode: "tcp",
      };
    } catch (err: any) {
      return {
        isHealthy: false,
        latencyMs: undefined,
        errorMessage: err.message || "Connection failed",
        testedAt: Date.now(),
        mode: "tcp",
      };
    }
  }

  private testTcpConnection(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      let isDone = false;

      const finish = (err?: Error) => {
        if (isDone) return;
        isDone = true;
        socket.destroy();
        if (err) reject(err);
        else resolve();
      };

      socket.setTimeout(this.timeoutMs);
      socket.once("connect", () => finish());
      socket.once("timeout", () => finish(new Error("TCP connection timed out")));
      socket.once("error", (err) => finish(err));

      socket.connect(port, host);
    });
  }

  private testTlsHandshake(host: string, port: number, servername: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let isDone = false;

      const finish = (err?: Error) => {
        if (isDone) return;
        isDone = true;
        socket.destroy();
        if (err) reject(err);
        else resolve();
      };

      const socket = tls.connect({
        host,
        port,
        servername,
        rejectUnauthorized: false,
        timeout: this.timeoutMs,
      });

      socket.once("secureConnect", () => finish());
      socket.once("timeout", () => finish(new Error("TLS handshake timed out")));
      socket.once("error", (err) => finish(err));
    });
  }
}
