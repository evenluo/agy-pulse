// Conversation metrics for the Context & TPS panel.
//
// Combines two sources:
// 1. Language Server RPC `GetCascadeTrajectoryGeneratorMetadata` (when the host
//    injects ANTIGRAVITY_LS_ADDRESS / ANTIGRAVITY_CSRF_TOKEN): millisecond TTFT,
//    streaming duration, thinking/response token split, context window metadata.
// 2. Local transcripts at ~/.gemini/antigravity*/brain/<id>/.system_generated/logs/transcript.jsonl:
//    token usage, model switches and checkpoints; durations are estimated from step timestamps.

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRICING_PROFILES, computeTurnCost, resolvePricingProfileKey } from './pricing.mjs';

const APP_DIRS = ['antigravity', 'antigravity-ide', 'antigravity-cli'];
const TRANSCRIPT_CACHE_MAX = 64;
const transcriptCache = new Map();

function realPath(p) {
  return existsSync(p) ? realpathSync(p) : resolve(p);
}

// Resolve the host's own ~/.gemini/<surface> dir when Antigravity runs this
// sidecar, disabled under AGY_GEMINI_ROOT so tests and demo runs stay isolated.
function resolveHostAppDataDir() {
  if (process.env.AGY_GEMINI_ROOT) return '';
  const execDataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (execDataDir) {
    for (let d = execDataDir; d !== dirname(d); d = dirname(d)) {
      if (basename(d) !== 'sidecar_data') continue;
      const appData = dirname(d);
      if (existsSync(join(appData, 'brain'))) return appData;
    }
  }
  const appDataDir = process.env.ANTIGRAVITY_APP_DATA_DIR;
  if (appDataDir && existsSync(join(appDataDir, 'brain'))) return appDataDir;
  return '';
}

function candidateBrainDirs() {
  const geminiRoot = process.env.AGY_GEMINI_ROOT || join(homedir(), '.gemini');
  const hostAppDataDir = resolveHostAppDataDir();
  const hostReal = hostAppDataDir ? realPath(hostAppDataDir) : '';
  const seenBrain = new Set();
  const candidates = [];

  for (const appDir of APP_DIRS) {
    const appPath = join(geminiRoot, appDir);
    const brainDir = join(appPath, 'brain');
    if (!existsSync(brainDir)) continue;
    const brainReal = realPath(brainDir);
    if (seenBrain.has(brainReal)) continue;
    seenBrain.add(brainReal);
    candidates.push({
      surface: appDir,
      brainDir,
      isHostSurface: Boolean(hostReal && realPath(appPath) === hostReal),
    });
  }

  if (hostAppDataDir) {
    const brainDir = join(hostAppDataDir, 'brain');
    if (existsSync(brainDir)) {
      const brainReal = realPath(brainDir);
      if (!seenBrain.has(brainReal)) {
        seenBrain.add(brainReal);
        candidates.unshift({
          surface: basename(hostAppDataDir),
          brainDir,
          isHostSurface: true,
        });
      }
    }
  }

  return candidates;
}
const DEFAULT_PHYSICAL_MAX_CONTEXT = 1048576; // 1M physical window for Gemini 3 / 4
// Used when the RPC reports no limit. Google does not document the threshold;
// community measurements put it at about 256k tokens on Gemini 3.8 Flash
// (https://github.com/google-antigravity/antigravity-cli/issues/878).
const DEFAULT_COMPACTION_MAX_CONTEXT = 256000;
// Transcript durations are gaps between step timestamps (1-second resolution, TTFT
// and any wait for tool approval included), so the TPS estimate filters them:
const TRANSCRIPT_MIN_TPS = 8; // a slower gap is treated as a wait, not generation
const TRANSCRIPT_MAX_TURN_SEC = 600; // cap transcript step gaps at 10 minutes
const TRANSCRIPT_MIN_SAMPLE_TOKENS = 100; // shorter turns are mostly TTFT
const TRANSCRIPT_MIN_SAMPLE_SEC = 2; // 1s step gaps carry up to 2x timestamp rounding error
const TRANSCRIPT_STALL_QUANTILE = 0.75; // upper-quartile anchor survives >=50% approval-wait sessions
const TRANSCRIPT_STALL_RATIO = 3; // a turn below p75 / 3 for its model waited on something

export function parseDurationSec(dur) {
  if (!dur) return 0;
  if (typeof dur === 'number') return dur;
  const s = String(dur).trim();
  if (s.endsWith('ms')) return (parseFloat(s.slice(0, -2)) || 0) / 1000;
  if (s.endsWith('s')) return parseFloat(s.slice(0, -1)) || 0;
  return parseFloat(s) || 0;
}

async function callLsRpc(method, body, timeoutMs = 2500) {
  const lsAddr = process.env.ANTIGRAVITY_LS_ADDRESS || '';
  const csrfToken = process.env.ANTIGRAVITY_CSRF_TOKEN || '';
  if (!lsAddr || !csrfToken) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(
      `http://${lsAddr}/exa.language_server_pb.LanguageServerService/${method}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-codeium-csrf-token': csrfToken,
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
  const items = [];

  for (const { surface, brainDir, isHostSurface } of candidateBrainDirs()) {
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
          surface,
          transcriptPath,
          mtimeMs: st.mtimeMs,
          size: st.size,
          isHostSurface,
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

function findTranscriptById(convId) {
  if (!convId) return null;
  const candidates = candidateBrainDirs().sort(
    (a, b) => Number(b.isHostSurface) - Number(a.isHostSurface)
  );
  for (const { surface, brainDir, isHostSurface } of candidates) {
    const transcriptPath = join(brainDir, convId, '.system_generated', 'logs', 'transcript.jsonl');
    if (!existsSync(transcriptPath)) continue;
    try {
      const st = statSync(transcriptPath);
      return {
        conversationId: convId,
        surface,
        transcriptPath,
        mtimeMs: st.mtimeMs,
        size: st.size,
        isHostSurface,
        updatedAt: st.mtime.toISOString(),
      };
    } catch {
      // ignore unreadable entry
    }
  }
  return null;
}

function parseTranscriptRaw(transcriptPath) {
  let raw = '';
  try {
    raw = readFileSync(transcriptPath, 'utf-8');
  } catch {
    return null;
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
  const rawTurns = [];

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
      for (const settingsMatch of s.content.matchAll(
        /<USER_SETTINGS_CHANGE>([\s\S]*?)<\/USER_SETTINGS_CHANGE>/g
      )) {
        for (const mmFull of settingsMatch[1].matchAll(
          /Model Selection` from ([^\n]+?) to ([^\n]+?)(?:\.\s+No need to comment|\.\s*$|\n|$)/g
        )) {
          const fromModel = mmFull[1].trim();
          const toModel = mmFull[2].trim();
          if (!currentModel && fromModel && fromModel !== 'None') {
            for (const prevTurn of rawTurns) {
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

      // Estimate E2E duration only from normal tool-execution step (GENERIC), excluding
      // ERROR_MESSAGE timeouts and human approval or tool stalls (< TRANSCRIPT_MIN_TPS).
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
        if (
          !Number.isNaN(dt) &&
          dt >= 0.05 &&
          dt <= TRANSCRIPT_MAX_TURN_SEC &&
          outTokens / dt >= TRANSCRIPT_MIN_TPS
        ) {
          estDurationSec = dt;
        }
      }

      const stepModelId = s.model || s.model_id || s.response_model || currentModel || '';
      if (stepModelId && !modelHint) {
        modelHint = stepModelId;
      }

      const explicitModel = currentModel || stepModelId || '';
      rawTurns.push({
        turn: rawTurns.length + 1,
        stepIndex: s.step_index ?? i,
        hasStepIndex: s.step_index !== undefined && s.step_index !== null,
        createdAt: s.created_at || null,
        interrupted,
        model: explicitModel,
        modelId: stepModelId || currentModel || '',
        hasExplicitModel: Boolean(explicitModel),
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
        hasThinkSplit: false,
        ttftSec: 0,
        streamSec: 0,
        e2eSec: estDurationSec,
        decodeTps: 0,
        e2eTps: !interrupted && estDurationSec >= 0.05 ? outTokens / estDurationSec : 0,
        visibleE2eTps: !interrupted && estDurationSec >= 0.05 ? outTokens / estDurationSec : 0,
        e2eSource: 'transcript',
        source: 'transcript',
      });
    }
  }

  return {
    rawTurns,
    firstUserPrompt,
    detectedModel: currentModel || modelHint || '',
    checkpointCount,
  };
}

export function parseTranscriptMetrics(transcriptPath, fallbackModelName) {
  if (!transcriptPath || !existsSync(transcriptPath)) {
    return { turns: [], firstUserPrompt: '', modelHint: '', detectedModel: '', checkpointCount: 0 };
  }
  let st;
  try {
    st = statSync(transcriptPath);
  } catch {
    return { turns: [], firstUserPrompt: '', modelHint: '', detectedModel: '', checkpointCount: 0 };
  }

  const cacheKey = `${st.mtimeMs}:${st.size}`;
  let cached = transcriptCache.get(transcriptPath);
  if (cached && cached.key === cacheKey) {
    // Refresh insertion order for LRU eviction.
    transcriptCache.delete(transcriptPath);
    transcriptCache.set(transcriptPath, cached);
  } else {
    const parsed = parseTranscriptRaw(transcriptPath);
    if (!parsed) {
      return { turns: [], firstUserPrompt: '', modelHint: '', detectedModel: '', checkpointCount: 0 };
    }
    if (transcriptCache.size >= TRANSCRIPT_CACHE_MAX) {
      transcriptCache.delete(transcriptCache.keys().next().value);
    }
    cached = { key: cacheKey, ...parsed };
    transcriptCache.set(transcriptPath, cached);
  }

  const fallbackModel = cached.detectedModel || fallbackModelName || 'Gemini 3.1 Pro (High)';
  const turns = cached.rawTurns.map((raw) => {
    const t = { ...raw };
    if (t.model) t.hasExplicitModel = true;
    if (!t.model) t.model = fallbackModel;
    if (!t.modelId) t.modelId = t.model;
    return t;
  });

  return {
    turns,
    firstUserPrompt: cached.firstUserPrompt,
    modelHint: fallbackModel,
    detectedModel: cached.detectedModel,
    checkpointCount: cached.checkpointCount,
  };
}

function quantile(values, q) {
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] !== undefined
    ? sorted[base] + rest * (sorted[base + 1] - sorted[base])
    : sorted[base];
}

function turnModelGroupKey(turn) {
  const modelId = String(turn.modelId || turn.model || 'Gemini').trim();
  const modelName = String(turn.model || modelId).trim();
  return `${modelId}::${modelName}`;
}

function isTranscriptTimed(turn) {
  return (turn.e2eSource || turn.source) === 'transcript';
}

// Turns that feed the time-weighted average, peak, and last-measured E2E TPS. For
// transcript-timed turns, prefer substantive ones (>=100 tokens and >=2s) so tiny
// tool-call turns and 1-second timestamp rounding spikes do not skew the speed
// (falling back to all valid turns), then drop turns far below that model's upper-
// quartile rate: a long turn that also waited for approval clears TRANSCRIPT_MIN_TPS,
// per-model grouping keeps a fast model from dropping a slower model's turns, and p75
// stays anchored on generation speed even when >=50% of tool calls waited on approval.
function evaluateE2eTurns(turns) {
  const valid = turns.filter((t) => !t.interrupted && t.e2eSec >= 0.05 && t.outTokens > 0);
  const substantive = valid.filter(
    (t) =>
      !isTranscriptTimed(t) ||
      (t.outTokens >= TRANSCRIPT_MIN_SAMPLE_TOKENS && t.e2eSec >= TRANSCRIPT_MIN_SAMPLE_SEC)
  );
  const sample = substantive.length > 0 ? substantive : valid;

  const ratesByModel = new Map();
  for (const t of sample) {
    const key = turnModelGroupKey(t);
    if (!ratesByModel.has(key)) ratesByModel.set(key, []);
    ratesByModel.get(key).push(t.e2eTps);
  }
  const floorByModel = new Map();
  for (const [key, rates] of ratesByModel) {
    if (rates.length >= 2) {
      floorByModel.set(key, quantile(rates, TRANSCRIPT_STALL_QUANTILE) / TRANSCRIPT_STALL_RATIO);
    }
  }

  const stalledTurns = new Set();
  for (const t of valid) {
    if (!isTranscriptTimed(t)) continue;
    const floor = floorByModel.get(turnModelGroupKey(t));
    if (floor !== undefined && t.e2eTps < floor) {
      stalledTurns.add(t);
    }
  }

  return {
    sampleTurns: sample.filter((t) => !stalledTurns.has(t)),
    stalledTurns,
  };
}

function selectE2eSampleTurns(turns) {
  return evaluateE2eTurns(turns).sampleTurns;
}

export async function getConversationMetrics(requestedConvId, requestedPricing, options = {}) {
  const includeRecent = options.includeRecent !== false;
  const rpcTimeoutMs = Number(options.rpcTimeoutMs) || 2500;
  const explicitPath =
    options.transcriptPath && existsSync(options.transcriptPath) ? options.transcriptPath : '';
  const localList =
    explicitPath || (!includeRecent && requestedConvId) ? [] : discoverLocalTranscripts();

  let targetEntry = null;
  if (explicitPath) {
    let st = null;
    try {
      st = statSync(explicitPath);
    } catch {
      st = null;
    }
    targetEntry = {
      conversationId: requestedConvId || '',
      surface: 'antigravity-cli',
      transcriptPath: explicitPath,
      mtimeMs: st?.mtimeMs || 0,
      size: st?.size || 0,
      updatedAt: st ? st.mtime.toISOString() : new Date().toISOString(),
    };
  } else if (requestedConvId) {
    // A requested conversation without a local transcript still gets RPC data;
    // it never falls back to another conversation's transcript.
    targetEntry = !includeRecent
      ? findTranscriptById(requestedConvId)
      : localList.find((x) => x.conversationId === requestedConvId) || null;
  } else {
    targetEntry = localList.find((x) => x.isHostSurface) || localList[0] || null;
  }

  const conversationId = requestedConvId || targetEntry?.conversationId || '';
  const transcriptData = parseTranscriptMetrics(targetEntry?.transcriptPath, options.fallbackModel);

  // Attempt RPC call to LanguageServerService for millisecond-level TTFT & streamingDuration
  const rpcMeta = conversationId
    ? await callLsRpc(
        'GetCascadeTrajectoryGeneratorMetadata',
        {
          cascadeId: conversationId,
          includeMessages: false,
        },
        rpcTimeoutMs
      )
    : null;

  const rpcItems = (rpcMeta?.generatorMetadata || []).filter((m) => m && m.chatModel);
  const turns = [];
  let activeModel = transcriptData.modelHint || 'Gemini 3.1 Pro (High)';
  let latestTokenBreakdown = null;
  let maxRpcCheckpointIndex = 0;

  const tTurnIndexByStep = new Map();
  for (let idx = 0; idx < transcriptData.turns.length; idx++) {
    const tt = transcriptData.turns[idx];
    if (tt.hasStepIndex) {
      tTurnIndexByStep.set(Number(tt.stepIndex), idx);
    }
  }

  if (rpcItems.length > 0) {
    const matchedTranscriptIndices = new Set();
    const mergedEntries = [];
    let firstRpcModel = '';
    let firstRpcModelId = '';

    for (let i = 0; i < rpcItems.length; i++) {
      const rItem = rpcItems[i];
      const cm = rItem.chatModel;
      const stepIndices = Array.isArray(rItem.stepIndices) ? rItem.stepIndices : [];
      let tIdx = -1;
      for (const rawIdx of stepIndices) {
        const cand = tTurnIndexByStep.get(Number(rawIdx));
        if (cand !== undefined && !matchedTranscriptIndices.has(cand)) {
          tIdx = cand;
          break;
        }
      }
      if (
        tIdx === -1 &&
        stepIndices.length === 0 &&
        rpcItems.length === transcriptData.turns.length &&
        !matchedTranscriptIndices.has(i)
      ) {
        tIdx = i;
      }
      const tTurn = tIdx >= 0 ? transcriptData.turns[tIdx] : null;
      if (tIdx >= 0) matchedTranscriptIndices.add(tIdx);

      const stepIdx = tTurn?.hasStepIndex
        ? tTurn.stepIndex
        : (stepIndices[0] ?? tTurn?.stepIndex ?? i);

      const usage = cm.usage || {};
      const ctxMeta = cm.chatStartMetadata?.contextWindowMetadata || {};
      const cpIdx = Number(ctxMeta.checkpointIndex || 0);
      if (cpIdx > maxRpcCheckpointIndex) {
        maxRpcCheckpointIndex = cpIdx;
      }
      const inUncached = Number(usage.inputTokens ?? tTurn?.inUncached ?? 0);
      const inCached = Number(usage.cacheReadTokens ?? tTurn?.inCached ?? 0);
      const cacheWriteTokens = Number(usage.cacheWriteTokens ?? 0);
      const totalInput = inUncached + inCached + cacheWriteTokens;

      const hasThinkSplit = usage.outputTokens !== undefined;
      const outTokens = Number(usage.outputTokens ?? tTurn?.outTokens ?? 0);
      const thinkTokens = Number(usage.thinkingOutputTokens ?? 0);
      const respTokens = Number(
        usage.responseOutputTokens ?? (outTokens >= thinkTokens ? outTokens - thinkTokens : outTokens)
      );

      const ttftSec = parseDurationSec(cm.timeToFirstToken);
      const streamSec = parseDurationSec(cm.streamingDuration);
      const interrupted = Boolean(tTurn?.interrupted);
      const hasRpcE2e = ttftSec + streamSec > 0;
      const e2eSec = hasRpcE2e
        ? ttftSec + streamSec
        : !interrupted
          ? tTurn?.e2eSec || 0
          : 0;
      const e2eSource = hasRpcE2e ? 'rpc' : e2eSec > 0 ? 'transcript' : 'rpc';

      const contextUsed = totalInput > 0 ? totalInput : Number(ctxMeta.estimatedTokensUsed || 0);
      const rpcCompactionLimit = Number(ctxMeta.maxContextTokens || DEFAULT_COMPACTION_MAX_CONTEXT);
      const maxContext = DEFAULT_PHYSICAL_MAX_CONTEXT;

      const explicitTModel = tTurn?.hasExplicitModel ? tTurn.model : '';
      const explicitTModelId = tTurn?.hasExplicitModel ? tTurn.modelId : '';
      const turnModelDisplay =
        cm.modelDisplayName || explicitTModel || cm.responseModel || usage.model || activeModel;
      const turnModelId =
        cm.responseModel || usage.model || cm.model || explicitTModelId || turnModelDisplay;

      if (turnModelDisplay) {
        activeModel = turnModelDisplay;
        if (!firstRpcModel) {
          firstRpcModel = turnModelDisplay;
          firstRpcModelId = turnModelId;
        }
      }

      // Guard decodeTps against single-chunk buffered responses (streamSec < 0.15s)
      const decodeTps = !interrupted && streamSec >= 0.15 ? outTokens / streamSec : 0;
      const e2eTps = !interrupted && e2eSec >= 0.05 ? outTokens / e2eSec : 0;
      const visibleE2eTps = !interrupted && e2eSec >= 0.05 ? respTokens / e2eSec : 0;

      const numericStep = Number(stepIdx);
      mergedEntries.push({
        sortStep: Number.isFinite(numericStep) ? numericStep : Number.MAX_SAFE_INTEGER,
        order: transcriptData.turns.length + i,
        tokenBreakdown: ctxMeta.tokenBreakdown || null,
        turnObj: {
          turn: 0,
          stepIndex: stepIdx,
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
          hasThinkSplit,
          ttftSec,
          streamSec,
          e2eSec,
          decodeTps,
          e2eTps,
          visibleE2eTps,
          e2eSource,
          source: 'rpc',
        },
      });
    }

    // Preserve earlier or unmatched transcript turns when RPC only covers recent turns
    for (let tIdx = 0; tIdx < transcriptData.turns.length; tIdx++) {
      if (matchedTranscriptIndices.has(tIdx)) continue;
      const tTurn = transcriptData.turns[tIdx];
      const fallbackM = firstRpcModel || activeModel || 'Gemini';
      const model = tTurn.hasExplicitModel ? tTurn.model : fallbackM;
      const modelId = tTurn.hasExplicitModel
        ? tTurn.modelId || model
        : firstRpcModelId || model;
      const { hasStepIndex: _hs, hasExplicitModel: _hm, ...restTurn } = tTurn;
      const numericStep = Number(tTurn.stepIndex);
      mergedEntries.push({
        sortStep: Number.isFinite(numericStep) ? numericStep : tIdx,
        order: tIdx,
        tokenBreakdown: null,
        turnObj: {
          ...restTurn,
          model,
          modelId,
        },
      });
    }

    mergedEntries.sort((a, b) => a.sortStep - b.sortStep || a.order - b.order);
    for (let idx = 0; idx < mergedEntries.length; idx++) {
      const entry = mergedEntries[idx];
      entry.turnObj.turn = idx + 1;
      if (entry.tokenBreakdown) {
        latestTokenBreakdown = entry.tokenBreakdown;
      }
      turns.push(entry.turnObj);
    }
    if (turns.length > 0 && turns[turns.length - 1].model) {
      activeModel = turns[turns.length - 1].model;
    }
  } else {
    for (let idx = 0; idx < transcriptData.turns.length; idx++) {
      const { hasStepIndex: _hs, hasExplicitModel: _hm, ...restTurn } = transcriptData.turns[idx];
      turns.push({
        ...restTurn,
        turn: idx + 1,
        model: restTurn.model || activeModel || 'Gemini',
        modelId: restTurn.modelId || restTurn.model || activeModel || 'Gemini',
      });
    }
  }

  // Compute per-turn cost using each turn's own model pricing (when requestedPricing === 'auto')
  for (const t of turns) {
    const hasConcreteDisplay = Boolean(t.model && t.model !== 'Gemini');
    const includeId = t.modelId && (!hasConcreteDisplay || !/-worker\b/i.test(t.modelId));
    const pricingLookup = includeId ? `${t.model || ''} ${t.modelId}` : t.model || '';
    const turnPricingKey = resolvePricingProfileKey(pricingLookup, requestedPricing);
    const turnProfile = PRICING_PROFILES[turnPricingKey] || PRICING_PROFILES.gemini_3_1_pro;
    t.pricingProfileKey = turnPricingKey;
    t.pricingProfileLabel = turnProfile.shortLabel;
    t.pricingProfileFullLabel = turnProfile.label;
    Object.assign(t, computeTurnCost(t, turnProfile));
  }

  const pricingProfileKey = resolvePricingProfileKey(activeModel, requestedPricing);
  const pricingProfile = PRICING_PROFILES[pricingProfileKey] || PRICING_PROFILES.gemini_3_1_pro;

  // Time-weighted session TPS and stall classification
  const validDecodeTurns = turns.filter((t) => !t.interrupted && t.streamSec >= 0.15 && t.outTokens > 0);
  const { sampleTurns: validE2eTurns, stalledTurns } = evaluateE2eTurns(turns);
  const validE2eSet = new Set(validE2eTurns);
  for (const t of turns) {
    t.stalled = stalledTurns.has(t);
  }
  const ttftTurns = turns.filter((t) => !t.interrupted && t.ttftSec > 0);

  const lastTurn = turns[turns.length - 1] || null;
  const currentTurn = [...turns].reverse().find((t) => t.contextUsed > 0) || lastTurn;
  const lastPerfTurn =
    [...turns].reverse().find((t) => !t.interrupted && (validE2eSet.has(t) || t.decodeTps > 0)) ||
    [...turns].reverse().find((t) => !t.interrupted && !t.stalled && t.e2eTps > 0) ||
    currentTurn;

  const totalOutTokens = turns.reduce((acc, t) => acc + t.outTokens, 0);
  const totalThinkTokens = turns.reduce((acc, t) => acc + t.thinkTokens, 0);
  const totalRespTokens = turns.reduce((acc, t) => acc + t.respTokens, 0);
  const totalInUncached = turns.reduce((acc, t) => acc + t.inUncached, 0);
  const totalInCached = turns.reduce((acc, t) => acc + t.inCached, 0);
  const totalCacheWriteTokens = turns.reduce((acc, t) => acc + (t.cacheWriteTokens || 0), 0);
  const totalInputTokens = totalInUncached + totalInCached + totalCacheWriteTokens;
  const sessionTotalTokens = totalInputTokens + totalOutTokens;
  const sessionNetTokens = totalInUncached + totalCacheWriteTokens + totalOutTokens;

  const totalInUncachedCostUsd = turns.reduce((acc, t) => acc + (t.inUncachedCostUsd || 0), 0);
  const totalInCachedCostUsd = turns.reduce((acc, t) => acc + (t.inCachedCostUsd || 0), 0);
  const totalCacheWriteCostUsd = turns.reduce((acc, t) => acc + (t.cacheWriteCostUsd || 0), 0);
  const totalInputCostUsd = turns.reduce((acc, t) => acc + (t.inputCostUsd || 0), 0);
  const totalThinkCostUsd = turns.reduce((acc, t) => acc + (t.thinkCostUsd || 0), 0);
  const totalRespCostUsd = turns.reduce((acc, t) => acc + (t.respCostUsd || 0), 0);
  const totalOutputCostUsd = turns.reduce((acc, t) => acc + (t.outputCostUsd || 0), 0);
  const totalCostUsd = turns.reduce((acc, t) => acc + (t.costUsd || 0), 0);
  const noCacheTotalCostUsd = turns.reduce((acc, t) => acc + (t.noCacheTotalCostUsd || 0), 0);
  const savedByCacheUsd = Math.max(0, noCacheTotalCostUsd - totalCostUsd);
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
        cacheWriteCostUsd: 0,
        inputCostUsd: 0,
        thinkCostUsd: 0,
        respCostUsd: 0,
        outputCostUsd: 0,
        costUsd: 0,
        noCacheTotalCostUsd: 0,
        _turns: [],
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
    g.cacheWriteCostUsd += t.cacheWriteCostUsd || 0;
    g.inputCostUsd += t.inputCostUsd || 0;
    g.thinkCostUsd += t.thinkCostUsd || 0;
    g.respCostUsd += t.respCostUsd || 0;
    g.outputCostUsd += t.outputCostUsd || 0;
    g.costUsd += t.costUsd || 0;
    g.noCacheTotalCostUsd += t.noCacheTotalCostUsd || 0;
    g._turns.push(t);
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
      const savedByCacheUsdModel = Math.max(0, g.noCacheTotalCostUsd - g.costUsd);
      const savedByCachePctModel =
        g.noCacheTotalCostUsd > 0 ? (savedByCacheUsdModel / g.noCacheTotalCostUsd) * 100 : 0;
      const modelE2eTurns = selectE2eSampleTurns(g._turns);
      const e2eOutSum = modelE2eTurns.reduce((a, t) => a + t.outTokens, 0);
      const e2eSecSum = modelE2eTurns.reduce((a, t) => a + t.e2eSec, 0);
      const avgE2eTpsModel = e2eSecSum > 0 ? e2eOutSum / e2eSecSum : 0;
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
        cacheWriteTokens: g.cacheWriteTokens,
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
        cacheWriteCostUsd: g.cacheWriteCostUsd,
        inputCostUsd: g.inputCostUsd,
        thinkCostUsd: g.thinkCostUsd,
        respCostUsd: g.respCostUsd,
        outputCostUsd: g.outputCostUsd,
        costUsd: g.costUsd,
        costSharePct,
        noCacheTotalCostUsd: g.noCacheTotalCostUsd,
        savedByCacheUsd: savedByCacheUsdModel,
        savedByCachePct: savedByCachePctModel,
      };
    })
    .sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens);

  const sumDecodeOut = validDecodeTurns.reduce((a, t) => a + t.outTokens, 0);
  const sumDecodeSec = validDecodeTurns.reduce((a, t) => a + t.streamSec, 0);
  const avgDecodeTps = sumDecodeSec > 0 ? sumDecodeOut / sumDecodeSec : 0;

  const sumE2eOut = validE2eTurns.reduce((a, t) => a + t.outTokens, 0);
  const sumE2eSec = validE2eTurns.reduce((a, t) => a + t.e2eSec, 0);
  const avgE2eTps = sumE2eSec > 0 ? sumE2eOut / sumE2eSec : 0;
  const validVisTurns = validE2eTurns.filter((t) => t.hasThinkSplit);
  const sumVisResp = validVisTurns.reduce((a, t) => a + t.respTokens, 0);
  const sumVisSec = validVisTurns.reduce((a, t) => a + t.e2eSec, 0);
  const avgVisibleE2eTps = sumVisSec > 0 ? sumVisResp / sumVisSec : 0;

  const peakE2eTps = Math.max(0, ...validE2eTurns.map((t) => t.e2eTps || 0));
  const peakDecodeTps = Math.max(0, ...validDecodeTurns.map((t) => t.decodeTps || 0));
  const peakTps = peakE2eTps > 0 ? peakE2eTps : peakDecodeTps;
  const avgTtftSec =
    ttftTurns.length > 0
      ? ttftTurns.reduce((a, t) => a + t.ttftSec, 0) / ttftTurns.length
      : 0;

  const contextUsed = currentTurn?.contextUsed || 0;
  const maxContext = currentTurn?.maxContext || DEFAULT_PHYSICAL_MAX_CONTEXT;
  const compactionMaxContext = currentTurn?.compactionMaxContext || DEFAULT_COMPACTION_MAX_CONTEXT;
  const contextUsedPct = maxContext > 0 ? (contextUsed / maxContext) * 100 : 0;
  const compactionUsedPct = compactionMaxContext > 0 ? (contextUsed / compactionMaxContext) * 100 : 0;

  const summaryCheckpointCount = Math.max(transcriptData.checkpointCount || 0, maxRpcCheckpointIndex);
  const lastStep = lastTurn
    ? `${lastTurn.stepIndex}:${lastTurn.totalInput}:${lastTurn.outTokens}:${lastTurn.e2eSec}`
    : '0';
  const topRecent = localList[0]
    ? `${localList[0].conversationId}:${Math.trunc(localList[0].mtimeMs)}`
    : '';
  const etag = `v1:${conversationId}:${requestedPricing || 'auto'}:${pricingProfileKey}:${Math.trunc(targetEntry?.mtimeMs || 0)}:${targetEntry?.size || 0}:${rpcItems.length}:${summaryCheckpointCount}:${turns.length}:${lastStep}:${topRecent}`;

  return {
    etag,
    conversationId,
    surface: targetEntry?.surface || 'antigravity',
    updatedAt: targetEntry?.updatedAt || new Date().toISOString(),
    title: transcriptData.firstUserPrompt || conversationId.slice(0, 8),
    model: activeModel || 'Gemini',
    detectedModel: rpcItems.length > 0 ? activeModel : transcriptData.detectedModel || '',
    rpcConnected: rpcItems.length > 0,
    summary: {
      turnCount: turns.length,
      modelCount: modelStats.length,
      checkpointCount: summaryCheckpointCount,
      contextUsed,
      maxContext,
      contextUsedPct,
      contextRemaining: Math.max(0, maxContext - contextUsed),
      compactionMaxContext,
      compactionUsedPct,
      compactionRemaining: Math.max(0, compactionMaxContext - contextUsed),
      lastCacheHitRate: currentTurn?.cacheHitRate || 0,
      lastCachedTokens: currentTurn?.inCached || 0,
      lastUncachedTokens: currentTurn?.inUncached || 0,
      lastCacheWriteTokens: currentTurn?.cacheWriteTokens || 0,
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
      lastTurnInterrupted: Boolean(currentTurn?.interrupted),
      lastTtftSec: currentTurn?.ttftSec || 0,
      lastStreamSec: currentTurn?.streamSec || 0,
      lastE2eSec: currentTurn?.e2eSec || 0,
      avgTtftSec,
      lastOutTokens: currentTurn?.outTokens || 0,
      lastThinkTokens: currentTurn?.thinkTokens || 0,
      lastRespTokens: currentTurn?.respTokens || 0,
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
      priceTierThreshold: pricingProfile.tierThreshold || 0,
      lastTurnCostUsd: currentTurn?.costUsd || 0,
      totalInUncachedCostUsd,
      totalInCachedCostUsd,
      totalCacheWriteCostUsd,
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
    recentConversations: includeRecent
      ? localList.slice(0, 20).map((item) => ({
          conversationId: item.conversationId,
          surface: item.surface,
          updatedAt: item.updatedAt,
        }))
      : [],
  };
}

function fmtCompactCount(n) {
  const v = Number(n || 0);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return `${Math.trunc(v)}`;
}

function fmtCostUsd(n) {
  const v = Number(n || 0);
  if (v >= 1) return `$${v.toFixed(2)}`;
  if (v >= 0.01) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(4)}`;
}

function formatMetricsSummaryText(m) {
  const s = m.summary || {};
  const lines = [
    `Conversation: ${m.conversationId || 'unknown'} (${m.surface || 'antigravity'} · ${m.rpcConnected ? 'RPC' : 'Transcript'})`,
    `Model: ${m.model} (${s.pricingProfileLabel || s.pricingProfileKey})`,
    `Turns: ${s.turnCount || 0} (Compactions: ${s.checkpointCount || 0})`,
    `Context: ${fmtCompactCount(s.contextUsed)} / ${fmtCompactCount(s.compactionMaxContext)} (${Number(s.compactionUsedPct || 0).toFixed(1)}% of compaction limit; ${Number(s.contextUsedPct || 0).toFixed(1)}% of ${fmtCompactCount(s.maxContext)} window)`,
    `Prompt Cache: ${Number(s.lastCacheHitRate || 0).toFixed(1)}% last turn · ${Number(s.sessionCacheHitRate || 0).toFixed(1)}% session avg (saved ${fmtCostUsd(s.savedByCacheUsd)})`,
    `Session Tokens: ${fmtCompactCount(s.sessionTotalTokens)} total (${fmtCompactCount(s.totalInputTokens)} in / ${fmtCompactCount(s.totalOutTokens)} out)`,
    `API List Cost: ${fmtCostUsd(s.totalCostUsd)} (last turn ${fmtCostUsd(s.lastTurnCostUsd)})`,
  ];
  const tpsParts = [];
  if (s.avgE2eTps > 0) tpsParts.push(`E2E ${Number(s.avgE2eTps).toFixed(1)} tok/s`);
  if (s.avgDecodeTps > 0) tpsParts.push(`Decode ${Number(s.avgDecodeTps).toFixed(1)} tok/s`);
  if (s.avgTtftSec > 0) tpsParts.push(`Avg TTFT ${Number(s.avgTtftSec).toFixed(2)}s`);
  lines.push(`Speed: ${tpsParts.length ? tpsParts.join(' · ') : '--'}`);
  if (Array.isArray(m.modelStats) && m.modelStats.length > 1) {
    lines.push('By Model:');
    for (const ms of m.modelStats) {
      lines.push(
        `  - ${ms.model}: ${ms.turnCount} turns, ${fmtCompactCount(ms.totalTokens)} tok, ${fmtCostUsd(ms.costUsd)} (${Number(ms.costSharePct || 0).toFixed(0)}%)`
      );
    }
  }
  return lines.join('\n');
}

function parseMetricsCliArgs(argv) {
  const opts = { transcriptPath: '', convId: '', pricing: 'auto', json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--transcript' || a === '-t') {
      if (!argv[i + 1]) throw new Error(`${a} requires a path.`);
      opts.transcriptPath = resolve(argv[++i]);
    } else if (a === '--conversation' || a === '--conv' || a === '-c') {
      if (!argv[i + 1]) throw new Error(`${a} requires an ID.`);
      opts.convId = argv[++i];
    } else if (a === '--pricing' || a === '-p') {
      if (!argv[i + 1]) throw new Error(`${a} requires a pricing key.`);
      opts.pricing = argv[++i];
    } else if (a === '--json') {
      opts.json = true;
    } else if (a === '--help' || a === '-h') {
      opts.help = true;
    } else if (!a.startsWith('-') && !opts.convId) {
      opts.convId = a;
    } else {
      throw new Error(`Unknown option: ${a}`);
    }
  }
  if (!opts.convId && !opts.transcriptPath && !process.env.AGY_GEMINI_ROOT) {
    opts.convId = process.env.ANTIGRAVITY_CONVERSATION_ID || '';
  }
  return opts;
}

const isMain =
  process.argv[1] && realPath(process.argv[1]) === realPath(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const opts = parseMetricsCliArgs(process.argv.slice(2));
    if (opts.help) {
      console.log(
        'Usage: node metrics.mjs [--transcript <path>] [--conversation <id>] [--pricing <key>] [--json]'
      );
      process.exit(0);
    }
    const metrics = await getConversationMetrics(opts.convId, opts.pricing, {
      transcriptPath: opts.transcriptPath,
      includeRecent: false,
      rpcTimeoutMs: 800,
    });
    console.log(opts.json ? JSON.stringify(metrics, null, 2) : formatMetricsSummaryText(metrics));
  } catch (err) {
    console.error(`[context-monitor] ${err.message}`);
    process.exit(1);
  }
}
