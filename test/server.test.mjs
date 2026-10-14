import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AGY_MONITOR_NO_AUTO_LISTEN = '1';

const {
  PRICING_PROFILES,
  resolvePricingProfileKey,
  computeTurnCost,
  parseDurationSec,
  parseTranscriptMetrics,
  getConversationMetrics,
  HTML_PAGE,
  PRELOAD_JS,
  server,
} = await import('../sidecars/context-monitor/server.mjs');

const { runCli } = await import('../install.mjs');

describe('Pricing & Cost Engine', () => {
  it('resolves model names to accurate pricing profiles in auto mode', () => {
    assert.equal(resolvePricingProfileKey('Gemini 4 Argon (High)', 'auto'), 'gemini_3_1_pro');
    assert.equal(resolvePricingProfileKey('Gemini 3.1 Pro', 'auto'), 'gemini_3_1_pro');
    assert.equal(resolvePricingProfileKey('Gemini 2.5 Pro', 'auto'), 'gemini_pro');
    assert.equal(resolvePricingProfileKey('Gemini 3 Flash', 'auto'), 'gemini_flash');
    assert.equal(resolvePricingProfileKey('Claude Sonnet 4.6', 'auto'), 'claude_sonnet');
    assert.equal(resolvePricingProfileKey('Claude Opus 4.6', 'auto'), 'claude_opus');
    assert.equal(resolvePricingProfileKey('Claude Opus 4.6', 'gemini_flash'), 'gemini_flash');
  });

  it('computes base-tier (<=200k) and high-tier (>200k) costs and prompt cache savings accurately', () => {
    const profile = PRICING_PROFILES.gemini_3_1_pro; // base: $2 / $0.2 / $12, high (>200k): $4 / $0.4 / $18
    const baseTurn = {
      inUncached: 50_000,
      inCached: 100_000,
      cacheWriteTokens: 0,
      totalInput: 150_000,
      outTokens: 10_000,
      thinkTokens: 4_000,
      respTokens: 6_000,
    };
    const baseRes = computeTurnCost(baseTurn, profile);
    assert.equal(baseRes.isHighTier, false);
    // inUncached: 0.05M * $2 = $0.10; inCached: 0.10M * $0.2 = $0.02; out: 0.01M * $12 = $0.12 -> total $0.24
    assert.ok(Math.abs(baseRes.costUsd - 0.24) < 1e-9);
    // Without cache: 0.15M * $2 + $0.12 = $0.42 -> saved $0.18
    assert.ok(Math.abs(baseRes.noCacheTotalCostUsd - 0.42) < 1e-9);
    assert.ok(Math.abs(baseRes.savedByCacheUsd - 0.18) < 1e-9);

    const highTurn = {
      inUncached: 50_000,
      inCached: 200_000,
      cacheWriteTokens: 0,
      totalInput: 250_000, // > 200,000 threshold
      outTokens: 10_000,
      thinkTokens: 5_000,
      respTokens: 5_000,
    };
    const highRes = computeTurnCost(highTurn, profile);
    assert.equal(highRes.isHighTier, true);
    // inUncached: 0.05M * $4 = $0.20; inCached: 0.20M * $0.4 = $0.08; out: 0.01M * $18 = $0.18 -> total $0.46
    assert.ok(Math.abs(highRes.costUsd - 0.46) < 1e-9);
  });

  it('parses duration strings in ms and s', () => {
    assert.equal(parseDurationSec('450ms'), 0.45);
    assert.equal(parseDurationSec('2.5s'), 2.5);
    assert.equal(parseDurationSec(1.25), 1.25);
    assert.equal(parseDurationSec(''), 0);
  });
});

describe('Transcript Parser & Multi-Model Aggregation', () => {
  let tmpRoot;
  let transcriptFile;

  before(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'agy-ctx-test-'));
    process.env.AGY_GEMINI_ROOT = tmpRoot;
    const logDir = join(
      tmpRoot,
      'antigravity',
      'brain',
      'conv-12345678',
      '.system_generated',
      'logs'
    );
    mkdirSync(logDir, { recursive: true });
    transcriptFile = join(logDir, 'transcript.jsonl');

    const lines = [
      JSON.stringify({
        step_index: 0,
        type: 'USER_INPUT',
        content:
          '<USER_REQUEST>\nBuild Context & TPS Monitor\n</USER_REQUEST>\n<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Gemini 4 Argon (High). No need to comment on this change.\n</USER_SETTINGS_CHANGE>',
      }),
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-10-14T06:00:00.000Z',
        input_tokens: 20000,
        cache_read_tokens: 80000,
        output_tokens: 500,
      }),
      JSON.stringify({
        step_index: 2,
        type: 'GENERIC',
        created_at: '2026-10-14T06:00:05.000Z',
      }),
      JSON.stringify({
        step_index: 3,
        type: 'CHECKPOINT',
      }),
      JSON.stringify({
        step_index: 4,
        type: 'USER_INPUT',
        content:
          '<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from Gemini 4 Argon (High) to Claude Sonnet 4.6. No need to comment.\n</USER_SETTINGS_CHANGE>',
      }),
      JSON.stringify({
        step_index: 5,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-10-14T06:01:00.000Z',
        input_tokens: 15000,
        cache_read_tokens: 210000,
        output_tokens: 600,
      }),
      JSON.stringify({
        step_index: 6,
        type: 'ERROR_MESSAGE',
        created_at: '2026-10-14T06:03:00.000Z',
      }),
    ];
    writeFileSync(transcriptFile, lines.join('\n') + '\n', 'utf-8');
  });

  after(() => {
    delete process.env.AGY_GEMINI_ROOT;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('extracts turns, models, checkpoints, and excludes interrupted ERROR_MESSAGE steps from TPS', () => {
    const parsed = parseTranscriptMetrics(transcriptFile);
    assert.equal(parsed.firstUserPrompt, 'Build Context & TPS Monitor');
    assert.equal(parsed.checkpointCount, 1);
    assert.equal(parsed.turns.length, 2);

    // Turn 1: Gemini 4 Argon (High), 5.0s duration, 500 output tokens -> 100 tok/s E2E
    assert.equal(parsed.turns[0].model, 'Gemini 4 Argon (High)');
    assert.equal(parsed.turns[0].interrupted, false);
    assert.equal(parsed.turns[0].e2eSec, 5);
    assert.equal(parsed.turns[0].e2eTps, 100);
    assert.equal(parsed.turns[0].cacheHitRate, 80);

    // Turn 2: Claude Sonnet 4.6, followed by ERROR_MESSAGE -> interrupted = true, e2eTps = 0
    assert.equal(parsed.turns[1].model, 'Claude Sonnet 4.6');
    assert.equal(parsed.turns[1].interrupted, true);
    assert.equal(parsed.turns[1].e2eTps, 0);
    assert.equal(parsed.turns[1].totalInput, 225000);
  });

  it('aggregates dual-track context watermarks and per-model billing in getConversationMetrics', async () => {
    const metrics = await getConversationMetrics('conv-12345678', 'auto');
    assert.equal(metrics.conversationId, 'conv-12345678');
    assert.equal(metrics.summary.turnCount, 2);
    assert.equal(metrics.summary.modelCount, 2);
    assert.equal(metrics.summary.checkpointCount, 1);
    assert.equal(metrics.summary.contextUsed, 225000);
    assert.equal(metrics.summary.maxContext, 1048576);
    assert.equal(metrics.summary.compactionMaxContext, 256000);
    assert.equal(metrics.summary.highTierTurnCount, 1);
    assert.equal(metrics.modelStats.length, 2);
  });
});

describe('Offline UI & HTTP Server', () => {
  it('ships self-contained CSS and bilingual i18n with zero external CDN dependencies', () => {
    assert.ok(!HTML_PAGE.includes('https://www.gstatic.com'));
    assert.ok(HTML_PAGE.includes('id="langToggle"'));
    assert.ok(HTML_PAGE.includes('const I18N ='));
    assert.ok(PRELOAD_JS.includes('theme-change'));
  });

  it('routes /, /preload.js, /api/metrics, and 404 accurately via HTTP handler', async () => {
    async function dispatch(method, urlPath, headers = {}) {
      let status = 200;
      let resHeaders = {};
      let body = '';
      const req = { method, url: urlPath, headers };
      let resolveDone;
      const done = new Promise((r) => {
        resolveDone = r;
      });
      const res = {
        writeHead(code, h) {
          status = code;
          resHeaders = h || {};
        },
        end(chunk) {
          if (chunk) body += String(chunk);
          resolveDone({ status, headers: resHeaders, body });
        },
      };
      server.emit('request', req, res);
      return done;
    }

    const resHtml = await dispatch('GET', '/');
    assert.equal(resHtml.status, 200);
    assert.ok(resHtml.body.includes('Context & TPS Monitor'));

    const resPreload = await dispatch('GET', '/preload.js');
    assert.equal(resPreload.status, 200);
    assert.ok(resPreload.body.includes('theme-change'));

    const resApi = await dispatch('GET', '/api/metrics');
    assert.equal(resApi.status, 200);
    const apiJson = JSON.parse(resApi.body);
    assert.ok(typeof apiJson.summary === 'object');

    const res404 = await dispatch('GET', '/unknown-route');
    assert.equal(res404.status, 404);
  });
});

describe('Installer CLI (install.mjs)', () => {
  let tmpConfigDir;

  before(() => {
    tmpConfigDir = mkdtempSync(join(tmpdir(), 'agy-cfg-test-'));
    // Seed existing config.json to verify preservation of sibling keys
    writeFileSync(
      join(tmpConfigDir, 'config.json'),
      JSON.stringify({ userSettings: { theme: 'dark' } }, null, 2)
    );
  });

  after(() => {
    rmSync(tmpConfigDir, { recursive: true, force: true });
  });

  it('installs standalone sidecar, preserves existing config.json keys, and sets 0600 mode', async () => {
    const res = await runCli(['--standalone', '--config-dir', tmpConfigDir, '--quiet']);
    assert.equal(res.ok, true);
    assert.equal(res.mode, 'standalone');

    const cfgPath = join(tmpConfigDir, 'config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    assert.equal(cfg.userSettings.theme, 'dark');
    assert.equal(cfg.sidecars['context-monitor'].enabled, true);

    const mode = statSync(cfgPath).mode & 0o777;
    assert.equal(mode, 0o600);
  });

  it('installs plugin bundle and switches sidecar enablement to avoid duplicate panels', async () => {
    const res = await runCli(['--plugin', '--config-dir', tmpConfigDir, '--quiet']);
    assert.equal(res.ok, true);
    assert.equal(res.mode, 'plugin');

    const cfg = JSON.parse(readFileSync(join(tmpConfigDir, 'config.json'), 'utf-8'));
    assert.equal(cfg.plugins['context-monitor'].enabled, true);
    assert.equal(cfg.sidecars['context-monitor/context-monitor'].enabled, true);
    assert.equal(cfg.sidecars['context-monitor'].enabled, false);

    const st = await runCli(['--status', '--config-dir', tmpConfigDir, '--quiet']);
    assert.equal(st.status.pluginInstalled, true);
    assert.equal(st.status.pluginSidecarEnabled, true);

    const un = await runCli(['--uninstall', '--config-dir', tmpConfigDir, '--quiet']);
    assert.equal(un.ok, true);
  });
});
