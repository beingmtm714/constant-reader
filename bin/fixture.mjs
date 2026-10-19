#!/usr/bin/env node
// Writes a small web/data/feed.json from the calibration set so the UI can be
// worked on without a crawl. Real scorer, real tags, real reading. Overwritten by
// the next `npm run build`; never committed, because web/data is gitignored.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { score } from '../lib/score.mjs';
import { tagsFor, buildIndex } from '../lib/tags.mjs';
import { describe } from '../lib/describe.mjs';
import { isRecommended, outOfTen } from '../web/lib/recommend.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'));
const profile = load('profile/taste-profile.json');
const lexicons = load('profile/lexicons.json');
const phrases = load('profile/phrases.json');
const calibration = load('profile/calibration.json');
const now = new Date().getFullYear();

const SOURCES = [
  { short: 'NYRB', name: 'New York Review of Books' },
  { short: 'LRB', name: 'London Review of Books' },
  { short: 'PW', name: 'Publishers Weekly' },
  { short: 'Bookforum', name: 'Bookforum' },
  { short: '4Columns', name: '4Columns' },
];

const fixtures = (calibration.books || calibration.fixtures || []).slice(0, 24);
const references = [];

const books = fixtures.map((f, i) => {
  const cand = {
    title: f.title, author: f.author || 'Unattributed',
    pages: f.pages ?? (240 + ((i * 47) % 380)),
    publisher: f.publisher || (i % 3 === 0 ? 'Graywolf Press' : 'Farrar, Straus and Giroux'),
    text: f.text || f.description || f.blurb || '',
  };
  const scored = score(cand, profile, lexicons, { now });
  const day = new Date(Date.UTC(2026, 7, 24 - (i % 20)));
  const src = SOURCES[i % SOURCES.length];
  const mentions = [{
    source: src, title: `${cand.title} reviewed`, url: 'https://example.invalid/review',
    published: day.toISOString(), critic: null, excerpt: cand.text.slice(0, 260),
  }];
  const bookYear = 2026 - (i % 9);
  const book = {
    title: cand.title, author: cand.author, publisher: cand.publisher,
    pages: cand.pages, bookYear, isbn13: i % 2 ? `978100000${String(i).padStart(4, '0')}` : null,
    translated: i % 7 === 0, translator: i % 7 === 0 ? 'A. Translator' : null,
    criticTally: i % 4 === 0 ? `${3 + (i % 3)} Rave, 1 Positive` : null,
  };
  const inWindow = bookYear >= now - profile.window.years;
  const identity = i % 6 === 0 ? 'unverified' : 'source-stated';
  const partial = { id: `fx-${i}`, fiction: scored.fiction.status, identity, inWindow };
  const rec = isRecommended({ scored, hasBook: true, identity, fiction: partial.fiction, inWindow });
  const entry = {
    id: `fx-${i}`, book, mentions, reviewCount: mentions.length,
    sources: [src.short], firstReviewed: day.toISOString(), lastReviewed: day.toISOString(),
    categories: ['fiction'], score: scored,
    outOfTen: scored.dimensionsFired > 0 ? outOfTen(scored.total) : null,
    recommended: rec.ok, recommendedWhyNot: rec.ok ? null : rec.because,
    reading: describe(scored, book, partial, profile, phrases, references),
    inWindow, fiction: partial.fiction, identity,
  };
  entry.tags = tagsFor(entry);
  return entry;
});

const feed = {
  builtAt: new Date().toISOString(),
  windowYears: profile.window.years, recommendAt: 7,
  profileRevision: profile.revision, thresholds: profile.thresholds,
  dimensions: profile.dimensions.map((d) => ({
    id: d.id, name: d.name, weight: d.weight, default: d.default,
    bands: d.bands.map((b) => ({ id: b.id, score: b.score, label: b.label, descriptiveOnly: !!b.descriptiveOnly })),
  })),
  evidenceRule: profile.evidenceRule,
  openQuestions: profile.openQuestions, hardFilters: profile.hardFilters,
  sources: SOURCES.map((s, i) => ({ id: `s${i}`, name: s.name, short: s.short, enabled: true, disabledReason: null })),
  surfacing: profile.surfacing, proseFloor: profile.proseFloor,
  unresolvedReviews: 0, tags: buildIndex(books), books,
  isFixture: true,
};
mkdirSync(join(root, 'web', 'data'), { recursive: true });
writeFileSync(join(root, 'web', 'data', 'feed.json'), JSON.stringify(feed));
console.log(`  Wrote ${books.length} fixture books to web/data/feed.json`);
