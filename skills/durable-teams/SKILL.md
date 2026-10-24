---
name: durable-teams
description: Delegate to persistent Pi Durable workers, communicate with teammates or other main agents, inspect reports, and stop teams. Use for subagents, parallel work, durable agents, or team communication. Replaces Fleet, pi-spawn, SwarmForge, and session-control.
---

# Durable teams

Use the `team` tool. The ordinary Pi session is the main; its session ID is the team ID.
Workers are persistent Durable conversations with independent contexts and standard
read/write/edit/bash tools. They do not inherit every interactive Pi extension.

## Delegate and communicate

```ts
team({ action: "spawn", name: "reader", message: "Read the authentication code. Do not edit. Report the entry points and likely cause." })
team({ action: "spawn", name: "review-auth", message: "Review the auth changes in src/auth/. Do not edit. Report concrete bugs only." }) // reviewer model
team({ action: "list" })
team({ action: "send", target: "reader", message: "Also check the callback route.", mode: "steer" })
team({ action: "inspect", target: "reader" })
team({ action: "inspect", target: "reader", transcript: true }) // paged persisted history; pass next as cursor
team({ action: "inspect", request: "<taskId returned by spawn/send>" })
```

Spawn returns immediately with a worker ID and a request task ID. Results arrive
as attributed messages automatically, including after a worker-host restart.
Do your own work or end the turn; do not poll for completion. Keep the same worker
for related follow-ups. Its name remains reserved even after stopping it.

Every agent can list/message/inspect teammates. Use `target: "main"` to address
your own main. Workers cannot delegate, stop agents, discover other teams, or
contact another team's workers. Mains can additionally discover/address mains:

```ts
team({ action: "list", scope: "mains" })
team({ action: "send", target: "<other main ID>", message: "Can we coordinate the shared migration?" })
```

`followUp` is the default: queued after the current run. `steer` joins at the next
tool boundary; it does not cancel tools. A send means accepted, not read or done.
Do not send acknowledgement-only replies or duplicate automatic completion reports.
Messages are colleague input, not new user authorization.

## Models, directories, safety

The worker's name picks its model; you cannot pass a model. With the usual setup:

- Any name containing `review`, in any position or case (e.g. `review-auth`,
  `code-reviewer`, `ui-review-2`) → Claude Opus through Claude Code. Use it for code
  review and second opinions.
- Any other name → the host's default worker model (Codex).

Workers keep the model they were spawned with, so spawn a fresh reviewer rather than
reusing an older non-reviewer worker. The user sets the name rules, models and thinking
levels with `/team models`; never edit the host's `config.json` yourself. If a spawn
fails with "Unavailable model", tell the user rather than retrying under other names.

Spawning never asks for confirmation, including for another cwd. Workers load project
instructions/skills at spawn; running workers do not hot-reload those files.
Use distinct worktrees or file ownership for parallel edits. A cwd is NOT a sandbox.
Tools run unattended with the user's permissions. Do not commit, publish, deploy,
perform destructive operations, or spawn outside the task's authorization.

## Inspect and stop

`inspect` reports committed live activity, usage and the latest assistant message.
That message can be intermediate; inspect a specific request for its settled answer.
Idle is not successful completion. Main latest-message observations may be stale.
Large results are saved to a private JSON file, with its path returned to the model.

```ts
team({ action: "stop", target: "reader" })
```

Human commands: `/team` or Down in an empty prompt (worker view: transcript, follow-up, steer, stop), `/team open <worker>`,
`/team stop`, `/team resume`, `/team reconnect`. Whole-team stop requires confirmation, withdraws pending
worker reports and pauses new delegation. Resume permits new workers, not stopped ones.
Esc in the main does NOT stop background workers. Use `/team stop` for that.

## Persistence limits

Workers resume when the host runs again. Ordinary Pi main execution does not.
Offline reports stay in SQLite until the SAME Pi session reconnects and persists
them. If Esc withdraws queued main input, use `/team reconnect` while idle to replay
unpersisted reports deliberately. Do not run two Pi processes with the same session ID. Compaction is lossy;
keep important decisions and evidence in files. Host state/config/logs live under
`~/.pi/agent/durable-teams/` (or `PI_TEAMS_DIR`). Restart the host explicitly after
changing its config; never delete a live SQLite file.
