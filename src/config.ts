// The host's config.json: the one source of truth for worker models and the host's provider packages.
// The host reads worker models on every spawn; `/team models` edits them in place.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { stateDir } from "./paths.ts";

/** A worker model; `thinking` unset follows the main session's thinking level. */
export type WorkerModel = { provider: string; modelId: string; thinking?: ModelThinkingLevel };
export type Config = {
  /** Pi packages whose model providers the host loads. Read at host startup. */
  providerExtensions?: string[];
  /** Model for new workers; unset uses the main's model. */
  workerModel?: WorkerModel;
  /** Name rules: a worker whose name contains the key (case-insensitive) uses its model. First match wins. */
  workerModels?: Record<string, WorkerModel>;
};

const path = (dir: string) => join(dir, "config.json");
const isStrings = (x: unknown) => Array.isArray(x) && x.every(v => typeof v === "string");
const isModel = (m: any) => typeof m?.provider === "string" && typeof m?.modelId === "string" && (m.thinking === undefined || typeof m.thinking === "string");

/** Missing file: no settings. Malformed file: throws. */
export async function readConfig(dir = stateDir): Promise<Config> {
  let config: any;
  try { config = JSON.parse(await readFile(path(dir), "utf8")); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  if (config.providerExtensions !== undefined && !isStrings(config.providerExtensions)) throw new Error("providerExtensions must be an array of Pi package paths");
  if (config.workerModel !== undefined && !isModel(config.workerModel)) throw new Error("workerModel must be { provider, modelId, thinking? }");
  if (config.workerModels !== undefined && (typeof config.workerModels !== "object" || !Object.values(config.workerModels).every(isModel))) {
    throw new Error("workerModels must map name keywords to { provider, modelId, thinking? }");
  }
  return config;
}

/** Replaces the worker model settings and keeps everything else in the file. Atomic. */
export async function writeWorkerModels(change: Pick<Config, "workerModel" | "workerModels">, dir = stateDir) {
  const config = { ...await readConfig(dir), workerModel: change.workerModel, workerModels: change.workerModels };
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temporary = `${path(dir)}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  await rename(temporary, path(dir));
}

/** The configured model for a worker name, if any: first matching name rule, else workerModel. */
export function workerModelFor(config: Config, name: string): WorkerModel | undefined {
  const lower = name.toLowerCase();
  return Object.entries(config.workerModels ?? {}).find(([key]) => lower.includes(key.toLowerCase()))?.[1] ?? config.workerModel;
}
