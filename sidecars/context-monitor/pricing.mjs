// API pricing profiles (USD per 1M tokens) and per-turn cost estimation.
//
// Prices follow the vendors' public list prices. A profile with `tierThreshold`
// bills a request whose input exceeds it at the `high` rates. A profile with
// `priceChange` bills turns from that date at `priceChange.base`; the date is read
// as UTC midnight, an assumption where the vendor names no timezone.
// Update this table when vendors change prices:
//   - Gemini: https://ai.google.dev/gemini-api/docs/pricing
//   - Claude: https://platform.claude.com/docs/en/about-claude/pricing

export const PRICING_PROFILES = {
  gemini_4_argon: {
    label: 'Gemini 4 Argon ($2/$0.1/$10 · from 2026-12-01 $4/$0.2/$20)',
    shortLabel: 'Gemini 4 Argon',
    base: { inUncached: 2.0, inCached: 0.1, cacheWrite: 2.0, out: 10.0 },
    priceChange: {
      from: '2026-12-01',
      base: { inUncached: 4.0, inCached: 0.2, cacheWrite: 4.0, out: 20.0 },
    },
  },
  gemini_3_1_pro: {
    label: 'Gemini 3.1 Pro ($2/$0.2/$12 · >200k $4/$18)',
    shortLabel: 'Gemini 3.1 Pro',
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
  // 3.6 and 3.8 Flash from the pricing page; 3.7 Flash input and output from its
  // model card (https://deepmind.google/models/model-cards/gemini-3-7-flash/),
  // which lists no cached price.
  gemini_3_6_flash: {
    label: 'Gemini 3.6–3.8 Flash ($0.75/$0.075/$3.75 · from 2027-01-01 $1.50/$0.15/$7.50)',
    shortLabel: 'Gemini 3.6–3.8 Flash',
    base: { inUncached: 0.75, inCached: 0.075, cacheWrite: 0.75, out: 3.75 },
    priceChange: {
      from: '2027-01-01',
      base: { inUncached: 1.5, inCached: 0.15, cacheWrite: 1.5, out: 7.5 },
    },
  },
  gemini_3_flash: {
    label: 'Gemini 3 Flash ($0.50/$0.05/$3)',
    shortLabel: 'Gemini 3 Flash',
    base: { inUncached: 0.5, inCached: 0.05, cacheWrite: 0.5, out: 3.0 },
  },
  gemini_flash: {
    label: 'Gemini 2.5 Flash ($0.30/$0.03/$2.50)',
    shortLabel: 'Gemini 2.5 Flash',
    base: { inUncached: 0.3, inCached: 0.03, cacheWrite: 0.3, out: 2.5 },
  },
  // Claude 4.6 and later bill the full 1M window at the standard price.
  claude_opus_5_5: {
    label: 'Claude Opus 5.5 ($4/$0.2/$20)',
    shortLabel: 'Claude Opus 5.5',
    base: { inUncached: 4.0, inCached: 0.2, cacheWrite: 5.0, out: 20.0 },
  },
  claude_sonnet_5_5: {
    label: 'Claude Sonnet 5.5 ($2/$0.1/$10)',
    shortLabel: 'Claude Sonnet 5.5',
    base: { inUncached: 2.0, inCached: 0.1, cacheWrite: 2.5, out: 10.0 },
  },
  claude_sonnet: {
    label: 'Claude Sonnet 4.6 ($3/$0.3/$15)',
    shortLabel: 'Claude Sonnet 4.6',
    base: { inUncached: 3.0, inCached: 0.3, cacheWrite: 3.75, out: 15.0 },
  },
  claude_opus: {
    label: 'Claude Opus 4.6–5 ($5/$0.5/$25)',
    shortLabel: 'Claude Opus 4.6–5',
    base: { inUncached: 5.0, inCached: 0.5, cacheWrite: 6.25, out: 25.0 },
  },
};

// The version written next to a model family: "Claude Sonnet 4.6" and
// "claude-sonnet-4-6-20260101" give "4.6" for sonnet, "gemini-3.8-flash-001" gives
// "3.8" for flash. Versions have one or two digits per part, so suffixes such as
// "-001" or a date are not read as one. Returns '' when there is none.
function versionOf(m, family) {
  const s = m.replace(/(\d)[-_](\d)(?!\d)/g, '$1.$2');
  const version = '(\\d{1,2}(?:\\.\\d{1,2})?)(?![\\d.])';
  const after = s.match(new RegExp(`${family}[ -]${version}`));
  const before = s.match(new RegExp(`${version}[ -]${family}`));
  return (after || before || [])[1] || '';
}

export function resolvePricingProfileKey(modelName, requestedProfile) {
  if (requestedProfile && requestedProfile !== 'auto' && PRICING_PROFILES[requestedProfile]) {
    return requestedProfile;
  }
  const m = String(modelName || '').toLowerCase();
  if (m.includes('opus')) return versionOf(m, 'opus') === '5.5' ? 'claude_opus_5_5' : 'claude_opus';
  if (m.includes('claude') || m.includes('sonnet')) {
    return versionOf(m, 'sonnet') === '5.5' ? 'claude_sonnet_5_5' : 'claude_sonnet';
  }
  if (m.includes('flash')) {
    const v = versionOf(m, 'flash');
    if (v === '3.6' || v === '3.7' || v === '3.8') return 'gemini_3_6_flash';
    return v === '3' ? 'gemini_3_flash' : 'gemini_flash';
  }
  if (m.includes('argon') || m.includes('gemini 4') || m.includes('gemini-4')) return 'gemini_4_argon';
  if (m.includes('2.5')) return 'gemini_pro';
  return 'gemini_3_1_pro';
}

// The rates that applied to one turn. A turn without a timestamp uses today's price.
function turnRates(turn, profile) {
  const isHighTier = Boolean(profile.tierThreshold) && turn.totalInput > profile.tierThreshold;
  if (isHighTier) return { isHighTier, tier: profile.high };
  const change = profile.priceChange;
  const at = Date.parse(turn.createdAt);
  const when = Number.isNaN(at) ? Date.now() : at;
  return { isHighTier, tier: change && when >= Date.parse(change.from) ? change.base : profile.base };
}

export function computeTurnCost(turn, profile) {
  const { isHighTier, tier } = turnRates(turn, profile);
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
