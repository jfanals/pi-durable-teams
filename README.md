# Pi Durable teams

One `team` tool for persistent coding workers and communication between ordinary
interactive Pi mains. No role engine, workflow scheduler, worktree automation,
completion polling, or mirrored Durable main conversation.

Node 24+, Pi 1.3.0. Dependencies are pinned; Durable is experimental.

## Use

Install dependencies with `npm ci --ignore-scripts`, add this package's absolute
path to Pi's `packages`, then restart Pi or `/reload`.
The package installs one extension and one [canonical skill](skills/durable-teams/SKILL.md).

```ts
team({ action: "spawn", name: "reader", message: "Investigate the callback failure. Read only. Return evidence and likely cause." })
team({ action: "list" })
team({ action: "send", target: "reader", message: "Also check the redirect URI.", mode: "steer" })
team({ action: "inspect", request: "<returned taskId>" })
```

Reports arrive automatically. Use the same worker for related follow-ups; do not
poll or send acknowledgement-only messages. Worker names stay reserved after stop.
Inspecting an agent returns its latest assistant message, which may be intermediate;
inspecting a request returns that request's settled outcome/answer.

Main commands: `/team` (pick a worker), `/team open <worker>`, `/team stop`,
`/team resume`, `/team reconnect`. A panel under the prompt shows each running worker
on its own line (spinner, current activity, elapsed time, tokens) and counts idle and
stopped ones. Pressing Down in an empty prompt (past the end of input history) moves
into the panel, where every worker is listed: ↑↓ select, Enter opens, Esc/Up or typing
returns to the prompt. All of it comes from committed host state. `/team` lists only this
session's workers; other sessions' workers are never shown.
The worker view reads the worker's persisted transcript and live activity: scroll
with ↑↓/PgUp/PgDn, `o` loads older pages, `f` sends a follow-up, `s` steers, `x`
stops it (confirmed), `esc` returns. Messages sent there go straight to the worker
with a stable request ID, are noted in this session for you (not the model), and
the worker's report arrives like any other. Viewing never triggers a model request
and does not inject tool-by-tool activity into model context.
Incoming reports render as compact cards (sender, source, first lines); Ctrl+O
expands the full Markdown and IDs. The model still receives the complete report.

Every agent can discover/message/inspect teammates. Only mains can spawn/stop
workers and discover/message other mains. Use IDs for cross-main messages; names
are only resolved inside a team. Mains cannot address another team's workers.
Workers cannot create nested workers. Scope checks are workflow boundaries, not
an OS sandbox against code running with the same user permissions.

New workers use the main's selected model and thinking level (no per-worker
choice) and its cwd unless `cwd` is given. The host reads Pi credentials/models through public ModelRuntime
APIs. Its provider policy is `config.json` under its state directory:

```json
{
  "allowedProviders": ["openai-codex", "claude-code"],
  "workerModel": { "provider": "openai-codex", "modelId": "gpt-6.1-sol" },
  "workerModels": { "review": { "provider": "claude-code", "modelId": "claude-opus-5-5" } },
  "providerExtensions": ["~/.pi/agent/git/github.com/earendil-works/pi-claude-code"]
}
```

All but `allowedProviders` are optional. A new worker's model is, in order: its
`workerModels` entry (key `review` matches any name containing it, case-insensitive,
e.g. `review-auth` or `code-reviewer`; first matching key wins),
then `workerModel`, then the main's model. Every choice is still subject to
`allowedProviders`. `providerExtensions` lists Pi packages whose model providers the
host loads (with Pi's loader); only their providers are used, not their commands or
tools. Workers spawned before a change keep their model.

Missing config defaults to Codex only; malformed config refuses startup. Restart
the host explicitly after changes. Never expand the allowlist to bypass a blocked
request. Main-selected providers registered only by an in-process extension must
also be available to the standalone host through Pi's provider configuration.
There is no silent model fallback. No custom private HTTP dispatcher imports.

Workers have Durable's standard read/write/edit/bash plus `team`, NOT the entire
interactive Pi extension/tool runtime. At spawn, public resource loaders read
AGENTS.md/CLAUDE.md and global/project skills. Spawning never asks for confirmation,
for any cwd. Already-running workers keep their initial resource snapshot. No private
Pi prompt-builder imports or permanent per-directory resource cache.

## Architecture and persistence

- `extension.ts`: ordinary Pi lifecycle, tools, messages, and receipt handling.
- `client.ts`: local HTTP/NDJSON transport and lazy host startup.
- `host.ts` / `daemon.ts`: one process owns the Durable Harness and SQLite.
- `teams.ts`: one membership document, native conversations/inboxes, background
  anchor/reporter tasks, request deduplication and scope checks.
- `resources.ts`: public Pi configuration/resource APIs and standard coding tools.

The Durable root is **non-model control state only**. It owns background tasks;
we never feed it main transcripts or run a second main model.
Each ordinary Pi session is a team and owns its worker conversations through
upstream's background anchors. Mains retain their real Pi session files; workers
retain their real Durable transcripts. Membership/request receipts live in a
Durable document, not a second mailbox database.

Pending reports to an offline main necessarily use that same document because an
ordinary Pi main has no Durable inbox. Report delivery is at-least-once across the
transport. Pi deduplicates by ID using persisted custom-message entries and only
acknowledges after the message exists in its session history. A queued in-memory
message is not an acknowledgement. This covers a host crash, reconnection, and a
main reopen after persistence but before acknowledgement without duplicating the
stored report. A delivery receipt is NOT proof the main read or acted on it.

If Esc withdraws queued main input before persistence, the report remains in host
storage; `/team reconnect` while idle replays it deliberately. No forced resumption
of an aborted main. Ordinary main model execution is not durable: a crash after
message persistence but before processing may leave an unacted-on visible report.
Resume that session and inspect/respond; there is no exactly-once external effect
guarantee. Do not run two Pi processes with the same session ID.

Worker-host restart resumes all pending work in its database, including other
registered teams. It does NOT resurrect interrupted OS shell processes. Tools
follow Durable's replay policy. No daemon supervisor is installed: after a crash
or reboot the next connected Pi client starts the host. Reconnection may resume
previously authorized work and incur model usage.

Stopping a worker aborts its current work, queued inputs and associated reporters;
its name/context remains inspectable. `/team stop` additionally pauses new
delegation, withdraws pending worker reports, and leaves other teams alone.
`/team resume` permits new workers, not resurrection of stopped ones. Main Esc does
not stop background workers. Generic tool side effects, daemonized external
services, Git state and worktrees are not undone by an abort.

## Upstream basis and deliberate deviations

Reference revision: `earendil-works/pi@73f8de80bc87021375f8b525292ac07492253002`.
[Durable examples](https://github.com/earendil-works/pi/tree/73f8de80bc87021375f8b525292ac07492253002/packages/durable/test/examples):

- **23**: background anchor ownership, reporter phases, native submissions,
  stable request IDs, reports surviving restart. This is the primary pattern.
- **20**: use native steer/follow-up queues, not a custom scheduler.
- **19/21**: committed snapshots/events and reconnectable consumers.
- **26/15**: standard coding tools, environments, settings and prompt sections.
- **25**: native compaction; no second context-management layer.
- **13/31**: recovery and reinstalling named task/extension definitions.
- Coding-agent's **subagent extension**: ordinary Pi tools/messages and expandable
  rendering; not its separate subprocess delegation engine.

The reference main revision and npm 1.3.0 differ: released IDs are numeric branded
IDs and session documents do not declare `history`. We adapt to the pinned package
API, not unpublished API shapes. Domain IDs are strings at the external boundary.

Local additions are team membership/scoping, peer/cross-main messaging, ordinary-Pi
transport/receipts, provider restrictions, and explicit stop/pause. Whole-team stop
is a human command/confirmation, not a prompt asking workers to stop.
The worker-host transport is necessary across independent Pi processes. Its
single-owner guard uses SQLite's OS lock on `owner.sqlite` held for process lifetime;
that file stores no domain state. It releases on SIGKILL without PID/heartbeat races.

We do not copy demonstration fake models, temporary-storage cleanup, unlimited
review loops, plan mode, tool-specific orchestration, or payment workflows into
the runtime. Update dependencies and the reference deliberately, then rerun tests.

## State and diagnostics

Default directory: `~/.pi/agent/durable-teams/` (`PI_TEAMS_DIR` overrides).
Socket: `host.sock` (`PI_TEAMS_SOCKET` overrides; macOS paths must stay short).
Files: `teams.sqlite` (+ WAL/SHM), `owner.sqlite`, `host.log`, `config.json` and
private large-result JSON files. Credentials are reused from Pi, not copied here;
main reconnection secrets are in private Pi session/host state. Do not publish them.

Main listings distinguish connected clients from known offline registrations.
Main latest-message observations can be stale. Inspect logs for model/auth failures;
use Pi `/login` to fix credentials. Runtime idle is not successful assignment completion.

Host tools run unattended with user permissions. There is no regex-based safety
claim or filesystem/container sandbox. Delegate only within approved scope;
publication/deletion/deployment still require explicit user authorization.
Use worktrees or distinct file ownership for parallel writers.

To stop/restart the host, inspect its exact PID from `/health` or the startup log,
then SIGTERM that process only. This preserves unfinished work, which resumes on
reopen; it is not a team abort. Never delete live SQLite/WAL files. Stop the owner
or use SQLite-aware backup before copying its database.

## Legacy cutover and rollback

`node scripts/migrate.ts --apply` is an explicit local migration, never an install
hook. It archives original global settings, legacy skills and launcher wrappers
under `~/.pi/agent/retired-delegation/<timestamp>/`. It removes Fleet/pi-spawn/
SwarmForge/session-control package configuration, installs this package, and replaces
user `fleet` / `swarm` entry points with explanatory disabled stubs. It preserves
the legacy provider allowlist. It does not stop any process or alter source repos,
transcripts, databases, launch records, worktrees, or leaf-repo SwarmForge files.
Existing Pi processes retain loaded tools until reload/restart; old agents/daemon
may still run until explicitly retired by their human owner.

Rollback: inspect the backup `manifest.json` and compare current settings with
`settings.after.json` before restoring `settings.json`. Restore archived skill
paths and command wrappers using the manifest; replace only the migration's stubs,
not later user edits. Restart Pi. Preserve/stop any new workers deliberately before
rollback; do not delete either system's runtime storage. Unrelated cmux, browser,
review and general-purpose extensions remain configured.

## Verification

```sh
npm ci --ignore-scripts
npm run check
npm test
```

Tests use deterministic faux models, real Durable storage/tasks, Unix sockets,
subprocesses and the real Pi SDK. No paid requests or user-visible agent tabs.
They cover two teams/four workers, scope enforcement, actual worker tool calls,
request retries, concurrent spawn, latest vs settled answer, native busy queues,
team stop with active tools, real SIGKILL/reopen, lock ownership, offline/large
reports, persisted receipts and busy-main reconnect, public project/skill loading,
and a disposable migration. All fixture processes and data are cleaned up.

Not verified by offline tests: live Codex/provider authentication/streaming, real
model delegation quality, and visual TUI appearance. A paid/real-model smoke run
requires separate approval. This package does not migrate old running teams.
