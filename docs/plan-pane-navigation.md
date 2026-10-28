# Plan: pane navigation (terminal and web)

Mock: `docs/pane-navigation-mock.html`. Navigation stays a stack (dashboard → main agent → sub-agent);
back always closes the top pane. Width decides how many panes under the active one stay visible as
narrow, read-only columns ("rails"). No host changes, no new state: rails render the roster both
clients already receive.

## Behaviour (both clients)

| Width | Terminal | Web | Dashboard | Main open | Sub-agent open |
|---|---|---|---|---|---|
| Narrow | < 80 cols | < 700px | full | main only | sub only |
| Medium | 80–139 cols | 700–1099px | full | dash rail + main | dash rail + sub |
| Wide | ≥ 140 cols | ≥ 1100px | full | dash rail + main | dash rail + main rail + sub |

- Dashboard rail ≈ 16% (terminal: clamp 18–28 cols), main rail ≈ 18% (clamp 18–30 cols).
- Rails are mouse/touch targets, never keyboard focus: the active pane keeps all keys as today.
  Clicking a rail's header collapses to it; clicking a row in a rail opens that agent.
- When a pane under the active one is hidden, the active pane shows the path
  `pi-agents › auth-review › scout` (web: tappable, with ‹ back; terminal: in the footer).
- Keys, unchanged: ← on an empty prompt goes back; ↓ enters the team list; enter/→ opens.
  New: alt+1 dashboard, alt+2 main agent (when a sub-agent is open).
  Not carried over from the mock: alt+← (Pi's editor uses it for word-left).

## Terminal (`src/app.ts`, `src/ui.ts`)

1. **Rails** (`src/ui.ts`, ~60 lines): `DashboardRail` and `MainRail` components. Rows reuse
   `statusRow` at rail width (it already drops model, cost and activity when narrow) plus the open
   agent's highlight; `MainRail` adds the main's activity line. Each wraps in `MouseRegion`
   (as `ClickToExpand` does) and calls back `collapseTo(depth)` / `open(agent)`. A 1-col `│`
   separator between columns.
2. **Layout** (`AgentsApp.setScreen`): when an agent is open, the layout root becomes
   `HStack([dashRail, mainRail?, view.layout])`. Rails use fixed `basis` + `grow: 0` and the
   stack's `visible(viewport)` for the 80/140 breakpoints, so resizing needs no extra code; the chat
   gets `grow: 1`. Rail widths depend on terminal width, so they are recomputed when the HStack is
   built and on resize (`tui.terminal.columns`).
3. **Navigation**: `stack` already holds the path. Add `collapseTo(depth)` (shared by rail clicks
   and alt+1/alt+2), reusing `back()`'s logic: reopen the parent's `ChatView` and focus the child
   row, or return to the list. The main agent's transcript is not kept alive while a sub-agent is
   open, as today; its rail only needs roster data.
4. **Path when hidden**: below 80 cols (or the main hidden at medium), the footer hint line starts
   with the path instead of only the agent name. No extra rows.
5. **Unchanged**: new-agent form, rename, delete confirmation, pickers (`/model`, `/tree`) stay
   full-screen or inside the active pane; cmux title and branch loading as today.

Checks: text selection and copy-on-select must stay inside the transcript column (selection is
anchored to the scroll view, so it should; verify). alt+1/alt+2 need the terminal's Option-as-Alt
on macOS (Ghostty, iTerm2); without it Option+1 types `¡`, so rail clicks and ← remain the
reliable path.

Tests (`test/testing/app-scenario.ts`, `test/app.test.ts`): at 60, 100 and 140 cols, open a main
and a sub-agent and assert which rails render; click a rail header (SGR mouse sequence) and assert
the collapse; ← and alt+1 behaviour. Add `wide-sub` to `scripts/screen.ts` for eyeballing.

## Web (`src/web/main.ts`, `src/web/app.css`)

1. **Markup**: the chat screen renders
   `<div class="panes depth-N"><nav class="rail dash">…<nav class="rail main">…<section class="pane">…`.
   Rails are rebuilt from `agents` in `status()` (already called on every roster update); the chat
   pane is rendered as today, so transcript, composer, attachments and autocomplete are untouched.
2. **Breakpoints in CSS only**: grid columns plus `@media (max-width: 699px)` hides both rails and
   `(max-width: 1099px)` hides `.rail.main`. The `#app` 900px cap applies only to the list and the
   single-pane layout. Resizing and phone rotation need no JS.
3. **Header**: the ← button and title become the path (`pi-agents › main › sub`, each a link) and
   ‹ back. CSS hides the path's ancestors that are visible as rails, so on wide screens it shows only
   the agent name.
4. **History**: `stack` and `history.pushState` already match the pane stack. Collapse to depth d =
   `history.go(-(stack.length - d))`, so the browser and Android back buttons keep working. Opening an
   agent from a rail collapses to its parent first, then pushes.
5. **Phone niceties**: slide-in on open and back (skipped under `prefers-reduced-motion`); edge
   swipe → `history.back()` only in the installed (standalone) PWA, where iOS gives no swipe-back.
6. **Desktop keys** (small, optional): ← on an empty prompt goes back, alt+1/alt+2 jump, matching
   the terminal. The web has no keyboard navigation today.

Tests: `test/web-render.test.ts` covers the rail rows if they're built in `render.ts`; manual check
on `node scripts/dev-host.ts 8796` at 390, 820 and 1280 px (Playwright screenshots as for the mock).

## Order, release and restart

1. Terminal (visible immediately in `pi-agents-dev`), commit on `dev`.
2. Web, commit on `dev`.
3. Release only when you authorize it. No host restart needed: no host code changes, and web files
   are read from disk per request.

## Open questions

1. Dashboard rail contents: the full dashboard folds idle sub-agents into "3 idle · team $1.20".
   Should the rail fold the same way, or list every sub-agent of the open main (the mock lists all)?
   Proposal: fold like the dashboard, but always list the open main's sub-agents.
2. Breakpoints 80/140 cols and 700/1100px: keep, or adjust after trying the mock?
3. Web keyboard shortcuts (step 6): now or later?
