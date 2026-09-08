import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function removeOwner(path: string, owner: string): void {
  try {
    unlinkSync(join(path, owner));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    rmdirSync(path);
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
}

/**
 * Publish a populated directory atomically, so every held lock has a unique
 * owner entry. Stale contenders remove only that entry; rmdir cannot remove a
 * replacement owner's nonempty directory. No timeout can evict a live sync.
 */
export function acquireSyncLock(
  path: string,
  pid = process.pid,
  alive: (pid: number) => boolean = isAlive,
): { release: () => void } | null {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const candidate = mkdtempSync(`${path}.candidate-`);
  const owner = `${pid}-${randomUUID()}`;
  try {
    writeFileSync(join(candidate, owner), "", { mode: 0o600 });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        renameSync(candidate, path);
        let released = false;
        return { release: () => {
          if (released) return;
          released = true;
          removeOwner(path, owner);
        } };
      } catch (error) {
        if (!["ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      }
      let entries: string[];
      try {
        entries = readdirSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (entries.length === 0) continue; // Atomic rename can replace an empty stale directory.
      if (entries.length !== 1) return null;
      const staleOwner = entries[0]!;
      const match = /^(\d+)-[0-9a-f-]+$/.exec(staleOwner);
      if (!match || Number(match[1]) < 1 || alive(Number(match[1]))) return null;
      removeOwner(path, staleOwner);
    }
    return null;
  } finally {
    rmSync(candidate, { recursive: true, force: true });
  }
}
