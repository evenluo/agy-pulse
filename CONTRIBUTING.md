# Contributing

Issues and pull requests are welcome. For a large change, open an issue first so we can agree on the approach.

## Ground rules

- **No runtime dependencies.** The sidecar and the installer use Node.js built-ins only, so users never run `npm install`.
- **No external resources in the panel.** No CDN scripts, styles, or fonts. The panel must work offline.
- **Loopback only.** The server binds to `127.0.0.1`, answers only loopback `Host` names, and makes no outbound requests other than to the local Language Server.
- **Never lose user config.** The installer must leave `config.json` untouched when it cannot parse it.

## Layout

```text
install.mjs                          Installer and config.json lifecycle CLI
plugin.json                          Antigravity plugin manifest
skills/context-monitor/SKILL.md      Agent skill: open or enable the panel
sidecars/context-monitor/
  sidecar.json                       Sidecar manifest (command, aux pane view)
  server.mjs                         HTTP entrypoint: serves ui/ and /api/metrics
  metrics.mjs                        Reads transcripts and LS RPC, aggregates per turn/model/session
  pricing.mjs                        Price table and per-turn cost
  ui/index.html                      The panel (HTML, CSS, JS in one file)
  ui/preload.js                      Applies host theme variables
test/                                node:test suites and the demo fixture
docs/                                README screenshots, rendered from the demo fixture
```

## Workflow

```bash
npm test                                         # run all tests (Node.js 20+)
AGY_GEMINI_ROOT=test/fixtures/demo npm start     # panel with demo data at http://127.0.0.1:18990
```

To try changes inside Antigravity, run `node install.mjs` again; the sidecar runs under `node --watch` and restarts when its files change.

Add or update tests for behaviour changes. Pure logic belongs in `metrics.mjs` or `pricing.mjs`, where it can be tested without a server.

## Updating prices

1. Edit `PRICING_PROFILES` in `sidecars/context-monitor/pricing.mjs`. Cite the vendor's pricing page in the pull request. Set `tierThreshold` and `high` only when the vendor prices by prompt length, and use `priceChange` for an announced price change on a date.
2. If you add a profile, add its keyword rule to `resolvePricingProfileKey`, an `<option>` to `#pricingSelect` in `ui/index.html`, and a test case in `test/metrics.test.mjs`.
3. Add a line to `CHANGELOG.md`.

## Releases

1. Set the same `version` in `package.json` and `plugin.json` (a test enforces this).
2. Move the `Unreleased` section of `CHANGELOG.md` under the new version and update the compare links at the bottom.
3. After the pull request is merged, tag the merge commit `vX.Y.Z` and create a GitHub release with that version's CHANGELOG section as notes.

The project is pre-1.0: a minor version may include breaking changes, listed at the top of its CHANGELOG section.

## Security

Do not open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).
