import { TelegramClient } from "telegram";
import { Config } from "../config/env.js";
import { ChannelRepository } from "../database/repositories/channel.repo.js";
import { ConfigRepository } from "../database/repositories/config.repo.js";
import { SettingsRepository } from "../database/repositories/settings.repo.js";
import { ParsedVpnConfig } from "../extractor/types.js";
import { logger } from "../logger.js";
import { TelegramPublisher } from "../telegram/publisher.js";
import { TelegramScanner } from "../telegram/scanner.js";
import { TesterPool } from "../tester/pool.js";

export class ScanOrchestrator {
  private client: TelegramClient;
  private channelRepo: ChannelRepository;
  private configRepo: ConfigRepository;
  private settingsRepo?: SettingsRepository;
  private testerPool: TesterPool;
  private scanner: TelegramScanner;
  private publisher: TelegramPublisher;
  private config: Config;

  private isRunning = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    client: TelegramClient,
    channelRepo: ChannelRepository,
    configRepo: ConfigRepository,
    testerPool: TesterPool,
    config: Config,
    settingsRepo?: SettingsRepository
  ) {
    this.client = client;
    this.channelRepo = channelRepo;
    this.configRepo = configRepo;
    this.testerPool = testerPool;
    this.config = config;
    this.settingsRepo = settingsRepo;

    this.scanner = new TelegramScanner(client, channelRepo, config, settingsRepo);
    this.publisher = new TelegramPublisher(client, configRepo, config, settingsRepo);
  }

  async runCycle(options?: { configs?: boolean; proxies?: boolean; isManual?: boolean }): Promise<void> {
    const isManual = options?.isManual ?? false;
    const shouldScanConfigs = options?.configs !== undefined
      ? options.configs
      : (this.settingsRepo ? this.settingsRepo.isConfigMonitoringActive() : true);
    const shouldScanProxies = options?.proxies !== undefined
      ? options.proxies
      : (this.settingsRepo ? this.settingsRepo.isProxyMonitoringActive() : true);

    if (!isManual && !shouldScanConfigs && !shouldScanProxies) {
      logger.debug("Both Config and Proxy automated monitoring are paused. Skipping scheduled cycle.");
      return;
    }

    if (this.isRunning) {
      logger.warn("Previous scan cycle is still running. Skipping this trigger.");
      return;
    }

    this.isRunning = true;
    const startTime = Date.now();
    const runId = this.configRepo.startScanRun();

    logger.info("==================================================");
    logger.info(
      `Starting scan cycle (${isManual ? "Manual" : "Scheduled"}) | Configs: ${shouldScanConfigs ? "ON" : "OFF"}, Proxies: ${shouldScanProxies ? "ON" : "OFF"}...`
    );
    logger.info("==================================================");

    let totalChannelsScanned = 0;
    let totalMessagesScanned = 0;
    let totalItemsFound = 0;
    let healthyCount = 0;
    let postedConfigsCount = 0;
    let postedProxiesCount = 0;

    try {
      // 1. VPN Configs Phase
      if (shouldScanConfigs) {
        const { channelsScanned, messagesScanned, configsFound } = await this.scanner.scanAllChannels();
        totalChannelsScanned += channelsScanned;
        totalMessagesScanned += messagesScanned;
        totalItemsFound += configsFound.length;

        logger.info(
          { channelsScanned, messagesScanned, totalExtracted: configsFound.length },
          "VPN Config channel scanning finished"
        );

        const configsToTest: ParsedVpnConfig[] = [];
        for (const item of configsFound) {
          const { parsed, sourceChannelId, sourceChannelTitle, sourceMessageId } = item;

          this.configRepo.saveConfig({
            hash: parsed.normalizedHash,
            protocol: parsed.protocol,
            server: parsed.server,
            port: parsed.port,
            rawConfig: parsed.raw,
            remarks: parsed.remarks,
            parsedDetails: {
              security: parsed.security,
              transport: parsed.transport,
              path: parsed.path,
              host: parsed.host,
              sni: parsed.sni,
              flow: parsed.flow,
            },
            sourceChannelId,
            sourceChannelTitle,
            sourceMessageId,
          });

          if (!this.configRepo.isConfigPosted(parsed.normalizedHash)) {
            if (!configsToTest.some((c) => c.normalizedHash === parsed.normalizedHash)) {
              configsToTest.push(parsed);
            }
          }
        }

        const checkPingConfig = this.settingsRepo
          ? this.settingsRepo.isCheckPingBeforePostConfig()
          : this.config.CHECK_PING_BEFORE_POST_CONFIG;

        if (checkPingConfig) {
          if (configsToTest.length > 0) {
            logger.info({ toTest: configsToTest.length }, "Starting VPN configs connectivity & latency testing...");
            const testResults = await this.testerPool.testBatch(configsToTest);
            for (const [hash, res] of testResults.entries()) {
              this.configRepo.updateTestResult(hash, res.isHealthy, res.latencyMs, res.errorMessage);
              if (res.isHealthy) healthyCount++;
            }
          }
        } else {
          logger.info({ count: configsToTest.length }, "Ping testing before post is disabled for configs. Marking ready directly.");
          for (const c of configsToTest) {
            this.configRepo.updateTestResult(c.normalizedHash, true, null, null);
            healthyCount++;
          }
        }

        const maxLimit = this.settingsRepo
          ? this.settingsRepo.getMaxPostsPerCycle()
          : this.config.MAX_POSTS_PER_CYCLE;

        const unpostedAll = this.configRepo.getUnpostedConfigs(100, checkPingConfig);
        const unpostedConfigs = unpostedAll
          .filter((c) => c.protocol !== "mtproto" && c.protocol !== "socks5")
          .slice(0, maxLimit);

        if (unpostedConfigs.length > 0) {
          logger.info({ unpostedCount: unpostedConfigs.length, maxLimit }, "Publishing unposted VPN configs...");
          postedConfigsCount = await this.publisher.publishBatch(unpostedConfigs);
        }
      }

      // 2. MTProto / Socks Proxies Phase
      if (shouldScanProxies) {
        const { channelsScanned: proxyChannelsScanned, proxiesFound } = await this.scanner.scanProxyChannels();
        totalChannelsScanned += proxyChannelsScanned;
        totalItemsFound += proxiesFound.length;

        const proxiesToTest: ParsedVpnConfig[] = [];
        for (const item of proxiesFound) {
          const { parsed, sourceChannelId, sourceChannelTitle, sourceMessageId } = item;

          this.configRepo.saveConfig({
            hash: parsed.normalizedHash,
            protocol: parsed.protocol,
            server: parsed.server,
            port: parsed.port,
            rawConfig: parsed.raw,
            remarks: parsed.remarks,
            parsedDetails: parsed.extra,
            sourceChannelId,
            sourceChannelTitle,
            sourceMessageId,
          });

          if (!this.configRepo.isConfigPosted(parsed.normalizedHash)) {
            if (!proxiesToTest.some((p) => p.normalizedHash === parsed.normalizedHash)) {
              proxiesToTest.push(parsed);
            }
          }
        }

        const checkPingProxy = this.settingsRepo
          ? this.settingsRepo.isCheckPingBeforePostProxy()
          : this.config.CHECK_PING_BEFORE_POST_PROXY;

        if (checkPingProxy) {
          if (proxiesToTest.length > 0) {
            logger.info({ toTestProxies: proxiesToTest.length }, "Testing MTProto / Socks proxy connectivity...");
            const proxyResults = await this.testerPool.testBatch(proxiesToTest);
            for (const [hash, res] of proxyResults.entries()) {
              this.configRepo.updateTestResult(hash, res.isHealthy, res.latencyMs, res.errorMessage);
              if (res.isHealthy) healthyCount++;
            }
          }
        } else {
          logger.info({ count: proxiesToTest.length }, "Ping testing before post is disabled for proxies. Marking ready directly.");
          for (const p of proxiesToTest) {
            this.configRepo.updateTestResult(p.normalizedHash, true, null, null);
            healthyCount++;
          }
        }

        const unpostedProxies = this.configRepo
          .getUnpostedConfigs(100, checkPingProxy)
          .filter((c) => c.protocol === "mtproto" || c.protocol === "socks5");

        if (unpostedProxies.length > 0) {
          logger.info({ unpostedProxies: unpostedProxies.length }, "Publishing bundled proxies...");
          postedProxiesCount = await this.publisher.publishProxiesBatch(unpostedProxies);
        }
      }

      const totalPosted = postedConfigsCount + postedProxiesCount;

      // 3. Finish run record
      this.configRepo.finishScanRun(runId, {
        channelsScanned: totalChannelsScanned,
        messagesScanned: totalMessagesScanned,
        configsFound: totalItemsFound,
        configsHealthy: healthyCount,
        configsPosted: totalPosted,
      });

      const elapsedSec = Math.round((Date.now() - startTime) / 1000);
      logger.info("==================================================");
      logger.info(
        { elapsedSec, postedConfigs: postedConfigsCount, postedProxies: postedProxiesCount, healthyCount },
        "Scan cycle completed successfully!"
      );
      logger.info("==================================================");
    } catch (err: any) {
      logger.error({ err: err.message, stack: err.stack }, "Fatal error during scan cycle");
    } finally {
      this.isRunning = false;
    }
  }

  start(): void {
    const intervalMinutes = this.settingsRepo
      ? this.settingsRepo.getScanIntervalMinutes()
      : this.config.SCAN_INTERVAL_MINUTES;

    logger.info(
      { intervalMinutes },
      "Starting scheduler: will scan channels every interval."
    );

    // Initial run if active
    if (!this.settingsRepo || this.settingsRepo.isMonitoringActive()) {
      this.runCycle().catch((err) => {
        logger.error({ err: err.message }, "Initial scan cycle failed");
      });
    }

    this.rescheduleTimer(intervalMinutes);
  }

  rescheduleTimer(minutes?: number): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    const intervalMinutes = minutes ?? (this.settingsRepo
      ? this.settingsRepo.getScanIntervalMinutes()
      : this.config.SCAN_INTERVAL_MINUTES);

    const intervalMs = Math.max(1, intervalMinutes) * 60 * 1000;
    this.timer = setInterval(() => {
      this.runCycle().catch((err) => {
        logger.error({ err: err.message }, "Scheduled scan cycle failed");
      });
    }, intervalMs);

    logger.info({ intervalMinutes }, "Scheduled scan timer rescheduled");
  }

  pauseMonitoring(): void {
    if (this.settingsRepo) {
      this.settingsRepo.setMonitoringActive(false);
    }
    logger.info("All monitoring paused by user");
  }

  resumeMonitoring(): void {
    if (this.settingsRepo) {
      this.settingsRepo.setMonitoringActive(true);
    }
    logger.info("All monitoring resumed by user");
  }

  pauseConfigMonitoring(): void {
    if (this.settingsRepo) {
      this.settingsRepo.setConfigMonitoringActive(false);
    }
    logger.info("VPN Config monitoring paused by user");
  }

  resumeConfigMonitoring(): void {
    if (this.settingsRepo) {
      this.settingsRepo.setConfigMonitoringActive(true);
    }
    logger.info("VPN Config monitoring resumed by user");
  }

  pauseProxyMonitoring(): void {
    if (this.settingsRepo) {
      this.settingsRepo.setProxyMonitoringActive(false);
    }
    logger.info("Proxy monitoring paused by user");
  }

  resumeProxyMonitoring(): void {
    if (this.settingsRepo) {
      this.settingsRepo.setProxyMonitoringActive(true);
    }
    logger.info("Proxy monitoring resumed by user");
  }

  isMonitoringActive(): boolean {
    return this.settingsRepo ? this.settingsRepo.isMonitoringActive() : true;
  }

  isConfigMonitoringActive(): boolean {
    return this.settingsRepo ? this.settingsRepo.isConfigMonitoringActive() : true;
  }

  isProxyMonitoringActive(): boolean {
    return this.settingsRepo ? this.settingsRepo.isProxyMonitoringActive() : true;
  }

  async triggerManualScan(): Promise<void> {
    await this.runCycle({ configs: true, proxies: true, isManual: true });
  }

  async triggerManualConfigScan(): Promise<void> {
    await this.runCycle({ configs: true, proxies: false, isManual: true });
  }

  async triggerManualProxyScan(): Promise<void> {
    await this.runCycle({ configs: false, proxies: true, isManual: true });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info("Scheduler stopped.");
    }
  }
}
