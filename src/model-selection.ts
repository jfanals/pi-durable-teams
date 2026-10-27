// Shared terminal/web model selection policy. The host supplies Pi's resolved, ordered scope.
export type Choice = { provider: string; modelId: string; name?: string; thinkingLevels: readonly string[]; thinking?: string; cycleThinking?: string; scoped?: boolean; thinkingMap?: Record<string, string> };
export type CurrentModel = { provider?: string; modelId?: string; thinking?: string };
export function nextModel<T extends Choice>(models: T[], current: CurrentModel, backwards = false): T | undefined {
  if (models.length <= 1) return undefined;
  const index = Math.max(0, models.findIndex(m => m.provider === current.provider && m.modelId === current.modelId));
  return models[(index + (backwards ? models.length - 1 : 1)) % models.length];
}
export function modelThinking(model: Choice, current?: string, cycle = false): string {
  const preferred = (cycle ? model.cycleThinking : undefined) ?? model.thinking ?? current ?? "medium";
  if (model.thinkingLevels.includes(preferred)) return preferred;
  return model.thinkingMap?.[preferred] ?? model.thinkingLevels[0] ?? "off";
}
export function modelNotice(model: Choice, thinking: string, cycle = false): string {
  if (!cycle) return `Model: ${model.modelId}`;
  return `Switched to ${model.name || model.modelId}${model.thinkingLevels.length > 1 && thinking !== "off" ? ` (thinking: ${thinking})` : ""}`;
}
export function thinkingSelection(model: Choice, current?: string, requested?: string): string | undefined {
  if (requested) {
    if (!model.thinkingLevels.includes(requested)) throw new Error(`Unsupported thinking level: ${requested}`);
    return requested;
  }
  if (model.thinkingLevels.length <= 1) return undefined;
  return model.thinkingLevels[(model.thinkingLevels.indexOf(current ?? "off") + 1) % model.thinkingLevels.length];
}
