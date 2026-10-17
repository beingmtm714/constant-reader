// Turning a review into a book.
//
// This is the hard half of the pipeline. A review is about a book but rarely names
// it in a structured way, and every publication does it differently. Three tiers,
// best first:
//
//   1. A publication that publishes a book-under-review block — NYRB and the LRB
//      both do — gives title, author, translator, publisher and page count outright.
//   2. A publication with a house title format — the Guardian's "Title by Author
//      review" — parses from the feed alone.
//   3. Everything else falls back to italics and "by" patterns in the review text,
//      which is where the confidence drops and the flag goes up.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseFeed } from './xml.mjs';
import { stripHtml, normalize } from './text.mjs';

// Section prefixes and the quotes a desk wraps a title in are not part of the title.
// The NYT ships "Book Review: 'The Time Tax,'" and means The Time Tax.
// Some desks set the book's title in caps and the payload keeps it that way.
// A word of four letters or more in all caps, with no lowercase anywhere, is
// styling rather than an acronym.
function unshout(s) {
  if (!/[A-Z]{4,}/.test(s) || /[a-z]/.test(s)) return s;
  return titleCase(s.toLowerCase());
}

function cleanTitle(s) {
  return clean(String(s || ''))
    .replace(/^(book\s+review|review|fiction|nonfiction|non-fiction|new\s+books|briefly\s+noted)\s*[:\u2014\u2013-]\s*/i, '')
    .replace(/^[\u2018\u2019'"\u201c\u201d]+|[\u2018\u2019'"\u201c\u201d,;:]+$/g, '')
    .trim();
}

// Zero-width joiners and soft hyphens ride along in scraped copy and are not
// whitespace as far as a regex is concerned, so they survive into titles and
// then break every comparison the book key depends on.
const clean = (s) => {
  const stripped = stripHtml(s).replace(/[\u200b-\u200f\u2060\ufeff\u00ad]/g, '').replace(/\s+/g, ' ').trim();
  // A run of two or more trailing dots is a source's own truncation marker, not
  // stray punctuation - stripping it along with everything else in the trailing
  // class below would turn an already-truncated string into one that no longer
  // even admits it was cut.
  const ellipsis = /\.{2,}\s*$/.test(stripped);
  const out = stripped.replace(/^[\s:;,.\-–—]+|[\s:;,.\-–—]+$/g, '').trim();
  return ellipsis ? `${out}…` : out;
};

// Cuts text to at most `max` characters without splitting a word, appending an
// ellipsis whenever anything was actually removed. Used for standfirst-length
// text pulled from a source that has no length limit of its own, so a cut never
// reads as a sentence that simply stops.
function cutText(s, max) {
  if (!s || s.length <= max) return s;
  const slice = s.slice(0, max);
  const at = slice.lastIndexOf(' ');
  const base = at > 40 ? slice.slice(0, at) : slice;
  return `${base.replace(/[,;:.\-–—]+$/, '')}…`;
}

// ------------------------------------------------------------------ listing

// Three classes of text, not two.
//
// **Critical.** A critic on a book they have read. It says whether the book is
// any good and it is the only text allowed to say so.
//
// **Descriptive.** The author on their own book, at length — the New Books
// Network's episode notes run to a median of 600 characters of argument, which
// is nearly five times what a newspaper standfirst carries. It says what the
// book is about and how it is built. It does not say whether it is any good,
// and it is not asked to: the profile reads form, subject, period, tone and
// scale, and an author describing their own argument answers all five.
//
// **Promotional.** A publisher's catalogue entry. Jacket copy, written to sell.
// It stays out until somebody measures it, which nobody has.
//
// The first version of this file had only the first and the third, and put
// author interviews in with jacket copy on the reasoning that neither "says the
// prose is the weakness". Measured against this archive that was wrong twice
// over: prose register fires on 2% of critic text and 3% of author accounts, so
// it separates nothing, and a low band fires on 14% of author accounts against
// 5% of critic text — the descriptive corpus is harder on its books, not softer.
// Excluding it suppressed 456 books on a hypothesis its own data contradicts.
function applyCritical(source, result) {
  if (source.critical !== false) return result;
  for (const item of result.items || []) {
    item.critical = false;
    if (source.descriptive) item.descriptive = true;
  }
  return result;
}

export async function fetchItems(source, http, defaults) {
  return applyCritical(source, await fetchItemsInner(source, http, defaults));
}

async function fetchItemsInner(source, http, defaults) {
  if (source.kind === 'larb') return fetchLarb(source, http);
  if (source.kind === 'pw') return fetchPw(source, http);
  if (source.kind === 'bookmarks') return fetchBookmarks(source, http);
  if (source.kind === 'bookforum') return fetchBookforum(source, http);
  if (source.kind === '4columns') return fetch4columns(source, http);
  if (source.kind === 'bmcr') return fetchBmcr(source, http);
  if (source.kind === 'catalogue') return fetchCatalogue(source, http);
  if (source.kind === 'archive') return fetchArchive(source, defaults);
  const res = await http.get(source.url);
  if (!res.ok) return { items: [], error: res.error || `HTTP ${res.status}` };

  const raw = parseFeed(res.body, source.url);
  const items = raw.map((it) => ({
    sourceId: source.id,
    reviewTitle: it.title,
    url: it.link,
    guid: it.guid || it.link,
    reviewDate: it.date,
    byline: it.author,
    standfirst: it.summary,
    text: it.content || it.summary,
    html: it.contentHtml || it.summaryHtml,
    categories: it.categories,
  }));
  return { items: filterItems(items, source, defaults), error: null };
}

async function fetchLarb(source, http) {
  const items = [];
  const seen = new Set();
  for (let page = 1; page <= (source.pages || 2); page++) {
    const url = page === 1 ? source.url : `${source.url}?page=${page}`;
    const res = await http.get(url);
    if (!res.ok) { if (page === 1) return { items: [], error: res.error || `HTTP ${res.status}` }; break; }
    const data = nextData(res.body);
    const docs = data?.props?.pageProps?.articles?.docs || [];
    if (!docs.length) break;
    for (const d of docs) {
      if (!d.slug || seen.has(d.slug)) continue;
      seen.add(d.slug);
      items.push({
        sourceId: source.id,
        reviewTitle: d.title,
        url: `https://lareviewofbooks.org/article/${d.slug}/`,
        guid: `larb:${d.id || d.slug}`,
        reviewDate: d.publish_date || null,
        byline: (d.contributors || []).map((c) => c.name).join(', '),
        standfirst: clean(d.description || d.excerpt || ''),
        text: clean(d.description || d.excerpt || ''),
        html: '',
        categories: (d.sections || []).map((s) => s.title).filter(Boolean),
      });
    }
  }
  return { items, error: null };
}

// Publishers Weekly reviews nearly everything the trade publishes, and every review
// page prints the publisher, the page count and the ISBN. Those are exactly the two
// dimensions - scale and provenance - that the catalogue leaves dark for a book
// published this year, so PW is worth the per-review fetch it costs.
async function fetchPw(source, http) {
  const seen = new Set();
  const items = [];
  for (const section of source.sections || ['/pw/reviews/fiction.html']) {
    const res = await http.get(new URL(section, 'https://www.publishersweekly.com').toString());
    if (!res.ok) { if (!items.length) return { items: [], error: res.error || `HTTP ${res.status}` }; continue; }
    for (const m of res.body.matchAll(/\/(97[89][\d-]{10,})/g)) {
      const isbn = m[1];
      // PW links the same review under both the hyphenated and unhyphenated ISBN, so
      // the digits are the identity; the string is not.
      const key = isbn.replace(/-/g, '');
      if (key.length !== 13 || seen.has(key)) continue;
      seen.add(key);
      items.push({
        sourceId: source.id,
        reviewTitle: '',
        url: `https://www.publishersweekly.com/${isbn}`,
        guid: `pw:${key}`,
        reviewDate: null,
        byline: '',
        standfirst: '',
        text: '',
        html: '',
        categories: sectionTags(section),
        isbn,
      });
    }
  }
  return { items, error: null };
}

// Book Marks aggregates the critical press and publishes a weekly list of what it
// rated best. One post is a dozen books, not one, and each line carries title,
// author, publisher and a tally of how the critics landed - "4 Rave, 1 Positive".
// That tally is the closest thing to a consensus signal anywhere in these sources.
const BM_LINE = /(\d+)\.\s+(.+?)\s+by\s+(.+?)\s+\(([^)]{2,40})\)\s+((?:\d+\s+(?:Rave|Positive|Mixed|Pan)\s*(?:•\s*)?)+)/g;

async function fetchBookmarks(source, http) {
  const res = await http.get(source.url);
  if (!res.ok) return { items: [], error: res.error || `HTTP ${res.status}` };
  const posts = parseFeed(res.body, source.url).filter((p) => /best reviewed books/i.test(p.title));

  const items = [];
  const seen = new Set();
  for (const post of posts.slice(0, source.maxPosts || 6)) {
    const page = await http.get(post.link);
    if (!page.ok) continue;
    const body = clean(page.body).replace(/\s+/g, ' ');
    const fictionAt = body.indexOf('Fiction');
    const nonfictionAt = body.indexOf('Nonfiction');

    for (const m of body.matchAll(BM_LINE)) {
      const title = cleanTitle(m[2]);
      const author = clean(m[3]);
      if (!looksLikeTitle(title) || !looksLikeName(author)) continue;
      const key = `${normalize(title)}|${normalize(author)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // Sections run in order, so position in the page says which one a line sits under.
      const isNonfiction = nonfictionAt !== -1 && m.index > nonfictionAt;
      const tally = clean(m[5]).replace(/\s*•\s*/g, ', ');

      items.push({
        sourceId: source.id,
        reviewTitle: `${title} by ${author}`,
        url: post.link,
        guid: `bookmarks:${key}`,
        reviewDate: post.date,
        byline: '',
        standfirst: `Critics: ${tally}.`,
        text: `${post.summary || ''} ${tally}`.trim(),
        html: '',
        categories: [isNonfiction ? 'Nonfiction' : 'Fiction'],
        parsedBook: { title, author, publisher: clean(m[4]), criticTally: tally, confidence: 'high', method: 'bookmarks-list' },
      });
    }
  }
  return { items, error: null };
}

// The section a review was filed under is the publication's own genre label, and
// worth keeping as a tag rather than flattening to fiction/nonfiction.
function sectionTags(section) {
  const name = (section.match(/\/([a-z0-9-]+)\.html$/) || [])[1] || '';
  if (!name || name === 'index') return [];
  const tags = [name];
  if (/fiction|mystery|sci-fi|romance|poetry|comics/.test(name) && name !== 'nonfiction') tags.push('Fiction');
  if (name === 'nonfiction') tags.push('Nonfiction');
  return tags;
}

// "Lina & June Genevieve Wheeler. St. Martin's, $29 (320p) ISBN 978-1-250-28086-2"
// Anchoring on the author rather than splitting on sentences, because "St. Martin's"
// has a full stop in the middle of the publisher's name.
async function fromPw(item, http) {
  const res = await http.get(item.url);
  if (!res.ok) return null;
  const html = res.body;
  const og = clean((html.match(/property="og:title" content="([^"]*)"/) || [])[1] || '');
  const desc = clean((html.match(/property="og:description" content="([^"]*)"/) || [])[1] || '');
  const body = clean(html).replace(/\s+/g, ' ');

  // Self-published titles sometimes come through as "Title by " with nothing after
  // the "by", so the trailing preposition has to come off the title either way.
  let title = cleanTitle(og.replace(/\s+by\s*$/i, '')), author = '';
  const byMatch = og.match(/^(.+?)\s+by\s+(.+)$/i);
  if (byMatch) { title = cleanTitle(byMatch[1]); author = clean(byMatch[2]); }
  if (!title) return null;

  const out = { title, author, confidence: 'high', method: 'pw-review' };

  const spec = body.match(/\((\d+)\s*p\)\s*ISBN\s*([\d-]+)/);
  if (spec) {
    out.pages = Number(spec[1]);
    out.isbn = spec[2];
    const before = body.slice(0, spec.index);
    // Prefer to cut at the author's name; fall back to the last sentence break.
    const anchor = author && before.lastIndexOf(`${author}.`) !== -1
      ? before.slice(before.lastIndexOf(`${author}.`) + author.length + 1)
      : before.split(/\.\s+/).pop();
    const publisher = clean(String(anchor))
      .replace(/[\s,]*\$[\d.,]+.*$/, '')
      .replace(/\b(trade paper|paper|hardcover|paperback|ebook|reprint)\b.*$/i, '')
      .replace(/[,.\s]+$/, '');
    // With no author to anchor on, the sentence-split fallback lands on whatever
    // preceded the publisher - which is the author's name. If it reads as a person
    // and we had no author, it is the author, not the imprint.
    if (publisher && publisher.length <= 60) {
      if (!author && looksLikeName(publisher)) { out.author = publisher; out.confidence = 'medium'; }
      else out.publisher = publisher;
    }
  }

  const reviewed = body.match(/Reviewed on:?\s*(\d{2})\/(\d{2})\/(\d{4})/);
  if (reviewed) item.reviewDate = new Date(`${reviewed[3]}-${reviewed[1]}-${reviewed[2]}T12:00:00Z`).toISOString();

  item.reviewTitle = og || title;
  // The review proper sits between the ISBN line and the boilerplate that follows.
  const after = spec ? body.slice(spec.index + spec[0].length) : body;
  item.text = clean(after).slice(0, 4000);
  // PW's own og:description is an SEO summary the CMS truncates to ~128 chars
  // mid-word - the review body it's drawn from is not truncated, so cut the
  // full text ourselves rather than persist the site's already-broken one.
  item.standfirst = item.text ? cutText(item.text, 300) : desc;
  return out;
}

// Bookforum runs on Nuxt and ships its whole page state as a minified IIFE:
// window.__NUXT__=(function(a,b,c,...){...}(<literals>)). Repeated values are
// hoisted into the parameter list, so a field can read `publicationDate:w` and
// mean the string sitting at position 22 of the argument list. Rebuilding that
// map is worth the trouble: the payload carries a `publications` array with
// title, author, publisher, ISBN and page count, plus the whole review body -
// the tier-1 data the RSS feed stopped providing when the site relaunched.
function nuxtPayload(html) {
  const at = html.indexOf('window.__NUXT__');
  if (at < 0) return null;
  const end = html.indexOf('</script>', at);
  const body = html.slice(at, end < 0 ? html.length : end);
  // \u00XX is how Nuxt escapes the slashes and angle brackets in embedded HTML.
  return body.replace(/\\u00([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

// Split on commas that sit outside every bracket and string.
function splitTop(s) {
  const out = [];
  let depth = 0, quote = null, start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) { out.push(s.slice(start, i)); start = i + 1; }
  }
  out.push(s.slice(start));
  return out;
}

function balanced(s, from, open, close) {
  let depth = 0, quote = null;
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (!depth) return s.slice(from, i + 1); }
  }
  return null;
}

function nuxtAliases(payload) {
  const head = payload.match(/^window\.__NUXT__=\(function\(([^)]*)\)/);
  const open = payload.lastIndexOf('}(');
  const close = payload.lastIndexOf('))');
  if (!head || open < 0 || close < open) return new Map();
  const params = head[1].split(',').map((s) => s.trim());
  const args = splitTop(payload.slice(open + 2, close));
  // A mismatch means the minifier shape changed; fall back to literals only
  // rather than resolving aliases against the wrong positions.
  if (args.length !== params.length) return new Map();
  const map = new Map();
  params.forEach((name, i) => {
    const v = args[i].trim();
    if (v[0] === '"') { try { map.set(name, JSON.parse(v)); } catch { /* keep unset */ } }
    else if (/^-?\d+(\.\d+)?$/.test(v)) map.set(name, Number(v));
  });
  return map;
}

// Read one field off a flat object literal, following an alias when the value is
// a bare identifier. Returns null for anything it cannot resolve to a literal.
function nuxtField(objBody, key, aliases) {
  const m = objBody.match(new RegExp(`(?:^|[,{])${key}:("(?:[^"\\\\]|\\\\.)*"|[A-Za-z_$][A-Za-z0-9_$]*)`));
  if (!m) return null;
  const v = m[1];
  if (v[0] === '"') { try { return JSON.parse(v); } catch { return null; } }
  return aliases.has(v) ? aliases.get(v) : null;
}

// The current print issue plus whatever the fiction desk has run online. The
// issue index is server-rendered; the section pages are not, so their article
// paths come out of the same Nuxt payload.
async function fetchBookforum(source, http) {
  const urls = new Map();
  let firstError = null;

  for (const index of source.indexes || ['https://www.bookforum.com/print', 'https://www.bookforum.com/fiction']) {
    const res = await http.get(index);
    if (!res.ok) { firstError = firstError || res.error || `HTTP ${res.status}`; continue; }
    const hay = nuxtPayload(res.body) || res.body;
    // Deliberately not treated as a genre label. Bookforum's /fiction desk covers
    // writing about fiction as well as fiction itself - a study of literary agents
    // sits there next to the novels - so the index says which desk commissioned the
    // review, not what kind of book is under it.
    for (const m of hay.matchAll(/\/(?:print\/\d+|fiction|culture|politics|interviews)\/[a-z0-9-]+-\d+/g)) {
      const url = new URL(m[0], 'https://www.bookforum.com').toString();
      if (urls.has(url)) continue;
      urls.set(url, url);
    }
  }
  if (!urls.size) return { items: [], error: firstError || 'no article links' };

  return {
    items: [...urls.values()].slice(0, source.maxItems || 40).map((url) => ({
      sourceId: source.id,
      reviewTitle: '',
      url,
      guid: url,
      reviewDate: null,
      byline: '',
      standfirst: '',
      text: '',
      html: '',
      categories: [],
    })),
    error: null,
  };
}

async function fromBookforum(item, http) {
  const res = await http.get(item.url);
  if (!res.ok) return null;
  const payload = nuxtPayload(res.body);
  if (!payload) return null;
  const aliases = nuxtAliases(payload);

  // The article id is in the URL slug, and the article object is the one that
  // declares it. Walking back to that object's opening brace keeps the fields
  // scoped to this piece rather than to a related-article stub.
  const id = (item.url.match(/-(\d+)$/) || [])[1];
  const at = id ? payload.indexOf(`id:${id}`) : -1;
  if (at < 0) return null;
  let depth = 0, start = -1;
  for (let i = at; i >= 0; i--) {
    const c = payload[i];
    if (c === '}') depth++;
    else if (c === '{') { if (!depth) { start = i; break; } depth--; }
  }
  if (start < 0) return null;
  const article = balanced(payload, start, '{', '}');
  if (!article) return null;

  const published = nuxtField(article, 'published', aliases);
  if (published) item.reviewDate = new Date(`${published}Z`).toISOString();
  const channel = nuxtField(article, 'channel', aliases);
  if (channel && !item.categories.includes(channel)) item.categories = [...item.categories, channel];
  item.byline = nuxtField(article, 'writerFormatted', aliases) || item.byline;
  item.reviewTitle = nuxtField(article, 'title', aliases) || item.reviewTitle;
  item.standfirst = clean(nuxtField(article, 'deckFormatted', aliases) || '');
  const body = nuxtField(article, 'bodyFormatted', aliases);
  if (body) { item.html = body; item.text = clean(body).slice(0, 20000); }

  const pubAt = article.indexOf('publications:[');
  if (pubAt < 0) return null;
  const list = balanced(article, pubAt + 'publications:'.length, '[', ']');
  if (!list) return null;
  const title = unshout(cleanTitle(nuxtField(list, 'title', aliases) || ''));
  const author = unshout(clean(nuxtField(list, 'author', aliases) || ''));
  if (!title || !author) return null;

  const out = { title, author, confidence: 'high', method: 'bookforum-publications' };
  const publisher = clean(nuxtField(list, 'publisher', aliases) || '');
  if (publisher) out.publisher = publisher;
  const isbn = String(nuxtField(list, 'isbn', aliases) || '').replace(/[^\dxX-]/g, '');
  if (isbn) out.isbn = isbn;
  const translator = clean(nuxtField(list, 'translator', aliases) || '');
  if (translator) { out.translator = translator; out.translated = true; }
  // "296 pages", occasionally "2 vols., 1104 pages".
  const pages = String(nuxtField(list, 'binding', aliases) || '').match(/(\d{2,4})\s*pages?/i);
  if (pages) out.pages = Number(pages[1]);
  const pubDate = nuxtField(list, 'publicationDate', aliases);
  const year = String(pubDate || '').match(/\b(19|20)\d{2}\b/);
  if (year) out.editionYear = Number(year[0]);
  return out;
}

// 4Columns is a weekly of four pieces, one per art form, and only some are books.
// The archive page is the whole run in one server-rendered table - date, category,
// critic and title per row - so the category filter happens before any article is
// fetched rather than after.
const FC_ROW = /<a class="item" href="(\/[^"]+)"[^>]*><span>([\d.]+)<\/span><span>([^<]*)<\/span><span>([^<]*)<\/span><span>([^<]*)<\/span>/g;
const FC_BOOKISH = /^(literature|nonfiction|poetry|graphic novels)\b/i;

// Public Books prints a books-under-review block, the same idea as NYRB's and
// better furnished: title, author, translator, publisher, year, and an ISBN
// sitting in the Bookshop link beside each one. A review often covers three
// books, so the first is the row and the rest are recorded as also-reviewed.
async function fromPublicBooks(item, http) {
  const res = await http.get(item.url);
  if (!res.ok) return null;
  const container = res.body.match(/class="pb-reviews-container"[\s\S]{0,8000}/);
  if (!container) return null;

  const books = [];
  for (const m of container[0].matchAll(/class="pb-review-item"([\s\S]*?)(?=class="pb-review-item"|$)/g)) {
    const block = m[1];
    const grab = (cls) => {
      const x = block.match(new RegExp(`class="pb-review-${cls}[^"]*"[^>]*>([\\s\\S]*?)<`));
      return x ? clean(stripHtml(x[1])) : '';
    };
    const title = cleanTitle(grab('title'));
    if (!title || !looksLikeTitle(title)) continue;

    // "Vinciane Despret, translated by Helen Morrison"
    const rawAuthor = grab('author');
    const tr = rawAuthor.match(/,?\s*translated by\s+(.+)$/i);
    const author = clean(rawAuthor.replace(/,?\s*translated by\s+.+$/i, ''));

    // "The Ohio State University Press, 2023"
    const info = grab('pub-info');
    const year = (info.match(/\b((?:19|20)\d\d)\b/) || [])[1];
    const publisher = clean(info.replace(/,?\s*(?:19|20)\d\d\s*$/, ''));

    // bookshop.org/a/5882/9780814258729
    const isbn = (block.match(/bookshop\.org\/[^"']*?\/(\d{13})/) || [])[1];

    books.push({
      title,
      author: looksLikeName(author) ? author : '',
      publisher,
      editionYear: year ? Number(year) : undefined,
      isbn13: isbn || '',
      translated: Boolean(tr),
      translator: tr ? clean(tr[1]) : null,
      confidence: 'high',
      method: 'public-books-block',
    });
  }
  if (!books.length) return null;
  return { ...books[0], alsoReviewed: books.slice(1).map((b) => b.title) };
}

// A publisher's own catalogue, which is a different kind of source from every
// other one here.
//
// Every other source says whether a book is any good. This one says only that it
// exists, which is the job Publishers Weekly already does for the trade and
// nobody does for university and independent presses. A book from Verso or
// Coffee House that none of the thirty-four review sources happened to cover
// never reached the feed at all.
//
// What comes back is a shop listing: a title, a date the shop published the
// page, and jacket copy. No author, no ISBN, no page count. So this supplies
// existence and hands the rest to the catalogue lookup, and the mention it
// creates is marked `critical: false` because jacket copy is not evidence about
// a book's quality — but `descriptive: true`, because for a book no critic has
// reviewed and no author has been interviewed about, the publisher's own
// account is the only description of it there is. See the note on the three
// classes of text above, and the note on scoring in bin/build.mjs.
const NOT_A_PRODUCT = /\b(subscription|gift card|gift certificate|tote|t-shirt|tshirt|mug|poster|membership|bundle|back ?issue|donation|merch|sticker|calendar|bookmark|voucher|box set of|preorder pack)\b/i;

// The back catalogue, a slice at a time.
//
// `bin/archive.mjs` discovers addresses and writes them to data/archive/. This
// hands the next few to the build, which fetches and extracts them through the
// same path a review published this morning takes. There is no second scorer and
// no second store, which is the whole reason discovery and extraction are split.
//
// An entry is stamped `taken` before the build has done anything with it, and
// that is deliberate. The store keys on the review URL, so re-offering one costs
// an update rather than a duplicate; leaving an entry untaken after a build that
// crashed on it would offer the same broken address every morning forever.
function fetchArchive(source, defaults) {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'archive');
  const path = join(dir, `${source.backlog || source.id}.json`);
  if (!existsSync(path)) return { items: [], error: null };

  let backlog;
  try { backlog = JSON.parse(readFileSync(path, 'utf8')); }
  catch { return { items: [], error: 'the backlog file is unreadable' }; }

  const want = source.perBuild || 40;
  const taking = [];
  for (const entry of backlog.entries || []) {
    if (entry.taken) continue;
    taking.push(entry);
    if (taking.length >= want) break;
  }
  if (!taking.length) return { items: [], error: null };

  for (const entry of taking) entry.taken = true;
  writeFileSync(path, `${JSON.stringify(backlog)}\n`);

  const items = taking.map((entry) => ({
    sourceId: source.id,
    reviewTitle: entry.reviewTitle || '',
    url: entry.url,
    guid: entry.url,
    reviewDate: entry.reviewDate || null,
    byline: '',
    standfirst: '',
    text: '',
    html: '',
    categories: [],
  }));

  // maxItems on an archive source is a per-build ceiling rather than a feed
  // length, so the shared filter is given the number it was just handed.
  return { items: filterItems(items, { ...source, maxItems: want }, defaults), error: null };
}

async function fetchCatalogue(source, http) {
  const res = await http.get(source.url);
  if (!res.ok) return { items: [], error: res.error || `HTTP ${res.status}` };

  const items = [];
  for (const m of res.body.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1];
    const pick = (re) => { const x = e.match(re); return x ? clean(stripHtml(x[1])) : ''; };
    const title = cleanTitle(pick(/<title[^>]*>([\s\S]*?)<\/title>/));
    const url = (e.match(/<link[^>]*href="([^"]+)"/) || [])[1] || '';
    const published = (e.match(/<published>([^<]+)<\/published>/) || [])[1] || '';
    if (!title || !url || !looksLikeTitle(title)) continue;
    // A publisher's shop sells more than books. Subscriptions, gift cards, tote
    // bags and back-issue bundles all arrive in the same feed with the same
    // shape, and "Fall 2026 Subscription" is not a book however much metadata
    // sits behind it.
    if (NOT_A_PRODUCT.test(title)) continue;

    // Shopify prefixes its summary with the shop's own fields. They are about
    // the listing rather than the book and they fire nothing useful.
    const body = pick(/<(?:summary|content)[^>]*>([\s\S]*?)<\/(?:summary|content)>/)
      // "Vendor: Verso Books Type: Books Price: 9.99 - 29.95 (3 variants)" and
      // then the jacket copy. Cut to the last shop field rather than trying to
      // match the whole prefix in one piece, because which fields appear varies.
      .replace(/^[\s\S]*?\(\d+\s+variants?\)\s*/i, '')
      .replace(/^\s*Vendor:[\s\S]*?Type:\s*\S+\s*/i, '')
      .replace(/^\s*Price:[^)]*\)?\s*/i, '')
      .trim();

    items.push({
      sourceId: source.id,
      reviewTitle: title,
      url,
      guid: url,
      reviewDate: published || new Date().toISOString(),
      byline: '',
      standfirst: cutText(body, 600),
      text: '',
      html: '',
      categories: ['catalogue'],
      // Everything downstream keys on this: what a publisher says about its own
      // book does not get to move a score.
      critical: false,
      descriptive: true,
      parsedBook: {
        title,
        author: '',
        publisher: source.publisher || '',
        confidence: 'medium',
        method: 'publisher-catalogue',
      },
    });
    if (items.length >= (source.maxItems || 40)) break;
  }
  return { items, error: items.length ? null : 'no entries in the catalogue feed' };
}

// Bryn Mawr Classical Review. Its RSS feed is a valid channel with no items in
// it, which is why this reads the front page instead: twenty dated review URLs,
// one per review, newest first.
//
// The reason it is worth the trouble is the same reason Bookforum and 4Columns
// are. Every review page carries an `entry-citation` block printing author,
// title, series, publisher, year, page count and ISBN in one line, which is more
// metadata than any feed in this registry supplies.
async function fetchBmcr(source, http) {
  const res = await http.get(source.url);
  if (!res.ok) return { items: [], error: res.error || `HTTP ${res.status}` };

  const seen = new Set();
  const items = [];
  for (const m of res.body.matchAll(/href="(https:\/\/bmcr\.brynmawr\.edu\/(20\d\d)\/\2\.(\d{2})\.(\d{2})\/)"/g)) {
    const [, url, year, month, seq] = m;
    if (seen.has(url)) continue;
    seen.add(url);
    items.push({
      sourceId: source.id,
      reviewTitle: '',
      url,
      guid: url,
      // 2026.08.14 is the fourteenth review filed in August rather than the
      // fourteenth of the month, so the last number is a sequence and the month
      // is the only real precision. Carrying the sequence as minutes past the
      // first keeps the twenty in the order BMCR filed them without inventing a
      // day none of them has.
      reviewDate: new Date(Date.UTC(Number(year), Number(month) - 1, 1, 0, Number(seq))).toISOString(),
      byline: '',
      standfirst: '',
      text: '',
      html: '',
      categories: ['classics'],
    });
    if (items.length >= (source.maxItems || 20)) break;
  }
  return { items, error: items.length ? null : 'no review links on the index' };
}

// The citation block, which carries everything the scorer wants about provenance
// and scale in a single line:
//   "Jeremy Armstrong, Children of Mars: the origins of Rome's empire. Ancient
//    warfare and civilization. Oxford: Oxford University Press, 2025. Pp. 288.
//    ISBN 9780197584972."
async function fromBmcr(item, http) {
  const res = await http.get(item.url);
  if (!res.ok) return null;
  const block = res.body.match(/class="entry-citation"[^>]*>([\s\S]*?)<\/(?:div|section|p)>/);
  if (!block) return null;
  const line = clean(stripHtml(block[1]).replace(/\s+/g, ' '));

  const head = line.match(/^(.+?)\s*,\s*(.+?)\s*\.\s/);
  if (!head) return null;
  const author = clean(head[1]);
  const title = cleanTitle(head[2]);
  if (!looksLikeName(author) || !looksLikeTitle(title)) return null;

  const out = { title, author, confidence: 'high', method: 'bmcr-citation' };
  const pages = line.match(/\bPp\.\s*(?:[a-z]+,\s*)?(\d{2,4})/i);
  if (pages) out.pages = Number(pages[1]);
  const isbn = line.match(/ISBN\s*([0-9Xx-]{10,17})/);
  if (isbn) {
    const digits = isbn[1].replace(/[^0-9Xx]/g, '');
    if (digits.length === 13) out.isbn13 = digits;
    else if (digits.length === 10) out.isbn10 = digits;
  }
  const pub = line.match(/:\s*([^,.]{3,60}),\s*((?:19|20)\d\d)\b/);
  if (pub) { out.publisher = clean(pub[1]); out.editionYear = Number(pub[2]); }
  // The review page's own headline is the book's title, so it is not a separate
  // fact worth carrying, but the reviewer's name is.
  const title2 = res.body.match(/class="entry-title"[^>]*>([\s\S]*?)<\//);
  if (title2) item.reviewTitle = clean(stripHtml(title2[1]));
  return out;
}

async function fetch4columns(source, http) {
  const res = await http.get(source.url);
  if (!res.ok) return { items: [], error: res.error || `HTTP ${res.status}` };

  const items = [];
  for (const m of res.body.matchAll(FC_ROW)) {
    const category = clean(m[3]);
    if (!FC_BOOKISH.test(category)) continue;
    // 06.26.26 is June 26th 2026. Two-digit years, and the site started in 2016.
    const d = m[2].match(/^(\d{2})\.(\d{2})\.(\d{2})$/);
    if (!d) continue;
    const url = new URL(m[1], 'https://4columns.org').toString();
    items.push({
      sourceId: source.id,
      reviewTitle: clean(m[5]),
      url,
      guid: url,
      reviewDate: new Date(`20${d[3]}-${d[1]}-${d[2]}T12:00:00Z`).toISOString(),
      byline: clean(m[4]),
      standfirst: '',
      text: '',
      html: '',
      categories: [category],
    });
    if (items.length >= (source.maxItems || 30)) break;
  }
  return { items, error: items.length ? null : 'no book rows in archive' };
}

// Every review opens with a centred bibliographic line:
//   Title: Subtitle, by Author, Publisher, 132 pages, $18
// The page counts and prices are wrapped in <span class="italic">, so the tags
// have to come off before the line parses.
async function from4columns(item, http) {
  const res = await http.get(item.url);
  if (!res.ok) return null;
  const html = res.body;
  // The cover image sits between the dek and the bibliographic line, so cutting at
  // <div class="figure"> - the obvious boundary - throws away the half that matters.
  const at = html.indexOf('<div class="column-copy">');
  const copy = at < 0 ? html : html.slice(at);

  const paragraphs = [...copy.matchAll(/<p[^>]*text-align:\s*center[^>]*>([\s\S]*?)<\/p>/g)].map((m) => clean(m[1]));
  const bib = paragraphs.find((p) => /,\s*by\s+[A-Z]/.test(p) && /\d{2,4}\s*pages?/i.test(p))
    || paragraphs.find((p) => /,\s*by\s+[A-Z]/.test(p));
  if (!bib) return null;

  const split = bib.match(/^(.+?),\s*by\s+(.+)$/);
  if (!split) return null;
  const title = cleanTitle(split[1]);
  const rest = split[2];
  const parts = rest.split(/,\s*/).map((s) => clean(s)).filter(Boolean);
  const author = parts.shift() || '';
  if (!title || !looksLikeName(author)) return null;

  const out = { title, author, confidence: 'high', method: '4columns-bib' };
  const pages = rest.match(/(\d{2,4})\s*pages?/i);
  if (pages) out.pages = Number(pages[1]);
  // A translated book puts "translated from the French by X" between the author and
  // the imprint, and it splits on commas like everything else, so the first surviving
  // part is the translator rather than the publisher unless it is skipped by name.
  const translated = rest.match(/translated\s+(?:from\s+the\s+\w+\s+)?by\s+([^,]+)/i);
  if (translated) { out.translator = clean(translated[1]); out.translated = true; }
  const publisher = parts.find((p) => !/^\$/.test(p) && !/\d{2,4}\s*pages?/i.test(p)
    && !/\btranslat(ed|ion)\b/i.test(p) && !/^(and|with)\b/i.test(p) && p.length <= 60);
  if (publisher) out.publisher = publisher;

  // The dek is the centred line above the cover; the review is everything after it.
  const dek = paragraphs.find((p) => p !== bib && p.length > 20 && !/^\W*$/.test(p));
  if (dek) item.standfirst = dek;
  item.text = clean(copy.replace(/<script[\s\S]*?<\/script>/g, '')).slice(0, 20000);
  item.html = copy;
  return out;
}

function nextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

function filterItems(items, source, defaults) {
  const excludes = (defaults.titleExcludes || []).map((s) => s.toLowerCase());
  const out = [];
  for (const it of items) {
    if (!it.url || !it.reviewTitle) continue;
    const t = it.reviewTitle.toLowerCase();
    if (excludes.some((x) => t.includes(x))) continue;
    if (source.titleRequires && !source.titleRequires.some((r) => t.includes(r.toLowerCase()))) continue;
    if (source.titleExcludes && source.titleExcludes.some((x) => t.includes(x.toLowerCase()))) continue;
    if (source.summaryExcludes && source.summaryExcludes.some((x) => (it.standfirst || '').toLowerCase().trim().startsWith(x.toLowerCase()))) continue;
    if (source.pathRequiresAny && !source.pathRequiresAny.some((p) => it.url.includes(p))) continue;
    if (source.pathIncludes && !source.pathIncludes.some((p) => it.url.includes(p))) continue;
    out.push(it);
  }
  return out.slice(0, source.maxItems || defaults.maxItems || 60);
}

// ------------------------------------------------------------------ book extraction

// A season preview lists a hundred books with the same markup a review uses for
// one. Taking the first italic title out of that list produces a confident, wrong
// answer, so a page that names many books is treated as naming none.
function isRoundup(item) {
  let html = item.html || '';
  if (html.includes('&lt;')) html = html.replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  // Not "how many things are in italics" - a full review italicises for emphasis all
  // the time. What marks a roundup is title-then-attribution, over and over.
  const attributed = (html.match(/<(?:em|i|cite)>[^<]{3,120}<\/(?:em|i|cite)>\s*[,(]?\s*by\s+[A-Z]/g) || []).length;
  if (attributed >= 6) return true;
  return /\b\d{2,3}\s+(?:titles|books|novels)\b/i.test(`${item.reviewTitle} ${item.standfirst}`);
}

export async function extractBook(item, source, http, { fetchArticle = true } = {}) {
  // Already parsed at listing time, because the listing is where the data lives.
  if (item.parsedBook) return item.parsedBook;
  // Already parsed at listing time, because the listing is where the data lives.
  if (fetchArticle && source.article === 'nyrb') {
    const found = await fromNyrb(item, http);
    if (found) return found;
  }
  if (fetchArticle && source.article === 'lrb') {
    const found = await fromLrb(item, http);
    if (found) return found;
  }
  if (source.article === 'bookforum') {
    const found = await fromBookforum(item, http);
    if (found) return found;
    return { title: '', author: '', confidence: 'none', method: 'unresolved' };
  }
  if (fetchArticle && source.article === 'public-books') {
    const found = await fromPublicBooks(item, http);
    if (found) return found;
    return { title: '', author: '', confidence: 'none', method: 'unresolved' };
  }
  if (source.article === 'bmcr') {
    const found = await fromBmcr(item, http);
    if (found) return found;
    return { title: '', author: '', confidence: 'none', method: 'unresolved' };
  }
  if (source.article === '4columns') {
    const found = await from4columns(item, http);
    if (found) return found;
    return { title: '', author: '', confidence: 'none', method: 'unresolved' };
  }
  if (source.article === 'pw') {
    const found = await fromPw(item, http);
    if (found) return found;
    return { title: '', author: '', confidence: 'none', method: 'unresolved' };
  }
  if (fetchArticle && source.article === 'larb') {
    const found = await fromLarb(item, http);
    if (found) return found;
    const enriched = await enrichLarb(item, http);
    if (enriched) { item.html = enriched; item.text = stripHtml(enriched).slice(0, 20000); }
  }
  if (source.titlePattern === 'dash-author') {
    const found = fromDashTitle(item);
    if (found) return found;
  }
  if (source.titlePattern === 'nyt') {
    const found = fromNytTitle(item);
    if (found) return found;
  }
  if (source.titlePattern === 'nbn') {
    const found = fromNbnTitle(item);
    if (found) return found;
  }
  if (source.titlePattern === 'kirkus') {
    const found = fromKirkus(item);
    if (found) return found;
  }
  if (source.titlePattern === 'guardian') {
    const found = fromGuardianTitle(item);
    if (found) return found;
  }
  if (isRoundup(item)) return { title: '', author: '', confidence: 'none', method: 'roundup-skipped' };
  return fromGenericText(item);
}

// NYRB: a sidebar headed "Reviewed:" with one <article> per book.
async function fromNyrb(item, http) {
  const res = await http.get(item.url);
  if (!res.ok) return null;
  const html = res.body;
  const start = html.indexOf('review-items');
  if (start === -1) return null;
  const block = html.slice(start, start + 6000);
  const articles = [...block.matchAll(/<article[^>]*>([\s\S]*?)<\/article>/g)].map((m) => m[1]);
  if (!articles.length) return null;

  const books = articles.map((a) => {
    const title = cleanTitle((a.match(/<a[^>]*>([\s\S]*?)<\/a>/) || [])[1] || '');
    const attribution = clean((a.match(/class="attribution[^"]*"[^>]*>([\s\S]*?)<\/div>/) || [])[1] || '');
    const details = clean((a.match(/class="details[^"]*"[^>]*>([\s\S]*?)<\/div>/) || [])[1] || '');
    return { title, ...parseAttribution(attribution), ...parseDetails(details) };
  }).filter(isReviewedBook);

  if (!books.length) return null;
  const body = clean((html.match(/class="article-main-content[^"]*"[^>]*>([\s\S]*?)<\/div>/) || [])[1] || '');
  if (body.length > 200) item.text = body.slice(0, 20000);

  return { ...books[0], alsoReviewed: books.slice(1).map((b) => b.title), confidence: 'high', method: 'nyrb-reviewed-block' };
}

// LRB: .reviewed-items, with icon-book / icon-film telling you the medium.
async function fromLrb(item, http) {
  const res = await http.get(item.url);
  if (!res.ok) return null;
  const html = res.body;
  const start = html.indexOf('reviewed-items');
  if (start === -1) return null;
  const block = html.slice(start, start + 8000);
  const entries = [...block.matchAll(/<div class="article-reviewed-item[^"]*"[\s\S]*?(?=<div class="article-reviewed-item|<\/div>\s*<a href="#Read-More)/g)].map((m) => m[0]);
  const items = entries.length ? entries : [block.slice(0, 3000)];

  const books = [];
  for (const e of items) {
    if (/icon-(film|exhibition|music|theatre|tv)/.test(e)) continue;
    const title = cleanTitle((e.match(/class="article-reviewed-item-title"[^>]*>([\s\S]*?)<\/span>/) || [])[1] || '');
    if (!title) continue;
    const subtitle = clean((e.match(/class="article-reviewed-item-subtitle"[^>]*>([\s\S]*?)<\/span>/) || [])[1] || '');
    const byRaw = (e.match(/<span class=['"]by['"]>([\s\S]*?)<\/span>/) || [])[1] || '';
    // The by-line span also contains the <i class="item-meta"> publisher block.
    const by = clean(byRaw.replace(/<i class="item-meta">[\s\S]*$/, ''));
    const meta = clean((e.match(/<i class="item-meta">([\s\S]*?)<\/i>/) || [])[1] || '');
    books.push({ title, subtitle, ...parseAttribution(by), ...parseDetails(meta) });
  }
  const kept = books.filter(isReviewedBook);
  if (!kept.length) return null;
  books.length = 0;
  books.push(...kept);

  const body = clean((html.match(/<main itemprop="articleBody">([\s\S]*?)<\/main>/) || [])[1] || '');
  if (body.length > 200) item.text = body.slice(0, 20000);

  return { ...books[0], alsoReviewed: books.slice(1).map((b) => b.title), confidence: 'high', method: 'lrb-reviewed-block' };
}

// LARB: the page ships a `reviewed_media` array carrying the book under review as
// structured data - title, author, publisher, page count, ISBN and translators.
// This is the same shape NYRB and the LRB provide and it is the best of the three,
// so LARB belongs in the house-parser tier rather than in the prose fallback.
//
// It was reaching that fallback before, which is how "The Little Rock convention
// was modeled on meetings held" became a book by "African Americans": the review's
// own sentence, split on the word "by". The block was on the page the whole time.
async function fromLarb(item, http) {
  const res = await http.get(item.url);
  if (!res.ok) return null;
  const i = res.body.indexOf('"reviewed_media"');
  if (i === -1) return null;

  // The payload is one long JSON string, so the values are pulled by key rather
  // than by parsing a document whose shape LARB is free to change around them.
  const win = res.body.slice(i, i + 4000);

  // Every string in the payload is JSON-escaped, so "W. W. Norton \u0026 Company"
  // keeps its encoded ampersand unless it goes back through the parser.
  const unesc = (v) => { try { return clean(JSON.parse(`"${v}"`)); } catch { return clean(v); } };
  const str = (k) => {
    const m = win.match(new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
    return m ? unesc(m[1]) : '';
  };
  const num = (k) => {
    const m = win.match(new RegExp(`"${k}"\\s*:\\s*(\\d+)`));
    return m ? Number(m[1]) : null;
  };

  // LARB files films, albums and exhibitions in the same array. Only a book is a
  // book, and a book under review has a name on it: without both, this falls
  // through to the prose tiers rather than producing a title nobody wrote.
  if (!/"relationTo"\s*:\s*"books"/.test(win)) return null;

  const title = str('title');
  if (!title || !looksLikeTitle(title)) return null;

  // "author":[{"__typename":"Author","name":"Katja Hoyer"}] - the first name after
  // the author array opens is the one under review.
  const aBlock = win.slice(win.indexOf('"author"'));
  const aName = aBlock.match(/"name"\s*:\s*"([^"]{2,80})"/);
  const author = aName ? unesc(aName[1]) : '';
  if (!author || author.length < 2 || author.length > 80) return null;

  const pubBlock = win.match(/"publisher"\s*:\s*\{[^}]*"name"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const translated = /"translators"\s*:\s*\[\s*\{/.test(win);
  const tName = translated ? win.slice(win.indexOf('"translators"')).match(/"name"\s*:\s*"((?:[^"\\]|\\.)*)"/) : null;
  const isbn = str('isbn').replace(/[^0-9Xx]/g, '');
  const pubDate = str('published_on');

  return {
    title: cleanTitle(title),
    author,
    publisher: pubBlock ? unesc(pubBlock[1]) : '',
    pages: num('page_count'),
    isbn13: isbn.length === 13 ? isbn : '',
    isbn10: isbn.length === 10 ? isbn : '',
    translated,
    translator: tName ? unesc(tName[1]) : null,
    editionYear: /^\d{4}/.test(pubDate) ? Number(pubDate.slice(0, 4)) : undefined,
    confidence: 'high',
    method: 'larb-reviewed-media',
  };
}

async function enrichLarb(item, http) {
  const res = await http.get(item.url);
  if (!res.ok) return null;
  const data = nextData(res.body);
  const doc = data?.props?.pageProps?.articles?.docs?.[0];
  if (!doc?.content?.root) return null;
  const ITALIC = 2;
  const walk = (n) => {
    if (!n) return '';
    let out = '';
    if (typeof n.text === 'string') out += (n.format & ITALIC) ? `<em>${n.text}</em>` : n.text;
    for (const c of n.children || []) out += walk(c) + (c.type === 'customParagraph' ? ' ' : '');
    return out;
  };
  const html = walk(doc.content.root).replace(/\s+/g, ' ').trim();
  return html.length > 200 ? html.slice(0, 24000) : null;
}

// "Title by Author review - standfirst"
function fromGuardianTitle(item) {
  const m = item.reviewTitle.match(/^(.+?)\s+by\s+(.+?)\s+review\b\s*[-–—:]?\s*(.*)$/i);
  if (!m) return null;
  const author = clean(m[2]).replace(/\s+(audiobook|audio|ebook|paperback|hardback)$/i, '');
  return { title: cleanTitle(m[1]), author, confidence: 'high', method: 'guardian-title' };
}

// NYT: "Book Review: 'The Time Tax,' by Annie Lowrey" - the desk prefix, the curly
// quotes and the trailing comma inside them all have to come off.
function fromNytTitle(item) {
  const t = clean(item.reviewTitle);
  const withAuthor = t.match(/^(?:book\s+review|review|fiction)\s*:\s*[\u2018\u201c'"](.+?)[,;]?\s*[\u2019\u201d'"]\s*,?\s*by\s+(.+?)$/i);
  if (withAuthor && looksLikeTitle(cleanTitle(withAuthor[1])) && looksLikeName(withAuthor[2])) {
    return { title: cleanTitle(withAuthor[1]), author: clean(withAuthor[2]), confidence: 'high', method: 'nyt-title' };
  }
  const titleOnly = t.match(/^(?:book\s+review|review|fiction)\s*:\s*[\u2018\u201c'"](.+?)[,;]?\s*[\u2019\u201d'"]\s*$/i);
  if (titleOnly && looksLikeTitle(cleanTitle(titleOnly[1]))) {
    return { title: cleanTitle(titleOnly[1]), author: '', confidence: 'medium', method: 'nyt-title' };
  }
  return null;
}

// Full Stop: "The Twenties - Varlam Shalamov"
function fromDashTitle(item) {
  const m = item.reviewTitle.match(/^(.{2,90}?)\s+[–—-]\s+(.{2,60})$/);
  if (!m || !looksLikeTitle(m[1]) || !looksLikeName(m[2])) return null;
  return { title: cleanTitle(m[1]), author: clean(m[2]), confidence: 'high', method: 'dash-title' };
}

// Kirkus: the title is the headline in caps, the author is a slug in the URL -
// /book-reviews/<author>/<title>/
// The New Books Network files every episode as
//   Author Name, "Title: Subtitle" (Publisher, Year)
// across five hundred items and a hundred channels, which is more structure than
// any review feed here offers and covers exactly the academic presses that
// publish press releases instead of catalogues.
//
// It is an author interview rather than a review. The description says what the
// book is about and never whether it is any good, so the source is marked
// critical: false and supplies existence and metadata only.
function fromNbnTitle(item) {
  const m = String(item.reviewTitle || '').match(
    /^(.+?),\s*[“"']([^”"']{3,150})[”"']\s*(?:\(([^,)]{2,60})(?:,\s*((?:19|20)\d\d))?\))?/,
  );
  if (!m) return null;
  const author = clean(m[1].replace(/\s+and\s+.*$/, ''));
  const title = cleanTitle(m[2]);
  if (!looksLikeTitle(title) || !looksLikeName(author)) return null;
  const out = { title, author, confidence: 'high', method: 'nbn-title' };
  if (m[3]) out.publisher = clean(m[3]);
  if (m[4]) out.editionYear = Number(m[4]);
  return out;
}

function fromKirkus(item) {
  const m = item.url.match(/\/book-reviews\/([^/]+)\//);
  if (!m) return null;
  const author = m[1].split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  const title = titleCase(item.reviewTitle);
  if (!looksLikeTitle(title)) return null;
  return { title, author, confidence: 'high', method: 'kirkus-url' };
}

const SMALL = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'nor', 'of', 'on', 'or', 'the', 'to', 'with']);
function titleCase(s) {
  const words = clean(s).toLowerCase().split(/\s+/);
  return words.map((w, i) => (i > 0 && SMALL.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
}

const TITLE_PATTERNS = [
  /^review:\s*(.+?)\s+by\s+([^,;(]+)/i,
  /^(.+?),?\s+by\s+([^,;(]+?)(?:\s*[-–—:].*)?$/i,
  /^[“"'‘](.+?)[”"'’]\s*,?\s*by\s+([^,;(]+)/i,
];

// Last resort: the review's own prose. An italicised title followed by "by Name" is
// the most reliable shape; failing that, the review's headline.
function fromGenericText(item) {
  // Several feeds ship their markup entity-encoded inside CDATA, so the <em> that
  // carries the book title is literally "&lt;em&gt;" until this runs.
  let html = item.html || '';
  if (html.includes('&lt;')) html = html.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  const ital = [...html.matchAll(/<(?:em|i|cite)>([^<]{3,120})<\/(?:em|i|cite)>/gi)].map((m) => clean(m[1]));
  for (const t of ital) {
    const after = html.split(new RegExp(`<(?:em|i|cite)>\\s*${escapeRe(t)}\\s*</(?:em|i|cite)>`, 'i'))[1] || '';
    // Stop at the end of the name. `[^,.;()]{2,60}` ran on into whatever followed,
    // which is how "Belonging by Nora Krug In a series of..." produced an author
    // called "Nora Krug In".
    const by = clean(after.slice(0, 160)).match(/^\s*[,(]?\s*by\s+([A-Z][A-Za-z.'’-]+(?:\s+[A-Z][A-Za-z.'’-]+){0,3})/);
    if (by && looksLikeTitle(t)) {
      return { title: cleanTitle(t), author: clean(by[1]), confidence: 'medium', method: 'italics-by' };
    }
  }

  // "Chang-rae Lee's new novel, <em>A Tender Age</em>" - the title is marked up but
  // the author sits in front of it as a possessive rather than behind it as a "by".
  for (const t of ital) {
    if (!looksLikeTitle(t)) continue;
    const idx = html.indexOf(`>${t}<`);
    if (idx === -1) continue;
    const before = html.slice(Math.max(0, idx - 240), idx).replace(/<[^>]+>/g, ' ');
    const poss = before.match(/([A-Z][A-Za-z.'’-]+(?:\s+[A-Z][A-Za-z.'’-]+){0,3})(?:’s|'s)\s+(?:new |latest |debut |first |second |third |own )*(?:novel|book|collection|memoir|début|debut)\b[^.]{0,40}$/);
    // A sentence starting "In Autumn DeWilde's book" capitalises its first word,
    // and the capture then reads that preposition as part of the name.
    const name = poss ? clean(poss[1]).replace(/^(In|On|At|By|For|From|With|After|Before)\s+/, '') : '';
    if (poss && looksLikeName(name)) {
      return { title: cleanTitle(t), author: name, confidence: 'medium', method: 'italics-possessive' };
    }
  }

  // "Rachel Cusk's new book, 'Life of M'" and "K.S. Shay's energetic Portrait of
  // a Witch Undone". The italics-possessive tier above wants <em> markup, which a
  // plain-text feed description does not have, and this is the shape the general
  // press actually files in: the author possessive, a noun for the book, then the
  // title in quotes or bare.
  //
  // It found nothing for the LA Times, BookPage and the Christian Science Monitor,
  // all three of which review constantly. The LA Times had been enabled and
  // yielding zero books out of thirty items for as long as it has been in the
  // registry.
  //
  // The possessive carries its own evidence, so this does not need the headline
  // corroboration prose-by needs: "X's new novel, Y" names a book and its author
  // in one clause and cannot be a fragment of some other sentence.
  const hay = `${item.standfirst} ${item.text}`.slice(0, 3000);
  const poss = hay.match(
    /([A-Z][A-Za-z.'’-]+(?:\s+[A-Z][A-Za-z.'’-]+){0,3})(?:’s|'s)\s+(?:new |latest |debut |first |second |third |own |excellent |energetic |compelling )*(?:novel|book|memoir|collection|history|biography|debut|début)\s*,?\s*[“"'‘]?([A-Z][^“”"'’.!?]{2,80}?)[”"'’]?(?=[.,;]|\s+(?:is|was|has|explores|reveals|follows|takes|weaves)\b)/,
  );
  if (poss) {
    const name = clean(poss[1]).replace(/^(In|On|At|By|For|From|With|After|Before)\s+/, '');
    const title = cleanTitle(poss[2]);
    if (looksLikeName(name) && looksLikeTitle(title) && !readsAsClause(title)) {
      return { title, author: name, confidence: 'medium', method: 'possessive-quoted' };
    }
  }

  for (const re of TITLE_PATTERNS) {
    const m = item.reviewTitle.match(re);
    if (m && looksLikeTitle(m[1]) && looksLikeName(m[2])) {
      return { title: cleanTitle(m[1]), author: clean(m[2]), confidence: 'medium', method: 'review-title' };
    }
  }

  // Any sentence containing the word "by" matches this shape, which is why it
  // produced "The Little Rock convention was modeled on meetings held" by "African
  // Americans", "Photograph" by "Bernard Gotfryd", and ten more like them: twelve
  // of the thirteen books it found were fragments of the review's own prose.
  //
  // Two gates now. The run before "by" has to read as a title rather than as a
  // clause, which means no conjugated verb anywhere in it rather than only at the
  // end. And the review has to be about the book: the headline or the URL has to
  // name it, the same corroboration italics-corroborated already demands. A title
  // lifted from the middle of a paragraph, in a review whose own headline never
  // mentions it, is a sentence rather than a book.
  const body = `${item.standfirst} ${item.text}`.slice(0, 3000);
  const inline = body.match(/\b([A-Z][A-Za-z'’]+(?:\s+[A-Za-z'’:,-]+){0,8}?)\s*[,(]?\s*by\s+([A-Z][a-z]+(?:\s+[A-Z][A-Za-z.'’-]+){1,3})\b/);
  if (inline && looksLikeTitle(inline[1]) && !readsAsClause(inline[1])
      && looksLikeName(inline[2]) && corroborates(item, inline[1])) {
    return { title: cleanTitle(inline[1]), author: clean(inline[2]), confidence: 'low', method: 'prose-by' };
  }

  // An italic run with no author attached is only worth trusting when the review's
  // own headline or URL is about it too. Otherwise it is emphasis, not a title.
  const slug = (item.url || '').toLowerCase();
  const head = normalize(item.reviewTitle);
  for (const t of ital) {
    if (!looksLikeTitle(t)) continue;
    const key = normalize(t);
    const slugKey = key.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (key.length >= 6 && (head.includes(key) || (slugKey.length >= 8 && slug.includes(slugKey)))) {
      return { title: t, author: '', confidence: 'low', method: 'italics-corroborated' };
    }
  }
  return { title: '', author: '', confidence: 'none', method: 'unresolved' };
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// A conjugated verb anywhere in the run means it is a sentence. looksLikeTitle only
// rejects one at the very end, which lets "the Lusitania was sunk" through.
const CLAUSE_VERB = /\b(is|was|were|are|be|been|being|has|have|had|does|did|says|said|writes|wrote|features|featured|expressed|revealed|published|sunk|modeled|modelled|came|comes|makes|made|takes|took|gives|gave|shows|showed|tells|told|calls|called|opens|opened|argues|argued|becomes|became)\b/i;
function readsAsClause(t) { return CLAUSE_VERB.test(String(t || '')); }

// The review has to be about the book, not merely to mention it. Same test
// italics-corroborated makes: the headline or the URL names it.
function corroborates(item, title) {
  const key = normalize(title);
  if (key.length < 6) return false;
  const slugKey = key.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return normalize(item.reviewTitle).includes(key)
    || (slugKey.length >= 8 && String(item.url || '').toLowerCase().includes(slugKey));
}

// A book has a page count or a person's name attached to it. An exhibition has a
// venue and a date range in the same slot.
function isReviewedBook(b) {
  if (!b || !b.title) return false;
  if (b.notABook) return false;
  if (/\b(exhibition|museum|gallery|directed by|at the [A-Z])/i.test(b.author || '')) return false;
  return Boolean(b.pages) || looksLikeName(b.author || '');
}

// Reviews italicise for emphasis at least as often as for titles. "thinking",
// "pessimism" and "for" all arrived as candidate book titles before this existed,
// and each of them matched a real book in the catalogue.
const NOT_A_TITLE = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'of', 'for', 'is', 'not', 'was',
  'very', 'really', 'thinking', 'feeling', 'being', 'doing', 'read', 'reading',
  'write', 'writing', 'written', 'said', 'says', 'now', 'then', 'here', 'there',
  'this', 'that', 'these', 'those', 'all', 'any', 'more', 'most', 'just', 'still',
  'about', 'almost', 'always', 'never', 'me', 'you', 'we', 'they', 'it',
]);
const PUBLICATIONS = /^(the )?(new york times|guardian|atlantic|new yorker|london review( of books)?|paris review|los angeles review( of books)?|nyrb|lrb|larb|times literary supplement|washington post|financial times|harper's|new republic|bookforum|n\+1|kirkus|publishers weekly)$/i;

function looksLikeTitle(t) {
  const s = String(t || '').trim();
  if (s.length < 3 || s.length > 120) return false;
  if (PUBLICATIONS.test(s)) return false;
  const words = s.split(/\s+/);
  if (words.length > 14) return false;
  if (NOT_A_TITLE.has(s.toLowerCase())) return false;
  // A title starts like one.
  if (!/^[A-Z0-9“"'‘(]/.test(s)) return false;
  // A clause, not a title: ends mid-sentence or runs on past a full stop.
  if (/\.\s+[a-z]/.test(s)) return false;
  if (/\b(is|was|are|were|has|have|had|says|said|writes|wrote|from|onto|into)$/i.test(s)) return false;
  // A single word only counts when it is properly capitalised and not a stopword.
  if (words.length === 1) return /^[A-Z][a-z’'-]{2,}$/.test(s) || /^[A-Z]{2,}$/.test(s);
  return true;
}

// Two to four capitalised parts, allowing the usual particles and initials, and
// nothing that reads as a fragment of a sentence.
const PARTICLE = /^(de|del|della|di|da|van|von|der|den|ter|la|le|du|dos|bin|ibn|al|el|y|mac|mc|st\.?)$/i;

function looksLikeName(n) {
  const s = clean(n).replace(/\s+(and|with|&)\s+.*$/i, '').replace(/[,.;]+$/, '');
  if (!s || s.length < 4 || s.length > 60) return false;
  if (/\d/.test(s)) return false;
  if (/\b(review|novel|book|edited|translated|published|press|books|onto|into|set|newly)\b/i.test(s)) return false;
  const parts = s.split(/\s+/);
  if (parts.length < 2 || parts.length > 5) return false;
  return parts.every((p) => {
    if (PARTICLE.test(p)) return true;
    if (p.endsWith('.') && p.length > 4) return false; // "Carusillo." is a truncation
    // An initial is a name part: "J." in "J. D. Vance". A bare single letter with
    // no period is not, so the period is what makes the difference.
    if (/^[A-Z]\.$/.test(p)) return true;
    return /^[A-Z][A-Za-z.'’-]*$/.test(p) && p.replace(/[.'’-]/g, '').length >= 2;
  });
}

// "by Maggie Haberman and Jonathan Swan" / "by Felix Platter, translated by Seán Jennett"
function parseAttribution(s) {
  if (!s) return { author: '' };
  const out = {};
  const tr = s.match(/translated (?:from [^,]*? )?by\s+([^,.;]+)/i);
  if (tr) { out.translated = true; out.translator = clean(tr[1]); }
  const cleaned = s.replace(/translated (?:from [^,]*? )?by\s+[^,.;]+/i, '');
  const by = cleaned.match(/\bby\s+(.+)$/i) || cleaned.match(/^(.+)$/);
  out.author = clean((by ? by[1] : '').replace(/[,.;]\s*$/, ''));
  if (/^(directed|edited|selected|introduced)\b/i.test(clean(s))) out.notABook = true;
  return out;
}

// "Simon and Schuster, 464 pp., $34.00" / "Routledge, 694 pp., £43.99, January 2025, 978..."
function parseDetails(s) {
  const out = {};
  if (!s) return out;
  const pages = s.match(/(\d{2,4})\s*pp?\b/i);
  if (pages) out.pages = Number(pages[1]);
  const publisher = s.match(/^\s*([^,]{2,60}?)\s*,/);
  if (publisher) out.publisher = clean(publisher[1]);
  const date = s.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/i);
  if (date) out.editionDate = `${date[1]} ${date[2]}`;
  const year = s.match(/\b(19|20)\d{2}\b/);
  if (year) out.editionYear = Number(year[0]);
  return out;
}

export function looksLikeReview(item, book) {
  const hay = normalize(`${item.reviewTitle} ${item.standfirst}`);
  if (book?.title) return true;
  return /\breview\b|\bnovel\b|\bfiction\b/.test(hay);
}
