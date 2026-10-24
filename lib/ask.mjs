// Search by meaning, through the Ask worker (worker/src/index.js).
//
// Keyword search in lib/search.mjs is instant and always runs first. This is
// the second pass: it asks the worker for the words a critic would have used,
// searches the archive again with them in the browser, sends the forty-odd
// books that turns up to be judged against the question, and returns them in
// the order the model put them, each with its reason.
//
// Nothing here is allowed to make search worse. No URL configured, a network
// failure, a timeout, a refusal or an empty answer all return null, and the
// caller keeps the keyword results it already showed.

import { ASK_URL } from './ask-config.mjs?v=7b9522d022';
import { bestBlurb } from './blurb.mjs?v=7b9522d022';

const TIMEOUT_MS = 20000;
const CANDIDATES = 45;

export const askEnabled = () => Boolean(ASK_URL);

async function call(stage, body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(ASK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage, ...body }),
      signal: ctl.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const kindOf = (e) => (e.fiction === 'confirmed' || e.fiction === 'likely' ? 'fiction'
  : e.fiction === 'nonfiction' ? 'nonfiction' : '');

function compact(e) {
  return {
    id: e.id,
    title: e.book?.title || '',
    author: e.book?.author || '',
    year: e.book?.bookYear || null,
    kind: kindOf(e),
    tags: (e.tags || []).map((t) => t.label).slice(0, 12),
    blurb: bestBlurb(e, { max: 400 })?.text || '',
  };
}

// keyword(query, limit) runs the app's own search and returns its rows.
// fitOf(entry) is the reader's fit out of ten, or null without a profile.
export async function askByMeaning(q, { keyword, fitOf }) {
  if (!ASK_URL || !q) return null;

  const expanded = await call('expand', { q });
  const terms = Array.isArray(expanded?.terms) ? expanded.terms : [];

  // The plain query's own matches go first, then whatever the critic's words
  // add. A book found both ways is offered once.
  const pool = [];
  const seen = new Set();
  const add = (rows) => {
    for (const r of rows) {
      if (pool.length >= CANDIDATES) return;
      if (seen.has(r.e.id)) continue;
      seen.add(r.e.id);
      pool.push(r.e);
    }
  };
  add(keyword(q, 25));
  if (terms.length) add(keyword(`${q} ${terms.join(' ')}`, CANDIDATES));
  if (!pool.length) return null;

  const ranked = await call('rank', { q, candidates: pool.map(compact) });
  if (!Array.isArray(ranked?.results)) return null;

  const byId = new Map(pool.map((e) => [e.id, e]));
  const n = ranked.results.length;
  const rows = ranked.results
    .map((r, i) => {
      const e = byId.get(r.id);
      if (!e) return null;
      // The model's order is the relevance, from 1 down to 0.5. Taste then
      // moves a book by at most a third, the same bound keyword search uses,
      // so a profile can reorder good answers but never promote a poor one
      // past a much better one.
      const relevance = n > 1 ? 1 - (0.5 * i) / (n - 1) : 1;
      const fit = fitOf(e);
      const total = fit == null ? relevance : relevance * (0.7 + 0.3 * Math.max(0, Math.min(1, fit / 10)));
      return { e, relevance, fit, total, why: r.why, matchedTags: [] };
    })
    .filter(Boolean)
    .sort((a, b) => b.total - a.total);

  return { results: rows, total: rows.length, terms };
}
