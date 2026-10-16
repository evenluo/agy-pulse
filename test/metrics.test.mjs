import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
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
    // The final turn has no duration, so the last measured speed is Turn 2's
    assert.equal(metrics.summary.lastE2eTps, 10);
  });

  it('drops a long turn that also waited for approval from transcript avgE2eTps', async () => {
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
    // Time-weighted over all three turns would be 2900 / 181 = 16 tok/s
    assert.equal(metrics.summary.avgE2eTps, 1400 / 16);
    assert.equal(metrics.modelStats[0].avgE2eTps, 1400 / 16);
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
  });

  it('resolves git branch from vcs payload, .git directory, and worktree .git file', () => {
    assert.deepEqual(resolveGitBranch({ vcs: { branch: 'feat/pulse', dirty: true } }), {
      branch: 'feat/pulse',
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
});
