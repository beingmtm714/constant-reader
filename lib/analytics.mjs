// Event recording.
//
// The app had no analytics of any kind before this, and adding a network sink to
// a private reading instrument would be the wrong thing to add: the feed already
// says, in the footer, that everything the reader does stays in their browser.
// So events are recorded locally and never sent anywhere. No script is loaded,
// no request is made, no identifier is minted.
//
// It is still worth recording. "How often do I actually go looking for a copy,
// and does the score predict it" is a question about the profile, and the export
// button is how the answer gets back into the next revision.
//
// The privacy rule is enforced here rather than trusted to callers: only the
// properties named per event are kept, so an outbound URL or a retailer account
// cannot be recorded by accident.

export const EVENTS = {
  book_saved: ['bookId', 'score', 'surface'],
  book_unsaved: ['bookId', 'surface'],
  saved_books_viewed: ['count', 'sort'],
  retailer_chooser_opened: ['bookId'],
  // linkResolution says which identifier the link was built from, which is the
  // one thing worth knowing here: it tells you whether the catalogue is carrying
  // its weight or whether readers are being dropped into a title search.
  retailer_link_opened: ['bookId', 'retailer', 'linkResolution'],
};

const MAX_EVENTS = 500;

function pick(name, props) {
  const allowed = EVENTS[name];
  if (!allowed) return null;
  const out = {};
  for (const key of allowed) {
    const value = props?.[key];
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out;
}

// Pure: takes the log, returns the next log. The browser wrapper below owns
// storage; this is what the tests exercise.
export function record(log, name, props = {}, now = new Date().toISOString()) {
  const kept = pick(name, props);
  if (!kept) return log;
  // A ring rather than unbounded growth — localStorage is a few megabytes and
  // this is diagnostic, not an audit trail.
  return [...log, { name, at: now, ...kept }].slice(-MAX_EVENTS);
}

export function createAnalytics({ load, store }) {
  return {
    track(name, props) {
      try { store(record(load(), name, props)); } catch { /* private mode, or storage full */ }
    },
    all() {
      try { return load(); } catch { return []; }
    },
  };
}
