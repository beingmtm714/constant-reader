// Where to go and buy a saved book.
//
// This app has no relationship with any of these retailers and asks nothing of
// them. It builds a URL a person can click. Nothing here fetches a retailer page,
// reads a price, claims a book is in stock, or touches a cart — see the note at
// the foot of the file for why that boundary is drawn where it is.
//
// URL formats are the one part of this that will rot, because they belong to
// somebody else. Every one of them is written in exactly one place below, so the
// day ThriftBooks changes its search parameter this is a one-line fix with a
// test that fails first.
//
// Verified 2026-08-25 against the live sites:
//   thriftbooks  /browse/?b.search=<isbn>   302 -> the work page. Confirmed.
//   abebooks     ?isbn= and ?tn=&an=        200 on both. Confirmed.
//   amazon       /dp/<asin>                 200. /s?k= answers 503 to a
//                                           datacentre IP, which is Amazon
//                                           throttling search for bots rather
//                                           than a wrong path.
//   bookshop     every HTML path answers 403 behind a Cloudflare challenge, so
//                the response body could not be read from here. Two things were
//                still learnable: /search?keywords= 301-redirects to
//                /beta-search?keywords=, which is the server naming its own
//                preferred path, so that is what is used below; and robots.txt
//                lists /beta-search, confirming the route exists.

import { bestIsbn13, isValidIsbn10, isValidIsbn13, normalizeIsbn } from './isbn.mjs?v=7324d439e1';

// Display order is this array's order. Adding a retailer means adding an entry
// here and a builder below, and nothing else.
export const RETAILERS = [
  {
    id: 'amazon',
    name: 'Amazon',
    blurb: 'New and used copies',
    // Set only if a real affiliate tag has been approved for this account.
    // An empty or placeholder value is worse than none: it is a broken
    // parameter on every outbound link, so decorate() refuses to write one.
    affiliate: { param: 'tag', value: null },
  },
  {
    id: 'thriftbooks',
    name: 'ThriftBooks',
    blurb: 'Affordable used books',
    affiliate: null,
  },
  {
    id: 'abebooks',
    name: 'AbeBooks',
    blurb: 'Used, rare, and out-of-print books',
    affiliate: null,
  },
  {
    id: 'bookshop',
    name: 'Bookshop.org',
    blurb: 'New books supporting independent bookstores',
    affiliate: { param: 'aid', value: null },
  },
];

export const RETAILER_IDS = RETAILERS.map((r) => r.id);

export const getRetailer = (id) => RETAILERS.find((r) => r.id === id) || null;

// ------------------------------------------------------------- identifiers

// Which identifier a link ended up being built from, in descending precision.
// This is the value analytics reports, so it is derived from the same call that
// builds the URL rather than guessed at afterwards.
export const RESOLUTIONS = ['asin', 'isbn13', 'isbn10', 'title_author', 'title'];

const trim = (v) => (typeof v === 'string' ? v.trim() : '');

// Amazon's own product id. Ten characters, alphanumeric. A valid ISBN-10 is also
// a valid ASIN for print books, but we only claim "asin" when the field was
// actually populated as one — a guess here sends the reader to a wrong page with
// no search box to recover from, which is the one failure mode worth avoiding.
function verifiedAsin(book) {
  const asin = trim(book?.asin).toUpperCase();
  return /^[A-Z0-9]{10}$/.test(asin) ? asin : null;
}

// The identifiers a book actually has, best first. Retailers differ in what they
// accept, so each builder walks this list and takes the first thing it can use.
//
// isbn13 and isbn13FromIsbn10 are kept apart deliberately. A valid ISBN-10
// converts to an ISBN-13 for the same book, and Bookshop needs that conversion
// because a 13 is all it will deep-link. But linkResolution is meant to say what
// the *catalogue* gave us — the question it answers is "are the sources carrying
// ISBN-13s, or are readers being dropped into a title search" — so a converted
// identifier is still reported as the isbn10 it came from. Collapsing the two
// would make every ISBN-10 in the feed look like an ISBN-13.
export function identifiersFor(book) {
  const title = trim(book?.title);
  const author = trim(book?.author);
  const isbn10 = isValidIsbn10(book?.isbn10) ? normalizeIsbn(book.isbn10) : null;
  return {
    asin: verifiedAsin(book),
    isbn13: isValidIsbn13(book?.isbn13) ? normalizeIsbn(book.isbn13) : null,
    isbn10,
    isbn13FromIsbn10: isbn10 ? bestIsbn13({ isbn10 }) : null,
    title: title || null,
    author: author || null,
  };
}

// True when there is anything at all to send a retailer. The UI disables "Find a
// copy" on exactly this condition and says why, rather than offering a button
// that opens an empty search.
export function canFindCopy(book) {
  const ids = identifiersFor(book);
  return Boolean(ids.asin || ids.isbn13 || ids.isbn10 || ids.title);
}

// ------------------------------------------------------------- url builders

// One builder per retailer, each returning { url, linkResolution } or null.
// Kept separate on purpose: these are four unrelated third-party formats that
// happen to sit next to each other, not four cases of one pattern.

const q = (params) => new URLSearchParams(params).toString();

function amazonUrl(ids) {
  if (ids.asin) return { url: `https://www.amazon.com/dp/${ids.asin}`, linkResolution: 'asin' };
  if (ids.isbn13) return { url: `https://www.amazon.com/s?${q({ k: ids.isbn13 })}`, linkResolution: 'isbn13' };
  if (ids.isbn10) return { url: `https://www.amazon.com/s?${q({ k: ids.isbn10 })}`, linkResolution: 'isbn10' };
  if (ids.title && ids.author) return { url: `https://www.amazon.com/s?${q({ k: `${ids.title} ${ids.author}` })}`, linkResolution: 'title_author' };
  if (ids.title) return { url: `https://www.amazon.com/s?${q({ k: ids.title })}`, linkResolution: 'title' };
  return null;
}

function thriftbooksUrl(ids) {
  const search = ids.isbn13 || ids.isbn10
    || (ids.title && ids.author ? `${ids.title} ${ids.author}` : ids.title);
  if (!search) return null;
  const linkResolution = ids.isbn13 ? 'isbn13' : ids.isbn10 ? 'isbn10'
    : ids.author ? 'title_author' : 'title';
  return { url: `https://www.thriftbooks.com/browse/?${q({ 'b.search': search })}`, linkResolution };
}

function abebooksUrl(ids) {
  const base = 'https://www.abebooks.com/servlet/SearchResults';
  if (ids.isbn13) return { url: `${base}?${q({ isbn: ids.isbn13 })}`, linkResolution: 'isbn13' };
  if (ids.isbn10) return { url: `${base}?${q({ isbn: ids.isbn10 })}`, linkResolution: 'isbn10' };
  // AbeBooks splits title and author into their own fields, which is a better
  // search than either concatenated into one keyword box.
  if (ids.title && ids.author) return { url: `${base}?${q({ tn: ids.title, an: ids.author })}`, linkResolution: 'title_author' };
  // With no author, tn alone is the supported title search.
  if (ids.title) return { url: `${base}?${q({ tn: ids.title })}`, linkResolution: 'title' };
  return null;
}

function bookshopUrl(ids) {
  // The only one of the four that deep-links on an identifier rather than
  // searching, and an ISBN-13 is the only thing it will take. An ISBN-10 that
  // passes its checksum converts into one and deep-links just as well — but it
  // is still reported as an isbn10, because that is what the feed held. An
  // ISBN-10 that fails its checksum converts to nothing and falls through to
  // search rather than deep-linking a wrong book.
  if (ids.isbn13) return { url: `https://bookshop.org/book/${ids.isbn13}`, linkResolution: 'isbn13' };
  if (ids.isbn13FromIsbn10) return { url: `https://bookshop.org/book/${ids.isbn13FromIsbn10}`, linkResolution: 'isbn10' };
  const keywords = ids.title && ids.author ? `${ids.title} ${ids.author}` : ids.title;
  if (!keywords) return null;
  return { url: `https://bookshop.org/beta-search?${q({ keywords })}`, linkResolution: ids.author ? 'title_author' : 'title' };
}

const BUILDERS = {
  amazon: amazonUrl,
  thriftbooks: thriftbooksUrl,
  abebooks: abebooksUrl,
  bookshop: bookshopUrl,
};

// ------------------------------------------------------------- public api

// The canonical URL and the identifier it was built from, with no affiliate
// decoration. Kept separate from decorate() so the two can be reasoned about —
// and tested — independently, and so a link still works with no affiliate
// configuration at all.
export function resolveBookRetailerUrl(retailer, book) {
  const build = BUILDERS[retailer];
  if (!build || !book) return null;
  return build(identifiersFor(book));
}

// The signature the feature was specified against. Returns the URL alone.
export function createBookRetailerUrl(retailer, book) {
  return resolveBookRetailerUrl(retailer, book)?.url ?? null;
}

// Affiliate parameters, applied only where a real one has been configured.
// Never invents an id and never writes an empty parameter.
export function decorate(url, retailerId, config = {}) {
  if (!url) return url;
  const retailer = getRetailer(retailerId);
  const affiliate = retailer?.affiliate;
  if (!affiliate) return url;
  const value = trim(config[retailerId] ?? affiliate.value);
  if (!value) return url;
  const decorated = new URL(url);
  decorated.searchParams.set(affiliate.param, value);
  return decorated.toString();
}

// What the UI actually calls: canonical URL, affiliate decoration if any, and
// the resolution to report to analytics.
export function linkFor(retailerId, book, affiliateConfig = {}) {
  const resolved = resolveBookRetailerUrl(retailerId, book);
  if (!resolved) return null;
  return {
    retailer: retailerId,
    url: decorate(resolved.url, retailerId, affiliateConfig),
    linkResolution: resolved.linkResolution,
  };
}

// Deliberately absent, and not an oversight: none of these retailers offers a
// supported way for a third party to add a book to a wish list, so there is no
// wish-list sync here. Nor is there price, stock, shipping, cart or checkout —
// all of those would mean either scraping a retailer or asserting something
// about availability that this app cannot know. The saved list lives here; the
// retailers are somewhere to be sent, and nothing more.
