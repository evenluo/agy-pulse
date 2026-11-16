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

This skill helps the user inspect live conversation metrics, open or toggle the **Context & TPS Monitor** auxiliary pane in Antigravity 2.0, and configure the status line in Antigravity CLI (`agy`).

## 1. Inspect Session Metrics Directly (Desktop or CLI)

When the user asks for current session token usage, auto-compaction headroom, prompt cache hit rate, API list cost, or TTFT/TPS (including inside `agy` CLI where there is no auxiliary side pane), run the bundled read-only CLI summary against the current conversation's transcript in the standard sandbox:

```bash
node "<plugin-root>/sidecars/context-monitor/metrics.mjs" --transcript "<Artifact Directory Path>/.system_generated/logs/transcript.jsonl"
```

Replace `<plugin-root>` with the directory two levels above this `SKILL.md` (or pass `--json` when structured fields are needed). Summarize the returned numbers concisely.

## 2. Open or Enable the Auxiliary Pane Panel (Desktop)

Determine the active sidecar ID from how this skill/sidecar is installed:

1. **Plugin-Bundled Sidecar**: `<plugin-root>/sidecars/context-monitor/sidecar.json` inside `plugins/<plugin-dir>/`
   - Sidecar ID: `<plugin-dir>/context-monitor` (use the actual `<plugin-dir>` folder name on disk, never assume `plugin.json`'s `name`)
   - Pill link: `[Context & TPS](sidecar://<plugin-dir>/context-monitor/)`
2. **Standalone Sidecar**: `~/.gemini/config/sidecars/context-monitor/sidecar.json`
   - Sidecar ID: `context-monitor`
   - Pill link: `[Context & TPS](sidecar://context-monitor/)`

Check `~/.gemini/config/config.json` (read-only) if accessible, or check whether the sidecar is enabled:

- **When enabled**: Include the matching one-click pill in your reply so the user can toggle the panel immediately:
  - Plugin mode: `[Context & TPS](sidecar://<plugin-dir>/context-monitor/)`
  - Standalone mode: `[Context & TPS](sidecar://context-monitor/)`
- **When disabled**: **Do not** edit `~/.gemini/config/config.json` or call `JetboxWriteState` from `run_command` (mutation RPCs are blocked for agent subprocesses and manual edits risk clobbering concurrent user settings). Instead:
  - In plugin mode, link directly to the plugin's Customizations page so the user can toggle it on live without restarting: `[Context & TPS Monitor](customization://<plugin-dir>)`
  - Or instruct the user to run `node "<plugin-root>/install.mjs"` in their own terminal.

## 3. Enable CLI Status Line (`agy` CLI)

If the user wants live metrics in the Antigravity CLI footer, instruct them to run one of:

- Inside an active `agy` session:
  ```text
  /statusline node <plugin-root>/sidecars/context-monitor/statusline.mjs
  ```
- Or in their terminal (writes `~/.gemini/antigravity-cli/settings.json` with `stack_with_default: true` while keeping any custom `statusLine` intact):
  ```bash
  node "<plugin-root>/install.mjs"
  ```
