import { Type, StringEnum, type Static } from "@earendil-works/pi-ai";

export const ActionSchema = Type.Object({
  action: StringEnum(["spawn", "list", "send", "inspect", "stop"] as const),
  target: Type.Optional(Type.String({ description: "Agent ID, teammate name, or main" })),
  name: Type.Optional(Type.String()),
  message: Type.Optional(Type.String()),
  mode: Type.Optional(Type.Union([Type.Literal("steer"), Type.Literal("followUp")])),
  scope: Type.Optional(Type.Union([Type.Literal("team"), Type.Literal("mains")])),
  cwd: Type.Optional(Type.String()),
  request: Type.Optional(Type.String({ description: "Request task ID returned by spawn/send" })),
  transcript: Type.Optional(Type.Boolean({ description: "Inspect a page of the worker's complete persisted transcript" })),
  cursor: Type.Optional(Type.String({ description: "Opaque next cursor from a transcript page" })),
  team: Type.Optional(Type.Boolean({ description: "Stop the whole team (main only)" })),
});
export type Action = Static<typeof ActionSchema>;
export type Mode = "steer" | "followUp";
export type Actor = { id: string; teamId: string; role: "main" | "worker"; name: string };
export type Delivery = { id: string; from: Actor; text: string; mode: Mode; request?: string };
export const TOOL_NAME = "team";
export const TOOL_DESCRIPTION = "Manage persistent Durable teammates: spawn, list, send, inspect latest messages or request results, stop. Workers can list/message/inspect teammates; mains can also list/message other mains. Reports arrive asynchronously. Read the durable-teams skill for workflow and limits.";
export const MESSAGE_TYPE = "durable-team-message";
export const IDENTITY_TYPE = "durable-team-identity";
export const SENT_TYPE = "durable-team-sent";
