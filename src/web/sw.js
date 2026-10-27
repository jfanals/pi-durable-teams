// No API requests enter the cache. Network-first shell files permit token rotation.
const VERSION = "pi-shell-v2";
const SHELL = [
  "/",
  "/web/index.html",
  "/web/app.css",
  "/web/main.ts",
  "/web/api.ts",
  "/web/pair.ts",
  "/web/push.ts",
  "/web/render.ts",
  "/status.ts",
  "/agent-name.ts",
  "/web/marked.js",
  "/web/manifest.webmanifest",
  "/web/icons/icon.svg",
  "/web/icons/icon-192.png",
  "/web/icons/icon-512.png",
  "/web/icons/badge-96.png",
];
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("pi-shell-") && key !== VERSION)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.search ||
    !SHELL.includes(url.pathname)
  )
    return;
  event.respondWith(
    fetch(event.request)
      .then(async (response) => {
        if (response.ok) {
          const cache = await caches.open(VERSION);
          await cache.put(event.request, response.clone());
        }
        return response;
      })
      .catch(async () => (await caches.match(event.request)) || Response.error()),
  );
});

// Notifications contain metadata only, never conversation text or credentials.
self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let data;
    try { data = event.data?.json(); } catch { return; }
    if (!data || typeof data.agent !== "string" || typeof data.title !== "string") return;
    await self.registration.showNotification(data.title, {
      body: typeof data.body === "string" ? data.body : "",
      tag: `agent-${data.agent}`,
      renotify: true,
      badge: "/web/icons/badge-96.png",
      icon: "/web/icons/icon-192.png",
      data: { agent: data.agent },
    });
  })());
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const agent = event.notification.data?.agent;
  if (typeof agent !== "string") return;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const client = windows.find(client => new URL(client.url).origin === self.location.origin);
    if (client) {
      client.postMessage({ type: "open-agent", agent });
      await client.focus();
    } else await self.clients.openWindow(`/#agent=${encodeURIComponent(agent)}`);
  })());
});
