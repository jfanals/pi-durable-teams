import { shellPath } from "./web-shell.ts";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { link, mkdir, readFile, rename, writeFile, unlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { readConfig } from "./config.ts";

/** Reading credentials never creates or repairs files. Invalid files disable remote access. */
export async function readRemoteToken(directory: string): Promise<string> {
  const token = (await readFile(join(directory, "remote-token"), "utf8")).trim();
  if (token.length < 32) throw new Error("remote-token must contain at least 32 characters; run pi-agents pair --rotate");
  return token;
}

export async function remoteToken(directory: string, rotate = false): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "remote-token");
  const temporary = `${path}.${randomBytes(12).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
    if (rotate) await rename(temporary, path);
    else {
      try { await link(temporary, path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
  } finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
  return readRemoteToken(directory);
}

/** The single remote allowlist. M2 adds exact static shell paths here. */
export function remoteAllowed(path: string): "api" | "shell" | undefined {
  if (shellPath(path)) return "shell";
  if (path === "/health" || path === "/agents" || path.startsWith("/agents/")) return "api";
}
export function tokenMatches(expected: string, supplied: string) {
  if (expected.length < 32 || supplied.length < 32) return false;
  const a = Buffer.from(expected); const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** One host timer refreshes credentials (including idle streams); no file watchers or frame I/O. */
export function tokenCache(directory: string, changed: () => void) {
  let token = ""; let signature = ""; let error = "Host starting";
  let refreshing = false;
  const refresh = async () => {
    if (refreshing) return;
    refreshing = true;
    try {
      const info = await stat(join(directory, "remote-token"), { bigint: true });
      const nextSignature = `${info.ino}:${info.mtimeNs}:${info.size}`;
      if (nextSignature === signature) return;
      const next = await readRemoteToken(directory);
      signature = nextSignature; error = "";
      if (token !== next) { token = next; changed(); }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      signature = "";
      if (token) { token = ""; changed(); }
    } finally { refreshing = false; }
  };
  return { refresh, get: () => ({ token, error }) };
}

export async function pair(directory: string, rotate = false) {
  const port = (await readConfig(directory)).remote?.port;
  if (!port) throw new Error('Phone access is disabled. Set "remote": { "port": 8787 } in config.json and restart the host.');
  const token = await remoteToken(directory, rotate);
  let base = `http://127.0.0.1:${port}`;
  try {
    const status = JSON.parse(execFileSync("tailscale", ["status", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
    if (status.Self?.DNSName) base = `https://${status.Self.DNSName.replace(/\.$/, "")}`;
  } catch { /* Tailscale is optional for local pairing. */ }
  const url = `${base}/?token=${encodeURIComponent(token)}`;
  console.log(url);
  let served = false;
  try { served = execFileSync("tailscale", ["serve", "status"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).includes(`127.0.0.1:${port}`); } catch { /* print setup below */ }
  if (!served) console.log(`Run: tailscale serve --bg ${port}`);
  try { console.log(execFileSync("qrencode", ["-t", "ansiutf8", url], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })); } catch { /* QR is optional. */ }
}
