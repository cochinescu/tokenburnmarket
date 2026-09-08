import { spawn, spawnSync } from "node:child_process";

/** Bound scans and own the npx process tree, including its shell and worker. */
export function runCollector(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  timeoutMs = 5 * 60_000,
): Promise<string> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let failure: Error | undefined;
    const child = spawn(command, args, {
      env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024 * 1024) {
        failure = new Error("Usage collection exceeded its output limit.");
        cleanup();
      } else chunks.push(chunk);
    });
    // Drain stderr without retaining potentially unbounded collector diagnostics.
    child.stderr.resume();
    child.once("exit", cleanup);
    child.once("error", (error) => { failure = error; });
    child.once("close", (code, exitSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      process.removeListener("exit", cleanup);
      cleanup();
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Usage collection exited with ${exitSignal ?? code}.`));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
    function cleanup() {
      if (!child.pid) return;
      try {
        if (process.platform === "win32") {
          spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
        } else {
          process.kill(-child.pid, "SIGKILL");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    function abort() {
      failure = new Error("Usage collection cancelled.");
      cleanup();
    }
    const timer = setTimeout(() => {
      failure = new Error(`Usage collection timed out after ${timeoutMs}ms.`);
      cleanup();
    }, timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    process.once("exit", cleanup);
    if (signal?.aborted) abort();
  });
}
