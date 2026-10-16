#!/usr/bin/env node
// CLI statusLine renderer for Antigravity CLI (`agy`).
// Reads a StatusLineData JSON object from stdin and prints a single-line ANSI
// summary powered by ./metrics.mjs and ./pricing.mjs. Zero dependencies.

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConversationMetrics } from './metrics.mjs';
import { PRICING_PROFILES, computeTurnCost, resolvePricingProfileKey } from './pricing.mjs';

export function fmtCompact(n) {
  const v = Number(n || 0);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return `${Math.trunc(v)}`;
}

export function splitModelAndEffort(rawModel, explicitEffort = '') {
  let s = String(rawModel || '').trim();
  if (s.startsWith('models/')) {
    s = s.slice('models/'.length);
  }
  let effort = String(explicitEffort || '').trim();
  const m = s.match(/\(([^()]+)\)\s*$/);
  if (m) {
    const inParens = m[1].trim();
    s = s.slice(0, m.index).trim();
    if (!effort) effort = inParens;
  }
  return { model: s || 'Gemini', effort };
}

export function resolveGitBranch(data, fallbackCwd = process.cwd()) {
  const vcs = data?.vcs;
  if (vcs && typeof vcs === 'object' && !Array.isArray(vcs)) {
    const b = String(vcs.branch || '').trim();
    if (b) return { branch: b, dirty: Boolean(vcs.dirty) };
  }
  const ws = data?.workspace;
  let startDir = '';
  if (ws && typeof ws === 'object' && !Array.isArray(ws)) {
    startDir = String(ws.current_dir || ws.project_dir || '').trim();
  }
  if (!startDir) {
    startDir = String(data?.cwd || fallbackCwd || '').trim();
  }
  if (!startDir) return { branch: '', dirty: false };

  let cur = resolve(startDir);
  for (let depth = 0; depth < 12; depth++) {
    const gitEntry = join(cur, '.git');
    let headFile = '';
    try {
      if (existsSync(gitEntry)) {
        const st = statSync(gitEntry);
        if (st.isDirectory()) {
          headFile = join(gitEntry, 'HEAD');
        } else if (st.isFile()) {
          const line = readFileSync(gitEntry, 'utf-8').split(/\r?\n/)[0].trim();
          if (line.startsWith('gitdir:')) {
            const gdir = line.slice('gitdir:'.length).trim();
            const resolvedGitDir = isAbsolute(gdir) ? gdir : resolve(cur, gdir);
            headFile = join(resolvedGitDir, 'HEAD');
          }
        }
      }
    } catch {
      // ignore unreadable .git entry
    }
    if (headFile && existsSync(headFile)) {
      try {
        const ref = readFileSync(headFile, 'utf-8').split(/\r?\n/)[0].trim();
        if (ref.startsWith('ref: refs/heads/')) {
          return { branch: ref.slice('ref: refs/heads/'.length), dirty: false };
        }
        if (ref.startsWith('ref: ')) {
          return { branch: ref.split('/').pop() || '', dirty: false };
        }
        if (ref.length >= 7) {
          return { branch: ref.slice(0, 7), dirty: false };
        }
      } catch {
        // ignore unreadable HEAD
      }
      break;
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return { branch: '', dirty: false };
}

function defaultCliSettingsPath() {
  if (process.env.AGY_CLI_SETTINGS_PATH) {
    return resolve(process.env.AGY_CLI_SETTINGS_PATH);
  }
  const geminiRoot = process.env.AGY_GEMINI_ROOT || join(homedir(), '.gemini');
  return join(geminiRoot, 'antigravity-cli', 'settings.json');
}

function readSettingsModel(settingsPath = defaultCliSettingsPath()) {
  try {
    if (settingsPath && existsSync(settingsPath)) {
      const cfg = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      return String(cfg?.model || '').trim();
    }
  } catch {
    // ignore missing or malformed settings.json during statusline render
  }
  return '';
}

function normalizeTranscriptPath(rawPath) {
  const s = String(rawPath || '').trim();
  if (!s.startsWith('file://')) return s;
  try {
    return fileURLToPath(s);
  } catch {
    return s.replace(/^file:\/\//, '');
  }
}

export async function formatStatusLine(data, options = {}) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return '';

  const convId = String(data.conversation_id || data.session_id || '').trim();
  const rawTranscriptPath = normalizeTranscriptPath(data.transcript_path);

  const modelInfo = data.model;
  let stdinModel = '';
  let stdinEffort = '';
  if (modelInfo && typeof modelInfo === 'object' && !Array.isArray(modelInfo)) {
    stdinModel = String(modelInfo.display_name || modelInfo.id || '').trim();
    stdinEffort = String(modelInfo.effort || '').trim();
  } else if (typeof modelInfo === 'string') {
    stdinModel = modelInfo.trim();
  }

  const settingsModel = readSettingsModel(options.settingsPath);
  const fallbackModel = stdinModel || settingsModel || 'Gemini 3.1 Pro (High)';

  let metrics = options.metrics || null;
  if (!metrics) {
    const hasConvId = Boolean(convId && convId !== 'default');
    const hasTranscript = Boolean(rawTranscriptPath && existsSync(rawTranscriptPath));
    if (hasConvId || hasTranscript) {
      metrics = await getConversationMetrics(hasConvId ? convId : '', 'auto', {
        transcriptPath: rawTranscriptPath,
        fallbackModel,
      });
    }
  }

  const transcriptModel = metrics?.detectedModel || '';
  const rawModelStr = stdinModel || transcriptModel || settingsModel || metrics?.model || 'Gemini';
  let { model: modelLabel, effort: effortLabel } = splitModelAndEffort(rawModelStr, stdinEffort);

  if (!effortLabel) {
    for (const candidate of [transcriptModel, settingsModel]) {
      if (!candidate) continue;
      const parsed = splitModelAndEffort(candidate);
      if (parsed.effort && parsed.model.toLowerCase() === modelLabel.toLowerCase()) {
        effortLabel = parsed.effort;
        break;
      }
    }
  }

  const { branch, dirty } = resolveGitBranch(data, options.cwd);

  const cw = data.context_window && typeof data.context_window === 'object' ? data.context_window : {};
  const cur = cw.current_usage && typeof cw.current_usage === 'object' ? cw.current_usage : {};

  let inUncached = Number(cur.input_tokens || 0);
  let inCached = Number(cur.cache_read_input_tokens || 0);
  let outTokens = Number(cur.output_tokens || 0);
  const totalInCw = Number(cw.total_input_tokens || 0);
  const totalOutCw = Number(cw.total_output_tokens || 0);
  const ctxSize = Number(cw.context_window_size || metrics?.summary?.maxContext || 1048576);

  if (inUncached + inCached === 0 && Number(metrics?.summary?.contextUsed || 0) > 0) {
    inUncached = Number(metrics.summary.lastUncachedTokens || 0);
    inCached = Number(metrics.summary.lastCachedTokens || 0);
    if (!outTokens) outTokens = Number(metrics.summary.lastOutTokens || 0);
  }

  const ctxUsed = inUncached + inCached;
  const rawUsedPct = cw.used_percentage;
  const usedPct =
    rawUsedPct == null || (ctxUsed > 0 && Number(rawUsedPct) === 0)
      ? ctxSize > 0
        ? (ctxUsed / ctxSize) * 100
        : 0
      : Number(rawUsedPct);
  const cacheHitPct = ctxUsed > 0 ? (inCached / ctxUsed) * 100 : 0;

  const turnCount = Number(metrics?.summary?.turnCount || 0);
  const checkpointCount = Number(metrics?.summary?.checkpointCount || 0);

  const transcriptTotalTokens = Number(metrics?.summary?.sessionTotalTokens || 0);
  const sessionTotal = Math.max(
    transcriptTotalTokens,
    totalInCw + totalOutCw,
    ctxUsed + (totalOutCw || outTokens)
  );

  let sessionCost = 0;
  if (turnCount > 0 && metrics?.summary?.totalCostUsd != null) {
    sessionCost = Number(metrics.summary.totalCostUsd);
  } else if (ctxUsed > 0 || totalOutCw > 0 || outTokens > 0) {
    const key = resolvePricingProfileKey(rawModelStr, 'auto');
    const profile = PRICING_PROFILES[key] || PRICING_PROFILES.gemini_3_1_pro;
    const outForCost = totalOutCw || outTokens;
    sessionCost = computeTurnCost(
      {
        inUncached,
        inCached,
        cacheWriteTokens: 0,
        totalInput: ctxUsed,
        thinkTokens: 0,
        respTokens: outForCost,
        outTokens: outForCost,
        createdAt: null,
      },
      profile
    ).costUsd;
  }

  const avgE2eTps = Number(metrics?.summary?.avgE2eTps || 0);
  const avgDecodeTps = Number(metrics?.summary?.avgDecodeTps || 0);
  const tpsVal = avgE2eTps || avgDecodeTps || 0;

  const RESET = '\x1b[0m';
  const BOLD = '\x1b[1m';
  const DIM = '\x1b[2m';
  const RED = '\x1b[31m';
  const GREEN = '\x1b[32m';
  const YELLOW = '\x1b[33m';
  const BLUE = '\x1b[34m';
  const MAGENTA = '\x1b[35m';
  const CYAN = '\x1b[36m';

  const ctxColor = usedPct >= 80 ? RED : usedPct >= 50 ? YELLOW : GREEN;
  const barWidth = 8;
  const filled = Math.min(barWidth, Math.max(0, Math.round((usedPct / 100) * barWidth)));
  const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);

  let modelStr = `${BOLD}${BLUE}${modelLabel}${RESET}`;
  if (effortLabel) {
    modelStr += ` ${YELLOW}[${effortLabel}]${RESET}`;
  }

  const compactBadge =
    checkpointCount > 0
      ? `${YELLOW}(Compact: ${checkpointCount})${RESET}`
      : `${DIM}(Compact: 0)${RESET}`;
  const turnsStr = `${turnCount} ${compactBadge}`;

  let tpsStr = tpsVal > 0 ? `~${Math.round(tpsVal)} tok/s` : '-- tok/s';
  if (avgDecodeTps > 0 && Math.abs(avgDecodeTps - tpsVal) >= 1) {
    tpsStr += ` ${DIM}(Dec ${Math.round(avgDecodeTps)})${RESET}`;
  }

  const costStr = sessionCost >= 1.0 ? `$${sessionCost.toFixed(2)}` : `$${sessionCost.toFixed(3)}`;

  const parts = [modelStr];
  if (branch) {
    const dirtyMark = dirty ? `${YELLOW}*${RESET}` : '';
    parts.push(`${CYAN}⎇ ${branch}${RESET}${dirtyMark}`);
  }
  parts.push(
    `Turns: ${turnsStr}`,
    `Ctx: ${ctxColor}${fmtCompact(ctxUsed)}/${fmtCompact(ctxSize)} (${usedPct.toFixed(1)}%) [${bar}]${RESET}`,
    `Cache: ${CYAN}${cacheHitPct.toFixed(1)}%${RESET} ${DIM}(${fmtCompact(inCached)})${RESET}`,
    `ΣTok: ${fmtCompact(sessionTotal)} ${GREEN}(${costStr})${RESET}`,
    `Avg: ${MAGENTA}${tpsStr}${RESET}`
  );

  return parts.join(` ${DIM}│${RESET} `);
}

function realPath(p) {
  return existsSync(p) ? realpathSync(p) : resolve(p);
}

const isMain =
  process.argv[1] && realPath(process.argv[1]) === realPath(fileURLToPath(import.meta.url));
if (isMain) {
  let raw = '';
  try {
    raw = readFileSync(0, 'utf-8').trim();
  } catch {
    process.exit(0);
  }
  if (!raw) process.exit(0);
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    process.exit(0);
  }
  formatStatusLine(data)
    .then((line) => {
      if (line) process.stdout.write(`${line}\n`);
    })
    .catch(() => {
      process.exit(0);
    });
}
