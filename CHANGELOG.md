# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
- Removed the `ANTIGRAVITY_SIDECAR_UI_TOKEN` check, which accepted every `GET` request, and all routes are `GET`.
- Node.js 20 or later is required; CI tests Node.js 20, 22, and 24 on Linux, macOS, and Windows.

### Added

- Price profiles for the models Antigravity offers that were billed at another model's price: Claude Opus 5.5, Claude Sonnet 5.5, Gemini 3.6–3.8 Flash (price doubles from 2027-01-01), and Gemini 3 Flash. Model names map by family and version.
- README sections on data sources, metric definitions, privacy, limitations, and troubleshooting; screenshots.
- `CONTRIBUTING.md`, `AGENTS.md`, `SECURITY.md`, and a demo fixture for local development.

## [1.0.0] - 2026-10-14

- Initial release.
