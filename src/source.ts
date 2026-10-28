import type { WorkerModel } from "./config.ts";
import type { ChatItem, Queued } from "./chat.ts";
import type { ModelChoice } from "./model-choices.ts";
import { randomUUID } from "node:crypto";
import type { ModelRef } from "@earendil-works/pi-durable";
import type { ImageContent, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Client } from "./client.ts";
import type { AgentSummary, Mode } from "./protocol.ts";
import type { WorkerSource } from "./ui.ts";

export type TreeNode = { entry: { type: "message"; id: string; parentId: string | null; timestamp: string; message: any }; children: TreeNode[] };
export type TreeResult = { nodes: TreeNode[]; leafId: string | null; id?: string; editorText?: string };
export type TranscriptPage = { conversationId?: string; items: ChatItem[]; queued?: Queued[]; next?: string };
export type RequestOptions = { requestId?: string; signal?: AbortSignal; images?: ImageContent[] };
export type CompactResult = { taskId: number; outcome: "compacted" | "nothing" | "running" | "failed"; error?: string };
export type MutationResult = { id?: string; taskId?: number; workerId?: string; delivery?: string; aborted?: string[]; stopped?: string[]; model?: ModelRef; thinking?: ModelThinkingLevel };
export interface HostSource {
  images(target: string, entryId: string): Promise<ImageContent[]>;
  models(signal?: AbortSignal): Promise<ModelChoice[]>;
  defaults(signal?: AbortSignal): Promise<WorkerModel | null>;
  list(signal?: AbortSignal): Promise<AgentSummary[]>;
  roster(signal: AbortSignal, receive: (agents: AgentSummary[]) => void | Promise<void>): Promise<void>;
  page(target: string, cursor?: string, signal?: AbortSignal): Promise<TranscriptPage>;
  watch(target: string, signal: AbortSignal, receive: (frame: unknown) => void | Promise<void>): Promise<void>;
  send(target: string, message: string, mode?: Mode, options?: RequestOptions): Promise<MutationResult>;
  stop(target: string, options?: RequestOptions): Promise<MutationResult>;
  archive(target: string, options?: RequestOptions): Promise<MutationResult>;
  unarchive(target: string, options?: RequestOptions): Promise<MutationResult>;
  remove(target: string, options?: RequestOptions): Promise<MutationResult>;
  newAgent(agent: { name: string; cwd: string; model?: ModelRef; thinking?: ModelThinkingLevel }, options?: RequestOptions): Promise<MutationResult>;
  rename(target: string, name: string, options?: RequestOptions): Promise<MutationResult>;
  setModel(target: string, provider: string, modelId: string, thinking?: ModelThinkingLevel, options?: RequestOptions): Promise<MutationResult>;
  compact(target: string, instructions?: string): Promise<CompactResult>;
  /** Pi's alt+up: queued messages taken back out of `target`'s inbox, oldest first. */
  dequeue(target: string): Promise<{ texts: string[] }>;
  /** The human's messages to `target`, oldest first: what `/fork` offers. */
  inputs(target: string): Promise<{ id: string; text: string }[]>;
  /** A new top-level agent from `target`'s history: all of it, or what came before input `before`. */
  fork(target: string, before?: string, options?: RequestOptions): Promise<MutationResult>;
  tree(target: string, entryId?: string, options?: RequestOptions): Promise<TreeResult>;
}

/** No implicit retries. Supply the same requestId when retrying a mutation. */
export class SocketHostSource implements HostSource {
  readonly client: Client;
  constructor(client = new Client()) { this.client = client; }
  images(target: string, entryId: string) { return this.client.call<ImageContent[]>("agents/images", { target, entryId }); }
  models(signal?: AbortSignal) { return this.client.call<ModelChoice[]>("agents/models", {}, signal); }
  defaults(signal?: AbortSignal) { return this.client.call<WorkerModel | null>("agents/defaults", {}, signal); }
  list(signal?: AbortSignal) { return this.client.call<AgentSummary[]>("agents", {}, signal); }
  async roster(signal: AbortSignal, receive: (agents: AgentSummary[]) => void | Promise<void>) {
    await this.client.ensureHost(signal);
    if (signal.aborted) return;
    return this.client.stream("agents/roster", {}, signal, receive);
  }
  page(target: string, cursor?: string, signal?: AbortSignal) { return this.client.call<TranscriptPage>("agents/page", { target, cursor }, signal); }
  watch(target: string, signal: AbortSignal, receive: (frame: unknown) => void | Promise<void>) {
    return this.client.stream("agents/watch", { target }, signal, receive);
  }
  private mutate(route: string, body: object, options: RequestOptions = {}) {
    return this.client.call<MutationResult>(`agents/${route}`, { ...body, requestId: options.requestId ?? randomUUID() }, options.signal);
  }
  send(target: string, message: string, mode: Mode = "followUp", options?: RequestOptions) { return this.mutate("send", { target, message, mode, images: options?.images }, options); }
  stop(target: string, options?: RequestOptions) { return this.mutate("stop", { target }, options); }
  archive(target: string, options?: RequestOptions) { return this.mutate("archive", { target }, options); }
  unarchive(target: string, options?: RequestOptions) { return this.mutate("unarchive", { target }, options); }
  newAgent(agent: { name: string; cwd: string; model?: ModelRef; thinking?: ModelThinkingLevel }, options?: RequestOptions) { return this.mutate("new", agent, options); }
  remove(target: string, options?: RequestOptions) { return this.mutate("remove", { target }, options); }
  rename(target: string, name: string, options?: RequestOptions) { return this.mutate("rename", { target, name }, options); }
  setModel(target: string, provider: string, modelId: string, thinking?: ModelThinkingLevel, options?: RequestOptions) { return this.mutate("model", { target, provider, modelId, thinking }, options); }
  compact(target: string, instructions?: string) { return this.client.call<CompactResult>("agents/compact", { target, instructions }); }
  dequeue(target: string) { return this.client.call<{ texts: string[] }>("agents/dequeue", { target }); }
  inputs(target: string) { return this.client.call<{ id: string; text: string }[]>("agents/inputs", { target }); }
  tree(target: string, entryId?: string, options: RequestOptions = {}) { return this.client.call<TreeResult>("agents/tree", { target, entryId, requestId: options.requestId ?? randomUUID() }, options.signal); }
  fork(target: string, before?: string, options?: RequestOptions) { return this.mutate("fork", { target, before }, options); }
}

/** Bind the shared chat inspector to one agent without database access. */
export function workerSource(source: HostSource, target: string): WorkerSource {
  return {
    images: entryId => source.images(target, entryId),
    page: cursor => source.page(target, cursor),
    status: async () => {
      const find = (rows: AgentSummary[]): AgentSummary | undefined => {
        for (const row of rows) { if (row.id === target) return row; const child = find(row.children); if (child) return child; }
      };
      const agent = find(await source.list());
      if (!agent) throw new Error("Agent not found");
      return agent;
    },
    watch: (signal, onFrame) => source.watch(target, signal, onFrame),
  };
}
