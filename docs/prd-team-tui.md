# Durable Teams: a calm conversation, an inspectable team

**Status:** proposal for discussion, not approved for implementation.  
**Date:** 23 October 2026.  
**Scope:** improve the existing Pi extension’s presentation and human controls; retain its Durable host and execution semantics.

## Recommendation

Build **compact message cards + a quiet team dock + an on-demand Team view**. The main conversation stays the primary workspace. Open the Team view only when you want to inspect or guide a worker. At wide terminal sizes it is a roster beside a conversation; at narrow sizes it becomes a list → detail flow.

Do not build another agent runtime, replace Pi’s editor, or make every report a large chat message. Start with the message cards: they solve the most visible problem without touching delivery behavior.

### The experience in one sentence

> I always know who is working and who sent a message; I can enter any of my workers’ conversations, understand their activity, and guide them without losing my place in the main session.

“Enter” means an interactive **inspector and message composer**, not attaching a second ordinary Pi TUI to a Durable conversation. Our workers do not run the full parent extension runtime.

**Visual companion:** [three-screen interface concept](team-tui-concept.html), covering the main conversation, wide inspector, and narrow-terminal detail view. It is an illustrative browser mockup with no backend controls, not a validated terminal implementation.

## 1. What is wrong today?

The present implementation has useful backend primitives, but exposes them as diagnostics:

| Current behavior | Human cost | Proposed change |
|---|---|---|
| Generic `Team message` heading followed by `[name (id); request …]` | Sender and intent are hard to scan | Name-first card; technical IDs in expanded metadata |
| Full reports and repeated “No acknowledgement is needed…” instructions appear as conversation text | The main discussion is buried in transport/agent instructions | Compact literal excerpt; full Markdown on expansion; model-only instruction omitted from normal display |
| Messages from different teams look alike | Unclear whether this is our worker or another main | Explicit `Our team` / `Other session` source label |
| `team` tool results render as JSON | Routine sends, inspection, and list calls feel technical | Action-specific tool renderers; full raw result remains available |
| `/team list` shows a JSON notification | No navigable roster | Team view with stable selection |
| `/team watch` renders a sliced JSON string | Hard to follow tool activity; potentially loses useful structure | Formatted activity and transcript, with a clear live/history boundary |
| `/team log` exports JSON | Reading a worker requires leaving the flow | In-terminal paginated conversation; export remains a fallback |

**Existing foundations:** custom-message renderer, structured `Delivery` metadata, authenticated list/inspect/send/stop operations, request-specific results, transcript pagination, snapshot/event watch streams, and persisted delivery receipts.

## 2. Product principles

1. **The main conversation is not a log dashboard.** Keep routine team traffic short, attributable, and expandable.
2. **Progressive disclosure.** Identity and useful text first; tools, thinking, IDs, raw events, and usage details on demand.
3. **Truthful state.** Idle is not successful completion; accepted is not read; offline is not failed; inspecting is not acknowledging.
4. **Human controls act directly.** Opening, reading, and sending guidance should not require an LLM intermediary.
5. **One backend, one source of truth.** Use real Durable transcripts and committed state, not a mirrored worker conversation database.
6. **Native Pi, not a dashboard bolted on top.** Use its theme, components, width utilities, focus handling, and keybindings.
7. **Quiet never means hidden.** Full original content, provenance, errors, and delivery state remain accessible.

## 3. Interface options

| Option | Shape | Strength | Cost / limitation | Decision |
|---|---|---|---|---|
| **A. Conversation-first** | Better cards and readable commands; no persistent roster | Small, low-risk change; immediate improvement | Still awkward to move among several workers | Ship first as the foundation |
| **B. Dock + on-demand Team view** | One/two-line dock; keyboard-opened roster/conversation inspector | Best balance of awareness, control, and screen space | Requires a focused custom component and a small UI data adapter | **Recommended destination** |
| **C. Always-open split workspace** | Permanent team sidebar and selected worker pane beside the main | Maximum simultaneous visibility | Crowded in normal terminals; focus and layout ownership are harder; likely more coupling to Pi | Defer; test whether B is insufficient |

A separate tmux/cmux worker terminal is **not** just another layout for our current backend. Providing a full ordinary Pi child session would be a runtime decision. A future read-only detached inspector is possible, but is not needed for this PRD.

## 4. Proposed screens

Wireframes show intended behavior, not screenshots of existing functionality. Wording and key choices are provisional.

### 4.1 Main conversation: message cards

```text
You
What are our options for the authentication change?

╭─ compare-ui · Our team ──────────────────────────────────────╮
│ Read-only research completed; no repository changes.         │
│ Hub has a roster/detail view and live steering.              │
│ … more content                                              │
╰─ Ctrl+O expand · /team open compare-ui ──────────────────────╯

╭─ Billing investigation · Other session ──────────────────────╮
│ The billing callback appears unrelated to this change.       │
╰─ Ctrl+O expand · /team inbox ────────────────────────────────╯

Assistant
Here is how those findings affect the plan…

Team · 2 running · 1 idle · 2 new messages       /team
> Main prompt remains unchanged
```

**Card behavior**

- Default: sender, source, at most three wrapped lines of literal body excerpt, and an expansion hint. Bound the total height, including long headings/paths.
- Expanded: full Markdown, with a collapsed raw/metadata fallback for debugging. Full tables/code are never discarded because their preview was short.
- Preview text is not an LLM summary. Select the first useful nonempty body lines deterministically; indicate truncation. Do not label the excerpt “summary” or manufacture a conclusion.
- Normal display uses `Delivery.from` and `Delivery.text`, not a regex that strips arbitrary user-authored instructions. The original model-facing content and no-acknowledgement instruction stay intact.
- If legacy or malformed details are missing, show a generic team card with the complete original content accessible. Do not silently drop it.
- Until structured request status is available, call the card a **message**, not “completed,” “success,” or “needs attention.” A sender having a `request` field alone is not success evidence.
- Technical IDs, request IDs, and delivery mode appear in expanded metadata, not the primary heading.
- `Ctrl+O` follows Pi’s existing expansion behavior; do not pretend it is a new per-card focus shortcut. Command hints are real commands, not decorative clickable buttons.
- Initially preserve one visible card per persisted delivery. Do not batch, suppress, reorder, or auto-dismiss deliveries. A collapsed inbox is a later optional presentation improvement.
- No acknowledgement-only assistant responses should be introduced. Existing model instructions remain; appearance work alone cannot guarantee that a model never emits one.

### 4.2 Quiet dock

A single compact row near the editor, rising to two rows only when a connection/action problem needs explanation.

```text
Team · 2 running · 1 idle · 2 new messages                 /team
```

- Hide when the session has no team activity; do not dedicate five rows to an empty roster.
- Use text plus restrained semantic colors, not constant spinners, flashing notifications, or a separate identity color for every worker.
- `new messages` means **not yet viewed in the Team inbox**, not “unread by the main model.” The dock must label this distinction in help.
- Counts need authoritative inputs. If status freshness is unknown, show `3 workers · status not refreshed`, not invented running/idle counts.
- Phase-one fallback: retain the existing connection status and skip the dock. A roster widget should not require permanent watch streams to every worker.
- Do not hijack arrows in the main editor. `/team` is the discoverable entry; an optional configurable shortcut can follow after checking collisions.

### 4.3 Team view: wide layout

```text
Team · Current session                         Host connected
┌──────────────────────┬──────────────────────────────────────┐
│ OUR WORKERS          │ reader · Running · read src/auth.ts   │
│ > reader    running  │ Model: inherited selection            │
│   reviewer  idle     │                                      │
│   scout     stopped  │ You → reader · Follow-up              │
│                      │ Find the authentication entry points. │
│ MESSAGES       2 new │                                      │
│ OTHER SESSIONS       │ reader                                │
│                      │ The relevant path is src/auth.ts…     │
│                      │                                      │
│                      │ ▸ read src/auth.ts:1–120              │
│                      │ ▸ bash: rg 'callback' src             │
├──────────────────────┴──────────────────────────────────────┤
│ ↑↓ select · Tab focus · Enter inspect · s message · Esc back │
└─────────────────────────────────────────────────────────────┘
```

- Roster selection changes only on deliberate input. A new result must not steal focus or reshuffle the row under the cursor. Use stable worker IDs internally, names for display.
- Detail opens at the latest activity. Scrolling up disables follow-live and shows `New activity ↓`; an explicit action returns to live. Never yank the user to the bottom.
- Render user/peer messages, assistant Markdown, tool calls/results, errors, and available thinking blocks distinctly. Thinking is collapsed by default and only displayed if supplied by the provider/runtime.
- Show the full task/prompt on demand. Pair tool calls with their results using real IDs; show pending/interrupted/unknown when a matching result is unavailable.
- Older transcript pages load on demand. Keep the viewport anchored during prepend and allow raw inspection of unfamiliar entry kinds.
- First implementation may use a full-area custom screen. A centered overlay/fullscreen toggle is optional, not a prerequisite.
- On small terminals, show a roster page followed by a detail page. No horizontal scrolling is required to reach a worker or message composer.

### 4.4 Worker composer

```text
Message to reader · Our team
Mode: Follow-up ▾
  Queues after the current work finishes.

> Also check the callback route. Do not edit files.

Send: configured submit key       Esc: cancel / return
```

- Show the target prominently; there is no ambiguous “global” composer.
- Default to **Follow-up**. Offer **Steer** explicitly: `Delivered at the next worker tool boundary; does not cancel the tool in flight.`
- On an idle, enabled worker, a message can start new work. Say so before send. A stopped worker cannot be resumed by sending; `/team resume` only re-enables delegation.
- Use Pi’s editor component and keybindings; preserve multiline editing and IME support. Final submission keys are determined by the feasibility spike, not hard-coded in this PRD.
- After submission show **Accepted / queued**, with the actual returned request identifier available in metadata. Do not show “read” or “applied” without evidence.
- Preserve the draft on failure. Do not automatically retry a timed-out mutation using a new request ID: it may already have been accepted.
- Human-origin sends use the existing authenticated action path and stable request IDs, without asking the main model to issue a tool call. Their resulting worker report still reaches the ordinary main through the existing reporter mechanism. No separate human-only result inbox is introduced.
- The UI must record the outgoing message/target/mode and receipt for later human inspection using existing transcript data or minimal non-model UI entries. Do not fabricate assistant tool-call entries or duplicate the prompt into main model context.

### 4.5 Inbox and other sessions

- `Messages` lists real persisted incoming deliveries, with source, excerpt, and view state. Selecting one opens its full body and metadata. Replies use the same target-aware composer.
- Other mains appear under **Other sessions**, with connected/offline and the explicit qualification `latest published message; may be stale`.
- Other sessions are not our workers. Offer message and published-summary inspection, **not** stop controls or access to their worker transcripts.
- Do not generate notifications for every worker-to-worker exchange. Relevant peer messages remain inspectable in the worker conversation; main inbox contains deliveries actually addressed to it.
- MVP can use session-local “new” indicators. Durable viewed markers are a later small `appendEntry` addition if reopen behavior warrants it. They are independent from transport receipt acknowledgements.

## 5. Status language: use evidence, not optimism

Keep **worker activity**, **request outcome**, **message delivery**, and **connection freshness** separate.

| Evidence | UI wording | Never infer |
|---|---|---|
| Committed live run/tool activity | Running / tool name | Which business task succeeded |
| Enabled worker with no active run | Idle | Completed successfully |
| Worker disabled | Stopped | Files, shell side effects, or worktrees were undone |
| Specific request has settled answer/outcome | Request answered / failed / stopped, using available outcome | Latest assistant text is necessarily the final answer |
| Submission acknowledged by host | Accepted / queued | Read, understood, or acted on |
| Delivery persisted in main history | Saved in this session | Human viewed it or main processed it |
| Main registered without current event connection | Offline / last publication | Failed or safely stopped |
| Lost watch/host connection | Stale · reconnecting | Worker execution stopped |

Do not create a `blocked / needs your answer` status by classifying prose. A future explicit human-input protocol can supply it; until then show the actual error or message.

## 6. Scope and priorities

### P0 — coherent daily experience

- Compact attributed Markdown message cards, plus action-specific `team` call/result rendering.
- `/team` opens a navigable local roster; `/team open <worker>` opens its inspector.
- Full selected-worker transcript and current committed activity; older pages on demand.
- Direct human follow-up/steering with target, mode, accepted receipt, and draft-preserving errors.
- Deliberate single-worker stop with confirmation. Whole-team stop retains the existing explicit confirmation and wording.
- Narrow-terminal layout, correct keyboard focus, dark/light themes, reload/session-switch cleanup.
- No changes to delivery order, turn triggering, acknowledgement semantics, provider policy, trust rules, or worker execution.

### P1 — polish after the core interaction works

- Quiet dock with honest freshness/counts; inbox/new indicators; other-main browsing.
- Per-worker scroll/selection restoration, result filtering, request outcome/history, usage details when available.
- Fullscreen/overlay toggle, configurable entry shortcut, optional pinned watch.
- Persist viewed markers only if session-local indicators prove confusing.

### Not in scope

Worktree automation, automatic commits/merges, nested agents, new roles, workflow scheduling, model routing, automatic restarts beyond current behavior, a second mailbox database, a browser dashboard, full ordinary Pi child-session attachment, or blanket exactly-once claims.

## 7. Implementation options and recommended path

### Option 1: extend the existing extension — recommended

Use `registerMessageRenderer`, tool `renderCall`/`renderResult`, `setWidget`, and `ctx.ui.custom()` over the existing `Client`.

```text
Pi session / custom message renderer / team tool renderer
                       │
             Team view + message composer
                       │
             small read-only UI projection
                       │
       existing authenticated Client → Durable host
                       │
     real workers, transcripts, requests, deliveries
```

The projection turns snapshots/events into display data; it is not another runtime or source of task truth. Start with a renderer module and a Team-view component; extract adapters only when real duplication appears. Avoid introducing a general plugin architecture.

**Initial data path:** list own workers, inspect them with bounded concurrency while the view is open, and attach one existing `/watch` stream to the selected worker. Fetch transcript pages through existing `inspect(transcript: true)`. Verify event ordering and the snapshot/history boundary against the pinned Durable API before implementing deduplication; do not guess from JSON shapes.

**Roster freshness:** current `list` has names/enabled flags, not complete running states. Initially refresh on open, after our actions, and on explicit refresh; mark non-selected observations stale as needed. If measurements show that this is inadequate, add a small authenticated read-only roster snapshot with committed status. Do not keep N full transcript subscriptions alive merely to draw N icons.

**Rendering:** reuse Pi `Markdown`, `ScrollView`, `SelectList`, `Editor`, theme/keybinding and visible-width utilities. Prefer simple tool name + args/result blocks first. Reusing Pi’s ordinary built-in tool renderers for Durable entries requires a separate compatibility check; do not depend on private main-session UI classes.

**Why:** preserves the backend behavior we already own, offers native presentation, and does not add a terminal/pane dependency.

### Option 2: adapt a third-party Hub UI

Borrow interaction patterns and, where licensing and API boundaries allow, small components from Hub/Community. Their renderers and controllers assume their own agent/session models; no interchangeable frontend adapter has been established.

**Use when:** a short feasibility spike demonstrates genuinely reusable components without importing their scheduler/runtime.

**Reject when:** integration means adopting another agent manager, mirrored sessions, or a large compatibility layer. Reusing the roster/detail pattern is preferable to vendoring an entire fork.

### Option 3: standalone terminal inspector

A separate read-only TUI client connects to the existing host, potentially in a pane. It can survive UI navigation independently and provides more screen space.

**Trade-off:** another executable, focus context, and lifecycle to maintain. Never open the same ordinary Pi session concurrently to get a second view. A full interactive child Pi session is a separate architecture change.

**Decision:** defer unless the in-session view proves too constrained.

## 8. Delivery phases

| Phase | Reviewable outcome | Backend impact |
|---|---|---|
| **0. Validate the interaction** | Static narrow/wide designs; verify busy-main custom-view behavior, input focus, event shapes, renderer API on installed Pi 1.4.0 and repo-pinned 1.3.0 | None |
| **1. Clean the conversation** | Sender-first cards, hidden visual boilerplate, full expansion, readable tool results | None; preserve all model-facing content and delivery mechanics |
| **2. Inspect workers** | `/team`, list/detail, history paging, selected watch, truthful stale state | Reuse current APIs first |
| **3. Guide and stop** | Direct human composer, receipts, stop confirmation, recoverable UI errors | Existing actions; minimal UI audit entries if needed |
| **4. Add awareness** | Dock, inbox/view markers, optional roster optimization | Small read-only endpoint only if justified |

Phase 1 can ship alone. Do not delay fixing message presentation until every panel exists.

## 9. Correctness and lifecycle constraints

- **Delivery invariant:** acknowledge host delivery only after it is persisted in Pi session history. Merely rendering, opening the inbox, or marking viewed must not acknowledge it.
- **Context invariant:** watch events and UI navigation stay out of main model context. Preserve full report content and existing `triggerTurn` / steer / follow-up behavior. Quiet mode that changes model activation is a separate product decision.
- **No duplicate mutation:** a send keeps one stable ID across an explicit retry while the draft is unchanged; keep uncertain outcomes visible rather than silently resending.
- **Scope invariant:** current authenticated main controls only its own workers; cross-main messaging remains within existing permissions. UI navigation never broadens host authorization.
- **Lifecycle invariant:** close view subscriptions on exit, reload, session switch, and shutdown. Late frames must not update another session’s view. Closing the view does not stop workers.
- **Non-TUI modes:** tools and delivery keep working in print/JSON/RPC. Custom terminal components are guarded by `ctx.mode === "tui"`.
- **Sensitive data:** transcripts may contain private tool output. Sanitize unsafe terminal control sequences while retaining the text; do not create public exports, secondary logs, or telemetry by default.
- **Source of truth:** use real entry/request/delivery IDs for matching and deduplication. Do not use text equality or invent ordering across unrelated streams.

## 10. Acceptance criteria

### Human experience

- [ ] A multi-page report occupies a bounded card in its collapsed state; full text/tables/code remain available on expansion.
- [ ] From the main session, reach a chosen worker in at most one command plus selection. Returning restores the main draft and focus.
- [ ] At 80×24, all essential controls remain keyboard-accessible; at 120×30, roster/detail can appear side by side. At 60×20, use a compact page flow without clipping actions.
- [ ] Adding messages or status updates never changes selection, steals focus, or forces a scrolled transcript to the bottom.
- [ ] Composer clearly identifies the target and mode; an error preserves the draft; acceptance is never labelled “read.”
- [ ] Reading/navigating a worker causes zero model requests. Direct send causes only the authorized worker work and existing report/main behavior—not an extra main-tool request to dispatch it.

### Regression and failure boundaries

- [ ] Persist-before-ack and reconnect deduplication tests remain unchanged/passing, including the queued-but-not-persisted window.
- [ ] A stopped worker, failed request, idle worker, offline main, and disconnected host have distinct truthful displays.
- [ ] Snapshot/event replay, repeated frames, older-page prepend, empty histories, missing tool results, and unfamiliar entry kinds do not duplicate or lose displayed messages.
- [ ] Reload/switch/view-close disposes subscriptions; no second connected main is created for an inspector.
- [ ] Human send timeout/retry does not duplicate a request. Stop cancellation, whole-team confirmation, and stopped-worker behavior match the backend.
- [ ] Unicode/wide characters, long paths, ANSI control content, resize, light/dark themes, multiline drafts, and IME focus are covered.
- [ ] Non-interactive tests confirm unchanged tool/report behavior with no custom TUI assumptions.

Use deterministic fixtures and integration tests for real delivery/stream boundaries. Test observable navigation and message behavior, not just private component snapshots. Manually verify the final TUI in both regular and fullscreen Pi modes; a browser sketch is not terminal validation.

## 11. Decisions to discuss

1. **Is the dock always present during team activity, or only when a new message/error exists?** Recommendation: one line during activity; hide when unused.
2. **Do you want routine incoming messages visible as compact cards, or only in an inbox?** Recommendation: cards first, preserving current delivery/activation behavior; optional quieter presentation later.
3. **Does “enter a worker” mean inspect + message, or the full Pi editor/tool environment?** Recommendation: inspector + composer for this iteration; full child Pi sessions are not a cosmetic enhancement.
4. **How much terminal space should opening the Team view take?** Recommendation: full interactive area first, adaptive list/detail; overlay toggle later.

## Source map

| Existing file / reference | Relevance |
|---|---|
| `src/extension.ts` | Receive/render, tool results, commands, watches, persist-before-ack behavior |
| `src/protocol.ts` | Current `Delivery` fields; no semantic kind, creation time, or read status |
| `src/teams.ts` | Scope, request outcomes, paging, Durable watch, send/stop rules |
| `src/host.ts` | Connection distinction, authenticated operations, watch backpressure |
| `test/extension.test.ts`, `test/queued-delivery.test.ts`, `test/host.test.ts` | Existing reliability boundaries to preserve |
| `README.md` | Intended execution/persistence limits |
| Installed Pi `docs/extensions.md`, `docs/tui.md`; `examples/extensions/message-renderer.ts`, `overlay-test.ts` | Public UI integration points and lifecycle/focus contracts |

No runtime code or extension settings were changed for this PRD. The repository already contained untracked project files before this document was added; do not treat those as changes belonging to this proposal.
