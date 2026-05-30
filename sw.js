// Service worker : met l'app en cache pour fonctionner hors-ligne
const CACHE = "bookreeder-v26";
const FICHIERS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.webmanifest",
  "./lib/jszip.min.js",
  "./lib/epub.min.js",
  "./fonts/merriweather-latin.woff2",
  "./fonts/merriweather-latin-ext.woff2",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FICHIERS)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((cles) =>
      Promise.all(cles.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  e.respondWith(
    caches.match(e.request).then((reponse) => reponse || fetch(e.request))
  );
});
