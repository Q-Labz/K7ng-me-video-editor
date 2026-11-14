/* KutLabz service worker: installable app + offline shell. Media never touches the cache. */
const CACHE = 'kutlabz-v7';
const SHELL = ['./', 'index.html', 'css/style.css', 'js/luts.js', 'js/gl.js', 'js/analysis.js', 'js/app.js', 'js/studio.js', 'js/chat.js', 'js/mobile.js', 'js/prompts.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon.svg'];
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// "Share to KutLabz" from the phone's gallery: park the files, then open the editor to import them
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'POST' || url.pathname !== '/share-target') return;
  e.respondWith((async () => {
    const form = await e.request.formData(), files = form.getAll('media').filter((f) => f && f.size);
    const box = await caches.open('kutlabz-shared');
    await Promise.all(files.map((f, i) => box.put(`/shared/${Date.now()}-${i}`, new Response(f, { headers: { 'content-type': f.type, 'x-name': encodeURIComponent(f.name || `shared-${i}`) } }))));
    return Response.redirect('/?shared=' + files.length, 303);
  })());
});
self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET') return;
  if (url.origin === location.origin) {
    // network first so deploys land immediately; the cache is the offline fallback
    e.respondWith(fetch(req).then((res) => {
      if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match('index.html') : Response.error()))));
  } else if (FONT_HOSTS.includes(url.hostname)) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return res; })));
  }
});
