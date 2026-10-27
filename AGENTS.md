# pi-durable-teams

Durable Pi agents: one host process runs every hosted agent; `pi-agents` (terminal) and the
web app (`src/web/`, served by the host) are views onto it. See README.md for the contract.

## Two checkouts

- `~/Desktop/src/pi-durable-teams` is LIVE (branch `stable`). The running host and Pi's extension
  load from it. Do not edit it.
- `~/Desktop/src/pi-durable-teams-dev` is for development (branch `dev`). Work here.

You may be running inside the live host you are changing. Never restart, kill, or signal the host
yourself, and never touch `~/.pi/agent/durable-teams/`. If a change needs a host restart, say so and
let the human do it.

## Seeing changes

- Terminal app: the human runs `pi-agents-dev` (this worktree under `node --watch`). It restarts on
  every save, so screen changes in `src/app.ts`, `src/status.ts`, etc. show up immediately.
- Web app: files under `src/web/` are read from disk on each request; a page refresh shows them once
  released to the live checkout.
- Host changes (`src/host.ts`, `src/teams.ts`, `src/chat.ts`, routes, push) need a release and a host
  restart, which only the human does.

## Verify

```bash
npm run check
(npm test > /tmp/test.log 2>&1 & p=$!; sleep 150; kill $p); grep -E "^ℹ (pass|fail)" /tmp/test.log
```

Need a host for a manual check? `node scripts/dev-host.ts 8796` starts a throwaway one with a fake
model; stop only that process.

## Style

Simple, boring, smallest change; prefer subtraction. Clients render what the host computes
(`src/chat.ts`, `src/status.ts`) and never duplicate that logic.
