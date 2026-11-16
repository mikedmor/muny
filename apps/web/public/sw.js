/*
 * Muny service worker: makes the app installable and loads the UI quickly.
 * - /api/* is never cached here. (The opt-in offline snapshot is separate:
 *   encrypted in IndexedDB by the app, see src/lib/offline.ts.)
 * - Built assets (/assets/*, hashed filenames) are cached on first use.
 * - Pages are network-first, falling back to the cached app shell offline.
 */
const CACHE = "muny-shell-v6";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then(async (c) => {
      await c.addAll(["/", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/badge-96.png"]);
      // The app's own script and styles too, so it opens offline from the first visit.
      try {
        const html = await (await c.match("/")).text();
        const assets = [...html.matchAll(/["'](\/assets\/[^"']+\.(?:js|css))["']/g)].map(
          (m) => m[1],
        );
        await c.addAll([...new Set(assets)]);
      } catch {
        // Cached on first use instead.
      }
    }),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (
    req.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/")
  )
    return;

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          if (res.ok) caches.open(CACHE).then((c) => c.put("/", copy));
          return res;
        })
        .catch(() => caches.match("/")),
    );
    return;
  }

  if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/icons/")) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            const copy = res.clone();
            if (res.ok) caches.open(CACHE).then((c) => c.put(req, copy));
            return res;
          }),
      ),
    );
  }
});

// The unread count on the installed app's icon (where supported).
function setBadge(n) {
  const nav = self.navigator;
  if (typeof n !== "number" || !nav || !nav.setAppBadge) return Promise.resolve();
  return (n > 0 ? nav.setAppBadge(n) : nav.clearAppBadge()).catch(() => {});
}

// Alerts sent to this device (Web Push): show them, and open Muny when tapped.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Muny", body: event.data ? event.data.text() : "" };
  }
  const options = {
    body: data.body || "",
    icon: "/icons/icon-192.png",
    // Android draws the small status-bar icon from this image's shape only.
    badge: "/icons/badge-96.png",
    data: { url: data.link || data.url || "/alerts", id: data.id || null },
  };
  if (typeof data.ts === "number") options.timestamp = data.ts;
  // A newer alert of the same kind replaces the old one, and still buzzes.
  if (data.tag) {
    options.tag = data.tag;
    options.renotify = true;
  }
  if (data.id)
    options.actions = [
      { action: "read", title: "Mark read" },
      { action: "open", title: "Open" },
    ];
  event.waitUntil(
    Promise.all([
      self.registration.showNotification(data.title || "Muny", options),
      setBadge(data.unread),
    ]),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const id = event.notification.data && event.notification.data.id;
  if (event.action === "read" && id) {
    // Mark it read without opening Muny (uses this browser's sign-in).
    event.waitUntil(
      fetch("/api/notifications/read", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-muny-csrf": "1" },
        body: JSON.stringify({ ids: [id] }),
      })
        .then(() => fetch("/api/notifications?limit=1", { credentials: "same-origin" }))
        .then((r) => (r.ok ? r.json() : null))
        .then((l) => setBadge(l ? l.unread : undefined))
        .catch(() => {}),
    );
    return;
  }
  const raw = (event.notification.data && event.notification.data.url) || "/alerts";
  const target = new URL(raw, self.location.origin);
  // Only ever open Muny itself.
  const url =
    target.origin === self.location.origin ? target.href : self.location.origin + "/alerts";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list)
        if (new URL(c.url).origin === self.location.origin && "focus" in c) {
          c.navigate(url);
          return c.focus();
        }
      return self.clients.openWindow(url);
    }),
  );
});
