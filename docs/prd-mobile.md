# PRD: phone clients for durable agents (Android web app + native Android app)

Status: approved by the owner 2026-10-26 (delegated: "finish both; good primitives first").

## Goal

Use the agents from an Android phone over Tailscale: see every agent and its sub-agents, read
transcripts, send messages (follow-up or steer), stop, create, rename and change models — the
same things the `pi-agents` terminal app does. Two clients on one host API:

1. **Mobile web app** (installable PWA), served by the host.
2. **Native Android app** (Kotlin, Jetpack Compose), with notifications when a top-level agent
   finishes.

## Principles

- **The host API is the single source of truth.** Clients never read the database and never
  re-derive agent state. Anything two clients would compute (status, transcript structure, the
  external-session placeholder, folder listings) is computed once on the host.
- **Primitives first.** Each primitive is a small pure function or one route, tested through the
  host. Clients are thin renderers.
- Simple, boring code; no frameworks where the platform suffices. TypeScript on the host and web,
  Kotlin on Android. The only duplication allowed is presentation formatting in Kotlin.
- No audience-split paths: the terminal app, the Pi extension, the web app and the Android app
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
- Every API request needs `Authorization: Bearer <token>` (`?token=` is accepted only for GET
  shell paths such as `/` and future static files, which the web app moves into storage and strips from the URL). The token lives in
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

## Native Android app (phase M3)

- `android/` Gradle project: Kotlin, Jetpack Compose (Material 3), OkHttp, kotlinx.serialization,
  a Compose markdown renderer. minSdk 29, target/compile 35. No DI framework.
- Same screens and the same routes as the web app. Settings: server URL + token (paste the
  pairing URL or scan the QR).
- **Notifications:** an opt-in "watch agents" foreground service keeps the roster stream open
  and posts a notification when a top-level agent finishes or fails; tapping opens its chat.
- Verified on an emulator against a test host (`adb reverse`), with screenshots.

## Testing

- Host primitives: node integration tests (faux model) covering items, external placeholder,
  ticks, dirs, remote auth and the route allowlist.
- Web app: loaded in a real browser at a phone viewport against a test host; screenshots of list,
  chat, working state, new-agent form. No Playwright test suite.
- Android: `./gradlew assembleDebug` plus unit tests for JSON decoding; installed and driven on an
  emulator with screenshots.

## Out of scope (for now)

Web Push for the PWA, iOS, access from outside the tailnet, multiple users, editing files from the
phone, streaming partial model text (the working line shows activity; text appears when committed).
