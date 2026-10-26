// Ask: the one piece of Constant Reader that runs on a server.
//
// Search in the app matches words. This lets it match meaning, without putting
// an API key in a static page where anybody could spend it. The browser does
// everything it can on its own and asks this worker two narrow questions:
//
//   expand  "books about grief and the sea" -> words a critic would have used
//           for that: mourning, widow, drowning, maritime, fishing village...
//           The app runs its own keyword search over those, so the archive
//           is still searched in the browser and never leaves it.
//   rank    the query and the forty-odd books that search found, each as a
//           title, an author, the tags and one standfirst. Back comes the
//           ones that genuinely answer, best first, with a line on why.
//
// The worker holds no catalogue and keeps no state beyond Cloudflare's cache.
// Taste is not sent: the app applies the reader's profile to the order this
// returns, the same bounded way it does for keyword search, so a reader's
// profile never leaves their browser either.

import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-opus-5-5';
const MAX_QUERY = 300;
const MAX_CANDIDATES = 60;
const MAX_FIELD = 600;
// Identical questions get identical answers for a day. Most searches are
// someone retyping, going back, or tapping an example chip.
const CACHE_SECONDS = 86400;

const EXPAND_SYSTEM = `You help a literary review archive understand what a reader is asking for.

The archive holds books that the literary press has reviewed. Its search matches words that appear in reviews, standfirsts and publisher descriptions. Given the reader's request, return the words and short phrases a critic would plausibly have used when writing about books that answer it: subjects, settings, periods, people, forms and moods. Include close synonyms and the specific names a review would mention (for "the French Revolution": Robespierre, Jacobins, the Terror, 1789, Paris, guillotine).

Return between 6 and 16 terms. Do not repeat the reader's own words. Do not invent book titles.`;

const RANK_SYSTEM = `You pick books from a literary review archive that answer a reader's request.

You are given the request and a numbered list of candidate books. Each has a title, an author, a year, tags the archive assigned from critics' reviews, and one line from a review or the publisher. Judge only from that information.

Return the books that genuinely answer the request, best answer first. Leave out any book that merely shares a word with the request (an author called French is not a book about France). Return at most 20, and return none if none fit.

For each book you return, give a reason of at most 15 words, in plain language, saying what about it answers the request. Base the reason on the information given, not on outside knowledge of the book.`;

const EXPAND_SCHEMA = {
  type: 'object',
  properties: { terms: { type: 'array', items: { type: 'string' } } },
  required: ['terms'],
  additionalProperties: false,
};

const RANK_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, why: { type: 'string' } },
        required: ['id', 'why'],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
};

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const allowed = allowedOrigin(origin, env);
    const cors = {
      'Access-Control-Allow-Origin': allowed || 'null',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: allowed ? 204 : 403, headers: cors });
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405, cors);
    // A browser on another site cannot call this. A script can send any
    // Origin it likes, which is why the key also wants a spend limit on the
    // Anthropic side; this keeps casual reuse out, not a determined one.
    if (!allowed) return json({ error: 'origin not allowed' }, 403, cors);
    if (!env.ANTHROPIC_API_KEY) return json({ error: 'not configured' }, 503, cors);

    let body;
    try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400, cors); }
    const q = clip(body?.q, MAX_QUERY).trim();
    if (!q) return json({ error: 'empty query' }, 400, cors);

    let stage, input;
    if (body.stage === 'expand') {
      stage = 'expand';
      input = { q };
    } else if (body.stage === 'rank') {
      stage = 'rank';
      const candidates = (Array.isArray(body.candidates) ? body.candidates : [])
        .slice(0, MAX_CANDIDATES)
        .map((c) => ({
          id: clip(c?.id, 200),
          title: clip(c?.title, 200),
          author: clip(c?.author, 200),
          year: Number.isFinite(c?.year) ? c.year : null,
          kind: clip(c?.kind, 20),
          tags: (Array.isArray(c?.tags) ? c.tags : []).slice(0, 12).map((t) => clip(t, 40)),
          blurb: clip(c?.blurb, MAX_FIELD),
        }))
        .filter((c) => c.id && c.title);
      if (!candidates.length) return json({ results: [] }, 200, cors);
      input = { q, candidates };
    } else {
      return json({ error: 'unknown stage' }, 400, cors);
    }

    // Keyed on the cleaned input, so the cache cannot be filled with anything
    // the model was not actually asked.
    const cacheKey = new Request(`https://ask.cache/${stage}/${await digest(JSON.stringify(input))}`);
    const cache = caches.default;
    const hit = await cache.match(cacheKey);
    if (hit) {
      const res = new Response(hit.body, hit);
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    }

    let out;
    try {
      out = stage === 'expand' ? await expand(env, input) : await rank(env, input);
    } catch (err) {
      const status = err instanceof Anthropic.RateLimitError ? 429
        : err instanceof Anthropic.APIError && err.status >= 500 ? 502
        : err instanceof Anthropic.APIError ? 500
        : 500;
      return json({ error: 'model call failed' }, status, cors);
    }

    const res = json(out, 200, { ...cors, 'Cache-Control': `public, max-age=${CACHE_SECONDS}` });
    ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  },
};

async function expand(env, { q }) {
  const data = await ask(env, EXPAND_SYSTEM, `Reader's request: ${q}`, EXPAND_SCHEMA, 1024);
  const seen = new Set();
  const terms = (data?.terms || [])
    .map((t) => String(t).trim())
    .filter((t) => t && t.length <= 60 && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()))
    .slice(0, 16);
  return { terms };
}

async function rank(env, { q, candidates }) {
  const list = candidates.map((c, i) => [
    `[${i + 1}] id: ${c.id}`,
    `title: ${c.title}${c.author ? ` | author: ${c.author}` : ''}${c.year ? ` | year: ${c.year}` : ''}${c.kind ? ` | ${c.kind}` : ''}`,
    c.tags.length ? `tags: ${c.tags.join(', ')}` : '',
    c.blurb ? `line: ${c.blurb}` : '',
  ].filter(Boolean).join('\n')).join('\n\n');
  const data = await ask(env, RANK_SYSTEM, `Reader's request: ${q}\n\nCandidates:\n\n${list}`, RANK_SCHEMA, 4096);
  // Only ids that were offered come back, once each. A model that misspells an
  // id loses that row rather than inventing a book.
  const offered = new Set(candidates.map((c) => c.id));
  const seen = new Set();
  const results = (data?.results || [])
    .filter((r) => offered.has(r?.id) && !seen.has(r.id) && seen.add(r.id))
    .slice(0, 20)
    .map((r) => ({ id: r.id, why: clip(r.why, 160) }));
  return { results };
}

async function ask(env, system, user, schema, maxTokens) {
  // ANTHROPIC_BASE_URL is only ever set for local testing against a stub.
  const client = new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    baseURL: env.ANTHROPIC_BASE_URL || undefined,
    maxRetries: 1,
    timeout: 25_000,
  });
  const response = await client.beta.messages.create({
    model: env.ASK_MODEL || MODEL,
    max_tokens: maxTokens,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    // A search box has to answer in seconds; this is retrieval, not reasoning.
    output_config: { effort: 'low', format: { type: 'json_schema', schema } },
    system,
    messages: [{ role: 'user', content: user }],
  });
  if (response.stop_reason === 'refusal') return null;
  const text = response.content.find((b) => b.type === 'text')?.text;
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function allowedOrigin(origin, env) {
  const list = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.includes(origin) ? origin : '';
}

const clip = (v, n) => String(v ?? '').slice(0, n);

async function digest(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}
