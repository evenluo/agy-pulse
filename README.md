<div align="center">
  <img src="assets/logo.svg" width="108" height="108" alt="Context & TPS Monitor Logo" />
  <h1>Antigravity Context & TPS Monitor</h1>
  <p>
    <strong>Native Sidecar UI Extension & Plugin for Google Antigravity 2.0</strong><br/>
    Real-time dual-track Context Window watermark (<code>1.05M</code> physical & <code>256k</code> auto-compaction), Prompt Cache hit rate, per-model API cost & cache savings (<code>&gt;200k</code> tiered pricing), TTFT, and E2E / Decode TPS telemetry.
  </p>
  <p>
    <a href="README_CN.md"><strong>🇨🇳 中文文档 (Chinese README)</strong></a> ·
    <a href="#quick-install"><strong>⚡ Quick Install</strong></a> ·
    <a href="#key-features"><strong>✨ Features</strong></a> ·
    <a href="#architecture"><strong>🏗️ Architecture</strong></a>
  </p>
</div>

---

## Why This Exists

When working on deep agentic sessions in **Google Antigravity 2.0**, two questions come up constantly:
1. **"Why did my conversation auto-compact at ~250k tokens when Gemini 3.1 / 4 Pro has a 1M context window — and why did API cost jump past 200k?"**
   - Antigravity's checkpointer triggers automatic context compaction around **256k tokens**, while Gemini & Claude APIs double per-token billing above **200k tokens** in a single turn.
2. **"Is the model currently slow because of First-Token Latency (TTFT), thinking token overhead, or streaming decode speed?"**

**Antigravity Context & TPS Monitor** lives directly inside the **Antigravity 2.0 Auxiliary Side Pane (`SIDECAR_UI_ENTRYPOINT_AUX_PANE`)** with zero external dependencies, 100% offline CSS rendering, automatic dark/light theme synchronization, and one-click `EN / 中文` switching.

---

## ✨ Key Features

- **Dual-Track Context Window Watermark**:
  - **Track 1 (`1.05M` Physical Window)**: Strictly aligned with physical context percentage, with visual tick markers at **`200k` (19.1% API price tier)** and **`256k` (24.4% auto-compaction threshold)**.
  - **Track 2 (`256k` Checkpointer Compaction Bar)**: Color-coded safety status (`<60%` Safe Green · `60–85%` Warning Amber · `>85%` Imminent Compaction Rose) plus automatic compaction count tracking (`CHECKPOINT` events).
- **Real-Time E2E TPS, Stream Decode TPS & TTFT**:
  - Distinguishes **End-to-End Perceived Speed (`E2E TPS`, including TTFT)**, **Pure Streaming Speed (`Decode TPS`)**, and **Visible Response TPS (excluding Thinking tokens)**.
  - Automatically filters out aborted/interrupted turns (`ERROR_MESSAGE`) and single-chunk buffer spikes (`streamSec < 0.15s`) using time-weighted session averages.
- **Prompt Cache Hit Rate & Per-Model API Billing (`>200k` Tiered)**:
  - Tracks cached vs. uncached input tokens per turn and across the entire session.
  - Automatically detects mid-conversation model switches (e.g. **Gemini 3.1 / 4 Pro**, **Gemini 2.5 Pro**, **Gemini Flash**, **Claude Sonnet 4.x**, **Claude Opus 4.x**) and computes per-model cost shares, `>200k` high-tier turn counts, and exact USD saved by Prompt Caching.
- **Hybrid Dual-Source Telemetry (RPC + Local Transcript)**:
  - Connects natively to Antigravity's Language Server (`GetCascadeTrajectoryGeneratorMetadata`) via injected sidecar environment variables (`ANTIGRAVITY_LS_ADDRESS`, `ANTIGRAVITY_CSRF_TOKEN`) for millisecond-level TTFT and streaming durations.
  - Seamlessly merges and falls back to `~/.gemini/antigravity-*/brain/<id>/.system_generated/logs/transcript.jsonl` for historical sessions and offline inspection.

---

## 📊 Comparison with Existing Community Tools

| Feature | **Antigravity Context & TPS Monitor** (This Repo) | `Antigravity-Context-Window-Monitor` | `antigravity-token-dashboard` | `codeburn` |
| :--- | :--- | :--- | :--- | :--- |
| **Host Surface** | **Native Antigravity 2.0 Sidecar UI Extension** (Aux Pane + `sidecar://` pill) | VS Code `.vsix` Extension (IDE only) | External Python server + macOS Menu Bar | External CLI |
| **LS Connection** | **Native Injected Env (`ANTIGRAVITY_LS_ADDRESS`)** + JSONL fallback | OS process scanning (`ps`/`lsof`/`wmic`) | Offline SQLite polling | OS process scanning |
| **Context Display** | **Dual-Track (`1.05M` Physical + `256k` Compaction + `200k` Tick)** | Single progress bar | Quota burn gauges | CLI summary table |
| **Speed Telemetry** | **Live TTFT + E2E TPS + Decode TPS + Think/Resp Split** | Step timestamps | Token burn velocity | None |
| **Runtime Dependencies** | **Zero (`node:http`, `node:fs`, 100% offline inline CSS)** | VS Code Extension Host | Python 3.10+ | Node.js CLI packages |

---

## ⚡ Quick Install

> **Prerequisite**: Node.js `>= 18.0.0` (uses built-in modules only; zero `npm install` dependencies required).

### Option 1: One-Line Quick Setup (Recommended)

Clone and run the zero-dependency installer, which deploys the sidecar and automatically enables it in `~/.gemini/config/config.json` (preserving `0600` file permissions and existing settings):

```bash
git clone https://github.com/evenluo/antigravity-context-monitor.git
node antigravity-context-monitor/install.mjs
```

Or install as a full **Antigravity Plugin bundle** (including both the UI sidecar and the companion Agent Skill):

```bash
node antigravity-context-monitor/install.mjs --plugin
```

### Option 2: Install via Antigravity CLI (`agy`)

```bash
agy plugin install https://github.com/evenluo/antigravity-context-monitor
# Then enable the sidecar in config.json:
node ~/.gemini/config/plugins/context-monitor/install.mjs
```

### Option 3: Team / Workspace Sharing (`.agents/`)

Copy this folder to `.agents/plugins/context-monitor/` inside your project repository so your entire team gets the plugin automatically when opening the workspace.

---

## 🚀 Usage

1. After installing, **restart Antigravity 2.0** (or open a new window) if this is the first time the sidecar directory was created.
2. Open the **Auxiliary Side Pane** on the right side of Antigravity 2.0 and select **`Context & TPS`**, or ask the Agent:
   > *"Open Context & TPS Monitor panel"*
   The Agent will surface a clickable `[Context & TPS](sidecar://context-monitor/)` pill in chat.
3. Click **`EN` / `中文`** in the top-right corner of the panel at any time to switch languages.

### CLI Management Commands

```bash
# Check installation & config.json enablement status
node install.mjs --status

# Uninstall and disable sidecar cleanly
node install.mjs --uninstall
```

---

## 🏗️ Architecture

```text
antigravity-context-monitor/
├── plugin.json                         # Antigravity Plugin manifest
├── install.mjs                         # Zero-dependency installer & config.json lifecycle CLI
├── assets/
│   └── logo.svg                        # Square SVG icon with >10% safe frame margin
├── sidecars/
│   └── context-monitor/
│       ├── sidecar.json                # Declares SIDECAR_UI_ENTRYPOINT_AUX_PANE web view
│       └── server.mjs                  # Zero-dependency Node.js telemetry server & bilingual UI
├── skills/
│   └── context-monitor/
│       └── SKILL.md                    # Companion skill for sidecar:// pill navigation & auto-enable
└── test/
    └── server.test.mjs                 # Automated unit & integration test suite (node --test)
```

---

## 🧪 Development & Testing

```bash
# Run the full test suite
npm test

# Run the monitor server standalone for local browser debugging (http://127.0.0.1:18990)
npm start
```

## 📄 License

[MIT License](./LICENSE) © 2026 evenluo
