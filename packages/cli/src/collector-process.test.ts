import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCollector } from "./collector-process.js";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe("collector process ownership", () => {
  it("returns stdout and reports spawn errors", async () => {
    await expect(runCollector(process.execPath, ["-e", "console.log('ok')"], process.env)).resolves.toBe("ok\n");
    await expect(runCollector("/nonexistent/tbm-command", [], process.env)).rejects.toThrow();
  });

  it.each(["abort", "timeout"])("kills wrapper and grandchild on %s", async (mode) => {
    const dir = mkdtempSync(join(tmpdir(), "tbm-collector-"));
    const path = join(dir, "pid");
    const controller = new AbortController();
    const script = `const {spawn}=require('node:child_process'); const fs=require('node:fs');
      const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});
      fs.writeFileSync(${JSON.stringify(path)},String(child.pid)); setInterval(()=>{},1000);`;
    let pid: number | undefined;
    try {
      const result = runCollector(process.execPath, ["-e", script], process.env, controller.signal, mode === "timeout" ? 1000 : 10000);
      const rejected = expect(result).rejects.toThrow(mode === "abort" ? /cancelled/ : /timed out/);
      for (let n = 0; n < 100 && !existsSync(path); n++) await sleep(10);
      pid = Number(readFileSync(path, "utf8"));
      expect(alive(pid)).toBe(true);
      if (mode === "abort") controller.abort();
      await rejected;
      for (let n = 0; n < 100 && alive(pid); n++) await sleep(10);
      expect(alive(pid)).toBe(false);
    } finally {
      controller.abort();
      if (pid && alive(pid)) process.kill(pid, "SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
