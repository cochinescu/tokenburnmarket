/*
  Sync behaviour against an in-memory store: the same code the route runs, with
  maps instead of Postgres. What is being pinned down is the dedupe rule, the
  Trust Level a failed check produces, and how the watermark moves.
*/
import { describe, expect, it } from "vitest";
import type { SyncDay, SyncPayload } from "@tokenburnmarket/core";
import {
  applySync,
  nextWatermark,
  type BuilderDayWrite,
  type ReceiptWrite,
  type RollupSourceRow,
  type SyncStore,
  type UsageRowWrite,
} from "./sync";

const BUILDER = "11111111-1111-4111-8111-111111111111";
const DEVICE_A = "22222222-2222-4222-8222-222222222222";
const DEVICE_B = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-08-17T12:00:00.000Z");
const DAY = "2026-08-16";

/** Deterministic 64-hex receipt hashes, so two Devices can report the same stream. */
function stream(count: number, salt = "a"): string[] {
  return Array.from({ length: count }, (_, i) => `${salt}${String(i).padStart(63, "0")}`);
}

function day(overrides: Partial<SyncDay> = {}): SyncDay {
  return {
    day: DAY,
    provider: "claude",
    model: "claude-opus-5",
    inputTokens: 5000,
    cachedInputTokens: 200_000,
    cacheWriteTokens: 20_000,
    outputTokens: 1000,
    reasoningTokens: 0,
    costUsd: 5,
    receipts: stream(10),
    ...overrides,
  };
}

function payload(deviceId: string, days: SyncDay[]): SyncPayload {
  return { version: 1, deviceId, sentAt: NOW.toISOString(), days };
}

interface Memory extends SyncStore {
  usage: Map<string, UsageRowWrite>;
  builderDays: Map<string, BuilderDayWrite>;
  watermarks: Map<string, string | null>;
}

function memoryStore(): Memory {
  const receipts = new Map<string, ReceiptWrite>();
  const usage = new Map<string, UsageRowWrite>();
  const builderDays = new Map<string, BuilderDayWrite>();
  const watermarks = new Map<string, string | null>();

  return {
    usage,
    builderDays,
    watermarks,
    async foreignReceipts(builderId, deviceId, hashes) {
      const owners = new Map<string, string>();
      for (const row of receipts.values()) {
        if (row.builderId !== builderId || row.deviceId === deviceId) continue;
        if (hashes.includes(row.hash)) owners.set(row.hash, row.deviceId);
      }
      return owners;
    },
    async putReceipts(rows) {
      for (const row of rows) receipts.set(`${row.deviceId}|${row.hash}`, row);
    },
    async putUsageRows(rows) {
      for (const row of rows) {
        usage.set(`${row.deviceId}|${row.day}|${row.provider}|${row.model}`, row);
      }
    },
    async usageRowsForDays(builderId, days): Promise<RollupSourceRow[]> {
      return [...usage.values()]
        .filter((row) => row.builderId === builderId && days.includes(row.day))
        .map((row) => ({
          day: row.day,
          costUsd: row.costUsd,
          inputTokens: row.inputTokens,
          cachedInputTokens: row.cachedInputTokens,
          cacheWriteTokens: row.cacheWriteTokens,
          outputTokens: row.outputTokens,
          reasoningTokens: row.reasoningTokens,
          trustLevel: row.trustLevel,
          duplicateOfDeviceId: row.duplicateOfDeviceId,
        }));
    },
    async putBuilderDays(rows) {
      for (const row of rows) builderDays.set(`${row.builderId}|${row.day}`, row);
    },
    async advanceWatermark(deviceId, watermarkDay) {
      watermarks.set(deviceId, watermarkDay);
    },
  };
}

function device(id: string, watermarkDay: string | null = null) {
  return { id, builderId: BUILDER, watermarkDay };
}

describe("applySync", () => {
  it("marks a day with a Receipt Stream verified and rolls it up", async () => {
    const store = memoryStore();
    const result = await applySync(store, device(DEVICE_A), payload(DEVICE_A, [day()]), NOW);

    expect(result.days).toEqual([
      { day: DAY, provider: "claude", model: "claude-opus-5", trustLevel: "verified", reasons: [] },
    ]);
    expect(result.nextWatermark).toBe(DAY);
    expect(store.builderDays.get(`${BUILDER}|${DAY}`)).toMatchObject({
      costUsd: 5,
      totalTokens: 226_000,
      trustLevelMin: "verified",
    });
  });

  it("does not double count two devices reading the same transcripts", async () => {
    const store = memoryStore();
    await applySync(store, device(DEVICE_A), payload(DEVICE_A, [day()]), NOW);
    const second = await applySync(store, device(DEVICE_B), payload(DEVICE_B, [day()]), NOW);

    expect(second.days[0]?.trustLevel).toBe("reported");
    expect(second.days[0]?.reasons.map((reason) => reason.code)).toContain("duplicate_of_device");

    const rollup = store.builderDays.get(`${BUILDER}|${DAY}`);
    expect(rollup?.costUsd).toBe(5);
    expect(rollup?.totalTokens).toBe(226_000);

    // Both rows are kept, so the second Device still sees its own day on the profile.
    expect(store.usage.size).toBe(2);
    expect(store.usage.get(`${DEVICE_B}|${DAY}|claude|claude-opus-5`)?.duplicateOfDeviceId).toBe(
      DEVICE_A,
    );
  });

  it("counts a second device that did different work", async () => {
    const store = memoryStore();
    await applySync(store, device(DEVICE_A), payload(DEVICE_A, [day()]), NOW);
    await applySync(
      store,
      device(DEVICE_B),
      payload(DEVICE_B, [day({ receipts: stream(10, "b") })]),
      NOW,
    );

    expect(store.builderDays.get(`${BUILDER}|${DAY}`)?.costUsd).toBe(10);
  });

  it("is idempotent when the same device re-sends a day", async () => {
    const store = memoryStore();
    await applySync(store, device(DEVICE_A), payload(DEVICE_A, [day()]), NOW);
    const again = await applySync(store, device(DEVICE_A, DAY), payload(DEVICE_A, [day()]), NOW);

    expect(again.days[0]?.trustLevel).toBe("verified");
    expect(store.builderDays.get(`${BUILDER}|${DAY}`)?.costUsd).toBe(5);
  });

  it("quarantines a day that fails a plausibility check and keeps it out of the watermark", async () => {
    const store = memoryStore();
    const result = await applySync(
      store,
      device(DEVICE_A),
      payload(DEVICE_A, [day({ costUsd: 9000 })]),
      NOW,
    );

    expect(result.days[0]?.trustLevel).toBe("quarantined");
    expect(result.days[0]?.reasons.map((reason) => reason.code)).toContain("daily_cost_ceiling");
    expect(result.nextWatermark).toBeNull();
    expect(store.builderDays.get(`${BUILDER}|${DAY}`)?.trustLevelMin).toBe("quarantined");
  });

  it("keeps a mixed day counted when one model has a thin stream, including re-syncs", async () => {
    const store = memoryStore();
    const days = [
      day({ costUsd: 415.37 }),
      day({ model: "claude-fable-5-1", outputTokens: 4, costUsd: 0.83, receipts: stream(682, "b") }),
    ];
    for (const watermark of [null, DAY]) {
      const result = await applySync(store, device(DEVICE_A, watermark), payload(DEVICE_A, days), NOW);
      expect(result.days.map((row) => row.trustLevel)).toEqual(["verified", "reported"]);
      expect(result.days[1]?.reasons.map((reason) => reason.code)).toEqual(["receipt_stream_thin"]);
      expect(result.nextWatermark).toBe(DAY);
      expect(store.builderDays.get(`${BUILDER}|${DAY}`)).toMatchObject({
        costUsd: 416.2,
        totalTokens: 451_004,
        trustLevelMin: "reported",
      });
      expect(store.usage.get(`${DEVICE_A}|${DAY}|claude|claude-fable-5-1`)).toMatchObject({
        trustLevel: "reported",
        quarantineReasons: [expect.objectContaining({ code: "receipt_stream_thin" })],
      });
    }
  });

  it("still quarantines the whole day when a thin stream also exceeds a ceiling", async () => {
    const store = memoryStore();
    const result = await applySync(
      store,
      device(DEVICE_A),
      payload(DEVICE_A, [day({ outputTokens: 4, costUsd: 9000, receipts: stream(682) })]),
      NOW,
    );
    expect(result.days[0]?.trustLevel).toBe("quarantined");
    expect(result.days[0]?.reasons.map((reason) => reason.code)).toEqual([
      "daily_cost_ceiling", "receipt_stream_thin",
    ]);
    expect(result.nextWatermark).toBeNull();
    expect(store.builderDays.get(`${BUILDER}|${DAY}`)?.trustLevelMin).toBe("quarantined");
  });

  it("reports a day with no Receipt Stream", async () => {
    const store = memoryStore();
    const result = await applySync(
      store,
      device(DEVICE_A),
      payload(DEVICE_A, [day({ provider: "gemini", model: "gemini-3-pro", receipts: [] })]),
      NOW,
    );

    expect(result.days[0]?.trustLevel).toBe("reported");
    expect(result.days[0]?.reasons.map((reason) => reason.code)).toEqual(["no_receipt_stream"]);
  });
});

describe("nextWatermark", () => {
  const outcome = (day: string, trustLevel: "verified" | "quarantined") => ({
    day,
    provider: "claude",
    model: "claude-opus-5",
    trustLevel,
    reasons: [],
  });

  it("takes the newest accepted day", () => {
    expect(nextWatermark(null, [outcome("2026-08-15", "verified"), outcome("2026-08-16", "verified")]))
      .toBe("2026-08-16");
  });

  it("never moves backwards", () => {
    expect(nextWatermark("2026-08-16", [outcome("2026-08-14", "verified")])).toBe("2026-08-16");
  });

  it("ignores quarantined days", () => {
    expect(nextWatermark("2026-08-16", [outcome("2026-09-01", "quarantined")])).toBe("2026-08-16");
  });
});
