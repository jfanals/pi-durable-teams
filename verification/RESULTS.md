# Implementation and cutover — 2026-10-20

## Delivered

Standalone package: `/Users/kulupu/Desktop/src/pi-durable-teams`.
Pi/Durable dependencies pinned to 1.3.0; upstream pattern/reference and deliberate
local additions are documented in README.md. No commits, paid calls, real-model
workers, visible agent tabs, or legacy process termination were performed.

- One `team` tool, persistent workers, scoped peer/cross-main communication.
- Upstream background anchor/reporter tasks, native queues and event streams.
- Ordinary Pi receipt bridge, reconnect/dedup and explicit team pause/stop.
- Project trust, public resource loading, model/provider restrictions.
- Paged persisted transcripts and bounded human live watch.

## Final verification

- `npm run check`: passed (strict TypeScript, unused-symbol and erasable-syntax checks).
- `npm test`: **16 passed, 0 failures/skips/cancellations**. See local `test.log`.
- `npm audit --omit=dev --audit-level=high`: **0 vulnerabilities**.
- Actual package discovery/Jiti: one team tool, canonical skill, no extension errors.
- `pi list`: new package configured; legacy Pi launcher/control packages absent.
- `fleet` and `swarm`: disabled stubs return exit 1; original wrappers archived.
- No fixture worker-host processes left running after tests.
- RevenueHunt `git diff --check`: passed.

Development checks caught and corrected release/main API differences, a TypeBox
mapped-union inferred as `never`, a non-erasable constructor parameter property,
and a transaction draft escaping its commit (`Cannot use a settled overlay`).
Tests now cover those paths. Review also corrected NDJSON backpressure for large
frames, transcript-scoped tool request IDs, and settings-relative resource loading.

This was a single-agent implementation and self-review, not an independent review.
Live Codex/provider authentication/streaming, real-model task quality, and visual
TUI appearance remain unverified. A paid smoke test requires approval.

## Cutover

Backup/manifest:
`/Users/kulupu/.pi/agent/retired-delegation/2026-10-20T07-27-04.139Z/`

Archived legacy Pi skills (Fleet, SwarmForge, super-manager), the shared Claude
Fleet skill link, and user Fleet/Swarm command wrappers. Original global settings,
post-migration settings and moved-path manifest are in that directory. Existing
provider policy remains `openai-codex` only. README describes rollback.

RevenueHunt AGENTS.md now routes all delegation to the canonical package/skill.
No leaf-repo SwarmForge sources, old databases/transcripts, worktrees, source repos,
or launch records were removed. General cmux/browser/review/goal-loop tools remain.

The old Fleet daemon PID **19837** was observed still running and deliberately left
untouched. Existing Pi sessions retain already-loaded legacy tools until reload or
restart. This session has not been reloaded. The new production host has not been
started; only config.json exists in its state directory. `/reload` or restart Pi
activates the extension; `/team list` confirms registration without delegating work.

Ordinary Pi main execution is not made durable; receipt means message persisted,
not acted upon. New workers are not a sandbox. Read README/skill for exact limits.
