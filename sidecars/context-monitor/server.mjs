#!/usr/bin/env node
// Antigravity Sidecar Web UI: Context Window, Cache Hit & TPS Monitor
//
// Combines:
// 1. Millisecond-accurate RPC metrics from LanguageServerService/GetCascadeTrajectoryGeneratorMetadata
//    (TTFT, streamingDuration, Decode TPS, E2E TPS, thinkingOutputTokens, responseOutputTokens,
//     ContextWindowMetadata, cacheReadTokens, inputTokens).
// 2. Local disk fallback/merge from ~/.gemini/antigravity-*/brain/<id>/.system_generated/logs/transcript.jsonl
//    so historical conversations and standalone debugging work seamlessly.

import { createServer } from 'node:http';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BIND_HOST = '127.0.0.1';
const PORT = parseInt(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || '18990', 10);
const UI_TOKEN = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || '';
const LS_ADDR = process.env.ANTIGRAVITY_LS_ADDRESS || '';
const CSRF_TOKEN = process.env.ANTIGRAVITY_CSRF_TOKEN || '';
const DEFAULT_PHYSICAL_MAX_CONTEXT = 1048576; // 1M physical window for Gemini 3 / 4
const DEFAULT_COMPACTION_MAX_CONTEXT = 256000; // Antigravity checkpointer soft limit (256k)
const DEFAULT_MAX_CONTEXT = DEFAULT_PHYSICAL_MAX_CONTEXT;

// Official API pricing tiers (USD per 1M tokens), with 200k single-turn prompt context threshold
const PRICING_PROFILES = {
  gemini_3_1_pro: {
    label: 'Gemini 3.1 / 4 Pro ($2/$0.2/$12 · >200k $4/$18)',
    shortLabel: 'Gemini 3.1/4 Pro',
    tierThreshold: 200000,
    base: { inUncached: 2.0, inCached: 0.2, cacheWrite: 2.0, out: 12.0 },
    high: { inUncached: 4.0, inCached: 0.4, cacheWrite: 4.0, out: 18.0 },
  },
  gemini_pro: {
    label: 'Gemini 2.5 Pro ($1.25/$0.125/$10 · >200k $2.5/$15)',
    shortLabel: 'Gemini 2.5 Pro',
    tierThreshold: 200000,
    base: { inUncached: 1.25, inCached: 0.125, cacheWrite: 1.25, out: 10.0 },
    high: { inUncached: 2.5, inCached: 0.25, cacheWrite: 2.5, out: 15.0 },
  },
  gemini_flash: {
    label: 'Gemini 2.5 / 3 Flash ($0.30/$0.03/$2.50)',
    shortLabel: 'Gemini Flash',
    tierThreshold: 200000,
    base: { inUncached: 0.3, inCached: 0.03, cacheWrite: 0.3, out: 2.5 },
    high: { inUncached: 0.3, inCached: 0.03, cacheWrite: 0.3, out: 2.5 },
  },
  claude_sonnet: {
    label: 'Claude Sonnet 4.x ($3/$0.3/$15 · >200k $6/$22.5)',
    shortLabel: 'Claude Sonnet 4.x',
    tierThreshold: 200000,
    base: { inUncached: 3.0, inCached: 0.3, cacheWrite: 3.75, out: 15.0 },
    high: { inUncached: 6.0, inCached: 0.6, cacheWrite: 7.5, out: 22.5 },
  },
  claude_opus: {
    label: 'Claude Opus 4.x ($5/$0.5/$25 · >200k $10/$37.5)',
    shortLabel: 'Claude Opus 4.x',
    tierThreshold: 200000,
    base: { inUncached: 5.0, inCached: 0.5, cacheWrite: 6.25, out: 25.0 },
    high: { inUncached: 10.0, inCached: 1.0, cacheWrite: 12.5, out: 37.5 },
  },
};

function resolvePricingProfileKey(modelName, requestedProfile) {
  if (requestedProfile && requestedProfile !== 'auto' && PRICING_PROFILES[requestedProfile]) {
    return requestedProfile;
  }
  const m = String(modelName || '').toLowerCase();
  if (m.includes('opus')) return 'claude_opus';
  if (m.includes('claude') || m.includes('sonnet')) return 'claude_sonnet';
  if (m.includes('flash')) return 'gemini_flash';
  if (m.includes('2.5')) return 'gemini_pro';
  if (m.includes('3.1') || m.includes('argon') || m.includes('gemini 4') || m.includes('gemini-3')) {
    return 'gemini_3_1_pro';
  }
  return 'gemini_3_1_pro';
}

function computeTurnCost(turn, profile) {
  const isHighTier = turn.totalInput > profile.tierThreshold;
  const tier = isHighTier ? profile.high : profile.base;
  const inUncachedCostUsd = (turn.inUncached / 1_000_000) * tier.inUncached;
  const inCachedCostUsd = (turn.inCached / 1_000_000) * tier.inCached;
  const cacheWriteCostUsd = ((turn.cacheWriteTokens || 0) / 1_000_000) * (tier.cacheWrite || tier.inUncached);
  const inputCostUsd = inUncachedCostUsd + inCachedCostUsd + cacheWriteCostUsd;
  const thinkCostUsd = (turn.thinkTokens / 1_000_000) * tier.out;
  const respCostUsd = (turn.respTokens / 1_000_000) * tier.out;
  const outputCostUsd = (turn.outTokens / 1_000_000) * tier.out;
  const costUsd = inputCostUsd + outputCostUsd;
  const noCacheTotalCostUsd = (turn.totalInput / 1_000_000) * tier.inUncached + outputCostUsd;
  const savedByCacheUsd = Math.max(0, noCacheTotalCostUsd - costUsd);
  return {
    isHighTier,
    inUncachedCostUsd,
    inCachedCostUsd,
    cacheWriteCostUsd,
    inputCostUsd,
    thinkCostUsd,
    respCostUsd,
    outputCostUsd,
    costUsd,
    noCacheTotalCostUsd,
    savedByCacheUsd,
  };
}

function parseDurationSec(dur) {
  if (!dur) return 0;
  if (typeof dur === 'number') return dur;
  const s = String(dur).trim();
  if (s.endsWith('ms')) return (parseFloat(s.slice(0, -2)) || 0) / 1000;
  if (s.endsWith('s')) return parseFloat(s.slice(0, -1)) || 0;
  return parseFloat(s) || 0;
}

async function callLsRpc(method, body) {
  if (!LS_ADDR || !CSRF_TOKEN) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const res = await fetch(
      `http://${LS_ADDR}/exa.language_server_pb.LanguageServerService/${method}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-codeium-csrf-token': CSRF_TOKEN,
        },
        body: JSON.stringify(body || {}),
        signal: controller.signal,
      }
    );
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function discoverLocalTranscripts() {
  const geminiRoot = process.env.AGY_GEMINI_ROOT || join(homedir(), '.gemini');
  const appDirs = ['antigravity', 'antigravity-ide', 'antigravity-cli'];
  const items = [];

  for (const appDir of appDirs) {
    const brainDir = join(geminiRoot, appDir, 'brain');
    if (!existsSync(brainDir)) continue;
    let convDirs = [];
    try {
      convDirs = readdirSync(brainDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of convDirs) {
      if (!d.isDirectory()) continue;
      const transcriptPath = join(
        brainDir,
        d.name,
        '.system_generated',
        'logs',
        'transcript.jsonl'
      );
      if (!existsSync(transcriptPath)) continue;
      try {
        const st = statSync(transcriptPath);
        items.push({
          conversationId: d.name,
          surface: appDir,
          transcriptPath,
          mtimeMs: st.mtimeMs,
          updatedAt: st.mtime.toISOString(),
        });
      } catch {
        // ignore unreadable entries
      }
    }
  }

  items.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return items;
}

function parseTranscriptMetrics(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) {
    return { turns: [], firstUserPrompt: '', modelHint: '', checkpointCount: 0 };
  }
  let raw = '';
  try {
    raw = readFileSync(transcriptPath, 'utf-8');
  } catch {
    return { turns: [], firstUserPrompt: '', modelHint: '', checkpointCount: 0 };
  }

  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const steps = [];
  for (const line of lines) {
    try {
      steps.push(JSON.parse(line));
    } catch {
      // skip malformed line
    }
  }

  let firstUserPrompt = '';
  let modelHint = '';
  let currentModel = '';
  let checkpointCount = 0;
  const turns = [];

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.type === 'CHECKPOINT') {
      checkpointCount++;
    }
    if (s.type === 'USER_INPUT' && typeof s.content === 'string') {
      if (!firstUserPrompt) {
        const m = s.content.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
        const text = (m ? m[1] : s.content).trim().replace(/\s+/g, ' ');
        firstUserPrompt = text.slice(0, 80);
      }
      const settingsMatch = s.content.match(/<USER_SETTINGS_CHANGE>([\s\S]*?)<\/USER_SETTINGS_CHANGE>/);
      if (settingsMatch) {
        const mmFull = settingsMatch[1].match(
          /Model Selection` from ([^\n]+?) to ([^\n]+?)(?:\.\s+No need to comment|\.\s*$|\n|$)/
        );
        if (mmFull) {
          const fromModel = mmFull[1].trim();
          const toModel = mmFull[2].trim();
          if (!currentModel && fromModel && fromModel !== 'None') {
            for (const prevTurn of turns) {
              if (!prevTurn.model) {
                prevTurn.model = fromModel;
                prevTurn.modelId = fromModel;
              }
            }
          }
          currentModel = toModel;
          modelHint = toModel;
        }
      }
    }

    if (s.type === 'PLANNER_RESPONSE') {
      const inUncached = Number(s.input_tokens || 0);
      const inCached = Number(s.cache_read_tokens || 0);
      const outTokens = Number(s.output_tokens || 0);
      const totalInput = inUncached + inCached;

      // Estimate E2E duration only from normal tool-execution step (GENERIC), excluding ERROR_MESSAGE timeouts
      let estDurationSec = 0;
      const nextStep = steps[i + 1];
      const interrupted = Boolean(nextStep && nextStep.type === 'ERROR_MESSAGE');
      if (
        !interrupted &&
        s.created_at &&
        nextStep &&
        nextStep.created_at &&
        nextStep.type === 'GENERIC'
      ) {
        const t0 = Date.parse(s.created_at);
        const t1 = Date.parse(nextStep.created_at);
        const dt = (t1 - t0) / 1000;
        if (!Number.isNaN(dt) && dt >= 0.05 && dt <= 180) {
          estDurationSec = dt;
        }
      }

      const stepModelId = s.model || s.model_id || s.response_model || currentModel || '';

      turns.push({
        turn: turns.length + 1,
        stepIndex: s.step_index,
        createdAt: s.created_at || null,
        interrupted,
        model: currentModel || stepModelId || '',
        modelId: stepModelId || currentModel || '',
        inUncached,
        inCached,
        cacheWriteTokens: 0,
        totalInput,
        contextUsed: totalInput,
        maxContext: DEFAULT_PHYSICAL_MAX_CONTEXT,
        compactionMaxContext: DEFAULT_COMPACTION_MAX_CONTEXT,
        cacheHitRate: totalInput > 0 ? (inCached / totalInput) * 100 : 0,
        outTokens,
        thinkTokens: 0,
        respTokens: outTokens,
        ttftSec: 0,
        streamSec: 0,
        e2eSec: estDurationSec,
        decodeTps: 0,
        e2eTps: !interrupted && estDurationSec >= 0.05 ? outTokens / estDurationSec : 0,
        visibleE2eTps: !interrupted && estDurationSec >= 0.05 ? outTokens / estDurationSec : 0,
        source: 'transcript',
      });
    }
  }

  const fallbackModel = currentModel || modelHint || 'Gemini 3.1 Pro (High)';
  for (const t of turns) {
    if (!t.model) t.model = fallbackModel;
    if (!t.modelId) t.modelId = t.model;
  }

  return { turns, firstUserPrompt, modelHint: fallbackModel, checkpointCount };
}

async function getConversationMetrics(requestedConvId, requestedPricing) {
  const localList = discoverLocalTranscripts();
  let targetEntry =
    (requestedConvId && localList.find((x) => x.conversationId === requestedConvId)) || null;
  if (!targetEntry && requestedConvId) {
    const geminiRoot = process.env.AGY_GEMINI_ROOT || join(homedir(), '.gemini');
    for (const appDir of ['antigravity', 'antigravity-ide', 'antigravity-cli']) {
      const tp = join(
        geminiRoot,
        appDir,
        'brain',
        requestedConvId,
        '.system_generated',
        'logs',
        'transcript.jsonl'
      );
      if (existsSync(tp)) {
        targetEntry = {
          conversationId: requestedConvId,
          surface: appDir,
          transcriptPath: tp,
          updatedAt: new Date().toISOString(),
        };
        break;
      }
    }
  }
  if (!targetEntry) targetEntry = localList[0] || null;

  const conversationId = requestedConvId || targetEntry?.conversationId || '';
  const transcriptData = parseTranscriptMetrics(targetEntry?.transcriptPath);

  // Attempt RPC call to LanguageServerService for millisecond-level TTFT & streamingDuration
  const rpcMeta = conversationId
    ? await callLsRpc('GetCascadeTrajectoryGeneratorMetadata', {
        cascadeId: conversationId,
        includeMessages: false,
      })
    : null;

  const rpcItems = (rpcMeta?.generatorMetadata || []).filter((m) => m && m.chatModel);
  const turns = [];
  let activeModel = transcriptData.modelHint || 'Gemini 3.1 Pro (High)';
  let latestTokenBreakdown = null;

  const tTurnByStep = new Map();
  for (const tt of transcriptData.turns) {
    if (tt.stepIndex !== undefined && tt.stepIndex !== null) {
      tTurnByStep.set(Number(tt.stepIndex), tt);
    }
  }

  if (rpcItems.length > 0) {
    for (let i = 0; i < rpcItems.length; i++) {
      const rItem = rpcItems[i];
      const cm = rItem.chatModel;
      const stepIdx = rItem.stepIndices?.[0];
      const tTurn =
        (stepIdx !== undefined ? tTurnByStep.get(Number(stepIdx)) : null) ||
        (rpcItems.length === transcriptData.turns.length ? transcriptData.turns[i] : null);

      const usage = cm.usage || {};
      const ctxMeta = cm.chatStartMetadata?.contextWindowMetadata || {};
      const inUncached = Number(usage.inputTokens ?? tTurn?.inUncached ?? 0);
      const inCached = Number(usage.cacheReadTokens ?? tTurn?.inCached ?? 0);
      const cacheWriteTokens = Number(usage.cacheWriteTokens ?? 0);
      const totalInput = inUncached + inCached;

      const outTokens = Number(usage.outputTokens ?? tTurn?.outTokens ?? 0);
      const thinkTokens = Number(usage.thinkingOutputTokens ?? 0);
      const respTokens = Number(
        usage.responseOutputTokens ?? (outTokens >= thinkTokens ? outTokens - thinkTokens : outTokens)
      );

      const ttftSec = parseDurationSec(cm.timeToFirstToken);
      const streamSec = parseDurationSec(cm.streamingDuration);
      const interrupted = Boolean(tTurn?.interrupted);
      const e2eSec =
        ttftSec + streamSec > 0
          ? ttftSec + streamSec
          : !interrupted
            ? tTurn?.e2eSec || 0
            : 0;

      const contextUsed = totalInput > 0 ? totalInput : Number(ctxMeta.estimatedTokensUsed || 0);
      const rpcCompactionLimit = Number(ctxMeta.maxContextTokens || DEFAULT_COMPACTION_MAX_CONTEXT);
      const maxContext = DEFAULT_PHYSICAL_MAX_CONTEXT;

      const turnModelDisplay =
        cm.modelDisplayName || tTurn?.model || cm.responseModel || usage.model || activeModel;
      const turnModelId =
        cm.responseModel || usage.model || cm.model || tTurn?.modelId || turnModelDisplay;

      if (turnModelDisplay) {
        activeModel = turnModelDisplay;
      }
      if (ctxMeta.tokenBreakdown) {
        latestTokenBreakdown = ctxMeta.tokenBreakdown;
      }

      // Guard decodeTps against single-chunk buffered responses (streamSec < 0.15s)
      const decodeTps = !interrupted && streamSec >= 0.15 ? outTokens / streamSec : 0;
      const e2eTps = !interrupted && e2eSec >= 0.05 ? outTokens / e2eSec : 0;
      const visibleE2eTps = !interrupted && e2eSec >= 0.05 ? respTokens / e2eSec : 0;

      turns.push({
        turn: i + 1,
        stepIndex: stepIdx ?? tTurn?.stepIndex ?? i,
        createdAt: tTurn?.createdAt || cm.chatStartMetadata?.createdAt || null,
        interrupted,
        model: turnModelDisplay,
        modelId: turnModelId,
        inUncached,
        inCached,
        cacheWriteTokens,
        totalInput,
        contextUsed,
        maxContext,
        compactionMaxContext: rpcCompactionLimit,
        cacheHitRate: totalInput > 0 ? (inCached / totalInput) * 100 : 0,
        outTokens,
        thinkTokens,
        respTokens,
        ttftSec,
        streamSec,
        e2eSec,
        decodeTps,
        e2eTps,
        visibleE2eTps,
        source: 'rpc',
      });
    }
  } else {
    for (const tTurn of transcriptData.turns) {
      turns.push({
        ...tTurn,
        model: tTurn.model || activeModel || 'Gemini',
        modelId: tTurn.modelId || tTurn.model || activeModel || 'Gemini',
      });
    }
  }

  // Compute per-turn cost using each turn's own model pricing (when requestedPricing === 'auto')
  for (const t of turns) {
    const turnPricingKey = resolvePricingProfileKey(
      `${t.model || ''} ${t.modelId || ''}`,
      requestedPricing
    );
    const turnProfile = PRICING_PROFILES[turnPricingKey] || PRICING_PROFILES.gemini_3_1_pro;
    t.pricingProfileKey = turnPricingKey;
    t.pricingProfileLabel = turnProfile.shortLabel;
    t.pricingProfileFullLabel = turnProfile.label;
    Object.assign(t, computeTurnCost(t, turnProfile));
  }

  const pricingProfileKey = resolvePricingProfileKey(activeModel, requestedPricing);
  const pricingProfile = PRICING_PROFILES[pricingProfileKey] || PRICING_PROFILES.gemini_3_1_pro;

  const lastTurn = turns[turns.length - 1] || null;
  const lastCtxTurn = [...turns].reverse().find((t) => t.contextUsed > 0) || lastTurn;
  const lastPerfTurn =
    [...turns].reverse().find((t) => !t.interrupted && (t.e2eTps > 0 || t.decodeTps > 0)) ||
    [...turns].reverse().find((t) => !t.interrupted && t.outTokens > 0) ||
    lastTurn;
  const totalOutTokens = turns.reduce((acc, t) => acc + t.outTokens, 0);
  const totalThinkTokens = turns.reduce((acc, t) => acc + t.thinkTokens, 0);
  const totalRespTokens = turns.reduce((acc, t) => acc + t.respTokens, 0);
  const totalInUncached = turns.reduce((acc, t) => acc + t.inUncached, 0);
  const totalInCached = turns.reduce((acc, t) => acc + t.inCached, 0);
  const totalCacheWriteTokens = turns.reduce((acc, t) => acc + (t.cacheWriteTokens || 0), 0);
  const totalInputTokens = totalInUncached + totalInCached;
  const sessionTotalTokens = totalInputTokens + totalOutTokens;
  const sessionNetTokens = totalInUncached + totalOutTokens;

  const totalInUncachedCostUsd = turns.reduce((acc, t) => acc + (t.inUncachedCostUsd || 0), 0);
  const totalInCachedCostUsd = turns.reduce((acc, t) => acc + (t.inCachedCostUsd || 0), 0);
  const totalInputCostUsd = turns.reduce((acc, t) => acc + (t.inputCostUsd || 0), 0);
  const totalThinkCostUsd = turns.reduce((acc, t) => acc + (t.thinkCostUsd || 0), 0);
  const totalRespCostUsd = turns.reduce((acc, t) => acc + (t.respCostUsd || 0), 0);
  const totalOutputCostUsd = turns.reduce((acc, t) => acc + (t.outputCostUsd || 0), 0);
  const totalCostUsd = turns.reduce((acc, t) => acc + (t.costUsd || 0), 0);
  const noCacheTotalCostUsd = turns.reduce((acc, t) => acc + (t.noCacheTotalCostUsd || 0), 0);
  const savedByCacheUsd = turns.reduce((acc, t) => acc + (t.savedByCacheUsd || 0), 0);
  const savedByCachePct =
    noCacheTotalCostUsd > 0 ? (savedByCacheUsd / noCacheTotalCostUsd) * 100 : 0;
  const highTierTurnCount = turns.filter((t) => t.isHighTier).length;

  // Per-Model ID Aggregation (分模型统计与计费明细)
  const modelMap = new Map();
  for (const t of turns) {
    const modelId = String(t.modelId || t.model || 'Gemini').trim();
    const modelName = String(t.model || modelId).trim();
    const key = `${modelId}::${modelName}`;
    if (!modelMap.has(key)) {
      modelMap.set(key, {
        modelId,
        model: modelName,
        pricingProfileKey: t.pricingProfileKey,
        pricingProfileLabel: t.pricingProfileLabel,
        pricingProfileFullLabel: t.pricingProfileFullLabel,
        turnCount: 0,
        highTierTurnCount: 0,
        inUncached: 0,
        inCached: 0,
        cacheWriteTokens: 0,
        totalInput: 0,
        outTokens: 0,
        thinkTokens: 0,
        respTokens: 0,
        totalTokens: 0,
        inUncachedCostUsd: 0,
        inCachedCostUsd: 0,
        inputCostUsd: 0,
        thinkCostUsd: 0,
        respCostUsd: 0,
        outputCostUsd: 0,
        costUsd: 0,
        noCacheTotalCostUsd: 0,
        savedByCacheUsd: 0,
        _e2eOutSum: 0,
        _e2eSecSum: 0,
        _decOutSum: 0,
        _decSecSum: 0,
        _ttftSum: 0,
        _ttftCount: 0,
      });
    }
    const g = modelMap.get(key);
    g.turnCount += 1;
    if (t.isHighTier) g.highTierTurnCount += 1;
    g.inUncached += t.inUncached;
    g.inCached += t.inCached;
    g.cacheWriteTokens += t.cacheWriteTokens || 0;
    g.totalInput += t.totalInput;
    g.outTokens += t.outTokens;
    g.thinkTokens += t.thinkTokens;
    g.respTokens += t.respTokens;
    g.totalTokens += t.totalInput + t.outTokens;
    g.inUncachedCostUsd += t.inUncachedCostUsd || 0;
    g.inCachedCostUsd += t.inCachedCostUsd || 0;
    g.inputCostUsd += t.inputCostUsd || 0;
    g.thinkCostUsd += t.thinkCostUsd || 0;
    g.respCostUsd += t.respCostUsd || 0;
    g.outputCostUsd += t.outputCostUsd || 0;
    g.costUsd += t.costUsd || 0;
    g.noCacheTotalCostUsd += t.noCacheTotalCostUsd || 0;
    g.savedByCacheUsd += t.savedByCacheUsd || 0;
    if (!t.interrupted && t.e2eSec >= 0.05 && t.outTokens > 0) {
      g._e2eOutSum += t.outTokens;
      g._e2eSecSum += t.e2eSec;
    }
    if (!t.interrupted && t.streamSec >= 0.15 && t.outTokens > 0) {
      g._decOutSum += t.outTokens;
      g._decSecSum += t.streamSec;
    }
    if (!t.interrupted && t.ttftSec > 0) {
      g._ttftSum += t.ttftSec;
      g._ttftCount += 1;
    }
  }

  const modelStats = Array.from(modelMap.values())
    .map((g) => {
      const cacheHitRate = g.totalInput > 0 ? (g.inCached / g.totalInput) * 100 : 0;
      const turnSharePct = turns.length > 0 ? (g.turnCount / turns.length) * 100 : 0;
      const tokenSharePct = sessionTotalTokens > 0 ? (g.totalTokens / sessionTotalTokens) * 100 : 0;
      const costSharePct = totalCostUsd > 0 ? (g.costUsd / totalCostUsd) * 100 : 0;
      const savedByCachePctModel =
        g.noCacheTotalCostUsd > 0 ? (g.savedByCacheUsd / g.noCacheTotalCostUsd) * 100 : 0;
      const avgE2eTpsModel = g._e2eSecSum > 0 ? g._e2eOutSum / g._e2eSecSum : 0;
      const avgDecodeTpsModel = g._decSecSum > 0 ? g._decOutSum / g._decSecSum : 0;
      const avgTtftSecModel = g._ttftCount > 0 ? g._ttftSum / g._ttftCount : 0;
      return {
        modelId: g.modelId,
        model: g.model,
        pricingProfileKey: g.pricingProfileKey,
        pricingProfileLabel: g.pricingProfileLabel,
        pricingProfileFullLabel: g.pricingProfileFullLabel,
        turnCount: g.turnCount,
        turnSharePct,
        highTierTurnCount: g.highTierTurnCount,
        inUncached: g.inUncached,
        inCached: g.inCached,
        totalInput: g.totalInput,
        cacheHitRate,
        outTokens: g.outTokens,
        thinkTokens: g.thinkTokens,
        respTokens: g.respTokens,
        totalTokens: g.totalTokens,
        tokenSharePct,
        avgE2eTps: avgE2eTpsModel,
        avgDecodeTps: avgDecodeTpsModel,
        avgTtftSec: avgTtftSecModel,
        inUncachedCostUsd: g.inUncachedCostUsd,
        inCachedCostUsd: g.inCachedCostUsd,
        inputCostUsd: g.inputCostUsd,
        thinkCostUsd: g.thinkCostUsd,
        respCostUsd: g.respCostUsd,
        outputCostUsd: g.outputCostUsd,
        costUsd: g.costUsd,
        costSharePct,
        noCacheTotalCostUsd: g.noCacheTotalCostUsd,
        savedByCacheUsd: g.savedByCacheUsd,
        savedByCachePct: savedByCachePctModel,
      };
    })
    .sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens);

  // Time-weighted session TPS (total tokens / total active seconds) to prevent short-turn ratio skew
  const validDecodeTurns = turns.filter((t) => !t.interrupted && t.streamSec >= 0.15 && t.outTokens > 0);
  const validE2eTurns = turns.filter((t) => !t.interrupted && t.e2eSec >= 0.05 && t.outTokens > 0);
  const ttftTurns = turns.filter((t) => !t.interrupted && t.ttftSec > 0);

  const sumDecodeOut = validDecodeTurns.reduce((a, t) => a + t.outTokens, 0);
  const sumDecodeSec = validDecodeTurns.reduce((a, t) => a + t.streamSec, 0);
  const avgDecodeTps = sumDecodeSec > 0 ? sumDecodeOut / sumDecodeSec : 0;

  const sumE2eOut = validE2eTurns.reduce((a, t) => a + t.outTokens, 0);
  const sumE2eResp = validE2eTurns.reduce((a, t) => a + t.respTokens, 0);
  const sumE2eSec = validE2eTurns.reduce((a, t) => a + t.e2eSec, 0);
  const avgE2eTps = sumE2eSec > 0 ? sumE2eOut / sumE2eSec : 0;
  const avgVisibleE2eTps = sumE2eSec > 0 ? sumE2eResp / sumE2eSec : 0;

  const peakE2eTps = Math.max(0, ...turns.map((t) => t.e2eTps || 0));
  const peakDecodeTps = Math.max(0, ...turns.map((t) => t.decodeTps || 0));
  const peakTps = peakE2eTps > 0 ? peakE2eTps : peakDecodeTps;
  const avgTtftSec =
    ttftTurns.length > 0
      ? ttftTurns.reduce((a, t) => a + t.ttftSec, 0) / ttftTurns.length
      : 0;

  const contextUsed = lastCtxTurn?.contextUsed || 0;
  const maxContext = lastCtxTurn?.maxContext || DEFAULT_PHYSICAL_MAX_CONTEXT;
  const compactionMaxContext = lastCtxTurn?.compactionMaxContext || DEFAULT_COMPACTION_MAX_CONTEXT;
  const contextUsedPct = maxContext > 0 ? (contextUsed / maxContext) * 100 : 0;
  const compactionUsedPct = compactionMaxContext > 0 ? (contextUsed / compactionMaxContext) * 100 : 0;

  return {
    conversationId,
    surface: targetEntry?.surface || 'antigravity',
    updatedAt: targetEntry?.updatedAt || new Date().toISOString(),
    title: transcriptData.firstUserPrompt || conversationId.slice(0, 8),
    model: activeModel || 'Gemini',
    rpcConnected: rpcItems.length > 0,
    summary: {
      turnCount: turns.length,
      modelCount: modelStats.length,
      checkpointCount: transcriptData.checkpointCount || 0,
      contextUsed,
      maxContext,
      contextUsedPct,
      contextRemaining: Math.max(0, maxContext - contextUsed),
      compactionMaxContext,
      compactionUsedPct,
      compactionRemaining: Math.max(0, compactionMaxContext - contextUsed),
      lastCacheHitRate: lastCtxTurn?.cacheHitRate || 0,
      lastCachedTokens: lastCtxTurn?.inCached || 0,
      lastUncachedTokens: lastCtxTurn?.inUncached || 0,
      sessionCacheHitRate: totalInputTokens > 0 ? (totalInCached / totalInputTokens) * 100 : 0,
      lastDecodeTps: lastPerfTurn?.decodeTps || 0,
      lastE2eTps: lastPerfTurn?.e2eTps || 0,
      lastVisibleE2eTps: lastPerfTurn?.visibleE2eTps || 0,
      avgDecodeTps,
      avgE2eTps,
      avgVisibleE2eTps,
      peakE2eTps,
      peakDecodeTps,
      peakTps,
      lastTtftSec: lastPerfTurn?.ttftSec || 0,
      lastStreamSec: lastPerfTurn?.streamSec || 0,
      lastE2eSec: lastPerfTurn?.e2eSec || 0,
      avgTtftSec,
      lastOutTokens: lastPerfTurn?.outTokens || 0,
      lastThinkTokens: lastPerfTurn?.thinkTokens || 0,
      lastRespTokens: lastPerfTurn?.respTokens || 0,
      totalInUncached,
      totalInCached,
      totalCacheWriteTokens,
      totalInputTokens,
      totalOutTokens,
      totalThinkTokens,
      totalRespTokens,
      sessionTotalTokens,
      sessionNetTokens,
      pricingProfileKey,
      pricingProfileLabel:
        requestedPricing === 'auto' && modelStats.length > 1
          ? `多模型分别计价 (${modelStats.length}个模型)`
          : pricingProfile.shortLabel,
      pricingProfileFullLabel: pricingProfile.label,
      lastTurnCostUsd: lastCtxTurn?.costUsd || 0,
      totalInUncachedCostUsd,
      totalInCachedCostUsd,
      totalInputCostUsd,
      totalThinkCostUsd,
      totalRespCostUsd,
      totalOutputCostUsd,
      totalCostUsd,
      noCacheTotalCostUsd,
      savedByCacheUsd,
      savedByCachePct,
      highTierTurnCount,
    },
    modelStats,
    tokenBreakdown: latestTokenBreakdown,
    turns,
    recentConversations: localList.slice(0, 20).map((item) => ({
      conversationId: item.conversationId,
      surface: item.surface,
      updatedAt: item.updatedAt,
    })),
  };
}

function validateToken(req, url) {
  if (url.pathname === '/preload.js' || req.method === 'GET') return true;
  if (!UI_TOKEN) return true;
  const provided = req.headers['x-sidecar-token'] || url.searchParams.get('token');
  return provided === UI_TOKEN;
}

const PRELOAD_JS = [
  '(function() {',
  '  window.addEventListener("message", function(event) {',
  '    if (event.data && event.data.type === "theme-change" && event.data.payload && event.data.payload.cssVariables) {',
  '      const vars = event.data.payload.cssVariables;',
  '      for (const [k, v] of Object.entries(vars)) {',
  '        document.documentElement.style.setProperty(k, v);',
  '      }',
  '    }',
  '  });',
  '})();',
].join('\n');

const HTML_PAGE = [
  '<!DOCTYPE html>',
  '<html lang="zh-CN">',
  '<head>',
  '  <meta charset="utf-8" />',
  '  <meta name="viewport" content="width=device-width, initial-scale=1" />',
  '  <title>Context & TPS Monitor</title>',
  '  <script src="/preload.js"></script>',
  '  <style>',
  '    *, *::before, *::after { box-sizing: border-box; }',
  '    body {',
  '      background: var(--background, #0f172a);',
  '      color: var(--foreground, #f8fafc);',
  '      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;',
  '      margin: 0;',
  '      padding: 12px;',
  '      -webkit-font-smoothing: antialiased;',
  '      font-size: 12px;',
  '      line-height: 1.45;',
  '    }',
  '    .card {',
  '      background: var(--card, rgba(30, 41, 59, 0.75));',
  '      border: 1px solid var(--border, rgba(148, 163, 184, 0.18));',
  '      border-radius: 10px;',
  '      padding: 12px;',
  '    }',
  '    .subcard {',
  '      background: rgba(148, 163, 184, 0.06);',
  '      border: 1px solid var(--border, rgba(148, 163, 184, 0.14));',
  '      border-radius: 8px;',
  '      padding: 8px 10px;',
  '    }',
  '    .muted { color: var(--muted-foreground, #94a3b8); }',
  '    select, button {',
  '      background: var(--card, #1e293b);',
  '      color: var(--foreground, #f8fafc);',
  '      border: 1px solid var(--border, rgba(148, 163, 184, 0.3));',
  '      border-radius: 6px;',
  '      padding: 3px 7px;',
  '      font-size: 11px;',
  '      cursor: pointer;',
  '    }',
  '    button:hover { border-color: rgba(56, 189, 248, 0.5); }',
  '    table { width: 100%; border-collapse: collapse; font-size: 11.5px; }',
  '    th, td {',
  '      padding: 5px 6px;',
  '      text-align: right;',
  '      border-bottom: 1px solid var(--border, rgba(148, 163, 184, 0.14));',
  '      font-variant-numeric: tabular-nums;',
  '      white-space: nowrap;',
  '    }',
  '    th:first-child, td:first-child, th:nth-child(2), td:nth-child(2) { text-align: left; }',
  '    /* Self-contained utility classes (zero external CDN dependency) */',
  '    .max-w-5xl { max-width: 64rem; }',
  '    .mx-auto { margin-left: auto; margin-right: auto; }',
  '    .space-y-0\\.5 > * + * { margin-top: 2px; }',
  '    .space-y-1 > * + * { margin-top: 4px; }',
  '    .space-y-1\\.5 > * + * { margin-top: 6px; }',
  '    .space-y-2 > * + * { margin-top: 8px; }',
  '    .space-y-2\\.5 > * + * { margin-top: 10px; }',
  '    .space-y-3 > * + * { margin-top: 12px; }',
  '    .flex { display: flex; }',
  '    .flex-wrap { flex-wrap: wrap; }',
  '    .inline-block { display: inline-block; }',
  '    .hidden { display: none; }',
  '    .grid { display: grid; }',
  '    .grid-cols-1 { grid-template-columns: repeat(1, minmax(0, 1fr)); }',
  '    .grid-cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }',
  '    @media (min-width: 520px) {',
  '      .sm\\:inline { display: inline; }',
  '      .sm\\:grid-cols-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }',
  '      .sm\\:grid-cols-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }',
  '    }',
  '    .items-center { align-items: center; }',
  '    .items-baseline { align-items: baseline; }',
  '    .justify-between { justify-content: space-between; }',
  '    .gap-1 { gap: 4px; }',
  '    .gap-1\\.5 { gap: 6px; }',
  '    .gap-2 { gap: 8px; }',
  '    .gap-2\\.5 { gap: 10px; }',
  '    .gap-3 { gap: 12px; }',
  '    .min-w-0 { min-width: 0; }',
  '    .shrink-0 { flex-shrink: 0; }',
  '    .truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
  '    .w-2 { width: 8px; }',
  '    .h-2 { height: 8px; }',
  '    .w-full { width: 100%; }',
  '    .h-full { height: 100%; }',
  '    .h-1\\.5 { height: 6px; }',
  '    .h-3 { height: 12px; }',
  '    .h-24 { height: 96px; }',
  '    .w-\\[2px\\] { width: 2px; }',
  '    .max-w-\\[145px\\] { max-width: 145px; }',
  '    .max-w-\\[175px\\] { max-width: 175px; }',
  '    .max-w-\\[200px\\] { max-width: 200px; }',
  '    .max-h-64 { max-height: 256px; }',
  '    .relative { position: relative; }',
  '    .absolute { position: absolute; }',
  '    .top-0 { top: 0; }',
  '    .bottom-0 { bottom: 0; }',
  '    .z-10 { z-index: 10; }',
  '    .overflow-hidden { overflow: hidden; }',
  '    .overflow-visible { overflow: visible; }',
  '    .overflow-x-auto { overflow-x: auto; }',
  '    .overflow-y-auto { overflow-y: auto; }',
  '    .rounded { border-radius: 4px; }',
  '    .rounded-full { border-radius: 9999px; }',
  '    .border { border: 1px solid currentColor; }',
  '    .border-t { border-top: 1px solid rgba(100, 116, 139, 0.15); }',
  '    .border-slate-500\\/10 { border-color: rgba(100, 116, 139, 0.1); }',
  '    .border-slate-500\\/15 { border-color: rgba(100, 116, 139, 0.15); }',
  '    .border-emerald-500\\/25 { border-color: rgba(16, 185, 129, 0.25); }',
  '    .border-emerald-500\\/30 { border-color: rgba(16, 185, 129, 0.3); }',
  '    .border-emerald-500\\/40 { border-color: rgba(16, 185, 129, 0.4); }',
  '    .border-amber-500\\/30 { border-color: rgba(245, 158, 11, 0.3); }',
  '    .border-amber-500\\/40 { border-color: rgba(245, 158, 11, 0.4); }',
  '    .border-rose-500\\/30 { border-color: rgba(244, 63, 94, 0.3); }',
  '    .border-sky-500\\/25 { border-color: rgba(14, 165, 233, 0.25); }',
  '    .px-1 { padding-left: 4px; padding-right: 4px; }',
  '    .px-1\\.5 { padding-left: 6px; padding-right: 6px; }',
  '    .px-2 { padding-left: 8px; padding-right: 8px; }',
  '    .py-0\\.5 { padding-top: 2px; padding-bottom: 2px; }',
  '    .py-2\\.5 { padding-top: 10px; padding-bottom: 10px; }',
  '    .pt-0\\.5 { padding-top: 2px; }',
  '    .pt-1 { padding-top: 4px; }',
  '    .pt-2 { padding-top: 8px; }',
  '    .mr-1 { margin-right: 4px; }',
  '    .text-\\[10px\\] { font-size: 10px; }',
  '    .text-\\[11px\\] { font-size: 11px; }',
  '    .text-xs { font-size: 12px; }',
  '    .text-sm { font-size: 13.5px; }',
  '    .text-base { font-size: 15px; }',
  '    .font-medium { font-weight: 500; }',
  '    .font-semibold { font-weight: 600; }',
  '    .font-bold { font-weight: 700; }',
  '    .tabular-nums { font-variant-numeric: tabular-nums; }',
  '    .select-none { user-select: none; }',
  '    .cursor-pointer { cursor: pointer; }',
  '    .opacity-70 { opacity: 0.7; }',
  '    .opacity-80 { opacity: 0.8; }',
  '    .transition-all { transition: all 0.3s ease; }',
  '    .duration-300 { transition-duration: 300ms; }',
  '    .text-emerald-400 { color: #34d399; }',
  '    .text-sky-400 { color: #38bdf8; }',
  '    .text-amber-400 { color: #fbbf24; }',
  '    .text-amber-400\\/90 { color: rgba(251, 191, 36, 0.9); }',
  '    .text-rose-400 { color: #fb7185; }',
  '    .text-rose-400\\/90 { color: rgba(251, 113, 133, 0.9); }',
  '    .text-violet-400 { color: #a78bfa; }',
  '    .text-violet-300 { color: #c4b5fd; }',
  '    .bg-emerald-400 { background-color: #34d399; }',
  '    .bg-emerald-500 { background-color: #10b981; }',
  '    .bg-emerald-500\\/10 { background-color: rgba(16, 185, 129, 0.1); }',
  '    .bg-emerald-500\\/15 { background-color: rgba(16, 185, 129, 0.15); }',
  '    .bg-sky-400 { background-color: #38bdf8; }',
  '    .bg-sky-500\\/10 { background-color: rgba(14, 165, 233, 0.1); }',
  '    .bg-amber-500 { background-color: #f59e0b; }',
  '    .bg-amber-500\\/15 { background-color: rgba(245, 158, 11, 0.15); }',
  '    .bg-amber-500\\/30 { background-color: rgba(245, 158, 11, 0.3); }',
  '    .bg-amber-400\\/80 { background-color: rgba(251, 191, 36, 0.8); }',
  '    .bg-amber-400\\/90 { background-color: rgba(251, 191, 36, 0.9); }',
  '    .bg-rose-500 { background-color: #f43f5e; }',
  '    .bg-rose-500\\/15 { background-color: rgba(244, 63, 94, 0.15); }',
  '    .bg-rose-400\\/90 { background-color: rgba(251, 113, 133, 0.9); }',
  '    .bg-violet-400 { background-color: #a78bfa; }',
  '    .bg-violet-500\\/15 { background-color: rgba(139, 92, 246, 0.15); }',
  '    .bg-slate-500\\/15 { background-color: rgba(100, 116, 139, 0.15); }',
  '    .bg-slate-500\\/20 { background-color: rgba(100, 116, 139, 0.2); }',
  '  </style>',
  '</head>',
  '<body class="antialiased space-y-2.5 text-xs max-w-5xl mx-auto">',
  '',
  '  <!-- Tier 1: Top Header & Global Controls -->',
  '  <div class="card flex flex-wrap items-center justify-between gap-2 py-2.5">',
  '    <div class="flex items-center gap-2 min-w-0">',
  '      <span id="liveDot" class="inline-block w-2 h-2 rounded-full bg-emerald-400 shrink-0"></span>',
  '      <span class="font-semibold text-sm truncate" id="modelBadge">Context & TPS</span>',
  '      <span id="sourceBadge" class="px-1.5 py-0.5 rounded text-[11px] border border-current opacity-80 shrink-0">RPC</span>',
  '      <span id="convTitle" class="muted truncate hidden sm:inline max-w-[200px]"></span>',
  '    </div>',
  '    <div class="flex flex-wrap items-center gap-1.5">',
  '      <label class="flex items-center gap-1 cursor-pointer muted select-none text-[11px]">',
  '        <input type="checkbox" id="autoFollow" checked />',
  '        <span data-i18n="autoFollow">跟随最新</span>',
  '      </label>',
  '      <select id="convSelect" title="Switch Conversation" class="max-w-[145px] truncate"></select>',
  '      <select id="pricingSelect" title="Select API Pricing Tier (>200k tiered)" class="max-w-[175px] truncate">',
  '        <option value="auto" data-i18n="priceAuto">按各轮模型自动计价 (推荐)</option>',
  '        <option value="gemini_3_1_pro">Gemini 3.1/4 Pro ($2/$12)</option>',
  '        <option value="gemini_pro">Gemini 2.5 Pro ($1.25/$10)</option>',
  '        <option value="gemini_flash">Gemini Flash ($0.30/$2.5)</option>',
  '        <option value="claude_sonnet">Claude Sonnet 4.x ($3/$15)</option>',
  '        <option value="claude_opus">Claude Opus 4.x ($5/$25)</option>',
  '      </select>',
  '      <button id="langToggle" type="button" title="Switch Language / 切换中英文" class="font-medium">EN</button>',
  '    </div>',
  '  </div>',
  '',
  '  <!-- Tier 2: Full-Width Hero Card — Dual-Track Context Window -->',
  '  <div class="card space-y-2.5">',
  '    <div class="flex flex-wrap items-center justify-between gap-1.5">',
  '      <div class="flex items-center gap-2">',
  '        <span class="font-semibold text-sm" data-i18n="ctxHeroTitle">Context 窗口水位</span>',
  '        <span id="turnCountBadge" class="px-1.5 py-0.5 rounded bg-slate-500/15 muted text-[11px] tabular-nums">0 轮</span>',
  '      </div>',
  '      <span id="ctxStatusBadge" class="px-2 py-0.5 rounded text-[11px] font-medium bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">',
  '        🟢 常规安全区 (<60% 压缩水位)',
  '      </span>',
  '    </div>',
  '',
  '    <!-- Track 1: 1.05M Physical Window Bar with 200k & 256k Tick Markers -->',
  '    <div class="space-y-1">',
  '      <div class="flex items-baseline justify-between">',
  '        <span class="muted"><span data-i18n="physBarTitle">1.05M 物理窗口实际占用</span> <span class="opacity-70" data-i18n="physBarSub">(主进度条与百分比严格对齐)</span></span>',
  '        <div class="flex items-baseline gap-2 tabular-nums">',
  '          <span id="ctxTokens" class="text-sm font-bold">0 / 1.05M</span>',
  '          <span id="ctxPct" class="text-sm font-bold text-sky-400">0.00%</span>',
  '        </div>',
  '      </div>',
  '      <div class="relative w-full h-3 rounded-full bg-slate-500/20 overflow-hidden">',
  '        <div id="ctxPhysBar" class="h-full bg-sky-400 transition-all duration-300" style="width: 0%"></div>',
  '        <div id="tick200kPhys" class="absolute top-0 bottom-0 w-[2px] bg-amber-400/90 z-10" style="left: 19.07%" title="200k API Tier Threshold (19.07% of 1.05M)"></div>',
  '        <div id="tick256kPhys" class="absolute top-0 bottom-0 w-[2px] bg-rose-400/90 z-10" style="left: 24.41%" title="256k Auto-Compaction Watermark (24.41% of 1.05M)"></div>',
  '      </div>',
  '      <div class="flex flex-wrap items-center justify-between text-[11px] muted gap-1">',
  '        <div class="flex items-center gap-3">',
  '          <span class="text-amber-400/90" data-i18n="tick200kLabel">▲ 200k 阶梯价线 (19.1%)</span>',
  '          <span class="text-rose-400/90" data-i18n="tick256kLabel">▲ 256k 自动压缩线 (24.4%)</span>',
  '        </div>',
  '        <span id="ctxPhysRemain" class="tabular-nums">物理余量: 1.05M</span>',
  '      </div>',
  '    </div>',
  '',
  '    <!-- Track 2: 256k Automatic Compaction Watermark Sub-Bar -->',
  '    <div class="pt-1 border-t border-slate-500/15 space-y-1">',
  '      <div class="flex items-baseline justify-between">',
  '        <span class="muted"><span data-i18n="compBarTitle">256k 自动压缩水位进度</span> <span class="opacity-70" data-i18n="compBarSub">(Antigravity Checkpointer 阈值)</span></span>',
  '        <div class="flex items-baseline gap-2 tabular-nums">',
  '          <span id="ctxRemain" class="font-semibold text-emerald-400">0.0k / 256.0k (0.0%)</span>',
  '          <span id="ctxCompRemain" class="muted text-[11px]">距压缩还剩 256.0k</span>',
  '        </div>',
  '      </div>',
  '      <div class="relative w-full h-2 rounded-full bg-slate-500/20 overflow-hidden">',
  '        <div id="ctxBar" class="h-full bg-emerald-500 transition-all duration-300" style="width: 0%"></div>',
  '        <div class="absolute top-0 bottom-0 w-[2px] bg-amber-400/80 z-10" style="left: 78.125%" title="200k API Tier Threshold (78.1% of 256k)"></div>',
  '      </div>',
  '    </div>',
  '  </div>',
  '',
  '  <!-- Tier 3: Real-Time Speed, Latency & Cache Strip (3 Cards) -->',
  '  <div class="grid grid-cols-1 sm:grid-cols-3 gap-2.5">',
  '    <div class="card space-y-1.5">',
  '      <div class="flex items-center justify-between">',
  '        <span class="muted font-medium" data-i18n="tpsCardTitle">体感速度 (E2E TPS)</span>',
  '        <span id="tpsModeLabel" class="muted text-[11px]">含 TTFT 端到端</span>',
  '      </div>',
  '      <div class="flex items-baseline justify-between gap-1">',
  '        <span class="text-base font-bold tabular-nums text-violet-400" id="mainTps">-- tok/s</span>',
  '        <span class="muted tabular-nums text-[11px]" id="subTps"></span>',
  '      </div>',
  '      <div class="flex justify-between muted text-[11px] pt-0.5 border-t border-slate-500/10">',
  '        <span id="avgTps">均值: --</span>',
  '        <span id="peakTps">峰值: --</span>',
  '      </div>',
  '    </div>',
  '',
  '    <div class="card space-y-1.5">',
  '      <div class="flex items-center justify-between">',
  '        <span class="muted font-medium" data-i18n="ttftCardTitle">首字延迟 & 本轮输出</span>',
  '        <span id="ttftVal" class="font-bold text-amber-400 tabular-nums">TTFT: --</span>',
  '      </div>',
  '      <div class="text-base font-bold tabular-nums" id="outTokens">本轮输出: 0</div>',
  '      <div class="flex justify-between muted text-[11px] pt-0.5 border-t border-slate-500/10">',
  '        <span id="thinkRespSplit">思考: 0 | 正文: 0</span>',
  '        <span id="totalOutTokens">平均TTFT: --</span>',
  '      </div>',
  '    </div>',
  '',
  '    <div class="card space-y-1.5">',
  '      <div class="flex items-center justify-between">',
  '        <span class="muted font-medium" data-i18n="cacheCardTitle">Cache 缓存命中率</span>',
  '        <span id="cacheRate" class="font-bold text-sky-400 tabular-nums">0.0%</span>',
  '      </div>',
  '      <div class="flex items-baseline justify-between gap-1">',
  '        <span class="text-base font-bold tabular-nums" id="cacheTokens">命中 0</span>',
  '        <span id="uncachedTokens" class="muted text-[11px] tabular-nums">新增: 0</span>',
  '      </div>',
  '      <div class="w-full h-1.5 rounded-full overflow-hidden bg-amber-500/30 flex">',
  '        <div id="cacheBar" class="h-full bg-sky-400 transition-all duration-300" style="width: 0%"></div>',
  '      </div>',
  '      <div class="flex justify-between muted text-[11px]">',
  '        <span data-i18n="cacheLegend">蓝: 缓存读取 · 黄: 新增输入</span>',
  '        <span id="sessionCacheRate">累计: 0.0%</span>',
  '      </div>',
  '    </div>',
  '  </div>',
  '',
  '  <!-- Tier 4: Session Cumulative Billing & Per-Model ID Breakdown -->',
  '  <div class="card space-y-3">',
  '    <div class="flex flex-wrap items-center justify-between gap-1.5">',
  '      <div class="flex items-center gap-2">',
  '        <span class="font-semibold text-sm" data-i18n="billingCardTitle">会话累计 Token & 分模型 API 计费估算</span>',
  '        <span id="pricingModelTag" class="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 text-[11px]"></span>',
  '      </div>',
  '      <span id="sessionTotalBadge" class="font-bold text-sm text-emerald-400 tabular-nums">$0.00</span>',
  '    </div>',
  '',
  '    <!-- 2x2 / 4-Col Financial & Token Summary Strip -->',
  '    <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">',
  '      <div class="subcard border-emerald-500/25 bg-emerald-500/10 space-y-0.5">',
  '        <div class="muted text-[11px]" data-i18n="estTotalCost">等效 API 总费用</div>',
  '        <div class="text-base font-bold tabular-nums text-emerald-400" id="costTotalUsd">$0.000</div>',
  '        <div class="muted text-[11px] tabular-nums" id="costLastTurn">本轮: $0.000</div>',
  '      </div>',
  '      <div class="subcard border-sky-500/25 bg-sky-500/10 space-y-0.5">',
  '        <div class="muted text-[11px]" data-i18n="cacheSavedCost">Cache 命中已省费用</div>',
  '        <div class="text-base font-bold tabular-nums text-sky-400" id="costSavedUsd">省 $0.000 (0.0%)</div>',
  '        <div class="muted text-[11px] tabular-nums" id="costNoCacheUsd">无缓存原价: $0.000</div>',
  '      </div>',
  '      <div class="subcard space-y-0.5">',
  '        <div class="flex justify-between muted text-[11px]"><span data-i18n="cumInput">累计总输入</span><span id="costSplitUsd" class="text-sky-400 tabular-nums"></span></div>',
  '        <div class="text-sm font-bold tabular-nums text-sky-400" id="sumInTokens">0</div>',
  '        <div class="muted text-[11px] tabular-nums" id="sumInSplit">缓: 0 | 新: 0</div>',
  '      </div>',
  '      <div class="subcard space-y-0.5">',
  '        <div class="flex justify-between muted text-[11px]"><span data-i18n="cumOutput">累计总输出</span><span id="costDetailSplit" class="text-violet-400 tabular-nums"></span></div>',
  '        <div class="text-sm font-bold tabular-nums text-violet-400" id="sumOutTokens">0</div>',
  '        <div class="muted text-[11px] tabular-nums" id="sumOutSplit">思: 0 | 正: 0</div>',
  '      </div>',
  '    </div>',
  '    <div class="hidden"><span id="sumAllTokens"></span><span id="sumNetTokens"></span></div>',
  '',
  '    <!-- Per-Model ID Statistics & Billing Breakdown -->',
  '    <div class="pt-2 border-t border-slate-500/15 space-y-2">',
  '      <div class="flex items-center justify-between">',
  '        <span class="font-medium text-xs" data-i18n="perModelTitle">分模型统计与计费明细 (Per-Model ID Breakdown)</span>',
  '        <span id="modelCountBadge" class="muted text-[11px]">0 个模型</span>',
  '      </div>',
  '      <div id="modelStatsList" class="space-y-2"></div>',
  '    </div>',
  '  </div>',
  '',
  '  <!-- Tier 5: Trend Chart & Per-Turn Detail Table -->',
  '  <div class="card space-y-2">',
  '    <div class="flex items-center justify-between">',
  '      <span class="font-medium" data-i18n="trendTitle">每轮趋势 (Context 占用 & 体感 E2E TPS)</span>',
  '      <div class="flex items-center gap-3 muted text-[11px]">',
  '        <span><span class="inline-block w-2 h-2 rounded-full bg-sky-400 mr-1"></span><span data-i18n="axisCtx">Context (左轴)</span></span>',
  '        <span><span class="inline-block w-2 h-2 rounded-full bg-violet-400 mr-1"></span><span data-i18n="axisTps">E2E TPS (右轴)</span></span>',
  '      </div>',
  '    </div>',
  '    <svg id="trendSvg" viewBox="0 0 400 105" class="w-full h-24 overflow-visible"></svg>',
  '  </div>',
  '',
  '  <div class="card space-y-1.5">',
  '    <div class="flex items-center justify-between">',
  '      <span class="font-medium" data-i18n="turnTableTitle">各轮调用明细 (最新在前)</span>',
  '      <span class="muted text-[11px]" id="updatedTime"></span>',
  '    </div>',
  '    <div class="overflow-x-auto max-h-64 overflow-y-auto">',
  '      <table>',
  '        <thead>',
  '          <tr class="muted">',
  '            <th>#</th>',
  '            <th data-i18n="thModel">模型</th>',
  '            <th>Context</th>',
  '            <th>Cache%</th>',
  '            <th data-i18n="thOut">Out (思/正)</th>',
  '            <th>TTFT</th>',
  '            <th data-i18n="thDur">总耗时</th>',
  '            <th>E2E (Dec)</th>',
  '            <th data-i18n="thCost">费用</th>',
  '          </tr>',
  '        </thead>',
  '        <tbody id="turnTableBody"></tbody>',
  '      </table>',
  '    </div>',
  '  </div>',

  '  <script>',
  '    const I18N = {',
  '      zh: {',
  '        autoFollow: "跟随最新",',
  '        priceAuto: "按各轮模型自动计价 (推荐)",',
  '        ctxHeroTitle: "Context 窗口水位",',
  '        physBarTitle: "1.05M 物理窗口实际占用",',
  '        physBarSub: "(主进度条与百分比严格对齐)",',
  '        tick200kLabel: "▲ 200k 阶梯价线 (19.1%)",',
  '        tick256kLabel: "▲ 256k 自动压缩线 (24.4%)",',
  '        compBarTitle: "256k 自动压缩水位进度",',
  '        compBarSub: "(Antigravity Checkpointer 阈值)",',
  '        tpsCardTitle: "体感速度 (E2E TPS)",',
  '        ttftCardTitle: "首字延迟 & 本轮输出",',
  '        cacheCardTitle: "Cache 缓存命中率",',
  '        cacheLegend: "蓝: 缓存读取 · 黄: 新增输入",',
  '        billingCardTitle: "会话累计 Token & 分模型 API 计费估算",',
  '        estTotalCost: "等效 API 总费用",',
  '        cacheSavedCost: "Cache 命中已省费用",',
  '        cumInput: "累计总输入",',
  '        cumOutput: "累计总输出",',
  '        perModelTitle: "分模型统计与计费明细 (Per-Model ID Breakdown)",',
  '        trendTitle: "每轮趋势 (Context 占用 & 体感 E2E TPS)",',
  '        axisCtx: "Context (左轴)",',
  '        axisTps: "E2E TPS (右轴)",',
  '        turnTableTitle: "各轮调用明细 (最新在前)",',
  '        thModel: "模型",',
  '        thOut: "Out (思/正)",',
  '        thDur: "总耗时",',
  '        thCost: "费用",',
  '        noTurns: "暂无调用记录",',
  '        zeroModels: "0 个模型",',
  '        noModelData: "暂无分模型数据",',
  '        rpcMs: "RPC 毫秒级",',
  '        transcriptSec: "Transcript 秒级",',
  '        physRemain: "物理余量: ",',
  '        compDanger: "🔴 即将触发 256k 自动压缩",',
  '        compWarn: "🟡 接近 200k 计价阶梯 & 256k 压缩线",',
  '        compSafe: "🟢 常规安全区 (<60% 压缩水位)",',
  '        compRemain: "距压缩还剩 ",',
  '        turnUnit: " 轮",',
  '        compactedCount: " · 已压缩 ",',
  '        timesUnit: " 次",',
  '        hitPrefix: "命中 ",',
  '        newPrefix: "新增: ",',
  '        sessionPrefix: "累计: ",',
  '        modeE2e: "含 TTFT 端到端",',
  '        modeDec: "纯流式 Decode",',
  '        decLabel: "解码 ",',
  '        visLabel: "可见 ",',
  '        avgPrefix: "均值: ",',
  '        peakPrefix: "E2E峰值: ",',
  '        durPrefix: "耗时: ",',
  '        lastOutPrefix: "本轮输出: ",',
  '        thinkPrefix: "思考: ",',
  '        respPrefix: " | 正文: ",',
  '        respToolPrefix: "正文+工具: ",',
  '        avgTtftPrefix: "平均TTFT: ",',
  '        streamDurPrefix: "流耗时: ",',
  '        inSplitPrefix: "缓: ",',
  '        inSplitMid: " | 新: ",',
  '        outSplitPrefix: "思: ",',
  '        outSplitMid: " | 正: ",',
  '        lastTurnCostPrefix: "本轮: ",',
  '        savedPrefix: "省 ",',
  '        noCachePrefix: "无缓存原价: ",',
  '        interrupted: "中断"',
  '      },',
  '      en: {',
  '        autoFollow: "Follow Latest",',
  '        priceAuto: "Auto Per-Turn Model Pricing",',
  '        ctxHeroTitle: "Context Window Watermark",',
  '        physBarTitle: "1.05M Physical Window Usage",',
  '        physBarSub: "(Strictly aligned with percentage)",',
  '        tick200kLabel: "▲ 200k Price Tier (19.1%)",',
  '        tick256kLabel: "▲ 256k Auto-Compact (24.4%)",',
  '        compBarTitle: "256k Auto-Compaction Watermark",',
  '        compBarSub: "(Antigravity Checkpointer Soft Limit)",',
  '        tpsCardTitle: "Perceived Speed (E2E TPS)",',
  '        ttftCardTitle: "First-Token Latency & Turn Out",',
  '        cacheCardTitle: "Prompt Cache Hit Rate",',
  '        cacheLegend: "Blue: Cached Read · Amber: Uncached",',
  '        billingCardTitle: "Session Cumulative Tokens & Per-Model API Cost",',
  '        estTotalCost: "Est. API Total Cost",',
  '        cacheSavedCost: "Saved by Prompt Cache",',
  '        cumInput: "Total Input",',
  '        cumOutput: "Total Output",',
  '        perModelTitle: "Per-Model ID Statistics & Billing Breakdown",',
  '        trendTitle: "Per-Turn Trend (Context Usage & E2E TPS)",',
  '        axisCtx: "Context (Left)",',
  '        axisTps: "E2E TPS (Right)",',
  '        turnTableTitle: "Per-Turn Call Breakdown (Latest First)",',
  '        thModel: "Model",',
  '        thOut: "Out (Thk/Rsp)",',
  '        thDur: "Duration",',
  '        thCost: "Cost",',
  '        noTurns: "No turns recorded yet",',
  '        zeroModels: "0 models",',
  '        noModelData: "No per-model data yet",',
  '        rpcMs: "RPC Live (ms)",',
  '        transcriptSec: "Transcript (s)",',
  '        physRemain: "Physical Free: ",',
  '        compDanger: "🔴 Near 256k Auto-Compaction",',
  '        compWarn: "🟡 Approaching 200k Tier & 256k Limit",',
  '        compSafe: "🟢 Safe Zone (<60% of 256k Limit)",',
  '        compRemain: "To Compaction: ",',
  '        turnUnit: " turns",',
  '        compactedCount: " · Compacted ",',
  '        timesUnit: "x",',
  '        hitPrefix: "Hit ",',
  '        newPrefix: "New: ",',
  '        sessionPrefix: "Session: ",',
  '        modeE2e: "End-to-End (incl. TTFT)",',
  '        modeDec: "Stream Decode Only",',
  '        decLabel: "Dec ",',
  '        visLabel: "Vis ",',
  '        avgPrefix: "Avg: ",',
  '        peakPrefix: "Peak E2E: ",',
  '        durPrefix: "Time: ",',
  '        lastOutPrefix: "Turn Out: ",',
  '        thinkPrefix: "Think: ",',
  '        respPrefix: " | Resp: ",',
  '        respToolPrefix: "Resp+Tool: ",',
  '        avgTtftPrefix: "Avg TTFT: ",',
  '        streamDurPrefix: "Stream: ",',
  '        inSplitPrefix: "Cache: ",',
  '        inSplitMid: " | New: ",',
  '        outSplitPrefix: "Thk: ",',
  '        outSplitMid: " | Rsp: ",',
  '        lastTurnCostPrefix: "Turn: ",',
  '        savedPrefix: "Saved ",',
  '        noCachePrefix: "No-Cache: ",',
  '        interrupted: "Aborted"',
  '      }',
  '    };',
  '',
  '    let currentLang = "zh";',
  '    try {',
  '      const saved = localStorage.getItem("agy_ctx_lang");',
  '      if (saved === "en" || saved === "zh") currentLang = saved;',
  '      else if (navigator.language && !navigator.language.toLowerCase().startsWith("zh")) currentLang = "en";',
  '    } catch {}',
  '',
  '    function tr(key) {',
  '      return (I18N[currentLang] && I18N[currentLang][key]) || I18N.zh[key] || key;',
  '    }',
  '',
  '    function applyStaticI18n() {',
  '      document.documentElement.lang = currentLang === "zh" ? "zh-CN" : "en";',
  '      const btn = document.getElementById("langToggle");',
  '      if (btn) btn.textContent = currentLang === "zh" ? "EN" : "中文";',
  '      document.querySelectorAll("[data-i18n]").forEach(function(el) {',
  '        const k = el.getAttribute("data-i18n");',
  '        if (k) el.textContent = tr(k);',
  '      });',
  '    }',
  '',
  '    const params = new URLSearchParams(window.location.search);',
  '    const urlConvId = params.get("conversationId") || "";',
  '    const token = params.get("token") || "";',
  '    let selectedConvId = urlConvId;',
  '    let lastMetricsData = null;',
  '    const convSelect = document.getElementById("convSelect");',
  '    const pricingSelect = document.getElementById("pricingSelect");',
  '    const autoFollow = document.getElementById("autoFollow");',
  '    const langToggle = document.getElementById("langToggle");',
  '    if (urlConvId) autoFollow.checked = false;',
  '',
  '    langToggle.addEventListener("click", function() {',
  '      currentLang = currentLang === "zh" ? "en" : "zh";',
  '      try { localStorage.setItem("agy_ctx_lang", currentLang); } catch {}',
  '      applyStaticI18n();',
  '      if (lastMetricsData) renderData(lastMetricsData);',
  '    });',
  '    applyStaticI18n();',
  '',
  '    convSelect.addEventListener("change", function() {',
  '      selectedConvId = convSelect.value;',
  '      autoFollow.checked = false;',
  '      fetchAndRender();',
  '    });',
  '    pricingSelect.addEventListener("change", function() {',
  '      fetchAndRender();',
  '    });',
  '    autoFollow.addEventListener("change", function() {',
  '      if (autoFollow.checked) {',
  '        selectedConvId = "";',
  '        fetchAndRender();',
  '      }',
  '    });',
  '',
  '    function fmtNum(n) {',
  '      return Number(n || 0).toLocaleString("en-US");',
  '    }',
  '    function fmtCompact(n) {',
  '      const v = Number(n || 0);',
  '      if (v >= 1000000) return (v / 1000000).toFixed(2) + "M";',
  '      if (v >= 1000) return (v / 1000).toFixed(1) + "k";',
  '      return String(v);',
  '    }',
  '    function fmtUsd(n) {',
  '      const v = Number(n || 0);',
  '      if (v >= 1) return "$" + v.toFixed(2);',
  '      if (v >= 0.01) return "$" + v.toFixed(3);',
  '      return "$" + v.toFixed(4);',
  '    }',
  '    function shortModel(m) {',
  '      const s = String(m || "Gemini").trim();',
  '      return s.replace(/\\s*\\(High\\)/i, "").replace(/^models\\//, "");',
  '    }',
  '',
  '    function renderChart(turns) {',
  '      const svg = document.getElementById("trendSvg");',
  '      if (!turns || turns.length === 0) {',
  '        svg.innerHTML = "<text x=\\"200\\" y=\\"52\\" text-anchor=\\"middle\\" fill=\\"currentColor\\" opacity=\\"0.4\\">" + tr("noTurns") + "</text>";',
  '        return;',
  '      }',
  '      const w = 400, h = 92, padL = 34, padR = 32, padT = 8, padB = 16;',
  '      const plotW = w - padL - padR;',
  '      const plotH = h - padT - padB;',
  '      const maxCtx = Math.max(1000, ...turns.map(function(t) { return t.contextUsed; }));',
  '      const maxTps = Math.max(10, ...turns.map(function(t) { return t.e2eTps > 0 ? t.e2eTps : t.decodeTps; }));',
  '      const xAt = function(i) { return turns.length === 1 ? padL + plotW / 2 : padL + (i / (turns.length - 1)) * plotW; };',
  '      const yCtx = function(v) { return padT + plotH - (v / maxCtx) * plotH; };',
  '      const yTps = function(v) { return padT + plotH - (v / maxTps) * plotH; };',
  '',
  '      const ctxPts = turns.map(function(t, i) { return xAt(i).toFixed(1) + "," + yCtx(t.contextUsed).toFixed(1); }).join(" ");',
  '      const tpsPts = turns.map(function(t, i) {',
  '        const val = t.e2eTps > 0 ? t.e2eTps : t.decodeTps;',
  '        return xAt(i).toFixed(1) + "," + yTps(val).toFixed(1);',
  '      }).join(" ");',
  '',
  '      const dotsCtx = turns.map(function(t, i) {',
  '        return "<circle cx=\\"" + xAt(i).toFixed(1) + "\\" cy=\\"" + yCtx(t.contextUsed).toFixed(1) + "\\" r=\\"2.3\\" fill=\\"#38bdf8\\" />";',
  '      }).join("");',
  '      const dotsTps = turns.map(function(t, i) {',
  '        const val = t.e2eTps > 0 ? t.e2eTps : t.decodeTps;',
  '        return "<circle cx=\\"" + xAt(i).toFixed(1) + "\\" cy=\\"" + yTps(val).toFixed(1) + "\\" r=\\"2.3\\" fill=\\"#a78bfa\\" />";',
  '      }).join("");',
  '',
  '      svg.innerHTML =',
  '        "<line x1=\\"" + padL + "\\" y1=\\"" + padT + "\\" x2=\\"" + (w - padR) + "\\" y2=\\"" + padT + "\\" stroke=\\"currentColor\\" stroke-opacity=\\"0.1\\" />" +',
  '        "<line x1=\\"" + padL + "\\" y1=\\"" + (padT + plotH) + "\\" x2=\\"" + (w - padR) + "\\" y2=\\"" + (padT + plotH) + "\\" stroke=\\"currentColor\\" stroke-opacity=\\"0.2\\" />" +',
  '        "<text x=\\"" + (padL - 4) + "\\" y=\\"" + (padT + 8) + "\\" text-anchor=\\"end\\" font-size=\\"10\\" fill=\\"#38bdf8\\">" + fmtCompact(maxCtx) + "</text>" +',
  '        "<text x=\\"" + (padL - 4) + "\\" y=\\"" + (padT + plotH) + "\\" text-anchor=\\"end\\" font-size=\\"10\\" fill=\\"currentColor\\" opacity=\\"0.5\\">0</text>" +',
  '        "<text x=\\"" + (w - padR + 4) + "\\" y=\\"" + (padT + 8) + "\\" text-anchor=\\"start\\" font-size=\\"10\\" fill=\\"#a78bfa\\">" + maxTps.toFixed(0) + "</text>" +',
  '        "<polyline fill=\\"none\\" stroke=\\"#38bdf8\\" stroke-width=\\"2\\" points=\\"" + ctxPts + "\\" />" +',
  '        "<polyline fill=\\"none\\" stroke=\\"#a78bfa\\" stroke-width=\\"2\\" stroke-dasharray=\\"3,2\\" points=\\"" + tpsPts + "\\" />" +',
  '        dotsCtx + dotsTps;',
  '    }',
  '',
  '    function renderModelStats(models) {',
  '      const container = document.getElementById("modelStatsList");',
  '      const badge = document.getElementById("modelCountBadge");',
  '      if (!models || models.length === 0) {',
  '        badge.textContent = tr("zeroModels");',
  '        container.innerHTML = "<div class=\\"muted text-[11px]\\">" + tr("noModelData") + "</div>";',
  '        return;',
  '      }',
  '      badge.textContent = currentLang === "zh"',
  '        ? ("共 " + models.length + " 个模型 · 按实际模型分别统计与计费")',
  '        : (models.length + " model(s) · billed & aggregated per model");',
  '      container.innerHTML = models.map(function(m) {',
  '        const showRawId = m.modelId && m.modelId !== m.model;',
  '        const hiTag = m.highTierTurnCount > 0',
  '          ? ("<span class=\\"px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 text-[10px]\\">>200k: " + m.highTierTurnCount + (currentLang === "zh" ? "轮" : "t") + "</span>")',
  '          : "";',
  '        const tpsStr = m.avgE2eTps > 0',
  '          ? (m.avgE2eTps.toFixed(1) + " tok/s" + (m.avgDecodeTps > 0 ? (" (" + tr("decLabel") + m.avgDecodeTps.toFixed(0) + ")") : ""))',
  '          : (m.avgDecodeTps > 0 ? (m.avgDecodeTps.toFixed(1) + " tok/s") : "--");',
  '        const tierBadgeLabel = currentLang === "zh" ? "计价: " : "Tier: ";',
  '        const lblTurns = currentLang === "zh" ? "轮数/吞吐: " : "Turns/Vol: ";',
  '        const lblIn = currentLang === "zh" ? "输入(缓/新): " : "In (Hit/New): ";',
  '        const lblOut = currentLang === "zh" ? "输出/均速: " : "Out/Speed: ";',
  '        const lblCost = currentLang === "zh" ? "费用构成: " : "Cost Split: ";',
  '        const turnSuffix = currentLang === "zh" ? "轮" : "t";',
  '        return "<div class=\\"subcard space-y-1.5\\">" +',
  '          "<div class=\\"flex flex-wrap items-center justify-between gap-1\\">" +',
  '            "<div class=\\"flex flex-wrap items-center gap-1.5\\">" +',
  '              "<span class=\\"font-semibold text-xs\\">" + m.model + "</span>" +',
  '              (showRawId ? ("<code class=\\"px-1 py-0.5 rounded bg-slate-500/20 muted text-[10px]\\">" + m.modelId + "</code>") : "") +',
  '              "<span class=\\"px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-300 text-[10px]\\" title=\\"" + (m.pricingProfileFullLabel || "") + "\\">" + tierBadgeLabel + (m.pricingProfileLabel || "") + "</span>" +',
  '              hiTag +',
  '            "</div>" +',
  '            "<div class=\\"flex items-center gap-2 tabular-nums\\">" +',
  '              "<span class=\\"text-sky-400 text-[11px]\\">" + tr("savedPrefix") + fmtUsd(m.savedByCacheUsd) + " (-" + Number(m.savedByCachePct || 0).toFixed(1) + "%)</span>" +',
  '              "<span class=\\"font-bold text-sm text-emerald-400\\">" + fmtUsd(m.costUsd) + "</span>" +',
  '              "<span class=\\"muted text-[11px]\\">(" + Number(m.costSharePct || 0).toFixed(1) + "%)</span>" +',
  '            "</div>" +',
  '          "</div>" +',
  '          "<div class=\\"w-full h-1.5 rounded-full bg-slate-500/20 overflow-hidden flex\\">" +',
  '            "<div class=\\"h-full bg-emerald-400 transition-all duration-300\\" style=\\"width: " + Math.min(100, Number(m.costSharePct || 0)).toFixed(1) + "%\\"></div>" +',
  '          "</div>" +',
  '          "<div class=\\"grid grid-cols-2 sm:grid-cols-4 gap-1.5 text-[11px] pt-0.5 tabular-nums\\">" +',
  '            "<div><span class=\\"muted\\">" + lblTurns + "</span><span class=\\"font-medium\\">" + m.turnCount + turnSuffix + " (" + m.turnSharePct.toFixed(0) + "%) · " + fmtCompact(m.totalTokens) + "</span></div>" +',
  '            "<div><span class=\\"muted\\">" + lblIn + "</span><span class=\\"text-sky-400\\">" + fmtCompact(m.inCached) + "</span> / " + fmtCompact(m.inUncached) + " <span class=\\"muted\\">(" + m.cacheHitRate.toFixed(1) + "%)</span></div>" +',
  '            "<div><span class=\\"muted\\">" + lblOut + "</span><span class=\\"text-violet-400\\">" + fmtCompact(m.outTokens) + "</span> <span class=\\"muted\\">(" + tpsStr + ")</span></div>" +',
  '            "<div><span class=\\"muted\\">" + lblCost + "</span>In " + fmtUsd(m.inputCostUsd) + " · Out " + fmtUsd(m.outputCostUsd) + "</div>" +',
  '          "</div>" +',
  '        "</div>";',
  '      }).join("");',
  '    }',
  '',
  '    function renderData(data) {',
  '      const s = data.summary || {};',
  '      const list = data.recentConversations || [];',
  '      const currentOptions = Array.from(convSelect.options).map(function(o) { return o.value; }).join(",");',
  '      const nextOptions = list.map(function(x) { return x.conversationId; }).join(",");',
  '      if (currentOptions !== nextOptions) {',
  '        convSelect.innerHTML = list.map(function(x) {',
  '          return "<option value=\\"" + x.conversationId + "\\">" + x.conversationId.slice(0, 8) + " (" + x.surface.replace("antigravity", "agy") + ")</option>";',
  '        }).join("");',
  '      }',
  '      if (data.conversationId) {',
  '        convSelect.value = data.conversationId;',
  '        if (!selectedConvId) selectedConvId = data.conversationId;',
  '      }',
  '',
  '      document.getElementById("modelBadge").textContent = data.model || "Gemini";',
  '      const srcBadge = document.getElementById("sourceBadge");',
  '      srcBadge.textContent = data.rpcConnected ? tr("rpcMs") : tr("transcriptSec");',
  '      srcBadge.className = "px-1.5 py-0.5 rounded text-[11px] border shrink-0 " +',
  '        (data.rpcConnected ? "border-emerald-500/40 text-emerald-400" : "border-amber-500/40 text-amber-400");',
  '',
  '      const maxPhys = Number(s.maxContext || 1048576);',
  '      const compLimit = Number(s.compactionMaxContext || 256000);',
  '      const pct = Number(s.contextUsedPct || 0);',
  '      const compPct = Number(s.compactionUsedPct || 0);',
  '',
  '      document.getElementById("ctxPct").textContent = pct.toFixed(2) + "%";',
  '      document.getElementById("ctxTokens").textContent = fmtNum(s.contextUsed) + " / " + fmtCompact(maxPhys);',
  '      document.getElementById("ctxPhysBar").style.width = Math.min(100, pct).toFixed(2) + "%";',
  '      document.getElementById("tick200kPhys").style.left = Math.min(100, (200000 / maxPhys) * 100).toFixed(2) + "%";',
  '      document.getElementById("tick256kPhys").style.left = Math.min(100, (compLimit / maxPhys) * 100).toFixed(2) + "%";',
  '      document.getElementById("ctxPhysRemain").textContent = tr("physRemain") + fmtCompact(s.contextRemaining);',
  '',
  '      const ctxBar = document.getElementById("ctxBar");',
  '      ctxBar.style.width = Math.min(100, compPct).toFixed(1) + "%";',
  '      const statusBadge = document.getElementById("ctxStatusBadge");',
  '      const ctxRemainEl = document.getElementById("ctxRemain");',
  '      if (compPct > 85) {',
  '        ctxBar.className = "h-full transition-all duration-300 bg-rose-500";',
  '        ctxRemainEl.className = "font-semibold text-rose-400";',
  '        statusBadge.className = "px-2 py-0.5 rounded text-[11px] font-medium bg-rose-500/15 text-rose-400 border border-rose-500/30";',
  '        statusBadge.textContent = tr("compDanger") + " (" + compPct.toFixed(1) + "%)";',
  '      } else if (compPct > 60) {',
  '        ctxBar.className = "h-full transition-all duration-300 bg-amber-500";',
  '        ctxRemainEl.className = "font-semibold text-amber-400";',
  '        statusBadge.className = "px-2 py-0.5 rounded text-[11px] font-medium bg-amber-500/15 text-amber-400 border border-amber-500/30";',
  '        statusBadge.textContent = tr("compWarn") + " (" + compPct.toFixed(1) + "%)";',
  '      } else {',
  '        ctxBar.className = "h-full transition-all duration-300 bg-emerald-500";',
  '        ctxRemainEl.className = "font-semibold text-emerald-400";',
  '        statusBadge.className = "px-2 py-0.5 rounded text-[11px] font-medium bg-emerald-500/15 text-emerald-400 border border-emerald-500/30";',
  '        statusBadge.textContent = tr("compSafe");',
  '      }',
  '      ctxRemainEl.textContent = fmtCompact(s.contextUsed) + " / " + fmtCompact(compLimit) + " (" + compPct.toFixed(1) + "%)";',
  '      document.getElementById("ctxCompRemain").textContent = tr("compRemain") + fmtCompact(s.compactionRemaining);',
  '      const cpCount = Number(s.checkpointCount || 0);',
  '      document.getElementById("turnCountBadge").textContent = (s.turnCount || 0) + tr("turnUnit") + (cpCount > 0 ? (tr("compactedCount") + cpCount + tr("timesUnit")) : "");',
  '',
  '      const hitRate = Number(s.lastCacheHitRate || 0);',
  '      document.getElementById("cacheRate").textContent = hitRate.toFixed(1) + "%";',
  '      document.getElementById("cacheTokens").textContent = tr("hitPrefix") + fmtNum(s.lastCachedTokens);',
  '      document.getElementById("cacheBar").style.width = Math.min(100, hitRate).toFixed(1) + "%";',
  '      document.getElementById("uncachedTokens").textContent = tr("newPrefix") + fmtCompact(s.lastUncachedTokens);',
  '      document.getElementById("sessionCacheRate").textContent = tr("sessionPrefix") + Number(s.sessionCacheHitRate || 0).toFixed(1) + "%";',
  '',
  '      const e2eTps = Number(s.lastE2eTps || 0);',
  '      const decTps = Number(s.lastDecodeTps || 0);',
  '      const visTps = Number(s.lastVisibleE2eTps || 0);',
  '      const primaryTps = e2eTps > 0 ? e2eTps : decTps;',
  '      document.getElementById("tpsModeLabel").textContent = e2eTps > 0 ? tr("modeE2e") : tr("modeDec");',
  '      document.getElementById("mainTps").textContent = primaryTps > 0 ? primaryTps.toFixed(1) + " tok/s" : "-- tok/s";',
  '      const subParts = [];',
  '      if (decTps > 0) subParts.push(tr("decLabel") + decTps.toFixed(1));',
  '      if (visTps > 0 && Number(s.lastThinkTokens || 0) > 0) subParts.push(tr("visLabel") + visTps.toFixed(1));',
  '      document.getElementById("subTps").textContent = subParts.join(" · ");',
  '      const avgE2e = Number(s.avgE2eTps || 0);',
  '      const avgDec = Number(s.avgDecodeTps || 0);',
  '      document.getElementById("avgTps").textContent =',
  '        tr("avgPrefix") + (avgE2e > 0 ? avgE2e.toFixed(1) : avgDec.toFixed(1)) +',
  '        (avgDec > 0 && avgE2e > 0 ? (" (" + tr("decLabel") + avgDec.toFixed(0) + ")") : " tok/s");',
  '      document.getElementById("peakTps").textContent = tr("peakPrefix") + Number(s.peakE2eTps || s.peakTps || 0).toFixed(1);',
  '',
  '      document.getElementById("ttftVal").textContent = s.lastTtftSec > 0',
  '        ? ("TTFT: " + Number(s.lastTtftSec).toFixed(2) + "s")',
  '        : (s.lastE2eSec > 0 ? (tr("durPrefix") + Number(s.lastE2eSec).toFixed(1) + "s") : "TTFT: --");',
  '      document.getElementById("outTokens").textContent = tr("lastOutPrefix") + fmtNum(s.lastOutTokens);',
  '      document.getElementById("thinkRespSplit").textContent = s.lastThinkTokens > 0',
  '        ? (tr("thinkPrefix") + fmtCompact(s.lastThinkTokens) + tr("respPrefix") + fmtCompact(s.lastRespTokens))',
  '        : (tr("respToolPrefix") + fmtCompact(s.lastOutTokens));',
  '      document.getElementById("totalOutTokens").textContent = s.avgTtftSec > 0',
  '        ? (tr("avgTtftPrefix") + Number(s.avgTtftSec).toFixed(2) + "s")',
  '        : (tr("streamDurPrefix") + Number(s.lastStreamSec || s.lastE2eSec || 0).toFixed(1) + "s");',
  '',
  '      document.getElementById("sessionTotalBadge").textContent = fmtCompact(s.sessionTotalTokens) + " tok · " + fmtUsd(s.totalCostUsd);',
  '      document.getElementById("sumAllTokens").textContent = fmtNum(s.sessionTotalTokens);',
  '      document.getElementById("sumNetTokens").textContent = fmtCompact(s.sessionNetTokens);',
  '      document.getElementById("sumInTokens").textContent = fmtNum(s.totalInputTokens);',
  '      document.getElementById("sumInSplit").textContent =',
  '        tr("inSplitPrefix") + fmtCompact(s.totalInCached) + tr("inSplitMid") + fmtCompact(s.totalInUncached);',
  '      document.getElementById("sumOutTokens").textContent = fmtNum(s.totalOutTokens);',
  '      document.getElementById("sumOutSplit").textContent =',
  '        tr("outSplitPrefix") + fmtCompact(s.totalThinkTokens) + tr("outSplitMid") + fmtCompact(s.totalRespTokens);',
  '',
  '      document.getElementById("pricingModelTag").textContent = s.pricingProfileLabel || "";',
  '      document.getElementById("costTotalUsd").textContent = fmtUsd(s.totalCostUsd);',
  '      const hiCount = Number(s.highTierTurnCount || 0);',
  '      document.getElementById("costLastTurn").textContent =',
  '        tr("lastTurnCostPrefix") + fmtUsd(s.lastTurnCostUsd) + (hiCount > 0 ? (" · >200k: " + hiCount + (currentLang === "zh" ? "轮" : "t")) : "");',
  '      document.getElementById("costSplitUsd").textContent = fmtUsd(s.totalInputCostUsd);',
  '      document.getElementById("costDetailSplit").textContent = fmtUsd(s.totalOutputCostUsd);',
  '      document.getElementById("costSavedUsd").textContent =',
  '        tr("savedPrefix") + fmtUsd(s.savedByCacheUsd) + " (-" + Number(s.savedByCachePct || 0).toFixed(1) + "%)";',
  '      document.getElementById("costNoCacheUsd").textContent =',
  '        tr("noCachePrefix") + fmtUsd(s.noCacheTotalCostUsd);',
  '',
  '      document.getElementById("convTitle").textContent = data.title || "";',
  '      document.getElementById("updatedTime").textContent = new Date().toLocaleTimeString();',
  '',
  '      renderModelStats(data.modelStats || []);',
  '      renderChart(data.turns || []);',
  '',
  '      const tbody = document.getElementById("turnTableBody");',
  '      const revTurns = (data.turns || []).slice().reverse();',
  '      tbody.innerHTML = revTurns.map(function(t) {',
  '        const outSplit = t.thinkTokens > 0',
  '          ? (fmtNum(t.outTokens) + " <span class=\\"muted\\">(" + fmtCompact(t.thinkTokens) + "/" + fmtCompact(t.respTokens) + ")</span>")',
  '          : fmtNum(t.outTokens);',
  '        const durCell = t.interrupted',
  '          ? "<span class=\\"text-rose-400\\">" + tr("interrupted") + "</span>"',
  '          : (t.e2eSec > 0 ? t.e2eSec.toFixed(1) + "s" : "-");',
  '        const tpsCell = t.e2eTps > 0',
  '          ? (t.e2eTps.toFixed(1) + (t.decodeTps > 0 ? " <span class=\\"muted\\">(" + t.decodeTps.toFixed(0) + ")</span>" : ""))',
  '          : (t.decodeTps > 0 ? t.decodeTps.toFixed(1) : "-");',
  '        const costCell = fmtUsd(t.costUsd || 0) + (t.isHighTier ? " <span class=\\"text-amber-400\\" title=\\">200k Tier\\">↑</span>" : "");',
  '        const modelCell = "<span class=\\"muted\\" title=\\"" + (t.modelId || t.model || "") + " · " + (t.pricingProfileLabel || "") + "\\">" + shortModel(t.model || t.modelId) + "</span>";',
  '        return "<tr>" +',
  '          "<td class=\\"font-medium\\">#" + t.turn + "</td>" +',
  '          "<td>" + modelCell + "</td>" +',
  '          "<td>" + fmtCompact(t.contextUsed) + "</td>" +',
  '          "<td class=\\"text-sky-400\\">" + t.cacheHitRate.toFixed(1) + "%</td>" +',
  '          "<td>" + outSplit + "</td>" +',
  '          "<td class=\\"text-amber-400\\">" + (t.ttftSec > 0 ? t.ttftSec.toFixed(2) + "s" : "-") + "</td>" +',
  '          "<td>" + durCell + "</td>" +',
  '          "<td class=\\"font-semibold text-violet-400\\">" + tpsCell + "</td>" +',
  '          "<td class=\\"text-emerald-400\\">" + costCell + "</td>" +',
  '        "</tr>";',
  '      }).join("");',
  '    }',
  '',
  '    async function fetchAndRender() {',
  '      try {',
  '        const q = new URLSearchParams();',
  '        if (!autoFollow.checked && selectedConvId) q.set("conversationId", selectedConvId);',
  '        if (pricingSelect && pricingSelect.value) q.set("pricing", pricingSelect.value);',
  '        if (token) q.set("token", token);',
  '        const res = await fetch("/api/metrics?" + q.toString(), {',
  '          headers: token ? { "X-Sidecar-Token": token } : {}',
  '        });',
  '        if (!res.ok) return;',
  '        const data = await res.json();',
  '        lastMetricsData = data;',
  '        renderData(data);',
  '      } catch (e) {',
  '        console.error("Failed to refresh metrics:", e);',
  '      }',
  '    }',
  '',
  '    fetchAndRender();',
  '    setInterval(fetchAndRender, 2000);',
  '  </script>',
  '</body>',
  '</html>',
].join('\n');

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${BIND_HOST}:${PORT}`);

  if (!validateToken(req, url)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/preload.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
    res.end(PRELOAD_JS);
    return;
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML_PAGE);
    return;
  }

  if (url.pathname === '/api/metrics') {
    const convId = url.searchParams.get('conversationId') || '';
    const pricing = url.searchParams.get('pricing') || 'auto';
    const metrics = await getConversationMetrics(convId, pricing);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(metrics));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

if (!process.env.AGY_MONITOR_NO_AUTO_LISTEN) {
  server.listen(PORT, BIND_HOST, () => {
    console.log(`[context-monitor] listening on http://${BIND_HOST}:${PORT}`);
  });
}

export {
  PRICING_PROFILES,
  resolvePricingProfileKey,
  computeTurnCost,
  parseDurationSec,
  discoverLocalTranscripts,
  parseTranscriptMetrics,
  getConversationMetrics,
  validateToken,
  HTML_PAGE,
  PRELOAD_JS,
  server,
};
