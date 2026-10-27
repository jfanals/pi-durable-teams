# Pi Durable teams

One `team` tool for persistent hosted agents, sub-agents and communication with ordinary
interactive Pi sessions. No role engine, workflow scheduler, worktree automation,
completion polling, or mirrored Durable main conversation.

Node 24+, Pi 1.4.0. Dependencies are pinned; Durable is experimental.

## Local client API

`SocketHostSource` in `src/source.ts` is the typed client for the same Unix socket;
`HostSource` is the terminal app boundary. `workerSource(source, id)` adapts it to
`WorkerView`. Clients never open the database. The socket's private 0700 directory
is the only human-route authentication: any process running as the user (including agents with bash) can act as the human.

- `GET` or `POST /agents`: top-level agents with nested `children` and committed
  `liveStatus` fields (`contextWindow` is the model window). External Pi sessions
  expose only known identity, cwd, enabled, connection and latest publication data.
- `POST /agents/new`, `/agents/send`, `/agents/model`: create, message, change model.
- `POST /agents/stop`: abort the current run; `/agents/disable`: disable the subtree.
- `POST /agents/tree`: `{target}` reads the session tree; `{target, entryId, requestId}` navigates it while idle with an empty inbox.
- `POST /agents/page`: `{target, cursor?}` transcript page; external sessions have no transcript.
- `POST /agents/watch`: `{target}` NDJSON snapshots/events for any hosted agent.
- `POST /agents/roster`: NDJSON full-list frames, initially and on status changes.

Mutations accept `requestId`: retain and reuse it for retries. The typed client
supplies a UUID when omitted and never retries automatically; raw requests without
an ID get a server-generated one and cannot be safely retried. IDs are scoped to
the human and action, so use a unique ID for each distinct mutation of an action. Roster invalidation follows
all Durable commits (including model/tool/run activity) and Pi-session connections;
updates coalesce for 25 ms and unchanged lists are suppressed. Slow streams respect
backpressure rather than queueing every change.

## Web tools in hosted agents

Hosted agents and workers share one `pi-web-access-mcp` stdio server. The host
registers its enabled tools (`web_search`, `fetch_content`, `get_search_content`,
`source_check`) with their upstream schemas. It reads `~/.pi/agent/web-search.json`
and provider environment variables; restart the host after changing configuration.
Web reads are replay-safe. A disconnected server restarts on the next call; the
failed call is returned as a tool error, not silently retried.

MCP-mode limits (see [upstream](https://github.com/nicobailon/pi-web-access#use-from-other-agents-mcp)):

- No curator or summaries; configured workflows are ignored.
- No Kimi search or OpenAI search through ChatGPT sign-in/the current Pi model.
- No `fetch_content` answer/extract modes, video prompts/frames, or direct image fetches.
- `includeContent` waits for page fetching before returning search results.
- `get_search_content` retains only the latest 50 results in server memory, shared
  across agents. Server/host restarts lose those results; search again for a fresh ID.

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

Main commands: `/team` (pick a worker), `/team open <worker>`, `/team models`, `/team stop`,
`/team resume`, `/team reconnect`. A panel under the prompt shows each running worker
on its own line (spinner, current activity, elapsed time, context use as in Pi's footer,
e.g. `18.8%/1.0M`, and list-price cost) and counts idle and
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

Inside [cmux](https://www.cmux.dev), the workspace card also shows a `2 workers` pill while
workers run; it is hidden when none are.

Agents can send/inspect their parent, children and siblings. Top-level hosted agents
and Pi sessions can spawn and control their own children; sub-agents cannot spawn.
No agent can address another top-level agent's children. The human can reach every
agent. Default `list` shows your parent, children and teammates, excluding other
top-level agents. Use `scope: "mains"` to discover reachable top-level peers.
External Pi sessions are addressed by ID, not display name. Hosted name lookup
checks children, parent, then siblings; ambiguous matches return the matching IDs.
Scope checks are workflow boundaries, not an OS sandbox against code running with the same user permissions.

A sub-agent runs in its parent's cwd unless `cwd` is given. Spawn uses configured models rather than a model parameter; `config.json` under the host's state directory does:

```json
{
  "providerExtensions": ["~/.pi/agent/git/github.com/earendil-works/pi-claude-code"],
  "agentModel": { "provider": "claude-code", "modelId": "claude-opus-5-5" },
  "workerModel": { "provider": "openai-codex", "modelId": "gpt-6.1-sol" },
  "workerModels": { "review": { "provider": "claude-code", "modelId": "claude-opus-5-5", "thinking": "high" } }
}
```

A new worker uses the first `workerModels` rule whose key its name contains
(case-insensitive, e.g. `review` matches `review-auth` and `code-reviewer`), else
`workerModel`, else the parent's model. `thinking` is optional; without it the worker
follows the parent's thinking level.
`providerExtensions` lists Pi packages whose model providers the host loads (with Pi's
loader); only their providers are used, not their commands or tools.

Edit models with `/team models`: pick the top-level default, worker default or a name rule, then a model
from Pi's scoped models (`/scoped-models`; all available models when none are scoped)
(read live, so `/scoped-models` changes show up next time), then a thinking level,
then where that model compacts: a preset share of its context window (50–90%) or
Pi's default. That limit is Pi's own per-model setting
(`compaction.modelOverrides["provider/id"].reserveTokens` in `~/.pi/agent/settings.json`),
so the main session and workers on that model compact at the same point; `/reload`
applies it to an open session. The host reads worker models
on every spawn, so changes apply to the next worker without a restart. Running
workers keep their model unless the human changes it through the service's
`action(human, { action: "model", target, model: { provider, modelId }, thinking? }, requestId)`.
Like Pi's interactive `/model`, this uses `configure()` directly: the next model
request uses the new choice, including a continuation after tools in an active run.
Model selection and top-level creation are not exposed to agent tools.
`abort` cancels current work without disabling the agent; `stop`
disables it.

A missing config means no worker models (sub-agents use the parent's model); a malformed
config refuses startup or spawn. `providerExtensions` is read at host startup: restart
the host explicitly after changing it. The host runs as its own process, so a model
works for workers only if the host can reach it (credentials in Pi's `auth.json`, local
servers running); otherwise the spawn fails with "Unavailable model". Main-selected providers registered only by an in-process extension must
also be available to the standalone host through Pi's provider configuration.
There is no silent model fallback. No custom private HTTP dispatcher imports.

Workers have Durable's standard read/write/edit/bash plus `team`, NOT the entire
interactive Pi extension/tool runtime. At spawn, public resource loaders read
AGENTS.md/CLAUDE.md and global/project skills. Spawning never asks for confirmation,
for any cwd. Already-running workers keep their initial resource snapshot. No private
Pi prompt-builder imports or permanent per-directory resource cache.

## Hosted top-level agents (service API)

`openTeams().action(human, args, requestId)` is available for local service callers;
`HostSource` provides the human-client socket API used by `pi-agents`. `human` is
exported from `src/teams.ts`. Create with `{ action: "newAgent", name, cwd, model?, thinking? }`,
then send/inspect/control with the same actions as the team tool. Only the human
can create a top-level agent or change an agent's model. `newAgent` returns `{ id }`.
Hosted names are unique among hosted siblings; external Pi display names may
duplicate each other or hosted names and do not prevent reconnection.

Top-level models default to `agentModel`; without it, creation requires an explicit
model. No paid default is silently selected. The example above selects Claude Opus.
Sub-agent models retain the name-rule/default/parent fallback. Prompts include the
cwd's project instructions and skills, with a short identity/authorization preamble.
Reports to hosted senders are `teams.report` conversation inputs; reports to Pi
sessions enter their persisted inbox; nothing is posted back to the human, who
reads transcripts. External Pi sessions still select their own models in Pi.

## Architecture and persistence

- `extension.ts`: ordinary Pi lifecycle, tools, messages, and receipt handling.
- `client.ts`: local HTTP/NDJSON transport and lazy host startup.
- `host.ts` / `daemon.ts`: one process owns the Durable Harness and SQLite.
- `teams.ts`: one membership document, native conversations/inboxes, background
  anchor/reporter tasks, request deduplication and scope checks.
- `resources.ts`: public Pi configuration/resource APIs and standard coding tools.

The Durable root is **non-model control state only**. It owns background tasks;
we never feed it main transcripts or run a second main model.
Registry v2 stores one flat `agents` tree: the human is the implicit root, hosted
top-level agents and Pi sessions are its children, and sub-agents are grandchildren.
A team is a subtree, not a separate record. Hosted conversations are owned through
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
its name/context remains inspectable. Aborting a run instead leaves the agent enabled
and reports the unanswered submission to its sender. `/team stop` additionally pauses new
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

The reference main revision and npm 1.4.0 differ: released IDs are numeric branded
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
user `fleet` / `swarm` entry points with explanatory disabled stubs. It does not stop any process or alter source repos,
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
requires separate approval. The registry and in-flight reporter tasks migrate from v1 automatically on open.

## pi-agents

Run `node src/pi-agents.ts` to chat with agents in the host. The `pi-agents` bin
is a `.ts` file: use `npm link` from this repository to put it on your PATH.
Node does not strip TypeScript types under `node_modules`, so a regular package
installation is not supported yet. Closing the app leaves agents running.

Pi 1.4 does not export its live theme instance or the app `KeybindingsManager`
class (upstream export request). A single checked compatibility import loads the
theme; the app uses public TUI keybindings, so your `keybindings.json` is not
loaded yet.

- List: **↑↓** select, **Enter/→** open, **n** create, **r** rename, **d** remove (confirm with **y**), **q** quit, **x** disable (confirm with **y**).
- New agent: review the launch directory, suggested name and visible model/thinking
  defaults, then choose **Create agent**. Change any setting from review.
  The first chat message is the task.
  Folder picker: **↑↓** move, **→** enter folder, **←** parent, **Enter** choose,
  typing filters, **Backspace** edits, **Esc** returns to review. Recent directories appear first;
  paste an existing directory path to jump there. Wide terminals show a preview.
  Review: **↑↓/Enter** create or edit name, folder, model, or thinking.
  The name is suggested from the folder with a suffix when needed; it stays editable.
  Model defaults to the host's configured `agentModel`; if missing or unavailable,
  choose a model explicitly. Thinking uses its supported configured level, else medium
  if supported, else the first supported level.
  Model filtering matches `provider/modelId` or name, ignoring case.
  **Esc** returns from an edit to review, or cancels from review.
  Validation errors stay inline.
- Chat: **Enter** send/steer, **Alt+Enter** queue follow-up, **Esc** stop current run,
  **↓/Enter** on an empty editor select/open a sub-agent, **←** goes back
  to its parent or the list, **PgUp/PgDn** scroll.
- **/tree** opens Pi's session-tree selector, as does **Esc Esc** within 500 ms while idle with an empty editor
  (honours Pi's `doubleEscapeAction` setting). Selecting a user message restores its text in the editor;
  selecting another message continues from there. The agent keeps its ID, name and children. Previous branches
  remain navigable and usage totals include their spend. Navigation creates a Durable fork behind the same agent
  identity; it does not undo files or tool side effects. Branch summaries are not supported.
- **Ctrl+C** exits.

Remove is human-only (terminal **d**, web **⋮ → Remove**): it stops the agent and
its subtree and hides them everywhere, including agents’ `team` tool. History is
kept and names are reusable. External Pi sessions cannot be removed. Human
interfaces show durable agents only, with no toggle.

Preview without touching the live host: `npm run screen -- small` (`narrow` or `wide`
also work). These scenarios use a temporary host and faux model, as do `test/app.test.ts`.

## Phone access

Enable the loopback API in `~/.pi/agent/durable-teams/config.json` (or your
`PI_TEAMS_DIR`) and restart the host:

```json
{ "remote": { "port": 8787 } }
```

Run `pi-agents pair` to print the pairing URL and, if `qrencode` is installed, a QR
code. Run the suggested `tailscale serve --bg 8787` command (`--https=8443` if port 443 is taken on the Mac) yourself to expose it
with tailnet HTTPS. Without Tailscale the URL falls back to localhost.
`pi-agents pair --rotate` revokes the old token and closes remote streams within one second.
The host polls token-file metadata once per second, reloads only changes, and destroys remote
streams when credentials change; requests and frame writes never create credentials.
API routes require a Bearer header. The web app's static files are public (they hold no agent data),
so Chrome can install the app; the page keeps the pairing token on the phone.
Folder listings require absolute paths; macOS privacy restrictions may return EPERM.

Treat the pairing URL as a secret: the API requires its token even on your tailnet.
Open the pairing URL on your phone in Chrome to use the web app. In Chrome's menu,
choose **Install app** (sometimes under **Add to Home screen**) to install Pi Agents.
Launch the installed app for a standalone window without an address bar. The app keeps the token on that
phone and removes it from the address bar. You can read chats, use `/tree` or **Rewind here** on a message, send or steer messages,
stop agents, and create agents with a folder, model and thinking level. Creation opens
on review using the most recent top-level agent’s folder; if none exists, choose a
folder first. The browser never silently uses the host process’s working directory.
The shell is available offline; agent data and actions always require the host.


Enable **Notify when agents finish** in the list header and allow notifications.
Only top-level hosted agents going from running to idle notify; tapping an alert opens
that agent's chat. Turn the toggle off to remove the subscription from both host and phone.
If permission is denied, allow notifications in the browser's site settings and try again.
Brave needs **Use Google services for push messaging** enabled in its settings.

Web Push requires HTTPS (or localhost for development) and host access to the browser's
push service. It works without keeping the app or a roster connection open. The host stores
stable VAPID keys and endpoint-keyed subscriptions in private, atomically written `push.json`
in its state directory. Notifications contain only agent name, model and duration, never
transcript text; push-service HTTP 404/410 responses remove expired subscriptions.
