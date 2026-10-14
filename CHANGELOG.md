# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Security

- The server rejects requests whose `Host` header is not `127.0.0.1`, `localhost`, or `[::1]` (HTTP 403), so a web page cannot read `/api/metrics` through DNS rebinding.

### Fixed

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
- The server reads `ui/` files on each request, so UI edits show up without a restart.
- Removed the `ANTIGRAVITY_SIDECAR_UI_TOKEN` check, which accepted every `GET` request, and all routes are `GET`.
- Node.js 20 or later is required; CI tests Node.js 20, 22, and 24.

### Added

- README sections on data sources, metric definitions, privacy, limitations, and troubleshooting; screenshots.
- `CONTRIBUTING.md`, `AGENTS.md`, and a demo fixture for local development.

## [1.0.0] - 2026-10-14

- Initial release.
