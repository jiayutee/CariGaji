const CACHE_NAME = "carigaji-cache-v2";

// Every in-app URL this worker builds is resolved against ITS OWN scope rather
// than a hardcoded prefix, because the same worker has to run on a host that
// serves the app from "/" and on one that serves it from "/CariGaji/" -- and a
// push payload cannot know which of the two a given subscription belongs to.
// Both link shapes are accepted: the bare form ("employer") that send-push now
// emits, and the legacy absolute form ("/CariGaji/employer") that may still be
// in flight from an older deployment.
const appUrl = (link) => {
  const rel = String(link || "")
    .replace(/^\/+/, "")
    .replace(/^CariGaji\//, "");
  return new URL(rel, self.registration.scope).href;
};

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
          // Portal deep links (<base>/employer, <base>/admin) are SPA
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

// ─── Web Push ───────────────────────────────────────────────────────────────
// Shows a notification in the OS tray when the server pushes one, and focuses
// (or opens) the app at the right place when it is tapped.
//
// The payload carries the notification's stored English title/body, not a
// translated string. The service worker has no access to the app's TRANSLATIONS
// table -- it runs outside the page -- and duplicating the dictionary here
// would give two copies to keep in sync. Tapping through lands on the in-app
// notification, which IS translated, so the reader sees their own language one
// tap later. Translating the push itself means rendering it server-side from
// `params` plus the user's stored language preference, which is worth doing
// once a language column exists on profiles.

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    // A push with a non-JSON body is not worth dropping silently: show
    // something rather than nothing, so the user still knows to look.
    payload = { title: "CariGaji", body: event.data ? event.data.text() : "" };
  }

  const title = payload.title || "CariGaji";
  const options = {
    body: payload.body || "",
    icon: appUrl("icon-192.png"),
    badge: appUrl("icon-192.png"),
    // Collapse repeats of the same thing: a second push about one application
    // replaces the first in the tray instead of stacking.
    tag: payload.tag || payload.link || "carigaji",
    renotify: true,
    data: { link: payload.link || "" },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const link = (event.notification.data && event.notification.data.link) || "";
  const target = appUrl(link);

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      // Reuse an open tab rather than piling up new ones. Matching on scope
      // rather than the exact URL, because the app is a SPA -- the tab showing
      // the app root can navigate itself to the deep link.
      for (const client of clients) {
        if (client.url.startsWith(self.registration.scope) && "focus" in client) {
          client.postMessage({ type: "notification-click", link });
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
