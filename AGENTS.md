# agy-pulse agent guide

agy-pulse is an Antigravity sidecar panel (context watermark, prompt cache, cost, TTFT/TPS). Read `CONTRIBUTING.md` for the code layout and ground rules; they are binding.

## Verify

- `npm test` runs every suite under `test/` with `node:test`. Run it after any change.
- `AGY_GEMINI_ROOT=test/fixtures/demo npm start` serves the panel with demo data on `http://127.0.0.1:18990` for UI checks.

## Invariants

- No runtime dependencies and no external resources in `ui/index.html`.
- The sidecar ID `context-monitor` and the config keys `sidecars["context-monitor"]` / `sidecars["context-monitor/context-monitor"]` are a compatibility contract with existing installs. Do not rename them.
- `install.mjs` must never write `config.json` after failing to parse it.
- Any value from transcripts, RPC, or directory names that reaches `innerHTML` goes through `esc()` in `ui/index.html`.
- `version` in `package.json` and `plugin.json` stay equal.
