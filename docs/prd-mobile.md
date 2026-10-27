# PRD: installed web app for durable agents

Status: web-only decision approved by the owner 2026-10-27.

## Goal

Use the agents from a phone over Tailscale: see every agent and its sub-agents, read
transcripts, send messages (follow-up or steer), stop, create, rename and change models — the
same things the `pi-agents` terminal app does. One installable web app, served by the host,
with opt-in Web Push notifications.

## Principles

- **The host API is the single source of truth.** Clients never read the database and never
  re-derive agent state. Anything multiple clients would compute (status, transcript structure, the
  external-session placeholder, folder listings) is computed once on the host.
- **Primitives first.** Each primitive is a small pure function or one route, tested through the
  host. Clients are thin renderers.
- Simple, boring code; no frameworks where the platform suffices. TypeScript on the host and web,
  with shared presentation formatters.
- No audience-split paths: the terminal app, the Pi extension, the installed web app
  use the same routes and the same transcript items.

## Primitives (phase M1)

### 1. Agent status: `src/status.ts`

`WorkerStatus`, `liveStatus` and the pure formatters (`formatDuration`, `formatAgo`,
`formatTokens`, `formatContext`, `formatCost`, `statusWord`) move out of the terminal UI into a
module with **no runtime imports**, so the host no longer imports terminal code and the web app
can import the same formatters. `ui.ts` re-uses them.

### 2. Transcript items: `src/chat.ts`

`chatItems(entries, prefix?)` turns committed Durable entries into a small, stable, JSON-friendly list.
One item per entry that matters; every client renders these and nothing else:

```ts
type ChatItem =
  | { id: string; kind: "input"; from: string; text: string; report?: boolean; at?: number }
  | { id: string; kind: "reply"; parts: ChatPart[];
      error?: string; at?: number; turn?: { ms?: number; tokens: number; cost: number } }
  | { id: string; kind: "result"; callId: string; ok: boolean; error?: string }
  | { id: string; kind: "notice"; text: string };
type ChatPart = { type: "text"; text: string } | { type: "thinking"; text: string }
  | { type: "tool"; id: string; name: string; subject: string };
```

- A tool call's outcome comes from the `result` item with the same `callId`. Within a page the
  host already pairs them; across a page boundary the client keeps a `callId → result` map.
- `turn` is set on the reply that ends a request (stop reason not `toolUse`), summed over all
  replies of that request, not just the page. The host reads older entries in bounded ID scans
  until the oldest request's input is found, and passes them as `prefix` (not returned items).
- Reply parts retain their original order; each text part renders as its own Markdown block.
- The terminal transcript renderer (`renderTranscript`) consumes `ChatItem[]`. The Pi extension
  applies `chatItems` to the entries it gets from `inspect transcript`; the host applies it for
  human routes. One function, every client.

### 3. Routes (human API, unchanged shape elsewhere)

| Route | Change |
|---|---|
| `POST /agents/page` | returns `{ items: ChatItem[], next? }`. For an external Pi session: one `reply` item with its latest publication (or a "no hosted transcript" notice), no error. |
| `POST /agents/watch`, `POST /watch` | frames become `{ changed: true }` ticks (coalesced). Clients refetch the first page; nobody sends whole conversation snapshots over a phone link. |
| `POST /agents/dirs` | `{ path? }` → `{ path, parent?, dirs: { name, markers }[], error? }` — the directory picker's listing for remote clients. Default path: home. Same listing code as the terminal picker. |

`/agents`, `/agents/roster`, `/agents/models`, `/agents/new|send|stop|disable|model|rename` keep
their shapes.

### 4. Remote access: one listener, one token

- `config.json` gains `remote: { port: number }`. When set, the host also listens on
  `127.0.0.1:<port>` (never 0.0.0.0) with the **same request handler**.
- Every API request needs `Authorization: Bearer <token>`. The web app's static files (`/`, `/web/*`, manifest, icons, scripts) are public: they are code with no agent data, and Chrome's installer fetches the manifest and icons without credentials (an earlier cookie gate made the app uninstallable). The pairing URL's `?token=` is read by the page into local storage and removed from the address bar; the host never accepts it. The token lives in
  `remote-token` (0600) in the state dir, created atomically at remote host startup or pairing. Stored and presented tokens must be
  at least 32 characters; invalid stored tokens disable remote access. Constant-time comparison.
- Remote requests may only reach `/agents*` and the web app's static files. `/register`,
  `/action`, `/events`, `/ack`, `/publish`, `/resume`, `/watch` (agent routes) answer 404.
- Tailscale provides the network and HTTPS: `tailscale serve --bg <port>` exposes it as
  `https://<machine>.<tailnet>.ts.net`. The token is still required: a tailnet can include other
  people's devices.
- `pi-agents pair` prints the URL with the token and a QR code (via `qrencode` when present) for
  the phone. `pi-agents pair --rotate` replaces the token atomically. A host timer checks file metadata once
  per second and reloads changed credentials; a changed token destroys open remote streams.

## Mobile web app (phase M2)

- Plain TypeScript ES modules in `src/web/`, served by the host with
  `node:module`'s `stripTypeScriptTypes` (no bundler, no build step). Type-checked with a DOM
  tsconfig as part of `npm run check`. Imports `src/status.ts` formatters directly.
- Markdown via `marked` (already installed with pi-tui), raw HTML escaped, only http(s) links.
- Screens mirror the terminal app: **list** (recency order, running first, sub-agents indented,
  offline Pi sessions hidden behind a toggle, summary line), **chat** (transcript items, working
  line with activity and elapsed time, composer with send / steer, stop, sub-agent strip, model
  and rename in a menu), **new agent** (name, folder browser via `/agents/dirs` with recent agent
  folders first, model and thinking).
- Live data: one roster stream for the list and the status line; the open chat's watch ticks
  trigger a refetch of the first page. Reconnect with backoff; a visible "reconnecting" state.
- PWA: manifest, icons, a service worker that caches only the app shell (never API responses),
  dark theme, safe-area insets, 44 px touch targets.

## Decision 2026-10-27: web app only

The native app lived in `android/` up to commit c0b3e5e (see git history).

### Web Push design

- `web-push` provides standard VAPID signing and RFC 8291 encryption. A stable key pair,
  `mailto:` subject and endpoint-keyed subscriptions live in state-dir `push.json` (0600),
  written atomically. The subject placeholder may be replaced with an operator contact.
- Bearer-authenticated `POST /agents/push/key` returns `{ publicKey }`;
  `POST /agents/push/subscribe` accepts `{ subscription }`;
  `POST /agents/push/unsubscribe` accepts `{ endpoint }`. Only the Bearer header authorizes these.
- The host reuses the existing commit subscription and `service.agents`, coalescing at 25 ms.
  It reads no roster when there are no subscriptions. The first snapshot is only a baseline;
  only top-level hosted running → idle transitions notify, never sub-agents or external Pi
  sessions. Idle snapshots, browser reconnects and host startup do not replay finishes.
- Encrypted payload: `{ title: "<name> finished", body: "<model> · <duration>", agent: id }`.
  No transcript text. TTL is one hour; urgency is normal. HTTP 404/410 removes an expired
  subscription. Delivery failures are logged and never interrupt the host.
- The list's **Notify when agents finish** toggle requests permission and registers the browser
  subscription with the host. Off removes it on both sides. Denied permission explains how
  to enable it in browser site settings; failed subscriptions are not shown as enabled.
- The service worker displays notifications tagged per agent. A tap focuses an existing app
  window or opens `/#agent=<id>`; startup, hash changes and worker messages select that chat.
- Standalone manifest with stable id, root scope/start URL, opaque maskable icons and dark
  splash background. Chrome's **Install app** launches without browser chrome. History-based
  back navigation and the existing missing-token pairing screen remain unchanged.
- HTTPS is required (localhost is allowed for development). The host needs outbound access
  to the browser's push service; phone delivery does not need a live roster connection.

## Testing

- Host primitives: node integration tests (faux model) covering items, external placeholder,
  ticks, dirs, remote auth and the route allowlist.
- Web app: loaded in a real browser at a phone viewport against a test host; screenshots of list,
  chat, working state, new-agent form. No Playwright test suite.
- Push: pure transition tests plus a faux-model API integration test using a local TLS push
  endpoint: encrypted headers/body, persistence, no duplicate first-frame/sub-agent alerts,
  bearer auth and 410 cleanup.

## Out of scope (for now)

iOS, access from outside the tailnet, multiple users, editing files from the
phone, streaming partial model text (the working line shows activity; text appears when committed).
