# PRD: Reduce durable-teams host CPU spent on status refreshes

Status: proposed; implementation not started by this investigation.
Audience: implementation agent working in `~/Desktop/src/pi-durable-teams-dev`.

## Objective

Remove transcript-sized work from routine agent status and chat refreshes without changing their observable behavior. Start with the smallest change; measure before adding shared caches or more orchestration.

## Operating constraints

- Read this repository's `AGENTS.md` before working.
- Develop only in `~/Desktop/src/pi-durable-teams-dev`. The sibling `pi-durable-teams` checkout runs the live host; never edit it directly.
- Do not restart, kill, or signal the live host, or modify its runtime files/databases under `~/.pi/agent/durable-teams/`.
- Use a throwaway development host and synthetic data for profiling and tests.
- This document is a handoff, not authorization to release, restart, commit, or push. Ask the human for any required authorization.
- Other work is in progress in dev, including edits to `src/teams.ts`. Inspect the current diff, preserve unrelated changes, and coordinate with its owner.

## Evidence

Observed on 2026-10-28, live host PID 53895, live checkout commit `f4d0ac4`:

- CPU snapshots: 77–105% (100% is one logical core).
- Native process sample: substantial JSON parsing inside timer-driven promise work.
- One read-only `/agents` request: 5.96 seconds for an 8.8 KB response containing 16 agents, five running. This is an end-to-end observation under live load, not an isolated benchmark.
- Physical memory footprint around 1 GB. This does not establish a leak.
- Both live and dev contained the expensive refresh paths when reviewed.

The sample does not resolve JavaScript function names. Source inspection strongly supports the refresh path below as a major contributor; confirm the attribution and improvement on an isolated fixture.

Artifacts from the investigation (temporary; may disappear):
- `/tmp/revenuehunt-host-sample.txt`
- `/tmp/revenuehunt-host-roster.json`

## Current behavior and likely cause

Line numbers below refer to the reviewed live commit; locate functions by name in current dev.

1. `src/teams.ts:579`: every harness commit queues subscriber notifications.
2. `src/host.ts:123–153`: each `/agents/roster` connection independently schedules a refresh after a 25 ms coalesce delay.
3. `src/teams.ts:780–795`: `agents()` invokes human `inspect` for every hosted, non-removed agent, including idle agents.
4. `src/teams.ts:384–394`: `inspect` obtains `conversation.viewState()`, flattens the active transcript's model messages to locate the latest assistant/user messages, then disposes the view.
5. Dependency `@earendil-works/pi-durable/dist/harness/view.js`: the last observer's detach removes the view mount. A later attachment without another observer rebuilds it using `activeEntries`.
6. `dist/harness/context.js:189–209`: rebuilding scans the active transcript in pages; SQLite storage parses each entry's JSON.

Streaming generation can publish progress around every 100 ms. Each connected roster client can consequently repeat this work. Comparing serialized roster output afterward saves network writes, not the computation.

Additional duplication:
- `src/push.ts`, `watchPush`: independently calls `agents()` on commits when push subscriptions are active.
- `src/source.ts`, `workerSource.status`: obtains the entire roster to find one agent.
- `src/extension.ts`: periodically inspects workers while work is running.
- `src/teams.ts`, `page()`: builds a full view just to read `pi.inbox`, despite already fetching a transcript page.

## Scope: first implementation

### A. Remove full-view hydration from routine inspection

Replace `inspect`'s use of `conversation.viewState()` with the narrow reads actually needed:

- Read configured agent and live status using the existing `harness.snapshot(AgentDoc/LiveDoc, conversationId, context)` APIs.
- Keep existing usage aggregation, including retained branches.
- Retrieve or maintain the latest assistant message and latest user timestamp without rebuilding the entire active transcript on every refresh.
- Preserve the response shape and all status fields consumed by `liveStatus`.

Choose the simplest correct approach after inspecting upstream APIs. Descending entry pagination is a candidate, not an approved algorithm. A small first page is useful, but must not silently truncate a valid search. If measurements show repeated historical scans remain expensive, consider an incremental in-memory summary invalidated by relevant publications, with a correct cold-start path.

### B. Read the inbox directly in chat pagination

In `page()`, use `harness.snapshot(InboxDoc, conversationId, context)` instead of mounting the whole view to read queued items. Preserve ordering, filtering, and returned shape.

Do not expand the first patch into unrelated UI, prompt, tool, scheduling, storage-schema, or dependency changes.

## Correctness requirements

Treat the existing implementation as a behavioral oracle on immutable fixtures.

- Preserve latest assistant selection, latest user timestamp, model/thinking information, live activity, usage, and queued-message behavior.
- Respect active-context boundaries after reset and compaction. Raw conversation history is not equivalent to the active entries exposed by `viewState()`.
- Inspect upstream head-marker semantics before implementing a scan: a marker can reference earlier retained entries. Simply stopping at a marker or taking a fixed number of rows is not automatically equivalent.
- Cover forked conversations and retained branches; do not double-count usage.
- Handle empty conversations, missing user/assistant messages, multiple model messages in one entry, and tool-heavy tails longer than a page.
- Do not scan the whole transcript repeatedly just because a user or assistant message is absent. Establish a correct termination or reuse strategy.
- Preserve safe behavior under concurrent commits. Understand any consistency difference between a coherent view and separate document/entry reads; use existing supported primitives rather than inventing a transaction layer.
- Preserve cancellation, removal, watch cleanup, and error behavior for touched paths.

## Possible follow-up scope, only if measurements justify it

1. Share one roster computation across roster streams and active push observation, rather than recomputing per subscriber.
2. Reuse status rows for conversations unaffected by a publication. Include registry, branch, model, usage, reset, and removal changes in invalidation rules.
3. Avoid whole-roster reads when a chat inspector needs one agent's status.
4. Consider a roughly 250 ms roster refresh cadence. Increasing the delay alone is not the root fix, and must not delay important transitions unnecessarily.

Do not retain every full transcript indefinitely as a CPU workaround; this trades repeated parsing for potentially substantial memory retention.

## Verification plan

1. Establish an isolated before/after fixture using the documented throwaway dev host (`node scripts/dev-host.ts 8796`) or existing test harness. Inspect its fixture/model behavior first; keep live state untouched.
2. Include a long, tool-heavy transcript; several idle agents plus one streaming agent; and one versus multiple observers. Use exactly the same fixture for comparisons.
3. Measure warm and cold `/agents` latency, process CPU over a fixed interval, and transcript entry-read counts or bytes parsed. Include chat-page refresh measurements for B.
4. Add behavioral equivalence tests for the correctness cases above. Prefer returned behavior and storage-read boundaries over private helper tests.
5. Run `npm run check` and relevant tests using repository instructions. Report precisely what ran and any unrelated failures.

## Acceptance criteria

- Normal warm status refreshes do not hydrate every agent's full active transcript.
- Chat `page()` does not load the full transcript merely to obtain inbox state.
- Increasing unchanged historical transcript length does not proportionally increase routine warm status-refresh work. If a cold scan is necessary, document it and demonstrate reuse afterward.
- Existing status/chat output semantics remain equivalent across the boundary fixtures, including compaction/reset/fork cases.
- A reproducible before/after benchmark demonstrates materially reduced CPU and latency under streaming load. Report actual numbers; do not promise a specific speedup from the live 5.96-second observation.
- No unacceptable retained-memory growth or leaked observers are introduced.
- No live checkout or runtime state is changed by implementation/testing.

## Deliverable

Provide a focused dev-checkout diff, tests, benchmark method and results, and any residual bottlenecks. Stop after the smallest effective patch. Explain whether follow-up scope is still warranted. Deployment of host changes requires an authorized release and host restart; do neither as part of this handoff without explicit human authorization.
