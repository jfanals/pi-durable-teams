import { existsSync, readdirSync, statSync } from "node:fs";
import { access, readdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";

export const errorText = (error: unknown) => `Cannot read: ${error instanceof Error ? error.message : String(error)}`;
const sorted = (names: string[]) => names.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()) || a.localeCompare(b));
const markerPaths = [[".git"], ["AGENTS.md"], [".pi/skills", "skills/SKILL.md"]];
const markerText = (found: boolean[]) => ["git", "AGENTS.md", "skills"].filter((_, i) => found[i]).join(" · ");

/** Synchronous snapshots for the local terminal picker; the host uses async I/O below. */
export function directories(path: string): { names: string[]; error?: string } {
  try {
    const names = readdirSync(path, { withFileTypes: true }).filter(entry => {
      if (entry.name === "node_modules") return false;
      try { return entry.isDirectory() || (entry.isSymbolicLink() && statSync(join(path, entry.name)).isDirectory()); } catch { return false; }
    }).map(entry => entry.name);
    return { names: sorted(names) };
  } catch (error) { return { names: [], error: errorText(error) }; }
}
export function markers(path: string) {
  return markerText(markerPaths.map(paths => paths.some(name => existsSync(join(path, name)))));
}

export async function listDirectories(path = homedir()) {
  if (!isAbsolute(path)) throw new Error("path must be absolute");
  let names: string[] = []; let error: string | undefined;
  try {
    const entries = await readdir(path, { withFileTypes: true });
    const found = await Promise.all(entries.map(async entry => {
      if (entry.name === "node_modules") return [];
      try { return entry.isDirectory() || (entry.isSymbolicLink() && (await stat(join(path, entry.name))).isDirectory()) ? [entry.name] : []; }
      catch { return []; }
    }));
    names = sorted(found.flat());
  } catch (cause) { error = errorText(cause); }
  const dirs = await Promise.all(names.map(async name => {
    const found = await Promise.all(markerPaths.map(async paths => (await Promise.all(paths.map(async marker => {
      try { await access(join(path, name, marker)); return true; } catch { return false; }
    }))).some(Boolean)));
    return { name, markers: markerText(found) };
  }));
  return { path, ...(dirname(path) !== path ? { parent: dirname(path) } : {}), dirs, ...(error ? { error } : {}) };
}
