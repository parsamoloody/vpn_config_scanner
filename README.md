# Telegram VPN Config Monitoring Bot 🚀

A production-ready Node.js bot that scans all Telegram channels you have joined using your personal Telegram account session (via MTProto / GramJS), extracts VPN configurations (`vless://`, `vmess://`, `trojan://`, `ss://`, `hysteria2://`, `tuic://`), tests their connectivity and ping latency, filters out dead or unreachable servers, prevents duplicate posts, stores results in SQLite, and publishes healthy configs to your own Telegram channel every 10 minutes.

---

## 🌟 Key Features

- **Telegram User Client (MTProto)**: Uses GramJS with your account session to access all joined public and private broadcast channels.
- **Multi-Protocol Support**:
  - `VLESS` (supports Reality, WebSocket, gRPC, TCP, TLS, Flow)
  - `VMess` (Base64 JSON decoding with WS/TCP/TLS)
  - `Trojan`
  - `Shadowsocks` (SIP002 and legacy URI formats)
  - `Hysteria2` / `hy2`
  - `TUIC`
- **Smart Deduplication**:
  - Computes a SHA-256 fingerprint from the core server properties (`protocol`, `server`, `port`, `credentials`, `sni`, `transport`, `security`).
  - Identical servers with different remarks/tags (e.g. `#ChannelA` vs `#ChannelB`) or reposted across multiple channels are never published twice.
- **Dual-Tier Health Checker**:
  - **Tier 1 (Fast TCP/TLS Pre-flight)**: Tests whether the server IP/domain and port respond to TCP handshakes.
  - **Tier 2 (Real Proxy End-to-End via Xray-core)**: Automatically downloads and runs `xray-core` to send real HTTP traffic through the proxy (e.g. to `http://cp.cloudflare.com/generate_204`) to confirm internet routing, TLS/Reality handshake, and measure real end-to-end latency.
- **SQLite Database**:
  - Built-in with WAL mode for zero-maintenance, high-speed local persistence.
  - Tracks channels, message scan progress (`last_scanned_message_id`), config health history, and scan statistics.
- **Automatic 10-Minute Scheduler**:
  - Runs automatically every 10 minutes with overlap protection (prevents concurrent scan runs).
- **Beautiful Telegram Formatting**:
  - Formats healthy configs with protocol badge, server address, ping latency indicator (`🟢 Fast`, `🟡 Normal`, `🔴 High Latency`), source channel attribution, and 1-click copyable monospace code blocks.

---

## 🏗️ Architecture Overview

```
                               ┌─────────────────────────────┐
                               │    10-Minute Scheduler      │
                               └──────────────┬──────────────┘
                                              │ triggers
                                              ▼
┌───────────────────────┐      ┌─────────────────────────────┐
│  Telegram MTProto     │◄────►│      Scan Orchestrator      │
│  (GramJS User Client) │      └──────────────┬──────────────┘
└───────────────────────┘                     │
                                              ▼
                               ┌─────────────────────────────┐
                               │   VPN Config Extractor &    │
                               │   Parser (VLESS, VMess, ...)│
                               └──────────────┬──────────────┘
                                              │
                                              ▼
                               ┌─────────────────────────────┐      ┌──────────────────┐
                               │   Deduplication & Storage   │◄────►│   SQLite DB      │
                               │   (Normalized Hash Index)   │      │ (better-sqlite3) │
                               └──────────────┬──────────────┘      └──────────────────┘
                                              │
                                              ▼
                               ┌─────────────────────────────┐
                               │   Two-Tier Proxy Tester     │
                               │   - Fast TCP/TLS Ping       │
                               │   - Xray-core End-to-End    │
                               └──────────────┬──────────────┘
                                              │ healthy configs
                                              ▼
                               ┌─────────────────────────────┐
                               │    Telegram Publisher       │───► Target Channel
                               │  (Formatted message + code) │
                               └─────────────────────────────┘
```

---

## 📋 Prerequisites

1. **Node.js**: v18+ (tested on Node v20, v22, and v24).
2. **Telegram MTProto Credentials**:
   - Go to [https://my.telegram.org](https://my.telegram.org).
   - Log in with your phone number.
   - Go to **API development tools** and create an application.
   - Copy your `API_ID` and `API_HASH`.

---

## 🚀 Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Edit `.env` and set:
- `TELEGRAM_API_ID`: Your Telegram API ID.
- `TELEGRAM_API_HASH`: Your Telegram API Hash.
- `TARGET_CHANNEL_ID`: Your destination channel (e.g. `@my_vpn_channel` or channel ID `-1001234567890`).

### 3. Authenticate Your Telegram Account

Run the interactive login script:

```bash
npm run auth
```

- Enter your phone number (international format, e.g. `+1234567890`).
- Enter the code received in your Telegram app.
- Enter your 2FA password (if enabled).
- The script will automatically generate your session string and save `TELEGRAM_SESSION` into your `.env` file.

### 4. Start the Bot

```bash
# Development (with hot-reload)
npm run dev

# Production
npm start
```

---

## 🐳 Docker Deployment

You can run the bot with Docker and Docker Compose:

1. Follow steps 1-3 above to authenticate and generate `.env`.
2. Start the container:

```bash
docker compose up -d
```

3. View logs:

```bash
docker compose logs -f
```

---

## ⚙️ Configuration Reference

All settings can be configured in `.env`:

| Variable | Default | Description |
| :--- | :--- | :--- |
| `TELEGRAM_API_ID` | *Required* | API ID from [my.telegram.org](https://my.telegram.org) |
| `TELEGRAM_API_HASH` | *Required* | API Hash from [my.telegram.org](https://my.telegram.org) |
| `TELEGRAM_SESSION` | *Generated* | GramJS StringSession from `npm run auth` |
| `TARGET_CHANNEL_ID` | `@my_vpn_channel` | Channel where healthy configs are sent |
| `SCAN_INTERVAL_MINUTES` | `10` | Frequency of scanning joined channels (minutes) |
| `INITIAL_CHANNEL_SCAN_LIMIT` | `30` | Number of messages to scan on first channel discovery |
| `SUBSEQUENT_CHANNEL_SCAN_LIMIT`| `50` | Number of new messages to fetch on subsequent scans |
| `TESTER_CONCURRENCY` | `5` | Number of configs tested concurrently |
| `TESTER_TIMEOUT_MS` | `5000` | Timeout per test in milliseconds |
| `TESTER_MODE` | `xray` | Testing engine: `xray` (full proxy test) or `tcp` (TCP ping) |
| `TESTER_PING_URL` | `http://cp.cloudflare.com/generate_204` | Endpoint to verify internet connectivity |
| `MAX_HEALTHY_LATENCY_MS` | `3500` | Maximum latency threshold; slower configs are rejected |
| `ALLOWED_CHANNELS` | `""` (all) | Comma-separated channel usernames/IDs to exclusively scan (e.g. `proxy_changgel,vpn_ir_f,xxx`). If set, the bot only scans these channels. |
| `EXCLUDED_CHANNELS` | `""` | Comma-separated channel IDs/usernames to ignore |
| `CUSTOM_CONFIG_REMARKS` | `@connexy_private` | Remarks name to replace after `#` (and inside VMess JSON `ps`) for all published configs |
| `DATABASE_PATH` | `./data/vpn_monitor.sqlite` | Path to SQLite database file |
| `LOG_LEVEL` | `info` | Log verbosity: `trace`, `debug`, `info`, `warn`, `error` |

---

## 🧪 Testing

Run automated tests:

```bash
npm test
```

Run TypeScript verification:

```bash
npm run lint
```

---

## 🛡️ License

MIT
