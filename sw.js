// Service worker : « réseau d'abord » pour toujours charger la dernière
// version quand on est en ligne, avec repli sur le cache hors-ligne.
const CACHE = "bookreeder-v341";
const FICHIERS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./chargeur.js",
  "./dialogues.js",
  "./manifest.webmanifest",
  "./lib/jszip.min.js",
  "./lib/epub.min.js",
  "./lib/pdf.min.js",
  "./lib/pdf.worker.min.js",
  "./fonts/merriweather-latin.woff2",
  "./fonts/merriweather-latin-ext.woff2",
  "./fonts/roboto-400.woff2",
  "./fonts/roboto-700.woff2",
  "./fonts/opendyslexic-400.woff2",
  "./fonts/opendyslexic-700.woff2",
  "./fonts/literata-400.woff2",
  "./fonts/literata-700.woff2",
  "./fonts/notosans-400.woff2",
  "./fonts/notosans-700.woff2",
  "./fonts/dejavu-400.woff2",
  "./fonts/dejavu-700.woff2",
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

// Réseau d'abord : on tente toujours le réseau (et on rafraîchit le cache),
// et on ne retombe sur le cache qu'en cas d'échec (hors-ligne).
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    fetch(e.request)
      .then((reponse) => {
        const copie = reponse.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copie)).catch(() => {});
        return reponse;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
