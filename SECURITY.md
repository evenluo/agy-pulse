# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through [GitHub security advisories](https://github.com/evenluo/agy-pulse/security/advisories/new). Do not open a public issue.

Include what an attacker can do, the steps to reproduce, and your Antigravity, Node.js, and operating system versions.

## Supported versions

Fixes go to the latest version on `main`.

## Scope

- The sidecar server (`sidecars/context-monitor/server.mjs`). It listens on `127.0.0.1` and answers only loopback `Host` names.
- The installer (`install.mjs`), which edits `~/.gemini/config/config.json`.
- The panel (`sidecars/context-monitor/ui/`), which renders data from local transcripts and the Antigravity Language Server.

Antigravity itself is out of scope; report its issues to Google.
