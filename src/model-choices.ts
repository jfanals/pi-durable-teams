import { getSupportedThinkingLevels, type Api, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";

export type ModelChoice = { provider: string; modelId: string; name?: string; thinkingLevels: ModelThinkingLevel[] };

/** Pi's scoped models take precedence; an empty scope means all available models. */
export function selectableModels<T>(scoped: readonly { model: T }[], available: () => readonly T[]): readonly T[] {
  return scoped.length ? scoped.map(item => item.model) : available();
}
export function modelChoices(models: readonly Model<Api>[]): ModelChoice[] {
  return models.map(model => ({ provider: model.provider, modelId: model.id, name: model.name, thinkingLevels: getSupportedThinkingLevels(model) }));
}
