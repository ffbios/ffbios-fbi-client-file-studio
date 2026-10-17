// FBI TV watch app (live.fbigh.com/tv) service worker.
// Network-first for the page so viewers always get the latest version;
// the cached copy is only an offline fallback. The live stream (/api/...)
// is never cached.
const CACHE_NAME = "fbi-tv-app-v2";
const SHELL = ["/tv", "/tv-manifest.webmanifest", "/tv-icon-192.png", "/tv-icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k.startsWith("fbi-tv-app-") && k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  if (req.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req, { cache: "no-store" });
        if (fresh.ok) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put("/tv", fresh.clone());
        }
        return fresh;
      } catch (e) {
        return (await caches.match("/tv")) || Response.error();
      }
    })());
    return;
  }

  if (SHELL.includes(url.pathname)) {
    event.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
  }
});


self.addEventListener("push", (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch {}
  const title = String(payload.title || "FBI TV starts soon").slice(0, 120);
  const body = String(payload.body || "Your FBI TV show is about to start.").slice(0, 240);
  const options = {
    body,
    icon: String(payload.icon || "/tv-icon-192.png"),
    badge: "/tv-icon-192.png",
    tag: String(payload.tag || "fbi-tv-reminder").slice(0, 128),
    renotify: false,
    data: { url: String(payload.url || "/tv#watch") }
  };
  event.waitUntil(
    self.registration.showNotification(title, options).then(() =>
      self.clients.matchAll({ type: "window", includeUncontrolled: true })
        .then(clients => clients.forEach(client => client.postMessage({ type: "fbi-tv-push-delivered" })))
    )
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const destination = new URL(String(event.notification.data && event.notification.data.url || "/tv#watch"), self.location.origin);
  if (destination.origin !== self.location.origin) destination.href = new URL("/tv#watch", self.location.origin).href;
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of clients) {
      if (!client.url.startsWith(self.location.origin)) continue;
      if (typeof client.navigate === "function") await client.navigate(destination.href).catch(() => {});
      return client.focus();
    }
    return self.clients.openWindow(destination.href);
  })());
});
