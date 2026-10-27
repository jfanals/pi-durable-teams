import type { WorkerStatus } from "./status.ts";
import { Type, StringEnum, type Static, type ModelThinkingLevel } from "@earendil-works/pi-ai";

export const ActionSchema = Type.Object({
  action: StringEnum(["spawn", "list", "send", "inspect", "wait", "stop", "abort"] as const),
  target: Type.Optional(Type.String({ description: "Agent ID, teammate name, or main" })),
  name: Type.Optional(Type.String()),
  message: Type.Optional(Type.String()),
  mode: Type.Optional(Type.Union([Type.Literal("steer"), Type.Literal("followUp")])),
  scope: Type.Optional(Type.Union([Type.Literal("team"), Type.Literal("mains")])),
  cwd: Type.Optional(Type.String()),
  request: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())], { description: "Own request task ID(s) returned by spawn/send" })),
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 0, maximum: 1800, default: 600 })),
  transcript: Type.Optional(Type.Boolean({ description: "Inspect a page of the agent's complete persisted transcript" })),
  cursor: Type.Optional(Type.String({ description: "Opaque next cursor from a transcript page" })),
  team: Type.Optional(Type.Boolean({ description: "Stop the whole team (Pi session only)" })),
});
export type ToolAction = Static<typeof ActionSchema>;
export type Action = Omit<ToolAction, "action"> & {
  action: ToolAction["action"] | "newAgent" | "model" | "rename";
  model?: { provider: string; modelId: string };
  thinking?: ModelThinkingLevel;
  images?: { type: "image"; data: string; mimeType: string }[];
};
export type Mode = "steer" | "followUp";
export type Actor = { id: string; teamId: string; role: "main" | "worker"; name: string };
export type Delivery = { id: string; from: Actor; text: string; mode: Mode; request?: string; images?: { type: "image"; data: string; mimeType: string }[] };
export const TOOL_NAME = "team";
export const TOOL_DESCRIPTION = "Manage durable agents: spawn children, list reachable agents, send, wait for answers, inspect transcripts/results, stop or abort children. Reports arrive asynchronously. Read the durable-teams skill for workflow and limits.";
export const MESSAGE_TYPE = "durable-team-message";
export const IDENTITY_TYPE = "durable-team-identity";
export const SENT_TYPE = "durable-team-sent";

export type AgentSummary = WorkerStatus & {
  hosted: boolean; latest?: string; children: AgentSummary[];
};
