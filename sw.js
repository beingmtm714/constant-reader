// The service worker, and it does one job: turn a push into a notification.
//
// There is deliberately no `fetch` handler. A service worker that caches this
// app would be a second copy of it with its own idea of how fresh it is, and
// module caching has already cost this project two false conclusions in one day
// — a fix that was live read as not shipped, twice, because the browser was
// serving an old lib/*.mjs. Offline reading is a real feature and it can be
// built later, on purpose, with a version stamp and a way to break the cache.
// It is not something to acquire by accident while adding notifications.
//
// The push carries no payload. It does not need to: everything the notification
// says is in feed.json, which is a public static file this worker can fetch for
// itself. That keeps VAPID as the only cryptography in the sender, and it keeps
// one reader's recommendations out of a third party's push service entirely —
// Apple relays the fact that there is news, never what the news is.

const FEED = new URL('data/feed.json', self.registration.scope).href;
const SEEN = 'constant-reader-seen';

// The ids a reader has already been told about, kept in a Cache entry because a
// service worker has no localStorage and IndexedDB is a lot of ceremony for one
// array of strings. Eviction is survivable: an empty set means the first roundup
// after it says "new this week" without a number, which is vaguer and not wrong.
async function seenIds() {
  try {
    const cache = await caches.open(SEEN);
    const res = await cache.match('seen');
    return new Set(res ? await res.json() : []);
  } catch { return new Set(); }
}

async function remember(ids) {
  try {
    const cache = await caches.open(SEEN);
    await cache.put('seen', new Response(JSON.stringify([...ids])));
  } catch { /* a roundup that cannot write its state still showed up */ }
}

// What to say. Counting is the whole value of the thing — "3 new books for you"
// is a reason to open the app and "new recommendations" is a reason to ignore
// it — so the count is attempted first and the vague form is the fallback.
async function roundup() {
  const res = await fetch(FEED, { cache: 'no-store' });
  if (!res.ok) throw new Error(`feed ${res.status}`);
  const feed = await res.json();
  const recommended = (feed.books || []).filter((e) => e.recommended);
  const ids = new Set(recommended.map((e) => e.id));
  const seen = await seenIds();
  const fresh = recommended.filter((e) => !seen.has(e.id));
  await remember(ids);

  // First run has nothing to compare against, so every recommendation looks new
  // and "97 new books" would be a lie about the week. It says what it can stand
  // behind instead.
  if (!seen.size) {
    return { title: 'Constant Reader', body: `${recommended.length} books are recommended for you.` };
  }
  if (!fresh.length) {
    return { title: 'Constant Reader', body: 'No new recommendations this week.' };
  }
  const lead = fresh[0];
  const name = lead.book?.title ? `${lead.book.title}${lead.book.author ? `, ${lead.book.author}` : ''}` : null;
  const body = fresh.length === 1
    ? (name ? `A new recommendation: ${name}.` : 'One new recommendation this week.')
    : (name ? `${fresh.length} new recommendations, starting with ${name}.` : `${fresh.length} new recommendations this week.`);
  return { title: 'Constant Reader', body };
}

self.addEventListener('push', (event) => {
  // iOS requires a notification for every push and revokes permission from a web
  // app that takes one and shows nothing. So the catch is not tidiness: if the
  // feed cannot be read, something still has to appear.
  event.waitUntil((async () => {
    let text;
    try {
      text = await roundup();
    } catch {
      text = { title: 'Constant Reader', body: 'Your weekly roundup is ready.' };
    }
    await self.registration.showNotification(text.title, {
      body: text.body,
      icon: new URL('icons/constant-reader-192.png', self.registration.scope).href,
      badge: new URL('icons/constant-reader-192.png', self.registration.scope).href,
      tag: 'weekly-roundup',
      renotify: true,
      data: { url: new URL('./', self.registration.scope).href },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || new URL('./', self.registration.scope).href;
  // Focus the app if it is already open rather than stacking another copy of it.
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of open) {
      if (client.url.startsWith(url) && 'focus' in client) return client.focus();
    }
    return self.clients.openWindow(url);
  })());
});

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
