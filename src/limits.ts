// Context limits are Pi's own per-model compaction setting (compaction.modelOverrides["provider/id"].reserveTokens
// in Pi's settings.json), so the main session and its workers compact at the same point. `/team models` shows and
// edits it as the share of the model's window a session fills before compacting.
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Models } from "@earendil-works/pi-ai";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import { agentDir } from "./paths.ts";

export const LIMIT_PRESETS = [50, 60, 70, 80, 90];
type Window = { provider: string; id: string; contextWindow: number };

/** The share of the window filled when this model compacts, from Pi's resolved setting. */
export const contextLimit = (settings: SettingsManager, model: Window) =>
  model.contextWindow > 0 ? Math.round(100 * (model.contextWindow - settings.getCompactionReserveTokens(model)) / model.contextWindow) : undefined;

/** Sets (or, with undefined, removes) a model's limit in Pi's global settings.json. Other settings are kept. */
export async function writeContextLimit(model: Window, percent: number | undefined, dir = agentDir) {
  const path = join(dir, "settings.json");
  const settings = JSON.parse(await readFile(path, "utf8"));
  const overrides = (settings.compaction ??= {}).modelOverrides ??= {};
  const key = `${model.provider}/${model.id}`;
  const { reserveTokens: _, ...rest } = overrides[key] ?? {};
  overrides[key] = percent === undefined ? rest : { ...rest, reserveTokens: model.contextWindow - Math.round(model.contextWindow * percent / 100) };
  if (!Object.keys(overrides[key]).length) delete overrides[key];
  // Pi rewrites only the settings it changed, so it keeps this edit; rename keeps a reader from seeing half a file.
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(settings, null, 2), { mode: 0o600 });
  await rename(temporary, path);
}

/**
 * pi-durable checks compaction against one reserve for every model, so a model's own reserve is applied by
 * shrinking the window it sees: it then compacts at `window - extra - reserve`, which is Pi's per-model point.
 */
export function withContextLimits(models: Models, settings: SettingsManager): Models {
  return new Proxy(models, {
    get(target, property) {
      if (property === "getModel") return (provider: string, id: string) => {
        const model = target.getModel(provider, id);
        const extra = model ? settings.getCompactionReserveTokens(model) - settings.getCompactionReserveTokens() : 0;
        return model && extra > 0 ? { ...model, contextWindow: model.contextWindow - extra } : model;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
