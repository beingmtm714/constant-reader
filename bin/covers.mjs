#!/usr/bin/env node
// Finding a better jacket for a book that has a poor one, or none.
//
// Two things put a soft cover on the screen and neither is fixable in the
// browser, because by then the only address the app has is the one the build
// wrote down.
//
// **The wrong source was preferred.** `merge` took Open Library's cover ahead of
// Google's wherever the catalogue matched, on the reasoning that a matched
// record is the more trustworthy source. It is, for facts. It is not, for
// pixels: Open Library serves three fixed sizes and its largest is about 300px,
// while Google renders the same jacket at 1000px. That is now the other way
// round, but only for books crawled after the change — the ones already in the
// store keep the address they were given.
//
// **And a cover found late was never looked for.** The title-and-author search
// runs when a book is first resolved, before an ISBN is known. An ISBN is an
// exact key, and a good number of the books with no jacket at all have one.
//
// So this walks the store, asks Google for a jacket by ISBN wherever the current
// one is Open Library's or missing, and **measures both before it swaps**. A
// 1000px replacement is worth having and a 128px thumbnail is not; without the
// measurement this would happily trade 300 real pixels for 128.
//
//   node bin/covers.mjs             report what would change, write nothing
//   node bin/covers.mjs --write     do it
//   node bin/covers.mjs --limit=50  a smaller bite
//
// Writes only `book.coverUrl`. Everything else on a record was settled by a
// match with more to go on than an ISBN lookup has.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ensureProxyAware } from '../lib/proxy.mjs';
import { Http } from '../lib/http.mjs';
import { coverByIsbn, googleAvailable } from '../lib/books.mjs';

ensureProxyAware();

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (n) => args.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
const flag = (n) => args.includes(`--${n}`);

const write = flag('write');
const limit = Number(arg('limit') || 0) || Infinity;

const DIM = '\x1b[2m', OFF = '\x1b[0m', GREEN = '\x1b[32m', RED = '\x1b[31m';
const pad = (s, n) => String(s).padEnd(n).slice(0, n);

const http = new Http({ cacheDir: join(root, '.cache'), ttlHours: 24 * 30, delayMs: 250 });

// How wide the file actually is, read from the JPEG or PNG header rather than
// downloaded whole. A jacket is the one thing here worth measuring in pixels,
// and 800 of them at 60KB each is 48MB nobody needs to transfer twice.
function widthOf(buf) {
  if (!buf || buf.length < 24) return 0;
  // PNG: IHDR width is a big-endian uint32 at byte 16.
  if (buf[0] === 0x89 && buf[1] === 0x50) return buf.readUInt32BE(16);
  // JPEG: walk the segments to the first frame header, whose width sits five
  // bytes into the payload.
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      // SOF0 through SOF15, skipping the four that are not frame headers.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc, 0xd8].includes(marker)) {
        return buf.readUInt16BE(i + 7);
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return 0;
}

const at = (url, w) => {
  if (!url) return null;
  if (url.includes('books.google')) {
    try { const u = new URL(url); u.searchParams.set('w', String(w)); u.searchParams.delete('edge'); u.protocol = 'https:'; return u.toString(); }
    catch { return url; }
  }
  if (url.includes('openlibrary')) return url.replace(/-(S|M|L)\.(jpg|png)$/i, '-L.$2');
  return url;
};

// Fetched directly rather than through lib/http.mjs, which returns text and
// caches text: an image read as a string is a mangled one, and its header is the
// only part being read here. A Range request keeps it to the first 64KB where
// the host honours one, which is far more than any header needs.
const seen = new Map();
async function measure(url) {
  if (!url) return 0;
  const target = at(url, 1000);
  if (seen.has(target)) return seen.get(target);
  let w = 0;
  try {
    const res = await fetch(target, { headers: { range: 'bytes=0-65535', 'user-agent': 'constant-reader/1.0' } });
    if (res.ok || res.status === 206) w = widthOf(Buffer.from(await res.arrayBuffer()));
  } catch { w = 0; }
  seen.set(target, w);
  await new Promise((r) => setTimeout(r, 120));
  return w;
}

// ---------------------------------------------------------------- run

const storePath = join(root, 'data', 'store.json');
const store = JSON.parse(readFileSync(storePath, 'utf8'));
const entries = Object.values(store.entries);

if (!googleAvailable()) {
  console.error('\n  Google Books is unavailable, so there is nothing to look a cover up in.\n');
  process.exit(1);
}

// One book can appear on several review entries; look each jacket up once.
const byIsbn = new Map();
for (const e of entries) {
  const b = e.book || {};
  const isbn = b.isbn13 || b.isbn10;
  if (!isbn) continue;
  const poor = !b.coverUrl || b.coverUrl.includes('openlibrary');
  if (!poor) continue;
  if (!byIsbn.has(isbn)) byIsbn.set(isbn, { isbn, title: b.title || '', current: b.coverUrl || null, rows: [] });
  byIsbn.get(isbn).rows.push(e);
}

const work = [...byIsbn.values()].slice(0, limit);
console.log(`\n  ${work.length} book${work.length === 1 ? '' : 's'} with a poor cover or none, and an ISBN to look one up with`);
console.log(`  ${write ? 'Writing' : `${DIM}Reporting only — pass --write to keep the results${OFF}`}\n`);

let better = 0, kept = 0, missing = 0, rowsTouched = 0;
for (const job of work) {
  const found = await coverByIsbn(http, job.isbn);
  if (!found) { missing++; console.log(`  ${pad(job.title, 40)} ${DIM}nothing on Google${OFF}`); continue; }

  const [now, next] = await Promise.all([measure(job.current), measure(found)]);
  // Only ever up. Without this the swap would trade Open Library's 300 real
  // pixels for Google's 128px thumbnail on any book whose scan is poor.
  if (next <= now) {
    kept++;
    console.log(`  ${pad(job.title, 40)} ${DIM}kept ${now}px, Google offers ${next}px${OFF}`);
    continue;
  }
  better++;
  console.log(`  ${pad(job.title, 40)} ${GREEN}${now || 'none'} -> ${next}px${OFF}`);
  if (write) for (const e of job.rows) { e.book.coverUrl = found; rowsTouched++; }
}

// ---------------------------------------------------------------- measuring

// Every cover the renderer has not been told the size of.
//
// `fillsSlot` treats an unmeasured cover as good enough, because discarding a
// real jacket over a fact nobody established is the wrong error. That makes this
// pass the thing that keeps the rule honest: without it, every book crawled
// tomorrow would be assumed fine and the small ones would go back to being
// stretched across a card.
let measured = 0;
const unmeasured = new Map();
for (const e of entries) {
  const b = e.book || {};
  if (!b.coverUrl || b.coverWidth != null) continue;
  if (!unmeasured.has(b.coverUrl)) unmeasured.set(b.coverUrl, []);
  unmeasured.get(b.coverUrl).push(e);
}
if (unmeasured.size) {
  console.log(`\n  measuring ${unmeasured.size} cover${unmeasured.size === 1 ? '' : 's'} of unknown size`);
  for (const [url, rows] of unmeasured) {
    const w = await measure(url);
    if (!w) continue;
    measured += rows.length;
    if (write) for (const e of rows) e.book.coverWidth = w;
  }
  console.log(`  ${measured} row${measured === 1 ? '' : 's'} stamped with a width`);
}

if (write && (better || measured)) {
  writeFileSync(storePath, JSON.stringify(store));
  console.log(`\n  Wrote data/store.json: ${rowsTouched} cover${rowsTouched === 1 ? '' : 's'} swapped, ${measured} measured. Run npm run build to carry it into the feed.`);
}
console.log(`\n  ${better} improved, ${kept} already as good as it gets, ${missing} not in Google.\n`);
