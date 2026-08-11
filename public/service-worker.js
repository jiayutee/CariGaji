const CACHE_NAME = "carigaji-cache-v2";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name)))
    ).then(() => self.clients.claim())
  );
});

// Network-first so deployed changes are always picked up when online;
// cache only exists to keep the app shell reachable during a network blip.
self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, responseClone));
        }
        return response;
      })
      .catch(() =>
        caches.match(request).then((cached) => {
          if (cached) return cached;
          // Portal deep links (/CariGaji/employer, /CariGaji/admin) are SPA
          // routes, not real files -- offline there is a cache miss on a URL
          // that was never fetched as itself. Any navigation can be served by
          // the one app shell, which then routes on location.pathname.
          if (request.mode === "navigate") {
            return caches
              .match(new URL(self.registration.scope).pathname)
              .then((shell) => shell || Response.error());
          }
          return Response.error();
        })
      )
  );
});
