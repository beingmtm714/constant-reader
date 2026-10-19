#!/usr/bin/env node
// Filling in the years the feeds cannot reach.
//
// Every source in sources.json is a syndication feed, and a syndication feed is
// a window on the present: the Guardian's carries 20 items, the LRB's 22, Book
// Marks' 10. Crawl one every morning for a year and you have a year. The app has
// always said it covers the window in profile/taste-profile.json — five years —
// and until this ran it held thirteen months of reviews.
//
// This does not fetch reviews. It discovers their addresses and writes them to a
// backlog, and `kind: 'archive'` sources in the daily build take a bounded slice
// off that backlog and put it through exactly the pipeline every other review
// goes through. One extraction path, one scorer, one store. A second pipeline
// that happened to agree with the first this morning is the kind of thing that
// stops agreeing in a month and tells nobody.
//
//   node bin/archive.mjs                 twelve slices of work, then stop
//   node bin/archive.mjs --slices=60     more of it
//   node bin/archive.mjs --source=lrb-archive
//   node bin/archive.mjs --status        what is discovered and what is left
//
// Bounded by design. It is called from the 06:20 job, which also has to crawl,
// score and publish before anyone is awake, so the default is twelve requests
// rather than five years of them. The backlog fills over a few weeks of mornings
// and the archive fills behind it.
//
// One archive is discovered and not used. The NYT publishes a sitemap a month
// and every book review is in it, but the article pages answer 403 to any
// crawler, so the only metadata is the URL slug — and a slug carries neither the
// quotes nor the "by" that the NYT title pattern reads. A build over 39 of them
// resolved nothing. The discovery is kept because it works; the source is
// disabled in sources.json because the pages are shut.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ensureProxyAware } from '../lib/proxy.mjs';
import { Http } from '../lib/http.mjs';
import { ARCHIVES, discover } from '../lib/archive.mjs';

ensureProxyAware();

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (n) => args.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
const flag = (n) => args.includes(`--${n}`);

const profile = JSON.parse(readFileSync(join(root, 'profile', 'taste-profile.json'), 'utf8'));
const windowYears = profile.window?.years || 5;

const dir = join(root, 'data', 'archive');
mkdirSync(dir, { recursive: true });
const statePath = join(dir, 'progress.json');

const DIM = '\x1b[2m', OFF = '\x1b[0m', GREEN = '\x1b[32m', RED = '\x1b[31m';
const pad = (s, n) => String(s).padEnd(n).slice(0, n);

function loadState() {
  if (!existsSync(statePath)) return { version: 1, sources: {} };
  try { return JSON.parse(readFileSync(statePath, 'utf8')); } catch { return { version: 1, sources: {} }; }
}
function saveState(state) { writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`); }

const backlogPath = (id) => join(dir, `${id}.json`);
function loadBacklog(id) {
  const p = backlogPath(id);
  if (!existsSync(p)) return { sourceId: id, entries: [] };
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return { sourceId: id, entries: [] }; }
}
function saveBacklog(b) { writeFileSync(backlogPath(b.sourceId), `${JSON.stringify(b)}\n`); }

// ---------------------------------------------------------------- status

if (flag('status')) {
  const state = loadState();
  console.log(`\n  Archive backlog — the last ${windowYears} years\n`);
  let anyLeft = 0;
  for (const a of ARCHIVES) {
    if (a.enabled === false) { const b0 = loadBacklog(a.id); console.log(`  ${pad(a.short, 14)} ${pad(`${b0.entries.length} found`, 14)} ${pad('not used', 28)} ${RED}off — ${a.disabledReason}${OFF}`); continue; }
    const b = loadBacklog(a.id);
    const taken = b.entries.filter((e) => e.taken).length;
    const st = state.sources[a.id] || {};
    const left = b.entries.length - taken;
    anyLeft += left;
    // A disabled archive says so rather than reporting green. Its backlog is
    // real and its addresses are real; what failed was reading the pages behind
    // them, and "discovery complete" over a source nothing can extract is the
    // sort of line that gets believed six months later.
    const where = a.enabled === false ? `${RED}off — ${a.disabledReason}${OFF}`
      : st.exhausted ? `${GREEN}discovery complete${OFF}`
      : `${DIM}slice ${st.cursor ?? 0}${OFF}`;
    console.log(`  ${pad(a.short, 14)} ${pad(`${b.entries.length} found`, 14)} ${pad(`${taken} handed to the build`, 28)} ${where}`);
  }
  console.log(`\n  ${anyLeft} addresses waiting for a build.\n`);
  process.exit(0);
}

// ---------------------------------------------------------------- crawl

const only = arg('source');
// Twelve slices is twelve requests, which is nothing next to the build that
// follows. It is set slightly ahead of what the build can swallow — the three
// archive sources take 70 articles between them per run — so the backlog stays
// non-empty and the build is never idle waiting for discovery.
const budget = Number(arg('slices') || 12);

const http = new Http({ cacheDir: join(root, '.cache'), ttlHours: flag('fresh') ? 0 : 24 * 30, delayMs: 700 });

const state = loadState();
const cutoff = new Date().getFullYear() - windowYears;

console.log(`\n  Discovering back to ${cutoff}, ${budget} slice${budget === 1 ? '' : 's'} of work\n`);

let spent = 0;
for (const a of ARCHIVES.filter((x) => x.enabled !== false && (!only || x.id === only))) {
  if (spent >= budget) break;
  const st = (state.sources[a.id] ||= { cursor: 0, exhausted: false });
  if (st.exhausted) { console.log(`  ${pad(a.short, 14)} ${DIM}already complete${OFF}`); continue; }

  const backlog = loadBacklog(a.id);
  const seen = new Set(backlog.entries.map((e) => e.url));
  let added = 0;

  while (spent < budget && !st.exhausted) {
    const slice = a.slices(cutoff)[st.cursor];
    if (!slice) { st.exhausted = true; break; }
    spent++;
    let found;
    try {
      found = await discover(a, slice, http);
    } catch (err) {
      console.log(`  ${pad(a.short, 14)} ${RED}slice ${st.cursor} failed${OFF}  ${err.message}`);
      // A slice that throws is a slice to come back to, not a reason to stop:
      // a single 503 from a decade-old sitemap must not end the crawl for
      // every publication behind it in the list.
      st.cursor++;
      continue;
    }
    for (const item of found) {
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      backlog.entries.push({ ...item, taken: false });
      added++;
    }
    console.log(`  ${pad(a.short, 14)} ${pad(`slice ${st.cursor}`, 12)} ${pad(slice.label, 22)} ${found.length} found`);
    st.cursor++;

    // A paginated archive does not know how long it is, so it is read until it
    // stops answering. Two empty pages rather than one, because a single blank
    // response is as likely to be a bad morning as the end of the run.
    if (a.exhaustedOnEmpty) {
      st.empties = found.length ? 0 : (st.empties || 0) + 1;
      if (st.empties >= a.exhaustedOnEmpty) {
        st.exhausted = true;
        console.log(`  ${pad(a.short, 14)} ${DIM}archive ends at slice ${st.cursor - st.empties}${OFF}`);
      }
    }
  }

  if (added) saveBacklog(backlog);
  saveState(state);
}

const totals = ARCHIVES.reduce((n, a) => n + loadBacklog(a.id).entries.filter((e) => !e.taken).length, 0);
console.log(`\n  ${totals} addresses waiting for a build.\n`);
