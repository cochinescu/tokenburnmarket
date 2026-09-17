// Plausibility checks (ADR 0003).
//
// Usage comes from user-owned transcript files, so it cannot be proven. These
// checks make fabrication costly and detectable: a row that clears them and
// carries a coherent Receipt Stream is Verified, one without usable evidence is Reported, and
// one that trips any ceiling is Quarantined with the reasons attached.
//
// Every ceiling is configurable. Defaults are deliberately loose: a false
// Quarantine costs a real Builder their day, a missed one costs play money.

import type { TrustLevel } from "./trust";

export type PlausibilityCode =
  | "negative_counts"
  | "future_day"
  | "stale_backfill"
  | "output_rate_ceiling"
  | "output_input_ratio"
  | "cache_ratio"
  | "daily_cost_ceiling"
  | "receipt_stream_incoherent"
  | "receipt_stream_thin"
  | "no_receipt_stream";

export interface PlausibilityReason {
  code: PlausibilityCode;
  /** Short human sentence, safe to show in the admin queue. */
  message: string;
  observed?: number;
  limit?: number;
}

/** One (Device, day, provider, model) row as uploaded by a Sync. */
export interface UsageDayInput {
  /** UTC calendar day, `YYYY-MM-DD`. */
  day: string;
  provider: string;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  costUsd: number;
  /** Length of the Receipt Stream for this row. Zero means no stream. */
  receiptCount: number;
}

export interface PlausibilityLimits {
  /** How many days before the Device watermark a Sync may still amend. */
  backfillWindowDays: number;
  /** Output tokens per elapsed second, applied when a model has no entry below. */
  defaultMaxOutputTokensPerSecond: number;
  /** Per-model ceilings. Keys match a model id exactly or as a prefix. */
  maxOutputTokensPerSecondByModel: Record<string, number>;
  /** Daily cost ceiling used when a provider has no entry below. */
  defaultMaxDailyCostUsd: number;
  /** Per-provider daily cost ceilings, sized against known plan tiers. */
  maxDailyCostUsdByProvider: Record<string, number>;
  /** Output tokens may exceed total input (fresh plus cached) by at most this factor. */
  maxOutputToInputRatio: number;
  /** Cache reads may exceed cache writes by at most this factor within a day. */
  maxCacheReadToWriteRatio: number;
  /** A single receipt stands for one assistant message. */
  maxOutputTokensPerReceipt: number;
  minOutputTokensPerReceipt: number;
}

export const DEFAULT_PLAUSIBILITY_LIMITS: PlausibilityLimits = {
  backfillWindowDays: 2,
  defaultMaxOutputTokensPerSecond: 1000,
  maxOutputTokensPerSecondByModel: {
    "claude-3-5-haiku": 2000,
    "claude-haiku": 2000,
    "gpt-5-mini": 2000,
  },
  defaultMaxDailyCostUsd: 3000,
  maxDailyCostUsdByProvider: {
    anthropic: 3000,
    openai: 3000,
    google: 2000,
  },
  maxOutputToInputRatio: 4,
  maxCacheReadToWriteRatio: 400,
  maxOutputTokensPerReceipt: 200_000,
  minOutputTokensPerReceipt: 1,
};

export interface PlausibilityContext {
  /** Evaluation time. Bounds how many seconds today has had to produce tokens. */
  now: Date;
  /**
   * Latest UTC day already accepted for this Device. Older days are only
   * accepted inside the backfill window, which keeps the watermark monotone.
   */
  deviceWatermarkDay?: string;
  /** Partial overrides on top of {@link DEFAULT_PLAUSIBILITY_LIMITS}. */
  limits?: Partial<PlausibilityLimits>;
}

export interface PlausibilityResult {
  trustLevel: TrustLevel;
  /** Empty only for a Verified row. Reported and Quarantined always explain themselves. */
  reasons: PlausibilityReason[];
}

export function resolvePlausibilityLimits(
  overrides?: Partial<PlausibilityLimits>,
): PlausibilityLimits {
  return { ...DEFAULT_PLAUSIBILITY_LIMITS, ...overrides };
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SECONDS_PER_DAY = 86_400;

/** Start of a `YYYY-MM-DD` UTC day in epoch milliseconds, or NaN if malformed. */
function dayStartMs(day: string): number {
  if (!DAY_PATTERN.test(day)) return Number.NaN;
  return Date.parse(`${day}T00:00:00.000Z`);
}

/** Longest matching prefix wins, so a family key covers every dated variant. */
function ceilingFor(
  key: string,
  table: Record<string, number>,
  fallback: number,
): number {
  const exact = table[key];
  if (exact !== undefined) return exact;
  let best: number | undefined;
  let bestLength = -1;
  for (const [prefix, value] of Object.entries(table)) {
    if (key.startsWith(prefix) && prefix.length > bestLength) {
      best = value;
      bestLength = prefix.length;
    }
  }
  return best ?? fallback;
}

/**
 * Seconds the day had available to produce tokens by `now`. A day still in
 * progress gets only its elapsed part, so a fresh day cannot hide a huge burst.
 */
function elapsedSecondsInDay(day: string, now: Date): number {
  const start = dayStartMs(day);
  const elapsed = (now.getTime() - start) / 1000;
  return Math.min(SECONDS_PER_DAY, Math.max(1, elapsed));
}

/**
 * Judge one Usage row. Pure: same inputs, same verdict, so the Collector can
 * preview what the server will decide.
 */
export function checkPlausibility(
  row: UsageDayInput,
  context: PlausibilityContext,
): PlausibilityResult {
  const limits = resolvePlausibilityLimits(context.limits);
  const reasons: PlausibilityReason[] = [];

  const counts = [
    row.inputTokens,
    row.cachedInputTokens,
    row.cacheWriteTokens,
    row.outputTokens,
    row.reasoningTokens,
    row.costUsd,
    row.receiptCount,
  ];
  if (counts.some((n) => !Number.isFinite(n) || n < 0)) {
    reasons.push({
      code: "negative_counts",
      message: "Token counts and cost must be finite and non-negative.",
    });
    return { trustLevel: "quarantined", reasons };
  }

  const start = dayStartMs(row.day);
  if (Number.isNaN(start)) {
    reasons.push({ code: "future_day", message: "Day is not a valid UTC calendar day." });
    return { trustLevel: "quarantined", reasons };
  }

  // A day that has not started yet cannot have produced anything.
  if (start > context.now.getTime()) {
    reasons.push({ code: "future_day", message: "Day starts in the future." });
  }

  if (context.deviceWatermarkDay !== undefined) {
    const watermark = dayStartMs(context.deviceWatermarkDay);
    if (!Number.isNaN(watermark)) {
      const daysBehind = (watermark - start) / (SECONDS_PER_DAY * 1000);
      if (daysBehind > limits.backfillWindowDays) {
        reasons.push({
          code: "stale_backfill",
          message: "Day is older than this Device's backfill window.",
          observed: daysBehind,
          limit: limits.backfillWindowDays,
        });
      }
    }
  }

  const seconds = elapsedSecondsInDay(row.day, context.now);
  const producedTokens = row.outputTokens + row.reasoningTokens;
  const outputRate = producedTokens / seconds;
  const rateCeiling = ceilingFor(
    row.model,
    limits.maxOutputTokensPerSecondByModel,
    limits.defaultMaxOutputTokensPerSecond,
  );
  if (outputRate > rateCeiling) {
    reasons.push({
      code: "output_rate_ceiling",
      message: "Output rate is above what this model can sustain.",
      observed: outputRate,
      limit: rateCeiling,
    });
  }

  // Agents send most of their context as cache reads, so the ratio is taken
  // against total input. Comparing against fresh input alone would Quarantine
  // every ordinary Claude Code day.
  const totalInput = row.inputTokens + row.cachedInputTokens + row.cacheWriteTokens;
  if (totalInput === 0) {
    if (producedTokens > 0) {
      reasons.push({
        code: "output_input_ratio",
        message: "Output was produced with no input tokens.",
        observed: producedTokens,
        limit: 0,
      });
    }
  } else if (producedTokens / totalInput > limits.maxOutputToInputRatio) {
    reasons.push({
      code: "output_input_ratio",
      message: "Output far exceeds the input that produced it.",
      observed: producedTokens / totalInput,
      limit: limits.maxOutputToInputRatio,
    });
  }
  if (
    row.cacheWriteTokens > 0 &&
    row.cachedInputTokens / row.cacheWriteTokens > limits.maxCacheReadToWriteRatio
  ) {
    reasons.push({
      code: "cache_ratio",
      message: "Cache reads are out of proportion with cache writes.",
      observed: row.cachedInputTokens / row.cacheWriteTokens,
      limit: limits.maxCacheReadToWriteRatio,
    });
  }

  const costCeiling = ceilingFor(
    row.provider,
    limits.maxDailyCostUsdByProvider,
    limits.defaultMaxDailyCostUsd,
  );
  if (row.costUsd > costCeiling) {
    reasons.push({
      code: "daily_cost_ceiling",
      message: "Daily cost is above any known plan tier for this provider.",
      observed: row.costUsd,
      limit: costCeiling,
    });
  }

  // The two directions are not symmetric. More tokens than the receipts can
  // carry inflates a ranked quantity, so it still quarantines. Surplus
  // receipts do not: Leaderboards rank cost and tokens, so extra receipts buy
  // nothing but the Verified badge. Dropping that row to Reported takes the
  // badge away, which is the whole of the advantage, without voiding a real
  // Builder's day.
  const distrust: PlausibilityReason[] = [];
  if (row.receiptCount > 0) {
    const perReceipt = producedTokens / row.receiptCount;
    if (perReceipt > limits.maxOutputTokensPerReceipt) {
      reasons.push({
        code: "receipt_stream_incoherent",
        message: "Too many output tokens for the number of receipts.",
        observed: perReceipt,
        limit: limits.maxOutputTokensPerReceipt,
      });
    } else if (producedTokens > 0 && perReceipt < limits.minOutputTokensPerReceipt) {
      distrust.push({
        code: "receipt_stream_thin",
        message:
          "More receipts than the output tokens can account for, so the stream is not counted as evidence.",
        observed: perReceipt,
        limit: limits.minOutputTokensPerReceipt,
      });
    }
  }

  // A quarantine outranks the downgrade, but the thin-stream reason still
  // belongs in the admin queue's explanation of the row.
  if (reasons.length > 0) {
    return { trustLevel: "quarantined", reasons: [...reasons, ...distrust] };
  }

  if (distrust.length > 0) return { trustLevel: "reported", reasons: distrust };

  if (row.receiptCount === 0) {
    return {
      trustLevel: "reported",
      reasons: [
        {
          code: "no_receipt_stream",
          message: "This agent does not expose message identifiers, so Usage is self-reported.",
        },
      ],
    };
  }

  return { trustLevel: "verified", reasons: [] };
}
