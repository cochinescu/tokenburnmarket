/*
  `tokenburnmarket mcp`: the stdio MCP server.

  Five tools, all of them about the Builder this machine is connected as. Four
  read. One spends Credits, and it will not do that without `confirm: true`:
  called without it, place_bet prices the trade, writes nothing, and says how to
  place it. An agent that guesses wrong therefore costs nobody anything.

  The server starts even when this machine has never connected. A tool that
  cannot work then says so in a sentence a person can act on, which is a better
  answer than a server that refuses to start at all.
*/
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ApiClient, type MarketRow, type TradeAnswer } from "./api.js";
import { currentConfigPath, readConfig, type DeviceConfig } from "./config.js";
import { sync, type SyncOptions } from "./sync.js";

const NOT_CONNECTED = "This machine is not connected. Run `tokenburnmarket connect` in a terminal.";

/**
 * How recent a sync has to be for the startup one to stand down. Agents get
 * opened many times a day; transcripts written in the last ten minutes can
 * wait for the next one.
 */
export const AUTO_SYNC_INTERVAL_MS = 10 * 60_000;

/** What an automatic sync is allowed to set. Everything else stays the command's. */
type AutoSyncOptions = Pick<SyncOptions, "skipIfSyncedWithinMs">;

/*
  The two tools that take arguments, as whole objects rather than raw shapes.
  Exported so the schemas can be asserted in tests without starting a server.
*/
export const ListMarketsInput = z.object({
  scope: z
    .enum(["community", "global", "all"])
    .optional()
    .describe("Narrow the list. Defaults to all."),
  communitySlug: z
    .string()
    .optional()
    .describe("One community's markets. The builder has to be a member."),
});

export const PlaceBetInput = z.object({
  marketId: z.string().describe("Market id, from list_markets."),
  outcomeId: z.string().describe("Outcome id, from list_markets."),
  side: z.enum(["buy", "sell"]).describe("buy opens or adds, sell closes."),
  credits: z.number().positive().optional().describe("Credits to spend, or to raise on a sell."),
  shares: z.number().positive().optional().describe("Shares to trade, instead of credits."),
  confirm: z
    .boolean()
    .optional()
    .describe("Nothing is spent unless this is true. Quote first, then confirm."),
});

export type ListMarketsArgs = z.infer<typeof ListMarketsInput>;
export type PlaceBetArgs = z.infer<typeof PlaceBetInput>;

/** Every tool answers with text, because every answer here is a small table. */
function text(lines: string | string[]) {
  return {
    content: [
      { type: "text" as const, text: Array.isArray(lines) ? lines.join("\n") : lines },
    ],
  };
}

function failure(message: string) {
  return { ...text(message), isError: true };
}

const usd = (value: number) => `$${value.toFixed(2)}`;
const cents = (price: number) => `${(price * 100).toFixed(1)}c`;
const credits = (value: number) => value.toFixed(2);

/** Thousands separators make a token count readable; nothing else here needs them. */
const tokens = (value: number) => value.toLocaleString("en-US");

function marketLines(markets: readonly MarketRow[]): string[] {
  if (markets.length === 0) return ["No open markets."];
  return markets.flatMap((market) => {
    const where = market.communitySlug ? `c/${market.communitySlug}` : market.scope;
    return [
      `${market.id}  ${market.question}`,
      `  ${where}, closes ${market.closesAt}`,
      ...market.outcomes.map(
        (outcome) => `  ${cents(outcome.price)}  ${outcome.label}  (${outcome.id})`,
      ),
    ];
  });
}

function quoteLines(answer: Extract<TradeAnswer, { placed: false }>): string[] {
  const { quote } = answer;
  return [
    `${quote.side} ${quote.shares} shares`,
    // A sell is paid, not charged, and calling that a cost would read as a loss.
    `  ${quote.side === "sell" ? "proceeds      " : "cost          "} ${credits(quote.credits)} credits`,
    `  average price  ${cents(quote.averagePrice)}`,
    `  price after    ${cents(quote.priceAfter)} (now ${cents(quote.priceBefore)})`,
    `  balance after  ${credits(quote.balanceAfter)} credits (now ${credits(quote.balance)})`,
    "",
    "Nothing was spent. Call again with confirm: true to place it.",
  ];
}

export interface McpDependencies {
  /** Read at call time, not at startup, so connecting in another terminal takes effect. */
  signal?: AbortSignal;
  loadConfig?: () => DeviceConfig | null;
  /** Injected in tests. Given a config, answers the four /api/me routes. */
  client?: (config: DeviceConfig) => ApiClient;
  /** Injected in tests. Runs one sync and returns what it printed. */
  runSync?: (
    config: DeviceConfig,
    log: (line: string) => void,
    options?: AutoSyncOptions,
  ) => Promise<number>;
}

/** The server, wired but not connected to a transport. Exported so tests can drive it. */
export function createMcpServer(dependencies: McpDependencies = {}): McpServer {
  const loadConfig = dependencies.loadConfig ?? (() => readConfig(currentConfigPath()));
  const clientFor = dependencies.client ?? ((config: DeviceConfig) => new ApiClient(config, (url, init) => {
    const signals = [AbortSignal.timeout(60_000)];
    if (dependencies.signal) signals.push(dependencies.signal);
    if (init?.signal) signals.push(init.signal);
    return fetch(url, { ...init, signal: AbortSignal.any(signals) });
  }));
  const runSync =
    dependencies.runSync ??
    ((config: DeviceConfig, log: (line: string) => void, options?: AutoSyncOptions) =>
      sync({ configPath: currentConfigPath(), log, ...options, signal: dependencies.signal }));

  const server = new McpServer(
    { name: "tokenburnmarket", version: "0.2.5" },
    { capabilities: { tools: {} } },
  );

  /*
    Sync as soon as the agent has said hello. This process is already running
    for the whole session, so the upload costs the person nothing they can see,
    and it is the reason nobody has to remember to sync. Nothing may be printed:
    stdout is the transport, and one stray line would corrupt it. Failures are
    swallowed for the same reason the tools answer on an unconnected machine; a
    sync that could not happen is not a reason to take the server down.
  */
  server.server.oninitialized = () => {
    const config = loadConfig();
    if (!config) return;
    void runSync(config, () => {}, { skipIfSyncedWithinMs: AUTO_SYNC_INTERVAL_MS }).catch(
      () => {},
    );
  };

  /** Wraps a tool so a missing config and a refused request read the same way. */
  const withClient =
    <T>(run: (client: ApiClient, config: DeviceConfig, args: T) => Promise<ReturnType<typeof text>>) =>
    async (args: T) => {
      const config = loadConfig();
      if (!config) return failure(NOT_CONNECTED);
      try {
        return await run(clientFor(config), config, args);
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }
    };

  server.registerTool(
    "sync_usage",
    {
      title: "Sync usage",
      description:
        "Upload this machine's agent usage to tokenburnmarket and return what the server made of it. Safe to call at the end of a session.",
      inputSchema: {},
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => {
      const config = loadConfig();
      if (!config) return failure(NOT_CONNECTED);
      const lines: string[] = [];
      try {
        const code = await runSync(config, (line) => lines.push(line));
        const output = lines.filter((line) => line !== "").join("\n");
        return code === 0 ? text(output || "Nothing to sync.") : failure(output || "Sync failed.");
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }
    },
  );

  server.registerTool(
    "my_stats",
    {
      title: "My stats",
      description:
        "Today, this week and this month of agent spend and tokens for the connected builder, plus their credit balance and how their usage is trusted.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    withClient(async (client) => {
      const stats = await client.stats();
      const row = (label: string, window: { costUsd: number; tokens: number }) =>
        `  ${label.padEnd(6)} ${usd(window.costUsd).padStart(10)}  ${tokens(window.tokens)} tokens`;
      return text([
        `@${stats.handle}`,
        `  credits ${credits(stats.credits.balance)}`,
        row("today", stats.usage.today),
        row("week", stats.usage.week),
        row("month", stats.usage.month),
        stats.trust.length > 0
          ? `  trust   ${stats.trust.map((t) => `${t.provider} ${t.level}`).join(", ")}`
          : "  trust   nothing synced yet",
        stats.quarantinedDays > 0
          ? `  ${stats.quarantinedDays} day rows are quarantined and visible only to you`
          : "",
      ].filter((line) => line !== ""));
    }),
  );

  server.registerTool(
    "my_communities",
    {
      title: "My communities",
      description: "The communities the connected builder belongs to, by slug and name.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    withClient(async (client) => {
      const { communities } = await client.communities();
      if (communities.length === 0) return text("Not in any community yet.");
      return text(communities.map((community) => `${community.slug}  ${community.name}`));
    }),
  );

  server.registerTool(
    "list_markets",
    {
      title: "List markets",
      description:
        "Open markets the connected builder can trade, with the current price of every outcome. Prices read as probabilities and add up to 1.",
      inputSchema: ListMarketsInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    withClient(async (client, _config, args: ListMarketsArgs) => {
      const { markets } = await client.markets(args);
      return text(marketLines(markets));
    }),
  );

  server.registerTool(
    "place_bet",
    {
      title: "Place bet",
      description:
        "Buy or sell shares in a market outcome. Without confirm: true this only quotes the trade and spends nothing. Always show the quote to the person before confirming.",
      inputSchema: PlaceBetInput,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    withClient(
      async (
        client,
        _config,
        args: PlaceBetArgs,
      ) => {
        if (args.credits === undefined && args.shares === undefined) {
          return failure("Say how much: credits, or shares.");
        }
        const answer = await client.trade({
          marketId: args.marketId,
          outcomeId: args.outcomeId,
          side: args.side,
          credits: args.credits,
          shares: args.shares,
          // Anything other than a literal true is a quote, including a missing flag.
          confirm: args.confirm === true,
        });

        if (!answer.placed) return text(quoteLines(answer));
        const { filled } = answer;
        return text([
          `Filled: ${filled.side} ${filled.shares} shares for ${credits(filled.credits)} credits.`,
          `  average price  ${cents(filled.averagePrice)}`,
          `  price now      ${cents(filled.priceAfter)}`,
          `  balance        ${credits(answer.balanceAfter)} credits`,
          `  trade          ${answer.tradeId}`,
        ]);
      },
    ),
  );

  return server;
}

/** Start the server on stdio and stay up until the client disconnects. */
export async function runMcpServer(dependencies: McpDependencies = {}): Promise<number> {
  const controller = new AbortController();
  const server = createMcpServer({ ...dependencies, signal: controller.signal });
  let finish!: () => void;
  const closed = new Promise<void>((resolve) => { finish = resolve; });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    controller.abort();
    void server.close().then(finish, finish);
  };
  server.server.onclose = stop;
  process.stdin.once("end", stop);
  process.stdin.once("close", stop);
  process.stdin.once("error", stop);
  process.stdout.once("error", stop);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  // Some hosts leave inherited pipes open when they die.
  const parent = process.ppid;
  const watchdog = setInterval(() => {
    if (process.ppid !== parent || process.ppid === 1) stop();
  }, 1000);
  try {
    await server.connect(new StdioServerTransport());
    if (process.stdin.readableEnded || process.stdin.destroyed) stop();
    await closed;
  } finally {
    controller.abort();
    clearInterval(watchdog);
    process.stdin.removeListener("end", stop);
    process.stdin.removeListener("close", stop);
    process.stdin.removeListener("error", stop);
    process.stdout.removeListener("error", stop);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
  return 0;
}
