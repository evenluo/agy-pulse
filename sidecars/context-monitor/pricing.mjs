// API pricing profiles (USD per 1M tokens) and per-turn cost estimation.
//
// Prices follow the vendors' public list prices; inputs above `tierThreshold`
// in a single request are billed at the `high` tier. Update this table when
// vendors change prices:
//   - Gemini: https://ai.google.dev/gemini-api/docs/pricing
//   - Claude: https://docs.anthropic.com/en/docs/about-claude/pricing

export const PRICING_PROFILES = {
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

export function resolvePricingProfileKey(modelName, requestedProfile) {
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

export function computeTurnCost(turn, profile) {
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
