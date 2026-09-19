import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { logger } from "../logger.js";

export class XrayManager {
  private binaryPath: string | null = null;

  async ensureBinary(): Promise<string | null> {
    if (this.binaryPath && fs.existsSync(this.binaryPath)) {
      return this.binaryPath;
    }

    // 1. Check local bin/ folder
    const localBin = path.resolve(process.cwd(), "bin", process.platform === "win32" ? "xray.exe" : "xray");
    if (fs.existsSync(localBin)) {
      this.binaryPath = localBin;
      return localBin;
    }

    // 2. Check system PATH
    try {
      const whichCmd = process.platform === "win32" ? "where xray" : "which xray";
      const stdout = execSync(whichCmd, { stdio: ["pipe", "pipe", "ignore"] }).toString().trim();
      if (stdout && fs.existsSync(stdout)) {
        this.binaryPath = stdout;
        return stdout;
      }
    } catch {
      // not in PATH
    }

    // 3. Auto-download official Xray-core binary
    logger.info("Xray binary not found locally or in PATH. Attempting automatic download...");
    try {
      const downloaded = await this.downloadXrayBinary(path.dirname(localBin));
      if (downloaded) {
        this.binaryPath = downloaded;
        return downloaded;
      }
    } catch (err: any) {
      logger.warn({ err: err.message }, "Could not automatically download Xray binary. Falling back to TCP tester.");
    }

    return null;
  }

  private async downloadXrayBinary(targetDir: string): Promise<string | null> {
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const platform = os.platform();
    const arch = os.arch();

    let assetName = "";
    if (platform === "linux" && arch === "x64") {
      assetName = "Xray-linux-64.zip";
    } else if (platform === "linux" && arch === "arm64") {
      assetName = "Xray-linux-arm64-v8a.zip";
    } else if (platform === "darwin" && arch === "arm64") {
      assetName = "Xray-macos-arm64-v8a.zip";
    } else if (platform === "darwin" && arch === "x64") {
      assetName = "Xray-macos-64.zip";
    } else if (platform === "win32" && arch === "x64") {
      assetName = "Xray-windows-64.zip";
    } else {
      logger.warn({ platform, arch }, "Unsupported platform for automatic Xray download");
      return null;
    }

    const downloadUrl = `https://github.com/XTLS/Xray-core/releases/latest/download/${assetName}`;
    const zipPath = path.join(targetDir, assetName);

    logger.info({ url: downloadUrl }, "Downloading Xray-core release...");

    // Use curl or wget
    try {
      execSync(`curl -fsSL -L -o "${zipPath}" "${downloadUrl}"`, { timeout: 30000 });
    } catch {
      try {
        execSync(`wget -q -O "${zipPath}" "${downloadUrl}"`, { timeout: 30000 });
      } catch (e: any) {
        throw new Error(`Failed to download Xray-core: ${e.message}`);
      }
    }

    // Extract zip
    try {
      execSync(`unzip -o "${zipPath}" -d "${targetDir}"`, { timeout: 15000 });
      if (fs.existsSync(zipPath)) {
        fs.unlinkSync(zipPath);
      }
    } catch (e: any) {
      throw new Error(`Failed to extract Xray zip: ${e.message}`);
    }

    const binaryFile = path.join(targetDir, platform === "win32" ? "xray.exe" : "xray");
    if (fs.existsSync(binaryFile)) {
      if (platform !== "win32") {
        fs.chmodSync(binaryFile, 0o755);
      }
      logger.info({ path: binaryFile }, "Successfully downloaded and extracted Xray-core!");
      return binaryFile;
    }

    return null;
  }
}
