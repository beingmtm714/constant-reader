#!/usr/bin/env node
// Unit tests for the saved-books feature.
//
// Same shape as bin/calibrate.mjs — no framework, no dependency, one line per
// case, exit 1 on failure — because that is how this repo tests things and a
// second convention would be worse than none.
//
// calibrate.mjs validates the profile against fixtures. This validates code with
// exact right answers: ISBN arithmetic, URL construction, and what the saved
// list does when it is asked to save the same book twice.
//
// URLs are asserted by origin, path and decoded parameters rather than by
// string equality, so adding an affiliate tag or reordering a query does not
// fail a test that is not about that.

import {
  normalizeIsbn, isValidIsbn10, isValidIsbn13, isbn10ToIsbn13, bestIsbn13,
} from '../web/lib/isbn.mjs';
import {
  RETAILERS, createBookRetailerUrl, resolveBookRetailerUrl, linkFor, decorate,
  canFindCopy, identifiersFor,
} from '../web/lib/retailers.mjs';
import * as saved from '../web/lib/saved-books.mjs';
import * as PUSH from '../web/lib/push.mjs';
import { record, EVENTS } from '../web/lib/analytics.mjs';
import { buildTasteModel, tuneEntry, tunedTotal, weightProposal, explore, unknownCoverage, MIN_SIGNAL, MIN_JUDGMENTS, MAX_ADJUSTMENT } from '../web/lib/taste.mjs';
import { distance, meanVector, nearestOf, vectorOf, weightsFrom } from '../web/lib/vector.mjs';
import { score as scoreCandidate } from '../lib/score.mjs';
import { rescore, summarize, isEmpty, bandKey } from '../web/lib/overrides.mjs';
import { CHIPS, REFUSALS } from '../web/lib/onboard.mjs';
import { mergeVerdicts, mergeOverrides, mergeProfile, stamp } from '../web/lib/merge-profile.mjs';
import { buildShelves, rankedKinds } from '../web/lib/shelves.mjs';
import { jacketFor, hash, titleSize, GROUNDS } from '../web/lib/jacket.mjs';
import { cleanBlurb, bestBlurb, isUsableBlurb } from '../web/lib/blurb.mjs';
import { parse as parseQuery, search as runSearch, buildIndex as buildSearchIndex, tokenize as searchTokens } from '../web/lib/search.mjs';
import { ARCHIVES } from '../lib/archive.mjs';
import { coverUrl, coverFor, fillsSlot, SLOTS } from '../web/lib/cover.mjs';
import { readFileSync } from 'node:fs';

const GREEN = '\x1b[32m', RED = '\x1b[31m', DIM = '\x1b[2m', OFF = '\x1b[0m';
const results = [];
let group = '';

const describe = (name) => { group = name; };

function it(name, fn) {
  try { fn(); results.push({ group, name, ok: true }); }
  catch (err) { results.push({ group, name, ok: false, why: err.message }); }
}

function eq(actual, expected, what = '') {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what ? what + ': ' : ''}got ${a}, wanted ${b}`);
}

const ok = (value, what) => { if (!value) throw new Error(`${what}: expected truthy, got ${JSON.stringify(value)}`); };
const notOk = (value, what) => { if (value) throw new Error(`${what}: expected falsy, got ${JSON.stringify(value)}`); };

// Origin + path + decoded params, so a test says what it means and nothing more.
function parts(url) {
  const u = new URL(url);
  return { origin: u.origin, path: u.pathname, params: Object.fromEntries(u.searchParams) };
}

// ---------------------------------------------------------------- fixtures

// Synthetic books, but every ISBN below is checksum-valid — an invalid one in a
// fixture makes a passing test mean something other than it appears to.
const FULL = { title: 'Piranesi', author: 'Susanna Clarke', isbn13: '9781635575637', isbn10: '0140449132', asin: 'B07YKM5QZP' };
const ISBN13_ONLY = { title: 'Checkout 19', author: 'Claire-Louise Bennett', isbn13: '9780593534564' };
const ISBN10_ONLY = { title: 'The Colony', author: 'Audrey Magee', isbn10: '155404295X' };
const TITLE_AUTHOR = { title: 'Yellow Pine', author: 'Claire Vaye Watkins' };
const TITLE_ONLY = { title: 'One Night Only' };
const NOTHING = { title: '', author: '' };
const AWKWARD = { title: 'Hurricane Season & Other Stories: A "Selection"', author: 'Fernanda Melchor' };

// ---------------------------------------------------------------- isbn

describe('isbn');

it('strips spaces and hyphens', () => {
  eq(normalizeIsbn('978-1-63557-563-7'), '9781635575637');
  eq(normalizeIsbn('  978 1 63557 563 7 '), '9781635575637');
});

it('accepts a trailing X on an ISBN-10 and upper-cases it', () => {
  eq(normalizeIsbn('1-55404-295-x'), '155404295X');
  ok(isValidIsbn10('155404295X'), 'X check digit');
});

it('rejects anything that is not a plausible ISBN', () => {
  eq(normalizeIsbn('not-a-book'), null);
  eq(normalizeIsbn('97816355756'), null, 'eleven digits');
  eq(normalizeIsbn(null), null);
  eq(normalizeIsbn(undefined), null);
});

it('rejects a well-formed ISBN with a bad check digit', () => {
  notOk(isValidIsbn13('9781635575630'), 'wrong final digit');
  notOk(isValidIsbn10('1635575630'), 'wrong final digit');
});

it('converts a valid ISBN-10 to ISBN-13', () => {
  eq(isbn10ToIsbn13('155404295X'), '9781554042951');
  eq(isbn10ToIsbn13('0140449132'), '9780140449136');
});

it('refuses to convert an invalid ISBN-10', () => {
  // A mistyped 10 would convert into a well-formed 13 pointing at another book.
  eq(isbn10ToIsbn13('1635575630'), null);
  eq(isbn10ToIsbn13('junk'), null);
});

it('finds the best ISBN-13 whether one was given or derived', () => {
  eq(bestIsbn13({ isbn13: '978-1-63557-563-7' }), '9781635575637', 'given');
  eq(bestIsbn13({ isbn10: '155404295X' }), '9781554042951', 'derived');
  eq(bestIsbn13({}), null);
});

// ---------------------------------------------------------------- resolution

describe('identifier priority');

it('prefers a verified ASIN over everything else', () => {
  eq(resolveBookRetailerUrl('amazon', FULL).linkResolution, 'asin');
});

it('only treats a ten-character alphanumeric as an ASIN', () => {
  eq(identifiersFor({ title: 'x', asin: 'nope' }).asin, null);
  eq(identifiersFor({ title: 'x', asin: 'b07ykm5qzp' }).asin, 'B07YKM5QZP', 'case is normalised');
});

it('never invents an ASIN from an ISBN-10', () => {
  eq(identifiersFor(ISBN10_ONLY).asin, null);
  eq(resolveBookRetailerUrl('amazon', ISBN10_ONLY).linkResolution, 'isbn10');
});

it('falls from isbn13 to isbn10 to title_author to title', () => {
  eq(resolveBookRetailerUrl('abebooks', ISBN13_ONLY).linkResolution, 'isbn13');
  eq(resolveBookRetailerUrl('amazon', ISBN10_ONLY).linkResolution, 'isbn10');
  eq(resolveBookRetailerUrl('amazon', TITLE_AUTHOR).linkResolution, 'title_author');
  eq(resolveBookRetailerUrl('amazon', TITLE_ONLY).linkResolution, 'title');
});

it('returns null when there is nothing to search for', () => {
  eq(createBookRetailerUrl('amazon', NOTHING), null);
  eq(createBookRetailerUrl('bookshop', NOTHING), null);
  eq(createBookRetailerUrl('thriftbooks', {}), null);
  eq(createBookRetailerUrl('abebooks', null), null);
});

it('returns null for a retailer it does not know', () => {
  eq(createBookRetailerUrl('waterstones', FULL), null);
});

it('canFindCopy agrees with the builders', () => {
  ok(canFindCopy(TITLE_ONLY), 'a title alone is searchable');
  notOk(canFindCopy(NOTHING), 'nothing is not');
  notOk(canFindCopy({ title: '   ' }), 'whitespace is not a title');
});

// ---------------------------------------------------------------- amazon

describe('amazon');

it('deep-links a verified ASIN', () => {
  const p = parts(createBookRetailerUrl('amazon', FULL));
  eq(p.origin, 'https://www.amazon.com');
  eq(p.path, '/dp/B07YKM5QZP');
  eq(p.params, {});
});

it('searches on an ISBN when there is no ASIN', () => {
  const p = parts(createBookRetailerUrl('amazon', ISBN13_ONLY));
  eq(p.path, '/s');
  eq(p.params, { k: '9780593534564' });
});

it('searches on title and author when there is no ISBN', () => {
  eq(parts(createBookRetailerUrl('amazon', TITLE_AUTHOR)).params, { k: 'Yellow Pine Claire Vaye Watkins' });
});

it('searches on title alone when there is no author', () => {
  eq(parts(createBookRetailerUrl('amazon', TITLE_ONLY)).params, { k: 'One Night Only' });
});

// ---------------------------------------------------------------- thriftbooks

describe('thriftbooks');

it('searches the b.search parameter on the browse path', () => {
  const p = parts(createBookRetailerUrl('thriftbooks', ISBN13_ONLY));
  eq(p.origin, 'https://www.thriftbooks.com');
  eq(p.path, '/browse/');
  eq(p.params, { 'b.search': '9780593534564' });
});

it('uses the most precise ISBN available', () => {
  // FULL carries both lengths; the 13 wins.
  eq(parts(createBookRetailerUrl('thriftbooks', FULL)).params, { 'b.search': '9781635575637' });
  eq(parts(createBookRetailerUrl('thriftbooks', ISBN10_ONLY)).params, { 'b.search': '155404295X' });
  eq(resolveBookRetailerUrl('thriftbooks', FULL).linkResolution, 'isbn13');
});

it('falls back to title and author', () => {
  eq(parts(createBookRetailerUrl('thriftbooks', TITLE_AUTHOR)).params, { 'b.search': 'Yellow Pine Claire Vaye Watkins' });
  eq(resolveBookRetailerUrl('thriftbooks', TITLE_ONLY).linkResolution, 'title');
});

// ---------------------------------------------------------------- abebooks

describe('abebooks');

it('searches the isbn parameter', () => {
  const p = parts(createBookRetailerUrl('abebooks', ISBN13_ONLY));
  eq(p.origin, 'https://www.abebooks.com');
  eq(p.path, '/servlet/SearchResults');
  eq(p.params, { isbn: '9780593534564' });
});

it('splits title and author into tn and an', () => {
  eq(parts(createBookRetailerUrl('abebooks', TITLE_AUTHOR)).params,
    { tn: 'Yellow Pine', an: 'Claire Vaye Watkins' });
});

it('uses tn alone when there is no author', () => {
  eq(parts(createBookRetailerUrl('abebooks', TITLE_ONLY)).params, { tn: 'One Night Only' });
});

// ---------------------------------------------------------------- bookshop

describe('bookshop');

it('deep-links an ISBN-13 with no query at all', () => {
  const p = parts(createBookRetailerUrl('bookshop', ISBN13_ONLY));
  eq(p.origin, 'https://bookshop.org');
  eq(p.path, '/book/9780593534564');
  eq(p.params, {});
});

it('converts an ISBN-10 and deep-links the result', () => {
  const resolved = resolveBookRetailerUrl('bookshop', ISBN10_ONLY);
  eq(parts(resolved.url).path, '/book/9781554042951', 'deep-linked, not searched');
  // Reported as what the feed held, not as what it was converted into — see the
  // note on identifiersFor. This is the property analytics is actually asking about.
  eq(resolved.linkResolution, 'isbn10');
});

it('searches when the ISBN-10 will not convert', () => {
  const bad = { title: 'The Colony', author: 'Audrey Magee', isbn10: '1554042950' };
  const resolved = resolveBookRetailerUrl('bookshop', bad);
  eq(parts(resolved.url).path, '/beta-search');
  eq(resolved.linkResolution, 'title_author');
});

it('searches on title and author with no ISBN', () => {
  const p = parts(createBookRetailerUrl('bookshop', TITLE_AUTHOR));
  eq(p.path, '/beta-search');
  eq(p.params, { keywords: 'Yellow Pine Claire Vaye Watkins' });
});

it('searches on title alone with no author', () => {
  eq(parts(createBookRetailerUrl('bookshop', TITLE_ONLY)).params, { keywords: 'One Night Only' });
});

// ---------------------------------------------------------------- encoding

describe('encoding');

it('encodes ampersands, quotes and colons in a title', () => {
  const url = createBookRetailerUrl('amazon', AWKWARD);
  ok(!url.includes('"'), 'no raw quote in the url');
  // The point of the round trip: whatever the encoding, it decodes back.
  eq(parts(url).params.k, 'Hurricane Season & Other Stories: A "Selection" Fernanda Melchor');
});

it('encodes non-ascii and accented names', () => {
  const book = { title: 'Élisabeth', author: 'Éric Rohmer' };
  eq(parts(createBookRetailerUrl('abebooks', book)).params, { tn: 'Élisabeth', an: 'Éric Rohmer' });
  ok(createBookRetailerUrl('abebooks', book).includes('%C3%89'), 'É is percent-encoded on the wire');
});

it('encodes a title containing a slash without inventing a path segment', () => {
  const url = createBookRetailerUrl('bookshop', { title: 'Either/Or' });
  eq(parts(url).path, '/beta-search', 'the slash stayed in the query');
  eq(parts(url).params, { keywords: 'Either/Or' });
});

it('trims surrounding whitespace rather than searching for it', () => {
  eq(parts(createBookRetailerUrl('amazon', { title: '  Piranesi  ' })).params, { k: 'Piranesi' });
});

// ---------------------------------------------------------------- every retailer

describe('retailer config');

it('has all four retailers in the documented order', () => {
  eq(RETAILERS.map((r) => r.id), ['amazon', 'thriftbooks', 'abebooks', 'bookshop']);
});

it('every retailer has a name and a blurb', () => {
  for (const r of RETAILERS) { ok(r.name, `${r.id} name`); ok(r.blurb, `${r.id} blurb`); }
});

it('every retailer builds a link for a book with only a title', () => {
  const hosts = { amazon: 'www.amazon.com', thriftbooks: 'www.thriftbooks.com', abebooks: 'www.abebooks.com', bookshop: 'bookshop.org' };
  for (const r of RETAILERS) {
    const url = createBookRetailerUrl(r.id, TITLE_ONLY);
    ok(url, `${r.id} built a url`);
    eq(new URL(url).host, hosts[r.id], `${r.id} host`);
    eq(new URL(url).protocol, 'https:', `${r.id} is https`);
  }
});

// ---------------------------------------------------------------- affiliates

describe('affiliates');

it('adds no tracking parameter when nothing is configured', () => {
  for (const r of RETAILERS) {
    const link = linkFor(r.id, FULL, {});
    const params = parts(link.url).params;
    notOk('tag' in params, `${r.id} has no amazon tag`);
    notOk('aid' in params, `${r.id} has no bookshop aid`);
  }
});

it('adds the configured parameter when one is supplied', () => {
  eq(parts(linkFor('amazon', ISBN13_ONLY, { amazon: 'realtag-20' }).url).params,
    { k: '9780593534564', tag: 'realtag-20' });
  eq(parts(linkFor('bookshop', ISBN13_ONLY, { bookshop: '12345' }).url).params, { aid: '12345' });
});

it('refuses an empty or whitespace affiliate id', () => {
  eq(parts(decorate('https://www.amazon.com/dp/X', 'amazon', { amazon: '' })).params, {});
  eq(parts(decorate('https://www.amazon.com/dp/X', 'amazon', { amazon: '   ' })).params, {});
});

it('leaves a retailer with no affiliate programme alone', () => {
  eq(decorate('https://www.thriftbooks.com/browse/?b.search=x', 'thriftbooks', { thriftbooks: 'nope' }),
    'https://www.thriftbooks.com/browse/?b.search=x');
});

it('keeps canonical generation free of affiliate data', () => {
  const canonical = resolveBookRetailerUrl('amazon', ISBN13_ONLY).url;
  notOk(canonical.includes('tag='), 'resolve never decorates');
});

// ---------------------------------------------------------------- saved list

describe('saved books');

const A = 'piranesi|clarke', B = 'the colony|magee';

it('saves a book', () => {
  const state = saved.save({}, A);
  ok(saved.isSaved(state, A), 'A is saved');
  eq(saved.savedIds(state), [A]);
});

it('unsaves a book', () => {
  eq(saved.savedIds(saved.unsave(saved.save({}, A), A)), []);
});

it('toggles', () => {
  const on = saved.toggleSaved({}, A);
  ok(saved.isSaved(on, A));
  notOk(saved.isSaved(saved.toggleSaved(on, A), A));
});

it('cannot save the same book twice', () => {
  const twice = saved.save(saved.save({}, A, '2026-01-01T00:00:00.000Z'), A, '2026-06-01T00:00:00.000Z');
  eq(saved.savedIds(twice), [A], 'still one entry');
  eq(twice[A].savedAt, '2026-01-01T00:00:00.000Z', 'the first save is when they decided');
});

it('is idempotent — a repeat save returns the same object', () => {
  const once = saved.save({}, A);
  ok(saved.save(once, A) === once, 'no new state for a no-op');
});

it('unsaving something that was never saved is a no-op', () => {
  const state = saved.save({}, A);
  ok(saved.unsave(state, B) === state);
});

it('ignores an empty book id', () => {
  eq(saved.savedIds(saved.save({}, '')), []);
  eq(saved.savedIds(saved.save({}, null)), []);
});

it('does not mutate the state it was given', () => {
  const before = saved.save({}, A);
  const snapshot = JSON.stringify(before);
  saved.save(before, B);
  saved.unsave(before, A);
  eq(JSON.stringify(before), snapshot, 'original untouched');
});

it('saved and passed are exclusive', () => {
  const passed = saved.setVerdict(saved.save({}, A), A, 'passed');
  notOk(saved.isSaved(passed, A), 'no longer saved');
  eq(saved.verdictOf(passed, A), 'passed');
});

it('setting the same verdict twice clears it', () => {
  const cleared = saved.setVerdict(saved.setVerdict({}, A, 'passed'), A, 'passed');
  eq(saved.verdictOf(cleared, A), null);
});

it('a passed book is not in the saved list', () => {
  const state = saved.setVerdict(saved.save({}, B), A, 'passed');
  eq(saved.savedIds(state), [B]);
  eq(saved.savedCount(state), 1);
});

// ---------------------------------------------------------------- migration

describe('persistence');

it('reads the old bare-string shape without losing a save', () => {
  const migrated = saved.migrate({ [A]: 'saved', [B]: 'passed' });
  ok(saved.isSaved(migrated, A), 'the save survived the upgrade');
  eq(saved.verdictOf(migrated, B), 'passed');
  eq(migrated[A].savedAt, null, 'no date is invented for it');
});

it('survives a round trip through JSON, as a reload would', () => {
  const state = saved.save({}, A, '2026-08-01T00:00:00.000Z');
  const reloaded = saved.migrate(JSON.parse(JSON.stringify(state)));
  ok(saved.isSaved(reloaded, A));
  eq(reloaded[A].savedAt, '2026-08-01T00:00:00.000Z');
});

it('discards junk in storage rather than throwing', () => {
  eq(saved.migrate({ x: 42, y: null, z: { nope: true } }), {});
  eq(saved.migrate(null), {});
  eq(saved.migrate(undefined), {});
});

// ---------------------------------------------------------------- listing

describe('saved list rendering');

const BOOKS = [
  { id: A, book: { title: 'Piranesi', author: 'Susanna Clarke' } },
  { id: B, book: { title: 'The Colony', author: 'Audrey Magee' } },
  { id: 'c', book: { title: 'Autumn', author: null } },
];

it('is empty when nothing is saved', () => {
  eq(saved.listSaved({}, BOOKS), []);
  ok(saved.EMPTY_COPY.startsWith('You haven’t saved any books yet.'), 'the specified copy');
});

it('lists most recently saved first by default', () => {
  let state = saved.save({}, A, '2026-01-01T00:00:00.000Z');
  state = saved.save(state, B, '2026-06-01T00:00:00.000Z');
  eq(saved.listSaved(state, BOOKS).map((r) => r.bookId), [B, A]);
});

it('sorts by title and by author surname', () => {
  let state = saved.save({}, A, '2026-01-01T00:00:00.000Z');
  state = saved.save(state, B, '2026-06-01T00:00:00.000Z');
  eq(saved.listSaved(state, BOOKS, 'title').map((r) => r.bookId), [A, B], 'Piranesi before The Colony');
  eq(saved.listSaved(state, BOOKS, 'author').map((r) => r.bookId), [A, B], 'Clarke before Magee');
});

it('puts an author-less book last when sorting by author', () => {
  let state = saved.save({}, 'c');
  state = saved.save(state, A);
  eq(saved.listSaved(state, BOOKS, 'author').map((r) => r.bookId).pop(), 'c');
});

it('sorts undated saves last under recently-saved', () => {
  const state = saved.migrate({ [A]: 'saved', [B]: { verdict: 'saved', savedAt: '2026-06-01T00:00:00.000Z' } });
  eq(saved.listSaved(state, BOOKS).map((r) => r.bookId), [B, A]);
});

it('skips a saved book the current build no longer carries', () => {
  const state = saved.save(saved.save({}, A), 'gone-from-the-feed');
  eq(saved.listSaved(state, BOOKS).map((r) => r.bookId), [A], 'not rendered');
  eq(saved.savedCount(state), 2, 'but the save is not thrown away');
});

// ---------------------------------------------------------------- analytics

describe('analytics');

it('records the five events the feature emits', () => {
  eq(Object.keys(EVENTS).sort(),
    ['book_saved', 'book_unsaved', 'retailer_chooser_opened', 'retailer_link_opened', 'saved_books_viewed']);
});

it('records retailer_link_opened with exactly the specified properties', () => {
  const log = record([], 'retailer_link_opened',
    { bookId: A, retailer: 'bookshop', linkResolution: 'isbn13' }, '2026-08-25T00:00:00.000Z');
  eq(log.length, 1);
  eq(log[0], { name: 'retailer_link_opened', at: '2026-08-25T00:00:00.000Z', bookId: A, retailer: 'bookshop', linkResolution: 'isbn13' });
});

it('drops properties an event did not declare', () => {
  // The privacy rule, enforced rather than trusted: an outbound URL cannot be
  // recorded by a caller that passes one in.
  const log = record([], 'retailer_link_opened',
    { bookId: A, retailer: 'amazon', linkResolution: 'asin', url: 'https://www.amazon.com/dp/X', account: 'someone@example.com' });
  notOk('url' in log[0], 'no outbound url');
  notOk('account' in log[0], 'no retailer account');
});

it('ignores an event it does not know', () => {
  eq(record([], 'something_else', { bookId: A }), []);
});

it('carries the resolution the link builder reported', () => {
  const link = linkFor('bookshop', ISBN10_ONLY, {});
  const log = record([], 'retailer_link_opened', { bookId: A, retailer: link.retailer, linkResolution: link.linkResolution });
  eq(log[0].linkResolution, 'isbn10', 'what the feed held, not what it converted to');
});

// ---------------------------------------------------------------- taste

describe('taste model');

const DIMENSIONS = [
  { id: 'D1', name: 'Historical causation', weight: 20 },
  { id: 'D2', name: 'Subject engine', weight: 14 },
  { id: 'D3', name: 'Formal ambition', weight: 18 },
  { id: 'D4', name: 'Prose register', weight: 24 },
  { id: 'D5', name: 'Tonal signature', weight: 6 },
  { id: 'D6', name: 'Scale and sprawl', weight: 10 },
  { id: 'D7', name: 'Independence and provenance', weight: 8 },
];

// A book with the seven dimension scores given, all fired unless listed as dark.
function book(id, scores, { tags = [], author = null, total = null, dark = [] } = {}) {
  const dimensions = {};
  DIMENSIONS.forEach((d, i) => {
    dimensions[d.id] = { dimension: d.id, score: scores[i], weight: d.weight, defaulted: dark.includes(d.id) };
  });
  const raw = total ?? Math.round(DIMENSIONS.reduce((s, d, i) => s + scores[i] * d.weight, 0) / 10);
  return {
    id, book: { title: id, author }, tags: tags.map((t) => ({ id: t, label: t.split(':')[1] || t, kind: t.split(':')[0] })),
    score: { total: raw, dimensions, filters: [] },
    outOfTen: Math.round(raw) / 10, recommended: raw >= 70,
  };
}

const HOT = [9, 8, 9, 8, 7, 9, 7, 0];
const COLD = [2, 3, 2, 3, 4, 2, 8, 0];

// Ten hot books saved, six cold ones passed. Tag kinds are deliberately mixed so
// the imprint-exclusion rule gets exercised.
const CORPUS = [
  ...Array.from({ length: 10 }, (_, i) => book(`hot${i}`, HOT, { tags: ['form:braided', 'period:period-set', 'imprint:Knopf'], author: `Writer ${i}` })),
  ...Array.from({ length: 6 }, (_, i) => book(`cold${i}`, COLD, { tags: ['period:sealed in the present', 'imprint:HQ Digital'], author: `Other ${i}` })),
  ...Array.from({ length: 8 }, (_, i) => book(`new${i}`, HOT, { tags: ['form:braided', 'imprint:Verso'], author: `Fresh ${i}` })),
  ...Array.from({ length: 8 }, (_, i) => book(`meh${i}`, COLD, { tags: ['period:sealed in the present', 'imprint:Titan'], author: `Bland ${i}` })),
];

const withVerdicts = (savedIds, passedIds = []) => {
  const v = {};
  savedIds.forEach((id, i) => { v[id] = { verdict: 'saved', savedAt: `2026-0${(i % 9) + 1}-01T00:00:00.000Z` }; });
  passedIds.forEach((id) => { v[id] = { verdict: 'passed', savedAt: null }; });
  return v;
};

const SAVED_IDS = Array.from({ length: 10 }, (_, i) => `hot${i}`);
const PASSED_IDS = Array.from({ length: 6 }, (_, i) => `cold${i}`);
const MODEL = buildTasteModel(withVerdicts(SAVED_IDS, PASSED_IDS), CORPUS, DIMENSIONS);

it('does nothing below the signal floor', () => {
  const thin = buildTasteModel(withVerdicts(['hot0', 'hot1']), CORPUS, DIMENSIONS);
  notOk(thin.ready, 'not ready on two saves');
  eq(tuneEntry(CORPUS[0], thin).delta, 0);
  eq(tunedTotal(CORPUS[20], thin).total, CORPUS[20].score.total, 'score untouched');
});

it('turns on at exactly the floor', () => {
  ok(buildTasteModel(withVerdicts(SAVED_IDS.slice(0, MIN_SIGNAL)), CORPUS, DIMENSIONS).ready);
  notOk(buildTasteModel(withVerdicts(SAVED_IDS.slice(0, MIN_SIGNAL - 1)), CORPUS, DIMENSIONS).ready);
});

it('learns the tags you save under and pass on', () => {
  const strong = MODEL.strongestTags.map((t) => t.label);
  const weak = MODEL.weakestTags.map((t) => t.label);
  ok(strong.includes('braided'), `braided in ${JSON.stringify(strong)}`);
  ok(weak.includes('sealed in the present'), `sealed in the present in ${JSON.stringify(weak)}`);
});

it('never learns an imprint', () => {
  // 127 of the feed's 186 tags are publisher names, nearly all on one or two
  // books. Learning from them produced "you pass on books tagged HQ Digital".
  for (const t of [...MODEL.strongestTags, ...MODEL.weakestTags]) notOk(t.kind === 'imprint', `${t.label} is an imprint`);
  notOk(MODEL.tags.has('imprint:Knopf'), 'Knopf never entered the tally');
});

it('boosts a book like the ones you saved and demotes one like the ones you passed', () => {
  const up = tuneEntry(CORPUS.find((b) => b.id === 'new0'), MODEL);
  const down = tuneEntry(CORPUS.find((b) => b.id === 'meh0'), MODEL);
  ok(up.delta > 0.5, `new0 moved ${up.delta}`);
  ok(down.delta < -0.5, `meh0 moved ${down.delta}`);
});

it('never moves a score by more than the cap', () => {
  for (const b of CORPUS) {
    const { delta } = tuneEntry(b, MODEL);
    ok(Math.abs(delta) <= MAX_ADJUSTMENT + 1e-9, `${b.id} moved ${delta}`);
  }
});

it('tunes the books you saved too — they are the ones you like', () => {
  for (const id of SAVED_IDS) {
    const t = tuneEntry(CORPUS.find((b) => b.id === id), MODEL);
    ok(t.judged, `${id} marked as judged`);
    ok(Math.abs(t.delta) > 0, `${id} was not tuned at all`);
  }
});

it('scores a saved book against the other saves, not against itself', () => {
  // Each save is about a tenth of its own evidence. Letting a book vote for
  // itself inflated the saves by 1.3 points on average against the real feed,
  // which puts your own collection at the top by construction.
  const target = CORPUS.find((b) => b.id === 'hot0');
  const withoutIt = buildTasteModel(withVerdicts(SAVED_IDS.filter((i) => i !== 'hot0'), PASSED_IDS), CORPUS, DIMENSIONS);
  eq(tuneEntry(target, MODEL).delta, tuneEntry(target, withoutIt).delta, 'held-out model matches one built without it');
});

it('does not hold out a book that was not judged', () => {
  const target = CORPUS.find((b) => b.id === 'new0');
  const looSize = MODEL.loo.size;
  tuneEntry(target, MODEL);
  eq(MODEL.loo.size, looSize, 'no leave-one-out model built for an unjudged book');
});

it('caches one held-out model per judged book', () => {
  const m = buildTasteModel(withVerdicts(SAVED_IDS, PASSED_IDS), CORPUS, DIMENSIONS);
  eq(m.loo.size, 0, 'nothing built until asked');
  tuneEntry(CORPUS.find((b) => b.id === 'hot0'), m);
  tuneEntry(CORPUS.find((b) => b.id === 'hot0'), m);
  eq(m.loo.size, 1, 'built once, reused');
  tuneEntry(CORPUS.find((b) => b.id === 'hot1'), m);
  eq(m.loo.size, 2);
});

it('leaves a saved book untuned when holding it out drops below the floor', () => {
  // Three saves minus the one being scored is two, and two is not a taste.
  const three = buildTasteModel(withVerdicts(SAVED_IDS.slice(0, 3)), CORPUS, DIMENSIONS);
  const t = tuneEntry(CORPUS.find((b) => b.id === 'hot0'), three);
  eq(t.delta, 0, 'keeps the profile’s own number');
  ok(t.heldOut, 'and says why');
  // A fourth save gives it something to compare against.
  const four = buildTasteModel(withVerdicts(SAVED_IDS.slice(0, 4)), CORPUS, DIMENSIONS);
  notOk(tuneEntry(CORPUS.find((b) => b.id === 'hot0'), four).heldOut, 'four saves is enough');
});

it('can demote a book you saved, which is the useful case', () => {
  // An outlier inside your own collection is worth seeing, and it is only
  // visible because saved books are scored rather than skipped.
  const odd = book('odd', COLD, { tags: ['period:sealed in the present'], author: 'Odd One' });
  const corpus = [...CORPUS, odd];
  const m = buildTasteModel(withVerdicts([...SAVED_IDS, 'odd'], PASSED_IDS), corpus, DIMENSIONS);
  ok(tuneEntry(odd, m).delta < 0, 'a save unlike your other saves is marked down');
});

it('keeps the base score alongside the tuned one', () => {
  const e = CORPUS.find((b) => b.id === 'new0');
  const t = tunedTotal(e, MODEL);
  eq(t.base, e.score.total, 'base preserved');
  eq(Math.round((t.base + t.delta) * 1e6) / 1e6, Math.round(t.total * 1e6) / 1e6);
});

it('holds the tuned score inside the scale', () => {
  const ceiling = book('ceiling', [10, 10, 10, 10, 10, 10, 10], { tags: ['form:braided'], total: 99 });
  const floor = book('floor', [0, 0, 0, 0, 0, 0, 0], { tags: ['period:sealed in the present'], total: 1 });
  const m = buildTasteModel(withVerdicts(SAVED_IDS, PASSED_IDS), [...CORPUS, ceiling, floor], DIMENSIONS);
  ok(tunedTotal(ceiling, m).total <= 100, 'no more than 100');
  ok(tunedTotal(floor, m).total >= 0, 'no less than 0');
});

it('gives a reason for every move it makes', () => {
  for (const b of CORPUS) {
    const t = tuneEntry(b, MODEL);
    if (Math.abs(t.delta) >= 0.3) ok(t.reasons.length > 0, `${b.id} moved ${t.delta} with no reason`);
  }
});

it('names the nearest book you saved', () => {
  const t = tuneEntry(CORPUS.find((b) => b.id === 'new0'), MODEL);
  ok(t.nearest, 'found an anchor');
  ok(SAVED_IDS.includes(t.nearest.id), 'the anchor is a saved book');
});

it('never anchors a book to itself', () => {
  const m = buildTasteModel(withVerdicts(SAVED_IDS), CORPUS, DIMENSIONS);
  for (const b of CORPUS) {
    const t = tuneEntry(b, m);
    if (t.nearest) notOk(t.nearest.id === b.id, `${b.id} anchored to itself`);
  }
});

it('does not tune on a dimension too few saves have evidence for', () => {
  const dark = Array.from({ length: 10 }, (_, i) => book(`d${i}`, HOT, { tags: ['form:braided'], dark: ['D4', 'D5'] }));
  const m = buildTasteModel(withVerdicts(dark.map((b) => b.id)), [...dark, ...CORPUS], DIMENSIONS);
  for (const id of ['D4', 'D5']) {
    const t = m.tilt.find((x) => x.id === id);
    notOk(t.enough, `${id} claimed enough evidence`);
    eq(t.delta, 0);
  }
});

it('tunes a thinly-read book less than a fully-read one', () => {
  // Evidence should buy influence. The first version divided by the fired weight
  // rather than the whole profile and got this exactly backwards.
  const full = book('full', HOT, { tags: ['form:braided'] });
  const thin = book('thin', HOT, { tags: ['form:braided'], dark: ['D2', 'D3', 'D4', 'D5', 'D7'] });
  const m = buildTasteModel(withVerdicts(SAVED_IDS, PASSED_IDS), [...CORPUS, full, thin], DIMENSIONS);
  const a = Math.abs(tuneEntry(full, m).delta);
  const b = Math.abs(tuneEntry(thin, m).delta);
  ok(a > b, `full ${a.toFixed(2)} should exceed thin ${b.toFixed(2)}`);
});

it('is symmetric — passes teach as much as saves', () => {
  const savesOnly = buildTasteModel(withVerdicts(SAVED_IDS), CORPUS, DIMENSIONS);
  const both = buildTasteModel(withVerdicts(SAVED_IDS, PASSED_IDS), CORPUS, DIMENSIONS);
  eq(savesOnly.weakestTags.length, 0, 'nothing to dislike without passes');
  ok(both.weakestTags.length > 0, 'passes produce negative signal');
});

it('does not mutate the feed or the verdicts', () => {
  const v = withVerdicts(SAVED_IDS, PASSED_IDS);
  const snapshot = JSON.stringify({ v, CORPUS });
  const m = buildTasteModel(v, CORPUS, DIMENSIONS);
  CORPUS.forEach((b) => tunedTotal(b, m));
  eq(JSON.stringify({ v, CORPUS }), snapshot, 'inputs untouched');
});

describe('weight proposal');

it('argues up a dimension your saves run hot on', () => {
  const p = weightProposal(MODEL, Object.fromEntries(DIMENSIONS.map((d) => [d.id, d.name])));
  const d1 = p.find((x) => x.id === 'D1');
  ok(d1, 'D1 proposed');
  ok(d1.delta > 0, `D1 argued ${d1.delta}`);
  ok(d1.savedMean > d1.fieldMean, 'because the saves run above the field');
});

it('proposes nothing before there is signal', () => {
  eq(weightProposal(buildTasteModel(withVerdicts(['hot0']), CORPUS, DIMENSIONS)), []);
});

it('keeps every proposal small', () => {
  // Deliberately timid. This is a suggestion to a human reading a calibration
  // report, not a gradient step.
  for (const p of weightProposal(MODEL)) ok(Math.abs(p.delta) <= 6, `${p.id} moved ${p.delta}`);
});

describe('vector');

it('measures distance as zero against itself and 1 at the extremes', () => {
  const weights = weightsFrom(DIMENSIONS);
  eq(distance(HOT, HOT, weights), 0);
  eq(Math.round(distance([0, 0, 0, 0, 0, 0, 0, 0], [10, 10, 10, 10, 10, 10, 10, 10], weights)), 1);
});

it('picks the nearest reference and reports the distance', () => {
  const weights = weightsFrom(DIMENSIONS);
  const refs = [{ id: 'a', vector: COLD }, { id: 'b', vector: HOT }];
  eq(nearestOf(HOT, refs, weights).id, 'b');
  eq(nearestOf(COLD, refs, weights).id, 'a');
  eq(nearestOf(HOT, [], weights), null);
});

it('averages only the dimensions that fired', () => {
  // A defaulted dimension is missing evidence, not a score of five; averaging it
  // in would pull every thin book toward the middle and make them all alike.
  const entries = [book('a', [10, 0, 0, 0, 0, 0, 0], { dark: ['D2'] }), book('b', [8, 4, 0, 0, 0, 0, 0])];
  const { mean, counts } = meanVector(entries);
  eq(mean[0], 9, 'D1 averaged across both');
  eq(counts[1], 1, 'D2 counted once');
  eq(mean[1], 4, 'D2 is b alone, not an average with a phantom zero');
});

it('reads a vector straight off a scored entry', () => {
  eq(vectorOf(book('x', HOT).score), HOT);
  eq(vectorOf(null), [0, 0, 0, 0, 0, 0, 0, 0]);
});

// ---------------------------------------------------------------- pre-rule bands

// Three of the profile's rules rewrite a dimension's score after the band is
// picked, and the band's own number used to be discarded. That is fine for one
// reader whose profile the rules encode and wrong for anyone else: a reader who
// likes a resolving twist cannot recover the 8 that braid earned by re-weighting,
// because the 8 was gone. Each rule now records what it moved and where from.

const PROFILE = JSON.parse(readFileSync(new URL('../profile/taste-profile.json', import.meta.url), 'utf8'));

// ------------------------------------------------- onboarding matches the profile

// The chips are `dimension:band` keys and buildProfile skips any band that does
// not exist - silently. Revision 3 moved four bands from D3 to D1 and gave D3 to
// Form, and six chips went on being offered while writing nothing at all. A
// question the app cannot answer is worse than no question, so this fails the
// build rather than waiting for someone to notice.
describe('onboarding asks only what the profile can hold');

it('every chip points at a band that exists', () => {
  const bands = Object.fromEntries(PROFILE.dimensions.map((d) => [d.id, new Set((d.bands || []).map((b) => b.id))]));
  const dead = CHIPS.filter((c) => !bands[c.dim]?.has(c.band)).map((c) => `${c.dim}:${c.band}`);
  eq(dead, [], 'chips pointing at bands the profile does not have');
});

it('every refusal points at a band that exists', () => {
  const bands = Object.fromEntries(PROFILE.dimensions.map((d) => [d.id, new Set((d.bands || []).map((b) => b.id))]));
  const dead = REFUSALS.filter((r) => {
    const [dim, band] = r.key.split(':');
    return !bands[dim]?.has(band);
  }).map((r) => r.key);
  eq(dead, [], 'refusals pointing at bands the profile does not have');
});

it('every dimension can be spoken to', () => {
  const covered = new Set(CHIPS.map((c) => c.dim));
  const silent = PROFILE.dimensions.filter((d) => !covered.has(d.id)).map((d) => d.name);
  eq(silent, [], 'dimensions carrying weight that onboarding never asks about');
});

const LEXICONS = JSON.parse(readFileSync(new URL('../profile/lexicons.json', import.meta.url), 'utf8'));
const scoreText = (text, extra = {}) =>
  scoreCandidate({ title: 'T', author: 'A', publisher: 'Graywolf', text, ...extra }, PROFILE, LEXICONS, new Date());

const ruleOn = (res, dim) => (res.dimensionRules || []).find((r) => r.dimension === dim);

describe('pre-rule bands');

it('twist override records the band it displaced', () => {
  const r = scoreText('Braided timelines carry the argument across two eras. The device finally resolves into a twist, a late revelation reframing the whole. Clean and functional prose.');
  const rule = ruleOn(r, 'D1');
  eq(rule.rule, 'twist_override');
  eq(rule.from.id, 'braid', 'the band the review actually earned');
  eq(rule.from.score, 8, 'braid is worth 8 before the rule');
  eq(rule.to, 3, 'the twist band the rule imposed');
  eq(r.dimensions.D1.preRule.score, 8, 'recoverable off the dimension too');
});

it('trap 4 records the land band at full value', () => {
  const r = scoreText('A single season on one farm. Water rights and the land title hang over a married couple. Spare and precise prose, elegiac.', { pages: 280 });
  const rule = ruleOn(r, 'D2');
  eq(rule.rule, 'trap4_land_scale');
  eq(rule.from.score, 10, 'land is worth 10 before the scale demotion');
  eq(rule.to, 6);
});

it('length without ambition records both demotions', () => {
  const long = scoreText('A conventional structure told straight through. Clean and functional prose about a marriage and a career.', { pages: 520 });
  eq(ruleOn(long, 'D6').rule, 'd6_sprawl_without_ambition');
  eq(ruleOn(long, 'D6').from.score, 10);
  eq(ruleOn(long, 'D6').to, 9);

  const mid = scoreText('A conventional structure told straight through. Clean and functional prose about a marriage and a career.', { pages: 430 });
  eq(ruleOn(mid, 'D6').rule, 'd6_length_without_ambition');
  eq(ruleOn(mid, 'D6').from.score, 9);
  eq(ruleOn(mid, 'D6').to, 6);
});

it('an unruled dimension carries its declared band score and no rule', () => {
  const r = scoreText('Spare and precise prose, elegiac and haunted throughout.');
  eq(r.dimensions.D4.id, 'spare');
  eq(r.dimensions.D4.bandScore, r.dimensions.D4.score, 'declared and stored agree');
  eq(r.dimensions.D4.ruleAdjusted, false);
  eq(r.dimensions.D4.preRule, undefined, 'nothing to undo, so nothing recorded');
});

it('a defaulted dimension has no band and so no declared score', () => {
  const r = scoreText('Spare and precise prose.');
  eq(r.dimensions.D6.defaulted, true, 'no page count given');
  eq(r.dimensions.D6.bandScore, null);
});

it('rules the review does not trigger leave the list empty', () => {
  const r = scoreText('Spare and precise prose, elegiac and haunted throughout.');
  eq(r.dimensionRules, []);
});

// ---------------------------------------------------------------- reader overrides

// The vocabulary is shared and the ordering is not. These check that a second
// reader can disagree with this profile's ranking without a rebuild, and that
// saying nothing leaves the profile's own number exactly as it was.

describe('reader overrides');

it('says nothing, changes nothing', () => {
  const r = scoreText('Braided timelines across two eras. Spare and precise prose, elegiac. A conventional structure otherwise.', { pages: 360 });
  const out = rescore(r, PROFILE, {});
  eq(isEmpty({}), true);
  eq(out.changed, false);
  eq(out.total, r.total, 'the profile keeps its own number');
});

it('undoes a rule the reader does not hold, and restores the band it displaced', () => {
  const r = scoreText('Braided timelines carry the argument across two eras. The device finally resolves into a twist, a late revelation reframing the whole. Spare and precise prose.', { pages: 360 });
  eq(r.dimensions.D1.id, 'device_twist', 'the profile applied its rule');
  const out = rescore(r, PROFILE, { rules: { twist_override: false } });
  eq(out.dimensions.D1.id, 'braid', 'the band the review earned comes back');
  eq(out.dimensions.D1.score, 8);
  eq(out.dimensions.D1.ruleUndone, 'twist_override');
  eq(out.total > r.total, true, 'a reader who likes a reveal scores it higher');
});

it('re-scores a band, and the ordering is the only thing that moved', () => {
  const r = scoreText('A farcical send-up, hilarious throughout. Spare and precise prose.', { pages: 320 });
  eq(r.dimensions.D5.id, 'comic', 'comic is worth 4 in this profile');
  eq(r.dimensions.D5.score, 4);
  const out = rescore(r, PROFILE, { bands: { [bandKey('D5', 'comic')]: 10 } });
  eq(out.dimensions.D5.score, 10);
  eq(out.dimensions.D5.bandRescored, { from: 4, to: 10 });
  eq(out.dimensions.D4.score, r.dimensions.D4.score, 'nothing else touched');
  eq(out.total > r.total, true);
});

it('applies a band override to the band the undone rule restored', () => {
  const r = scoreText('Braided timelines carry the argument across two eras. The device finally resolves into a twist, a late revelation reframing the whole. Spare and precise prose.', { pages: 360 });
  const out = rescore(r, PROFILE, {
    rules: { twist_override: false },
    bands: { [bandKey('D1', 'braid')]: 10, [bandKey('D1', 'device_twist')]: 1 },
  });
  eq(out.dimensions.D1.id, 'braid');
  eq(out.dimensions.D1.score, 10, 'the restored band is re-scored, not the displaced one');
});

it('re-weights a dimension', () => {
  const r = scoreText('Spare and precise prose. A conventional structure.', { pages: 320 });
  const heavier = rescore(r, PROFILE, { weights: { D4: 60 } });
  const lighter = rescore(r, PROFILE, { weights: { D4: 2 } });
  eq(heavier.total > lighter.total, true, 'prose carries more when it is weighted more');
  eq(heavier.dimensions.D4.contribution, Math.round(r.dimensions.D4.score * 60) / 10);
  eq(lighter.dimensions.D4.contribution, Math.round(r.dimensions.D4.score * 2) / 10);
});

it('rescoring never writes back into the entry it was given', () => {
  const r = scoreText('Spare and precise prose. A conventional structure.', { pages: 320 });
  const before = JSON.stringify(r);
  rescore(r, PROFILE, { weights: { D4: 60 }, bands: { [bandKey('D4', 'spare')]: 1 }, rules: { twist_override: false } });
  eq(JSON.stringify(r), before, 'one reader\'s ordering cannot leak into the stored feed');
});

it('drops a filter the reader does not hold', () => {
  const r = scoreText('A farcical, satirical send-up, comic throughout, a spoof and a lampoon. Spare and precise prose.', { pages: 320 });
  const penalised = (r.adjustments || []).find((a) => a.id === 'satire');
  eq(!!penalised, true, 'the profile penalises it');
  const out = rescore(r, PROFILE, { adjustments: { satire: false } });
  eq(out.total > r.total, true, 'a reader who likes satire gets the points back');
  eq(out.total - r.total >= 25, true, 'the whole penalty, not part of it');
});

it('reports what the reader changed in words', () => {
  const sum = summarize({ rules: { twist_override: false }, bands: { 'D5:comic': 9 }, weights: { D4: 10 } }, PROFILE);
  eq(sum.rules, ['twist_override']);
  eq(sum.bands[0].band, 'comic');
  eq(sum.bands[0].was, 4);
  eq(sum.bands[0].now, 9);
  eq(sum.weights[0].was, 16);
  eq(sum.weights[0].now, 10);
});

// ---------------------------------------------------------------- widened vocabulary

// New bands describe without judging until someone overrides them, which is the
// only way to add vocabulary to a scored profile without moving its numbers.

describe('widened vocabulary');

it('a new tone band fires where none of the profile\'s own did', () => {
  const r = scoreText('A hardboiled, wisecracking tour of the mean streets. Clean and functional prose.', { pages: 300 });
  eq(r.dimensions.D5.id, 'hardboiled');
  eq(r.dimensions.D5.defaulted, undefined, 'it fired rather than defaulting');
});

// Revision 3 made this half-true and the change is the point. A descriptive band
// is still worth exactly the dimension default, so naming it expresses no
// preference. But firing it is evidence, and evidence is what licenses a score
// to speak for a whole book, so the total moves even though the band did not.
// That is the shrinkage model working: knowing more about a book is allowed to
// change what we are willing to say about it.
it('a new band judges nothing, but knowing it is still evidence', () => {
  const withBand = scoreText('A hardboiled, wisecracking tour of the mean streets. Clean and functional prose.', { pages: 300 });
  const without = scoreText('Clean and functional prose.', { pages: 300 });
  eq(withBand.dimensions.D5.score, without.dimensions.D5.score, 'same number, named instead of blank');
  eq(withBand.dimensions.D5.score, 7, 'the dimension default, judging nothing');
  eq(withBand.evidenceWeight > without.evidenceWeight, true, 'but the evidence base widened');
});

it('the profile\'s own bands still win over the new ones', () => {
  const r = scoreText('An elegiac, haunted book, and a noir one. Clean and functional prose.', { pages: 300 });
  eq(r.dimensions.D5.id, 'elegiac', 'new bands are last in the pick order by design');
});

it('a reader can score a new band and it counts', () => {
  const r = scoreText('A hardboiled, wisecracking tour of the mean streets. Clean and functional prose.', { pages: 300 });
  const out = rescore(r, PROFILE, { bands: { [bandKey('D5', 'hardboiled')]: 10 } });
  eq(out.dimensions.D5.score, 10);
  eq(out.total > r.total, true);
});

it('a new subject band fires where the profile had no engine', () => {
  const r = scoreText('The detective works the homicide through to the courtroom and the verdict. Clean and functional prose.', { pages: 300 });
  eq(r.dimensions.D2.id, 'crime');
  eq(r.dimensions.D2.score, 5, 'the dimension default, judging nothing');
});

// ---------------------------------------------------------------- D6 propagation

describe('D6 reads the band Structure earned');

it('the twist rule does not travel into scale', () => {
  const text = 'Braided timelines carry the argument across two eras. The device finally resolves into a twist, a late revelation reframing the whole. Spare and precise prose.';
  const r = scoreText(text, { pages: 520 });
  eq(r.dimensions.D1.score, 3, 'the rule applies where it belongs');
  eq(r.dimensions.D6.id, 'sprawl');
  eq(r.dimensions.D6.score, 10, 'and not a second time on scale');
  eq(r.dimensionRules.some((x) => x.dimension === 'D6'), false, 'no scale demotion fired');
});

it('a genuinely unambitious long book is still demoted', () => {
  const r = scoreText('A conventional structure told straight through. Clean and functional prose about a marriage.', { pages: 520 });
  eq(r.dimensions.D6.score, 9);
  eq(r.dimensionRules.some((x) => x.rule === 'd6_sprawl_without_ambition'), true);
});

// ------------------------------------------------- merging two devices

describe('merging one reader\'s two devices');

const SAVED_AT = (iso) => ({ verdict: 'saved', savedAt: iso });

it('a book saved on one device only survives the merge', () => {
  const merged = mergeVerdicts({ a: SAVED_AT('2026-01-01T00:00:00Z') }, {});
  eq(merged.a.verdict, 'saved');
});

it('a book saved on the other device only survives the merge', () => {
  const merged = mergeVerdicts({}, { b: SAVED_AT('2026-01-01T00:00:00Z') });
  eq(merged.b.verdict, 'saved');
});

it('the earlier save wins, because that is when the reader decided', () => {
  const early = SAVED_AT('2026-01-01T00:00:00Z'), late = SAVED_AT('2026-06-01T00:00:00Z');
  eq(mergeVerdicts({ a: late }, { a: early }).a.savedAt, '2026-01-01T00:00:00Z');
  eq(mergeVerdicts({ a: early }, { a: late }).a.savedAt, '2026-01-01T00:00:00Z');
});

it('merging is the same whichever device runs it', () => {
  const x = { a: SAVED_AT('2026-01-01T00:00:00Z'), c: { verdict: 'passed', savedAt: null } };
  const y = { a: SAVED_AT('2026-03-01T00:00:00Z'), b: SAVED_AT('2026-02-01T00:00:00Z') };
  eq(mergeVerdicts(x, y), mergeVerdicts(y, x));
});

it('a dated save outranks one migrated from before timestamps existed', () => {
  const undated = { verdict: 'saved', savedAt: null }, dated = SAVED_AT('2026-01-01T00:00:00Z');
  eq(mergeVerdicts({ a: undated }, { a: dated }).a.savedAt, '2026-01-01T00:00:00Z');
  eq(mergeVerdicts({ a: dated }, { a: undated }).a.savedAt, '2026-01-01T00:00:00Z');
});

it('a bare string written by an older build is upgraded on the way in', () => {
  eq(mergeVerdicts({ a: 'saved' }, {}).a, { verdict: 'saved', savedAt: null });
});

it('a device that has heard of nothing cannot empty a list', () => {
  const local = { a: SAVED_AT('2026-01-01T00:00:00Z'), b: SAVED_AT('2026-01-02T00:00:00Z') };
  eq(saved.savedIds(mergeVerdicts(local, {})).length, 2);
  eq(saved.savedIds(mergeVerdicts({}, local)).length, 2);
});

// The bug this whole tombstone design exists for. Signed in, every unsave was
// followed by a sync: the server still held the save, the union merge read the
// deleted key as "unknown here", and the book came back on screen a second later.
// A signed-in reader could not remove a book at all.
it('unsaving stays unsaved after a sync', () => {
  const server = { a: SAVED_AT('2026-01-01T00:00:00Z') };
  const afterUnsave = saved.unsave(saved.migrate(server), 'a', '2026-02-01T00:00:00Z');
  const merged = mergeVerdicts(afterUnsave, server);
  notOk(saved.isSaved(merged, 'a'), 'the book does not come back');
  eq(saved.savedIds(merged), []);
});

it('a removal and a save disagree, and the later decision wins', () => {
  const tomb = { a: { verdict: null, removedAt: '2026-02-01T00:00:00Z' } };
  const early = { a: SAVED_AT('2026-01-01T00:00:00Z') };
  const late = { a: SAVED_AT('2026-03-01T00:00:00Z') };
  notOk(saved.isSaved(mergeVerdicts(tomb, early), 'a'), 'removed after it was saved');
  ok(saved.isSaved(mergeVerdicts(tomb, late), 'a'), 're-saved after it was removed');
});

it('a removal survives a round trip through storage', () => {
  const afterUnsave = saved.unsave(saved.save({}, 'a'), 'a', '2026-02-01T00:00:00Z');
  const reloaded = saved.migrate(JSON.parse(JSON.stringify(afterUnsave)));
  eq(reloaded.a.removedAt, '2026-02-01T00:00:00Z', 'the tombstone is not dropped on read');
  notOk(saved.isSaved(mergeVerdicts(reloaded, { a: SAVED_AT('2026-01-01T00:00:00Z') }), 'a'));
});

it('a tombstone is absent everywhere the list is counted', () => {
  const state = saved.unsave(saved.save(saved.save({}, 'a'), 'b'), 'a', '2026-02-01T00:00:00Z');
  eq(saved.savedCount(state), 1);
  eq(saved.verdictOf(state, 'a'), null);
  notOk(saved.isSaved(state, 'a'), 'not saved');
  eq(saved.listSaved(state, [{ id: 'a', book: { title: 'A' } }, { id: 'b', book: { title: 'B' } }]).map((r) => r.bookId), ['b']);
});

it('removing the same book on both devices agrees with itself', () => {
  const x = { a: { verdict: null, removedAt: '2026-02-01T00:00:00Z' } };
  const y = { a: { verdict: null, removedAt: '2026-03-01T00:00:00Z' } };
  eq(mergeVerdicts(x, y), mergeVerdicts(y, x));
  notOk(saved.isSaved(mergeVerdicts(x, y), 'a'));
});

it('an ordering is taken whole, from whichever device touched it last', () => {
  const older = stamp({ weights: { D1: 2 } }, '2026-01-01T00:00:00Z');
  const newer = stamp({ weights: { D4: 9 } }, '2026-05-01T00:00:00Z');
  eq(mergeOverrides(older, newer).weights, { D4: 9 });
  eq(mergeOverrides(newer, older).weights, { D4: 9 });
});

it('a stamped ordering beats an unstamped one', () => {
  const unstamped = { weights: { D1: 2 } };
  const stamped = stamp({ weights: { D4: 9 } }, '2026-05-01T00:00:00Z');
  eq(mergeOverrides(unstamped, stamped).weights, { D4: 9 });
  eq(mergeOverrides(stamped, unstamped).weights, { D4: 9 });
});

it('a first sign-in against an empty server keeps everything local', () => {
  const local = { verdicts: { a: SAVED_AT('2026-01-01T00:00:00Z') }, overrides: stamp({ weights: { D1: 3 } }) };
  const merged = mergeProfile(local, null);
  eq(merged.verdicts.a.verdict, 'saved');
  eq(merged.overrides.weights, { D1: 3 });
});

it('a fresh device adopts the server and loses nothing of its own', () => {
  const remote = { verdicts: { a: SAVED_AT('2026-01-01T00:00:00Z') }, overrides: stamp({ weights: { D1: 3 } }, '2026-01-01T00:00:00Z') };
  const merged = mergeProfile({ verdicts: {}, overrides: {} }, remote);
  eq(merged.verdicts.a.verdict, 'saved');
  eq(merged.overrides.weights, { D1: 3 });
});

it('merging twice changes nothing the second time', () => {
  const local = { verdicts: { a: SAVED_AT('2026-01-01T00:00:00Z') }, overrides: stamp({ weights: { D1: 3 } }, '2026-02-01T00:00:00Z') };
  const remote = { verdicts: { b: SAVED_AT('2026-03-01T00:00:00Z') }, overrides: stamp({ weights: { D4: 8 } }, '2026-04-01T00:00:00Z') };
  const once = mergeProfile(local, remote);
  eq(mergeProfile(once, remote), once);
});

it('theme and filters are not the reader, so the merge does not carry them', () => {
  const merged = mergeProfile({ verdicts: {}, overrides: {}, theme: 'dark' }, { verdicts: {}, overrides: {}, theme: 'light' });
  eq(Object.keys(merged).sort(), ['overrides', 'verdicts']);
});

// ------------------------------------------------- shelves and jackets

describe('shelves built from the reader\'s own weights');

const bk = (id, opts = {}) => ({
  id, listedOnly: false, recommended: false, lastReviewed: '2026-08-01T00:00:00Z',
  score: { total: 70, band: 'good' }, book: { title: `Book ${id}`, author: 'A N Other' },
  tags: [], ...opts,
});
const tagged = (id, kind, label, opts = {}) => bk(id, { tags: [{ kind, label, id: `${kind}:${label}` }], ...opts });

it('the heaviest dimension leads the shelves', () => {
  eq(rankedKinds({ weights: { D1: 1, D2: 1, D3: 1, D4: 99, D5: 1, D6: 1 } })[0], 'prose');
  eq(rankedKinds({ weights: { D1: 99, D2: 1, D3: 1, D4: 1, D5: 1, D6: 1 } })[0], 'period');
});

it('bookkeeping and imprint never become a shelf', () => {
  const kinds = rankedKinds({ weights: {} });
  for (const bad of ['caveat', 'attention', 'question', 'rule', 'press', 'imprint', 'genre']) {
    notOk(kinds.includes(bad), `${bad} is not a taste`);
  }
});

it('a band with too few scored books gets no shelf', () => {
  const books = [tagged('a', 'tone', 'wry'), tagged('b', 'tone', 'wry'), tagged('c', 'tone', 'wry')];
  const shelves = buildShelves(books, { weights: { D5: 99 } });
  notOk(shelves.some((s) => s.title === 'Wry'), 'three books is not a collection');
});

it('a band with enough scored books does', () => {
  const books = ['a', 'b', 'c', 'd', 'e'].map((id) => tagged(id, 'tone', 'wry'));
  const shelves = buildShelves(books, { weights: { D5: 99 } });
  ok(shelves.some((s) => s.title === 'Wry'), 'five books is');
});

it('the band word is not renamed, only sentence-cased for the heading', () => {
  const books = ['a', 'b', 'c', 'd'].map((id) => tagged(id, 'form', 'braided'));
  const shelf = buildShelves(books, { weights: { D3: 99 } }).find((s) => s.kind === 'form');
  eq(shelf.title, 'Braided');
});

it('unscored books never push scored ones off a shelf', () => {
  const books = [
    ...['a', 'b', 'c', 'd'].map((id) => tagged(id, 'form', 'braided', { listedOnly: true, score: null })),
    ...['e', 'f', 'g', 'h'].map((id) => tagged(id, 'form', 'braided')),
  ];
  const shelf = buildShelves(books, { weights: { D3: 99 } }).find((s) => s.kind === 'form');
  eq(shelf.books.slice(0, 4).map((b) => b.id), ['e', 'f', 'g', 'h'], 'the scored four lead');
});

it('one shelf per dimension before a second from any of them', () => {
  const books = [
    ...['a', 'b', 'c', 'd'].map((id) => tagged(id, 'form', 'braided')),
    ...['e', 'f', 'g', 'h'].map((id) => tagged(id, 'form', 'linear')),
    ...['i', 'j', 'k', 'l'].map((id) => tagged(id, 'tone', 'wry')),
  ];
  const kinds = buildShelves(books, { weights: { D3: 99, D5: 50 } }).filter((s) => s.kind !== 'standing').map((s) => s.kind);
  eq(kinds.slice(0, 2), ['form', 'tone'], 'the second form shelf waits its turn');
});

it('a shelf never renders the whole feed', () => {
  const books = Array.from({ length: 400 }, (_, i) => tagged(`b${i}`, 'form', 'braided'));
  const shelf = buildShelves(books, { weights: { D3: 99 } }).find((s) => s.kind === 'form');
  ok(shelf.books.length <= 24, 'capped');
  eq(shelf.total, 400, 'but it still says how many there are');
});

it('an empty feed produces no shelves rather than throwing', () => {
  eq(buildShelves([], {}), []);
  eq(buildShelves(null, null), []);
});

describe('the drawn jacket');

it('the same book always gets the same jacket', () => {
  const a = jacketFor({ id: 'x', title: 'A Book' });
  const b = jacketFor({ id: 'x', title: 'A Book' });
  eq(a.ground.id, b.ground.id);
  eq(a.rule, b.rule);
});

it('different books get different jackets', () => {
  const ids = Array.from({ length: 200 }, (_, i) => jacketFor({ id: `b${i}`, title: 't' }).ground.id);
  ok(new Set(ids).size >= 4, 'the shelf is not one colour');
});

it('the loudest ground is outnumbered rather than given equal billing', () => {
  const counts = {};
  for (let i = 0; i < 600; i++) { const g = jacketFor({ id: `b${i}`, title: 't' }).ground.id; counts[g] = (counts[g] || 0) + 1; }
  ok(counts.lacquer / 600 < 0.28, `lacquer is ${Math.round(counts.lacquer / 6)}% of the shelf`);
});

it('a long title is set smaller rather than cut', () => {
  eq(titleSize('Piranesi'), 'xl');
  eq(titleSize('A'.repeat(60)), 'sm');
});

it('a book with no id still gets a jacket', () => {
  const j = jacketFor({ title: 'Untitled Thing' });
  ok(GROUNDS.includes(j.ground), 'a real ground');
  eq(j.title, 'Untitled Thing');
});

it('the hash is stable across runs', () => {
  eq(hash('constant-reader'), hash('constant-reader'));
  ok(hash('a') !== hash('b'));
});

// ------------------------------------------------- the description a row shows

describe('cleaning a publication\'s standfirst');

const OUP = 'Literature and Learning: A History of English Studies in Britain';
const SHORES = 'Unwelcome Shores: Black Refugees in America';

it('a citation used as a heading comes off', () => {
  const raw = `${OUP} (Oxford University Press, 2025) by Stefan Collini The study and teaching of English literature is generally regarded as one of the central disciplines in the modern university.`;
  const out = cleanBlurb(raw, { title: OUP, author: 'Stefan Collini' });
  eq(out.startsWith('The study and teaching'), true, out.slice(0, 40));
});

// The bug the first draft of this shipped: the same cut applied to a sentence
// whose subject IS the title, leaving "Liberian refugee community in Staten
// Island..." with nothing to attach to.
it('a title doing grammatical work is kept, and only the parenthesis goes', () => {
  const raw = `${SHORES} (Rutgers University Press, 2025) is an ethnographic study of the Liberian refugee community in Staten Island, New York.`;
  const out = cleanBlurb(raw, { title: SHORES, author: '' });
  eq(out, `${SHORES} is an ethnographic study of the Liberian refugee community in Staten Island, New York.`);
});

it('no description ever starts mid-clause', () => {
  for (const raw of [
    `${SHORES} (Rutgers University Press, 2025) is an ethnographic study of the Liberian refugee community in Staten Island.`,
    `${OUP} (Oxford University Press, 2025) by Stefan Collini The study and teaching of English literature is a central discipline in the modern university.`,
    `${OUP} (Oxford University Press, 2025) explores the dark side of colonial modernity through the eyes of its own historians and their many students.`,
  ]) {
    const out = cleanBlurb(raw, { title: OUP.length > 4 ? raw.split(' (')[0] : '', author: 'Stefan Collini' });
    ok(/^["'“(]?[A-Z0-9]/.test(out), `starts with a capital: ${out.slice(0, 30)}`);
  }
});

it('the network\'s ad furniture is removed', () => {
  const body = 'A history of the nursery rhyme and the possibility of supplanting problematic ancient poems with new songs.';
  eq(cleanBlurb(`${body} Learn more about your ad choices. Visit megaphone.fm/adchoices`, {}), body);
});

it('the interviewer\'s sign-off is removed, and only from the end', () => {
  const body = 'A study of how doctoral candidates are trained across three universities.';
  const out = cleanBlurb(`${body} Jane Roe is a PhD candidate in history at Rutgers.`, {});
  eq(out, body, 'the book\'s own subject survives');
});

it('a description that needs nothing is returned as it was', () => {
  const clean = 'The relationship between humans and the environment in the United States reflects countless overlapping trends and tensions.';
  eq(cleanBlurb(clean, { title: 'Lessons for a Warming Planet' }), clean);
});

it('a standfirst that is only a citation is left alone rather than emptied', () => {
  const raw = `${SHORES} (Rutgers University Press, 2025)`;
  eq(cleanBlurb(raw, { title: SHORES }), raw);
});

it('empty in, empty out', () => {
  eq(cleanBlurb('', {}), '');
  eq(cleanBlurb(null, {}), '');
  eq(cleanBlurb(undefined, { title: 'x' }), '');
});

// ------------------------------------------------------- weekly roundup

// The one failure this feature can have that nothing else would catch. The app
// ships the public half of the VAPID pair and the sender signs with the private
// half; if the two ever stop being halves of the same pair — a regenerated key,
// a half-finished paste — every push is refused by the push service with a 403,
// no browser shows anything, and the only symptom is a Monday where nobody's
// phone buzzed. There is no user-visible error to notice.
{
  const { createPrivateKey, createPublicKey } = await import('node:crypto');
  const { existsSync, readFileSync } = await import('node:fs');
  const keyPath = new URL('../vapid.key', import.meta.url);

  it('the shipped VAPID public key is a P-256 point', () => {
    const bytes = Buffer.from(PUSH.VAPID_PUBLIC_KEY, 'base64url');
    eq(bytes.length, 65, 'a VAPID public key is 65 bytes');
    eq(bytes[0], 4, 'it is an uncompressed EC point, so it starts with 0x04');
  }, 'Weekly roundup');

  it('vapid.key is the private half of the key the app ships', () => {
    if (!existsSync(keyPath)) {
      // A clone without the key is a normal state — it is gitignored. Nothing
      // to check, and failing here would mean the suite could only pass on one
      // machine.
      return;
    }
    const raw = readFileSync(keyPath, 'utf8').trim();
    const d = Buffer.from(raw, 'base64url');
    eq(d.length, 32, 'a P-256 private key is 32 bytes');
    const prefix = Buffer.from('308141020100301306072a8648ce3d020106082a8648ce3d030107042730250201010420', 'hex');
    const der = Buffer.concat([prefix, d]);
    const pem = `-----BEGIN PRIVATE KEY-----\n${der.toString('base64').replace(/(.{64})/g, '$1\n')}\n-----END PRIVATE KEY-----\n`;
    const spki = createPublicKey(createPrivateKey(pem)).export({ type: 'spki', format: 'der' });
    const derived = Buffer.from(spki.subarray(spki.length - 65)).toString('base64url');
    eq(derived, PUSH.VAPID_PUBLIC_KEY, 'the key in vapid.key must derive the key push.mjs ships');
  }, 'Weekly roundup');
}


// ---------------------------------------------------------------- search

// A small hand-built corpus rather than the real feed, because these assert what
// the parser and the ranker do rather than what happens to be in the archive
// this morning. Nothing here should change when the crawl runs.
function bookFixture(over = {}) {
  return {
    id: over.id || 'x',
    book: {
      title: 'A Book', author: 'A Writer', description: '', publisher: 'A Press',
      pages: null, bookYear: 2025, translated: false, subjects: [], ...(over.book || {}),
    },
    mentions: over.mentions || [],
    tags: (over.tags || []).map((label) => ({ id: `t:${label}`, label, kind: 'subject' })),
    fiction: over.fiction || 'confirmed',
    score: over.score || { total: 50, dimensions: {} },
  };
}

describe('reading a query');

it('strips the ask and keeps the request', () => {
  const q = parseQuery('I want recommendations for a funny novel');
  ok(q.tags.some((t) => t.label === 'comic'), 'the tone concept fires');
  ok(!q.terms.includes('want'), '"want" is not a search term');
  ok(!q.terms.includes('recommendation'), 'the ask is not a search term');
});

it('claims the longest concept first', () => {
  const q = parseQuery('a great american novel');
  ok(q.concepts.includes('great american novel'), 'the three-word phrase wins');
  ok(q.tags.some((t) => t.label === 'generational sweep'), 'and brings its bands');
});

it('reads a length, a kind and a translation as requirements', () => {
  const q = parseQuery('short nonfiction in translation');
  eq(q.facets.maxPages, 300, 'short means under 300 pages');
  eq(q.facets.kind, 'nonfiction');
  eq(q.facets.translated, true);
});

it('does not leave the kind word in the search terms', () => {
  // "nonfiction about artificial intelligence" was matching the literal word
  // "nonfiction" in review copy and ranking on it.
  const q = parseQuery('nonfiction about artificial intelligence');
  ok(!q.terms.includes('nonfiction'), 'the kind is a facet, not a term');
  ok(q.tags.some((t) => t.label === 'technology & power'), 'the subject still fires');
});

it('reads an explicit page ceiling in preference to "short"', () => {
  eq(parseQuery('short books under 150 pages').facets.maxPages, 150);
});

it('separates the words the reader typed from the ones it added', () => {
  const q = parseQuery('books about grief');
  ok(q.typed.length === 0 || !q.typed.includes('mourning'), 'an expansion is not something they typed');
  ok(q.terms.includes('mourn') || q.terms.includes('mourning'), 'but it is still searched for');
});

it('takes a resemblance whole', () => {
  eq(parseQuery('something like Rachel Cusk').facets.similarTo, 'rachel cusk');
  eq(parseQuery('in the vein of The Overstory').facets.similarTo, 'the overstory');
});

it('an empty query asks for nothing', () => {
  eq(parseQuery('   ').empty, true);
});

describe('ranking an answer');

const SEARCH_CORPUS = [
  bookFixture({ id: 'right', book: { title: 'The Long Field', pages: 240, description: 'A comic novel about office work in America.' }, tags: ['comic', 'work & the economy'] }),
  bookFixture({ id: 'tagonly', book: { title: 'Elsewhere', pages: 220, description: 'Nothing to do with the question.' }, tags: ['comic'] }),
  bookFixture({ id: 'toolong', book: { title: 'The Doorstop', pages: 900, description: 'A comic novel about office work.' }, tags: ['comic', 'work & the economy'] }),
  bookFixture({ id: 'unrelated', book: { title: 'Sediment', pages: 200, description: 'Coastal geology of the Baltic.' }, tags: ['science'] }),
];
const IDX = buildSearchIndex(SEARCH_CORPUS);
const ids = (r) => r.results.map((x) => x.e.id);

it('a book matching band and word beats a book matching band alone', () => {
  const r = runSearch('funny books about work', SEARCH_CORPUS, { index: IDX });
  eq(ids(r)[0], 'right', 'the one that answers on two counts leads');
});

it('a length is a requirement, not a preference', () => {
  const r = runSearch('funny books about work under 300 pages', SEARCH_CORPUS, { index: IDX });
  ok(!ids(r).includes('toolong'), 'a 900-page book is not a short book however well it matches');
});

it('nothing irrelevant is returned however it scores', () => {
  const r = runSearch('funny books about work', SEARCH_CORPUS, { index: IDX });
  ok(!ids(r).includes('unrelated'), 'the geology book answers no part of the question');
});

it('taste reorders answers and never creates them', () => {
  // The unrelated book is given a perfect fit. It must still not appear, because
  // relevance is a multiplier and zero times anything is zero.
  const fitOf = (e) => (e.id === 'unrelated' ? 10 : 1);
  const r = runSearch('funny books about work', SEARCH_CORPUS, { index: IDX, fitOf });
  ok(!ids(r).includes('unrelated'), 'a perfect fit cannot answer a question it does not match');
});

it('a profile can move a genuine answer up', () => {
  const plain = runSearch('funny books about work', SEARCH_CORPUS, { index: IDX });
  const tuned = runSearch('funny books about work', SEARCH_CORPUS, {
    index: IDX, fitOf: (e) => (e.id === 'tagonly' ? 10 : 1),
  });
  ok(plain.results.length === tuned.results.length, 'the same books answer either way');
  ok(tuned.results.findIndex((x) => x.e.id === 'tagonly')
     <= plain.results.findIndex((x) => x.e.id === 'tagonly'), 'fit lifts it');
});

it('a facet-only query still ranks', () => {
  const r = runSearch('short fiction', SEARCH_CORPUS, { index: IDX });
  ok(r.results.length > 0, 'asking only for a length is a real question');
  ok(r.results.every((x) => x.relevance > 0.2), 'and the answers are not scraping a floor');
});

it('every row says why it is there', () => {
  const r = runSearch('funny books about work', SEARCH_CORPUS, { index: IDX });
  ok(r.results.every((x) => x.why && x.why.length > 3), 'no unexplained result');
});

it('the index weights a title above a description', () => {
  const corpus = [
    bookFixture({ id: 'titled', book: { title: 'Sediment', description: 'A novel.' } }),
    bookFixture({ id: 'mentioned', book: { title: 'Elsewhere', description: 'sediment sediment' } }),
  ];
  const r = runSearch('sediment', corpus, { index: buildSearchIndex(corpus) });
  eq(r.results[0].e.id, 'titled', 'a reader typing a title wants that book');
});

it('tokenizing collapses a plural onto its singular', () => {
  eq(searchTokens('cities'), ['city']);
  // "novel" is deliberately kept: it is the signal behind the "a novel" form tag.
  eq(searchTokens('books about grief'), ['grief'], 'and the stopwords go');
  ok(!searchTokens('happiness').includes('happines'), 'a double s is not a plural');
});


// ---------------------------------------------------------------- archives

// These assert the shape of the index each publication keeps, against captured
// markup rather than the live site. A parser that silently returns nothing is
// the failure mode here: bin/archive.mjs would advance its cursor, log "0
// found", and walk the whole five years discovering nothing at all.
describe('reading a back-issue index');

const archive = (id) => ARCHIVES.find((a) => a.id === id);

it('the NYT sitemap yields only book reviews', () => {
  const body = `
    <url><loc>https://www.nytimes.com/2019/06/14/us/politics/some-story.html</loc></url>
    <url><loc>https://www.nytimes.com/2019/06/14/books/review/the-nickel-boys-colson-whitehead.html</loc></url>
    <url><loc>https://www.nytimes.com/2019/06/02/books/review/machines-like-me-ian-mcewan.html</loc></url>`;
  const out = archive('nyt-archive').parse(body, { label: '2019-06' });
  eq(out.length, 2, 'the politics story is not a book review');
  eq(out[0].reviewDate, '2019-06-14T12:00:00.000Z', 'the date comes out of the path');
  ok(out[0].url.endsWith('.html'));
});

it('the LRB issue page yields one address per piece and no duplicates', () => {
  const body = `
    <a href="/the-paper/v48/n01/tom-stevenson/climbing-the-ziggurat">x</a>
    <a href="/the-paper/v48/n01/tom-stevenson/climbing-the-ziggurat">x again</a>
    <a href="/the-paper/v48/n01/tony-wood/short-cuts">y</a>
    <a href="/contributors/tom-stevenson">not a piece</a>`;
  const out = archive('lrb-archive').parse(body, { label: 'v48/n01' });
  eq(out.length, 2, 'the contributor page is not a review and the repeat is one address');
  eq(out[0].url, 'https://www.lrb.co.uk/the-paper/v48/n01/tom-stevenson/climbing-the-ziggurat');
});

it('the LRB volume is the year less 1978', () => {
  // Volume 43 opened on 7 January 2021 and volume 48 on 22 January 2026, both
  // checked against the live issue pages. Getting this wrong walks the crawl
  // through five years of 404s and reports them as empty issues.
  const slices = archive('lrb-archive').slices(new Date().getFullYear() - 5);
  const vols = [...new Set(slices.map((s) => s.vol))];
  eq(vols[0], new Date().getFullYear() - 1978, 'this year is this volume');
  eq(slices[0].n, 1, 'issues run up from n01, because the current volume is part-published');
});

it('LARB reads the Next.js payload and survives a page without one', () => {
  const a = archive('larb-archive');
  const good = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
    { props: { pageProps: { articles: { docs: [{ slug: 'a-review', title: 'A Review', publish_date: '2024-01-02' }] } } } })}</script>`;
  eq(a.parse(good, { label: 'page 4' }).length, 1);
  eq(a.parse('<html>an error page</html>', { label: 'page 4' }), [], 'no payload is no results, not a throw');
});

it('4Columns keeps the book rows and drops the rest', () => {
  const body = `
    <a href="/literature/this-poor-book">06.26.26 This Poor Book</a>
    <a href="/art/some-show">06.26.26 A Gallery Show</a>
    <a href="/poetry/incinarration">06.19.26 Incinarration</a>`;
  const out = archive('4columns-archive').parse(body, { label: 'the whole run' });
  eq(out.length, 2, 'the gallery show is not a book');
  eq(out[0].reviewDate, '2026-06-26T12:00:00.000Z', 'two-digit dates are this century');
});

it('every archive can name its slices and build a URL for the first', () => {
  for (const a of ARCHIVES) {
    const slices = a.slices(new Date().getFullYear() - 5);
    ok(slices.length > 0, `${a.id} has work to do`);
    ok(/^https:\/\//.test(a.url(slices[0])), `${a.id} builds a URL`);
    ok(slices[0].label, `${a.id} labels its slices`);
  }
});


// ---------------------------------------------------------------- covers

// The bug these exist to stop coming back, in both the forms it took. Every
// cover shipped at Google's default zoom=1, which is 128px wide. Then it shipped
// at a fixed width per slot, which was measured on a desktop shelf where the
// card is 222px — and the same card is 317px on a 375px phone, drawn at three
// device pixels to the point. Nothing errored either time. It just looked soft.
describe('asking a cover host for the right size');

const GB = 'https://books.google.com/books/content?id=abc&printsec=frontcover&img=1&zoom=1&source=gbs_api';
const OL = 'https://covers.openlibrary.org/b/id/15240354-M.jpg';
const widthOf = (u) => Number(new URL(u).searchParams.get('w'));

it('Google Books is offered a ladder, not one width', () => {
  const c = coverFor(GB, 'card');
  const widths = c.srcset.split(', ').map((p) => Number(p.split(' ')[1].replace('w', '')));
  eq(widths, SLOTS.card.ladder);
  // Each entry asks the host for the width it claims to be.
  for (const part of c.srcset.split(', ')) {
    const [url, desc] = part.split(' ');
    eq(widthOf(url), Number(desc.replace('w', '')), 'the URL matches its descriptor');
  }
});

it('the card ladder reaches what a phone actually asks for', () => {
  // 317 CSS px at three device pixels to the point is a little over 950.
  ok(SLOTS.card.ladder[SLOTS.card.ladder.length - 1] >= 950, 'the top rung covers a phone');
  ok(/max-width/.test(SLOTS.card.sizes), 'and sizes describes both layouts');
});

it('the src fallback is not the widest rung', () => {
  // A browser that ignores srcset should not be handed a megabyte a card.
  const c = coverFor(GB, 'card');
  ok(widthOf(c.src) < SLOTS.card.ladder[SLOTS.card.ladder.length - 1]);
});

it('the page-curl decoration is refused', () => {
  ok(!coverFor(`${GB}&edge=curl`, 'card').src.includes('edge='), 'a paper-curl effect is not the jacket');
});

it('an http cover is upgraded, because a https page will not load it', () => {
  ok(coverFor(GB.replace('https:', 'http:'), 'card').src.startsWith('https:'));
});

it('Open Library claims no widths it cannot verify', () => {
  // L is 328px on one book and larger on others, so a w descriptor would be a
  // guess the browser acts on.
  const c = coverFor(OL, 'card');
  eq(c.srcset, '');
  ok(c.src.endsWith('-L.jpg'));
  ok(coverFor(OL, 'row').src.endsWith('-M.jpg'), 'the row still gets M, never S');
});

it('a host it does not know is passed through', () => {
  const other = 'https://example.com/jacket.jpg';
  eq(coverFor(other, 'card').src, other);
  eq(coverFor('', 'card'), null);
  eq(coverFor(null, 'card'), null);
});

it('every slot has a ladder and a sizes rule', () => {
  for (const [name, slot] of Object.entries(SLOTS)) {
    ok(slot.ladder.length >= 2, `${name} offers a choice`);
    ok(slot.sizes.length > 0, `${name} says how wide it is`);
    ok(slot.ladder.every((w, i, a) => i === 0 || w > a[i - 1]), `${name} ascends`);
  }
});

it('coverUrl still answers for a single width', () => {
  eq(widthOf(coverUrl(GB, 460)), 460);
  eq(coverUrl(''), '');
});

describe('a cover that cannot fill its slot');

it('a small jacket is fine in a row and not on a card', () => {
  // 194 of the archive's covers are 300-499px. That is more than a 60px row
  // needs and a fraction of what a card on a phone does.
  ok(fillsSlot(400, 'row'), 'a row asks for 120');
  ok(fillsSlot(400, 'dossier'), 'the dossier asks for 260');
  ok(fillsSlot(400, 'spotlight'), 'the spotlight asks for 340');
  notOk(fillsSlot(400, 'card'), 'a card asks for 680');
});

it('a large jacket fills everything', () => {
  for (const slot of Object.keys(SLOTS)) ok(fillsSlot(1000, slot), slot);
});

it('a tiny one fills nothing but the row', () => {
  notOk(fillsSlot(100, 'row'));
  notOk(fillsSlot(100, 'card'));
});

it('an unmeasured cover is assumed to be fine', () => {
  // Discarding real jackets over a fact nobody established is the same mistake
  // as scoring a book on defaults.
  for (const slot of Object.keys(SLOTS)) ok(fillsSlot(null, slot), slot);
  ok(fillsSlot(undefined, 'card'));
});

it('every slot asks for no more than its widest rung', () => {
  for (const [name, slot] of Object.entries(SLOTS)) {
    ok(slot.needs <= slot.ladder[slot.ladder.length - 1],
      `${name} cannot require more than it would ever request`);
  }
});

// ---------------------------------------------------------------- descriptions

// The row prints one sentence about a book and it is the most-read text in the
// app. Two failures put a web page there instead: a few publications syndicate
// their own CMS chrome inside the description field, and 588 of 823 books carry
// a publisher's description that was never looked at.
describe('choosing what a row says about a book');

const wlt = 'FICTION [email removed] Mon, 08/24/2026 - 15:42 Author: Morgan Day Astra House. 2026. 192 pages. If ever there were a phrase I would not have expected to include in a book review, it would be this one.';
const ancillary = 'Matthew Eatough Under Review:Electric Shamans at the Festival of the Sun. Monica Ojeda, translated by Sarah Booker. Coffee House Press, May 2026. It is fascinating to consider why cutting-edge developments within a genre often seem to cluster.';

it('the section label, the address and the citation come off the front', () => {
  const out = cleanBlurb(wlt, { title: 'The Oldest Bitch Alive', author: 'Morgan Day' });
  ok(out.startsWith('If ever there were a phrase'), `got: ${out.slice(0, 60)}`);
  ok(!out.includes('[email removed]'));
  ok(!out.includes('15:42'));
});

it('a reviewer byline and an "Under Review" heading come off too', () => {
  const out = cleanBlurb(ancillary, { title: 'Electric Shamans at the Festival of the Sun' });
  ok(out.startsWith('It is fascinating'), `got: ${out.slice(0, 60)}`);
});

it('a review that mentions a page count keeps its sentence', () => {
  // The furniture rules are anchored to the start; a critic writing about length
  // is not a form.
  const real = 'Ferrante gives the reader 400 pages. What she does with them is the argument of this review, and it is a good one.';
  eq(cleanBlurb(real, { title: 'Some Novel' }), real);
});

it('a form is never a description, however little else there is', () => {
  ok(!isUsableBlurb('Critics: 11 Rave, 1 Mixed, 1 Pan.'), 'a critic tally is a tally');
  ok(!isUsableBlurb('FICTION [email removed] Mon, 08/24/2026 - 15:42 Author: Morgan Day'));
  ok(!isUsableBlurb('short'), 'and neither is a fragment');
  ok(isUsableBlurb('A polyphonic debut following an aging French bulldog and the parasitic worms that send it wandering.'));
});

it('the critic is preferred, and the publisher is the fallback', () => {
  const critic = 'A polyphonic debut following an aging bulldog, told in four voices across sixty years of one town.';
  const listed = 'The electrifying new novel from a National Book Award finalist, now in paperback.';
  const withCritic = { book: { title: 'X', author: 'Y', description: listed }, mentions: [{ standfirst: critic }] };
  eq(bestBlurb(withCritic).from, 'review');
  eq(bestBlurb(withCritic).text, critic);

  // The same book where the only standfirst is the page it came from.
  const junkOnly = { book: { title: 'X', author: 'Y', description: listed }, mentions: [{ standfirst: 'Critics: 4 Rave.' }] };
  eq(bestBlurb(junkOnly).from, 'publisher');
  eq(bestBlurb(junkOnly).text, listed);
});

it('nothing usable anywhere returns nothing, not a form', () => {
  const bare = { book: { title: 'X', description: '' }, mentions: [{ standfirst: 'Critics: 4 Rave.' }] };
  eq(bestBlurb(bare).text, '');
  eq(bestBlurb(bare).from, 'none');
});

it('a long text is cut at a word', () => {
  const long = { book: { title: 'X', description: `${'word '.repeat(200)}end` }, mentions: [] };
  const out = bestBlurb(long, { max: 60 }).text;
  ok(out.length <= 61, `got ${out.length}`);
  ok(out.endsWith('…'));
  ok(!/\s\S{1,3}…$/.test(out) || out.endsWith('word…'), 'cut on a boundary');
});


// ------------------------------------------------------- learning from a pass

// The model used to switch on at three saves and at nothing else, so a reader
// who passed on twenty books in a row taught it nothing: the passes were
// recorded, the books disappeared, and every remaining score was what the
// profile had already said.
describe('a pass is evidence too');

function tasteBook(id, tags, dims = {}) {
  return {
    id,
    book: { title: id, author: `${id} author`, pages: 300 },
    tags: tags.map((label) => ({ id: `subject:${label}`, label, kind: 'subject' })),
    score: {
      total: 50,
      dimensions: Object.fromEntries(['D1','D2','D3','D4','D5','D6','D7','D8']
        .map((d) => [d, { id: 'x', score: dims[d] ?? 5, defaulted: dims[d] == null }])),
    },
  };
}
const TDIMS = ['D1','D2','D3','D4','D5','D6','D7','D8'].map((id, i) => ({ id, name: id, weight: [16,26,12,20,10,8,8,0][i] }));
const CORPUS_T = [
  ...Array.from({ length: 6 }, (_, i) => tasteBook(`sat${i}`, ['satire'], { D2: 4 })),
  ...Array.from({ length: 6 }, (_, i) => tasteBook(`land${i}`, ['land & labour'], { D2: 9 })),
];
const verdictsOf = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { verdict: v, at: 1 }]));

it('five passes and no saves are enough to start learning', () => {
  const passesOnly = verdictsOf(Object.fromEntries(
    ['sat0','sat1','sat2','sat3','sat4'].map((id) => [id, 'passed'])));
  const m = buildTasteModel(passesOnly, CORPUS_T, TDIMS);
  ok(m.ready, 'the model has something to say');
  notOk(m.anchored, 'but it has no positive example to anchor on');
  eq(m.savedCount, 0);
  eq(m.passedCount, 5);
});

it('four verdicts are not', () => {
  const four = verdictsOf(Object.fromEntries(['sat0','sat1','sat2','sat3'].map((id) => [id, 'passed'])));
  notOk(buildTasteModel(four, CORPUS_T, TDIMS).ready);
});

it('passes mark down the tags they carry, and say so', () => {
  const passesOnly = verdictsOf(Object.fromEntries(
    ['sat0','sat1','sat2','sat3','sat4'].map((id) => [id, 'passed'])));
  const m = buildTasteModel(passesOnly, CORPUS_T, TDIMS);
  const t = tuneEntry(tasteBook('new', ['satire'], { D2: 4 }), m);
  ok(t.delta < 0, `a book carrying the refused tag is marked down, got ${t.delta}`);
  ok(t.reasons.some((r) => /pass on books tagged satire/.test(r.label)), 'and the row can say why');
});

it('a passes-only model never invents a positive anchor', () => {
  // There is no such thing as the average of the books you refused standing in
  // for a book you would want.
  const passesOnly = verdictsOf(Object.fromEntries(
    ['sat0','sat1','sat2','sat3','sat4'].map((id) => [id, 'passed'])));
  const m = buildTasteModel(passesOnly, CORPUS_T, TDIMS);
  eq(m.references, [], 'nothing to be nearest to');
  ok(m.tilt.every((t) => !t.enough), 'and no dimension tilt');
  eq(tuneEntry(tasteBook('new', ['land & labour'], { D2: 9 }), m).nearest, null);
});

it('three saves still anchor it, as before', () => {
  const saves = verdictsOf({ land0: 'saved', land1: 'saved', land2: 'saved' });
  const m = buildTasteModel(saves, CORPUS_T, TDIMS);
  ok(m.ready);
  ok(m.anchored, 'saves are what anchor it');
  eq(m.savedCount, MIN_SIGNAL);
});

it('the two floors are what the code says they are', () => {
  eq(MIN_SIGNAL, 3);
  eq(MIN_JUDGMENTS, 5);
  ok(MIN_JUDGMENTS > MIN_SIGNAL, 'a pass is weaker evidence than a save, so more are asked for');
});


// ------------------------------------------------------------ the reserve slot

// A feed sorted strictly by score only ever offers what it already believes, so
// a model that is wrong about a reader never finds out. One slot is spent on the
// book whose verdict would resolve the most of what it does not know.
describe('the one it cannot place');

// A corpus with three tag families. The reader has ruled only on satire.
const EXPLORE_CORPUS = [
  ...Array.from({ length: 10 }, (_, i) => tasteBook(`sat${i}`, ['satire'])),
  ...Array.from({ length: 12 }, (_, i) => tasteBook(`land${i}`, ['land & labour'])),
  ...Array.from({ length: 9 }, (_, i) => tasteBook(`faith${i}`, ['faith'])),
  // A tag on two books: a coincidence, not a thing to learn about.
  ...Array.from({ length: 2 }, (_, i) => tasteBook(`odd${i}`, ['sport'])),
];
const JUDGED_SATIRE = verdictsOf(Object.fromEntries(
  ['sat0', 'sat1', 'sat2', 'sat3', 'sat4'].map((id) => [id, 'passed'])));
const EX_MODEL = buildTasteModel(JUDGED_SATIRE, EXPLORE_CORPUS, TDIMS);

it('picks a tag family the reader has never ruled on', () => {
  const eligible = EXPLORE_CORPUS.filter((e) => !JUDGED_SATIRE[e.id]);
  const pick = explore(eligible, EX_MODEL);
  ok(pick, 'there is something to learn');
  ok(!/^sat/.test(pick.entry.id), 'not the family already ruled on');
  ok(pick.tags.every((t) => !EX_MODEL.tags.has(t.id)), 'every named tag is genuinely unseen');
});

it('prefers the family that explains more of the corpus', () => {
  const eligible = EXPLORE_CORPUS.filter((e) => !JUDGED_SATIRE[e.id]);
  const pick = explore(eligible, EX_MODEL);
  // land & labour is on 12 books, faith on 9. A verdict on the first is worth more.
  eq(pick.tags[0].label, 'land & labour');
});

it('ignores a tag too rare to be worth learning', () => {
  // 'sport' is on two books. An explorer that chased those would offer a
  // different obscurity every day and learn nothing that transfers.
  const only = EXPLORE_CORPUS.filter((e) => /^odd/.test(e.id));
  eq(explore(only, EX_MODEL), null);
  eq(unknownCoverage(only[0], EX_MODEL).tags, []);
});

it('a tag already ruled on is not unknown', () => {
  const c = unknownCoverage(EXPLORE_CORPUS.find((e) => e.id === 'sat9'), EX_MODEL);
  eq(c.tags, [], 'satire has had five verdicts');
  eq(c.score, 0);
});

it('there is nothing to explore before the model is ready', () => {
  const cold = buildTasteModel({}, EXPLORE_CORPUS, TDIMS);
  notOk(cold.ready);
  eq(explore(EXPLORE_CORPUS, cold), null);
  eq(unknownCoverage(EXPLORE_CORPUS[0], cold).score, 0);
});

it('the caller decides what is eligible', () => {
  // A reserve pick that duplicates the shelf spends the slot on nothing, so the
  // exclusion is the caller's business and explore honours whatever it is given.
  const narrowed = EXPLORE_CORPUS.filter((e) => /^faith/.test(e.id));
  eq(explore(narrowed, EX_MODEL).tags[0].label, 'faith');
  eq(explore([], EX_MODEL), null);
});

// ---------------------------------------------------------------- report

const w = (s, n) => String(s).padEnd(n).slice(0, n);
let current = '';
console.log(`\n  Saved books - unit tests\n`);
for (const r of results) {
  if (r.group !== current) { current = r.group; console.log(`  ${DIM}${current}${OFF}`); }
  console.log(`  ${r.ok ? `${GREEN} ok ${OFF}` : `${RED} XX ${OFF}`}${w(r.name, 62)}${r.ok ? '' : `${RED}${r.why}${OFF}`}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n  ${results.length - failed.length}/${results.length} tests pass.\n`);
if (failed.length) process.exit(1);
