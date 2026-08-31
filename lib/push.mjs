// The weekly roundup: asking for it, and the three ways a browser can say no.
//
// This is the only feature in the app that cannot work everywhere, and most of
// this file is about saying so honestly. On iPhone, Web Push exists only for a
// web app that has been added to the Home Screen — Safari 16.4 onward, Apple's
// own rule, not a Firebase or a GitHub Pages limitation. A reader looking at
// this page in a Safari tab has no button to press that would work, so they get
// the instructions for the Share sheet instead of a button that fails.
//
// Everything here is optional in the same way sign-in is: nothing above it may
// assume it worked, no failure throws upward, and a reader who never asks for a
// notification pays nothing for it.

// The public half of the VAPID key pair. Public by design and it ships: it is
// what a push service checks the sender's signature against, and it authorises
// nothing on its own. The private half is in vapid.key beside google-books.key,
// gitignored twice, and never leaves this machine. Regenerating the pair
// invalidates every existing subscription, so it is not a thing to do casually.
export const VAPID_PUBLIC_KEY = 'BHuh5X5a7Zp1Pq7T4sagUJUMU155rF5JHsnqNShU3T3p_4PFxvuOmG8NKBFBtIxdZ9-sctXBBq7DARiMcIwOFW4';

// A Home Screen web app on iOS reports standalone through a non-standard
// property Safari has carried since 2008; every other browser answers the
// display-mode media query. Checking both is not belt and braces — on iOS the
// media query is the one that is unreliable, and it is the platform that needs
// this answer to be right.
export const installed = () => window.navigator.standalone === true
  || window.matchMedia?.('(display-mode: standalone)').matches === true;

export const supported = () => 'serviceWorker' in navigator
  && 'PushManager' in window
  && 'Notification' in window;

// Why the reader cannot have this, in the order the reasons actually apply.
// `needs-install` is deliberately checked before support: on an iPhone in a
// Safari tab, PushManager is missing *because* the app is not installed, and
// telling someone their browser cannot do it when their browser can, once they
// add it to the Home Screen, is the wrong sentence.
export function blocker() {
  const iOS = /iP(hone|ad|od)/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (iOS && !installed()) return 'needs-install';
  if (!supported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return null;
}

export const state = () => (Notification.permission === 'granted' ? 'on' : 'off');

let registration = null;

// Registered on demand rather than at load, for the same reason the Firebase
// SDK is: a reader who never asks for notifications should not be running a
// service worker they did not want. `sw.js` sits at the root of the app so its
// scope covers the whole thing, and the path is relative because this site is
// served from a subdirectory and an absolute one would point off the app.
async function worker() {
  if (registration) return registration;
  const root = new URL('../', import.meta.url);
  registration = await navigator.serviceWorker.register(new URL('sw.js', root), { scope: root.pathname });
  await navigator.serviceWorker.ready;
  return registration;
}

// The base64url the push spec speaks, which is not the base64 atob speaks.
function keyBytes(base64url) {
  const padded = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4))
    .replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

const b64 = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Must be called from inside the tap. Both requestPermission and subscribe are
// gesture-gated on iOS, and a handler that awaits anything slow before reaching
// them is a handler whose prompt never appears — the same failure that made
// sign-in look broken on a phone for a day.
export async function enable() {
  const stop = blocker();
  if (stop) throw Object.assign(new Error(stop), { code: `push/${stop}` });
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw Object.assign(new Error(permission), { code: `push/${permission}` });
  }
  const reg = await worker();
  const existing = await reg.pushManager.getSubscription();
  // userVisibleOnly is not optional and not a formality: it is the promise that
  // every push shows the reader something, and iOS withdraws permission from a
  // web app that breaks it.
  const sub = existing || await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: keyBytes(VAPID_PUBLIC_KEY),
  });
  return describe(sub);
}

export async function disable() {
  if (!supported()) return;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  await sub?.unsubscribe();
  return sub ? describe(sub) : null;
}

export async function current() {
  if (!supported() || Notification.permission !== 'granted') return null;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub ? describe(sub) : null;
}

// The shape the sender needs, and nothing else. No user agent string and no
// display name: a subscription is a device's address, and what it is used for
// here is one notification a week.
function describe(sub) {
  const json = sub.toJSON();
  return {
    endpoint: sub.endpoint,
    p256dh: json.keys?.p256dh || b64(sub.getKey('p256dh')),
    auth: json.keys?.auth || b64(sub.getKey('auth')),
  };
}

// A stable id for the subscription's document, so a device that re-subscribes
// replaces its own row instead of adding a second one and being told twice.
export async function deviceId(endpoint) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return b64(digest).slice(0, 32).replace(/[^A-Za-z0-9_-]/g, '');
}
