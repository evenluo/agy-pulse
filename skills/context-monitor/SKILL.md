---
name: context-monitor
description: >-
  Open, inspect, or enable the Context & TPS Monitor UI extension panel in the
  Antigravity auxiliary side pane. Use this skill when the user asks to view
  context window usage, 256k auto-compaction watermark, prompt cache hit rate,
  per-model API cost (>200k tier), TTFT, or E2E/Decode TPS, or asks to open or
  enable the Context & TPS Monitor.
---

# Context & TPS Monitor Skill

This skill helps the user open and manage the **Context & TPS Monitor** UI extension in the Antigravity 2.0 Auxiliary Pane.

## Step 1: Check Whether the Sidecar is Enabled

Inspect `~/.gemini/config/config.json` (or run `install.mjs --status` if present in this plugin directory) to see which sidecar ID is active:

1. **Standalone Sidecar**: `~/.gemini/config/sidecars/context-monitor/sidecar.json`
   - Sidecar ID: `context-monitor`
   - Pill link: `[Context & TPS](sidecar://context-monitor/)`
2. **Plugin-Bundled Sidecar**: `~/.gemini/config/plugins/<plugin-dir>/sidecars/context-monitor/sidecar.json`
   - Sidecar ID: `<plugin-dir>/context-monitor` (typically `context-monitor/context-monitor`)
   - Pill link: `[Context & TPS](sidecar://<plugin-dir>/context-monitor/)`

## Step 2: Auto-Enable if Disabled

Antigravity keeps newly discovered sidecars disabled until they are enabled in `config.json`. If neither entry is enabled, run the installer from the plugin root; it enables the matching sidecar and notifies the Language Server:

```bash
node install.mjs
```

If the installer is not available, enable the standalone sidecar through the Language Server RPC. The CSRF token stays in the environment; do not print it or paste it into the command:

```bash
: "${ANTIGRAVITY_LS_ADDRESS:=localhost:5387}"
curl -sS -X POST \
  "http://${ANTIGRAVITY_LS_ADDRESS}/exa.language_server_pb.LanguageServerService/JetboxWriteState" \
  -H "Content-Type: application/json" \
  -H "x-codeium-csrf-token: ${ANTIGRAVITY_CSRF_TOKEN}" \
  -d '{"userConfig":{"sidecars":{"context-monitor":{"enabled":true}}}}'
```

## Step 3: Surface the One-Click Pill

In your response to the user, include the clickable `sidecar://` pill matching the active installation mode so the user can toggle the panel in one click:

- Standalone mode: `[Context & TPS](sidecar://context-monitor/)`
- Plugin mode: `[Context & TPS](sidecar://context-monitor/context-monitor/)`
