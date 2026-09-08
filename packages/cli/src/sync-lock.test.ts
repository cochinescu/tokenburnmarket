import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { afterEach, expect, it } from "vitest";
import { generateDeviceKeyPair } from "@tokenburnmarket/core/signing";
import { writeConfig } from "./config";
import { sync } from "./sync";
import { acquireSyncLock } from "./sync-lock";

const directories: string[] = [];
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "tbm-sync-lock-"));
  directories.push(dir);
  return dir;
}
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it("excludes overlapping calls even within the same process and releases idempotently", () => {
  const path = join(temp(), "lock");
  const first = acquireSyncLock(path)!;
  expect(first).not.toBeNull();
  expect(acquireSyncLock(path)).toBeNull();
  first.release();
  const second = acquireSyncLock(path)!;
  expect(second).not.toBeNull();
  first.release();
  expect(acquireSyncLock(path)).toBeNull();
  second.release();
});

it("recovers dead owners without allowing stale release to remove a replacement", () => {
  const path = join(temp(), "lock");
  const stale = acquireSyncLock(path, 123)!;
  const replacement = acquireSyncLock(path, process.pid, () => false)!;
  expect(replacement).not.toBeNull();
  stale.release();
  expect(acquireSyncLock(path)).toBeNull();
  replacement.release();
});

it("lets only one competing process recover a stale lock", async () => {
  const dir = temp();
  const path = join(dir, "lock");
  acquireSyncLock(path, 2147483647);
  const modulePath = join(dir, "sync-lock.mjs");
  writeFileSync(modulePath, ts.transpileModule(readFileSync(new URL("./sync-lock.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText);
  const children = Array.from({ length: 8 }, () => spawn(process.execPath, ["--input-type=module", "-e", `
    import { acquireSyncLock } from ${JSON.stringify(pathToFileURL(modulePath).href)};
    process.stdout.write('ready\\n');
    process.stdin.once('data', () => {
      const lock = acquireSyncLock(${JSON.stringify(path)});
      process.stdout.write(lock ? 'held\\n' : 'skipped\\n');
      process.stdin.once('data', () => { lock?.release(); process.exit(0); });
    });
  `], { stdio: ["pipe", "pipe", "pipe"] }));
  const nextLine = (child: typeof children[number]) => new Promise<string>((resolve) => {
    child.stdout.once("data", (chunk) => resolve(String(chunk).trim()));
  });
  try {
    expect(await Promise.all(children.map(nextLine))).toEqual(Array(8).fill("ready"));
    const results = children.map(nextLine);
    children.forEach((child) => child.stdin.write("go\n"));
    expect((await Promise.all(results)).filter((line) => line === "held")).toHaveLength(1);
  } finally {
    const exits = children.map((child) => new Promise((resolve) => child.once("exit", resolve)));
    children.forEach((child) => child.stdin.write("done\n"));
    await Promise.all(exits);
  }
}, 15_000);

it("skips overlapping sync collection and releases after collection fails", async () => {
  const configPath = join(temp(), "config.json");
  writeConfig({
    serverUrl: "https://example.test", deviceId: "device", deviceName: "test", handle: "ada",
    deviceToken: "token", ...(await generateDeviceKeyPair()), connectedAt: new Date().toISOString(),
  }, configPath);
  let rejectRead!: (error: Error) => void;
  const first = sync({ configPath, log: () => {}, readUsage: () => new Promise((_resolve, reject) => { rejectRead = reject; }) });
  const logs: string[] = [];
  expect(await sync({ configPath, log: (line) => logs.push(line), readUsage: async () => { throw new Error("overlap"); } })).toBe(0);
  expect(logs).toContain("Another usage sync is already running. Skipping this sync.");
  rejectRead(new Error("collector failed"));
  await expect(first).rejects.toThrow("collector failed");
  expect(await sync({ configPath, home: temp(), env: {}, log: () => {}, readUsage: async () => [] })).toBe(0);
  expect(await sync({ configPath, home: temp(), env: {}, log: () => {}, readUsage: async () => [] })).toBe(0);
});

it("releases the sync lock when cancellation arrives during collection", async () => {
  const configPath = join(temp(), "config.json");
  writeConfig({
    serverUrl: "https://example.test", deviceId: "device", deviceName: "test", handle: "ada",
    deviceToken: "token", ...(await generateDeviceKeyPair()), connectedAt: new Date().toISOString(),
  }, configPath);
  const controller = new AbortController();
  await expect(sync({
    configPath, signal: controller.signal, log: () => {},
    readUsage: async (options) => {
      expect(options?.signal).toBe(controller.signal);
      controller.abort(new Error("disconnected"));
      return [];
    },
  })).rejects.toThrow("disconnected");
  const next = acquireSyncLock(`${configPath}.sync-lock`);
  expect(next).not.toBeNull();
  next?.release();
});
