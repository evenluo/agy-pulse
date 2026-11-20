import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  PRICING_PROFILES,
  resolvePricingProfileKey,
  computeTurnCost,
} from '../sidecars/context-monitor/pricing.mjs';
import {
  parseDurationSec,
  parseTranscriptMetrics,
  getConversationMetrics,
} from '../sidecars/context-monitor/metrics.mjs';
import {
  formatStatusLine,
  resolveGitBranch,
  splitModelAndEffort,
} from '../sidecars/context-monitor/statusline.mjs';

describe('Pricing & Cost Engine', () => {
  it('resolves model names to accurate pricing profiles in auto mode', () => {
    const cases = {
      'Gemini 4 Argon (High)': 'gemini_4_argon',
      'gemini-4-argon': 'gemini_4_argon',
      'Gemini 4 Carbon (Medium)': 'gemini_4_argon',
      'gemini-4-carbon': 'gemini_4_argon',
      'Gemini 4 Neon (High)': 'gemini_4_neon',
      'Gemini 4 Neon (Extra High)': 'gemini_4_neon',
      'gemini-4-neon': 'gemini_4_neon',
      'gemini-4-neon-xhigh': 'gemini_4_neon',
      'Orchestrator (Neon)': 'gemini_4_neon',
      'Orchestrator (Neon) gemini-pro-orchestrator-neon': 'gemini_4_neon',
      'Orchestrator (Neon) MODEL_PLACEHOLDER_M537': 'gemini_4_neon',
      'gemini-pro-orchestrator-neon': 'gemini_4_neon',
      'Orchestrator (Neon) gemini-flash-worker-agy': 'gemini_4_neon',
      'Gemini 4 Hydrogen (Orchestrator)': 'gemini_4_hydrogen',
      'gemini-4-hydrogen': 'gemini_4_hydrogen',
      'Gemini 4 Hydrogen (Orchestrator) gemini-flash-worker-agy': 'gemini_4_hydrogen',
      'Orchestrator (Carbon) gemini-flash-worker-agy': 'gemini_4_argon',
      'Gemini 3.1 Pro (High)': 'gemini_3_1_pro',
      'Gemini 2.5 Pro': 'gemini_pro',
      'Gemini 3.8 Flash': 'gemini_3_6_flash',
      'Gemini 3.7 Flash (High)': 'gemini_3_6_flash',
      'gemini-3.6-flash': 'gemini_3_6_flash',
      'Gemini 3.6 Flash gemini-3.6-flash-001': 'gemini_3_6_flash',
      'gemini-3.8-flash-20261001': 'gemini_3_6_flash',
      'gemini-3-flash-preview': 'gemini_3_flash',
      'Gemini 2.5 Flash': 'gemini_flash',
      'Claude Opus 5.5': 'claude_opus_5_5',
      'claude-opus-5-5': 'claude_opus_5_5',
      'Claude Opus 5.5 (Thinking)': 'claude_opus_5_5',
      // RPC turns join the display name with an opaque model ID.
      'Claude Opus 5.5 (Thinking) MODEL_PLACEHOLDER_M26': 'claude_opus_5_5',
      'Gemini 3.8 Flash MODEL_PLACEHOLDER_M26': 'gemini_3_6_flash',
      'Claude Opus 4.6 (Thinking)': 'claude_opus',
      'Claude Sonnet 5.5 (Thinking)': 'claude_sonnet_5_5',
      'claude-sonnet-5-5-20261001': 'claude_sonnet_5_5',
      'Claude Sonnet 4.6 (Thinking)': 'claude_sonnet',
      'claude-sonnet-4-6': 'claude_sonnet',
    };
    for (const [name, key] of Object.entries(cases)) {
      assert.equal(resolvePricingProfileKey(name, 'auto'), key, name);
    }
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

  it('bills Gemini 4 Argon and Claude 4.6 or later without a 200k tier, and Argon by the date of each turn', () => {
    const turn = (createdAt) => ({
      inUncached: 50_000,
      inCached: 200_000,
      cacheWriteTokens: 0,
      totalInput: 250_000,
      outTokens: 10_000,
      thinkTokens: 0,
      respTokens: 10_000,
      createdAt,
    });
    const intro = computeTurnCost(turn('2026-11-30T23:59:59Z'), PRICING_PROFILES.gemini_4_argon);
    assert.equal(intro.isHighTier, false);
    // 0.05M * $2 + 0.20M * $0.1 + 0.01M * $10 = $0.10 + $0.02 + $0.10
    assert.ok(Math.abs(intro.costUsd - 0.22) < 1e-9);
    const standard = computeTurnCost(turn('2026-12-01T00:00:00Z'), PRICING_PROFILES.gemini_4_argon);
    // 0.05M * $4 + 0.20M * $0.2 + 0.01M * $20 = $0.20 + $0.04 + $0.20
    assert.ok(Math.abs(standard.costUsd - 0.44) < 1e-9);

    const sonnet = computeTurnCost(turn(null), PRICING_PROFILES.claude_sonnet);
    assert.equal(sonnet.isHighTier, false);
    // 0.05M * $3 + 0.20M * $0.3 + 0.01M * $15 = $0.15 + $0.06 + $0.15
    assert.ok(Math.abs(sonnet.costUsd - 0.36) < 1e-9);

    const hydrogen = computeTurnCost(turn(null), PRICING_PROFILES.gemini_4_hydrogen);
    assert.equal(hydrogen.isHighTier, false);
    // 0.05M * $1.50 + 0.20M * $0.075 + 0.01M * $7.50 = $0.075 + $0.015 + $0.075 = $0.165
    assert.ok(Math.abs(hydrogen.costUsd - 0.165) < 1e-9);

    const neon = computeTurnCost(turn(null), PRICING_PROFILES.gemini_4_neon);
    assert.equal(neon.isHighTier, false);
    // 0.05M * $3.00 + 0.20M * $0.15 + 0.01M * $15.00 = $0.15 + $0.03 + $0.15 = $0.33
    assert.ok(Math.abs(neon.costUsd - 0.33) < 1e-9);
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
    lines.splice(3, 0, 'null', '[]', '{not json');
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
    // The 225k turn runs on Claude Sonnet 4.6, which has no long-context tier, and was interrupted.
    assert.equal(metrics.summary.highTierTurnCount, 0);
    assert.equal(metrics.summary.priceTierThreshold, 0);
    assert.equal(metrics.summary.lastTurnInterrupted, true);
    assert.equal(metrics.summary.lastOutTokens, 600);

    const forced = await getConversationMetrics('conv-12345678', 'gemini_3_1_pro');
    assert.equal(forced.summary.priceTierThreshold, 200000);
    assert.equal(forced.summary.highTierTurnCount, 1);
    assert.equal(metrics.modelStats.length, 2);
  });

  it('does not show another conversation\'s transcript for an unknown conversation id', async () => {
    const metrics = await getConversationMetrics('../../outside', 'auto');
    assert.equal(metrics.conversationId, '../../outside');
    assert.equal(metrics.summary.turnCount, 0);
  });

  it('filters out approval stalls (<8 tok/s) and micro tool-call turns (<100 tokens) from transcript avgE2eTps while keeping final turn output tokens', async () => {
    const convDir = join(
      tmpRoot,
      'antigravity',
      'brain',
      'conv-tps-filter',
      '.system_generated',
      'logs'
    );
    mkdirSync(convDir, { recursive: true });
    const tPath = join(convDir, 'transcript.jsonl');
    const lines = [
      // Turn 1: substantive turn (600 tokens in 6s = 100 tok/s)
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-10-16T08:00:00Z',
        input_tokens: 10000,
        cache_read_tokens: 40000,
        output_tokens: 600,
      }),
      JSON.stringify({
        step_index: 2,
        type: 'GENERIC',
        created_at: '2026-10-16T08:00:06Z',
      }),
      // Turn 2: micro tool-call turn (50 tokens in 5s = 10 tok/s, dominated by TTFT)
      JSON.stringify({
        step_index: 3,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-10-16T08:00:10Z',
        input_tokens: 2000,
        cache_read_tokens: 48000,
        output_tokens: 50,
      }),
      JSON.stringify({
        step_index: 4,
        type: 'GENERIC',
        created_at: '2026-10-16T08:00:15Z',
      }),
      // Turn 3: tool call waiting 40s for human approval (120 tokens in 40s = 3 tok/s < 8 tok/s)
      JSON.stringify({
        step_index: 5,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-10-16T08:00:20Z',
        input_tokens: 2000,
        cache_read_tokens: 50000,
        output_tokens: 120,
      }),
      JSON.stringify({
        step_index: 6,
        type: 'GENERIC',
        created_at: '2026-10-16T08:01:00Z',
      }),
      // Turn 4: final text response with no trailing GENERIC step (1500 output tokens)
      JSON.stringify({
        step_index: 7,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-10-16T08:01:05Z',
        input_tokens: 3000,
        cache_read_tokens: 52000,
        output_tokens: 1500,
      }),
    ];
    writeFileSync(tPath, lines.join('\n') + '\n', 'utf-8');

    const metrics = await getConversationMetrics('conv-tps-filter', 'auto');
    assert.equal(metrics.turns.length, 4);
    // Turn 3 approval stall has e2eSec = 0 and e2eTps = 0
    assert.equal(metrics.turns[2].e2eSec, 0);
    assert.equal(metrics.turns[2].e2eTps, 0);
    // Session and per-model avgE2eTps use substantive Turn 1 (100 tok/s), ignoring micro Turn 2 (10 tok/s)
    assert.equal(metrics.summary.avgE2eTps, 100);
    assert.equal(metrics.modelStats[0].avgE2eTps, 100);
    // Final turn output tokens are preserved in summary.lastOutTokens
    assert.equal(metrics.summary.lastOutTokens, 1500);
    // Last measured and peak speed use substantive Turn 1 (100 tok/s), ignoring micro Turn 2 (10 tok/s)
    assert.equal(metrics.summary.lastE2eTps, 100);
    assert.equal(metrics.summary.peakE2eTps, 100);
  });

  it('drops a long turn that also waited for approval from transcript avgE2eTps and lastE2eTps', async () => {
    const convDir = join(
      tmpRoot,
      'antigravity',
      'brain',
      'conv-tps-long-wait',
      '.system_generated',
      'logs'
    );
    mkdirSync(convDir, { recursive: true });
    const planner = (step, at, out) =>
      JSON.stringify({
        step_index: step,
        type: 'PLANNER_RESPONSE',
        created_at: at,
        input_tokens: 2000,
        cache_read_tokens: 40000,
        output_tokens: out,
      });
    const generic = (step, at) => JSON.stringify({ step_index: step, type: 'GENERIC', created_at: at });
    const lines = [
      // 600 tokens in 6s = 100 tok/s
      planner(1, '2026-10-16T09:00:00Z', 600),
      generic(2, '2026-10-16T09:00:06Z'),
      // 800 tokens in 10s = 80 tok/s
      planner(3, '2026-10-16T09:00:10Z', 800),
      generic(4, '2026-10-16T09:00:20Z'),
      // 1500 tokens, then about 150s waiting for approval: 165s gap = 9.1 tok/s, above the 8 tok/s floor
      planner(5, '2026-10-16T09:00:25Z', 1500),
      generic(6, '2026-10-16T09:03:10Z'),
    ];
    writeFileSync(join(convDir, 'transcript.jsonl'), lines.join('\n') + '\n', 'utf-8');

    const metrics = await getConversationMetrics('conv-tps-long-wait', 'auto');
    assert.equal(metrics.turns[2].e2eSec, 165);
    assert.equal(metrics.turns[2].stalled, true);
    // Time-weighted over all three turns would be 2900 / 181 = 16 tok/s
    assert.equal(metrics.summary.avgE2eTps, 1400 / 16);
    assert.equal(metrics.modelStats[0].avgE2eTps, 1400 / 16);
    // Last measured speed falls back to Turn 2 (80 tok/s), ignoring stalled Turn 3 (9.1 tok/s)
    assert.equal(metrics.summary.lastE2eTps, 80);
  });

  it('keeps slower-model turns in session avgE2eTps when mixed with a much faster model', async () => {
    const convDir = join(
      tmpRoot,
      'antigravity',
      'brain',
      'conv-tps-multimodel',
      '.system_generated',
      'logs'
    );
    mkdirSync(convDir, { recursive: true });
    const switchModel = (step, from, to) =>
      JSON.stringify({
        step_index: step,
        type: 'USER_INPUT',
        content: `<USER_SETTINGS_CHANGE>\nThe user changed setting \`Model Selection\` from ${from} to ${to}.\n</USER_SETTINGS_CHANGE>`,
      });
    const planner = (step, at, out) =>
      JSON.stringify({
        step_index: step,
        type: 'PLANNER_RESPONSE',
        created_at: at,
        input_tokens: 5000,
        cache_read_tokens: 20000,
        output_tokens: out,
      });
    const generic = (step, at) => JSON.stringify({ step_index: step, type: 'GENERIC', created_at: at });

    const lines = [
      switchModel(0, 'None', 'Gemini 3.8 Flash'),
      // 5 Flash turns: 720 tokens in 4s = 180 tok/s each (3600 tok / 20s)
      planner(1, '2026-10-16T10:00:00Z', 720),
      generic(2, '2026-10-16T10:00:04Z'),
      planner(3, '2026-10-16T10:00:05Z', 720),
      generic(4, '2026-10-16T10:00:09Z'),
      planner(5, '2026-10-16T10:00:10Z', 720),
      generic(6, '2026-10-16T10:00:14Z'),
      planner(7, '2026-10-16T10:00:15Z', 720),
      generic(8, '2026-10-16T10:00:19Z'),
      planner(9, '2026-10-16T10:00:20Z', 720),
      generic(10, '2026-10-16T10:00:24Z'),
      switchModel(11, 'Gemini 3.8 Flash', 'Claude Opus 5.5 (Thinking)'),
      // 4 Opus turns: 450 tokens in 10s = 45 tok/s each (1800 tok / 40s)
      planner(12, '2026-10-16T10:01:00Z', 450),
      generic(13, '2026-10-16T10:01:10Z'),
      planner(14, '2026-10-16T10:01:15Z', 450),
      generic(15, '2026-10-16T10:01:25Z'),
      planner(16, '2026-10-16T10:01:30Z', 450),
      generic(17, '2026-10-16T10:01:40Z'),
      planner(18, '2026-10-16T10:01:45Z', 450),
      generic(19, '2026-10-16T10:01:55Z'),
    ];
    writeFileSync(join(convDir, 'transcript.jsonl'), lines.join('\n') + '\n', 'utf-8');

    const metrics = await getConversationMetrics('conv-tps-multimodel', 'auto');
    const byModel = new Map(metrics.modelStats.map((m) => [m.model, m]));
    assert.equal(byModel.get('Gemini 3.8 Flash').avgE2eTps, 180);
    assert.equal(byModel.get('Claude Opus 5.5 (Thinking)').avgE2eTps, 45);
    // Pooled across both models: (3600 + 1800) / (20 + 40) = 90 tok/s (not 180 tok/s)
    assert.equal(metrics.summary.avgE2eTps, 90);
  });

  it('filters approval stalls even when a majority of turns waited, and preserves >180s active turns', async () => {
    const convDir = join(
      tmpRoot,
      'antigravity',
      'brain',
      'conv-tps-majority-wait',
      '.system_generated',
      'logs'
    );
    mkdirSync(convDir, { recursive: true });
    const planner = (step, at, out) =>
      JSON.stringify({
        step_index: step,
        type: 'PLANNER_RESPONSE',
        created_at: at,
        input_tokens: 2000,
        cache_read_tokens: 40000,
        output_tokens: out,
      });
    const generic = (step, at) => JSON.stringify({ step_index: step, type: 'GENERIC', created_at: at });

    const lines = [
      // Turn 1: 600 tokens in 6s = 100 tok/s (auto-approved read)
      planner(1, '2026-10-16T11:00:00Z', 600),
      generic(2, '2026-10-16T11:00:06Z'),
      // Turn 2: 500 tokens in 40s = 12.5 tok/s (waited ~35s for approval)
      planner(3, '2026-10-16T11:00:10Z', 500),
      generic(4, '2026-10-16T11:00:50Z'),
      // Turn 3: 500 tokens in 50s = 10 tok/s (waited ~45s for approval)
      planner(5, '2026-10-16T11:01:00Z', 500),
      generic(6, '2026-10-16T11:01:50Z'),
      // Turn 4: long 200s reasoning turn at 80 tok/s (16,000 tokens, >180s)
      planner(7, '2026-10-16T11:02:00Z', 16000),
      generic(8, '2026-10-16T11:05:20Z'),
    ];
    writeFileSync(join(convDir, 'transcript.jsonl'), lines.join('\n') + '\n', 'utf-8');

    const metrics = await getConversationMetrics('conv-tps-majority-wait', 'auto');
    assert.equal(metrics.turns[3].e2eSec, 200);
    // Keeps Turn 1 (600 / 6s) and Turn 4 (16000 / 200s), dropping the two approval waits
    assert.equal(metrics.summary.avgE2eTps, 16600 / 206);
  });

  it('filters transcript-fallback turns in RPC mode and includes cacheWriteTokens in cache hit rate', async () => {
    const convDir = join(
      tmpRoot,
      'antigravity',
      'brain',
      'conv-rpc-fallback',
      '.system_generated',
      'logs'
    );
    mkdirSync(convDir, { recursive: true });
    const lines = [
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-10-16T12:00:00Z',
        input_tokens: 10000,
        cache_read_tokens: 60000,
        output_tokens: 600,
      }),
      JSON.stringify({ step_index: 2, type: 'GENERIC', created_at: '2026-10-16T12:00:06Z' }),
      JSON.stringify({
        step_index: 3,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-10-16T12:00:10Z',
        input_tokens: 10000,
        cache_read_tokens: 60000,
        output_tokens: 800,
      }),
      JSON.stringify({ step_index: 4, type: 'GENERIC', created_at: '2026-10-16T12:00:20Z' }),
      // Turn 3 waited ~150s for approval in transcript (1500 / 165s = 9.1 tok/s)
      JSON.stringify({
        step_index: 5,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-10-16T12:00:25Z',
        input_tokens: 10000,
        cache_read_tokens: 60000,
        output_tokens: 1500,
      }),
      JSON.stringify({ step_index: 6, type: 'GENERIC', created_at: '2026-10-16T12:03:10Z' }),
    ];
    writeFileSync(join(convDir, 'transcript.jsonl'), lines.join('\n') + '\n', 'utf-8');

    const lsServer = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          generatorMetadata: [
            {
              stepIndices: [1],
              chatModel: {
                modelDisplayName: 'Claude Opus 5.5 (Thinking)',
                timeToFirstToken: '1.0s',
                streamingDuration: '5.0s',
                usage: {
                  inputTokens: 10000,
                  cacheReadTokens: 60000,
                  cacheWriteTokens: 30000,
                  outputTokens: 600,
                  thinkingOutputTokens: 200,
                  responseOutputTokens: 400,
                },
              },
            },
            {
              stepIndices: [3],
              chatModel: {
                modelDisplayName: 'Claude Opus 5.5 (Thinking)',
                timeToFirstToken: '2.0s',
                streamingDuration: '8.0s',
                usage: {
                  inputTokens: 10000,
                  cacheReadTokens: 60000,
                  cacheWriteTokens: 30000,
                  outputTokens: 800,
                  thinkingOutputTokens: 300,
                  responseOutputTokens: 500,
                },
              },
            },
            {
              // Missing RPC durations and usage -> falls back to transcript (165s approval wait)
              stepIndices: [5],
              chatModel: {
                modelDisplayName: 'Claude Opus 5.5 (Thinking)',
              },
            },
          ],
        })
      );
    });

    await new Promise((r) => lsServer.listen(0, '127.0.0.1', r));
    process.env.ANTIGRAVITY_LS_ADDRESS = `127.0.0.1:${lsServer.address().port}`;
    process.env.ANTIGRAVITY_CSRF_TOKEN = 'test-csrf';
    try {
      const metrics = await getConversationMetrics('conv-rpc-fallback', 'auto');
      assert.equal(metrics.rpcConnected, true);
      // Turn 1 & 2 each have 60k cached / (10k + 60k + 30k) = 60% cache hit rate
      assert.equal(metrics.turns[0].totalInput, 100000);
      assert.equal(metrics.turns[0].cacheHitRate, 60);
      // Session input: 30k uncached + 180k cached + 60k cacheWrite = 270k -> 180k / 270k = 66.67%
      assert.ok(Math.abs(metrics.summary.sessionCacheHitRate - (180000 / 270000) * 100) < 1e-9);
      // Turn 3's 165s transcript-fallback stall is filtered out; avgE2eTps uses Turns 1 & 2 (1400 / 16s)
      assert.equal(metrics.summary.avgE2eTps, 1400 / 16);
      // Visible TPS uses only RPC turns with token split: (400 + 500) / 16s
      assert.equal(metrics.summary.avgVisibleE2eTps, 900 / 16);
      // Net cache savings account for Claude's 1.25x cache write premium (cost + saved === noCacheTotalCost)
      assert.ok(
        Math.abs(
          metrics.summary.totalCostUsd +
            metrics.summary.savedByCacheUsd -
            metrics.summary.noCacheTotalCostUsd
        ) < 1e-9
      );
    } finally {
      delete process.env.ANTIGRAVITY_LS_ADDRESS;
      delete process.env.ANTIGRAVITY_CSRF_TOKEN;
      await new Promise((r) => lsServer.close(r));
    }
  });

  it('preserves historical transcript turns when RPC only covers recent post-reload turns, and nets cache write costs', async () => {
    const convDir = join(
      tmpRoot,
      'antigravity',
      'brain',
      'conv-rpc-partial',
      '.system_generated',
      'logs'
    );
    mkdirSync(convDir, { recursive: true });
    const lines = [
      // Historical Turn 1 before reload: two model switches in a single USER_INPUT (None -> Pro -> Flash)
      JSON.stringify({
        step_index: 0,
        type: 'USER_INPUT',
        content:
          '<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Gemini 3.1 Pro (High).\n</USER_SETTINGS_CHANGE>\n' +
          '<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from Gemini 3.1 Pro (High) to Gemini 3.8 Flash.\n</USER_SETTINGS_CHANGE>',
      }),
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-10-16T13:00:00Z',
        input_tokens: 20000,
        cache_read_tokens: 0,
        output_tokens: 800,
      }),
      JSON.stringify({ step_index: 2, type: 'GENERIC', created_at: '2026-10-16T13:00:05Z' }),
      // Historical Turn 2: 1s timestamp rounding spike (180 tok in 1s = 180 tok/s vs Turn 1's 160 tok/s)
      JSON.stringify({
        step_index: 3,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-10-16T13:00:10Z',
        input_tokens: 5000,
        cache_read_tokens: 18000,
        output_tokens: 180,
      }),
      JSON.stringify({ step_index: 4, type: 'GENERIC', created_at: '2026-10-16T13:00:11Z' }),
      // Post-reload Turn 3 & Turn 4 on Claude Opus 5.5
      JSON.stringify({
        step_index: 5,
        type: 'USER_INPUT',
        content:
          '<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from Gemini 3.8 Flash to Claude Opus 5.5 (Thinking).\n</USER_SETTINGS_CHANGE>',
      }),
      JSON.stringify({
        step_index: 6,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-10-16T13:05:00Z',
        input_tokens: 0,
        cache_read_tokens: 0,
        output_tokens: 500,
      }),
      JSON.stringify({ step_index: 7, type: 'GENERIC', created_at: '2026-10-16T13:05:10Z' }),
      JSON.stringify({
        step_index: 8,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-10-16T13:05:15Z',
        input_tokens: 0,
        cache_read_tokens: 100000,
        output_tokens: 500,
      }),
    ];
    writeFileSync(join(convDir, 'transcript.jsonl'), lines.join('\n') + '\n', 'utf-8');

    // RPC only has post-reload steps 6 and 8:
    // Step 6 writes 100k cache ($5/M = $0.50 vs $0.40 uncached -> -$0.10 premium)
    // Step 8 reads 100k cache ($0.20/M = $0.02 vs $0.40 uncached -> +$0.38 gross, +$0.28 net)
    const lsServer = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          generatorMetadata: [
            {
              stepIndices: [6],
              chatModel: {
                modelDisplayName: 'Claude Opus 5.5 (Thinking)',
                timeToFirstToken: '1.0s',
                streamingDuration: '9.0s',
                usage: {
                  inputTokens: 0,
                  cacheReadTokens: 0,
                  cacheWriteTokens: 100000,
                  outputTokens: 500,
                  thinkingOutputTokens: 200,
                  responseOutputTokens: 300,
                },
              },
            },
            {
              stepIndices: [8],
              chatModel: {
                modelDisplayName: 'Claude Opus 5.5 (Thinking)',
                timeToFirstToken: '0.8s',
                streamingDuration: '9.2s',
                usage: {
                  inputTokens: 0,
                  cacheReadTokens: 100000,
                  cacheWriteTokens: 0,
                  outputTokens: 500,
                  thinkingOutputTokens: 200,
                  responseOutputTokens: 300,
                },
              },
            },
          ],
        })
      );
    });

    await new Promise((r) => lsServer.listen(0, '127.0.0.1', r));
    process.env.ANTIGRAVITY_LS_ADDRESS = `127.0.0.1:${lsServer.address().port}`;
    process.env.ANTIGRAVITY_CSRF_TOKEN = 'test-csrf';
    try {
      const metrics = await getConversationMetrics('conv-rpc-partial', 'auto');
      // All 4 turns (2 historical transcript + 2 live RPC) are preserved in step order
      assert.equal(metrics.summary.turnCount, 4);
      assert.equal(metrics.turns[0].model, 'Gemini 3.8 Flash');
      assert.equal(metrics.turns[0].source, 'transcript');
      assert.equal(metrics.turns[2].model, 'Claude Opus 5.5 (Thinking)');
      assert.equal(metrics.turns[2].source, 'rpc');
      assert.equal(metrics.model, 'Claude Opus 5.5 (Thinking)');

      // 1-second quantization spike on Turn 2 (180 tok/s) is skipped in favor of >=2s Turn 1 (160 tok/s)
      assert.equal(metrics.summary.peakE2eTps, 160);

      // Opus net cache savings = ($0.40 + $0.40) - ($0.50 + $0.02) = $0.28 (not $0.38)
      const opusStats = metrics.modelStats.find((m) => m.model === 'Claude Opus 5.5 (Thinking)');
      assert.ok(Math.abs(opusStats.savedByCacheUsd - 0.28) < 1e-9);
    } finally {
      delete process.env.ANTIGRAVITY_LS_ADDRESS;
      delete process.env.ANTIGRAVITY_CSRF_TOKEN;
      await new Promise((r) => lsServer.close(r));
    }
  });

  it('merges placeholder and display-only modelIds for Orchestrator (Neon) and prices Gemini 4 Neon without >200k tier', async () => {
    const convDir = join(
      tmpRoot,
      'antigravity',
      'brain',
      'conv-neon-placeholder',
      '.system_generated',
      'logs'
    );
    mkdirSync(convDir, { recursive: true });
    const lines = [
      // Historical transcript turn before reload: display-only modelId 'Orchestrator (Neon)'
      JSON.stringify({
        step_index: 0,
        type: 'USER_INPUT',
        content:
          '<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Orchestrator (Neon).\n</USER_SETTINGS_CHANGE>',
      }),
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-20T09:00:00Z',
        input_tokens: 10000,
        cache_read_tokens: 40000,
        output_tokens: 500,
      }),
      JSON.stringify({ step_index: 2, type: 'GENERIC', created_at: '2026-11-20T09:00:05Z' }),
      // RPC turns: step 3 & 5 (Neon), step 4 (Hydrogen), step 6 (in-flight/empty Neon with MODEL_PLACEHOLDER_M537)
      JSON.stringify({
        step_index: 3,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-20T09:01:00Z',
        input_tokens: 50000,
        cache_read_tokens: 200000,
        output_tokens: 10000,
      }),
      JSON.stringify({ step_index: 4, type: 'PLANNER_RESPONSE', created_at: '2026-11-20T09:02:00Z' }),
      JSON.stringify({ step_index: 5, type: 'PLANNER_RESPONSE', created_at: '2026-11-20T09:03:00Z' }),
      JSON.stringify({ step_index: 6, type: 'PLANNER_RESPONSE', created_at: '2026-11-20T09:04:00Z' }),
    ];
    writeFileSync(join(convDir, 'transcript.jsonl'), lines.join('\n') + '\n', 'utf-8');

    const lsServer = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          generatorMetadata: [
            {
              stepIndices: [3],
              chatModel: {
                model: 'MODEL_PLACEHOLDER_M537',
                modelDisplayName: 'Orchestrator (Neon)',
                responseModel: 'gemini-pro-orchestrator-neon',
                timeToFirstToken: '0.8s',
                streamingDuration: '4.2s',
                usage: {
                  inputTokens: 50000,
                  cacheReadTokens: 200000,
                  outputTokens: 10000,
                },
              },
            },
            {
              stepIndices: [4],
              chatModel: {
                model: 'MODEL_PLACEHOLDER_M400',
                modelDisplayName: 'Gemini 4 Hydrogen (Orchestrator)',
                responseModel: 'gemini-flash-worker-agy',
                timeToFirstToken: '0.4s',
                streamingDuration: '2.6s',
                usage: {
                  inputTokens: 10000,
                  cacheReadTokens: 90000,
                  outputTokens: 600,
                },
              },
            },
            {
              stepIndices: [5],
              chatModel: {
                model: 'MODEL_PLACEHOLDER_M537',
                modelDisplayName: 'Orchestrator (Neon)',
                responseModel: 'gemini-pro-orchestrator-neon',
                timeToFirstToken: '0.6s',
                streamingDuration: '3.4s',
                usage: {
                  inputTokens: 10000,
                  cacheReadTokens: 90000,
                  outputTokens: 800,
                },
              },
            },
            {
              // Empty/in-flight turn with no responseModel or usage -> falls back to MODEL_PLACEHOLDER_M537
              stepIndices: [6],
              chatModel: {
                model: 'MODEL_PLACEHOLDER_M537',
                modelDisplayName: 'Orchestrator (Neon)',
              },
            },
          ],
        })
      );
    });

    await new Promise((r) => lsServer.listen(0, '127.0.0.1', r));
    process.env.ANTIGRAVITY_LS_ADDRESS = `127.0.0.1:${lsServer.address().port}`;
    process.env.ANTIGRAVITY_CSRF_TOKEN = 'test-csrf';
    try {
      const metrics = await getConversationMetrics('conv-neon-placeholder', 'auto');
      assert.equal(metrics.summary.turnCount, 5);
      assert.equal(metrics.summary.modelCount, 2);
      assert.equal(metrics.modelStats.length, 2);
      // 250k input turn on Neon must NOT trigger >200k tier
      assert.equal(metrics.summary.highTierTurnCount, 0);
      assert.equal(metrics.summary.priceTierThreshold, 0);
      assert.equal(metrics.summary.pricingProfileKey, 'gemini_4_neon');

      const neonStats = metrics.modelStats.find((m) => m.model === 'Orchestrator (Neon)');
      assert.ok(neonStats);
      assert.equal(neonStats.modelId, 'gemini-pro-orchestrator-neon');
      assert.equal(neonStats.pricingProfileKey, 'gemini_4_neon');
      // Historical step 1 + RPC steps 3, 5, 6 = 4 turns merged under gemini-pro-orchestrator-neon
      assert.equal(neonStats.turnCount, 4);
      assert.equal(neonStats.highTierTurnCount, 0);

      const hydrogenStats = metrics.modelStats.find(
        (m) => m.model === 'Gemini 4 Hydrogen (Orchestrator)'
      );
      assert.ok(hydrogenStats);
      assert.equal(hydrogenStats.modelId, 'gemini-flash-worker-agy');
      assert.equal(hydrogenStats.pricingProfileKey, 'gemini_4_hydrogen');
      assert.equal(hydrogenStats.turnCount, 1);
    } finally {
      delete process.env.ANTIGRAVITY_LS_ADDRESS;
      delete process.env.ANTIGRAVITY_CSRF_TOKEN;
      await new Promise((r) => lsServer.close(r));
    }
  });

  it('keeps distinct concrete backend modelIds separate and prices placeholder-only turns by display name', async () => {
    const convDir = join(
      tmpRoot,
      'antigravity',
      'brain',
      'conv-modelid-edge',
      '.system_generated',
      'logs'
    );
    mkdirSync(convDir, { recursive: true });
    writeFileSync(
      join(convDir, 'transcript.jsonl'),
      [
        JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', created_at: '2026-11-20T09:10:00Z' }),
        JSON.stringify({ step_index: 2, type: 'PLANNER_RESPONSE', created_at: '2026-11-20T09:11:00Z' }),
        JSON.stringify({ step_index: 3, type: 'PLANNER_RESPONSE', created_at: '2026-11-20T09:12:00Z' }),
        JSON.stringify({ step_index: 4, type: 'PLANNER_RESPONSE', created_at: '2026-11-20T09:13:00Z' }),
      ].join('\n') + '\n',
      'utf-8'
    );

    const lsServer = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          generatorMetadata: [
            {
              stepIndices: [1],
              chatModel: {
                modelDisplayName: 'Shared Display',
                responseModel: 'backend-route-a',
                usage: { inputTokens: 1000, cacheReadTokens: 0, outputTokens: 100 },
              },
            },
            {
              stepIndices: [2],
              chatModel: {
                modelDisplayName: 'Shared Display',
                responseModel: 'backend-route-b',
                usage: { inputTokens: 1000, cacheReadTokens: 0, outputTokens: 100 },
              },
            },
            {
              stepIndices: [3],
              chatModel: {
                model: 'MODEL_PLACEHOLDER_M999',
                modelDisplayName: 'Shared Display',
              },
            },
            {
              // Only MODEL_PLACEHOLDER_M537 for this display name -> stays one group and prices via display name
              stepIndices: [4],
              chatModel: {
                model: 'MODEL_PLACEHOLDER_M537',
                modelDisplayName: 'Orchestrator (Neon)',
                usage: { inputTokens: 50000, cacheReadTokens: 200000, outputTokens: 10000 },
              },
            },
          ],
        })
      );
    });

    await new Promise((r) => lsServer.listen(0, '127.0.0.1', r));
    process.env.ANTIGRAVITY_LS_ADDRESS = `127.0.0.1:${lsServer.address().port}`;
    process.env.ANTIGRAVITY_CSRF_TOKEN = 'test-csrf';
    try {
      const metrics = await getConversationMetrics('conv-modelid-edge', 'auto');
      // backend-route-a, backend-route-b, MODEL_PLACEHOLDER_M999 (not guessed), plus Orchestrator (Neon)
      assert.equal(metrics.modelStats.length, 4);
      assert.ok(metrics.modelStats.some((m) => m.modelId === 'backend-route-a'));
      assert.ok(metrics.modelStats.some((m) => m.modelId === 'backend-route-b'));
      assert.ok(metrics.modelStats.some((m) => m.modelId === 'MODEL_PLACEHOLDER_M999'));
      const neonOnly = metrics.modelStats.find((m) => m.model === 'Orchestrator (Neon)');
      assert.ok(neonOnly);
      assert.equal(neonOnly.modelId, 'MODEL_PLACEHOLDER_M537');
      assert.equal(neonOnly.pricingProfileKey, 'gemini_4_neon');
      assert.ok(Math.abs(neonOnly.costUsd - 0.33) < 1e-9);
    } finally {
      delete process.env.ANTIGRAVITY_LS_ADDRESS;
      delete process.env.ANTIGRAVITY_CSRF_TOKEN;
      await new Promise((r) => lsServer.close(r));
    }
  });
});

describe('CLI StatusLine Renderer (statusline.mjs)', () => {
  const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

  it('splits model name and thinking effort cleanly', () => {
    assert.deepEqual(splitModelAndEffort('models/Gemini 3.1 Pro (High)'), {
      model: 'Gemini 3.1 Pro',
      effort: 'High',
    });
    assert.deepEqual(splitModelAndEffort('Gemini 4 Argon', 'max'), {
      model: 'Gemini 4 Argon',
      effort: 'max',
    });
    assert.deepEqual(splitModelAndEffort('Orchestrator (Carbon)', 'medium'), {
      model: 'Orchestrator (Carbon)',
      effort: 'medium',
    });
    assert.deepEqual(splitModelAndEffort('Orchestrator (Carbon)'), {
      model: 'Orchestrator (Carbon)',
      effort: '',
    });
    assert.deepEqual(splitModelAndEffort('Orchestrator (Neon)'), {
      model: 'Orchestrator (Neon)',
      effort: '',
    });
    assert.deepEqual(splitModelAndEffort('Gemini 4 Neon (Extra High)'), {
      model: 'Gemini 4 Neon',
      effort: 'Extra High',
    });
  });

  it('resolves git branch from vcs payload, worktree payload, .git directory, and worktree .git file', () => {
    assert.deepEqual(resolveGitBranch({ vcs: { branch: 'feat/pulse', dirty: true } }), {
      branch: 'feat/pulse',
      dirty: true,
    });
    assert.deepEqual(resolveGitBranch({ worktree: { branch: 'wt-feature', dirty: true } }), {
      branch: 'wt-feature',
      dirty: true,
    });

    const tmp = mkdtempSync(join(tmpdir(), 'agy-git-test-'));
    try {
      const repoDir = join(tmp, 'repo');
      const subDir = join(repoDir, 'packages', 'ui');
      mkdirSync(join(repoDir, '.git'), { recursive: true });
      mkdirSync(subDir, { recursive: true });
      writeFileSync(join(repoDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
      assert.deepEqual(resolveGitBranch({ workspace: { current_dir: subDir } }), {
        branch: 'main',
        dirty: false,
      });

      const wtDir = join(tmp, 'worktree');
      const gitDir = join(tmp, 'actual-gitdir');
      mkdirSync(wtDir, { recursive: true });
      mkdirSync(gitDir, { recursive: true });
      writeFileSync(join(wtDir, '.git'), 'gitdir: ../actual-gitdir\n');
      writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/wt-branch\n');
      assert.deepEqual(resolveGitBranch({ cwd: wtDir }), {
        branch: 'wt-branch',
        dirty: false,
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('renders model, effort, branch, turns + compact count, context, cache, cost, and filtered avg TPS', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'agy-statusline-test-'));
    try {
      const tPath = join(tmp, 'transcript.jsonl');
      const lines = [
        JSON.stringify({ step_index: 0, type: 'CHECKPOINT', created_at: '2026-10-16T08:00:00Z' }),
        JSON.stringify({
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          created_at: '2026-10-16T08:00:01Z',
          input_tokens: 20000,
          cache_read_tokens: 80000,
          output_tokens: 500,
        }),
        JSON.stringify({ step_index: 2, type: 'GENERIC', created_at: '2026-10-16T08:00:06Z' }),
      ];
      writeFileSync(tPath, lines.join('\n') + '\n');

      const out = await formatStatusLine({
        conversation_id: 'conv-statusline-1',
        transcript_path: pathToFileURL(tPath).href,
        model: { display_name: 'Gemini 4 Argon', effort: 'high' },
        vcs: { branch: 'feat/statusline', dirty: true },
        context_window: {
          current_usage: { input_tokens: 20000, cache_read_input_tokens: 80000, output_tokens: 500 },
          context_window_size: 1048576,
        },
      });
      const plain = stripAnsi(out);
      assert.match(plain, /^Gemini 4 Argon \[high\] │ ⎇ feat\/statusline\* │ Turns: 1 \(Compact: 1\)/);
      assert.match(plain, /Ctx: 100\.0k\/1\.05M \(9\.5%\)/);
      assert.match(plain, /Cache: 80\.0% \(80\.0k\)/);
      assert.match(plain, /ΣTok: 100\.5k \(\$0\.053\)/);
      assert.match(plain, /Avg: ~100 tok\/s$/);
      assert.doesNotMatch(plain, /\bOut:/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('does not leak another conversation transcript when conversation_id is missing and avoids cross-model effort mismatch', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'agy-statusline-settings-'));
    try {
      const settingsPath = join(tmp, 'settings.json');
      writeFileSync(settingsPath, JSON.stringify({ model: 'Gemini 3.1 Pro (High)' }));

      const out = await formatStatusLine(
        {
          model: { display_name: 'Claude Sonnet 4.6' },
          vcs: { branch: 'main', dirty: false },
          context_window: {
            current_usage: { input_tokens: 10000, cache_read_input_tokens: 30000, output_tokens: 1000 },
            context_window_size: 1048576,
          },
        },
        { settingsPath }
      );
      const plain = stripAnsi(out);
      // Should NOT attach [High] from Gemini 3.1 Pro onto Claude Sonnet 4.6
      assert.match(plain, /^Claude Sonnet 4\.6 │ ⎇ main │ Turns: 0 \(Compact: 0\)/);
      // Without a transcript there is no session total to show.
      assert.doesNotMatch(plain, /ΣTok/);
      assert.match(plain, /Cache: 75\.0% \(30\.0k\) │ Avg: -- tok\/s$/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
  it('pairs the host used_percentage with total_input + total_output and counts cache writes', async () => {
    // Payload from https://antigravity.google/docs/cli/statusline
    const out = await formatStatusLine({
      model: { display_name: 'Gemini 3.1 Pro' },
      context_window: {
        total_input_tokens: 88244,
        total_output_tokens: 61074,
        context_window_size: 1048576,
        used_percentage: 14.24,
        current_usage: {
          input_tokens: 63382,
          output_tokens: 346,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 20857,
        },
      },
    });
    assert.match(stripAnsi(out), /Ctx: 149\.3k\/1\.05M \(14\.2%\)/);
    assert.match(stripAnsi(out), /Cache: 24\.8% \(20\.9k\)/);

    for (const used_percentage of [0, 'n/a']) {
      const recomputed = await formatStatusLine({
        context_window: { total_input_tokens: 104858, context_window_size: 1048576, used_percentage },
      });
      assert.match(stripAnsi(recomputed), /Ctx: 104\.9k\/1\.05M \(10\.0%\) \[█░░░░░░░\]/);
    }

    const withWrites = await formatStatusLine({
      model: { display_name: 'Claude Opus 4.7' },
      context_window: {
        context_window_size: 1000000,
        current_usage: {
          input_tokens: 10000,
          cache_creation_input_tokens: 30000,
          cache_read_input_tokens: 60000,
        },
      },
    });
    assert.match(stripAnsi(withWrites), /Ctx: 100\.0k\/1\.00M \(10\.0%\)/);
    assert.match(stripAnsi(withWrites), /Cache: 60\.0% \(60\.0k\)/);
  });

  it('renders without waiting for EOF when the CLI keeps stdin open', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'agy-statusline-stdin-'));
    const script = fileURLToPath(new URL('../sidecars/context-monitor/statusline.mjs', import.meta.url));
    const run = (payload) =>
      new Promise((resolveRun, rejectRun) => {
        const child = spawn(process.execPath, [script], {
          cwd: tmp,
          env: { PATH: process.env.PATH, AGY_GEMINI_ROOT: tmp, AGY_CLI_SETTINGS_PATH: join(tmp, 's.json') },
        });
        let stdout = '';
        child.stdout.on('data', (c) => (stdout += c));
        const killer = setTimeout(() => {
          child.kill();
          rejectRun(new Error('statusline.mjs did not exit'));
        }, 4000);
        child.on('exit', (code) => {
          clearTimeout(killer);
          resolveRun({ code, stdout });
        });
        if (payload) child.stdin.write(payload); // never end()
      });
    try {
      const rendered = await run(JSON.stringify({ model: { display_name: 'Gemini 3.1 Pro' } }));
      assert.equal(rendered.code, 0);
      assert.match(stripAnsi(rendered.stdout), /^Gemini 3\.1 Pro │ Turns: 0/);

      const silent = await run('');
      assert.equal(silent.code, 0);
      assert.equal(silent.stdout, '');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('expands tilde transcript_path in statusline and supports cached metrics + read-only CLI summary', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'agy-metrics-cli-'));
    const prevHome = process.env.HOME;
    const prevRoot = process.env.AGY_GEMINI_ROOT;
    try {
      const convDir = join(tmp, 'antigravity', 'brain', 'conv-cache-cli', '.system_generated', 'logs');
      mkdirSync(convDir, { recursive: true });
      const tPath = join(convDir, 'transcript.jsonl');
      const turn1 = JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-10-16T09:00:00Z',
        input_tokens: 10000,
        cache_read_tokens: 40000,
        output_tokens: 500,
      });
      const gen1 = JSON.stringify({
        step_index: 2,
        type: 'GENERIC',
        created_at: '2026-10-16T09:00:05Z',
      });
      writeFileSync(tPath, `${turn1}\n${gen1}\n`, 'utf-8');

      process.env.HOME = tmp;
      const tildePath = '~/antigravity/brain/conv-cache-cli/.system_generated/logs/transcript.jsonl';
      const statusOut = await formatStatusLine(
        {
          conversation_id: 'conv-cache-cli',
          transcript_path: tildePath,
          model: { display_name: 'Orchestrator (Carbon)' },
        },
        { cwd: tmp }
      );
      assert.match(stripAnsi(statusOut), /^Orchestrator \(Carbon\) │ Turns: 1/);

      process.env.AGY_GEMINI_ROOT = tmp;
      const first = await getConversationMetrics('conv-cache-cli', 'auto', { includeRecent: false });
      const second = await getConversationMetrics('conv-cache-cli', 'auto', { includeRecent: false });
      assert.deepEqual(first.recentConversations, []);
      assert.equal(typeof first.etag, 'string');
      assert.equal(first.etag, second.etag);

      const turn2 = JSON.stringify({
        step_index: 3,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-10-16T09:00:10Z',
        input_tokens: 12000,
        cache_read_tokens: 48000,
        output_tokens: 600,
      });
      writeFileSync(tPath, `${turn1}\n${gen1}\n${turn2}\n`, 'utf-8');

      const third = await getConversationMetrics('conv-cache-cli', 'auto', { includeRecent: false });
      assert.equal(third.summary.turnCount, 2);
      assert.notEqual(third.etag, first.etag);

      const metricsScript = fileURLToPath(new URL('../sidecars/context-monitor/metrics.mjs', import.meta.url));
      const textOut = execFileSync(process.execPath, [metricsScript, '--transcript', tPath], {
        encoding: 'utf-8',
      });
      assert.match(textOut, /Turns: 2/);
      assert.match(textOut, /Prompt Cache: 80\.0% last turn/);

      const jsonOut = JSON.parse(
        execFileSync(
          process.execPath,
          [metricsScript, '--transcript', tPath, '--conversation', 'conv-cache-cli', '--json'],
          { encoding: 'utf-8' }
        )
      );
      assert.equal(jsonOut.summary.turnCount, 2);
      assert.equal(jsonOut.etag, third.etag);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevRoot === undefined) delete process.env.AGY_GEMINI_ROOT;
      else process.env.AGY_GEMINI_ROOT = prevRoot;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('labels pooled average speed as Avg(Nm) when multiple models are used in one session', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'agy-statusline-multimodel-'));
    try {
      const tPath = join(tmp, 'transcript.jsonl');
      const switchModel = (step, from, to) =>
        JSON.stringify({
          step_index: step,
          type: 'USER_INPUT',
          content: `<USER_SETTINGS_CHANGE>\nThe user changed setting \`Model Selection\` from ${from} to ${to}.\n</USER_SETTINGS_CHANGE>`,
        });
      const planner = (step, at, out) =>
        JSON.stringify({
          step_index: step,
          type: 'PLANNER_RESPONSE',
          created_at: at,
          input_tokens: 5000,
          cache_read_tokens: 20000,
          output_tokens: out,
        });
      const generic = (step, at) => JSON.stringify({ step_index: step, type: 'GENERIC', created_at: at });
      const lines = [
        switchModel(0, 'None', 'Gemini 3.8 Flash'),
        // Flash turn: 720 tokens in 4s = 180 tok/s
        planner(1, '2026-10-16T10:00:00Z', 720),
        generic(2, '2026-10-16T10:00:04Z'),
        switchModel(3, 'Gemini 3.8 Flash', 'Claude Opus 5.5 (Thinking)'),
        // Opus turn: 720 tokens in 12s = 60 tok/s; pooled = 1440 / 16 = 90 tok/s
        planner(4, '2026-10-16T10:01:00Z', 720),
        generic(5, '2026-10-16T10:01:12Z'),
      ];
      writeFileSync(tPath, lines.join('\n') + '\n', 'utf-8');

      const out = await formatStatusLine({
        conversation_id: 'conv-statusline-multimodel',
        transcript_path: pathToFileURL(tPath).href,
        model: { display_name: 'Claude Opus 5.5 (Thinking)' },
        context_window: {
          current_usage: { input_tokens: 5000, cache_read_input_tokens: 20000, output_tokens: 720 },
          context_window_size: 1048576,
        },
      });
      const plain = stripAnsi(out);
      assert.match(plain, /Turns: 2 \(Compact: 0\)/);
      assert.match(plain, /Avg\(2m\): ~90 tok\/s$/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
