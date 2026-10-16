# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- The Speed card now headlines the session time-weighted average TPS (`avgE2eTps` / `avgDecodeTps`) and moves the latest single-turn TPS to the card footer alongside peak TPS, preventing short tool-call steps from making the headline speed jump around.

### Fixed

- Installer skips notifying the host Language Server (`JetboxWriteState`) when `--config-dir` or `AGY_CONFIG_DIR` points outside `~/.gemini/config`, so running `npm test` inside Antigravity no longer overwrites the host's `config.json`.
- Transcript fallback TPS estimation excludes tool-approval stalls (`< 8 tok/s`), prefers substantive turns (`>= 100` output tokens) when computing session and per-model average TPS, and keeps the latest non-interrupted turn's output token count on final response turns.


## [0.2.0] - 2026-10-15

First release under the name agy-pulse. Upgrading from 0.1.0:

- Node.js 20 or later is required.
- The `ANTIGRAVITY_SIDECAR_UI_TOKEN` check is gone; nothing needs to be configured instead.
- The sidecar ID and `config.json` keys are unchanged, so rerunning `node install.mjs` updates an existing install in place.

### Security

- The server rejects requests whose `Host` header is not `127.0.0.1`, `localhost`, or `[::1]` (HTTP 403), so a web page cannot read `/api/metrics` through DNS rebinding.

### Fixed

- Gemini 4 Argon has its own price ($2 / $0.10 cached / $10 per 1M tokens, doubling for turns from 2026-12-01) instead of Gemini 3.1 Pro's, and no 200k tier.
- Claude Sonnet 4.6 and Opus 4.6–5 no longer get a >200k surcharge; Anthropic bills their full 1M window at the standard price.
- The 200k tick and legend show only when the current model's price has a long-context tier.
- Installer no longer overwrites `config.json` with an empty object when the file is not valid JSON; it now stops with an error and leaves the file unchanged.
- Installer writes `config.json` with an atomic rename instead of a copy, and writes through a symlinked `config.json` instead of replacing the link.
- Installer keeps only one registration of the sidecar enabled, including plugin directories with another name (for example one created by `agy plugin install`); `--status` and `--uninstall` cover them too.
- `install.mjs` and `server.mjs` detect being the entrypoint when started through a symlink.
- Installer resolves symlinks when it checks whether it runs inside `plugins/` (macOS `/var` -> `/private/var`, a symlinked `~/.gemini`).
- Installer rejects unknown options instead of silently doing a standalone install.
- Panel escapes model names and conversation IDs before inserting them into HTML.
- Selecting a conversation without a local transcript no longer shows the latest conversation's transcript under that ID.
- The multi-model pricing label follows the selected UI language.
- A metrics error returns HTTP 500 instead of crashing the sidecar.
- Transcript lines that are valid JSON but not objects (such as `null`) are skipped instead of failing every request.

### Changed

- Project renamed to **agy-pulse**; links point to `github.com/evenluo/agy-pulse`. The sidecar ID stays `context-monitor`, so existing installs keep working.
- Split the 1,650-line `server.mjs` into `server.mjs`, `metrics.mjs`, `pricing.mjs`, and `ui/`.
- Standalone install copies the whole sidecar directory.
- The panel pauses polling while it is hidden.
- Panel wording: shorter labels in plain words, no unexplained abbreviations, and every label in both languages. Cache savings show as a positive amount instead of a negative percentage.
- Panel layout: the distance to auto-compaction comes first and the model window second; the conversation title shows at any width; in a narrow pane the turns table keeps #, Context, tok/s, and Cost; TTFT and the thinking split are hidden when the data source does not provide them.
- The server reads `ui/` files on each request, so UI edits show up without a restart.
- Node.js 20 or later is required; CI tests Node.js 20, 22, and 24 on Linux, macOS, and Windows.

### Removed

- The `ANTIGRAVITY_SIDECAR_UI_TOKEN` check. It accepted every `GET` request, and every route is `GET`.

### Added

- Price profiles for the models Antigravity offers that were billed at another model's price: Claude Opus 5.5, Claude Sonnet 5.5, Gemini 3.6–3.8 Flash (price doubles from 2027-01-01), and Gemini 3 Flash. Model names map by family and version.
- README sections on data sources, metric definitions, privacy, limitations, and troubleshooting; screenshots.
- `CONTRIBUTING.md`, `AGENTS.md`, `SECURITY.md`, and a demo fixture for local development.

## [0.1.0] - 2026-10-14

- Initial release. Its commit message calls it v1.0.0; it was renumbered before any tag was published.

[Unreleased]: https://github.com/evenluo/agy-pulse/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/evenluo/agy-pulse/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/evenluo/agy-pulse/releases/tag/v0.1.0
