// No API requests enter the cache. Network-first shell files permit token rotation.
const VERSION = "pi-shell-v1";
const SHELL = [
  "/",
  "/web/index.html",
  "/web/app.css",
  "/web/main.ts",
  "/web/api.ts",
  "/web/pair.ts",
  "/web/render.ts",
  "/status.ts",
  "/agent-name.ts",
  "/web/marked.js",
  "/web/manifest.webmanifest",
  "/web/icons/icon.svg",
  "/web/icons/icon-192.png",
  "/web/icons/icon-512.png",
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
