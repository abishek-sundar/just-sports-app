/* JustSports service worker — network-first for data, cache the app shell for offline.
 * Deliberately does NOT cache API responses (scores must be fresh).
 */
const SHELL = "justsports-shell-v12";
const SHELL_FILES = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest",
  "./icon.svg",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const { request } = e;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  // Page navigations (/, /mlb, /nba, /f1) all resolve to the same app shell.
  const isNavigation = request.mode === "navigate";
  // Only serve the app shell from cache; never cache cross-origin API/data.
  const isAsset = url.origin === self.location.origin &&
    SHELL_FILES.some((f) => url.pathname.endsWith(f.replace("./", "/")) || url.pathname.endsWith("/"));

  if (isNavigation || isAsset) {
    e.respondWith(
      fetch(request).then((res) => {
        const copy = res.clone();
        caches.open(SHELL).then((c) => c.put(request, copy));
        return res;
      }).catch(() =>
        caches.match(request).then((r) => r || caches.match("./index.html")))
    );
  }
  // Everything else (ESPN/Jolpica/Worker): straight to network, no caching here.
});
