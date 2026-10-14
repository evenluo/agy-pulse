// Conversation metrics for the Context & TPS panel.
//
// Combines two sources:
// 1. Language Server RPC `GetCascadeTrajectoryGeneratorMetadata` (when the host
//    injects ANTIGRAVITY_LS_ADDRESS / ANTIGRAVITY_CSRF_TOKEN): millisecond TTFT,
//    streaming duration, thinking/response token split, context window metadata.
// 2. Local transcripts at ~/.gemini/antigravity*/brain/<id>/.system_generated/logs/transcript.jsonl:
//    token usage, model switches and checkpoints; durations are estimated from step timestamps.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PRICING_PROFILES, computeTurnCost, resolvePricingProfileKey } from './pricing.mjs';

const LS_ADDR = process.env.ANTIGRAVITY_LS_ADDRESS || '';
const CSRF_TOKEN = process.env.ANTIGRAVITY_CSRF_TOKEN || '';
const APP_DIRS = ['antigravity', 'antigravity-ide', 'antigravity-cli'];
const DEFAULT_PHYSICAL_MAX_CONTEXT = 1048576; // 1M physical window for Gemini 3 / 4
const DEFAULT_COMPACTION_MAX_CONTEXT = 256000; // Antigravity checkpointer soft limit (256k)

export function parseDurationSec(dur) {
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

export function discoverLocalTranscripts() {
  const geminiRoot = process.env.AGY_GEMINI_ROOT || join(homedir(), '.gemini');
  const items = [];

  for (const appDir of APP_DIRS) {
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

export function parseTranscriptMetrics(transcriptPath) {
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
      const step = JSON.parse(line);
      if (step && typeof step === 'object' && !Array.isArray(step)) steps.push(step);
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

export async function getConversationMetrics(requestedConvId, requestedPricing) {
  const localList = discoverLocalTranscripts();
  // A requested conversation without a local transcript still gets RPC data;
  // it never falls back to another conversation's transcript.
  const targetEntry = requestedConvId
    ? localList.find((x) => x.conversationId === requestedConvId) || null
    : localList[0] || null;

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
      pricingProfileLabel: pricingProfile.shortLabel,
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
