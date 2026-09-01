// Merging one reader's two copies of themselves.
//
// A reader who signs in on a phone has a list here and a list there, and both are
// real. The device that syncs second must not win by being second: that is how a
// reader loses a year of saves to a browser they opened once. So nothing here
// overwrites — the two sides are merged, and the merge is the same on both
// devices, so they converge on the same answer whatever order they run in.
//
// Every function is pure — state in, new state out — like the rest of web/lib.
// The Firebase glue lives in sync.mjs and knows nothing about what any of this
// means; this file knows nothing about the network.

import { migrate } from './saved-books.mjs?v=5a97887a83';

// ---------------------------------------------------------------- verdicts

// A record is either a verdict, { verdict, savedAt }, or a tombstone,
// { verdict: null, removedAt }. Both are decisions the reader made; they differ in
// which way they went and when.
const isTombstone = (r) => Boolean(r) && r.verdict === null;
const decidedAt = (r) => Date.parse((isTombstone(r) ? r.removedAt : r.savedAt) || '');

// Two saves of the same book are one decision made twice, so the older wins:
// savedAt is when the reader chose the book, and re-tapping save on a second
// device should not rewrite that date.
//
// A save against a removal is two different decisions, so the later one wins
// instead. Taking a book off the list is a decision too, made after the save it
// undoes, and a reader who unsaves on their phone has to see it stay gone on their
// laptop. This is the whole reason unsave() leaves a tombstone.
//
// A null date is a record migrated from before timestamps existed. It loses to any
// real date, because "we do not know when" cannot outrank "we know when", and two
// undated records keep the local one so an offline device stays stable.
function resolve(mine, theirs) {
  if (!mine) return theirs;
  if (!theirs) return mine;
  const a = decidedAt(mine), b = decidedAt(theirs);
  if (!Number.isFinite(a) && !Number.isFinite(b)) return mine;
  if (!Number.isFinite(a)) return theirs;
  if (!Number.isFinite(b)) return mine;
  // Disagreeing about whether the book belongs on the list at all: latest wins.
  if (isTombstone(mine) !== isTombstone(theirs)) return a >= b ? mine : theirs;
  // Agreeing, so this is one decision recorded twice and the first is the true one.
  return a <= b ? mine : theirs;
}

// The union of what both sides know, never the intersection. A book one device has
// heard of and the other has not is kept: silence is not disagreement, and a device
// that has been offline for a month should not be able to erase a month of saves by
// syncing. Removals travel as tombstones rather than as missing keys, so an unsave
// is something this merge can carry and an unheard-of book still is not.
// Keys come out sorted, so the two devices write the same bytes and not merely
// the same facts. Object key order is insertion order in JavaScript, so merging
// A into B and B into A agreed on every verdict and still produced two different
// documents - which is a diff on the server every time the second device syncs,
// for no change at all. Firestore does not care about map order; a person reading
// the document, and a test asserting the merge commutes, both do.
export function mergeVerdicts(local, remote) {
  const mine = migrate(local || {});
  const theirs = migrate(remote || {});
  const out = {};
  const ids = [...new Set([...Object.keys(mine), ...Object.keys(theirs)])].sort();
  for (const bookId of ids) {
    out[bookId] = resolve(mine[bookId], theirs[bookId]);
  }
  return out;
}

// ---------------------------------------------------------------- overrides

// The reader's ordering is one coherent document, not a set of independent facts:
// a weight and the band scores under it were chosen against each other, so merging
// half of one copy into half of the other produces an ordering neither device's
// reader ever held. It is last-write-wins on the whole object for that reason.
//
// An unstamped copy is one written before this file existed. It loses to any
// stamped one and beats another unstamped one only by being local.
export function mergeOverrides(local, remote) {
  const a = Date.parse(local?.updatedAt || '');
  const b = Date.parse(remote?.updatedAt || '');
  if (!Number.isFinite(b)) return local;
  if (!Number.isFinite(a)) return remote;
  return b > a ? remote : local;
}

export function stamp(overrides, now = new Date().toISOString()) {
  return { ...overrides, updatedAt: now };
}

// ---------------------------------------------------------------- document

// What one reader's document holds, and nothing else. Theme, filter prefs, the
// last retailer and the analytics log stay on the device that made them: they
// describe a browser rather than a reader, and syncing them would mean a phone
// deciding what a laptop looks like.
export function mergeProfile(local, remote) {
  return {
    verdicts: mergeVerdicts(local?.verdicts, remote?.verdicts),
    overrides: mergeOverrides(local?.overrides, remote?.overrides),
  };
}
