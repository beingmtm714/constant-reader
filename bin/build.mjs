#!/usr/bin/env node
// Fetch -> extract -> resolve -> score -> write.
//
//   node bin/build.mjs                 full build
//   node bin/build.mjs --source=nyrb   one publication
//   node bin/build.mjs --no-articles   feeds only, skip per-article fetches
//   node bin/build.mjs --fresh         ignore the HTTP cache

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ensureProxyAware } from '../lib/proxy.mjs';
import { Http } from '../lib/http.mjs';
import { fetchItems, extractBook } from '../lib/sources.mjs';
import { resolve as resolveBook, merge as mergeMetadata, googleLookup, coverByIsbn, googleAvailable, googleKeyed, readerRatings } from '../lib/books.mjs';
import { weightedSum } from '../web/lib/total.mjs';
import { score } from '../lib/score.mjs';
import { group, merge as mergeBook } from '../lib/aggregate.mjs';
import { tagsFor, buildIndex } from '../lib/tags.mjs';
import { describe, vectorOf } from '../lib/describe.mjs';
import { outOfTen as toTen, isRecommended } from '../web/lib/recommend.mjs';
import * as store from '../lib/store.mjs';

ensureProxyAware();

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'));

const args = process.argv.slice(2);
const arg = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const flag = (name) => args.includes(`--${name}`);

const profile = load('profile/taste-profile.json');
const lexicons = load('profile/lexicons.json');
const registry = load('sources.json');
const phrases = load('profile/phrases.json');
const calibration = load('profile/calibration.json');

const now = new Date();
const nowYear = now.getFullYear();

const only = arg('source');
const sources = registry.sources.filter((s) => s.enabled && (!only || s.id === only));
const fetchArticle = !flag('no-articles');

// The twelve confirmed acquisitions, scored through the same pipeline, give a set of
// dimension vectors to measure a new book against. "Nearest thing in your own set"
// means nearest in this space, not nearest by subject.
const references = calibration.fixtures
  .filter((f) => f.expected === 'acquire')
  .map((f) => ({
    title: f.title,
    author: f.author,
    vector: vectorOf(score({
      title: f.title, author: f.author, text: f.text, pages: f.pages, publisher: f.publisher,
      translated: f.translated, translator: f.translator, bookYear: f.year, subjects: ['Fiction'],
    }, profile, lexicons, { now: nowYear })),
  }));


const http = new Http({
  cacheDir: join(root, '.cache'),
  ttlHours: flag('fresh') ? 0 : 12,
  delayMs: 500,
});

const statePath = join(root, 'data', 'store.json');
const state = store.load(statePath);
const report = { sources: [], startedAt: now.toISOString() };

console.log(`\n  Building from ${sources.length} source${sources.length === 1 ? '' : 's'}${fetchArticle ? '' : ' (feeds only)'}\n`);

let added = 0, updated = 0;

for (const source of sources) {
  const line = { id: source.id, name: source.name };
  const { items, error } = await fetchItems(source, http, registry.defaults);
  if (error) {
    line.error = error;
    report.sources.push(line);
    console.log(`  ${pad(source.short, 16)} ${red('failed')}  ${error}`);
    continue;
  }
  line.items = items.length;

  let resolved = 0, unresolved = 0;
  for (const item of items) {
    const extracted = await extractBook(item, source, http, { fetchArticle });
    if (!extracted.title) { unresolved++; }

    const catalogue = extracted.title
      ? await resolveBook(http, { title: extracted.title, author: extracted.author }, { now: nowYear })
      : { matched: false, reason: 'no title extracted' };
    // Only reach for Google when Open Library left a hole worth filling.
    const needsMore = extracted.title && (!catalogue.matched || catalogue.unverified || !catalogue.pages);
    const google = needsMore && !flag('no-google') ? await googleLookup(http, { title: extracted.title, author: extracted.author }) : null;
    const ratings = catalogue.matched && !catalogue.unverified && !flag('no-ratings')
      ? await readerRatings(http, catalogue.key) : null;
    const book = mergeMetadata(extracted, catalogue, item, google, ratings);
    // A last look for a jacket, by ISBN, for a record that has one and no cover.
    // The title-and-author search runs before the ISBN is known; this runs after,
    // and an ISBN is an exact key rather than a fuzzy match.
    if (!book.coverUrl && (book.isbn13 || book.isbn10) && !flag('no-google')) {
      book.coverUrl = await coverByIsbn(http, book.isbn13 || book.isbn10);
    }
    if (book.title) resolved++;

    // Feeds carry things their publishers did not mean to syndicate. World
    // Literature Today's byline field arrived holding a reviewer's university
    // email address, which the publish guard caught on its way to a public site.
    // Redact rather than drop: the surrounding text is the review, and an address
    // is the one part of it nobody agreed to put on the open web.
    const noEmail = (v) => String(v || '').replace(/[\w.+-]+@[\w-]+\.[\w.]{2,}/g, '[email removed]');
    // A description field is not a standfirst. Several feeds open theirs with a
    // picture credit or a house line, which then reads as the app's account of
    // the book: "Featured image credit: Ketchup Entertainment Among the many
    // genres covered at crimereads dot com is..." was the first sentence under a
    // score. Cut the credit, keep the sentence after it.
    const noBoilerplate = (v) => String(v || '')
      .replace(/^\s*(?:featured\s+)?(?:image|photo(?:graph)?|illustration|art(?:work)?)\s+(?:credit|courtesy)[^.]*?[.:]?\s+(?=[A-Z])/i, '')
      .replace(/^\s*(?:buy the book|share this|advertisement)\b[^.]*[.:]?\s*/i, '')
      .trim();

    const entry = {
      id: store.key(item),
      source: { id: source.id, name: source.name, short: source.short, fictionOnly: Boolean(source.fictionOnly) },
      reviewTitle: noEmail(item.reviewTitle),
      reviewUrl: item.url,
      reviewDate: item.reviewDate,
      byline: noEmail(item.byline),
      // False for a publisher's own catalogue and for an author interview.
      // Neither says whether a book is any good, and the scorer never reads
      // either as though it did.
      critical: item.critical !== false,
      // True for the author on their own book. Not evidence about quality, but
      // the best description of what a book is and how it is built that this
      // archive holds — see lib/sources.mjs for the measurements.
      descriptive: item.descriptive === true,
      standfirst: noBoilerplate(noEmail(item.standfirst)).slice(0, 600),
      excerpt: noEmail(item.text).slice(0, 4000),
      categories: item.categories?.slice(0, 8) || [],
      book,
      identity: identityOf(book),
    };
    if (store.upsert(state, entry)) added++; else updated++;
  }

  line.resolved = resolved;
  line.unresolved = unresolved;
  report.sources.push(line);
  console.log(`  ${pad(source.short, 16)} ${pad(items.length + ' items', 12)} ${pad(resolved + ' with a book', 18)} ${unresolved ? dim(unresolved + ' unresolved') : ''}`);
}

const pruned = store.prune(state);
state.lastBuilt = new Date().toISOString();
store.save(statePath, state);

// --------------------------------------------------------------- publish

// A publisher's shop sells more than books, and the same list carries them.
const NOT_A_BOOK = /\b(subscription|gift card|gift certificate|tote|t-shirt|tshirt|mug|poster|membership|bundle|back ?issue|donation|merch|sticker|calendar|bookmark|voucher)\b/i;

const mentions = Object.values(state.entries);
const withBookMention = mentions.filter((m) => m.book?.title);

// One row per book, scored once over every review of it. This is the whole point of
// the change: three publications on the same novel is three times the evidence, and
// the partial-evidence cap exists precisely because one standfirst is not enough.
const grouped = group(withBookMention);

// The middle of the field, computed before anything is ranked against it.
//
// A thin score is pulled toward this rather than capped at a line - see the note
// on shrinkage in web/lib/total.mjs. It has to be measured on this corpus rather
// than assumed, and it has to be the same number the browser uses, so it is
// computed here in a pre-pass and written into feed.json.
//
// Measured on the weighted average of what fired, before shrinkage and before
// penalties, so the prior is neither defined in terms of itself nor dragged down
// by an exclusion the reader can switch off.
const priorPass = [];
for (const [, group_] of grouped) {
  const m = mergeBook(group_);
  const text = m.pooledText || m.describedText;
  if (!text) continue;
  const s = score({
    title: m.book.title, subtitle: m.book.subtitle, author: m.book.author, text,
    pages: m.book.pages, publisher: m.book.publisher, publishers: m.book.publishers,
    subjects: m.book.subjects, translated: m.book.translated, translator: m.book.translator,
    bookYear: m.book.bookYear, sections: m.sections,
    sourceIsFictionOnly: group_.some((x) => x.source?.fictionOnly),
  }, profile, lexicons, { now: nowYear });
  // The weighted average of what fired, before any penalty. That is the quantity
  // shrinkage operates on, so it is the quantity the prior has to describe.
  if (s.dimensionsFired > 0) priorPass.push(weightedSum(s.dimensions, profile).raw);
}
const prior = priorPass.length
  ? { mean: Math.round(priorPass.reduce((a, b) => a + b, 0) / priorPass.length * 10) / 10, weight: 15, n: priorPass.length }
  : null;
if (prior) profile.prior = prior;

const books = [];
let uncorroborated = 0;
for (const [key, group_] of grouped) {
  const m = mergeBook(group_);
  const scored = score({
    title: m.book.title,
    subtitle: m.book.subtitle,
    author: m.book.author,
    // A critic's text where there is one, the author's own account where there
    // is not. Never both: the corpora overlap on three books in this archive, so
    // pooling buys nothing and would let an author's words move a critic's score.
    text: m.pooledText || m.describedText,
    pages: m.book.pages,
    publisher: m.book.publisher,
    publishers: m.book.publishers,
    subjects: m.book.subjects,
    translated: m.book.translated,
    translator: m.book.translator,
    bookYear: m.book.bookYear,
    sections: m.sections,
    // Provenance reads it: two publications on one book is a harder thing to
    // arrange than a good imprint.
    reviewCount: m.reviewCount,
    sourceIsFictionOnly: group_.some((x) => x.source?.fictionOnly),
  }, profile, lexicons, { now: nowYear });

  // Where the score was read from, carried on the record so the row can say so.
  // A number built from an author describing their own book is a real placement
  // and it is not a critical judgement, and the reader is owed the difference.
  scored.readFrom = m.pooledText ? 'reviews' : m.describedText ? 'author-account' : 'none';

  // A book nothing has said anything about gets no score, whatever its metadata
  // says.
  //
  // Without this it still scored: D6 reads a page count and D7 reads an imprint,
  // and neither needs a word of prose, so a book listed by its publisher and
  // described nowhere came out at "Reserve" on the strength of being 300 pages
  // long and published by someone good. That is a number about a catalogue
  // record wearing the clothes of a judgement about a book.
  //
  // What this no longer covers is a book with an author's account behind it.
  // That is 456 records with a median of 600 characters of argument each, and
  // refusing to read them was suppressing the best descriptive text in the
  // archive — see lib/sources.mjs.
  if (m.listedOnly) {
    scored.total = 0;
    scored.dimensionsFired = 0;
  }

  if (scored.dimensionsFired === 0) {
    scored.band = 'unscored';
    scored.bandLabel = 'Not scored';
    scored.action = m.listedOnly
      ? 'Listed by its publisher and described nowhere this reads.'
      : m.describedOnly
        ? 'Nothing in the author’s own account spoke to any dimension of the profile.'
        : 'Nothing across these reviews spoke to any dimension of the profile.';
  }

  const inWindow = m.book.bookYear ? m.book.bookYear >= nowYear - profile.window.years : null;
  const partial = { id: key, fiction: scored.fiction.status, identity: m.identity, inWindow };
  const rec = isRecommended({
    scored, hasBook: true, identity: m.identity, fiction: partial.fiction, inWindow,
  });

  const entry = {
    id: key,
    book: m.book,
    mentions: m.mentions,
    // Reviews, not listings. A book listed by its publisher and reviewed nowhere
    // has been reviewed zero times, and the row should say so.
    reviewCount: m.reviewCount,
    listedOnly: m.listedOnly,
    // Scored, but from the author on their own book rather than from a critic.
    describedOnly: m.describedOnly,
    sources: [...new Set(m.mentions.map((x) => x.source.short))],
    firstReviewed: m.firstReviewed,
    lastReviewed: m.lastReviewed,
    categories: m.sections,
    score: scored,
    outOfTen: scored.dimensionsFired > 0 ? toTen(scored.total) : null,
    recommended: rec.ok,
    recommendedWhyNot: rec.ok ? null : rec.because,
    reading: describe(scored, m.book, partial, profile, phrases, references),
    inWindow,
    fiction: partial.fiction,
    identity: m.identity,
  };
  entry.tags = tagsFor(entry);

  // A title with nothing behind it does not reach the feed at all.
  //
  // No catalogue record, no page count, no publisher and no ISBN means nothing
  // has established that this is a book, and a film, a television series and a
  // games supplement all reached the site that way. Hiding them behind a filter
  // was the wrong fix: they still got scored, still shipped in the payload, and
  // still had to be accounted for in the status line. Something that cannot be
  // shown to be a book has no business being scored as one.
  //
  // The store keeps them. Mentions are the archive and the catalogue catches up
  // on recent books over weeks, so a title that is bare today can resolve on a
  // later run and appear then. This is a rule about what is published, not about
  // what is remembered.
  // The store keeps what it has already seen, so a rule added today has to be
  // applied on the way out as well as on the way in, or yesterday's mistakes
  // stay published forever.
  if (NOT_A_BOOK.test(entry.book.title)) { uncorroborated++; continue; }
  if (entry.book.corroborated === false && !entry.listedOnly) { uncorroborated++; continue; }
  if (entry.book.corroborated === false && entry.listedOnly && !entry.book.publisher) { uncorroborated++; continue; }
  books.push(entry);
}

// What counts as a recommendation, set as a share of the field rather than as a
// point on the scale.
//
// A weighted average over seven dimensions is a mean, and means regress: once
// every dimension fires, almost every book lands near the middle and an absolute
// 7.0 becomes unreachable by arithmetic rather than by judgement. Revision 3
// fires 63% on structure where revision 2 fired 11%, and the distribution
// collapsed into two bands the moment it did.
//
// So the profile states how selective it wants to be and the build finds the
// number that delivers it against this corpus. The score on the row is still the
// transparent weighted sum, showing its working; the line it has to clear is the
// one that keeps the top of the list the size the reader asked for.
const scoredTotals = books
  .filter((b) => !b.listedOnly && b.score.band !== 'unscored' && b.score.band !== 'unresolved')
  .map((b) => b.score.total)
  .sort((a, b) => a - b);
if (scoredTotals.length > 40) {
  const share = profile.recommendShare ?? 0.12;
  const cut = scoredTotals[Math.floor(scoredTotals.length * (1 - share))];
  profile.recommendAt = Math.max(1, Math.round(cut) / 10);
}

// The flag was set in the loop against the old constant, before the threshold
// this corpus actually needs could be known. Re-run it now that it is.
for (const b of books) {
  if (b.listedOnly || b.score.band === 'unscored' || b.score.band === 'unresolved') continue;
  const rec = isRecommended({ scored: b.score, hasBook: true, identity: b.identity,
    fiction: b.fiction, inWindow: b.inWindow, at: profile.recommendAt });
  b.recommended = rec.ok;
  b.recommendedWhyNot = rec.ok ? null : rec.because;
}

const tagIndex = buildIndex(books);

books.sort((a, b) => (Date.parse(b.lastReviewed || 0) || 0) - (Date.parse(a.lastReviewed || 0) || 0));

const feed = {
  builtAt: state.lastBuilt,
  windowYears: profile.window.years,
  recommendAt: profile.recommendAt,
  recommendShare: profile.recommendShare ?? 0.12,
  profileRevision: profile.revision,
  thresholds: profile.thresholds,
  // Bands travel with the feed now. A reader re-scoring a band in the browser needs
  // to know what bands exist and what this profile paid for each, and the evidence
  // rule has to travel too or the browser's arithmetic diverges from the build's.
  dimensions: profile.dimensions.map((d) => ({
    id: d.id, name: d.name, weight: d.weight, default: d.default,
    bands: d.bands.map((b) => ({ id: b.id, score: b.score, label: b.label, descriptiveOnly: !!b.descriptiveOnly })),
  })),
  evidenceRule: profile.evidenceRule,
  // The middle of this corpus, so the browser shrinks a thin score to the same
  // place the build did when a reader re-weights a dimension.
  prior: profile.prior || null,
  openQuestions: profile.openQuestions,
  hardFilters: profile.hardFilters,
  sources: registry.sources.map((s) => ({ id: s.id, name: s.name, short: s.short, enabled: s.enabled, disabledReason: s.disabledReason || null })),
  surfacing: profile.surfacing,
  proseFloor: profile.proseFloor,
  unresolvedReviews: mentions.length - withBookMention.length,
  tags: tagIndex,
  // `matched` is the scorer's full working: every band of every dimension with
  // the terms it hit, including the eighty-odd that hit nothing. The build needs
  // it — runFilters reads it — and the browser has never once looked at it. On
  // 785 books it was 1.72MB of a 6.7MB feed, a quarter of what every reader
  // downloads, all of it zeroes. It stays in data/store.json, where the next
  // build can still read it, and it stops here.
  books: books.map((b) => (b.score?.dimensions ? {
    ...b,
    score: {
      ...b.score,
      dimensions: Object.fromEntries(Object.entries(b.score.dimensions)
        .map(([id, d]) => [id, { ...d, matched: undefined }])),
    },
  } : b)),
};

mkdirSync(join(root, 'web', 'data'), { recursive: true });
writeFileSync(join(root, 'web', 'data', 'feed.json'), JSON.stringify(feed));

// --------------------------------------------------------------- summary

const inWindow = books.filter((b) => b.inWindow !== false);
const fiction = books.filter((b) => b.fiction === 'confirmed' || b.fiction === 'likely');
const recommended = books.filter((b) => b.recommended);
const multi = books.filter((b) => b.reviewCount > 1);
const capped = books.filter((b) => b.score.scoredOnPartialEvidence);

console.log(`\n  ${added} new mentions, ${updated} refreshed, ${pruned} pruned. ${mentions.length} reviews in the archive.`);
console.log(`  ${books.length} distinct books, ${multi.length} reviewed more than once, ${feed.unresolvedReviews} reviews with no book identified.`);
console.log(`  ${uncorroborated} titles held back: nothing establishes them as books yet.`);
console.log(`  ${inWindow.length} inside the ${profile.window.years}-year window, ${fiction.length} evidenced as fiction.`);
console.log(`  ${recommended.length} recommended (7.0 or above), ${capped.length} still capped on partial evidence.`);
console.log(`  ${tagIndex.length} distinct tags, ${tagIndex.filter((t) => t.count > 1).length} shared by more than one book.`);
console.log(`  Cache: ${http.stats.hits} hits, ${http.stats.misses} fetches, ${http.stats.errors} errors.`);
// A missing key and a spent quota both end as "no Google Books", and they need
// different things doing about them, so the run says which one happened.
if (!googleKeyed()) console.log(`  ${red('No google-books.key - every Google Books request will 429. See the Google Books section of the handoff.')}`);
else if (!googleAvailable()) console.log(`  ${dim('Google Books stopped answering (quota) - page counts came from Open Library and the reviews only.')}`);
console.log(`\n  Wrote web/data/feed.json  -  run 'npm start' to read it.\n`);

// How confident we are that this row is about the book it says it is. Only the top
// two tiers are surfaced as recommendations; the rest stay in the unverified drawer,
// visible but never counted.
function identityOf(book) {
  const STATED = new Set(['nyrb-reviewed-block', 'lrb-reviewed-block', 'guardian-title', 'kirkus-url', 'dash-title', 'nyt-title', 'pw-review', 'bookmarks-list', 'bookforum-publications', '4columns-bib']);
  if (!book.title) return 'unresolved';
  if (STATED.has(book.extraction.method)) return 'source-stated';
  if (book.catalogued) return 'catalogue-confirmed';
  return 'unverified';
}

function pad(s, n) { return String(s).padEnd(n); }
function dim(s) { return `\x1b[2m${s}\x1b[0m`; }
function red(s) { return `\x1b[31m${s}\x1b[0m`; }
