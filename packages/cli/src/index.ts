#!/usr/bin/env node
/*
  tokenburnmarket, the Collector.

  connect binds this machine to a Builder and runs the first sync, sync uploads
  Usage, status says what is stored here, daemon syncs on a timer, and mcp
  serves the whole thing to an agent over stdio, syncing itself when it starts.
*/
import { parseArgs } from "./args.js";
import { connect } from "./connect.js";
import { currentConfigPath, readConfig, resolveServerUrl } from "./config.js";
import { describeError } from "./errors.js";
import { daemon, DEFAULT_INTERVAL, installDaemon, installSnippet } from "./daemon.js";
import { runMcpServer } from "./mcp.js";
import { mcpSetupLines } from "./setup.js";
import { sync } from "./sync.js";

const USAGE = `tokenburnmarket

  connect [--server URL] [--name NAME]   bind this machine to your account and sync
  sync [--since N] [--dry-run] [--quiet] upload usage for the days that changed
  status                                 show what is stored on this machine
  daemon [--interval 15m]                sync on a timer, in the foreground
  daemon install [--interval 15m]        install and start a per-user sync service
  daemon install --dry-run               print the service definition, change nothing
  mcp                                    run the MCP server on stdio; syncs at startup
  mcp setup                              print the lines that point an agent here

  --server URL     the server to talk to, also settable as TBM_SERVER
  --name NAME      what this device is called, defaults to the hostname
  --since N        collect the last N days instead of the days since the last sync
  --dry-run        show what would be uploaded, upload nothing
  --quiet          print nothing unless something went wrong
  --interval SPEC  how often the daemon syncs: 30s, 15m, 2h. Defaults to ${DEFAULT_INTERVAL}

The MCP server exposes sync_usage, my_stats, my_communities, list_markets and
place_bet. place_bet quotes the trade and spends nothing unless it is called
with confirm: true.

Config lives in the platform config directory.
`;

/** What `status` prints. Never the token, never the private key. */
function status(): void {
  const path = currentConfigPath();
  const config = readConfig(path);
  if (!config) {
    console.log("Not connected. Run: tokenburnmarket connect");
    console.log(`Nothing stored at ${path}`);
    return;
  }
  console.log(`Handle      @${config.handle}`);
  console.log(`Device      ${config.deviceName}`);
  console.log(`Device id   ${config.deviceId}`);
  console.log(`Server      ${config.serverUrl}`);
  console.log(`Connected   ${config.connectedAt}`);
  console.log(`Synced to   ${config.lastSyncedDay ?? "never"}`);
  console.log(`Last sync   ${config.lastSyncedAt ?? "never"}`);
  console.log(`Config      ${path}`);
}

async function main(): Promise<number> {
  const { command, subcommand, flags, switches } = parseArgs(process.argv.slice(2));

  if (!command || command === "help" || switches.has("help") || switches.has("h")) {
    console.log(USAGE);
    return 0;
  }

  switch (command) {
    case "connect":
      await connect({
        serverUrl: resolveServerUrl(flags.server, process.env),
        deviceName: flags.name,
      });
      return 0;
    case "sync": {
      const since = flags.since === undefined ? undefined : Number.parseInt(flags.since, 10);
      if (since !== undefined && (!Number.isFinite(since) || since < 0)) {
        console.error("--since takes a number of days, for example --since 7");
        return 1;
      }
      // For cron lines and scripts. Failures still go to stderr through the thrown error.
      const quiet = switches.has("quiet");
      return sync({
        sinceDays: since,
        dryRun: switches.has("dry-run"),
        log: quiet ? () => {} : undefined,
      });
    }
    case "status":
      status();
      return 0;
    case "daemon": {
      if (subcommand === "install") {
        const context = {
          platform: process.platform,
          execPath: process.execPath,
          scriptPath: process.argv[1] ?? "tokenburnmarket",
          interval: flags.interval ?? DEFAULT_INTERVAL,
          home: process.env.HOME ?? process.env.USERPROFILE ?? "~",
        };
        if (switches.has("dry-run")) {
          for (const line of installSnippet(context)) console.log(line);
          return 0;
        }
        return installDaemon(context);
      }
      if (subcommand) {
        console.error(`Unknown daemon command: ${subcommand}`);
        return 1;
      }
      return daemon({ interval: flags.interval });
    }
    case "mcp": {
      if (subcommand === "setup") {
        for (const line of mcpSetupLines()) console.log(line);
        return 0;
      }
      return runMcpServer();
    }
    default:
      console.error(`Unknown command: ${command}`);
      console.error(USAGE);
      return 1;
  }
}

// Convert normal termination into an exit event so owned collector trees are
// removed for one-shot commands too. MCP and daemon provide their own shutdown.
if (!["mcp", "daemon"].includes(process.argv[2] ?? "")) {
  process.once("SIGINT", () => process.exit(130));
  process.once("SIGTERM", () => process.exit(143));
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(describeError(error));
    process.exitCode = 1;
  });
