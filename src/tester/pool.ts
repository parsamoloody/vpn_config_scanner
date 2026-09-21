import { Config } from "../config/env.js";
import { ParsedVpnConfig } from "../extractor/types.js";
import { logger } from "../logger.js";
import { TcpTester } from "./tcp-tester.js";
import { IVpnTester, TestResult } from "./types.js";
import { XrayManager } from "./xray-manager.js";
import { XrayTester } from "./xray-tester.js";

export class TesterPool {
  private primaryTester!: IVpnTester;
  private fallbackTester: IVpnTester;
  private config: Config;
  private initialized = false;

  constructor(config: Config) {
    this.config = config;
    this.fallbackTester = new TcpTester(config.TESTER_TIMEOUT_MS);
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    if (this.config.TESTER_MODE === "xray") {
      const xrayMgr = new XrayManager();
      const binaryPath = await xrayMgr.ensureBinary();

      if (binaryPath) {
        logger.info({ binaryPath }, "Initialized Xray-core tester for deep proxy connectivity checks");
        this.primaryTester = new XrayTester(binaryPath, this.config.TESTER_TIMEOUT_MS, this.config.TESTER_PING_URL);
      } else {
        logger.warn("Xray-core binary not available. Using TCP/TLS ping tester as fallback.");
        this.primaryTester = this.fallbackTester;
      }
    } else {
      logger.info("Using TCP/TLS ping tester (configured via TESTER_MODE=tcp)");
      this.primaryTester = this.fallbackTester;
    }

    this.initialized = true;
  }

  async testOne(vpnConfig: ParsedVpnConfig): Promise<TestResult> {
    if (!this.initialized) {
      await this.init();
    }

    // For Hysteria2 and TUIC (QUIC/UDP-based), if not supported directly by standard xray outbound,
    // we use TCP/UDP ping
    let tester = this.primaryTester;
    if (
      vpnConfig.protocol === "hysteria2" ||
      vpnConfig.protocol === "tuic" ||
      vpnConfig.protocol === "mtproto" ||
      vpnConfig.protocol === "socks5"
    ) {
      tester = this.fallbackTester;
    }

    try {
      const result = await tester.test(vpnConfig);

      // Check max latency constraint
      if (result.isHealthy && result.latencyMs && result.latencyMs > this.config.MAX_HEALTHY_LATENCY_MS) {
        return {
          ...result,
          isHealthy: false,
          errorMessage: `Latency ${result.latencyMs}ms exceeded threshold of ${this.config.MAX_HEALTHY_LATENCY_MS}ms`,
        };
      }

      return result;
    } catch (err: any) {
      return {
        isHealthy: false,
        errorMessage: err.message || "Test failed",
        testedAt: Date.now(),
        mode: "tcp",
      };
    }
  }

  async testBatch(
    configs: ParsedVpnConfig[],
    concurrency = this.config.TESTER_CONCURRENCY
  ): Promise<Map<string, TestResult>> {
    const results = new Map<string, TestResult>();
    const queue = [...configs];

    const workers = Array.from({ length: Math.min(concurrency, configs.length) }, async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        if (!item) break;

        const result = await this.testOne(item);
        results.set(item.normalizedHash, result);
      }
    });

    await Promise.all(workers);
    return results;
  }
}
