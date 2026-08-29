// The saved list.
//
// This app has no accounts and no server — it is one reader's instrument, built
// and read on their own machine — so a saved book is a bookId and a timestamp in
// localStorage, and that is the whole data model. The conceptual record is
//
//   { id, userId, bookId, savedAt }
//
// with `id` and `bookId` collapsed into one, because the record is keyed by the
// book, and `userId` dropped, because there is exactly one. Uniqueness on
// (userId, bookId) is therefore structural: a plain object keyed by bookId
// cannot hold the same book twice, so a duplicate save is an overwrite rather
// than a second row. If accounts ever arrive, this file is where the userId
// scoping goes and nothing above it needs to know.
//
// Every function here is pure — state in, new state out. The browser owns the
// reading and writing of localStorage; this module owns what the shape means.

// The feed already stored a verdict per book: 'saved' or 'passed', as a bare
// string. That list is this list — a second parallel store would let the two
// disagree about what is saved — so the shape was widened rather than replaced,
// and anything written by an older build is migrated on read.
export const SAVED = 'saved';
export const PASSED = 'passed';

// A record written before savedAt existed. Its save is real and must survive the
// upgrade; only the timestamp is unknown, and null sorts to the end of "recently
// saved" rather than pretending to a date it never had.
function upgrade(value) {
  if (typeof value === 'string') return { verdict: value, savedAt: null };
  if (value && typeof value === 'object' && typeof value.verdict === 'string') {
    return { verdict: value.verdict, savedAt: value.savedAt ?? null };
  }
  // A tombstone: the reader took this book off the list, and that is a fact worth
  // keeping rather than the absence of one. See unsave().
  if (value && typeof value === 'object' && value.verdict === null && value.removedAt) {
    return { verdict: null, removedAt: value.removedAt };
  }
  return null;
}

export function migrate(raw) {
  const out = {};
  for (const [bookId, value] of Object.entries(raw || {})) {
    const record = upgrade(value);
    if (record) out[bookId] = record;
  }
  return out;
}

export const verdictOf = (state, bookId) => state?.[bookId]?.verdict ?? null;
export const isSaved = (state, bookId) => verdictOf(state, bookId) === SAVED;

// Saving twice is not an error and does not move the book to the top of the
// list: the first save is when the reader decided, and re-tapping a control they
// have already tapped should not quietly rewrite that. Idempotent by design.
export function save(state, bookId, now = new Date().toISOString()) {
  if (!bookId) return state;
  const existing = state[bookId];
  if (existing?.verdict === SAVED) return state;
  return { ...state, [bookId]: { verdict: SAVED, savedAt: existing?.savedAt ?? now } };
}

// Removes the saved relationship only. The book itself lives in feed.json and is
// rebuilt from the publications; nothing here can or should delete it.
//
// The record is kept as a tombstone rather than deleted, because a reader with two
// devices has two copies of this list and a merge can only see what is written
// down. A deleted key is indistinguishable from a book the other device has never
// heard of, so a union merge reads it as "saved over there, unknown here" and puts
// the book back — which is exactly what a signed-in reader would watch happen a
// second after every unsave. A tombstone says the removal out loud, with the date
// it happened, so the merge can rank it against the save. See lib/merge-profile.mjs.
//
// Nothing above this file changes: verdictOf reads the null verdict as no verdict,
// so isSaved, savedIds, savedCount and listSaved all treat a tombstone as absent,
// which is what it is.
export function unsave(state, bookId, now = new Date().toISOString()) {
  if (!state[bookId]) return state;
  return { ...state, [bookId]: { verdict: null, removedAt: now } };
}

export function toggleSaved(state, bookId, now) {
  return isSaved(state, bookId) ? unsave(state, bookId) : save(state, bookId, now);
}

// 'passed' is the feed's other verdict and shares this store. Setting one clears
// the other: a book cannot be both saved and passed.
export function setVerdict(state, bookId, verdict, now = new Date().toISOString()) {
  if (!bookId) return state;
  if (!verdict || verdictOf(state, bookId) === verdict) return unsave(state, bookId);
  if (verdict === SAVED) return save(state, bookId, now);
  const next = { ...state };
  next[bookId] = { verdict, savedAt: state[bookId]?.savedAt ?? null };
  return next;
}

export const savedIds = (state) => Object.keys(state).filter((id) => isSaved(state, id));

export const savedCount = (state) => savedIds(state).length;

// ---------------------------------------------------------------- listing

const byTitle = (e) => (e?.book?.title || '').toLowerCase();
// Sorting people by surname is what a shelf does, and the feed already has a
// surname key for grouping; this is the display-side equivalent.
const byAuthor = (e) => {
  const name = (e?.book?.author || '').toLowerCase().trim();
  if (!name) return '￿';
  const parts = name.replace(/[^a-z .'-]/g, '').split(/\s+/).filter(Boolean);
  return parts.length ? `${parts[parts.length - 1]} ${parts.slice(0, -1).join(' ')}` : name;
};

export const SORTS = {
  recent: { label: 'Recently saved' },
  title: { label: 'Title' },
  author: { label: 'Author' },
};

// The saved list as feed entries, newest save first by default. A saved id with
// no entry in the current feed is skipped rather than rendered as a blank row:
// the feed is rebuilt from live publications and a book can drop out of it, but
// the save is kept in storage so it comes back when the book does.
export function listSaved(state, books, sort = 'recent') {
  const byId = new Map((books || []).map((b) => [b.id, b]));
  const rows = savedIds(state)
    .map((bookId) => ({ bookId, savedAt: state[bookId].savedAt, entry: byId.get(bookId) }))
    .filter((row) => row.entry);

  if (sort === 'title') return rows.sort((a, b) => byTitle(a.entry).localeCompare(byTitle(b.entry)));
  if (sort === 'author') return rows.sort((a, b) => byAuthor(a.entry).localeCompare(byAuthor(b.entry)));
  // Undated saves are the ones migrated from before timestamps existed. They go
  // last, because "recently saved" is a claim we cannot make about them.
  return rows.sort((a, b) => (Date.parse(b.savedAt || '') || 0) - (Date.parse(a.savedAt || '') || 0));
}

export const EMPTY_COPY = 'You haven’t saved any books yet. Save recommendations you’d like to come back to.';
