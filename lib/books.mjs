// Resolving an extracted title and author to a real book.
//
// Open Library answers the two questions the profile actually needs — when was this
// first published, and is it fiction — plus page count and publisher when the review
// did not supply them. It is weakest on books published in the last few months,
// which is exactly the pool a review feed is full of, so the review's own metadata
// block wins wherever it exists and Open Library fills the gaps.

import { readFileSync } from 'node:fs';
import { normalize } from './text.mjs';

// Google Books knows about books published this month, which Open Library often does
// not, and it carries page counts and publishers for them. It is also aggressively
// rate-limited per IP, so a single 429 disables it for the rest of the run rather
// than spending the remaining budget on retries.
let googleDisabled = false;

// One 429 used to disable Google for the rest of the build. That is right for a
// hard refusal and wrong for a burst limit: the 2026-08-29 build stopped asking
// after the first one and finished with jacket images for 18% of the shelf, while
// the same key answered 200 to three requests a minute later. So a rate limit is
// now retried by the HTTP layer, and Google is only given up on after three
// failures in a row - enough to tell a spent daily quota, which will not recover
// inside one build, from a burst, which will.
let googleFailures = 0;
const GIVE_UP_AFTER = 3;

// Unkeyed, it answers 429 to every request from a residential address, which read
// for months as an IP block and was a missing key the whole time. The same query
// returns 200 with a key and 429 without it from this machine, in the same minute.
//
// The key lives in a file rather than an environment variable because a build
// that silently loses the key from a scheduled job's environment is the failure
// this is meant to end. In Actions the workflow writes it from a secret. Restricted to
// books.googleapis.com on the project constant-reader-93f05, and gitignored.
const googleKey = readKey();
function readKey() {
  try { return readFileSync(new URL('../google-books.key', import.meta.url), 'utf8').trim(); }
  catch { return ''; }
}

export function googleKeyed() { return Boolean(googleKey); }

// A cover by ISBN, for a book that came out of the pipeline without one.
//
// `googleLookup` searches by title and author, which is what it has when a book
// is first resolved. By the time a record is complete it often has an ISBN as
// well, and an ISBN is an exact key rather than a fuzzy match — no title
// similarity, no surname check, no chance of the wrong edition's jacket. 99 of
// the 183 books with no cover at all had one to look up with.
//
// Only the image is taken. Everything else on the record was already settled by
// a match that had more to go on than this one does.
export async function coverByIsbn(http, isbn) {
  if (googleDisabled || !isbn) return null;
  const key = googleKey ? `&key=${encodeURIComponent(googleKey)}` : '';
  const res = await http.json(`https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(isbn)}&maxResults=1${key}`, { retries: 1 });
  if (!res.ok) {
    googleFailures += 1;
    if (googleFailures >= GIVE_UP_AFTER) googleDisabled = true;
    return null;
  }
  googleFailures = 0;
  return pickCover(res.data?.items?.[0]?.volumeInfo?.imageLinks) || null;
}

export async function googleLookup(http, book) {
  if (googleDisabled || !book.title) return null;
  const q = [`intitle:"${book.title}"`, book.author ? `inauthor:"${book.author}"` : ''].filter(Boolean).join('+');
  const key = googleKey ? `&key=${encodeURIComponent(googleKey)}` : '';
  const res = await http.json(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=5&printType=books${key}`, { retries: 2 });
  if (!res.ok) {
    googleFailures += 1;
    if (googleFailures >= GIVE_UP_AFTER) googleDisabled = true;
    return null;
  }
  googleFailures = 0;
  const items = res.data?.items || [];
  if (!items.length) return null;

  const wantSurname = surname(book.author || '');
  let best = null;
  for (const it of items) {
    const v = it.volumeInfo || {};
    const tScore = similarity(book.title, v.title || '');
    const aScore = wantSurname ? ((v.authors || []).map(surname).includes(wantSurname) ? 1 : 0) : 0.5;
    const score = tScore * 0.6 + aScore * 0.4;
    if (!best || score > best.score) best = { score, v, tScore, aScore };
  }
  if (!best || best.tScore < 0.72 || (wantSurname && best.aScore !== 1)) return null;

  const v = best.v;
  const year = v.publishedDate ? Number(String(v.publishedDate).slice(0, 4)) : null;
  return {
    source: 'googlebooks',
    pages: v.pageCount || null,
    publisher: v.publisher || null,
    year: Number.isFinite(year) ? year : null,
    categories: v.categories || [],
    isFiction: (v.categories || []).some((c) => /fiction/i.test(c)) || null,
    // Google's own jacket image. Open Library has one for 46 of 692 books, which
    // is not enough to build a cover-led screen on; Google carries them for books
    // published this month, which is most of what a review feed is. Requested
    // over https and without the curl/edge parameters Google adds by default,
    // because those draw a page-curl graphic onto the image.
    coverUrl: pickCover(v.imageLinks),
    // The publisher's own description of the book, which Google carries for most
    // of what it holds. It is jacket copy — written to sell, and it will never
    // say the prose is the weakness — so it is descriptive text and never
    // critical. It is also, for a book nobody has reviewed and no author has
    // been interviewed about, the only account of what the book is.
    description: typeof v.description === 'string' ? v.description.slice(0, 2000) : null,
  };
}

function pickCover(links) {
  const raw = links?.thumbnail || links?.smallThumbnail || '';
  if (!raw) return null;
  return raw.replace(/^http:/, 'https:').replace(/&edge=curl/g, '');
}

export function googleAvailable() { return !googleDisabled; }

const FIELDS = 'key,title,subtitle,author_name,first_publish_year,publish_year,number_of_pages_median,publisher,subject,language,cover_i,ia_collection_s,isbn';

function titleKey(s) {
  return normalize(s).replace(/^(the|a|an)\s+/, '').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

function similarity(a, b) {
  const x = titleKey(a), y = titleKey(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.startsWith(y) || y.startsWith(x)) return 0.9;
  const xs = new Set(x.split(' ')), ys = new Set(y.split(' '));
  const inter = [...xs].filter((w) => ys.has(w)).length;
  return inter / Math.max(xs.size, ys.size);
}

function surname(name) {
  const parts = normalize(name).replace(/[^a-z .'-]/g, '').split(/\s+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

// Reader ratings, as distinct from critical opinion. Free, and available for any
// work the catalogue already knows - which is the one reader signal still reachable
// now that Goodreads has retired its feeds and StoryGraph and LibraryThing refuse
// automated clients.
export async function readerRatings(http, workKey) {
  if (!workKey) return null;
  const res = await http.json(`https://openlibrary.org${workKey}/ratings.json`);
  if (!res.ok) return null;
  const s = res.data?.summary;
  if (!s || !s.count) return null;
  return { average: Math.round(s.average * 100) / 100, count: s.count };
}

export async function resolve(http, book, { now = new Date().getFullYear() } = {}) {
  if (!book.title) return { matched: false, reason: 'no title extracted' };

  const params = new URLSearchParams({ title: book.title, fields: FIELDS, limit: '8' });
  if (book.author) params.set('author', book.author);
  const url = `https://openlibrary.org/search.json?${params}`;

  let res = await http.json(url);
  let docs = res.ok ? res.data?.docs || [] : [];

  // A wrong author guess is worse than none — retry on title alone before giving up.
  if (!docs.length && book.author) {
    const alt = new URLSearchParams({ title: book.title, fields: FIELDS, limit: '8' });
    res = await http.json(`https://openlibrary.org/search.json?${alt}`);
    docs = res.ok ? res.data?.docs || [] : [];
  }
  if (!docs.length) return { matched: false, reason: res.ok ? 'no catalogue match' : `openlibrary ${res.error || 'error'}` };

  const wantSurname = surname(book.author || '');
  let best = null;
  for (const d of docs) {
    const tScore = similarity(book.title, d.title || '');
    const authors = (d.author_name || []).map(surname);
    const aScore = wantSurname ? (authors.includes(wantSurname) ? 1 : 0) : 0.5;
    const recency = d.first_publish_year && d.first_publish_year >= now - 12 ? 0.08 : 0;
    const score = tScore * 0.6 + aScore * 0.34 + recency;
    if (!best || score > best.score) best = { score, doc: d, tScore, aScore };
  }

  // Title has to be a real match and, when an author was extracted, it has to agree.
  // Titles repeat across books, so an exact title with the wrong author is recorded
  // as a match of last resort and flagged, never treated as confirmed.
  const strict = best.tScore >= 0.72 && (!wantSurname || best.aScore === 1);
  // Without an author there is nothing to verify identity against, so an exact title
  // is a pointer, not a confirmation: "Killing Spree" matched a thriller when the
  // review was about a poetry collection of the same name.
  const loose = !wantSurname && best.tScore >= 0.9;
  const authorMismatch = Boolean(wantSurname) && best.aScore === 0 && best.tScore >= 0.95;
  if (!strict && !loose && !authorMismatch) {
    return { matched: false, reason: 'no confident catalogue match', nearest: best.doc?.title };
  }

  const d = best.doc;
  const subjects = d.subject || [];
  const subjectHay = normalize(subjects.join(' | '));
  return {
    matched: true,
    confidence: strict && wantSurname ? 'high' : 'low',
    authorMismatch,
    unverified: Boolean(authorMismatch) || !wantSurname,
    key: d.key,
    title: d.title,
    subtitle: d.subtitle || '',
    authors: d.author_name || [],
    firstPublishYear: d.first_publish_year || (d.publish_year || []).sort((a, b) => a - b)[0] || null,
    pages: d.number_of_pages_median || null,
    publishers: (d.publisher || []).slice(0, 6),
    subjects: subjects.slice(0, 40),
    // No subjects at all means the catalogue has not classified it, which is common
    // for books published this year. Unknown, not fiction and not nonfiction.
    isFiction: subjects.length ? /\bfiction\b/.test(subjectHay) : null,
    isNonfiction: subjects.length ? (!/\bfiction\b/.test(subjectHay) && /(biography|autobiograph|history|essays|criticism|memoir)/.test(subjectHay)) : null,
    // The catalogue lists every edition's ISBN, unsorted. Both lengths are kept
    // because the retailers want different ones: Bookshop deep-links on a 13,
    // and a 10 is what an older edition's copyright page carries.
    isbns: (d.isbn || []).slice(0, 40),
    coverId: d.cover_i || null,
    coverUrl: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : null,
    url: d.key ? `https://openlibrary.org${d.key}` : null,
  };
}

// Digits only, then the requested length. The review block prints one ISBN and
// the catalogue returns dozens across every edition; the review's wins, and the
// catalogue is only read for the length the review did not supply.
function pickIsbn(reviewIsbn, catalogueIsbns, length) {
  const digits = (v) => String(v ?? '').replace(/[^0-9Xx]/g, '').toUpperCase();
  const fromReview = digits(reviewIsbn);
  if (fromReview.length === length) return fromReview;
  for (const candidate of catalogueIsbns) {
    const d = digits(candidate);
    if (d.length === length) return d;
  }
  return null;
}

// The review's own block outranks the catalogue: it describes the edition actually
// under review, and it exists for books too new to be catalogued at all.
export function merge(extracted, resolved, item, google = null, ratings = null) {
  // An exact-title-wrong-author hit describes a different book. Keep it as a pointer
  // for the reader, never as a source of year, pages or subjects - a 2025 novel
  // colliding with a 2014 namesake would otherwise fall straight out of the window.
  const trusted = resolved.matched && !resolved.unverified;
  const pages = extracted.pages || (trusted ? resolved.pages : null) || google?.pages || null;
  const publisher = extracted.publisher || (trusted ? resolved.publishers?.[0] : null) || google?.publisher || null;

  // Purchasing identifiers, which the review's own metadata block is the best
  // source of: it prints the ISBN of the edition actually under review, where
  // the catalogue lists every edition ever issued and cannot say which is meant.
  const catalogueIsbns = trusted ? (resolved.isbns || []) : [];
  const isbn13 = pickIsbn(extracted.isbn, catalogueIsbns, 13);
  const isbn10 = pickIsbn(extracted.isbn, catalogueIsbns, 10);

  let bookYear = null, yearSource = null, yearPrecision = null;
  if (trusted && resolved.firstPublishYear) {
    bookYear = resolved.firstPublishYear; yearSource = 'openlibrary'; yearPrecision = 'year';
  } else if (google?.year) {
    bookYear = google.year; yearSource = 'googlebooks'; yearPrecision = 'year';
  } else if (extracted.editionYear) {
    bookYear = extracted.editionYear; yearSource = 'review-metadata'; yearPrecision = extracted.editionDate ? 'month' : 'year';
  } else if (item.reviewDate) {
    bookYear = new Date(item.reviewDate).getFullYear(); yearSource = 'inferred-from-review'; yearPrecision = 'inferred';
  }

  return {
    title: extracted.title || (trusted ? resolved.title : ''),
    subtitle: extracted.subtitle || (trusted ? resolved.subtitle : ''),
    // Where no author was extracted and the catalogue's title match is exact, the
    // catalogue's author is the best answer available. It is not trusted, because
    // there was no extracted name to check it against and titles repeat across
    // books, so the row still carries "book unverified". Showing it beats showing
    // a book with no author at all, which is what the feed did before.
    author: extracted.author || (trusted ? (resolved.authors || [])[0] : '') || '',
    proposedAuthor: (!extracted.author && !trusted && resolved?.unverified && (resolved.authors || [])[0]) || null,
    translated: Boolean(extracted.translated || /translated/i.test(extracted.translator || '')),
    translator: extracted.translator || null,
    pages,
    publisher,
    publishers: trusted ? resolved.publishers : [],
    subjects: trusted ? resolved.subjects : (google?.categories || []),
    isFiction: trusted ? resolved.isFiction : (google?.isFiction ?? null),
    isNonfiction: trusted ? resolved.isNonfiction : null,
    bookYear,
    yearSource,
    yearPrecision,
    editionDate: extracted.editionDate || null,
    criticTally: extracted.criticTally || null,
    isbn13,
    isbn10,
    // No source in this pipeline supplies an Amazon ASIN. The field exists
    // because the retailer link builder prefers one when it is there, and an
    // absent field and a wrong one are very different things — never guess it
    // from an ISBN-10, which would be right for print and wrong for everything
    // else, with no search box to recover from.
    asin: null,
    // Google's cover first, Open Library's only when Google has none.
    //
    // This was the other way round, on the reasoning that a matched catalogue
    // record is the more trustworthy source. It is, for facts. It is not, for
    // pixels: Open Library serves three fixed sizes and its largest is about
    // 300px, while Google's content endpoint will render the same jacket at
    // 1000px and beyond. Measured across four books where both had it — 296,
    // 328, 325 and 323 against 1000 every time — so preferring the catalogue was
    // choosing a third of the resolution for 56 books.
    //
    // A book with neither gets a drawn jacket in the browser rather than a gap;
    // see web/lib/jacket.mjs.
    coverUrl: google?.coverUrl || (trusted ? resolved.coverUrl : null) || null,
    // The widest the host will actually render this jacket, measured by
    // bin/covers.mjs and carried through so the browser can tell a cover that
    // will fill a card from one that will be stretched across it. Null until it
    // has been measured, which the renderer reads as "assume it is fine".
    coverWidth: extracted.coverWidth ?? null,
    // Descriptive, never critical. See googleLookup.
    description: google?.description || null,
    openLibraryUrl: trusted ? resolved.url : null,
    readerRating: ratings ? ratings.average : null,
    readerRatingCount: ratings ? ratings.count : null,
    catalogued: Boolean(trusted),
    catalogueNote: trusted ? null
      : resolved.authorMismatch ? `the catalogue's "${resolved.title}" is by someone else - this book is not listed`
      : resolved.unverified ? `a "${resolved.title}" exists in the catalogue but no author was extracted to check it against`
      : resolved.reason,
    // Is there anything behind the title at all?
    //
    // A title lifted out of review prose with no catalogue record, no page
    // count, no publisher and no ISBN is a string, not an established book. The
    // app already refuses to score where no dimension fired, on the principle
    // that a number assembled from defaults is a claim it cannot support; this
    // is the same principle one level down. Thirty per cent of the archive was
    // in that state on 2026-08-28, and among them were a film, a television
    // series and a games supplement, all scored and sorted as novels.
    // Google Books does not get to establish that an authorless title is a book.
    //
    // Open Library already refuses this: an exact title match with no author to
    // check it against is marked `unverified` and never becomes `trusted`. Google
    // had no such rule, so once the API key started working it began supplying a
    // page count and a publisher for every italicised title lifted out of review
    // prose - and a title-only match cannot tell a film from the novel it was
    // adapted from. That is how "Jurassic Park", "A Nightmare on Elm Street",
    // "Star Trek: Strange New Worlds" and "Coyote vs. Acme" arrived in a feed of
    // books, scored, with jacket images, on 2026-08-29.
    //
    // So the evidence is weighed by where it came from. The review's own metadata
    // block counts however the title was extracted: a publisher who prints a page
    // count and an ISBN beside a title is asserting it is a book. A catalogue
    // match counts, because it was verified against an author. Google counts only
    // when there was an author to verify it against.
    corroborated: Boolean(
      trusted
      || extracted.pages || extracted.publisher || extracted.isbn
      || ((google?.pages || google?.publisher) && extracted.author),
    ),
    extraction: { method: extracted.method, confidence: extracted.confidence },
    alsoReviewed: extracted.alsoReviewed || [],
  };
}
