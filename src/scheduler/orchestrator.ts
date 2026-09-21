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

  async runCycle(isManualTrigger = false): Promise<void> {
    if (!isManualTrigger && this.settingsRepo && !this.settingsRepo.isMonitoringActive()) {
      logger.debug("Automated monitoring is currently paused. Skipping scheduled cycle.");
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
    logger.info(`Starting VPN scan & health check cycle (${isManualTrigger ? "Manual" : "Scheduled"})...`);
    logger.info("==================================================");

    try {
      // 1. Scan joined channels
      const { channelsScanned, messagesScanned, configsFound } = await this.scanner.scanAllChannels();

      logger.info(
        { channelsScanned, messagesScanned, totalExtracted: configsFound.length },
        "Channel scanning finished"
      );

      // 2. Filter & Deduplicate
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

        // Only test if not already posted
        if (!this.configRepo.isConfigPosted(parsed.normalizedHash)) {
          // Avoid testing duplicate items within the same batch
          if (!configsToTest.some((c) => c.normalizedHash === parsed.normalizedHash)) {
            configsToTest.push(parsed);
          }
        }
      }

      logger.info({ toTest: configsToTest.length }, "Starting connectivity & latency testing...");

      // 3. Test configs
      let healthyCount = 0;
      if (configsToTest.length > 0) {
        const testResults = await this.testerPool.testBatch(configsToTest);

        for (const [hash, res] of testResults.entries()) {
          this.configRepo.updateTestResult(hash, res.isHealthy, res.latencyMs, res.errorMessage);
          if (res.isHealthy) healthyCount++;
        }
      }

      logger.info(
        { totalTested: configsToTest.length, healthyCount, deadCount: configsToTest.length - healthyCount },
        "Testing completed!"
      );

      // 4. Publish healthy configs
      const maxLimit = this.settingsRepo
        ? this.settingsRepo.getMaxPostsPerCycle()
        : this.config.MAX_POSTS_PER_CYCLE;

      const unpostedHealthy = this.configRepo.getUnpostedHealthyConfigs(maxLimit);
      logger.info({ unpostedCount: unpostedHealthy.length, maxLimit }, "Publishing unposted healthy configs...");

      const postedCount = await this.publisher.publishBatch(unpostedHealthy);

      // 5. Finish run record
      this.configRepo.finishScanRun(runId, {
        channelsScanned,
        messagesScanned,
        configsFound: configsFound.length,
        configsHealthy: healthyCount,
        configsPosted: postedCount,
      });

      const elapsedSec = Math.round((Date.now() - startTime) / 1000);
      logger.info("==================================================");
      logger.info(
        { elapsedSec, postedCount, healthyCount, channelsScanned },
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
    logger.info("Monitoring paused by user");
  }

  resumeMonitoring(): void {
    if (this.settingsRepo) {
      this.settingsRepo.setMonitoringActive(true);
    }
    logger.info("Monitoring resumed by user");
  }

  isMonitoringActive(): boolean {
    return this.settingsRepo ? this.settingsRepo.isMonitoringActive() : true;
  }

  async triggerManualScan(): Promise<void> {
    await this.runCycle(true);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info("Scheduler stopped.");
    }
  }
}
