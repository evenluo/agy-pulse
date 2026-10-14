import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

describe('Pricing & Cost Engine', () => {
  it('resolves model names to accurate pricing profiles in auto mode', () => {
    const cases = {
      'Gemini 4 Argon (High)': 'gemini_4_argon',
      'gemini-4-argon': 'gemini_4_argon',
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
    // The 225k turn runs on Claude Sonnet 4.6, which has no long-context tier.
    assert.equal(metrics.summary.highTierTurnCount, 0);
    assert.equal(metrics.summary.priceTierThreshold, 0);

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
});
