/* Constant Reader — the jewel editorial desk.

   Reads data/feed.json, ranks it against the reading profile, and draws six
   sections over one normalised book record: For you, Review feed, All books,
   Saved, Taste, Profile. Every route into a book ends at the same dossier.

   The scoring is not here. It lives in lib/, shared with the build, so the
   browser and the build can never disagree about what a number means. This file
   decides what is shown and in what order. */

import * as saved from './lib/saved-books.mjs';
import { RETAILERS, linkFor, canFindCopy } from './lib/retailers.mjs';
import { createAnalytics } from './lib/analytics.mjs';
import { buildTasteModel, tunedTotal, MIN_SIGNAL, MAX_ADJUSTMENT } from './lib/taste.mjs';
import { outOfTen, RECOMMEND_AT } from './lib/recommend.mjs';
import { rescore, isEmpty, EMPTY as EMPTY_OVERRIDES } from './lib/overrides.mjs';
import * as sync from './lib/sync.mjs';
import { jacketFor } from './lib/jacket.mjs';
import { cleanBlurb } from './lib/blurb.mjs';

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const VERDICT_KEY = 'litfeed:verdicts';
  const PREFS_KEY = 'litfeed:prefs';
  const OVERRIDES_KEY = 'litfeed:overrides';
  const EVENTS_KEY = 'litfeed:events';
  const ACCOUNT_KEY = 'litfeed:account';

  // No affiliate programme has been approved, so every outbound link goes clean.
  const AFFILIATES = {};

  // How many rows or cards a section previews before the reader asks for more.
  const ROW_PAGE = 14;
  const CARD_PAGE = 16;

  let FEED = null;
  let verdicts = saved.migrate(read(VERDICT_KEY, {}));
  let overrides = { ...EMPTY_OVERRIDES };
  let taste = null;
  let user = null;
  let syncing = false;
  let syncQueued = false;
  let profileVersion = 0;
  let toastTimer = null;

  const analytics = createAnalytics({
    load: () => read(EVENTS_KEY, []),
    store: (log) => write(EVENTS_KEY, log),
  });

  const SORTS = [
    { id: 'fit', label: 'Best fit for me' },
    { id: 'latest', label: 'Newest reviews' },
    { id: 'short', label: 'Shortest first' },
    { id: 'title', label: 'Title A–Z' },
  ];

  const SCOPES = [
    { id: 'any', label: 'All reviewed books' },
    { id: 'scored', label: 'Scored' },
    { id: 'reviewed-unscored', label: 'Reviewed · no score' },
  ];

  const ALL_SCOPES = [
    { id: 'any', label: 'Everything in the archive' },
    { id: 'scored', label: 'Scored' },
    { id: 'reviewed-unscored', label: 'Reviewed · no score' },
    { id: 'awaiting-review', label: 'Awaiting review' },
  ];

  const state = {
    view: 'foryou',
    q: '',
    sort: 'fit',
    scope: 'any',
    allScope: 'any',
    recommendedOnly: false,
    shortOnly: false,
    limit: ROW_PAGE,
    allLimit: CARD_PAGE,
    openMenu: null,
    draftWeights: null,
  };

  // ------------------------------------------------------------ storage

  function read(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  }
  function write(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
  }
  // The one write whose failure the reader has to know about. Private mode and a
  // full quota both land here, and both mean the save did not happen.
  function persist(key, value) { localStorage.setItem(key, JSON.stringify(value)); }

  function loadPrefs() {
    const p = read(PREFS_KEY, {});
    for (const k of ['view', 'sort', 'scope', 'allScope']) if (p[k]) state[k] = p[k];
    if (typeof p.recommendedOnly === 'boolean') state.recommendedOnly = p.recommendedOnly;
    if (typeof p.shortOnly === 'boolean') state.shortOnly = p.shortOnly;
    if (!VIEWS[state.view]) state.view = 'foryou';
  }
  function savePrefs() {
    write(PREFS_KEY, {
      view: state.view, sort: state.sort, scope: state.scope, allScope: state.allScope,
      recommendedOnly: state.recommendedOnly, shortOnly: state.shortOnly,
    });
  }

  function loadOverrides() {
    overrides = { ...EMPTY_OVERRIDES, ...read(OVERRIDES_KEY, {}) };
    for (const k of Object.keys(EMPTY_OVERRIDES)) overrides[k] = overrides[k] || {};
  }

  // ------------------------------------------------------------ helpers

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const ico = (name, cls = 'ico') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-${name}"/></svg>`;

  const cssId = (s) => String(s).replace(/[^a-z0-9]/gi, '-');

  function fmtDate(iso) {
    const d = new Date(iso || '');
    if (Number.isNaN(d.getTime())) return 'undated';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function relative(iso) {
    const t = Date.parse(iso || '');
    if (!t) return '';
    const days = Math.round((Date.now() - t) / 86400000);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 30) return `${days} days ago`;
    if (days < 365) return `${Math.round(days / 30)} months ago`;
    return `${Math.round(days / 365)} years ago`;
  }

  // "Rebuilt this morning" is a claim about today; a build from last week has to
  // say so rather than borrow the phrasing.
  function rebuiltPhrase(iso) {
    const t = Date.parse(iso || '');
    if (!t) return 'Rebuild time unknown';
    const d = new Date(t);
    const sameDay = d.toDateString() === new Date().toDateString();
    if (!sameDay) return `Rebuilt ${relative(iso)}`;
    return d.getHours() < 12 ? 'Rebuilt this morning' : 'Rebuilt today';
  }

  function greetingWord() {
    const h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 18) return 'Good afternoon';
    return 'Good evening';
  }

  // The prototype greeted a signed-in persona by name. A stranger has no name to
  // use, so the greeting stands on its own rather than inventing one.
  function greeting() {
    const account = read(ACCOUNT_KEY, null);
    const name = (user?.displayName || account?.name || '').trim().split(/\s+/)[0];
    const usable = name && !name.includes('@') ? name.replace(/[^\p{L}\p{N}'\-]/gu, '') : '';
    return usable ? `${greetingWord()}, ${usable}.` : `${greetingWord()}.`;
  }

  function dateline() {
    const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    return `${today} · ${rebuiltPhrase(FEED.builtAt)}`;
  }

  // ------------------------------------------------------------ scoring

  // One status test, everywhere. A missing number means one of two very different
  // things — no critic has reviewed the book yet, or a review exists and gave too
  // little dependable evidence — and neither is ever shown as a zero.
  function scoreStatus(e) {
    const noScore = e.listedOnly || e.score?.band === 'unscored' || e.score?.band === 'unresolved';
    if (!noScore) return 'scored';
    if (!e.listedOnly && e.reviewCount > 0) return 'reviewed-unscored';
    return 'awaiting-review';
  }
  const isScored = (e) => scoreStatus(e) === 'scored';

  const profileForOverrides = () => ({
    dimensions: FEED.dimensions,
    evidenceRule: FEED.evidenceRule,
    proseFloor: FEED.proseFloor,
  });

  const retune = () => { taste = buildTasteModel(verdicts, FEED?.books || [], FEED?.dimensions || []); };

  // Two layers, in order: the reader's own weighting decides what the profile's
  // number should have been, then their saves tune it within a bounded range.
  function scoreOf(e) {
    if (!isScored(e)) {
      const base = e.score?.total ?? 0;
      return { base, delta: 0, total: base, reasons: [], nearest: null, tuned: false, overridden: false, profileBase: base };
    }
    const o = rescore(e.score, profileForOverrides(), overrides);
    const overridden = Boolean(o.changed);
    const base = overridden ? o.total : e.score.total;
    if (!taste?.ready) {
      return { base, delta: 0, total: base, reasons: [], nearest: null, tuned: false, overridden, profileBase: e.score.total };
    }
    const ent = overridden ? { ...e, score: { ...e.score, total: base, dimensions: o.dimensions } } : e;
    return { ...tunedTotal(ent, taste), overridden, profileBase: e.score.total };
  }

  const shownScore = (e, s = scoreOf(e)) => outOfTen(s.total);

  // The build's rule, applied to the live number. Everything the build refused
  // for a reason other than the score stays refused.
  function recommendedNow(e, s) {
    if (!isScored(e)) return false;
    if (!s.overridden && !taste?.ready) return e.recommended;
    if (!e.recommended && e.recommendedWhyNot && !/^scores /.test(e.recommendedWhyNot)) return false;
    return outOfTen(s.total) >= threshold();
  }

  const threshold = () => FEED?.recommendAt ?? RECOMMEND_AT;

  const passed = (e) => saved.verdictOf(verdicts, e.id) === 'passed';
  const isSaved = (e) => saved.isSaved(verdicts, e.id);

  // ------------------------------------------------------------ derived facts

  let stats = null;
  function computeStats() {
    const books = FEED.books;
    const byStatus = { scored: 0, 'reviewed-unscored': 0, 'awaiting-review': 0 };
    let recentReviews = 0;
    const cutoff = Date.now() - 30 * 86400000;
    for (const e of books) {
      byStatus[scoreStatus(e)]++;
      for (const m of e.mentions) if ((Date.parse(m.reviewDate || '') || 0) >= cutoff) recentReviews++;
    }
    stats = {
      total: books.length,
      scored: byStatus.scored,
      unscored: byStatus['reviewed-unscored'],
      awaiting: byStatus['awaiting-review'],
      reviewed: byStatus.scored + byStatus['reviewed-unscored'],
      recentReviews,
    };
  }

  // The day's edit: everything the profile can score, not already ruled on,
  // ranked by the live number. Ranked once per render rather than per section.
  function edit() {
    return FEED.books
      .filter((e) => isScored(e) && e.inWindow !== false && !passed(e))
      .map((e) => ({ e, s: scoreOf(e) }))
      .sort((a, b) => b.s.total - a.s.total || reviewTime(b.e) - reviewTime(a.e));
  }

  const reviewTime = (e) => Date.parse(e.lastReviewed || '') || 0;

  const DESCRIBING = new Set(['period', 'subject', 'form', 'prose', 'tone', 'scale', 'genre']);

  // What today's shortlist leans toward, counted rather than asserted: the tags
  // that recur most across the books at the top of the edit.
  const LEANING = new Set(['period', 'subject', 'form', 'prose', 'tone', 'scale']);

  function leanCounts(ranked, n = 4) {
    const pool = ranked.slice(0, 40);
    const counts = new Map();
    for (const { e } of pool) {
      for (const t of e.tags || []) {
        if (!LEANING.has(t.kind)) continue;
        const row = counts.get(t.id) || { label: t.label, n: 0 };
        row.n++;
        counts.set(t.id, row);
      }
    }
    return [...counts.values()].sort((a, b) => b.n - a.n).slice(0, n);
  }

  // The dimensions a review actually spoke to, strongest first. Everything that
  // explains a score in plain words is built from this.
  function firedDims(e) {
    const dims = Object.values(e.score?.dimensions || {});
    return dims
      .filter((d) => !d.defaulted && d.score != null)
      .sort((a, b) => (b.score * b.weight) - (a.score * a.weight));
  }

  const lower = (s) => String(s || '').charAt(0).toLowerCase() + String(s || '').slice(1);

  // Why this book, in one sentence, built from the dimensions that fired rather
  // than from a model. Two dimensions is the most a single line can carry.
  // Four books whose reviews fired the same two dimensions would otherwise carry
  // the same sentence four times across one shelf, which reads as boilerplate
  // rather than as a reason. The claim is identical; the phrasing rotates on the
  // book's own id, so it is stable per book and varied across a row.
  const STRONG = [
    (x, y) => `${x} and ${lower(y)} align almost perfectly with your profile.`,
    (x, y) => `Two of your highest-weight dimensions appear here: ${lower(x)} and ${lower(y)}.`,
    (x, y) => `Your ${lower(x)} and ${lower(y)} preferences both fire on this one.`,
  ];
  const SOLID = [
    (x, y) => `A high-confidence match for ${lower(x)}, with ${lower(y)} behind it.`,
    (x, y) => `${x} carries it; ${lower(y)} holds the rest up.`,
    (x, y) => `Strong on ${lower(x)}, and ${lower(y)} does not let it down.`,
  ];

  function matchLine(e, s) {
    if (!isScored(e)) {
      return scoreStatus(e) === 'reviewed-unscored'
        ? 'Reviewed, but the evidence was too thin for a reliable number.'
        : 'Catalogued and browseable. No critic has reviewed it yet.';
    }
    const fired = firedDims(e);
    if (!fired.length) return 'Scored on the little the review gave, so treat the number lightly.';
    const [a, b] = fired;
    const pick = (bank) => bank[hashId(e.id) % bank.length](a.name, b.name);
    if (b && a.score >= 9 && b.score >= 9) return pick(STRONG);
    if (b && a.score >= 8) return pick(SOLID);
    if (a.score >= 8) return `${a.name} is the signal doing the work here.`;
    if (s.tuned && s.reasons?.length) return `Your saves lift this: ${s.reasons.map((r) => r.label).join(', ')}.`;
    return `${a.name} reads clearly; the rest of the review says less.`;
  }

  // The dossier's fuller version of the same argument.
  function caseFor(e, s) {
    if (!isScored(e)) return matchLine(e, s);
    const fired = firedDims(e);
    const names = fired.slice(0, 3).map((d) => lower(d.name));
    if (!names.length) return 'Too little of this review spoke to the profile for a confident argument.';
    const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
    const strength = shownScore(e, s) >= 9 ? 'align almost perfectly with' : shownScore(e, s) >= threshold() ? 'sit well inside' : 'only partly meet';
    return `Strong signals for ${list} ${strength} your profile.`;
  }

  function blurbOf(e, max = 320) {
    const m = e.mentions.find((x) => (x.standfirst || '').trim()) || e.mentions.find((x) => (x.excerpt || '').trim());
    const text = cleanBlurb(m?.standfirst || m?.excerpt || '', { title: e.book.title, author: e.book.author });
    if (!text) return '';
    if (text.length <= max) return text;
    return `${text.slice(0, max).replace(/\s+\S*$/, '')}…`;
  }

  // ------------------------------------------------------------ covers

  // A cover URL rots between builds — Google rotates volume ids and this feed is
  // republished every morning — so a dead image falls back to the drawn jacket
  // rather than leaving an empty box or a broken-image glyph.
  const TONES = ['paper', 'dark', 'garnet', 'lapis', 'olive'];

  function drawnJacket(e) {
    const j = jacketFor({ id: e.id, title: e.book.title, author: e.book.author });
    const tone = TONES[Math.abs(hashId(e.id)) % TONES.length];
    return `<div class="jacket-drawn" data-tone="${tone}" data-size="${esc(j.size)}">
      <div class="j-rule" aria-hidden="true"></div>
      <div class="j-title">${esc(j.title)}</div>
      <div><div class="j-rule" aria-hidden="true"></div><div class="j-author">${esc(j.author)}</div></div>
    </div>`;
  }

  function hashId(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < String(s).length; i++) { h ^= String(s).charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h >>> 0;
  }

  function jacket(e) {
    if (!e.book.coverUrl) return `<div class="jacket">${drawnJacket(e)}</div>`;
    return `<div class="jacket" data-jacket="${esc(e.id)}">
      <img src="${esc(e.book.coverUrl)}" alt="" loading="lazy" decoding="async">
    </div>`;
  }

  function bindJackets(root) {
    const swap = (img) => {
      const box = img.closest('.jacket');
      if (!box) return;
      const e = FEED.books.find((x) => x.id === box.dataset.jacket);
      if (e) box.innerHTML = drawnJacket(e);
    };
    for (const img of $$('.jacket[data-jacket] img', root)) {
      // A 404 already in the browser cache resolves before this handler can be
      // attached, and that error never fires again — which is exactly the case
      // for a cover URL that has been dead since the first visit. So the
      // finished-and-empty state is tested as well as listened for.
      if (img.complete && img.naturalWidth === 0) { swap(img); continue; }
      img.addEventListener('error', () => swap(img), { once: true });
      // A request that never resolves leaves an empty ground where a jacket
      // should be, which reads the same as a broken one. Covers come from hosts
      // this app does not control, so a slow or unreachable one falls back too.
      // Ten seconds, not two: a slow connection should still get the real jacket.
      // Past that the request is not arriving and an empty ground is the worse
      // of the two failures.
      const t = setTimeout(() => { if (!img.complete || !img.naturalWidth) swap(img); }, 10000);
      img.addEventListener('load', () => clearTimeout(t), { once: true });
    }
  }

  // ------------------------------------------------------------ filtering

  function matches(e, q) {
    if (!q) return true;
    const hay = [e.book.title, e.book.author, e.book.publisher,
      ...e.mentions.flatMap((m) => [m.reviewTitle, m.byline, m.source.name])]
      .filter(Boolean).join(' ').toLowerCase();
    return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
  }

  function sortPool(pool, sort) {
    const rows = pool.slice();
    if (sort === 'latest') return rows.sort((a, b) => reviewTime(b.e) - reviewTime(a.e));
    if (sort === 'title') return rows.sort((a, b) =>
      (a.e.book.title || '').localeCompare(b.e.book.title || ''));
    if (sort === 'short') {
      // A book with no page count cannot be ranked by length, so it goes last
      // rather than being treated as the shortest thing in the archive.
      return rows.sort((a, b) => (a.e.book.pages || Infinity) - (b.e.book.pages || Infinity));
    }
    // Best fit. A missing score is never ordered against a number.
    return rows.sort((a, b) => {
      const as = isScored(a.e), bs = isScored(b.e);
      if (as !== bs) return as ? -1 : 1;
      if (!as) return reviewTime(b.e) - reviewTime(a.e);
      return b.s.total - a.s.total || reviewTime(b.e) - reviewTime(a.e);
    });
  }

  // ------------------------------------------------------------ components

  function saveBtn(e, { block = false, label = 'Save' } = {}) {
    const on = isSaved(e);
    return `<button class="btn js-save${block ? ' btn-block' : ''}" data-action="save" data-id="${esc(e.id)}"
      aria-pressed="${on}" aria-label="${on ? 'Remove from your shelf' : 'Save to your shelf'}">
      ${ico('bookmark')}<span>${on ? 'Saved' : label}</span></button>`;
  }

  function bookmarkBtn(e) {
    const on = isSaved(e);
    return `<button class="card-bookmark" data-action="save" data-id="${esc(e.id)}"
      aria-pressed="${on}" aria-label="${on ? 'Remove from your shelf' : 'Save to your shelf'}">${ico('bookmark')}</button>`;
  }

  function scoreBadge(e, s) {
    const status = scoreStatus(e);
    if (status === 'scored') return `<span class="card-score">${shownScore(e, s).toFixed(1)}</span>`;
    return `<span class="card-score" data-state="none">${status === 'reviewed-unscored' ? 'No score' : 'Not scored'}</span>`;
  }

  function card(row, i) {
    const { e, s } = row;
    const status = scoreStatus(e);
    return `<article class="card" data-family="${i % 4}">
      <button class="card-cover" data-action="open" data-id="${esc(e.id)}"
        aria-label="Open the dossier for ${esc(e.book.title)}">
        ${jacket(e)}
        ${scoreBadge(e, s)}
        <span class="card-peek" aria-hidden="true">${ico('arrow')}View dossier</span>
      </button>
      <div class="card-body">
        <p class="card-source">${esc(status === 'awaiting-review' ? (e.book.publisher || 'Catalogue listing') : e.sources.join(' · '))}</p>
        <button class="card-title" data-action="open" data-id="${esc(e.id)}">${esc(e.book.title)}</button>
        ${e.book.author ? `<p class="card-author">${esc(e.book.author)}</p>` : ''}
        <p class="card-why">${ico('sparkles')}<span>${esc(matchLine(e, s))}</span></p>
      </div>
      <div class="card-foot">${bookmarkBtn(e)}</div>
    </article>`;
  }

  function shelf(rows) {
    return `<div class="shelf">${rows.map(card).join('')}</div>`;
  }

  function feedRow(row, i) {
    const { e, s } = row;
    const b = e.book;
    const status = scoreStatus(e);
    const scored = status === 'scored';
    const rec = recommendedNow(e, s);

    const meta = [
      e.sources.join(' · '),
      status === 'awaiting-review' ? `listed ${fmtDate(e.lastReviewed)}` : `reviewed ${fmtDate(e.lastReviewed)}`,
      b.editionDate || b.bookYear || null,
      b.pages ? `${b.pages} pp.` : null,
    ].filter(Boolean).join(' · ');

    const tags = (e.tags || []).filter((t) => DESCRIBING.has(t.kind)).slice(0, 3);

    return `<li><article class="feed-row" data-family="${i % 4}" data-id="${esc(e.id)}">
      <button class="row-cover" data-action="open" data-id="${esc(e.id)}"
        aria-label="Open the dossier for ${esc(b.title)}">${jacket(e)}</button>
      <div class="row-score">
        ${scored
          ? `<span class="row-num">${shownScore(e, s).toFixed(1)}<small>/ 10</small></span>`
          : `<span class="row-num" data-state="none">No score</span>`}
        ${scored && rec ? `<span class="row-rec">${ico('sparkles')}Recommended</span>` : ''}
        ${status === 'reviewed-unscored' ? `<span class="row-rec" data-state="thin">Evidence too thin</span>` : ''}
        ${status === 'awaiting-review' ? `<span class="row-rec" data-state="thin">Awaiting review</span>` : ''}
      </div>
      <div class="row-main">
        <h3 class="row-title"><button data-action="open" data-id="${esc(e.id)}">${esc(b.title)}${
          b.author ? `<span class="row-author">${esc(b.author)}</span>` : ''}</button></h3>
        <p class="row-meta">${esc(meta)}</p>
        ${blurbOf(e, 190) ? `<p class="row-blurb">${esc(blurbOf(e, 190))}</p>` : ''}
        ${!scored ? `<p class="row-note">${esc(status === 'reviewed-unscored'
          ? 'A review exists, but it did not supply enough dependable evidence across the seven dimensions for a number to mean anything.'
          : 'Known from a catalogue listing or the author’s own account. It will be scored when review prose gives the profile something to read.')}</p>` : ''}
        ${tags.length ? `<div class="tags">${tags.map((t) => `<span class="tag">${esc(t.label)}</span>`).join('')}</div>` : ''}
        <button class="row-why" data-action="open" data-id="${esc(e.id)}">${ico('sparkles')}${
          scored ? `Why it’s a ${shownScore(e, s).toFixed(1)}` : 'Why there’s no score'}${ico('arrow')}</button>
      </div>
      <div class="row-actions">
        ${saveBtn(e, { block: true })}
        <button class="btn btn-quiet" data-action="pass" data-id="${esc(e.id)}">Pass</button>
      </div>
    </article></li>`;
  }

  function viewHead({ eyebrow, title, lede, aside = '', action = '' }) {
    return `<header class="view-head">
      <div class="view-head-main">
        <p class="eyebrow">${esc(eyebrow)}</p>
        <h1>${esc(title)}</h1>
        ${lede ? `<p class="view-lede">${lede}</p>` : ''}
      </div>
      ${aside || action ? `<div class="view-head-aside">${aside ? `<span>${esc(aside)}</span>` : ''}${action}</div>` : ''}
    </header>`;
  }

  function toolbar({ scopes, scope, showRecommended = true }) {
    const sortLabel = SORTS.find((x) => x.id === state.sort)?.label || 'Best fit for me';
    return `<div class="toolbar" data-toolbar>
      <div class="search">
        ${ico('search')}
        <label class="sr-only" for="q">Search books</label>
        <input type="search" id="q" value="${esc(state.q)}" placeholder="Title, author, publisher, critic…" autocomplete="off">
      </div>
      <div class="tool-pair">
        <button class="tool-btn" data-action="menu" data-menu="sort" aria-haspopup="true" aria-expanded="${state.openMenu === 'sort'}">
          <span>${esc(sortLabel)}</span>${ico('chevron')}
        </button>
        <button class="tool-btn" data-action="menu" data-menu="filter" aria-haspopup="true" aria-expanded="${state.openMenu === 'filter'}">
          ${ico('sliders')}<span>Filters</span>
        </button>
      </div>
      ${state.openMenu === 'sort' ? sortMenu() : ''}
      ${state.openMenu === 'filter' ? filterMenu(scopes, scope, showRecommended) : ''}
    </div>`;
  }

  function sortMenu() {
    return `<div class="menu-pop" role="menu" data-pop>
      <span class="label">Order</span>
      ${SORTS.map((o) => `<button class="menu-opt" role="menuitemradio" aria-checked="${state.sort === o.id}"
        data-action="sort" data-value="${o.id}">${ico('check')}<span>${esc(o.label)}</span></button>`).join('')}
    </div>`;
  }

  function filterMenu(scopes, scope, showRecommended) {
    return `<div class="menu-pop" role="menu" data-pop>
      <div class="menu-pop-group">
        ${showRecommended ? `<button class="menu-opt" role="menuitemcheckbox" aria-checked="${state.recommendedOnly}"
          data-action="toggle" data-value="recommendedOnly">${ico('check')}<span>Recommended only (${threshold()}+)</span></button>` : ''}
        <button class="menu-opt" role="menuitemcheckbox" aria-checked="${state.shortOnly}"
          data-action="toggle" data-value="shortOnly">${ico('check')}<span>Under 300 pages</span></button>
      </div>
      <div class="menu-pop-group">
        <span class="label">Which books</span>
        ${scopes.map((o) => `<button class="menu-opt" role="menuitemradio" aria-checked="${scope === o.id}"
          data-action="scope" data-value="${o.id}">${ico('check')}<span>${esc(o.label)}</span></button>`).join('')}
        <p class="menu-pop-note">Score ranges apply only to scored books. Missing scores are never treated as zero.</p>
      </div>
    </div>`;
  }

  function moreBtn(shown, total, action) {
    if (shown >= total) return '';
    return `<button class="btn btn-block" data-action="${action}">Show ${Math.min(
      action === 'more-cards' ? CARD_PAGE : ROW_PAGE, total - shown)} more of ${total}</button>`;
  }

  // ------------------------------------------------------------ For you

  function viewForYou() {
    const ranked = edit();
    if (!ranked.length) {
      return `${viewHead({ eyebrow: dateline(), title: greeting(), lede: 'Nothing in the current build clears the profile. The archive is still browseable under All books.' })}
        <div class="panel panel-empty"><h2>No edit today</h2>
        <p>Every scored book has been ruled on, or the build found nothing inside the window.</p>
        <button class="btn btn-solid" data-action="go" data-view="all">Open the archive ${ico('arrow')}</button></div>`;
    }

    const best = ranked.find(({ e, s }) => recommendedNow(e, s)) || ranked[0];
    const rest = ranked.filter((r) => r.e.id !== best.e.id);
    const picks = rest.slice(0, 4);
    const leans = leanCounts(ranked);
    const newly = ranked.slice()
      .sort((a, b) => reviewTime(b.e) - reviewTime(a.e))
      .filter((r) => r.e.id !== best.e.id)
      .slice(0, 3);

    return `
      ${viewHead({
        eyebrow: dateline(),
        title: greeting(),
        lede: `A quiet edit of the books most worth your attention—drawn from ${esc(String(stats.recentReviews))} new reviews, ordered by your taste.`,
      })}

      ${spotlight(best)}

      <section class="lean" aria-label="What today’s selection leans toward">
        <div class="lean-copy">
          <p class="eyebrow">Today’s selection leans</p>
          <p>Toward ${esc(leanPhrase(leans, ranked))}.</p>
        </div>
        <div class="lean-counts">
          ${leans.map((t) => `<span class="lean-count">${esc(t.label)}<b>${t.n}</b></span>`).join('')}
        </div>
      </section>

      <section aria-labelledby="sel-h">
        <div class="section-head">
          <div>
            <p class="eyebrow">A considered shelf</p>
            <h2 id="sel-h">Selected for you</h2>
          </div>
          <button class="section-head-link" data-action="go" data-view="feed">See the full feed ${ico('arrow')}</button>
        </div>
        ${shelf(picks)}
      </section>

      <section aria-labelledby="new-h">
        <div class="section-head">
          <div>
            <p class="eyebrow">The review desk</p>
            <h2 id="new-h">Newly reviewed</h2>
          </div>
          <span class="label">Updated daily</span>
        </div>
        <ul class="rows">${newly.map(feedRow).join('')}</ul>
      </section>`;
  }

  // What the shortlist leans toward and away from. Both halves are counted rather
  // than asserted: the tags that recur most across today's edit, against the
  // penalty the profile fired most often on the books it pushed down.
  function leanPhrase(leans, ranked) {
    if (!leans.length) return 'nothing in particular yet';
    const toward = leans.slice(0, 2).map((t) => t.label.toLowerCase()).join(' and ');
    const fires = new Map();
    for (const { e } of ranked.slice(-120)) {
      for (const f of e.score?.filters || []) fires.set(f.id, (fires.get(f.id) || 0) + 1);
    }
    const top = [...fires.entries()].sort((a, b) => b[1] - a[1])[0];
    const label = top && (FEED.hardFilters || []).find((f) => f.id === top[0])?.label;
    return label ? `${toward}, away from ${lower(label)}` : toward;
  }

  function spotlight({ e, s }) {
    const b = e.book;
    return `<article class="spotlight">
      <div class="spotlight-body">
        <div class="spotlight-kicker">
          <span class="diamond" aria-hidden="true">◆</span>
          <span>
            <b>Your best pick</b>
            <span class="label">Highest fit in today’s edit</span>
          </span>
        </div>
        <h2>${esc(b.title)}</h2>
        ${b.author ? `<p class="spotlight-author">${esc(b.author)}</p>` : ''}
        ${blurbOf(e, 240) ? `<p class="spotlight-blurb">${esc(blurbOf(e, 240))}</p>` : ''}
        <p class="spotlight-fit">${ico('sparkles')}<span>${esc(caseFor(e, s))}</span></p>
        <div class="spotlight-actions">
          <button class="btn btn-solid" data-action="open" data-id="${esc(e.id)}">Open the dossier ${ico('arrow')}</button>
          ${saveBtn(e, { label: 'Save for later' })}
        </div>
      </div>
      <div class="spotlight-cover">
        <button class="jacket-btn" data-action="open" data-id="${esc(e.id)}" aria-label="Open the dossier for ${esc(b.title)}">
          ${jacket(e)}
        </button>
        <span class="spotlight-score"><b>${shownScore(e, s).toFixed(1)}</b><span>Your fit</span></span>
        <span class="folio">CR / 001</span>
      </div>
    </article>`;
  }

  // ------------------------------------------------------------ Review feed

  function viewFeed() {
    const pool = FEED.books
      .filter((e) => {
        const st = scoreStatus(e);
        if (st === 'awaiting-review') return false;
        // A pass takes a book out of the views that recommend. All books keeps it,
        // because the archive is a record rather than an opinion.
        if (passed(e)) return false;
        if (state.scope !== 'any' && st !== state.scope) return false;
        if (state.shortOnly && !(e.book.pages && e.book.pages < 300)) return false;
        return matches(e, state.q);
      })
      .map((e) => ({ e, s: scoreOf(e) }))
      .filter(({ e, s }) => !state.recommendedOnly || recommendedNow(e, s));

    const rows = sortPool(pool, state.sort);
    const shown = rows.slice(0, state.limit);

    return `
      ${viewHead({
        eyebrow: 'Your live edit',
        title: 'Review feed',
        lede: `${esc(String(stats.reviewed))} reviewed titles: ${esc(String(stats.scored))} scored, plus ${esc(String(stats.unscored))} where the evidence was not strong enough for a reliable number.`,
        aside: `${shown.length} previewed · ${rows.length} reviewed`,
      })}

      <div class="coverage">
        <p class="eyebrow">Review coverage</p>
        <div class="coverage-figs">
          <span class="coverage-fig"><b>${stats.scored}</b><span>scored</span></span>
          <span class="coverage-sep" aria-hidden="true">|</span>
          <span class="coverage-fig"><b>${stats.unscored}</b><span>reviewed without enough evidence</span></span>
        </div>
      </div>

      ${toolbar({ scopes: SCOPES, scope: state.scope })}

      ${rows.length
        ? `<ul class="rows">${shown.map(feedRow).join('')}</ul>${moreBtn(shown.length, rows.length, 'more-rows')}`
        : `<div class="panel panel-empty"><h2>Nothing matches</h2>
           <p>No reviewed book answers that search under the filters now set.</p>
           <button class="btn btn-solid" data-action="clear">Clear the filters</button></div>`}`;
  }

  // ------------------------------------------------------------ All books

  function viewAll() {
    const pool = FEED.books
      .filter((e) => {
        const st = scoreStatus(e);
        if (state.allScope !== 'any' && st !== state.allScope) return false;
        if (state.shortOnly && !(e.book.pages && e.book.pages < 300)) return false;
        return matches(e, state.q);
      })
      .map((e) => ({ e, s: scoreOf(e) }));

    const rows = sortPool(pool, state.sort);
    const shown = rows.slice(0, state.allLimit);

    const fig = (n, name, note, id) => `<div class="board-fig" aria-current="${state.allScope === id}">
      <b>${n}</b><span><span class="board-fig-name">${esc(name)}</span><span class="board-fig-note">${esc(note)}</span></span></div>`;

    return `
      ${viewHead({
        eyebrow: 'The complete catalogue',
        title: 'Every book, clearly accounted for.',
        lede: `The full ${esc(String(stats.total))}-book archive—scored and unscored—without making absence look like a verdict.`,
        aside: `${shown.length} previewed · ${rows.length} total`,
      })}

      <div class="board">
        <div class="board-lede">
          <p class="eyebrow">Score status</p>
          <h2>A missing score is information, not a judgment.</h2>
          <p>Books stay fully browseable. We show whether a review lacked enough evidence or has not been evaluated yet.</p>
        </div>
        <div class="board-figs">
          ${fig(stats.total, 'All books', 'Complete archive', 'any')}
          ${fig(stats.scored, 'Scored', 'Reliable fit evidence', 'scored')}
          ${fig(stats.unscored, 'Reviewed · no score', 'Evidence too thin', 'reviewed-unscored')}
          ${fig(stats.awaiting, 'Awaiting review', 'Catalogue only', 'awaiting-review')}
        </div>
      </div>

      ${toolbar({ scopes: ALL_SCOPES, scope: state.allScope, showRecommended: false })}

      ${rows.length
        ? `${shelf(shown)}${moreBtn(shown.length, rows.length, 'more-cards')}`
        : `<div class="panel panel-empty"><h2>Nothing matches</h2>
           <p>No book in the archive answers that search under the filters now set.</p>
           <button class="btn btn-solid" data-action="clear">Clear the filters</button></div>`}`;
  }

  // ------------------------------------------------------------ Saved

  function viewSaved() {
    const rows = saved.listSaved(verdicts, FEED.books, 'recent')
      .map(({ entry }) => ({ e: entry, s: scoreOf(entry) }));
    const missing = saved.savedCount(verdicts) - rows.length;

    return `
      ${viewHead({
        eyebrow: 'Your shelf',
        title: rows.length ? 'Your shelf, so far.' : 'A shelf with room to grow.',
        lede: 'Save books from the feed and they’ll gather here—ready to compare, buy, or export.',
        aside: rows.length ? `${rows.length} saved${missing > 0 ? ` · ${missing} not in this build` : ''}` : '',
      })}
      ${rows.length
        ? shelf(rows)
        : `<div class="panel panel-empty">
            ${ico('bookmark')}
            <h2>Nothing saved yet</h2>
            <p>Start with today’s shortlist. One tap keeps a book without interrupting your browse.</p>
            <button class="btn btn-solid" data-action="go" data-view="foryou">Browse your recommendations ${ico('arrow')}</button>
          </div>`}`;
  }

  // ------------------------------------------------------------ Taste

  function viewTaste() {
    const savedN = taste?.savedCount ?? saved.savedCount(verdicts);
    const need = Math.max(0, MIN_SIGNAL - savedN);
    const dims = FEED.dimensions
      .map((d) => ({ name: d.name, weight: weightOf(d) }))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 5);
    const max = dims[0]?.weight || 1;

    return `
      ${viewHead({
        eyebrow: 'Learning from your choices',
        title: 'Your taste, made legible.',
        lede: 'The profile is the foundation. Your saves can gently refine it—never silently rewrite it.',
      })}

      <div class="dash">
        <div class="dash-side">
          <div class="dash-calibrate">
            <span class="calibrate-dial">${savedN}<small>/ ${MIN_SIGNAL}</small></span>
            <div>
              <p class="eyebrow">Calibration</p>
              <h2>${need ? `${need} more save${need === 1 ? '' : 's'} to begin learning.` : 'Your saves are tuning the feed.'}</h2>
              <p>Saves can move a score by no more than ${(MAX_ADJUSTMENT / 10).toFixed(1)} points. Rules and penalties remain entirely yours.</p>
              <button class="btn btn-solid" data-action="go" data-view="foryou">${need ? 'Find something to keep' : 'Keep reading the edit'}</button>
            </div>
          </div>
        </div>
        <div class="dash-side">
          <div class="dash-signal-head">
            <div>
              <p class="eyebrow">Profile signal</p>
              <h2>What currently matters</h2>
            </div>
            <span class="label">v${esc(String(FEED.profileRevision))}</span>
          </div>
          <div class="bars">
            ${dims.map((d) => `<div class="bar-row">
              <span class="bar-name">${esc(d.name)}</span>
              <span class="bar-track"><span class="bar-fill" style="width:${Math.round(d.weight / max * 100)}%"></span></span>
              <span class="bar-val">${d.weight}</span>
            </div>`).join('')}
          </div>
        </div>
      </div>

      <section aria-labelledby="how-h">
        <div class="section-head">
          <div>
            <p class="eyebrow">Plain English, always</p>
            <h2 id="how-h">How a recommendation moves</h2>
          </div>
        </div>
        <div class="steps">
          <div class="step"><span class="step-n">01</span><h3>The review is read</h3>
            <p>Shared tags describe the book’s form, subject, tone, scale, and provenance.</p></div>
          <div class="step"><span class="step-n">02</span><h3>Your weights decide</h3>
            <p>Your profile determines what each signal is worth, with explicit rules and penalties.</p></div>
          <div class="step"><span class="step-n">03</span><h3>Your saves nudge</h3>
            <p>Saved books make small transparent adjustments—not hidden replacements.</p></div>
        </div>
      </section>`;
  }

  // ------------------------------------------------------------ Profile

  const weightOf = (d) => overrides.weights?.[d.id] ?? d.weight;

  // The four guardrails the profile applies, in the reader's words rather than
  // the build's rule ids. Each maps onto a rule or hard filter that already
  // exists in the feed, so switching one off changes a real score.
  const GUARDRAILS = [
    { group: 'rules', key: 'twist_override', copy: 'Resolve formal-device scores downward when the review reveals a twist.' },
    { group: 'rules', key: 'trap4_land_scale', copy: 'Require institutional or multi-decade stakes for land and labor themes.' },
    { group: 'rules', key: 'd6_sprawl_without_ambition', copy: 'Penalize long books when the review shows no multi-strand structure.' },
    { group: 'adjustments', key: 'nonfiction', copy: 'Keep nonfiction below fiction unless provenance is exceptionally strong.' },
  ];

  const guardrailOn = (g) => overrides[g.group]?.[g.key] !== false;

  function draft() {
    if (!state.draftWeights) {
      state.draftWeights = Object.fromEntries(FEED.dimensions.map((d) => [d.id, weightOf(d)]));
    }
    return state.draftWeights;
  }

  function draftTotal() {
    return Object.values(draft()).reduce((n, v) => n + v, 0);
  }

  function viewProfile() {
    const w = draft();
    const total = draftTotal();
    const ok = total === 100;
    const tags = leanCounts(edit(), 3);

    return `
      ${viewHead({
        eyebrow: `Profile v${esc(String(FEED.profileRevision))} · Local draft`,
        title: 'Set the terms of your own taste.',
        lede: 'The words used to describe a book are shared. What those words are worth is entirely yours.',
        action: `<button class="btn btn-solid" data-action="save-profile" ${ok ? '' : 'disabled'}
          aria-describedby="weights-total">Save changes ${ico('check')}</button>`,
      })}

      <div class="profile-grid">
        <div class="weights">
          <div class="weights-head">
            <div>
              <p class="eyebrow">Weighted dimensions</p>
              <h2>What a book is worth</h2>
            </div>
            <span class="weights-total" id="weights-total" data-over="${!ok}" role="status">
              ${total} / 100 points ${ok ? 'total' : '— must total 100'}</span>
          </div>
          ${FEED.dimensions.map((d) => `<div class="weight-row">
            <label class="weight-label" for="w-${esc(d.id)}">${esc(d.name)}<b>${w[d.id]}</b></label>
            <input type="range" id="w-${esc(d.id)}" min="0" max="40" step="1" value="${w[d.id]}"
              data-weight="${esc(d.id)}" aria-valuetext="${w[d.id]} of 100 points">
          </div>`).join('')}
        </div>

        <aside class="summary-rail">
          <p class="summary-threshold"><b>${threshold().toFixed(1)}</b><span class="label">Recommend threshold</span></p>
          <hr>
          <h3>Your profile in one sentence</h3>
          <p>Historically alive, formally ambitious fiction with controlled prose and a reason to be long.</p>
          <div class="tags">${tags.map((t) => `<span class="tag">${esc(t.label)}</span>`).join('')}</div>
        </aside>

        <section class="guardrails profile-guardrails" aria-labelledby="guard-h">
          <div class="weights-head">
            <div>
              <p class="eyebrow">Guardrails</p>
              <h2 id="guard-h">Rules the profile applies</h2>
            </div>
            <span class="weights-total">${GUARDRAILS.filter(guardrailOn).length} active</span>
          </div>
          ${GUARDRAILS.map((g, i) => `<div class="guardrail-row">
            <span id="g-${i}">${esc(g.copy)}</span>
            <button class="switch" role="switch" aria-checked="${guardrailOn(g)}"
              aria-labelledby="g-${i}" data-action="guardrail" data-guardrail="${i}"></button>
          </div>`).join('')}
        </section>

        <div class="profile-extras">
          <p>Your saves and passes are what the next revision of the profile is written from. Export them as JSON to keep or to feed back in.</p>
          <button class="btn" data-action="export">Export my verdicts</button>
        </div>
      </div>`;
  }

  // ------------------------------------------------------------ dossier

  let lastFocus = null;
  let lastFocusKey = null;

  function openDossier(id) {
    const e = FEED.books.find((x) => x.id === id);
    if (!e) return;
    lastFocus = document.activeElement;
    // A save or a pass made inside the dossier redraws the page behind it, so the
    // node that opened it is gone by the time we close. The book and the action
    // it carried are enough to find its replacement.
    const d = lastFocus?.dataset || {};
    const cls = lastFocus?.classList?.[0];
    lastFocusKey = d.id && d.action
      ? `${cls ? `.${CSS.escape(cls)}` : ''}[data-action="${d.action}"][data-id="${CSS.escape(d.id)}"]`
      : null;
    const box = $('dossier');
    box.innerHTML = dossierHtml(e);
    box.hidden = false;
    $('scrim').hidden = false;
    document.body.classList.add('is-locked');
    bindJackets(box);
    box.scrollTop = 0;
    box.querySelector('.dossier-close')?.focus();
    analytics.track('book_opened', { bookId: e.id, view: state.view });
  }

  function closeDossier() {
    const box = $('dossier');
    if (box.hidden) return;
    box.hidden = true;
    box.innerHTML = '';
    $('scrim').hidden = true;
    document.body.classList.remove('is-locked');
    const back = lastFocus?.isConnected ? lastFocus : (lastFocusKey && document.querySelector(lastFocusKey));
    back?.focus?.();
    lastFocus = null;
    lastFocusKey = null;
  }

  const dossierOpenId = () => $('dossier').querySelector('[data-dossier-id]')?.dataset.dossierId || null;

  function dossierHtml(e) {
    const s = scoreOf(e);
    const b = e.book;
    const status = scoreStatus(e);
    const scored = status === 'scored';
    const rec = recommendedNow(e, s);
    const on = isSaved(e);

    const facts = [b.bookYear || null, b.pages ? `${b.pages} pages` : null, b.publisher || null]
      .filter(Boolean).join(' · ');

    const fired = firedDims(e).slice(0, 5);
    const maxc = Math.max(1, ...fired.map((d) => d.score * d.weight));

    const m = e.mentions.find((x) => (x.standfirst || '').trim()) || e.mentions[0];
    const tags = (e.tags || []).filter((t) => DESCRIBING.has(t.kind)).slice(0, 6);

    const buys = canFindCopy(buyIds(e)) ? RETAILERS.map((r) => {
      const link = linkFor(r.id, buyIds(e), AFFILIATES);
      if (!link) return '';
      return `<a class="buylink" href="${esc(link.url)}" target="_blank" rel="noopener noreferrer"
        data-action="buy" data-id="${esc(e.id)}" data-retailer="${esc(r.id)}" data-resolution="${esc(link.linkResolution)}">
        <b>${esc(r.name)}</b><span>Search ↗</span></a>`;
    }).join('') : '';

    return `<div data-dossier-id="${esc(e.id)}">
      <button class="dossier-close" data-action="close-dossier" aria-label="Close the dossier">${ico('close')}</button>

      <div class="dossier-head">
        ${jacket(e)}
        <div>
          <p class="dossier-score">
            ${scored ? `<b>${shownScore(e, s).toFixed(1)}<small>FIT</small></b>` : ''}
            <span class="dossier-state" data-state="${scored && rec ? 'rec' : 'none'}">${
              scored ? (rec ? 'Recommended for you' : 'Below your threshold') :
              status === 'reviewed-unscored' ? 'Reviewed · no score' : 'Awaiting review'}</span>
          </p>
          <h2 id="dossier-title">${esc(b.title)}</h2>
          ${b.author ? `<p class="dossier-author">${esc(b.author)}</p>` : ''}
          ${facts ? `<p class="dossier-facts">${esc(facts)}</p>` : ''}
        </div>
      </div>

      <div class="dossier-actions">
        <button class="btn ${on ? '' : 'btn-solid'}" data-action="save" data-id="${esc(e.id)}" aria-pressed="${on}">
          ${ico('bookmark')}<span>${on ? 'On your shelf' : 'Save to shelf'}</span></button>
        <button class="btn" data-action="pass" data-id="${esc(e.id)}">Pass for now</button>
      </div>

      <section class="dossier-block">
        <p class="eyebrow">${scored ? 'The case for it' : 'What is known'}</p>
        <h3>${esc(caseFor(e, s))}</h3>
        ${blurbOf(e, 420) ? `<p>${esc(blurbOf(e, 420))}</p>` : ''}
      </section>

      <section class="dossier-block">
        <p class="eyebrow">${scored ? 'Transparent scoring' : 'Evidence status'}</p>
        <span class="dossier-head-note">Profile v${esc(String(FEED.profileRevision))}</span>
        <h3>${scored ? `Why it earned ${shownScore(e, s).toFixed(1)}` : 'Why there is no score'}</h3>
        <p>${esc(scoreNarrative(e, s))}</p>
        ${scored && fired.length ? `<div class="bars">${fired.map((d) => `<div class="bar-row">
          <span class="bar-name">${esc(d.name)}</span>
          <span class="bar-track"><span class="bar-fill" style="width:${Math.round(d.score * d.weight / maxc * 100)}%"></span></span>
          <span class="bar-val">${d.score}</span></div>`).join('')}</div>` : ''}
        ${tags.length ? `<div class="tags">${tags.map((t) => `<span class="tag">${esc(t.label)}</span>`).join('')}</div>` : ''}
      </section>

      ${m?.standfirst ? `<section class="dossier-block">
        <p class="eyebrow">${status === 'awaiting-review' ? 'From the listing' : 'From the review'}</p>
        <blockquote class="quote">${esc(m.standfirst.length > 300 ? `${m.standfirst.slice(0, 300).replace(/\s+\S*$/, '')}…` : m.standfirst)}
          <span class="quote-source">${esc(m.source.name)} · ${esc(fmtDate(m.reviewDate))}${m.byline ? ` · ${esc(m.byline)}` : ''}</span>
        </blockquote>
        <p><a href="${esc(m.reviewUrl)}" target="_blank" rel="noopener">Read the ${esc(m.source.short)} ${status === 'awaiting-review' ? 'source' : 'review'} ↗</a></p>
      </section>` : ''}

      ${buys ? `<section class="dossier-block">
        <p class="eyebrow">Find a copy</p>
        <div class="buylinks">${buys}</div>
      </section>` : ''}
    </div>`;
  }

  const buyIds = (e) => ({
    title: e.book.title, author: e.book.author,
    isbn10: e.book.isbn10, isbn13: e.book.isbn13, asin: e.book.asin,
  });

  function scoreNarrative(e, s) {
    const status = scoreStatus(e);
    if (status === 'reviewed-unscored') {
      return 'A critical review exists, but it did not supply enough dependable evidence across the seven dimensions to support a number. The book stays visible; the ranking stays blank.';
    }
    if (status === 'awaiting-review') {
      return 'This book is known from a catalogue listing or the author’s own account, not from a critical review. It can be described and saved now, but it will not be ranked until review prose gives the profile something to read.';
    }
    const fired = firedDims(e);
    const names = fired.slice(0, 3).map((d) => lower(d.name));
    const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0] || 'very little';
    const thin = e.score?.scoredOnPartialEvidence
      ? ' The evidence is thin, so treat the number as triage rather than a reading.'
      : '';
    const tuned = s.tuned && Math.abs(s.delta) >= 0.3
      ? ` Your saves move it ${s.delta > 0 ? 'up' : 'down'} to ${outOfTen(s.total).toFixed(1)} from the profile’s own ${outOfTen(s.profileBase).toFixed(1)}.`
      : '';
    return `Strong signals for ${list}.${thin}${tuned}`;
  }

  // ------------------------------------------------------------ saving

  function toast(message, { error = false, undo = null } = {}) {
    const el = $('toast');
    el.innerHTML = `<span>${esc(message)}</span>${undo ? '<button class="btn" id="toast-undo">Undo</button>' : ''}`;
    el.style.borderColor = error ? 'var(--destructive)' : 'var(--brass)';
    el.hidden = false;
    if (undo) $('toast-undo').addEventListener('click', () => { el.hidden = true; undo(); });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, undo ? 6000 : 2600);
  }

  const announce = (msg) => { $('announce').textContent = msg; };

  // Optimistic: the list changes and the screen redraws first, and only then is
  // the write attempted. A failed write puts the previous list back exactly.
  function commit(next, { onOk, onFail } = {}) {
    const previous = verdicts;
    verdicts = next;
    retune();
    render();
    try {
      persist(VERDICT_KEY, next);
      profileVersion++;
      onOk?.();
      syncNow();
    } catch {
      verdicts = previous;
      retune();
      render();
      onFail?.();
    }
  }

  function toggleSave(id) {
    const e = FEED.books.find((x) => x.id === id);
    const want = !isSaved(e);
    commit(want ? saved.save(verdicts, id) : saved.unsave(verdicts, id), {
      onOk: () => {
        const msg = want ? `Saved: ${e.book.title}.` : `Removed: ${e.book.title}.`;
        toast(want ? 'Saved for later.' : 'Removed from your shelf.');
        announce(msg);
        analytics.track(want ? 'book_saved' : 'book_unsaved', { bookId: id, view: state.view });
      },
      onFail: () => toast('That could not be written to this browser.', { error: true }),
    });
  }

  // A pass takes a book out of the recommendation views and leaves the archive
  // record alone. It is undoable, because it is the one action with no control
  // left on screen afterwards.
  function passBook(id) {
    const e = FEED.books.find((x) => x.id === id);
    const was = saved.verdictOf(verdicts, id);
    commit(saved.setVerdict(verdicts, id, 'passed'), {
      onOk: () => {
        announce(`Passed: ${e.book.title}.`);
        toast(`Passed on ${e.book.title}.`, {
          undo: () => commit(saved.setVerdict(verdicts, id, was)),
        });
      },
      onFail: () => toast('That could not be written to this browser.', { error: true }),
    });
  }

  function saveProfile() {
    if (draftTotal() !== 100) return;
    const w = draft();
    const next = { ...overrides, weights: { ...overrides.weights } };
    for (const d of FEED.dimensions) {
      if (w[d.id] === d.weight) delete next.weights[d.id];
      else next.weights[d.id] = w[d.id];
    }
    overrides = sync.stamp(next);
    write(OVERRIDES_KEY, overrides);
    profileVersion++;
    render();
    toast('Profile saved. The feed re-ranked.');
    announce('Profile saved. Every score has been recalculated.');
    syncNow();
  }

  function toggleGuardrail(i) {
    const g = GUARDRAILS[i];
    const on = guardrailOn(g);
    const next = { ...overrides, [g.group]: { ...overrides[g.group] } };
    if (on) next[g.group][g.key] = false;
    else delete next[g.group][g.key];
    overrides = sync.stamp(next);
    write(OVERRIDES_KEY, overrides);
    profileVersion++;
    render();
    syncNow();
  }

  // Every verdict this device holds, resolved against the current build. The
  // profile is revised by hand from this file, so it carries the title and author
  // rather than only the ids that mean nothing outside the app.
  function exportVerdicts() {
    const byId = new Map(FEED.books.map((e) => [e.id, e]));
    const rows = Object.entries(verdicts)
      .filter(([, v]) => v.verdict)
      .map(([id, v]) => ({
        id,
        verdict: v.verdict,
        savedAt: v.savedAt ?? null,
        title: byId.get(id)?.book.title ?? null,
        author: byId.get(id)?.book.author ?? null,
        score: byId.get(id) && isScored(byId.get(id)) ? shownScore(byId.get(id)) : null,
      }));
    const payload = { exportedAt: new Date().toISOString(), profileRevision: FEED.profileRevision, verdicts: rows, overrides };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'constant-reader-verdicts.json';
    a.click();
    URL.revokeObjectURL(url);
    toast(`Exported ${rows.length} verdict${rows.length === 1 ? '' : 's'}.`);
  }

  // ------------------------------------------------------------ sync

  const localProfile = () => ({ verdicts, overrides });

  function adoptProfile(merged) {
    verdicts = merged.verdicts;
    overrides = { ...EMPTY_OVERRIDES, ...merged.overrides };
    write(VERDICT_KEY, verdicts);
    write(OVERRIDES_KEY, overrides);
    state.draftWeights = null;
    retune();
    render();
  }

  const monogramOf = (u) => {
    const name = u?.displayName || u?.email || '';
    const letter = name.trim().charAt(0).toUpperCase();
    return /[A-Z0-9]/.test(letter) ? letter : '@';
  };

  function rememberAccount(u) {
    if (!u) { write(ACCOUNT_KEY, null); return; }
    write(ACCOUNT_KEY, { name: u.displayName || u.email || 'your account', mono: monogramOf(u) });
  }

  function showAuth({ failing = false } = {}) {
    const account = read(ACCOUNT_KEY, null);
    const signedIn = Boolean(user) || (account && read(sync.RETURNING_KEY, false) === true);
    const name = user ? (user.displayName || user.email || 'your account') : account?.name;
    const word = signedIn ? 'Sign out' : 'Sign in';
    $('auth-word').textContent = word;
    for (const el of $$('[data-auth] span')) el.textContent = word;
    $('auth-note').textContent = !signedIn
      ? 'Saves stay on this device until you sign in.'
      : failing
        ? `Signed in as ${name}. Not syncing right now — your books are safe on this device.`
        : `Signed in as ${name}. Your books sync across your devices.`;
  }

  async function syncNow() {
    if (!user) return;
    if (syncing) { syncQueued = true; return; }
    syncing = true;
    try {
      do {
        syncQueued = false;
        const version = profileVersion;
        const uid = user?.uid;
        if (!uid) break;
        try {
          const merged = await sync.reconcile(uid, localProfile());
          if (user?.uid !== uid) break;
          if (profileVersion === version) adoptProfile(merged);
          else syncQueued = true;
          showAuth();
        } catch (err) {
          showAuth({ failing: true });
          toast(sync.explain(err), { error: true });
          break;
        }
      } while (syncQueued && user);
    } finally {
      syncing = false;
    }
  }

  async function doAuth() {
    if (user) {
      try { await sync.signOut(); } catch { /* already gone */ }
      write(sync.RETURNING_KEY, false);
      rememberAccount(null);
      user = null;
      showAuth();
      render();
      toast('Signed out. Your books stay on this device.');
      return;
    }
    try {
      user = await sync.signIn();
      write(sync.RETURNING_KEY, true);
      rememberAccount(user);
      showAuth();
      render();
      await syncNow();
      toast('Signed in. Your books are synced.');
    } catch (err) {
      user = null;
      write(sync.RETURNING_KEY, false);
      rememberAccount(null);
      showAuth();
      toast(sync.explain(err), { error: true });
    }
  }

  // ------------------------------------------------------------ navigation

  const VIEWS = {
    foryou: viewForYou,
    feed: viewFeed,
    all: viewAll,
    saved: viewSaved,
    taste: viewTaste,
    profile: viewProfile,
  };

  function setView(view) {
    if (!VIEWS[view]) return;
    state.view = view;
    state.openMenu = null;
    state.limit = ROW_PAGE;
    state.allLimit = CARD_PAGE;
    if (view === 'profile') state.draftWeights = null;
    savePrefs();
    closeMenuPanel();
    render();
    window.scrollTo({ top: 0, behavior: 'auto' });
    const heading = $('view-root').querySelector('h1');
    heading?.setAttribute('tabindex', '-1');
    heading?.focus?.({ preventScroll: true });
  }

  function syncChrome() {
    const n = saved.savedCount(verdicts);
    for (const el of $$('[data-saved-count]')) { el.textContent = String(n); el.dataset.zero = String(n === 0); }
    for (const btn of $$('.sidenav-item, .menu-item, .bottom-item')) {
      if (btn.dataset.view === state.view) btn.setAttribute('aria-current', 'page');
      else btn.removeAttribute('aria-current');
    }
    const dot = $$('[data-profile-dot]')[0];
    if (dot) dot.hidden = isEmpty(overrides);
  }

  function render() {
    computeStats();
    const root = $('view-root');
    root.innerHTML = `<div class="view">${VIEWS[state.view]()}</div>`;
    bindJackets(root);
    syncChrome();
    // A dossier left open must show the state the action just produced.
    const openId = dossierOpenId();
    if (openId) {
      const box = $('dossier');
      const top = box.scrollTop;
      box.innerHTML = dossierHtml(FEED.books.find((x) => x.id === openId));
      bindJackets(box);
      box.scrollTop = top;
    }
  }

  function closeMenuPanel() {
    $('menu-panel').hidden = true;
    $('menu-toggle').setAttribute('aria-expanded', 'false');
    $('menu-toggle').querySelector('use').setAttribute('href', '#i-menu');
  }

  // ------------------------------------------------------------ events

  function actionsFrom(el) {
    const btn = el.closest('[data-action]');
    return btn ? { btn, action: btn.dataset.action } : null;
  }

  function bindGlobal() {
    document.addEventListener('click', (ev) => {
      const nav = ev.target.closest('[data-view]');
      if (nav && !nav.dataset.action) {
        ev.preventDefault();
        setView(nav.dataset.view);
        return;
      }

      const hit = actionsFrom(ev.target);
      if (!hit) {
        // An outside click closes an open sort or filter menu, which is what a
        // menu is expected to do; nothing else on the page is dismissible.
        if (state.openMenu && !ev.target.closest('[data-pop]')) { state.openMenu = null; render(); }
        return;
      }
      const { btn, action } = hit;

      switch (action) {
        case 'open': ev.preventDefault(); openDossier(btn.dataset.id); break;
        case 'close-dossier': closeDossier(); break;
        case 'save': toggleSave(btn.dataset.id); break;
        case 'pass': passBook(btn.dataset.id); break;
        case 'go': setView(btn.dataset.view); break;
        case 'menu':
          state.openMenu = state.openMenu === btn.dataset.menu ? null : btn.dataset.menu;
          render();
          $$('[data-menu]').find((b) => b.dataset.menu === state.openMenu)?.focus();
          break;
        case 'sort': state.sort = btn.dataset.value; state.openMenu = null; savePrefs(); render(); break;
        case 'scope':
          if (state.view === 'all') state.allScope = btn.dataset.value;
          else state.scope = btn.dataset.value;
          state.openMenu = null; savePrefs(); render();
          break;
        case 'toggle': state[btn.dataset.value] = !state[btn.dataset.value]; savePrefs(); render(); break;
        case 'clear':
          state.q = ''; state.recommendedOnly = false; state.shortOnly = false;
          state.scope = 'any'; state.allScope = 'any';
          savePrefs(); render();
          break;
        case 'more-rows': state.limit += ROW_PAGE; render(); break;
        case 'more-cards': state.allLimit += CARD_PAGE; render(); break;
        case 'save-profile': saveProfile(); break;
        case 'guardrail': toggleGuardrail(Number(btn.dataset.guardrail)); break;
        case 'export': exportVerdicts(); break;
        case 'buy':
          write('litfeed:last-retailer', btn.dataset.retailer);
          analytics.track('retailer_opened', { bookId: btn.dataset.id, retailer: btn.dataset.retailer, resolution: btn.dataset.resolution });
          break;
        default: break;
      }
    });

    // Search filters as the reader types. The field is re-created on every
    // render, so the caret and the focus are restored by hand.
    document.addEventListener('input', (ev) => {
      if (ev.target.id === 'q') {
        // The whole view redraws, which destroys the field being typed into, so
        // the caret is carried across by hand rather than snapped to the end —
        // otherwise editing the middle of a query throws you to the end of it.
        const at = ev.target.selectionStart;
        const end = ev.target.selectionEnd;
        state.q = ev.target.value;
        state.limit = ROW_PAGE;
        state.allLimit = CARD_PAGE;
        render();
        const field = $('q');
        if (field) { field.focus(); try { field.setSelectionRange(at, end); } catch { /* not selectable */ } }
        return;
      }
      if (ev.target.dataset.weight) {
        const w = draft();
        w[ev.target.dataset.weight] = Number(ev.target.value);
        // Redrawing on every pixel of a drag would lose the pointer, so only the
        // two numbers that have to keep up are written directly.
        const label = ev.target.previousElementSibling?.querySelector('b');
        if (label) label.textContent = String(w[ev.target.dataset.weight]);
        ev.target.setAttribute('aria-valuetext', `${w[ev.target.dataset.weight]} of 100 points`);
        const total = draftTotal();
        const el = $('weights-total');
        if (el) {
          el.textContent = `${total} / 100 points ${total === 100 ? 'total' : '— must total 100'}`;
          el.dataset.over = String(total !== 100);
        }
        const save = document.querySelector('[data-action="save-profile"]');
        if (save) save.disabled = total !== 100;
      }
    });

    $('menu-toggle').addEventListener('click', () => {
      const panel = $('menu-panel');
      const open = panel.hidden;
      panel.hidden = !open;
      $('menu-toggle').setAttribute('aria-expanded', String(open));
      $('menu-toggle').querySelector('use').setAttribute('href', open ? '#i-close' : '#i-menu');
    });

    $('auth').addEventListener('click', doAuth);
    for (const el of $$('[data-auth]')) el.addEventListener('click', doAuth);
    $('scrim').addEventListener('click', closeDossier);

    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        if (!$('dossier').hidden) { closeDossier(); return; }
        if (state.openMenu) { state.openMenu = null; render(); return; }
        if (!$('menu-panel').hidden) { closeMenuPanel(); $('menu-toggle').focus(); }
        return;
      }
      // Focus stays inside the dossier while it is open. Tab wraps at both ends.
      if (ev.key === 'Tab' && !$('dossier').hidden) {
        const box = $('dossier');
        const focusable = $$('a[href], button:not([disabled]), input, [tabindex]:not([tabindex="-1"])', box)
          .filter((el) => el.offsetParent !== null);
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
        else if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
        else if (!box.contains(document.activeElement)) { ev.preventDefault(); first.focus(); }
      }
    });

    // Firebase takes a round trip to answer. A reader who never signed in loads
    // nothing at all: watch() returns immediately.
    sync.watch((u, { authoritative } = {}) => {
      user = u;
      if (!u && authoritative) { write(sync.RETURNING_KEY, false); rememberAccount(null); }
      else if (u) rememberAccount(u);
      showAuth({ failing: !u && !authoritative });
      if (u) { syncNow(); render(); }
    }, { returning: read(sync.RETURNING_KEY, false) === true });
  }

  // ------------------------------------------------------------ boot

  function skeleton() {
    $('view-root').innerHTML = `<div class="view">${Array.from({ length: 4 }, () => `
      <div class="skeleton"><div class="sk-cover"></div>
      <div><div class="sk line w40"></div><div class="sk line w90"></div><div class="sk line w70"></div></div></div>`).join('')}</div>`;
  }

  function failure(message, detail) {
    $('view-root').innerHTML = `<div class="panel panel-empty"><h2>${esc(message)}</h2><p>${detail}</p></div>`;
  }

  async function boot() {
    skeleton();
    let res;
    try {
      res = await fetch('data/feed.json', { cache: 'no-cache' });
    } catch {
      failure('The feed could not be loaded',
        'Opening <code>index.html</code> straight off disk blocks the fetch. Serve the folder over HTTP and use the address it prints.');
      return;
    }
    if (!res.ok) { failure('No feed has been built yet', 'Run the build; it writes <code>data/feed.json</code>.'); return; }
    FEED = await res.json();
    if (!FEED.books?.length) { failure('The feed is empty', 'The build ran but found nothing. Check the source report it printed.'); return; }

    loadPrefs();
    loadOverrides();
    retune();

    $('profile-rev').textContent = String(FEED.profileRevision);
    $('threshold-line').textContent = `${threshold()}+ is recommended`;
    $('rebuilt-line').textContent = rebuiltPhrase(FEED.builtAt);

    bindGlobal();
    showAuth();
    render();
  }

  boot();
})();
