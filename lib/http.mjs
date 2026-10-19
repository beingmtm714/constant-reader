// Fetching with an on-disk cache.
//
// Review sites rate-limit and some of them 403 a bare user agent. The cache means
// a rebuild costs nothing for pages already seen, which matters because the book
// resolver hits one API per candidate.

import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

// Declare what this is rather than pretending to be Safari.
//
// The pretence was costing sources rather than winning them. The Hudson Review
// and n+1 answer 200 with a full feed to an honest user-agent and 403 to the
// Chrome string, from the same machine and the same address, seconds apart:
// their rule is not "no bots", it is "no bots claiming to be browsers", which is
// the ordinary way to catch a scraper. Tested across all 35 enabled sources on
// 2026-08-28: two got better, thirty-three were identical, none got worse.
//
// This also spent a day pointing the diagnosis at the wrong thing. The failures
// were read as datacentre IP reputation and recorded as such, and this machine
// was on home broadband the whole time.
const UA = 'ConstantReader/1.0 (personal reading feed; +https://www.constantreader.app/)';

export class Http {
  constructor({ cacheDir, ttlHours = 12, delayMs = 400, verbose = false }) {
    this.cacheDir = cacheDir;
    this.ttl = ttlHours * 3600 * 1000;
    this.delayMs = delayMs;
    this.verbose = verbose;
    this.lastHostHit = new Map();
    this.stats = { hits: 0, misses: 0, errors: 0 };
    mkdirSync(cacheDir, { recursive: true });
  }

  path(url) {
    return join(this.cacheDir, createHash('sha1').update(url).digest('hex').slice(0, 20) + '.txt');
  }

  cached(url) {
    const p = this.path(url);
    if (!existsSync(p)) return null;
    if (Date.now() - statSync(p).mtimeMs > this.ttl) return null;
    return readFileSync(p, 'utf8');
  }

  async throttle(url) {
    const host = new URL(url).host;
    const last = this.lastHostHit.get(host) || 0;
    const wait = this.delayMs - (Date.now() - last);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastHostHit.set(host, Date.now());
  }

  async get(url, { retries = 2, timeoutMs = 25000, allowCache = true } = {}) {
    if (allowCache) {
      const hit = this.cached(url);
      if (hit !== null) { this.stats.hits++; return { ok: true, body: hit, cached: true }; }
    }
    for (let attempt = 0; attempt <= retries; attempt++) {
      await this.throttle(url);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          redirect: 'follow', signal: ctrl.signal,
          headers: { 'user-agent': UA, accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html, application/json;q=0.9, */*;q=0.8', 'accept-language': 'en-US,en;q=0.9' },
        });
        clearTimeout(timer);
        if (!res.ok) {
          // 429 is a rate limit, which is a request to wait rather than a refusal.
          // It was falling straight through to the error return, and for Google
          // Books that meant one burst limit disabled the source for a whole
          // build - 600 books losing their page counts and jacket images over a
          // pause the server explicitly asked for. Backed off harder than a 5xx
          // because a rate limit is counted in seconds, and honouring Retry-After
          // where the server sends one.
          if (res.status === 429 && attempt < retries) {
            const after = Number(res.headers.get('retry-after'));
            const wait = Number.isFinite(after) && after > 0 ? after * 1000 : 5000 * (attempt + 1);
            await new Promise((r) => setTimeout(r, Math.min(wait, 30000)));
            continue;
          }
          if (res.status >= 500 && attempt < retries) { await new Promise((r) => setTimeout(r, 2000 * (attempt + 1))); continue; }
          this.stats.errors++;
          return { ok: false, status: res.status, body: '', error: `HTTP ${res.status}` };
        }
        const body = await res.text();
        this.stats.misses++;
        writeFileSync(this.path(url), body);
        return { ok: true, body, status: res.status };
      } catch (err) {
        clearTimeout(timer);
        if (attempt < retries) { await new Promise((r) => setTimeout(r, 2000 * (attempt + 1))); continue; }
        this.stats.errors++;
        return { ok: false, body: '', error: err.name === 'AbortError' ? 'timeout' : String(err.message || err) };
      }
    }
    return { ok: false, body: '', error: 'unreachable' };
  }

  async json(url, opts) {
    const res = await this.get(url, opts);
    if (!res.ok) return { ok: false, error: res.error, status: res.status };
    try { return { ok: true, data: JSON.parse(res.body) }; }
    catch { return { ok: false, error: 'bad json' }; }
  }
}
