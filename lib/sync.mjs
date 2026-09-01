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

import { firebaseConfig } from './firebase-config.mjs?v=ce26cab02f';
import { mergeProfile, stamp } from './merge-profile.mjs?v=ce26cab02f';

const SDK = 'https://www.gstatic.com/firebasejs/10.14.1';

// Set once a reader signs in, cleared when they sign out. Its only job is to let
// a reload restore the session without loading the SDK for everyone else.
export const RETURNING_KEY = 'litfeed:signed-in';

// Google is asked for the token here, in this page, and Firebase is only ever
// handed the result. Neither of Firebase's own flows survives iOS Safari on a
// github.io origin, and the reason is the same for both: they route through
// constant-reader-93f05.firebaseapp.com, which writes its state to sessionStorage
// under a partition key, and the browser hands the page a different partition on
// the way back. signInWithRedirect was ruled out for that on 2026-08-29 and the
// popup was believed safe because it stayed in one window. It is not — on
// 2026-08-30 the same handler answered "Unable to process request due to missing
// initial state", which is that page saying its sessionStorage came back empty.
// Desktop Chrome never showed it because desktop Chrome does not partition this
// way, so the flow verified end to end and still could not sign anyone in on a
// phone.
//
// So the handler is out of the path. Google Identity Services runs on this
// origin, returns an access token, and `signInWithCredential` exchanges it for a
// Firebase session. Nothing is stored on a third domain and there is nothing to
// partition. There is deliberately no fallback to either Firebase flow: both are
// broken in the browser most readers are holding.
const GIS = 'https://accounts.google.com/gsi/client';

// The web client id of the Google provider on this project. Public by design —
// it identifies the app to Google and authorises nothing on its own; the origin
// allowlist on the OAuth client is what decides who may ask. Its secret is not
// here and must never be: this is a static site and anything in it is readable.
const CLIENT_ID = '630940771506-q6m111ptbqcuqk4691bte25j0pb1kk72.apps.googleusercontent.com';

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
  // Google Identity Services reports its own states and none of them start
  // `auth/`. Three are worth a sentence of their own: a blocked window reads as
  // a broken button, a closed one is a decision rather than a fault, and an
  // origin the OAuth client does not know is a setup step nobody can guess at.
  if (code === 'gis/popup_failed_to_open') return 'Your browser blocked the Google sign-in window. Allow popups for this site and try again.';
  if (code === 'gis/popup_closed' || code === 'gis/access_denied') return 'Sign-in was cancelled.';
  if (code === 'gis/idpiframe_initialization_failed' || code === 'gis/unavailable') return 'Google sign-in could not start here. Your books are safe on this device.';
  if (code === 'gis/unreachable') return 'Could not reach Google to sign in. Your books are still saved on this device.';
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
// onChange is called with (user, { authoritative }). The flag is the whole point:
// a null user from Firebase means "nobody is signed in" and should clear the
// remembered account, but a null user because the SDK would not load means "we
// could not ask" and must not. Without the distinction, opening the app on a
// train signs the reader out and makes them do the Google popup again on the
// other side of the tunnel.
export async function watch(onChange, { returning }) {
  if (!returning) return () => {};
  try {
    const { auth: authMod } = await load();
    return authMod.onAuthStateChanged(auth, (u) => onChange(u, { authoritative: true }));
  } catch {
    // Offline, or gstatic unreachable. The app carries on from localStorage, which
    // is the source of truth on this device anyway.
    onChange(null, { authoritative: false });
    return () => {};
  }
}

// The GIS script, fetched once. Kept separate from load() because the two are
// wanted at different moments: this one has to be in place *before* the tap that
// opens Google's window, and the Firebase SDK is not needed until a token comes
// back out of it.
let gis = null;
function loadGis() {
  if (gis) return gis;
  gis = new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = GIS;
    el.async = true;
    el.onload = () => (window.google?.accounts?.oauth2
      ? resolve(window.google.accounts.oauth2)
      : reject(Object.assign(new Error('gis'), { code: 'gis/unavailable' })));
    el.onerror = () => reject(Object.assign(new Error('gis'), { code: 'gis/unreachable' }));
    document.head.appendChild(el);
  }).catch((err) => { gis = null; throw err; });
  return gis;
}

let client = null;

// Called on the first sign of intent — a pointer going down on the account
// control — and never on load. Google's window is opened by requestAccessToken,
// and a browser only allows that from a gesture: a tap that has to wait for a
// script to arrive first is a tap the popup blocker eats. Warming here means the
// script is already there when the click lands. It is still gated on the reader
// reaching for the button, so a reader who never signs in still fetches nothing.
export async function warm() {
  const oauth2 = await loadGis();
  if (!client) {
    client = oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: 'openid email profile',
      callback: () => {},
    });
  }
  return client;
}

export async function signIn() {
  const tokens = await warm();
  const token = await new Promise((resolve, reject) => {
    // Both of these fire once per request and the pair is exhaustive: callback
    // for anything Google answered, error_callback for the window never opening
    // or the reader closing it. Without the second, a dismissed window leaves a
    // promise nobody settles and a button that spins for ever.
    tokens.callback = (res) => (res.access_token
      ? resolve(res.access_token)
      : reject(Object.assign(new Error(res.error || 'gis'), { code: `gis/${res.error || 'failed'}` })));
    tokens.error_callback = (err) => reject(Object.assign(new Error(err?.type || 'gis'), { code: `gis/${err?.type || 'failed'}` }));
    tokens.requestAccessToken();
  });
  const { auth: authMod } = await load();
  const credential = authMod.GoogleAuthProvider.credential(null, token);
  const { user } = await authMod.signInWithCredential(auth, credential);
  return user;
}

export async function signOut() {
  if (!auth) return;
  const { auth: authMod } = await load();
  await authMod.signOut(auth);
}

// ---------------------------------------------------------------- document

function docRef(store, uid) { return store.doc(db, 'readers', uid); }

// A push subscription is a device's address, and it lives in a subcollection
// rather than in the reader's document on purpose: push() above writes the
// reader document with setDoc and no merge, so a field beside the verdicts
// would be erased by the next sync — silently, and a week before anyone noticed
// the notification had stopped. A subcollection cannot be reached by that write
// at all. It also lets one reader hold several devices, which is the normal
// case: the phone on the Home Screen and the laptop that set it up.
function deviceRef(store, uid, id) { return store.doc(db, 'readers', uid, 'devices', id); }

export async function saveDevice(uid, id, subscription) {
  const { store } = await load();
  await store.setDoc(deviceRef(store, uid, id), {
    ...subscription,
    subscribedAt: new Date().toISOString(),
  });
}

export async function forgetDevice(uid, id) {
  const { store } = await load();
  await store.deleteDoc(deviceRef(store, uid, id));
}

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
