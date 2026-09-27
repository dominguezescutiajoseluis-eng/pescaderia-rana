/* ==========================================================================
   PESCADERÍA RANA - SERVICE WORKER PWA (v4: todo local + Firebase opcional)
   ========================================================================== */

const CACHE_NAME = 'pescaderia-rana-v4';
const ASSETS = [
  './',
  './index.html',
  './css/styles.css',
  './css/fonts.css',
  './js/db.js',
  './js/sync.js',
  './js/ocr.js',
  './js/clients.js',
  './js/invoices.js',
  './js/reports.js',
  './js/pdf.js',
  './js/whatsapp.js',
  './js/exportar.js',
  './js/app.js',
  './manifest.json',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/apple-touch-icon.png',
  './vendor/fontawesome/css/all.min.css',
  './vendor/html2pdf/html2pdf.bundle.min.js',
  './vendor/tesseract/tesseract.min.js',
  './vendor/tesseract/worker.min.js',
  './vendor/firebase/firebase-app-compat.js',
  './vendor/firebase/firebase-firestore-compat.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('Caché Pescadería Rana v4 activado');
      return cache.addAll(ASSETS);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (
    !event.request.url.startsWith(self.location.origin) ||
    event.request.url.includes('firestore.googleapis.com') ||
    event.request.url.includes('firebase') ||
    event.request.url.includes('generativelanguage')
  ) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.status === 200) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      })
      .catch(() => {
        return caches.match(event.request);
      })
  );
});
