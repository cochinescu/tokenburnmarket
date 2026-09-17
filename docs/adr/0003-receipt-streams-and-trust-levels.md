# ADR 0003 — Signed device syncs, Receipt Streams, and Trust Levels instead of "unfakeable"

Status: accepted · 2026-08-17

## Context
Usage comes from user-owned local transcript files; no provider exposes per-user token totals for subscription accounts. Cryptographic proof of usage is impossible.

## Decision
Make cheating costly and detectable rather than impossible:
- Each Device has a keypair bound via browser-approved short code; every Sync is signed.
- Syncs carry daily aggregates plus a Receipt Stream: hashes of per-message identifiers (Claude Code `message.id:requestId`, Codex and Grok equivalents), never content. The server dedupes across Devices and checks stream coherence.
- Trust Levels: Verified (stream + checks pass), Reported (no usable stream, including surplus receipts relative to output; 50% mint, badged), Quarantined (failed checks; excluded from boards, mint, and resolution; admin review).
- Plausibility checks: per-model tokens/second ceilings, output/input and cache ratios, daily cost ceilings vs known plan tiers, monotone per-device watermark (no retroactive jumps beyond a 2-day backfill window).
- Product copy says "verified = not obviously fake", never "proof".

## Consequences
+ Any ccusage-supported agent can participate.  + Multi-device users are not double-counted.  − Determined cheaters can still fabricate coherent streams; mitigated by community visibility and play-money stakes.
