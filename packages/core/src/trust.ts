// Trust Level (CONTEXT.md, ADR 0003). Shared by mint and plausibility.

/**
 * How much a Usage row is believed.
 *
 * - `verified`: signed Device, Receipt Stream present, checks passed.
 *   Product copy: "verified means signed and plausible, not proven".
 * - `reported`: signed Device, no Receipt Stream we can lean on — either none
 *   at all, or one carrying more receipts than its tokens account for. Mints
 *   at a discount, badged.
 * - `quarantined`: failed a check. Out of Leaderboards, mint, and resolution.
 */
export type TrustLevel = "verified" | "reported" | "quarantined";

export const TRUST_LEVELS = ["verified", "reported", "quarantined"] as const;

// Weakest wins when a Builder-day aggregates several Usage rows.
const TRUST_RANK: Record<TrustLevel, number> = {
  verified: 0,
  reported: 1,
  quarantined: 2,
};

/** The weakest Trust Level in a set. An empty set is `reported` (nothing proven). */
export function weakestTrustLevel(levels: readonly TrustLevel[]): TrustLevel {
  let weakest: TrustLevel = levels.length === 0 ? "reported" : "verified";
  for (const level of levels) {
    if (TRUST_RANK[level] > TRUST_RANK[weakest]) weakest = level;
  }
  return weakest;
}
