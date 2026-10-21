// The Firebase web config for project constant-reader-93f05.
//
// Every value here is public by design and ships to the browser: Firebase
// identifies the project with them and controls access with security rules and
// the signed-in user's token, never with this key. It carries HTTP referrer
// restrictions for the Pages origin, the auth handler and localhost:4123, and
// Firestore refuses everything except a reader's own document. See
// firestore.rules.
//
// It is not the Google Books key. That one is server-side, restricted to the
// Books API, read at build time from google-books.key and gitignored. The two
// must never be confused, which is why bin/publish.mjs allowlists this exact
// string and keeps refusing every other AIza key it finds.
export const firebaseConfig = {
  apiKey: 'AIzaSyAvJLmjkycIXXLaPTfjTgPIovSnUZoU1Eo',
  authDomain: 'constant-reader-93f05.firebaseapp.com',
  projectId: 'constant-reader-93f05',
  storageBucket: 'constant-reader-93f05.firebasestorage.app',
  messagingSenderId: '630940771506',
  appId: '1:630940771506:web:c1718425bb8901498f55ab',
};
