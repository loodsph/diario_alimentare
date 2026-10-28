// Service worker di NutriTrack.
// - File dell'app (stessa origine): network-first, con la cache come riserva offline.
//   Così dopo un deploy si usa sempre il codice nuovo quando c'è rete.
// - Librerie da CDN (URL con versione fissa): cache-first.
// - Firestore, Auth, Gemini, Open Food Facts: non intercettati.

const CACHE = 'nutritrack-v5';

const APP_SHELL = [
    '/',
    '/index.html',
    '/style.css',
    '/script.js',
    '/firebase-config.js',
    '/manifest.json',
    '/icons/icon-192.png',
    '/icons/favicon-32.png',
    '/modules/aiPhotoAnalysis.js',
    '/modules/aiDishAnalysis.js',
    '/modules/dishEstimateEditor.js',
    '/modules/charts.js',
    '/modules/foodSearch.js',
    '/modules/mealEntry.js',
    '/modules/nutrition.js',
    '/modules/portionPicker.js',
    '/modules/portions.js',
    '/modules/scanner.js',
    '/modules/uiHelpers.js',
    '/modules/utils.js',
    '/modules/diary.js',
    '/modules/sync.js',
    '/modules/lazy.js',
    '/modules/photo.js',
    '/modules/mealEstimate.js',
    '/modules/estimateEditor.js'
];

const CDN_HOSTS = [
    'www.gstatic.com',
    'cdn.jsdelivr.net',
    'unpkg.com',
    'cdnjs.cloudflare.com',
    'fonts.googleapis.com',
    'fonts.gstatic.com'
];

self.addEventListener('install', event => {
    event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(APP_SHELL.map(path => new Request(path, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
            .then(() => self.clients.claim())
    );
});

async function networkFirst(request) {
    const cache = await caches.open(CACHE);
    try {
        const response = await fetch(request, { cache: 'no-cache' });
        if (response.ok) cache.put(request, response.clone());
        return response;
    } catch (error) {
        const cached = await cache.match(request, { ignoreSearch: true });
        if (cached) return cached;
        if (request.mode === 'navigate') {
            const shell = await cache.match('/index.html');
            if (shell) return shell;
        }
        throw error;
    }
}

async function cacheFirst(request) {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    // Le risposte "opaque" (status 0) dei CDN senza CORS si possono comunque riusare.
    if (response.ok || response.type === 'opaque') cache.put(request, response.clone());
    return response;
}

self.addEventListener('fetch', event => {
    const { request } = event;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);

    if (url.origin === self.location.origin) {
        // Gli handler di Firebase Auth (/__/auth/...) non vanno mai messi in cache.
        if (url.pathname.startsWith('/__/')) return;
        event.respondWith(networkFirst(request));
        return;
    }

    if (CDN_HOSTS.includes(url.hostname)) {
        event.respondWith(cacheFirst(request));
    }
});
