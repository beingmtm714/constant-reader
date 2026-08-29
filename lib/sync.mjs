// Sign-in and profile sync. The only part of this app that talks to a server.
//
// Everything here is optional and nothing above it may assume it worked. The app
// is a static file and a JSON blob; it opens, reads and ranks with no network and
// no account, and that has to stay true. So the Firebase SDK is not bundled, not
// preloaded and not imported at start: it is fetched the first time a reader taps
// Sign in, and on later visits only because they already did. A reader who never
// signs in never pays a byte for this file beyond its own source.
//
// Failure is expected rather than exceptional — offline, a blocked CDN, a popup
// the browser swallowed — and every path through here ends in a message and a
// working signed-out app. Nothing throws upward.

import { firebaseConfig } from './firebase-config.mjs';
import { mergeProfile, stamp } from './merge-profile.mjs';

const SDK = 'https://www.gstatic.com/firebasejs/10.14.1';

// Set once a reader signs in, cleared when they sign out. Its only job is to let
// a reload restore the session without loading the SDK for everyone else.
export const RETURNING_KEY = 'litfeed:signed-in';

// A popup, never a redirect. signInWithRedirect needs the auth handler on
// firebaseapp.com to hand state back to a page on github.io, and Safari's storage
// partitioning drops it in silence: no error, no user, and a reader who tapped
// Sign in and watched nothing happen. The popup keeps the whole exchange in one
// window that Safari treats as first-party. There is deliberately no redirect
// fallback — falling back to the broken path is worse than saying what went wrong.
let app = null, auth = null, db = null, fb = null;

async function load() {
  if (fb) return fb;
  const [core, authMod, store] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-auth.js`),
    import(`${SDK}/firebase-firestore.js`),
  ]);
  app = core.initializeApp(firebaseConfig);
  auth = authMod.getAuth(app);
  db = store.getFirestore(app);
  fb = { core, auth: authMod, store };
  return fb;
}

// What the reader is told when it does not work. Firebase's own messages name
// internal states ("auth/popup-blocked"), so each one that a reader can actually
// do something about gets a sentence that says what to do.
export function explain(err) {
  const code = err?.code || '';
  // The two states before anyone has finished switching Auth on in the console.
  // They are the first errors this app can produce, so they say what is missing
  // rather than "sync failed": configuration-not-found is Authentication never
  // started, operation-not-allowed is started with Google left off.
  if (code === 'auth/configuration-not-found') return 'Sign-in is not set up for this project yet. Nothing is lost; your books are on this device.';
  if (code === 'auth/operation-not-allowed') return 'Google sign-in is not switched on for this project yet.';
  if (code === 'auth/popup-blocked') return 'Your browser blocked the sign-in window. Allow popups for this site and try again.';
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return 'Sign-in was cancelled.';
  if (code === 'auth/unauthorized-domain') return 'This address is not on the project’s authorised domains yet.';
  if (code === 'auth/network-request-failed') return 'No connection. Your books are still here and still saved on this device.';
  if (code === 'permission-denied') return 'The server refused that write. Your books are still saved on this device.';
  if (code === 'unavailable') return 'Cannot reach the server. Your books are still saved on this device.';
  return 'Sync failed. Your books are still saved on this device.';
}

// ---------------------------------------------------------------- session

// Called on every load, and it is a no-op — no import, no network — for a reader
// who has never signed in. onChange fires with the user or with null, and the app
// renders from localStorage either way, before this ever resolves.
export async function watch(onChange, { returning }) {
  if (!returning) return () => {};
  try {
    const { auth: authMod } = await load();
    return authMod.onAuthStateChanged(auth, onChange);
  } catch {
    // The SDK did not load. The reader is offline or gstatic is unreachable, and
    // the app carries on exactly as it does for someone who never signed in.
    onChange(null);
    return () => {};
  }
}

export async function signIn() {
  const { auth: authMod } = await load();
  const provider = new authMod.GoogleAuthProvider();
  const { user } = await authMod.signInWithPopup(auth, provider);
  return user;
}

export async function signOut() {
  if (!auth) return;
  const { auth: authMod } = await load();
  await authMod.signOut(auth);
}

// ---------------------------------------------------------------- document

function docRef(store, uid) { return store.doc(db, 'readers', uid); }

export async function pull(uid) {
  const { store } = await load();
  const snap = await store.getDoc(docRef(store, uid));
  return snap.exists() ? snap.data() : null;
}

// Merge, then write the merged result back. Both devices run the same merge over
// the same two documents, so whichever writes second writes the same thing the
// first one would have — the order they sync in cannot change where they land.
export async function push(uid, profile) {
  const { store } = await load();
  await store.setDoc(docRef(store, uid), {
    verdicts: profile.verdicts || {},
    overrides: profile.overrides || {},
    syncedAt: new Date().toISOString(),
  });
}

// The whole exchange, which is what the app calls: read the far side, merge it
// with what is here, write the result back, hand the merged copy up to be saved
// locally and rendered. One round trip, and it is the same on first sign-in as on
// every save after it.
export async function reconcile(uid, local) {
  const remote = await pull(uid);
  const merged = mergeProfile(local, remote);
  await push(uid, merged);
  return merged;
}

export { stamp };
