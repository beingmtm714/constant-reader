// Grouping reviews into books.
//
// The feed's unit is the book, not the review. Three publications reviewing the same
// novel is one row carrying three mentions, and — the reason this matters — one
// scoring pass over all three texts rather than three thin ones. A Guardian
// standfirst fires three dimensions; pooled with an NYRB review of the same book it
// can fire seven, which is the difference between a capped 6.9 and a real score.

import { normalize } from './text.mjs';
import { cleanBlurb, trimBody } from '../web/lib/blurb.mjs';

const IDENTITY_RANK = { 'source-stated': 3, 'catalogue-confirmed': 2, unverified: 1, unresolved: 0 };
const CONFIDENCE_RANK = { high: 3, medium: 2, low: 1, none: 0 };

export function titleKey(title) {
  return normalize(title)
    .replace(/^(the|a|an)\s+/, '')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function surname(author) {
  const parts = normalize(author).replace(/[^a-z .'-]/g, '').split(/\s+/).filter(Boolean);
  // "and" joins co-authors; the first surname is enough to key on.
  const cut = parts.indexOf('and');
  const use = cut > 0 ? parts.slice(0, cut) : parts;
  return use.length ? use[use.length - 1] : '';
}

// A title with no author is only distinctive enough to merge on when it is long
// enough to be unlikely to collide. "Outline" is not; "Mercury Pictures Presents" is.
function distinctive(key) {
  return key.length >= 12 || key.split(' ').length >= 3;
}

export function bookKey(book) {
  const t = titleKey(book.title || '');
  if (!t) return null;
  const s = surname(book.author || '');
  return s ? `${t}|${s}` : `${t}|`;
}

// Attach author-less mentions to an author-ful book of the same title where that is
// safe, so "Mercury Pictures Presents" from a review that named no author still lands
// on the right row.
function reconcile(groups) {
  const byTitle = new Map();
  for (const [key, mentions] of groups) {
    const [t, s] = key.split('|');
    if (!s) continue;
    if (!byTitle.has(t)) byTitle.set(t, []);
    byTitle.get(t).push(key);
  }
  for (const [key, mentions] of [...groups]) {
    const [t, s] = key.split('|');
    if (s) continue;
    const candidates = byTitle.get(t) || [];
    if (candidates.length === 1 && distinctive(t)) {
      groups.get(candidates[0]).push(...mentions);
      groups.delete(key);
    }
  }
  return groups;
}

export function group(entries) {
  const groups = new Map();
  for (const e of entries) {
    const key = bookKey(e.book);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  return reconcile(groups);
}

// Rank mentions so the most trustworthy one supplies metadata: a publication that
// prints the publisher and page count outranks one that did not.
function rankMention(e) {
  return (IDENTITY_RANK[e.identity] ?? 0) * 10
    + (CONFIDENCE_RANK[e.book?.extraction?.confidence] ?? 0)
    + (e.book?.pages ? 5 : 0);
}

const firstOf = (mentions, pick) => {
  for (const m of mentions) { const v = pick(m); if (v !== null && v !== undefined && v !== '') return v; }
  return null;
};

export function merge(mentions, { maxPooledChars = 40000 } = {}) {
  const ranked = [...mentions].sort((a, b) => rankMention(b) - rankMention(a));
  const best = ranked[0];

  const book = {
    title: firstOf(ranked, (m) => m.book.title),
    subtitle: firstOf(ranked, (m) => m.book.subtitle),
    author: firstOf(ranked, (m) => m.book.author),
    // A name the catalogue proposed but nothing could verify. It travels with the
    // book because the row shows it where no author was extracted, and this object
    // is composed field by field rather than spread, so anything not named here is
    // dropped on the way out of the merge.
    proposedAuthor: firstOf(ranked, (m) => m.book.proposedAuthor),
    // Any one mention establishing the book establishes it for the row.
    corroborated: ranked.some((m) => m.book.corroborated),
    translated: ranked.some((m) => m.book.translated),
    translator: firstOf(ranked, (m) => m.book.translator),
    pages: firstOf(ranked, (m) => m.book.pages),
    publisher: firstOf(ranked, (m) => m.book.publisher),
    publishers: firstOf(ranked, (m) => (m.book.publishers?.length ? m.book.publishers : null)) || [],
    subjects: firstOf(ranked, (m) => (m.book.subjects?.length ? m.book.subjects : null)) || [],
    bookYear: firstOf(ranked, (m) => m.book.bookYear),
    yearSource: null,
    yearPrecision: null,
    editionDate: firstOf(ranked, (m) => m.book.editionDate),
    criticTally: firstOf(ranked, (m) => m.book.criticTally),
    // Purchasing identifiers take the same ranking as everything else, so a PW
    // notice printing an ISBN supplies it even when the essay that scored the
    // book did not.
    isbn13: firstOf(ranked, (m) => m.book.isbn13),
    isbn10: firstOf(ranked, (m) => m.book.isbn10),
    asin: firstOf(ranked, (m) => m.book.asin),
    readerRating: firstOf(ranked, (m) => m.book.readerRating),
    readerRatingCount: firstOf(ranked, (m) => m.book.readerRatingCount),
    coverUrl: firstOf(ranked, (m) => m.book.coverUrl),
    // The widest the host will actually render that jacket, measured by
    // bin/covers.mjs. It travels with the cover so the browser can tell a jacket
    // that will fill a card from one that will be stretched across it.
    coverWidth: firstOf(ranked, (m) => m.book.coverWidth),
    // The publisher's own account of the book, from the catalogue lookup. Read
    // as descriptive text where nobody else has written about it at all.
    description: firstOf(ranked, (m) => m.book.description),
    openLibraryUrl: firstOf(ranked, (m) => m.book.openLibraryUrl),
    catalogued: ranked.some((m) => m.book.catalogued),
    catalogueNote: firstOf(ranked, (m) => m.book.catalogueNote),
    extraction: best.book.extraction,
  };

  // Keep the provenance of whichever mention supplied the year.
  const yearDonor = ranked.find((m) => m.book.bookYear === book.bookYear);
  if (yearDonor) { book.yearSource = yearDonor.book.yearSource; book.yearPrecision = yearDonor.book.yearPrecision; }

  // Every publication's text, so the scorer reads the whole critical record at
  // once — and only the critical record.
  //
  // A publisher's catalogue entry is in `mentions` because it establishes that
  // the book exists and supplies its imprint and date. Its text is jacket copy,
  // which is written to sell and never says the prose is the weakness, so the
  // profile's negative signals cannot fire on it and its positive ones fire on
  // everything. Pooling it would inflate every book a press listed and no book a
  // critic reviewed, in one direction, invisibly.
  const critical = ranked.filter((m) => m.critical !== false);
  const describing = ranked.filter((m) => m.descriptive === true);

  const poolOf = (ms, clean) => {
    let out = '';
    for (const m of ms) {
      // The episode notes carry an ad tail, a host's biography and an opening
      // that restates the citation. None of it is about the book, and all of it
      // is keyword the scorer would read. web/lib/blurb.mjs already strips
      // exactly this for the row, and it is pure, so the build uses it too.
      const sf = clean ? cleanBlurb(m.standfirst || '', { title: book.title, author: book.author }) : m.standfirst;
      // The body carries the page around it, and past its own end it carries other
      // books' reviews. Trimmed for both pools: this is the best text the pipeline
      // has and it is the text most likely to be scored against the wrong book.
      const chunk = [m.reviewTitle, sf, clean ? null : trimBody(m.excerpt)].filter(Boolean).join('. ');
      if (out.length + chunk.length > maxPooledChars) break;
      out += (out ? '\n\n' : '') + chunk;
    }
    return out;
  };

  const pooled = poolOf(critical, false);
  // The publisher's own description of the book, from the catalogue lookup, on
  // the end of whatever anyone else said. It is the weakest of the three texts
  // and it is the only one that exists for a book nobody has written about, so
  // it goes last and it goes in.
  const described = [poolOf(describing, true), book.description || '']
    .filter(Boolean).join('\n\n').slice(0, maxPooledChars);

  const sections = [...new Set(mentions.flatMap((m) => m.categories || []))];
  const identity = ranked.map((m) => m.identity).sort((a, b) => (IDENTITY_RANK[b] ?? 0) - (IDENTITY_RANK[a] ?? 0))[0];

  const dates = mentions.map((m) => Date.parse(m.reviewDate || '')).filter(Boolean).sort((a, b) => a - b);

  return {
    book,
    pooledText: pooled,
    // What the author said about their own book, kept apart from what a critic
    // said about it. Read only where there is no critic at all: the two corpora
    // overlap on three books in the whole archive, so pooling them buys nothing
    // and would put author's-own-account words into a score a critic earned.
    describedText: described,
    // Nothing has said anything about it — no critic, and no author account
    // either. Only then does the row show no score, and it is the publisher
    // catalogues that land here.
    listedOnly: critical.length === 0 && described.length === 0,
    // A book known only from an author's account has been reviewed zero times
    // and the row still has to say so.
    describedOnly: critical.length === 0 && described.length > 0,
    reviewCount: critical.length,
    sections,
    identity,
    firstReviewed: dates.length ? new Date(dates[0]).toISOString() : null,
    lastReviewed: dates.length ? new Date(dates[dates.length - 1]).toISOString() : null,
    mentions: mentions
      .slice()
      .sort((a, b) => (Date.parse(b.reviewDate || 0) || 0) - (Date.parse(a.reviewDate || 0) || 0))
      .map((m) => ({
        id: m.id,
        source: m.source,
        reviewTitle: m.reviewTitle,
        reviewUrl: m.reviewUrl,
        reviewDate: m.reviewDate,
        byline: m.byline,
        // Which of the two kinds of text this is, carried through to the browser.
        // The split is already made here — `critical` against `describing` — and
        // it was being thrown away at the edge, so the app could say a book had
        // been reviewed but could not point at which of its mentions was the
        // review. A row that names an author's podcast as "the review" is the
        // exact confusion this flag exists to prevent.
        critical: m.critical !== false,
        standfirst: m.standfirst,
        extraction: m.book.extraction,
        identity: m.identity,
      })),
  };
}
