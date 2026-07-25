const CACHE = 'rvp-v11';
const ASSETS = [
  '/RandomVidPick/',
  '/RandomVidPick/index.html',
  '/RandomVidPick/app.js',
  '/RandomVidPick/manifest.json'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c =>
      // cache: 'reload' bypasses the browser's HTTP cache for these fetches -
      // without it, a fresh CACHE bucket could still get seeded with stale
      // bytes if the browser had an old index.html/app.js HTTP-cached.
      c.addAll(ASSETS.map(url => new Request(url, { cache: 'reload' })))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  // Deliberately no clients.claim() here. Claiming an already-open page
  // mid-session can hand a page's OWN sub-resource request (e.g. app.js)
  // to this newly-activated worker while that page's HTML was already
  // served by the outgoing one - producing a mixed old-HTML/new-JS load.
  // Without claim(), an already-open page keeps its current worker until
  // the next full navigation, which is guaranteed to be fully one version
  // or the other. skipWaiting() above still installs/activates promptly
  // in the background; this only affects already-open pages.
});

self.addEventListener('fetch', e => {
  if (!e.request.url.startsWith(self.location.origin)) return;
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
