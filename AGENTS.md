# pi-durable-teams

Durable Pi agents: one host process runs every hosted agent; `pi-agents` (terminal) and the
web app (`src/web/`, served by the host) are views onto it. See README.md for the contract.

## Two checkouts

- `~/Desktop/src/pi-durable-teams` is LIVE (branch `stable`). The running host and Pi's extension
  load from it. Never edit files there; it changes only through a release (below).
- `~/Desktop/src/pi-durable-teams-dev` is for development (branch `dev`). Work here.

You may be running inside the live host you are changing. Never restart, kill, or signal the host
on your own, and never touch `~/.pi/agent/durable-teams/` (live runtime state and databases). If a
change needs a host restart, say so. Restart only when the human asks for it in the current
conversation, and then only with `node ~/Desktop/src/pi-durable-teams/src/pi-agents.ts restart-host`
(it detaches, so your own tool call may be cut off; check `/health` in your next turn).

## Releasing

Agents may commit on `dev`. Release to `stable` only when the human explicitly authorizes that
release in the current conversation; finishing a task, a passing test run, or an earlier release is
not authorization. When authorized:

1. Inspect both checkouts (`git status`, `git log stable..dev`). Commit only your own changes; leave
   anyone else's uncommitted work as it is and keep it out of the release.
2. `npm run check` and the test command below must pass on exactly the commit being released, with
   no other uncommitted changes in the tree being tested.
3. From the live checkout, `git merge --ff-only dev`. Nothing else: no edits, resets, stashes, or
   checkouts there.
4. Stop and ask the human if either checkout has changes you can't account for, the live checkout
   is not clean, `stable` has commits not in `dev`, the merge is not a fast-forward, or anything
   conflicts.
5. Report what was released and whether it needs a host restart.

Never push to a remote without separate, explicit authorization.

## Seeing changes

- Terminal app: the human runs `pi-agents-dev` (this worktree under `node --watch`). It restarts on
  every save, so screen changes in `src/app.ts`, `src/status.ts`, etc. show up immediately.
- Web app: files under `src/web/` are read from disk on each request; a page refresh shows them once
  released to the live checkout.
- Host changes (`src/host.ts`, `src/teams.ts`, `src/chat.ts`, routes, push) need a release
  (authorized, above) and a host restart (above).

## Where things are

- Terminal views: `src/app.ts` (dashboard, rails, drafts per agent), `src/ui.ts` (`ChatView` with its
  footer, `TeamPanel` with the asks under the prompt, `agentCard`, `Rail`).
- Web views: `src/web/main.ts` (screens, composer, drafts in localStorage), `src/web/render.ts` (HTML).
- Shared by both, never duplicated: `src/chat.ts` (asks, `Re:` lines, `waiting`/`withDraft`),
  `src/status.ts` (status words, tones, marks, team glance).
- Tests: `test/ui.test.ts` (panel, cards, transcript), `test/web-render.test.ts`, `test/app.test.ts`
  (the terminal app end to end, script in `test/testing/app-scenario.ts`).

## Verify

While working, run the test files for what you touched (seconds):

```bash
npm run check && node --test --test-force-exit test/ui.test.ts test/web-render.test.ts
```

Before committing, the whole suite once (about two minutes; it exits when done):

```bash
npm run check && npm test > /tmp/test.log 2>&1; grep -E "^ℹ (pass|fail|cancelled)|✖" /tmp/test.log
```

Small, easily undone screen changes: build the recommended option and show it, rather than asking
first; ask first when the host, stored data or agent-facing behaviour changes.

Need a host for a manual check? `node scripts/dev-host.ts 8796` starts a throwaway one with a fake
model; stop only that process.

## Style

Simple, boring, smallest change; prefer subtraction. Clients render what the host computes
(`src/chat.ts`, `src/status.ts`) and never duplicate that logic.
