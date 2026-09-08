/*
  The one test that runs the thing someone actually installs: the bundle in
  dist, spoken to over stdio by a real MCP client. Everything else in mcp.test.ts
  runs the server in process, which cannot catch a broken bin, a missing shebang
  or a dependency that was bundled away.
*/
import { spawn, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { configPathFor, writeConfig } from "./config.js";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = join(packageDir, "dist", "index.js");

let home: string;

beforeAll(async () => {
  // `pnpm test` can run before `pnpm build`, so build on demand rather than skip.
  if (!existsSync(entry)) {
    execFileSync("npx", ["tsup"], { cwd: packageDir, stdio: "inherit" });
  }
  // An empty HOME means an unconnected machine, which is the state this test
  // wants and, more to the point, leaves the real one alone.
  home = await mkdtemp(join(tmpdir(), "tbm-stdio-"));
}, 180_000);

afterAll(async () => {
  if (home) await rm(home, { recursive: true, force: true });
});

describe("the built server over stdio", () => {
  it("starts, handshakes and lists its tools", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entry, "mcp"],
      env: { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home },
    });
    const client = new Client({ name: "stdio-test", version: "0" });
    await client.connect(transport);

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "list_markets",
      "my_communities",
      "my_stats",
      "place_bet",
      "sync_usage",
    ]);

    // An unconnected machine must answer, not hang or crash.
    const result = await client.callTool({ name: "my_stats", arguments: {} });
    expect(result.isError).toBe(true);

    await client.close();
  }, 60_000);
});

// Client.close() sends signals after a grace period and used to hide the EOF bug.
it("exits on stdin EOF without the client sending a signal", async () => {
  const child = spawn(process.execPath, [entry, "mcp"], {
    env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: "pipe",
  });
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  child.stdin.end();
  const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
  try { expect(await exited).toBe(0); } finally { clearTimeout(timer); child.kill(); }
});

it.each(["EOF", "SIGTERM"])("stops an active startup collector on %s", async (mode) => {
  const isolatedHome = await mkdtemp(join(tmpdir(), "tbm-active-"));
  const pidFile = join(isolatedHome, "worker.pid");
  const script = join(isolatedHome, "collector.cjs");
  await writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(()=>{},1000);`);
  const env = { ...process.env, HOME: isolatedHome, USERPROFILE: isolatedHome, XDG_CONFIG_HOME: isolatedHome,
    TBM_CCUSAGE: `${process.execPath} ${script}` };
  writeConfig({ deviceId: "test", deviceToken: "test", privateKey: "test", publicKey: "test", serverUrl: "http://127.0.0.1:1", handle: "test", deviceName: "test", connectedAt: new Date().toISOString() },
    configPathFor({ platform: process.platform, env, home: isolatedHome }));
  const child = spawn(process.execPath, [entry, "mcp"], { env, stdio: "pipe" });
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  let worker = 0;
  try {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } } }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    for (let n = 0; n < 100; n++) {
      try { worker = Number(await readFile(pidFile, "utf8")); break; } catch { await new Promise(r => setTimeout(r, 20)); }
    }
    expect(worker).toBeGreaterThan(0);
    if (mode === "EOF") child.stdin.end(); else child.kill("SIGTERM");
    expect(await exited).toBe(0);
    expect(() => process.kill(worker, 0)).toThrow();
  } finally {
    clearTimeout(timer);
    child.kill("SIGKILL");
    if (worker) { try { process.kill(worker, "SIGKILL"); } catch {} }
    await rm(isolatedHome, { recursive: true, force: true });
  }
}, 10000);
