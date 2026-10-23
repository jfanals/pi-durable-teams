// Explicit local cutover, not an install hook. Leaves processes, source repos,
// transcripts, worktrees and project launch records untouched.
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function migrate(home: string, packageRoot: string) {
  const agent = join(home, ".pi", "agent");
  const settingsPath = join(agent, "settings.json");
  const original = readFileSync(settingsPath, "utf8");
  const settings = JSON.parse(original);
  if ((settings.packages ?? []).some((entry: unknown) => entry === packageRoot)) throw new Error("New package is already configured; no second migration was performed");
  const oldConfig = join(agent, "claude-fleet", "config.json");
  const newConfig = join(agent, "durable-teams", "config.json");
  const allowedProviders = existsSync(oldConfig) ? JSON.parse(readFileSync(oldConfig, "utf8")).allowedProviders : ["openai-codex"];
  if (!Array.isArray(allowedProviders) || !allowedProviders.every(x => typeof x === "string")) throw new Error("Invalid old provider policy; inspect before migration");
  const backup = join(agent, "retired-delegation", new Date().toISOString().replaceAll(":", "-"));
  mkdirSync(backup, { recursive: true, mode: 0o700 });
  writeFileSync(join(backup, "settings.json"), original, { mode: 0o600 });
  const moved: { original: string; archived: string; kind: string }[] = [];
  const retired = (source: string) => /(?:^|\/)(?:pi-spawn|pi-fleet|swarm-forge|swarmforge)(?:\/|$)/i.test(source)
    || source.endsWith("/session-control-default.ts") || source.includes("mitsuhiko/agent-stuff") && source.includes("122e2994");
  const removed = (settings.packages ?? []).filter((entry: any) => retired(typeof entry === "string" ? entry : entry.source));
  settings.packages = (settings.packages ?? []).filter((entry: any) => !removed.includes(entry));
  settings.packages.push(packageRoot);
  const manifest = { createdAt: new Date().toISOString(), packageRoot, settingsPath, removed, moved,
    note: "No legacy processes stopped. Existing processes keep old extensions until restart/reload. No source/history/worktrees removed." };
  const saveManifest = () => writeFileSync(join(backup, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
  saveManifest();
  function archive(path: string, relative: string, kind: string) {
    if (!existsSync(path)) return;
    const destination = join(backup, relative); mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    renameSync(path, destination); moved.push({ original: path, archived: destination, kind }); saveManifest();
  }
  for (const name of ["pi-fleet", "swarmforge", "super-manager"]) archive(join(agent, "skills", name), `skills/${name}`, "skill");
  archive(join(home, ".claude", "skills", "pi-fleet"), "claude-skills/pi-fleet", "legacy Fleet skill link");
  for (const [path, relative] of [
    [join(home, "bin", "fleet"), "commands/fleet"],
    [join(home, ".local", "bin", "swarm"), "commands/swarm"],
  ]) {
    if (!existsSync(path!)) continue;
    archive(path!, relative!, "command");
    writeFileSync(path!, '#!/bin/sh\nprintf "%s\\n" "Legacy delegation is deactivated. Use Pi durable-teams (team tool or /team). Source and runtime history were preserved." >&2\nexit 1\n', { mode: 0o755 });
  }
  // Preserve the existing provider spending policy rather than silently opening providers.
  if (!existsSync(newConfig)) {
    mkdirSync(dirname(newConfig), { recursive: true, mode: 0o700 });
    writeFileSync(newConfig, JSON.stringify({ allowedProviders }, null, 2) + "\n", { mode: 0o600 });
  }
  // Refuse to overwrite a settings edit made while the inventory was being written.
  if (readFileSync(settingsPath, "utf8") !== original) throw new Error(`Settings changed during migration. Restore moved files using ${backup}/manifest.json before retrying.`);
  const temporary = `${settingsPath}.teams-migration`;
  writeFileSync(temporary, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  renameSync(temporary, settingsPath);
  copyFileSync(settingsPath, join(backup, "settings.after.json"));
  return backup;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== "--apply") throw new Error("Usage: node scripts/migrate.ts --apply");
  console.log(migrate(homedir(), fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "")));
}
