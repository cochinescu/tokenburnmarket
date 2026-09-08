/*
  ccusage is the Collector's meter. It already knows how to read every agent CLI
  on this machine and how to price the tokens, so this module only runs it and
  reshapes what comes back.

  Two calls, because no single report has everything:
    `daily --by-agent`  every detected agent, per model, with cost
    `codex daily`       reasoning tokens, which the unified report drops

  ccusage is spawned rather than imported: its JSON is a stable contract, its
  internals are not, and `npx` keeps the Collector's own install small. Point
  TBM_CCUSAGE at a local install to skip the download.
*/
import { runCollector } from "./collector-process.js";

/** One (day, provider, model) aggregate, before receipts are attached. */
export interface UsageAggregate {
  day: string;
  /** The agent, as ccusage names it: claude, codex, gemini, opencode. */
  provider: string;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  costUsd: number;
}

/** The command that runs ccusage, split into argv. Overridable for local installs. */
export function ccusageCommand(env: NodeJS.ProcessEnv): string[] {
  const override = env.TBM_CCUSAGE?.trim();
  if (override) return override.split(/\s+/);
  return ["npx", "-y", "ccusage@latest"];
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/*
  The day a report row covers. Per-agent reports call it `date`; the unified
  report calls it `period`. Reading both keeps one parser for both shapes.
*/
function dayOf(entry: Record<string, unknown>): string {
  for (const key of ["date", "period"]) {
    const value = entry[key];
    if (typeof value === "string" && DAY_PATTERN.test(value)) return value;
  }
  return "";
}

function money(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Reshape `ccusage daily --json --by-agent`. Rows that are not usable, because
 * a version changed a field name, are dropped rather than guessed at: a missing
 * day is better than an invented one.
 */
export function parseUnifiedDaily(json: unknown): UsageAggregate[] {
  const daily = isRecord(json) && Array.isArray(json.daily) ? json.daily : [];
  const out: UsageAggregate[] = [];

  for (const entry of daily) {
    if (!isRecord(entry)) continue;
    const day = dayOf(entry);
    if (!DAY_PATTERN.test(day)) continue;
    const agents = Array.isArray(entry.agents) ? entry.agents : [];

    for (const agent of agents) {
      if (!isRecord(agent)) continue;
      const provider = typeof agent.agent === "string" ? agent.agent : "";
      if (!provider || provider === "all") continue;
      const breakdowns = Array.isArray(agent.modelBreakdowns) ? agent.modelBreakdowns : [];

      for (const model of breakdowns) {
        if (!isRecord(model)) continue;
        const name = typeof model.modelName === "string" ? model.modelName : "";
        if (!name) continue;
        out.push({
          day,
          provider,
          model: name,
          inputTokens: count(model.inputTokens),
          cachedInputTokens: count(model.cacheReadTokens),
          cacheWriteTokens: count(model.cacheCreationTokens),
          outputTokens: count(model.outputTokens),
          reasoningTokens: 0,
          costUsd: money(model.cost),
        });
      }
    }
  }

  return out;
}

/**
 * Reasoning tokens per (day, model) from `ccusage codex daily --json`. Codex
 * bills them, the unified report does not carry them, and they are most of what
 * a reasoning model actually produces.
 */
export function parseCodexReasoning(json: unknown): Map<string, number> {
  const daily = isRecord(json) && Array.isArray(json.daily) ? json.daily : [];
  const out = new Map<string, number>();

  for (const entry of daily) {
    if (!isRecord(entry)) continue;
    const day = dayOf(entry);
    if (!DAY_PATTERN.test(day) || !isRecord(entry.models)) continue;

    for (const [model, stats] of Object.entries(entry.models)) {
      if (!isRecord(stats)) continue;
      const reasoning = count(stats.reasoningOutputTokens);
      if (reasoning > 0) out.set(`${day} ${model}`, reasoning);
    }
  }

  return out;
}

export interface CcusageOptions {
  /** Oldest UTC day to ask for, `YYYY-MM-DD`. Omitted means everything on this machine. */
  since?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** Injected in tests. Real runs spawn ccusage. */
  exec?: (args: string[]) => Promise<string>;
}

async function spawnCcusage(env: NodeJS.ProcessEnv, args: string[], signal?: AbortSignal): Promise<string> {
  const [command, ...base] = ccusageCommand(env);
  return runCollector(command!, [...base, ...args], env, signal);
}

/**
 * Every (day, provider, model) aggregate this machine can account for.
 *
 * Days are grouped in UTC to match the Receipt Streams and the server's idea of
 * a day. A Builder in Auckland sees their evening land on tomorrow's row, which
 * is the price of one global calendar.
 */
export async function readUsageAggregates(
  options: CcusageOptions = {},
): Promise<UsageAggregate[]> {
  const env = options.env ?? process.env;
  const exec = options.exec ?? ((args: string[]) => spawnCcusage(env, args, options.signal));
  const window = options.since ? ["--since", options.since.replace(/-/g, "")] : [];
  const common = ["--json", "--timezone", "UTC", ...window];

  const aggregates = parseUnifiedDaily(JSON.parse(await exec(["daily", "--by-agent", ...common])));

  // Codex is the only adapter with reasoning tokens today. If it is not
  // installed, ccusage still answers, with an empty report.
  let reasoning = new Map<string, number>();
  try {
    reasoning = parseCodexReasoning(JSON.parse(await exec(["codex", "daily", ...common])));
  } catch {
    options.signal?.throwIfAborted();
    reasoning = new Map();
  }

  return aggregates.map((row) =>
    row.provider === "codex"
      ? { ...row, reasoningTokens: reasoning.get(`${row.day} ${row.model}`) ?? 0 }
      : row,
  );
}
