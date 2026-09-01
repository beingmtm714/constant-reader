/* Constant Reader — the jewel editorial desk.

   Reads data/feed.json, ranks it against the reading profile, and draws six
   sections over one normalised book record: For you, Review feed, All books,
   Saved, Taste, Profile. Every route into a book ends at the same dossier.

   The scoring is not here. It lives in lib/, shared with the build, so the
   browser and the build can never disagree about what a number means. This file
   decides what is shown and in what order. */

import * as saved from './lib/saved-books.mjs?v=bb5f9182b2';
import { RETAILERS, linkFor, canFindCopy } from './lib/retailers.mjs?v=bb5f9182b2';
import { createAnalytics } from './lib/analytics.mjs?v=bb5f9182b2';
import { buildTasteModel, tunedTotal, explore, MIN_SIGNAL, MIN_JUDGMENTS, MAX_ADJUSTMENT } from './lib/taste.mjs?v=bb5f9182b2';
import { outOfTen, RECOMMEND_AT } from './lib/recommend.mjs?v=bb5f9182b2';
import { rescore, isEmpty, bandKey, AVERSION_STRENGTHS, MAX_AVERSIONS, EMPTY as EMPTY_OVERRIDES } from './lib/overrides.mjs?v=bb5f9182b2';
import { READS, REFUSALS, MIN_PICKS, answersReady, chipsFor, groupedChipsFor, buildProfile } from './lib/onboard.mjs?v=bb5f9182b2';
import * as sync from './lib/sync.mjs?v=bb5f9182b2';
import * as push from './lib/push.mjs?v=bb5f9182b2';
import { jacketFor } from './lib/jacket.mjs?v=bb5f9182b2';
import { cleanBlurb, bestBlurb } from './lib/blurb.mjs?v=bb5f9182b2';
import { coverFor, fillsSlot } from './lib/cover.mjs?v=bb5f9182b2';
import { buildIndex as buildSearchIndex, search as runSearch, EXAMPLES as SEARCH_EXAMPLES } from './lib/search.mjs?v=bb5f9182b2';

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const VERDICT_KEY = 'litfeed:verdicts';
  const PREFS_KEY = 'litfeed:prefs';
  const OVERRIDES_KEY = 'litfeed:overrides';
  const EVENTS_KEY = 'litfeed:events';
  const ACCOUNT_KEY = 'litfeed:account';
  // The onboarding answers themselves, kept after they have been turned into
  // weights. buildProfile is one-way — a set of picks becomes a set of numbers
  // and the picks are gone — so without this a reader can never see what they
  // said, let alone change one word of it. Everything they can edit afterwards
  // depends on this being written down.
  const ANSWERS_KEY = 'litfeed:answers';
  // When the reader was last here, and the cutoff the page is currently drawing
  // "new since" against. Two keys rather than one because a reload must not
  // wipe the answer: the cutoff only advances when a visit is an hour or more
  // after the last, so refreshing five minutes later shows the same books.
  const VISIT_KEY = 'litfeed:visit';

  // No affiliate programme has been approved, so every outbound link goes clean.
  const AFFILIATES = {};

  // How many rows or cards a section previews before the reader asks for more.
  const ROW_PAGE = 14;
  const CARD_PAGE = 16;
  const SEARCH_PAGE = 12;

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

  const PCT_LABEL = 'Best fit for me';

  const SCOPES = [
    { id: 'any', label: 'Everything the profile can place' },
    { id: 'scored', label: 'Scored' },
    { id: 'reviewed-unscored', label: 'Described · no score' },
  ];

  const KINDS = [
    { id: 'any', label: 'Both' },
    { id: 'fiction', label: 'Fiction only' },
    { id: 'nonfiction', label: 'Nonfiction only' },
  ];

  const ALL_SCOPES = [
    { id: 'any', label: 'Everything in the archive' },
    { id: 'scored', label: 'Scored' },
    { id: 'reviewed-unscored', label: 'Described · no score' },
    { id: 'awaiting-review', label: 'Not yet described' },
  ];

  const state = {
    view: 'foryou',
    q: '',
    sort: 'fit',
    scope: 'any',
    allScope: 'any',
    recommendedOnly: false,
    shortOnly: false,
    // The tag being followed, as its label. A tag is the same word wherever it
    // appears, so following one from a row in the feed and following it from a
    // card in the archive land on the same set.
    tag: null,
    // 'any', 'fiction' or 'nonfiction'. Separate from `scope`, which is about
    // how much is known about a book rather than what kind of book it is.
    kind: 'any',
    limit: ROW_PAGE,
    allLimit: CARD_PAGE,
    // The natural-language query, kept apart from `q`. They are different
    // questions: `q` narrows a list you are already looking at, `sq` asks the
    // archive one. Sharing a field would mean typing "funny books about work"
    // into the feed's filter and getting nothing, which is the wrong answer to
    // a good question.
    sq: '',
    searchLimit: SEARCH_PAGE,
    // What has actually been searched for, as against what is in the field. The
    // two differ while a keystroke is settling, and the results on screen belong
    // to the first of them.
    sqRun: '',
    searching: false,
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

  function setStatusCard() {
    const has = hasProfile();
    $('profile-rev').textContent = has ? String(FEED.profileRevision) : '—';
    $('profile-rev').parentElement.firstChild.textContent = has ? 'Profile v' : 'No profile yet';
    if (!has) $('profile-rev').textContent = '';
    $('threshold-line').textContent = has
      ? (FEED.recommendShare
        ? `Top ${Math.round(FEED.recommendShare * 100)}% is recommended`
        : `${threshold()}+ is recommended`)
      : `${FEED.books.length} books indexed`;
  }

  function loadPrefs() {
    const p = read(PREFS_KEY, {});
    // Neither `view` nor the two filters are restored, and for one reason: a
    // link to this app has to open the app. Somebody sent the address, or it was
    // tapped on a Home Screen, and what they get has to be the front of it —
    // not the Profile screen because that is where the last session happened to
    // end. The same goes for `tag` and `kind`: opening tomorrow inside a filter
    // set last week is an empty feed with no visible cause.
    //
    // What does persist is how a reader likes a list arranged — the sort and the
    // scope — because those describe a preference rather than a position.
    for (const k of ['sort', 'scope', 'allScope']) if (p[k]) state[k] = p[k];
    if (typeof p.recommendedOnly === 'boolean') state.recommendedOnly = p.recommendedOnly;
    if (typeof p.shortOnly === 'boolean') state.shortOnly = p.shortOnly;
    if (!VIEWS[state.view]) state.view = 'foryou';
  }
  function savePrefs() {
    // `view`, `tag` and `kind` are deliberately absent — see loadPrefs. Writing
    // them here and ignoring them there would be worse than not writing them:
    // the file would claim to remember something the app does not.
    write(PREFS_KEY, {
      sort: state.sort, scope: state.scope, allScope: state.allScope,
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

  // Where the number came from. A critic on a book they read, or the author on
  // their own book at length — the second is a real placement and it is not a
  // critical judgement, and the row is owed the difference.
  const readFrom = (e) => e.score?.readFrom
    || (e.reviewCount > 0 ? 'reviews' : e.describedOnly ? 'author-account' : 'none');
  const fromAuthor = (e) => readFrom(e) === 'author-account';

  const profileForOverrides = () => ({
    dimensions: FEED.dimensions,
    evidenceRule: FEED.evidenceRule,
    proseFloor: FEED.proseFloor,
    // The corpus middle a thin score is shrunk toward. Without it the browser
    // would reach a different number from the build the moment a reader touched
    // a weight — see web/lib/total.mjs.
    prior: FEED.prior,
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

  // Where a book sits in this corpus rather than against an absolute line.
  //
  // A weighted sum out of a hundred is only legible next to the field it came
  // from: 5.2 means nothing until you know that half the archive is under 2.5.
  // Recomputed whenever the reader's weights change, because that is exactly
  // when the field moves, and cached per render so a shelf of eighty cards does
  // not sort the archive eighty times.
  let percentiles = null;
  function rankAll() {
    const totals = FEED.books.filter(isScored).map((e) => scoreOf(e).total).sort((a, b) => a - b);
    percentiles = totals;
  }
  function percentileOf(e, s = scoreOf(e)) {
    if (!isScored(e) || !percentiles?.length) return null;
    let lo = 0, hi = percentiles.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (percentiles[mid] < s.total) lo = mid + 1; else hi = mid; }
    return Math.round(lo / percentiles.length * 100);
  }

  // Which single requirement is emptying the list.
  //
  // When a reader's profile surfaces almost nothing, the useful answer is not
  // "nothing matched" but "your prose weighting is the reason". So each
  // dimension is zeroed in turn and the top twenty recounted; the dimension
  // whose removal lets the most new books in is the one doing the excluding.
  // Brute force over eight dimensions and eight hundred books, which at this
  // size is a loop rather than an algorithm.
  // The answer only changes when the reader's weights do, and the Taste screen
  // re-renders on every save, filter and tag. Nine rescoring passes over every
  // scored book is 160ms at 823 books and 1.1s at the size the back catalogue is
  // heading for — paid on each of those renders, for a number that had not moved.
  // `profileVersion` already counts every change that could move it.
  let starving = { at: -1, value: null };
  function starvingDimension() {
    if (starving.at === profileVersion) return starving.value;
    const value = computeStarvingDimension();
    starving = { at: profileVersion, value };
    return value;
  }

  function computeStarvingDimension() {
    const books = FEED.books.filter(isScored);
    if (books.length < 20) return null;
    // The weight has to be zeroed in the overrides rather than in the profile:
    // rescore reads the reader's own weights last, so a change to the profile's
    // copy is shadowed by whatever they have set and the experiment measures
    // nothing. This cost an hour and would have shipped as a panel that never
    // appeared.
    const P = profileForOverrides();
    const topOf = (zeroed) => {
      const o = zeroed
        ? { ...overrides, weights: { ...overrides.weights, [zeroed]: 0 } }
        : overrides;
      return new Set(books
        .map((e) => ({ id: e.id, t: rescore(e.score, P, o).total }))
        .sort((a, b) => b.t - a.t).slice(0, 20).map((x) => x.id));
    };
    const base = topOf(null);
    let worst = null;
    for (const d of FEED.dimensions) {
      const without = topOf(d.id);
      const fresh = [...without].filter((id) => !base.has(id)).length;
      if (!worst || fresh > worst.fresh) worst = { name: d.name, id: d.id, fresh, weight: weightOf(d) };
    }
    return worst && worst.fresh >= 4 ? worst : null;
  }

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
    let fromReviews = 0;
    let fromAccount = 0;
    const cutoff = Date.now() - 30 * 86400000;
    // How far back the archive actually reaches, counted rather than declared.
    // The profile sets a five-year window and the app used to say the feed held
    // it; the feed held thirteen months. The back-catalogue crawl fills that in
    // over weeks, so this is the one honest way to say it — the sentence gets
    // truer on its own every morning and nobody has to remember to edit it.
    let earliest = Infinity;
    for (const e of books) {
      byStatus[scoreStatus(e)]++;
      if (scoreStatus(e) === 'scored') {
        if (readFrom(e) === 'author-account') fromAccount++; else fromReviews++;
      }
      for (const m of e.mentions) {
        const t = Date.parse(m.reviewDate || '') || 0;
        if (t >= cutoff) recentReviews++;
        if (t && t < earliest) earliest = t;
      }
    }
    stats = {
      total: books.length,
      scored: byStatus.scored,
      unscored: byStatus['reviewed-unscored'],
      awaiting: byStatus['awaiting-review'],
      placed: byStatus.scored + byStatus['reviewed-unscored'],
      fromReviews,
      fromAccount,
      recentReviews,
      reachesBack: Number.isFinite(earliest)
        ? new Date(earliest).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
        : null,
    };
  }

  // The day's edit: everything the profile can score, not already ruled on,
  // ranked by the live number. Ranked once per render rather than per section.
  function edit() {
    return FEED.books
      .filter((e) => isScored(e) && e.inWindow !== false && !passed(e))
      .filter(inFilters)
      .map((e) => ({ e, s: scoreOf(e) }))
      .sort((a, b) => b.s.total - a.s.total || reviewTime(b.e) - reviewTime(a.e));
  }

  // The one filter test the three ranked views share. For you had none of it:
  // a reader who set "fiction only" on the feed, went to the front page and
  // found nonfiction at the top had no way to tell whether the filter had failed
  // or the page simply did not have one.
  //
  // Scope is deliberately absent. It asks how much is known about a book, and
  // For you only ever holds scored books, so the control would be a menu whose
  // options do nothing.
  function inFilters(e) {
    if (state.shortOnly && !(e.book.pages && e.book.pages < 300)) return false;
    if (!isKind(e, state.kind)) return false;
    if (!hasTag(e, state.tag)) return false;
    return matches(e, state.q);
  }

  const reviewTime = (e) => Date.parse(e.lastReviewed || '') || 0;

  // Tags come from the review and from nothing else.
  //
  // The feed carries thirteen kinds and most of them are facts about our own
  // bookkeeping rather than about the book: `caveat` holds "thin evidence",
  // `rule` and `question` hold which of the profile's rules fired, `attention`
  // holds how many critics turned up, `imprint` and `press` hold the publisher.
  // `scale` is a page count wearing a word and `genre` is a catalogue subject.
  // None of them describes what a reader would find inside the book.
  //
  // These five do. Each is read out of review prose by keyword, so a tag on a
  // row is always something a critic wrote. A book whose review said nothing
  // categorisable shows no tags, which is the honest outcome: 90 of the 312
  // scored books, and most of the archive, where there is no review at all.
  const REVIEW_TAGS = new Set(['period', 'subject', 'form', 'prose', 'tone', 'narration']);

  // What the book is, which every book has and no review is needed for. The
  // classification is on all 811 records — 500 nonfiction, 180 confirmed
  // fiction, 14 likely, 117 nothing establishes either way — so this tag is
  // always there, and it leads. It is a fact about the book rather than about
  // our coverage, which is the line the caveat tags failed.
  const FORM = {
    confirmed: 'Fiction',
    likely: 'Fiction, probably',
    nonfiction: 'Nonfiction',
    unknown: 'Unclassified',
  };

  // The catalogue's own word, where it is narrower than fiction or nonfiction.
  const SPECIFIC = new Set(['Poetry', 'Comics', 'Mystery & thriller', 'SF, fantasy & horror', 'Religion']);

  // What a card carries: what kind of book it is first, because that is the thing
  // a reader sorts by at a glance, then whatever the reviews actually said about
  // it. A card showing only "Fiction, probably" was showing the one fact the
  // reader could already see from the cover.
  function cardTags(e) {
    const form = formTags(e);
    const seen = new Set(form.map((t) => t.label));
    const read = tagsFor(e).filter((t) => !seen.has(t.label) && REVIEW_TAGS.has(t.kind));
    return [...form, ...read].slice(0, 5);
  }

  function formTags(e) {
    const out = [{ kind: 'form', label: FORM[e.fiction] || FORM.unknown }];
    for (const t of e.tags || []) {
      if (t.kind === 'genre' && SPECIFIC.has(t.label)) out.push({ kind: 'form', label: t.label });
    }
    return out;
  }

  // The classification first, then whatever the review actually said.
  const tagsFor = (e) => [...formTags(e), ...(e.tags || []).filter((t) => REVIEW_TAGS.has(t.kind))];

  // Six of the eight dimensions read the review for what the book is like. The
  // other two read the catalogue: D6 is a page count and D7 is a publisher.
  //
  // A book where only those two fired has a score built from nothing a critic
  // wrote — 90 of the 312 scored books — and that is worth saying on the row
  // rather than leaving as a number with nothing behind it. It is a fact about
  // how far to trust the score, so it sits beside the score as a status, not in
  // the tags.
  const READ_DIMS = ['D1', 'D2', 'D3', 'D4', 'D5'];
  const readTheReview = (e) => READ_DIMS.some((id) => e.score?.dimensions?.[id] && !e.score.dimensions[id].defaulted);

  // What today's shortlist leans toward, counted rather than asserted: the tags
  // that recur most across the books at the top of the edit.
  function leanCounts(ranked, n = 4) {
    const pool = ranked.slice(0, 40);
    const counts = new Map();
    for (const { e } of pool) {
      for (const t of e.tags || []) {
        if (!REVIEW_TAGS.has(t.kind)) continue;
        const row = counts.get(t.id) || { label: t.label, kind: t.kind, n: 0 };
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
  // Which tag kind each dimension files its band under. One to one, which is
  // what lets a band the reader picked during onboarding be found again as a tag
  // on a book.
  const KIND_OF_DIM = {
    D1: 'period', D2: 'subject', D3: 'form', D4: 'prose',
    D5: 'tone', D6: 'scale', D7: 'press', D8: 'narration',
  };

  // Why this book is where it is, named as things the reader did.
  //
  // This line used to be six templated sentences chosen by a hash of the book's
  // id — "Strong on subject, and structure does not let it down", "Subject
  // carries it; structure holds the rest up" — which is generated variety
  // standing in for an explanation. Every one of them named a dimension the
  // reader never chose, in a grammar that sounded like a judgement and carried
  // none.
  //
  // It names tags now, and the verb says where they came from: what the reader
  // saved, what they passed on, or what they picked when they built the profile.
  // All three are things the reader did and can check, and the tags are the same
  // words on the chips directly below the line.
  function whyTags(e, s) {
    const own = e.tags || [];

    // Their own verdicts first, where any of them bear on this book.
    if (taste?.ready) {
      const rows = own.map((t) => ({ t, row: taste.tags.get(t.id) })).filter((x) => x.row);
      const up = rows.filter((x) => x.row.weight > 0.15).sort((a, b) => b.row.weight - a.row.weight);
      const down = rows.filter((x) => x.row.weight < -0.15).sort((a, b) => a.row.weight - b.row.weight);
      // A book can carry both. The one that actually moved it is the one named.
      if (up.length && ((s?.delta ?? 0) >= 0 || !down.length)) return { verb: 'saved', labels: up.map((x) => x.t.label) };
      if (down.length) return { verb: 'passed on', labels: down.map((x) => x.t.label) };
    }

    // Otherwise the profile itself, which was built from bands they picked.
    const picked = [];
    for (const [dim, d] of Object.entries(e.score?.dimensions || {})) {
      if (d.defaulted || !d.id) continue;
      if (!(answers.liked || []).includes(`${dim}:${d.id}`)) continue;
      const tag = own.find((t) => t.kind === KIND_OF_DIM[dim]);
      if (tag) picked.push(tag.label);
    }
    if (picked.length) return { verb: 'picked', labels: picked };
    return null;
  }

  // The tags in the sentence are the tags on the row, so they are the same
  // control: following one filters to it. A line that names the reason a book is
  // here and then makes the reader find that word again in the chips below is
  // asking them to do the app's work.
  function whyTagButton(label) {
    return `<button class="tag-inline" data-action="tag" data-tag="${esc(label)}"
      aria-label="Show other books tagged ${esc(label)}">${esc(label)}</button>`;
  }

  function whyHtml(e, s, max = 3) {
    const why = whyTags(e, s);
    if (!why) return null;
    return `Because you ${esc(why.verb)}: ${why.labels.slice(0, max).map(whyTagButton).join(', ')}`;
  }

  function whyLine(e, s) {
    const why = whyTags(e, s);
    if (!why) return null;
    return `Because you ${why.verb}: ${why.labels.slice(0, 3).join(', ')}`;
  }

  // What can honestly be said about a book to someone the app knows nothing
  // about: where it came from and when. A fact about the book rather than a
  // claim about the reader.
  function sourceLine(e) {
    const who = e.reviewCount > 0
      ? `Reviewed by ${e.sources[0] || 'the press'}`
      : fromAuthor(e) ? 'The author’s own account of it'
      : `Listed by ${e.book.publisher || 'its publisher'}`;
    const when = e.book.bookYear ? `, ${e.book.bookYear}` : '';
    return `${who}${when}.`;
  }

  // The one mention a row should point at: the newest thing that is actually a
  // review, where the book has one. `critical` comes from the build, which marks
  // a publisher's catalogue and an author interview false, and mentions arrive
  // newest first. A feed built before that flag shipped carries no `critical` on
  // its mentions at all, so an absent flag reads as a review — on the current
  // archive that is right for all 410 reviewed books, none of which lead with a
  // podcast.
  function citedMention(e) {
    const ms = (e.mentions || []).filter((m) => m.reviewUrl);
    if (!ms.length) return null;
    return ms.find((m) => m.critical !== false) || ms[0];
  }

  // Who said it, on the row rather than only inside the dossier. The publication
  // was already on the card — first in the meta line, 8.5px grey mono between a
  // date and a page count — and it was not being read there. Someone looking at a
  // list of new reviews should see that the New York Times is the one reviewing,
  // and be able to go and read it, without opening anything first.
  function rowSource(e) {
    const m = citedMention(e);
    if (!m) return '';
    const review = readFrom(e) === 'reviews';
    const lead = review ? 'Reviewed in' : fromAuthor(e) ? 'The author’s own account, at' : 'Listed by';
    const others = review && e.reviewCount > 1 ? e.reviewCount - 1 : 0;
    return `<a class="row-source" href="${esc(m.reviewUrl)}" target="_blank" rel="noopener noreferrer"
      data-action="review" data-id="${esc(e.id)}" data-source="${esc(m.source.id)}"
      aria-label="${esc(`${lead} ${m.source.name}. Opens the ${review ? 'review' : 'source'} in a new tab.`)}">
      <span>${lead} <b>${esc(m.source.name)}</b>${others ? `, and ${others} more` : ''}</span>
      <span class="row-source-go" aria-hidden="true">↗</span>
    </a>`;
  }

  // Every row says what the book is, whoever is looking. 27 of the 785 books have
  // no standfirst anywhere in their mentions — a catalogue listing with a title,
  // a press and a page count and nothing written about it yet — and those rows
  // were printing a title and then nothing, which reads as a broken card rather
  // than as a book nobody has described. This is the sentence they get instead:
  // provenance and date, which is what is actually known.
  function describeBook(e, max = 190) {
    const blurb = blurbOf(e, max);
    if (blurb) return blurb;
    const facts = [
      e.book.publisher || null,
      e.book.bookYear ? String(e.book.bookYear) : null,
      e.book.pages ? `${e.book.pages} pages` : null,
    ].filter(Boolean).join(' · ');
    const nobody = e.reviewCount > 0
      ? 'The reviews of it are indexed here without a summary.'
      : 'Nobody has described it yet — not a critic, and not the author.';
    return facts ? `${facts}. ${nobody}` : nobody;
  }

  function matchLine(e, s) {
    if (!isScored(e)) {
      return scoreStatus(e) === 'reviewed-unscored'
        ? 'Described, but the evidence was too thin for a reliable number.'
        : 'A catalogue listing and nothing more. Nobody has described it yet.';
    }
    if (!readTheReview(e)) return `Ranked on its length and its publisher; ${e.reviewCount > 0 ? 'the review' : 'the description'} said nothing the profile could read.`;
    const why = whyLine(e, s);
    if (why) return why;
    const fired = firedDims(e);
    if (!fired.length) return 'Scored on the little the review gave, so treat the number lightly.';
    // Nothing the reader has said bears on this book. Naming what it was read on
    // is the most that can honestly be claimed.
    return `Read on ${fired.slice(0, 2).map((d) => lower(d.name)).join(' and ')}, none of which you have ruled on.`;
  }

  // The dossier's fuller version of the same argument.
  function caseFor(e, s) {
    if (!isScored(e)) return matchLine(e, s);
    if (!readTheReview(e)) return `There is no case yet. ${e.reviewCount > 0 ? 'The review' : 'The description'} said nothing the profile could read.`;
    const why = whyTags(e, s);
    if (why) return `Because you ${why.verb}: ${why.labels.slice(0, 4).join(', ')}`;
    const fired = firedDims(e);
    const names = fired.slice(0, 3).map((d) => lower(d.name));
    if (!names.length) return 'Too little of this review spoke to the profile for a confident argument.';
    const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
    return `Read on ${list}, none of which you have ruled on.`;
  }

  // Two texts are the same text for this purpose when they differ only by the
  // trimming one of them has had: blurbOf runs cleanBlurb over it and cuts it at
  // a word boundary with an ellipsis, so a string compare would call them
  // different and print both.
  const normalizeQuote = (t) => String(t || '')
    .replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"')
    .replace(/[^a-z0-9]+/gi, ' ').trim().toLowerCase().slice(0, 120);

  // The best of the texts on the record, rather than the first one that is not
  // empty. Two things were wrong with taking the first. A few publications
  // syndicate their own page furniture inside the description field, so the row
  // printed a section label, a redacted address and a timestamp. And 588 of the
  // books carry a publisher's description that was never displayed at all, so a
  // book whose only standfirst was a masthead said "the reviews of it are
  // indexed here without a summary" with a good paragraph sitting unused.
  //
  // The critic still wins wherever the critic wrote a sentence. Publisher copy
  // is written to sell and reads like it, so it is the fallback rather than the
  // preference — and it stays out of the scoring entirely, which is the line
  // that matters.
  const blurbOf = (e, max = 320) => bestBlurb(e, { max }).text;

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

  // Every jacket says how wide it is about to be drawn, because both cover hosts
  // serve a thumbnail unless asked otherwise and neither was being asked. The
  // archive card draws at 222 CSS pixels — 444 on a retina screen — and was
  // being handed Google's 128px default. Nothing errored; it just looked soft.
  function jacket(e, slot = 'card') {
    // A cover the host will not render large enough for this slot is drawn
    // instead of stretched. 209 of the 823 jackets in the archive are under
    // 500px, which is fine in a 60px row and visibly soft across a card.
    if (!e.book.coverUrl || !fillsSlot(e.book.coverWidth, slot)) {
      return `<div class="jacket">${drawnJacket(e)}</div>`;
    }
    const c = coverFor(e.book.coverUrl, slot);
    if (!c) return `<div class="jacket">${drawnJacket(e)}</div>`;
    return `<div class="jacket" data-jacket="${esc(e.id)}">
      <img src="${esc(c.src)}"${c.srcset ? ` srcset="${esc(c.srcset)}" sizes="${esc(c.sizes)}"` : ''}
        alt="" loading="lazy" decoding="async">
    </div>`;
  }

  // One observer for the whole app: it arms a cover's timeout at the moment the
  // browser decides to fetch it, which is the only moment a stopwatch on that
  // fetch means anything. `rootMargin` matches roughly what the lazy loader
  // itself uses, so the timer starts with the request rather than after it.
  const coverWatch = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((entries, obs) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        en.target.__armCover?.();
        obs.unobserve(en.target);
      }
    }, { rootMargin: '400px' })
    : null;

  function bindJackets(root) {
    const observer = coverWatch;
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
      //
      // The clock starts when the browser starts fetching, and not before. These
      // images are `loading="lazy"`, so one below the fold is not requested at
      // all until it is scrolled near — and a timer armed at render was counting
      // that deliberate wait as a failure. Ten seconds after any page load, seven
      // of the eight covers on the front page were being thrown away and replaced
      // with drawn jackets, for hosts that were answering in 300ms. Nothing
      // errored, and it read as an app that simply had no cover art.
      let timer = null;
      const arm = () => {
        if (timer || img.complete) return;
        timer = setTimeout(() => { if (!img.complete || !img.naturalWidth) swap(img); }, 10000);
      };
      const done = () => { clearTimeout(timer); observer?.unobserve(img); };
      img.addEventListener('load', done, { once: true });
      if (observer) observer.observe(img); else arm();
      img.__armCover = arm;
    }
  }

  // ------------------------------------------------------------ filtering

  // Fiction, nonfiction, or no opinion. `likely` counts as fiction: the label on
  // the card already says "Fiction, probably", and a reader who filters to
  // fiction wants those rather than a shorter list and no explanation.
  function isKind(e, kind) {
    if (kind === 'any') return true;
    if (kind === 'fiction') return e.fiction === 'confirmed' || e.fiction === 'likely';
    return e.fiction === 'nonfiction';
  }

  // Tags are matched by label rather than by kind and label together, because a
  // reader following "land & labour" means the words, not the dimension they
  // happen to hang off.
  const hasTag = (e, tag) => !tag || tagsFor(e).some((t) => t.label === tag);

  function matches(e, q) {
    if (!q) return true;
    const hay = [e.book.title, e.book.author, e.book.publisher,
      ...e.mentions.flatMap((m) => [m.reviewTitle, m.byline, m.source.name])]
      .filter(Boolean).join(' ').toLowerCase();
    return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
  }

  function sortPool(pool, sort) {
    const rows = pool.slice();
    // Without a profile there is no fit to sort by, and falling back to it
    // silently would order a stranger's first screen by a stranger's taste. The
    // neutral answer to "what is here" is what arrived most recently.
    if (!hasProfile() && (!sort || sort === 'fit')) sort = 'latest';
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

  // A pass on the card, because the front page was the one place a book could be
  // recommended and not refused. The feed row and the dossier have had this the
  // whole time; For you is where a reader actually meets the recommendation, so
  // it is where a disagreement with it is worth the most.
  // Pass is a toggle — setVerdict clears a verdict that is set again — and this
  // button shipped without saying so. All books keeps passed books on purpose,
  // being a record rather than an opinion, so a reader who pressed × on one
  // already passed silently un-passed it and the book came back to the feed with
  // nothing on screen having changed. The state has to be visible for the second
  // press to mean what it does.
  function passBtn(e) {
    const on = passed(e);
    return `<button class="card-bookmark card-pass" data-action="pass" data-id="${esc(e.id)}"
      aria-pressed="${on}"
      aria-label="${on ? `Passed on ${esc(e.book.title)}. Put it back in the feed` : `Pass on ${esc(e.book.title)} and stop showing it`}"
      >${ico(on ? 'undo' : 'close')}</button>`;
  }

  function scoreBadge(e, s) {
    // A number on a cover is the strongest claim the interface makes. It is a
    // fit score, so before there is anyone to fit it is simply absent — not
    // zero, not a placeholder digit.
    if (!hasProfile()) return '';
    const status = scoreStatus(e);
    if (status === 'scored') return `<span class="card-score">${shownScore(e, s).toFixed(1)}</span>`;
    return `<span class="card-score" data-state="none">${status === 'reviewed-unscored' ? 'No score' : 'Not described'}</span>`;
  }

  function card(row, i) {
    const { e, s } = row;
    const status = scoreStatus(e);
    return `<article class="card" data-family="${i % 4}" data-id="${esc(e.id)}"
      data-action="open" role="button" tabindex="0" aria-label="Open the dossier for ${esc(e.book.title)}">
      <button class="card-cover" data-action="open" data-id="${esc(e.id)}"
        aria-label="Open the dossier for ${esc(e.book.title)}">
        ${jacket(e, 'card')}
        ${scoreBadge(e, s)}
        <span class="card-peek" aria-hidden="true">${ico('arrow')}View dossier</span>
      </button>
      <div class="card-body">
        <p class="card-source">${esc(status === 'awaiting-review' && !e.sources.length ? (e.book.publisher || 'Catalogue listing') : e.sources.join(' · '))}</p>
        <button class="card-title" data-action="open" data-id="${esc(e.id)}">${esc(e.book.title)}</button>
        ${e.book.author ? `<p class="card-author">${esc(e.book.author)}</p>` : ''}
        <p class="card-blurb">${esc(describeBook(e, 150))}</p>
        <div class="tags card-tags">${cardTags(e).map((t) =>
          `<button class="tag" data-action="tag" data-tag="${esc(t.label)}" data-kind="${esc(t.kind)}"
            aria-label="Show other books tagged ${esc(t.label)}">${esc(t.label)}</button>`).join('')}</div>
        <p class="card-why">${ico('sparkles')}<span>${
          hasProfile() ? (whyHtml(e, s) || esc(matchLine(e, s))) : esc(sourceLine(e))}</span></p>
      </div>
      <div class="card-foot">${passBtn(e)}${bookmarkBtn(e)}</div>
    </article>`;
  }

  function shelf(rows) {
    return `<div class="shelf">${rows.map(card).join('')}</div>`;
  }

  function feedRow(row, i) {
    const { e, s, note, hit } = row;
    const b = e.book;
    const status = scoreStatus(e);
    const scored = status === 'scored';
    const rec = recommendedNow(e, s);

    // The publication moved out of this line and into the credit link below the
    // title, where it can be read and followed. It comes back here only on the
    // handful of rows that have no linkable mention at all.
    const src = rowSource(e);

    const meta = [
      src ? null : e.sources.join(' · '),
      e.reviewCount > 0 ? `reviewed ${fmtDate(e.lastReviewed)}`
        : fromAuthor(e) ? `author’s account, ${fmtDate(e.lastReviewed)}`
        : `listed ${fmtDate(e.lastReviewed)}`,
      b.editionDate || b.bookYear || null,
      b.pages ? `${b.pages} pp.` : null,
    ].filter(Boolean).join(' · ');

    // Always at least one: tagsFor leads with the fiction/nonfiction label, which
    // every book has whether or not anything else fired.
    //
    // In a search result the tags the query matched come first and are marked.
    // They used to be listed again on a line of their own above a different four
    // tags, and two unlabelled lists side by side read as a contradiction rather
    // than as an explanation.
    const all = tagsFor(e);
    const tags = hit?.size
      ? [...all.filter((t) => hit.has(t.label)), ...all.filter((t) => !hit.has(t.label))].slice(0, 5)
      : all.slice(0, 4);

    // The whole row opens the book. Tapping a card and having nothing happen is
    // the commonest way this app gets reported broken: the title and the cover
    // were buttons and the other eighty per cent of the row was not, which on a
    // phone is most of what a thumb lands on. The controls inside it still win,
    // because the handler takes the nearest [data-action] and theirs is nearer.
    return `<li><article class="feed-row" data-family="${i % 4}" data-id="${esc(e.id)}"
      data-action="open" role="button" tabindex="0" aria-label="Open the dossier for ${esc(b.title)}">
      <span class="row-cover">${jacket(e, 'row')}</span>
      <div class="row-score">
        ${!hasProfile()
          ? `<span class="row-num" data-state="none">Not scored yet</span>`
          : scored
          ? `<span class="row-num">${shownScore(e, s).toFixed(1)}<small>/ 10</small></span>`
          : `<span class="row-num" data-state="none">No score</span>`}
        ${hasProfile() && scored && rec ? `<span class="row-rec">${ico('sparkles')}Recommended</span>` : ''}
        ${hasProfile() && scored && !readTheReview(e) ? `<span class="row-rec" data-state="thin">Length and press only</span>`
          : hasProfile() && scored && fromAuthor(e) ? `<span class="row-rec" data-state="thin">From the author’s account</span>` : ''}
        ${hasProfile() && status === 'reviewed-unscored' ? `<span class="row-rec" data-state="thin">Evidence too thin</span>` : ''}
        ${status === 'awaiting-review' ? `<span class="row-rec" data-state="thin">Not yet described</span>` : ''}
      </div>
      <div class="row-main">
        <h3 class="row-title">${esc(b.title)}${
          b.author ? `<span class="row-author">${esc(b.author)}</span>` : ''}</h3>
        ${src}
        <p class="row-meta">${esc(meta)}</p>
        <p class="row-blurb">${esc(describeBook(e, 190))}</p>
        ${!scored && hasProfile() ? `<p class="row-note">${esc(status === 'reviewed-unscored'
          ? 'Something has been written about this book, but it did not supply enough dependable evidence across the eight dimensions for a number to mean anything.'
          : 'Known from a catalogue listing alone.')}</p>` : ''}
        ${note ? `<p class="row-match">${ico('search')}<span>${esc(note)}</span></p>` : ''}
        ${tags.length ? `<div class="tags">${tags.map((t) => `<button class="tag" data-action="tag" data-tag="${esc(t.label)}" data-kind="${esc(t.kind)}"
          ${hit?.has(t.label) ? 'data-hit="true" ' : ''}aria-label="${hit?.has(t.label) ? `${esc(t.label)}, which your search asked for. ` : ''}Show other books tagged ${esc(t.label)}">${esc(t.label)}</button>`).join('')}</div>` : ''}
        <button class="row-why" data-action="open" data-id="${esc(e.id)}">${ico('sparkles')}${
          !hasProfile() ? 'What this book is'
          : scored ? `Why it’s a ${shownScore(e, s).toFixed(1)}` : 'Why there’s no score'}${ico('arrow')}</button>
      </div>
      <div class="row-actions">
        ${saveBtn(e, { block: true })}
        <button class="btn btn-quiet" data-action="pass" data-id="${esc(e.id)}"
          aria-pressed="${passed(e)}">${passed(e) ? 'Passed' : 'Pass'}</button>
      </div>
    </article></li>`;
  }

  // What a personalised screen says before there is anyone to personalise it
  // for: what it becomes, in the specific rather than the abstract, and the one
  // action that gets there. No borrowed numbers, no sample of somebody else's
  // shelf dressed up as a preview.
  function blankSlate({ eyebrow, title, lede, becomes }) {
    return `
      ${viewHead({ eyebrow, title, lede })}
      <section class="panel blank-slate" aria-labelledby="bs-h">
        <p class="eyebrow">Not built yet</p>
        <h2 id="bs-h">Once you have answered, this page holds:</h2>
        <ul class="blank-list">${becomes.map((b) => `<li>${b}</li>`).join('')}</ul>
        <div class="blank-acts">
          <button class="btn btn-solid" data-action="go" data-view="start">Build your taste profile ${ico('arrow')}</button>
          <button class="btn" data-auth><span>Sign in</span></button>
        </div>
        <p class="privacy blank-note">Two minutes, and it stays in this browser unless you sign in. ${
          FEED.books.length} books are already here to browse under All books — those are a record of what the press reviewed, not an opinion about you.</p>
      </section>`;
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

  // Shown while a tag is being followed, and it has two jobs: say what is being
  // filtered, since a feed that suddenly holds nine books needs to explain
  // itself, and offer the way out of the reader's own opinion. Following a tag
  // in My feed shows the books this profile likes; a reader chasing a subject
  // usually wants everything written about it, including what the profile scored
  // badly, so the archive is one tap away and says how many more are in it.
  function tagBanner(shownHere) {
    if (!state.tag) return '';
    const inArchive = FEED.books.filter((e) => hasTag(e, state.tag) && isKind(e, state.kind)).length;
    const elsewhere = Math.max(0, inArchive - shownHere);
    return `<div class="tag-banner" role="status">
      <div class="tag-banner-main">
        <p class="eyebrow">Following a tag</p>
        <h2>${esc(state.tag)}</h2>
        <p class="tag-banner-count">${shownHere} ${shownHere === 1 ? 'book' : 'books'} here${
          state.view !== 'all' && elsewhere ? ` · ${elsewhere} more in the archive the profile scores lower` : ''}</p>
      </div>
      <div class="tag-banner-acts">
        ${state.view !== 'all'
          ? `<button class="btn" data-action="tag-all">See every book tagged this ${ico('arrow')}</button>`
          : ''}
        <button class="btn btn-quiet" data-action="clear-tag">Clear</button>
      </div>
    </div>`;
  }

  // Above the two browsable lists, before there is a profile. It is doing one
  // job: making sure nobody reads this order as a recommendation. The archive is
  // worth browsing on its own — that is why the lists are not gated — but the
  // ordering is chronological and says so rather than letting a reader assume
  // the top of the page means anything.
  function unrankedNote() {
    if (hasProfile()) return '';
    return `<div class="unranked" role="status">
      <div>
        <p class="eyebrow">Newest first</p>
        <p class="unranked-text">These are in the order the press reviewed them. Nothing here is ranked for you and no book carries a score, because a score in this app measures fit with a particular reader and there is not one yet.</p>
      </div>
      <button class="btn btn-solid" data-action="go" data-view="start">Build your taste profile ${ico('arrow')}</button>
    </div>`;
  }

  // One toolbar, three views, and the parts a view cannot honour are left out
  // rather than shown doing nothing. For you passes no scopes, because scope
  // asks how much is known about a book and that page only ever holds scored
  // ones; it passes showSort false, because its order is the edit it is making.
  function toolbar({ scopes, scope, showRecommended = true, showSort = true }) {
    const effective = (!hasProfile() && state.sort === 'fit') ? 'latest' : state.sort;
    const sortLabel = SORTS.find((x) => x.id === effective)?.label || 'Newest reviews';
    return `<div class="toolbar" data-toolbar data-nosort="${!showSort}">
      <div class="search">
        ${ico('search')}
        <label class="sr-only" for="q">Search books</label>
        <input type="search" id="q" value="${esc(state.q)}" placeholder="Title, author, publisher, critic…" autocomplete="off">
      </div>
      <div class="tool-pair">
        ${showSort ? `<button class="tool-btn" data-action="menu" data-menu="sort" aria-haspopup="true" aria-expanded="${state.openMenu === 'sort'}">
          <span>${esc(sortLabel)}</span>${ico('chevron')}
        </button>` : ''}
        <button class="tool-btn" data-action="menu" data-menu="filter" aria-haspopup="true" aria-expanded="${state.openMenu === 'filter'}">
          ${ico('sliders')}<span>Filters</span>${activeFilters() ? `<em class="tool-count">${activeFilters()}</em>` : ''}
        </button>
      </div>
      ${showSort && state.openMenu === 'sort' ? sortMenu() : ''}
      ${state.openMenu === 'filter' ? filterMenu(scopes, scope, showRecommended) : ''}
    </div>`;
  }

  // How many filters are on. Without it a reader who set one on another screen
  // arrives at a short list with the reason folded inside a closed menu.
  function activeFilters() {
    return (state.kind !== 'any' ? 1 : 0) + (state.shortOnly ? 1 : 0)
      + (state.recommendedOnly ? 1 : 0) + (state.tag ? 1 : 0);
  }

  function sortMenu() {
    return `<div class="menu-pop" role="menu" data-pop>
      <span class="label">Order</span>
      ${SORTS.filter((o) => o.id !== 'fit' || hasProfile()).map((o) => `<button class="menu-opt" role="menuitemradio"
        aria-checked="${state.sort === o.id || (!hasProfile() && state.sort === 'fit' && o.id === 'latest')}"
        data-action="sort" data-value="${o.id}">${ico('check')}<span>${esc(o.label)}</span></button>`).join('')}
    </div>`;
  }

  function filterMenu(scopes, scope, showRecommended) {
    return `<div class="menu-pop" role="menu" data-pop>
      <div class="menu-pop-group">
        ${showRecommended && hasProfile() ? `<button class="menu-opt" role="menuitemcheckbox" aria-checked="${state.recommendedOnly}"
          data-action="toggle" data-value="recommendedOnly">${ico('check')}<span>Recommended only (${threshold()}+)</span></button>` : ''}
        <button class="menu-opt" role="menuitemcheckbox" aria-checked="${state.shortOnly}"
          data-action="toggle" data-value="shortOnly">${ico('check')}<span>Under 300 pages</span></button>
      </div>
      <div class="menu-pop-group">
        <span class="label">Fiction or nonfiction</span>
        ${KINDS.map((o) => `<button class="menu-opt" role="menuitemradio" aria-checked="${state.kind === o.id}"
          data-action="kind" data-value="${o.id}">${ico('check')}<span>${esc(o.label)}</span></button>`).join('')}
      </div>
      ${scopes ? `<div class="menu-pop-group">
        <span class="label">Which books</span>
        ${scopes.map((o) => `<button class="menu-opt" role="menuitemradio" aria-checked="${scope === o.id}"
          data-action="scope" data-value="${o.id}">${ico('check')}<span>${esc(o.label)}</span></button>`).join('')}
        <p class="menu-pop-note">Score ranges apply only to scored books. Missing scores are never treated as zero.</p>
      </div>` : ''}
    </div>`;
  }

  // More rows, without a button to press.
  //
  // The button is still here and still does the work. An observer presses it
  // when it scrolls into view, which is what makes the list infinite; keeping a
  // real control rather than a bare sentinel is what keeps it reachable by
  // keyboard and announceable by a screen reader, both of which an infinite list
  // otherwise strands. It is only hidden once the observer is known to exist.
  function moreBtn(shown, total, action) {
    if (shown >= total) return '';
    const left = total - shown;
    return `<button class="btn btn-block js-more" data-action="${action}" data-auto="${Boolean(moreWatch)}">
      Show ${Math.min(action === 'more-cards' ? CARD_PAGE : action === 'more-search' ? SEARCH_PAGE : ROW_PAGE, left)} more of ${left}</button>`;
  }

  // What presses it: how near the bottom the reader is, checked on scroll.
  //
  // An IntersectionObserver on the button is the tidier version and it was the
  // first one written. It is also the one that can silently never fire — a zero
  // height viewport is enough, and a hidden button that is never pressed leaves
  // a reader at the end of fourteen rows with no way to ask for more, which is
  // worse than the button they started with. A scroll position cannot fail to
  // be a number.
  //
  // 600px of lead, so the next page is there before the reader arrives at it.
  const MORE_LEAD = 600;
  const moreWatch = true;
  let morePending = false;

  function checkMore() {
    morePending = false;
    const btn = document.querySelector('.js-more');
    if (!btn || btn.dataset.spent === 'true') return;
    const el = document.scrollingElement || document.documentElement;
    const left = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (left > MORE_LEAD) return;
    // Spent before the click, because the click re-renders and the button this
    // handler is holding is gone by the time the next scroll event arrives.
    btn.dataset.spent = 'true';
    btn.click();
  }

  // Throttled on a clock rather than on a frame. `requestAnimationFrame` does
  // not run in a backgrounded or zero-height tab, and a reader who switches away
  // mid-scroll and back should not find a list that has stopped growing. Two
  // reads of scrollTop are cheap enough that 80ms is generous.
  let moreCheckedAt = 0;
  const queueMore = () => {
    const now = performance.now();
    if (morePending || now - moreCheckedAt < 80) return;
    morePending = true;
    moreCheckedAt = now;
    setTimeout(checkMore, 0);
  };

  function bindMore() {
    // A list can also start shorter than the viewport, in which case there is no
    // scroll to wait for and the next page is due immediately.
    queueMore();
  }

  // ------------------------------------------------------------ For you

  // The one book the model cannot place, held until the model changes.
  //
  // Redrawing it on every render would be churn — the page re-renders on every
  // save, filter and tag — and the point of the slot is to get a verdict on one
  // book rather than to keep offering different ones. It changes when the model
  // does, which is also exactly when the answer to "what does it not know" moves.
  let reserve = { at: -2, value: null };
  function reserveBook(shown) {
    if (!taste?.ready) return null;
    if (reserve.at === profileVersion) {
      // Still held, unless the reader has since ruled on it or filtered it out.
      const v = reserve.value;
      if (!v) return null;
      if (saved.verdictOf(verdicts, v.entry.id) || !inFilters(v.entry)) { reserve = { at: -2, value: null }; }
      else return v;
    }
    const onScreen = new Set(shown);
    const eligible = FEED.books.filter((e) => isScored(e)
      && !saved.verdictOf(verdicts, e.id)
      && !onScreen.has(e.id)
      && inFilters(e));
    reserve = { at: profileVersion, value: explore(eligible, taste) };
    return reserve.value;
  }

  // The section itself. It says what it is before it says what the book is,
  // because a shelf called "for you" that quietly includes something the model
  // does not believe in would be lying by omission — and because the reason it
  // is here is the reason to rule on it.
  function reserveSection(shownIds) {
    const pick = reserveBook(shownIds);
    if (!pick) return '';
    const names = pick.tags.slice(0, 2).map((t) => t.label);
    const rest = pick.tags.length - names.length;
    const which = names.length === 1
      ? `tagged ${names[0]}`
      : `tagged ${names[0]} or ${names[1]}`;
    const others = rest > 0 ? `, or ${rest} other${rest === 1 ? '' : 's'} this one carries` : '';
    return `
      <section class="reserve" aria-labelledby="res-h">
        <div class="section-head">
          <div>
            <p class="eyebrow">Held back on purpose</p>
            <h2 id="res-h">One it cannot place</h2>
          </div>
          <span class="label">Save or pass either way</span>
        </div>
        <p class="reserve-note">You have never saved or passed a book ${esc(which)}${esc(others)}, so nothing above was chosen with them in mind. A verdict here is worth more than one on a book the model has already made up its mind about.</p>
        <ul class="rows">${feedRow({ e: pick.entry, s: scoreOf(pick.entry) }, 0)}</ul>
      </section>`;
  }

  // The week's pick, and it holds for the week.
  //
  // Not the best book in the archive, which is what the spotlight used to be and
  // why the page looked identical every morning: that only changes when
  // something outscores it. This is the best of what arrived this week, anchored
  // to Monday so it is the same book on Friday as it was on Tuesday.
  let weekPick = { at: -1, value: null };
  function pickOfWeek() {
    const from = weekStart();
    if (weekPick.at === from + profileVersion) return weekPick.value;
    const fresh = FEED.books
      .filter((e) => isScored(e) && !passed(e) && (Date.parse(e.firstReviewed || '') || 0) >= from)
      .map((e) => ({ e, s: scoreOf(e) }));
    const sorted = hasProfile()
      ? fresh.sort((a, b) => b.s.total - a.s.total)
      : fresh.sort((a, b) => reviewTime(b.e) - reviewTime(a.e));
    weekPick = { at: from + profileVersion, value: sorted[0] || null };
    return weekPick.value;
  }

  // What the press has written since the reader was last here.
  //
  // `lastReviewed` rather than `firstReviewed`: a book reviewed a month ago that
  // got a second review last night is news too, and the second review is often
  // the more interesting one.
  function sinceLastVisit() {
    const rows = FEED.books
      .filter((e) => isScored(e) && !passed(e) && inFilters(e)
        && (Date.parse(e.lastReviewed || '') || 0) >= sinceCutoff)
      .map((e) => ({ e, s: scoreOf(e) }));
    const byFit = (a, b) => (hasProfile() ? b.s.total - a.s.total : reviewTime(b.e) - reviewTime(a.e));

    // Critics first, and the author's own account after them.
    //
    // These are different classes of text and lib/sources.mjs is explicit about
    // it: a critic on a book they have read is the only text allowed to say
    // whether it is any good, while an author describing their own book says
    // what it is about and cannot say that. Ordering the two together by fit
    // buried the New York Times under a podcast interview, because the interview
    // happened to score higher. Measured over two days of arrivals: 9 reviews
    // against 12 author accounts, so this is most of what lands.
    //
    // Nothing is hidden — the author accounts follow, and every row already says
    // which it is.
    const reviewed = rows.filter((r) => readFrom(r.e) === 'reviews').sort(byFit);
    const described = rows.filter((r) => readFrom(r.e) !== 'reviews').sort(byFit);
    return [...reviewed, ...described];
  }

  // How long ago that was, in the words a reader would use.
  // The critic rows were already first and nothing on the page said so. A note
  // under one heading was doing that job and it was the wrong instrument: the two
  // halves of the list are different kinds of evidence, so they get the same
  // treatment as every other break on this page — an eyebrow, a heading of their
  // own, and a line saying what the group is.
  function freshHead(kind, n, withLink) {
    const review = kind === 'reviews';
    const eyebrow = review
      ? (sinceLabel() === 'today' ? 'Filed today by the critics' : `Reviewed ${sinceLabel()}`)
      : 'No critic yet';
    const heading = review
      ? (hasProfile() ? 'New reviews, ranked for you' : 'New reviews')
      : 'Described by their authors';
    const note = review
      ? `${n === 1 ? 'One book' : `${n} books`} the press has just reviewed. Every one links straight out to the review it came from.`
      : 'Nobody has reviewed these. What is known comes from the author on their own book, which says what it is about and cannot say whether it is any good.';
    return `<div class="section-head">
      <div>
        <p class="eyebrow">${esc(eyebrow)}</p>
        <h2 id="fresh-h${review ? '' : '-a'}">${esc(heading)}</h2>
        <p class="section-note">${esc(note)}</p>
      </div>
      ${withLink ? `<button class="section-head-link" data-action="go" data-view="feed">See the full feed ${ico('arrow')}</button>` : ''}
    </div>`;
  }

  function sinceLabel() {
    const days = Math.round((Date.now() - sinceCutoff) / 86400000);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 7) return `in the last ${days} days`;
    if (days < 10) return 'this week';
    return `in the last ${Math.round(days / 7)} weeks`;
  }

  // The week's pick, small and stuck under the header rather than filling the
  // top of every visit. It is the one thing on the page that should not change
  // between Tuesday and Friday, so it is also the one thing that does not need
  // the room.
  function weekStrip() {
    const pick = pickOfWeek();
    if (!pick) return '';
    const { e, s } = pick;
    return `<div class="weekpick" data-action="open" data-id="${esc(e.id)}" role="button" tabindex="0"
      aria-label="Pick of the week: ${esc(e.book.title)}. Open the dossier.">
      <span class="weekpick-cover">${jacket(e, 'row')}</span>
      <span class="weekpick-body">
        <span class="weekpick-eyebrow">${hasProfile() ? 'Your pick of the week' : 'Pick of the week'}</span>
        <span class="weekpick-title">${esc(e.book.title)}${e.book.author ? `<em> ${esc(e.book.author)}</em>` : ''}</span>
      </span>
      ${hasProfile() && isScored(e) ? `<span class="weekpick-score">${shownScore(e, s).toFixed(1)}</span>` : ''}
      <span class="weekpick-go" aria-hidden="true">${ico('arrow')}</span>
    </div>`;
  }

  function viewForYou() {
    // Without a profile this page shows the app rather than an argument for it:
    // real books, the real layout, drawn at random. The first-visit prompt
    // already makes the case for signing in, and a second pitch where the shelf
    // should be leaves a stranger with nothing to look at. What it does not do
    // is rank them or score them — a random eight is honestly a random eight,
    // and calling it an edit would be the borrowed-taste problem again.
    // Without a profile this used to be eight books drawn at random, because the
    // page had nothing else to put up. It has the week's reviews now, which are
    // real, current and in an order that means something — so the sample is
    // gone, and with it two lines that had started lying: "reload for a
    // different eight" and "these eight lean", on a page showing twelve reviews.
    const ranked = hasProfile() ? edit() : sinceLastVisit();
    const filtered = Boolean(state.q || state.tag || state.kind !== 'any' || state.shortOnly);
    if (!ranked.length) {
      return `${viewHead({ eyebrow: dateline(), title: greeting(),
        lede: filtered
          ? 'Nothing on today’s shelf answers the filters now set.'
          : 'Nothing in the current build clears the profile. The archive is still browseable under All books.' })}
        ${toolbar({ scopes: null, scope: null, showRecommended: false, showSort: false })}
        <div class="panel panel-empty"><h2>${filtered ? 'Nothing matches' : 'No edit today'}</h2>
        <p>${filtered
          ? `The edit is a few dozen books, so a filter empties it long before it empties the archive. All ${esc(String(stats.total))} are still under All books.`
          : 'Every scored book has been ruled on, or the build found nothing inside the window.'}</p>
        <button class="btn btn-solid" data-action="${filtered ? 'clear' : 'go'}" data-view="all">${
          filtered ? 'Clear the filters' : `Open the archive ${ico('arrow')}`}</button></div>`;
    }

    const week = pickOfWeek();
    const fresh = sinceLastVisit().filter((r) => r.e.id !== week?.e.id);
    const leans = leanCounts(ranked);
    // Everything else the profile likes, minus what is already on the page.
    const shown = new Set([week?.e.id, ...fresh.slice(0, 12).map((r) => r.e.id)].filter(Boolean));
    const picks = ranked.filter((r) => !shown.has(r.e.id)).slice(0, 4);

    // The same twelve rows in the same order — sinceLastVisit already put the
    // reviews first — split at the seam it already sorted on so each half can be
    // named. Either half is routinely empty: a day of nothing but author accounts
    // and a day of nothing but reviews both happen, and a heading over no rows is
    // worse than no heading.
    const freshTop = fresh.slice(0, 12);
    const freshCritics = freshTop.filter((r) => readFrom(r.e) === 'reviews');
    const freshAuthors = freshTop.filter((r) => readFrom(r.e) !== 'reviews');

    return `
      ${viewHead({
        eyebrow: dateline(),
        title: greeting(),
        lede: hasProfile()
          ? `${esc(String(fresh.length))} book${fresh.length === 1 ? '' : 's'} the press wrote about ${esc(sinceLabel())}, ordered by your taste.`
          : `What the press wrote about ${esc(sinceLabel())}, newest first. Answer three questions and this page orders itself by what you like instead.`,
      })}

      ${toolbar({ scopes: null, scope: null, showRecommended: false, showSort: false })}
      ${tagBanner(ranked.length)}

      ${fresh.length
        ? `${freshCritics.length ? `<section aria-labelledby="fresh-h">
            ${freshHead('reviews', freshCritics.length, true)}
            <ul class="rows">${freshCritics.map(feedRow).join('')}</ul>
          </section>` : ''}
          ${freshAuthors.length ? `<section aria-labelledby="fresh-h-a">
            ${freshHead('author', freshAuthors.length, !freshCritics.length)}
            <ul class="rows">${freshAuthors.map((r, i) => feedRow(r, i + freshCritics.length)).join('')}</ul>
          </section>` : ''}`
        : `<section class="panel panel-empty" aria-labelledby="fresh-h">
            <h2 id="fresh-h">Nothing new since you were here</h2>
            <p>The desks file about seventeen reviews a day into this feed, so there is usually something by tomorrow morning. The whole archive is under All books in the meantime.</p>
            <button class="btn btn-solid" data-action="go" data-view="all">Open the archive ${ico('arrow')}</button>
          </section>`}

      ${hasProfile() ? '' : `<div class="unranked" role="status">
        <div>
          <p class="eyebrow">Not chosen for you yet</p>
          <p class="unranked-text">These are the newest reviews, in the order they were filed. Answer three questions and the same list reorders around what you read for.</p>
        </div>
        <button class="btn btn-solid" data-action="go" data-view="start">Build your taste profile ${ico('arrow')}</button>
      </div>`}

      <section class="lean" aria-label="What today’s selection leans toward">
        <div class="lean-copy">
          <p class="eyebrow">${hasProfile() ? 'Today’s selection leans' : 'This week’s reviews lean'}</p>
          <p>Toward ${esc(leanPhrase(leans, ranked))}.</p>
        </div>
        <div class="lean-counts">
          ${leans.map((t) => `<span class="lean-count">${esc(t.label)}<b>${t.n}</b></span>`).join('')}
        </div>
      </section>

      <section aria-labelledby="sel-h">
        <div class="section-head">
          <div>
            <p class="eyebrow">${hasProfile() ? 'A considered shelf' : 'More from the archive'}</p>
            <h2 id="sel-h">${hasProfile() ? 'Selected for you' : 'Also on the shelf'}</h2>
          </div>
          <button class="section-head-link" data-action="go" data-view="feed">See the full feed ${ico('arrow')}</button>
        </div>
        ${shelf(picks)}
      </section>

      ${reserveSection([week?.e.id, ...fresh.slice(0, 12).map((r) => r.e.id), ...picks.map((r) => r.e.id)].filter(Boolean))}`;
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
            <b>${hasProfile() ? 'Your best pick' : 'From the archive'}</b>
            <span class="label">${hasProfile() ? 'Highest fit in today’s edit' : 'Drawn at random until you have a profile'}</span>
          </span>
        </div>
        <h2>${esc(b.title)}</h2>
        ${b.author ? `<p class="spotlight-author">${esc(b.author)}</p>` : ''}
        ${blurbOf(e, 240) ? `<p class="spotlight-blurb">${esc(blurbOf(e, 240))}</p>` : ''}
        <p class="spotlight-fit">${ico('sparkles')}<span>${
          hasProfile() ? (whyHtml(e, s, 4) || esc(caseFor(e, s))) : esc(sourceLine(e))}</span></p>
        <div class="spotlight-actions">
          <button class="btn btn-solid" data-action="open" data-id="${esc(e.id)}">Open the dossier ${ico('arrow')}</button>
          ${saveBtn(e, { label: 'Save for later' })}
          <button class="btn btn-quiet" data-action="pass" data-id="${esc(e.id)}">Not for me</button>
        </div>
      </div>
      <div class="spotlight-cover">
        <button class="jacket-btn" data-action="open" data-id="${esc(e.id)}" aria-label="Open the dossier for ${esc(b.title)}">
          ${jacket(e, 'spotlight')}
        </button>
        ${hasProfile() ? `<span class="spotlight-score"><b>${shownScore(e, s).toFixed(1)}</b><span>Your fit</span></span>` : ''}
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
        if (!isKind(e, state.kind)) return false;
        if (!hasTag(e, state.tag)) return false;
        return matches(e, state.q);
      })
      .map((e) => ({ e, s: scoreOf(e) }))
      .filter(({ e, s }) => !state.recommendedOnly || recommendedNow(e, s));

    const rows = sortPool(pool, state.sort);
    const shown = rows.slice(0, state.limit);

    return `
      ${viewHead({
        eyebrow: hasProfile() ? 'Ranked for you' : 'Newest first',
        title: 'Review feed',
        lede: hasProfile()
          ? `Every book the press has written about, best fit first. Save one or pass on it and the order moves.`
          : `Every book the press has written about since ${esc(stats.reachesBack || 'the archive opened')}, newest first.`,
        aside: `${rows.length} books`,
      })}

      ${toolbar({ scopes: SCOPES, scope: state.scope })}
      ${unrankedNote()}
      ${tagBanner(rows.length)}

      ${rows.length
        ? `<ul class="rows">${shown.map(feedRow).join('')}</ul>${moreBtn(shown.length, rows.length, 'more-rows')}`
        : `<div class="panel panel-empty"><h2>Nothing matches</h2>
           <p>No reviewed book answers that search under the filters now set.</p>
           <button class="btn btn-solid" data-action="clear">Clear the filters</button></div>`}`;
  }

  // ------------------------------------------------------------ Search

  // Built on first use and kept for the session. The index is derived entirely
  // from the feed already in memory, so it costs a loop and nothing on the wire.
  let searchIndex = null;
  const searchIdx = () => (searchIndex ||= buildSearchIndex(FEED.books));

  function viewSearch() {
    const q = state.sqRun.trim();
    // Fit is what the reader's own profile makes of a book, and it is passed in
    // only when there is a reader. Without one the ranking is relevance alone —
    // a stranger's search must not be ordered by somebody else's taste, which is
    // the same rule the feed and the shelf already follow.
    const found = q
      ? runSearch(q, FEED.books.filter((e) => !passed(e)), {
        index: searchIdx(),
        dimensions: FEED.dimensions,
        fitOf: hasProfile() ? (e) => (isScored(e) ? shownScore(e) : null) : () => null,
        limit: 200,
      })
      : null;

    const rows = found ? found.results.slice(0, state.searchLimit) : [];

    return `
      ${viewHead({
        eyebrow: 'Ask in your own words',
        title: 'Search',
        lede: hasProfile()
          ? `Describe the book you want. Where two books answer equally well, your profile decides the order.`
          : `Describe the book you want. This reads ${esc(String(FEED.books.length))} books the press has written about, and nothing outside them.`,
        aside: found ? `${found.total} match${found.total === 1 ? '' : 'es'}` : '',
      })}

      <form class="asksearch" id="askform" role="search">
        <label class="sr-only" for="sq">Describe the book you want</label>
        <div class="asksearch-field" data-busy="${state.searching}">
          ${state.searching ? `<span class="asksearch-spin" role="status" aria-label="Searching"></span>` : ico('search')}
          <input type="search" id="sq" value="${esc(state.sq)}" autocomplete="off" spellcheck="false"
            enterkeyhint="search" aria-busy="${state.searching}"
            placeholder="a contemporary Great American Novel">
          ${state.sq ? `<button type="button" class="asksearch-clear" data-action="clear-search" aria-label="Clear the search">${ico('close')}</button>` : ''}
        </div>
        <p class="asksearch-note">Plain sentences work. So do lengths, years, “in translation”, and “like <em>Trust</em>”.</p>
      </form>

      ${!q ? `<div class="asksearch-eg">
        <p class="eyebrow">Try one of these</p>
        <div class="asksearch-chips">${SEARCH_EXAMPLES.map((x) =>
          `<button class="chip" data-action="example" data-q="${esc(x)}">${esc(x)}</button>`).join('')}</div>
        <p class="asksearch-limit">Every match comes from what a critic or a publisher wrote about the book. Ask for a family saga in translation and it finds one; ask for something that feels like early Denis Johnson and it is guessing.</p>
      </div>` : readback(found)}

      ${q ? (rows.length
        ? `<ul class="rows">${rows.map(searchRow).join('')}</ul>${
          rows.length < found.results.length
            ? moreBtn(rows.length, found.results.length, 'more-search')
            : ''}`
        : `<div class="panel panel-empty"><h2>Nothing in the archive answers that</h2>
           <p>No book here matched on a band, on the text, or on length. Try the subject on its own, or name a book you want something like.</p>
           <button class="btn btn-solid" data-action="clear-search">Start again</button></div>`) : ''}`;
  }

  // Running a search without freezing the field being typed into.
  //
  // Two costs, and they are different. The BM25 index is built once over the
  // whole archive and takes 447ms at 823 books — a visible stall, and it will
  // grow with the corpus. Each search after that is 17ms. Neither should happen
  // on the keystroke: the field has to keep up with a thumb.
  //
  // So a keystroke only records what was typed and schedules. The scheduler
  // waits for the typing to settle, puts the spinner up, yields a frame so the
  // browser can actually paint it — a spinner rendered in the same task as the
  // work it describes is never seen — and then searches.
  let searchTimer = null;
  const SETTLE = 180;

  function queueSearch({ now = false } = {}) {
    clearTimeout(searchTimer);
    const run = () => {
      searchTimer = null;
      const q = state.sq.trim();
      if (q === state.sqRun) { setSearching(false); return; }
      // An index that already exists costs nothing, so the spinner is only put
      // up for the build. Showing it for 17ms is a flash, which reads as a fault.
      const heavy = !searchIndex && q;
      if (heavy) setSearching(true);
      let ran = false;
      const go = () => {
        if (ran) return;
        ran = true;
        state.sqRun = q;
        state.searchLimit = SEARCH_PAGE;
        state.searching = false;
        render();
      };
      if (!heavy) { go(); return; }
      // Two frames, so the spinner is painted before the work that blocks the
      // paint begins. With a timer behind it, because requestAnimationFrame does
      // not fire in a backgrounded tab — switch away mid-search and the search
      // would never finish, and switching back would show a spinner over an
      // empty page for as long as the tab stayed open.
      requestAnimationFrame(() => requestAnimationFrame(go));
      setTimeout(go, 120);
    };
    if (now) run(); else searchTimer = setTimeout(run, SETTLE);
  }

  // The field is re-created on every render, so the caret and the focus are put
  // back by hand — and only while the reader is still in it.
  function setSearching(on) {
    if (state.searching === on) return;
    state.searching = on;
    const field = $('sq');
    const at = field?.selectionStart, end = field?.selectionEnd, had = document.activeElement === field;
    render();
    const next = $('sq');
    if (next && had) { next.focus(); try { next.setSelectionRange(at, end); } catch { /* not selectable */ } }
  }

  function searchRow(row, i) {
    return feedRow({ e: row.e, s: scoreOf(row.e), note: row.why, hit: new Set(row.matchedTags) }, i);
  }

  // What the app understood, in the app's own vocabulary, before any result.
  //
  // A search that silently reinterprets the question is the thing that sends
  // people back to a chatbot: they cannot tell a thin archive from a
  // misunderstanding. This says which bands it went looking for, which words it
  // kept, and what it treated as a requirement — so a wrong answer is a legible
  // wrong answer and the reader knows which word to change.
  function readback(found) {
    if (!found) return '';
    const q = found.query;
    const bits = [];
    if (found.reference) {
      bits.push(`<span class="rb-item" data-kind="ref">nearest to <b>${esc(found.reference.book?.title || '')}</b></span>`);
    }
    for (const t of q.tags) bits.push(`<span class="rb-item" data-kind="tag">${esc(t.label)}</span>`);
    for (const f of q.echo) bits.push(`<span class="rb-item" data-kind="facet">${esc(f)}</span>`);
    for (const t of q.typed || []) bits.push(`<span class="rb-item" data-kind="word">“${esc(t)}”</span>`);

    if (!bits.length) {
      return `<div class="readback" data-state="empty"><p class="eyebrow">What this read</p>
        <p>Nothing in that query named a subject, a shape or a length this archive records, so it went looking in the review text alone.</p></div>`;
    }
    return `<div class="readback">
      <p class="eyebrow">What this read</p>
      <div class="rb-items">${bits.join('')}</div>
      ${found.reference ? '' : `<p class="readback-note">Bands come from what critics said about each book. Words come from the review and the publisher’s description.</p>`}
    </div>`;
  }

  // ------------------------------------------------------------ All books

  function viewAll() {
    const pool = FEED.books
      .filter((e) => {
        const st = scoreStatus(e);
        if (state.allScope !== 'any' && st !== state.allScope) return false;
        if (state.shortOnly && !(e.book.pages && e.book.pages < 300)) return false;
        if (!isKind(e, state.kind)) return false;
        if (!hasTag(e, state.tag)) return false;
        return matches(e, state.q);
      })
      .map((e) => ({ e, s: scoreOf(e) }));

    const rows = sortPool(pool, state.sort);
    const shown = rows.slice(0, state.allLimit);

    // The score-status board is gone. It counted how many books the scorer had
    // placed, how many it had read from a review against an author's account,
    // and how many carried too little evidence — a build report, standing where
    // a reader who came to browse a shelf has to scroll past it. Most mornings
    // two of its four figures were zero.
    //
    // Nothing went with it. Its figures doubled as the scope filter, and that
    // filter is in the Filters menu, where the other three live.
    return `
      ${viewHead({
        eyebrow: 'Nothing left out',
        title: 'The whole shelf.',
        lede: hasProfile()
          ? `${esc(String(stats.total))} books, yours to sort. The one page that shows what your profile scores badly as well as what it likes.`
          : `${esc(String(stats.total))} books, newest first. Everything the press has written about, whether or not anyone has scored it.`,
        aside: `${shown.length} of ${rows.length}`,
      })}

      ${toolbar({ scopes: ALL_SCOPES, scope: state.allScope, showRecommended: false })}
      ${unrankedNote()}
      ${tagBanner(rows.length)}

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
        lede: 'Save a book anywhere in the app and it gathers here, with everywhere you can buy a copy.',
        aside: rows.length ? `${rows.length} saved${missing > 0 ? ` · ${missing} not in this build` : ''}` : '',
      })}
      ${rows.length
        ? shelf(rows)
        : `<div class="panel panel-empty">
            ${ico('bookmark')}
            <h2>Nothing saved yet</h2>
            <p>One tap keeps a book without interrupting your browse.</p>
            <button class="btn btn-solid" data-action="go" data-view="foryou">${
              hasProfile() ? `Browse your recommendations` : `Browse the archive`} ${ico('arrow')}</button>
          </div>`}`;
  }

  // ------------------------------------------------------------ Taste

  // What the reader actually said, and the way back into it. Taste used to show
  // only the consequences — bars, a calibration dial, a dimension doing the most
  // excluding — with no sign that any of it came from a list of words someone
  // once picked, and no way to pick differently. The numbers are downstream of
  // these chips, so the chips are what belong on this screen.
  function answerEditor() {
    const chips = [
      ...answers.liked.map((key) => ({ key, which: 'liked' })),
      ...answers.disliked.map((key) => ({ key, which: 'disliked' })),
    ];
    const label = (key) => CHIP_LABELS.get(key) || key.split(':')[1]?.replace(/_/g, ' ') || key;

    return `<section class="panel answers" aria-labelledby="answers-h">
      <div class="section-head">
        <div>
          <p class="eyebrow">In your own words</p>
          <h2 id="answers-h">${chips.length ? 'What you told it you like' : 'You have not said what you like yet'}</h2>
        </div>
        <button class="btn" data-action="go" data-view="start">${chips.length ? 'Add or change' : 'Answer three questions'} ${ico('arrow')}</button>
      </div>
      ${chips.length
        ? `<p class="answers-note">Every weight on the Profile screen was calculated from these. Remove one and the scores move.</p>
           <div class="tags answers-tags">${chips.map(({ key, which }) => `
             <button class="tag" data-state="${which}" data-action="unpick" data-key="${esc(key)}"
               aria-label="Remove ${esc(label(key))} from what you ${which === 'liked' ? 'like' : 'avoid'}">
               ${which === 'disliked' ? '<span aria-hidden="true">✕ </span>' : ''}${esc(label(key))}
               <span class="tag-x" aria-hidden="true">×</span>
             </button>`).join('')}</div>`
        : `<p class="answers-note">The feed is ranked by one reader's profile until you do. It takes about two minutes.</p>`}
    </section>`;
  }

  // Chip keys are stored as `D2:land`; the words a reader recognises live in
  // onboard.mjs. This is the one lookup between them.
  const CHIP_LABELS = new Map(chipsFor('both').map((c) => [`${c.dim}:${c.band}`, c.label]));

  function viewTaste() {
    if (!hasProfile()) {
      return blankSlate({
        eyebrow: 'Learning from your choices',
        title: 'Your taste, made legible.',
        lede: 'What this screen reads is your own answers and your own saves. With neither, there is nothing to show and nothing worth inventing.',
        becomes: [
          'The words you picked to describe what you like, each one removable.',
          'Which dimensions your feed is actually weighing, and by how much.',
          'How far your saves have moved the ranking, and which single preference is narrowing your list the most.',
        ],
      });
    }
    // Two counters, because the model has two halves and they need different
    // evidence. Saves anchor it: a mean of the books you liked, and the nearest
    // one to say why. Passes only sharpen what it already reads off a tag, so
    // they open that half on their own and never the other.
    const savedN = taste?.savedCount ?? saved.savedCount(verdicts);
    const passedN = taste?.passedCount ?? 0;
    const judgedN = savedN + passedN;
    const need = Math.max(0, MIN_SIGNAL - savedN);
    const needAny = Math.max(0, MIN_JUDGMENTS - judgedN);
    const learning = Boolean(taste?.ready);
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
            <span class="calibrate-dial">${learning ? judgedN : Math.min(judgedN, MIN_JUDGMENTS)}<small>${
              learning ? '' : `/ ${MIN_JUDGMENTS}`}</small></span>
            <div>
              <p class="eyebrow">Calibration</p>
              <h2>${!learning
                ? `${needAny} more verdict${needAny === 1 ? '' : 's'} to begin learning.`
                : need
                  ? 'Learning from what you pass on.'
                  : 'Your saves and passes are tuning the feed.'}</h2>
              <p>${!learning
                ? 'A save or a pass both count. Refusing a book says as much about your taste as keeping one.'
                : need
                  ? `${esc(String(passedN))} passes have told it which tags to mark down. ${need} more save${need === 1 ? '' : 's'} and it can also say what a book you would keep looks like.`
                  : `Together they can move a score by no more than ${(MAX_ADJUSTMENT / 10).toFixed(1)} points. Rules and penalties remain entirely yours.`}</p>
              <button class="btn btn-solid" data-action="go" data-view="foryou">${learning ? 'Keep reading the edit' : 'Start ruling on books'}</button>
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

      ${answerEditor()}

      ${(() => {
        const w = starvingDimension();
        if (!w) return '';
        return `<section class="panel" aria-labelledby="starve-h">
          <p class="eyebrow">What is narrowing your list</p>
          <h2 id="starve-h" style="font-family:var(--font-display);font-weight:400;font-size:25px;color:var(--porcelain);margin:10px 0 0">
            ${esc(w.name)} is doing the most excluding.</h2>
          <p style="margin:12px 0 0;font-size:14px;line-height:1.55;color:var(--graphite);max-width:56ch">
            It carries ${w.weight} of your 100 points. Set it to zero and ${w.fresh} books that cannot reach your top twenty today would enter it.
            That is not a fault — it is what a strong preference does — but it is the one worth knowing about.</p>
          <button class="btn" data-action="go" data-view="profile" style="margin-top:16px">Open the weights ${ico('arrow')}</button>
        </section>`;
      })()}

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
  ];

  const guardrailOn = (g) => overrides[g.group]?.[g.key] !== false;

  // The hard filters, minus the one the guardrails above already name. Listing
  // nonfiction twice would give a reader two switches for one fact.
  const penalties = () => (FEED.hardFilters || []).filter((f) => f.id !== 'nonfiction');
  const penaltyOn = (f) => overrides.adjustments?.[f.id] !== false;

  function draft() {
    if (!state.draftWeights) {
      state.draftWeights = Object.fromEntries(FEED.dimensions.map((d) => [d.id, weightOf(d)]));
    }
    return state.draftWeights;
  }

  function draftTotal() {
    return Object.values(draft()).reduce((n, v) => n + v, 0);
  }

  // What each band a review can land in is worth, out of ten.
  //
  // The weight above says how much a dimension counts; this says what counts as
  // a good answer within it. Both halves are the reader's, and the second half
  // is where a disagreement usually lives: "comic" describes a novel the same
  // way for everyone and is worth 4 to this profile and 10 to somebody who reads
  // for comedy.
  //
  // Closed on arrival, because eight dimensions carry eighty-four bands between
  // them and a screen that opens as eighty-four number fields is a spreadsheet. A
  // band the reader has moved says what it was worth before, and nothing else on
  // the row is coloured.
  function bandEditor(d) {
    const bands = d.bands || [];
    if (!bands.length) return '';
    const moved = bands.filter((b) => overrides.bands?.[bandKey(d.id, b.id)] != null).length;
    return `<details class="bands">
      <summary>What each band is worth${moved ? ` · ${moved} changed` : ''}</summary>
      ${bands.map((b) => {
        const cur = overrides.bands?.[bandKey(d.id, b.id)] ?? b.score;
        const id = `b-${cssId(d.id)}-${cssId(b.id)}`;
        return `<div class="band-row">
          <label for="${id}">${esc(b.label)}${b.descriptiveOnly ? '<span class="band-note">Describes the book; the profile does not rank it.</span>' : ''}</label>
          <input type="number" id="${id}" min="0" max="10" step="1" value="${cur}"
            data-band-dim="${esc(d.id)}" data-band-id="${esc(b.id)}"
            aria-label="What ${esc(b.label)} is worth, out of ten">
          <span class="band-was">${cur !== b.score ? `was ${b.score}` : ''}</span>
        </div>`;
      }).join('')}
    </details>`;
  }

  // The weekly roundup. Most of this is the honest no: on an iPhone this works
  // only for a web app that has been added to the Home Screen, which is Apple's
  // rule and not something a button here can talk its way past. So a reader in a
  // Safari tab is told how to install it rather than shown a control that would
  // fail, and a reader who has turned it down in the browser is told where that
  // decision now lives, because this page cannot ask twice.
  function roundupCard() {
    const stop = push.blocker();
    const on = !stop && push.state() === 'on' && roundupOn;
    const body = {
      'needs-install': 'Add Constant Reader to your Home Screen first — the Share button, then <b>Add to Home Screen</b>. Open it from there and this becomes a button.',
      unsupported: 'This browser cannot do notifications. Everything else works as it always did.',
      denied: 'Notifications are switched off for this app in your browser or system settings, so this cannot ask again from here.',
    }[stop];
    return `<div class="roundup" data-state="${on ? 'on' : 'off'}">
      <h3>Weekly roundup</h3>
      ${body
        ? `<p class="privacy">${body}</p>`
        : !signedInNow()
          ? '<p class="privacy">Sign in first. The roundup is sent to your devices, so it needs an account to know which ones are yours.</p>'
          : `<p class="privacy">${on
              ? 'On. One notification a week, Monday morning, only when something new clears your threshold.'
              : 'One notification a week, Monday morning, naming what is new for you. Nothing else is ever sent.'}</p>
             <button class="btn ${on ? 'btn-ghost' : 'btn-solid'}" data-action="roundup">${on ? 'Turn off' : 'Turn on notifications'}</button>`}
    </div>`;
  }

  // Whether this device is subscribed. Read once at start and kept here so the
  // card can render on the first paint rather than flickering through "off".
  let roundupOn = false;

  async function toggleRoundup() {
    if (!user) {
      needAuth('Sign in to get the roundup.',
        'It is sent to your devices, so it needs an account to know which ones are yours.');
      return;
    }
    try {
      if (roundupOn) {
        const gone = await push.disable();
        if (gone) await sync.forgetDevice(user.uid, await push.deviceId(gone.endpoint));
        roundupOn = false;
        render();
        toast('Weekly roundup off.');
        return;
      }
      const sub = await push.enable();
      await sync.saveDevice(user.uid, await push.deviceId(sub.endpoint), sub);
      roundupOn = true;
      render();
      toast('Weekly roundup on. The next one is Monday.');
    } catch (err) {
      roundupOn = false;
      render();
      toast(explainPush(err), { error: true });
    }
  }

  // The browser's own words for these are "denied" and "default", which tell a
  // reader nothing about what to do next.
  function explainPush(err) {
    const code = err?.code || '';
    if (code === 'push/denied') return 'Your browser refused notifications for this app. It can be changed in its settings, not from here.';
    if (code === 'push/default') return 'Notifications were not allowed, so nothing was turned on.';
    if (code === 'push/needs-install') return 'Add the app to your Home Screen first, then open it from there.';
    if (code === 'push/unsupported') return 'This browser cannot do notifications.';
    if (code === 'permission-denied') return 'The server refused to record this device. Nothing else changed.';
    return 'Could not turn the roundup on. Nothing else changed.';
  }

  function viewProfile() {
    if (!hasProfile()) {
      return blankSlate({
        eyebrow: 'The numbers behind your feed',
        title: 'Set the terms of your own taste.',
        lede: 'The weights on this screen decide every score in the app. Until you answer three questions they are a starting set, and nothing in the app is scored against them.',
        becomes: [
          'Eight weighted dimensions totalling a hundred points, all of them yours to move.',
          'The words used to describe a book, and what each one is worth to you.',
          'Guardrails and vetoes: rules that take points off, or take a book out.',
        ],
      });
    }
    const w = draft();
    const total = draftTotal();
    const ok = total === 100;
    const tags = leanCounts(edit(), 3);

    return `
      ${viewHead({
        eyebrow: 'The numbers behind your feed',
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
            ${bandEditor(d)}
          </div>`).join('')}
        </div>

        <aside class="summary-rail">
          <p class="summary-threshold"><b>${threshold().toFixed(1)}</b><span class="label">Recommend threshold</span></p>
          <hr>
          <h3>Your profile in one sentence</h3>
          <p>Historically alive, formally ambitious fiction with controlled prose and a reason to be long.</p>
          <div class="tags">${tags.map((t) => `<span class="tag" data-kind="${esc(t.kind)}">${esc(t.label)}</span>`).join('')}</div>
          <hr>
          ${roundupCard()}
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

        <section class="guardrails profile-guardrails" aria-labelledby="pen-h">
          <div class="weights-head">
            <div>
              <p class="eyebrow">What the profile discounts</p>
              <h2 id="pen-h">Penalties, not exclusions</h2>
            </div>
            <span class="weights-total">${penalties().filter(penaltyOn).length} of ${penalties().length} in force</span>
          </div>
          <p class="view-lede" style="margin:0 0 6px">A book carrying one of these is still scored and still shown. Switch one off and its points come back.</p>
          ${penalties().map((f) => `<div class="guardrail-row penalty-row">
            <span id="p-${esc(f.id)}">${esc(f.label)}<span class="band-note">${f.points} points</span></span>
            <button class="switch" role="switch" aria-checked="${penaltyOn(f)}"
              aria-labelledby="p-${esc(f.id)}" data-action="penalty" data-penalty="${esc(f.id)}"></button>
          </div>`).join('')}
        </section>

        <section class="guardrails profile-guardrails" aria-labelledby="averse-h">
          <div class="weights-head">
            <div>
              <p class="eyebrow">What closes the book</p>
              <h2 id="averse-h">Things you won’t read</h2>
            </div>
            <span class="weights-total">${Object.keys(overrides.aversions || {}).length} of ${MAX_AVERSIONS}</span>
          </div>
          <p class="view-lede" style="margin:0 0 6px">Everything above weighs a book’s strengths against its weaknesses. These do not: they come off the score at full force, or take the book out altogether. The list is capped, because a veto list long enough to be comfortable is long enough to empty the shelf.</p>
          ${REFUSALS.map((r) => {
            const cur = overrides.aversions?.[r.key] || 'off';
            return `<div class="guardrail-row averse-row">
              <span id="av-${esc(cssId(r.key))}">${esc(r.label)}</span>
              <span class="averse-picks" role="group" aria-labelledby="av-${esc(cssId(r.key))}">
                ${['off', 'mild', 'strong', 'never'].map((k) => `<button class="averse-pick"
                  data-action="aversion" data-key="${esc(r.key)}" data-strength="${k}"
                  aria-pressed="${cur === k}">${k === 'off' ? 'Fine' : k === 'never' ? 'Never' : k}</button>`).join('')}
              </span>
            </div>`;
          }).join('')}
        </section>

        <div class="profile-extras">
          <p>Your saves and passes are what the next revision of the profile is written from. Export them as JSON to keep or to feed back in.</p>
          <button class="btn" data-action="export">Export my verdicts</button>
        </div>
      </div>`;
  }

  // ------------------------------------------------------------ the builder

  // Three questions on one screen. A wizard would be more ceremony than three
  // questions deserve, and seeing all of them at once is what makes it feel
  // short. lib/onboard.mjs turns the answers into an override object; this only
  // asks them.
  //
  // It has no slot in the navigation. Nobody arrives here twice: the first-visit
  // prompt and the return band point at it, the Profile screen keeps everything
  // it produces, and a permanent seventh nav item for a screen used once would
  // cost a slot on every other visit.
  // What counts as new for this visit.
  //
  // The front page was the highest-scoring book in the whole archive followed by
  // the next four, which changes when something outscores them and not before —
  // maybe weekly, whatever arrives. Measured, the press files about 17 reviews a
  // day into this feed and 8 of them are books it has never seen. That is the
  // material the page was not showing.
  //
  // A gap of more than a fortnight is capped: coming back after a month should
  // open on a readable page rather than four hundred books.
  const WEEK = 7 * 86400000;
  const HOUR = 3600000;
  const MAX_GAP = 14 * 86400000;

  let sinceCutoff = null;
  function openVisit() {
    const now = Date.now();
    const v = read(VISIT_KEY, null);
    const last = v?.at ? Date.parse(v.at) : null;
    if (!last) {
      // A first visit has nothing to be new against, so it opens on the week.
      sinceCutoff = now - WEEK;
      write(VISIT_KEY, { at: new Date(now).toISOString(), since: new Date(sinceCutoff).toISOString() });
      return;
    }
    if (now - last < HOUR) {
      // Same sitting. Hold the cutoff the page already used.
      sinceCutoff = v.since ? Date.parse(v.since) : last;
      return;
    }
    sinceCutoff = Math.max(last, now - MAX_GAP);
    write(VISIT_KEY, { at: new Date(now).toISOString(), since: new Date(sinceCutoff).toISOString() });
  }

  // Monday, so a pick of the week holds for the week rather than sliding daily.
  function weekStart(now = Date.now()) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return d.getTime();
  }

  let answers = {
    reads: 'both', liked: [], disliked: [], refused: [], satire: false,
    ...read(ANSWERS_KEY, {}),
  };
  // A band cannot be both liked and disliked. The picker has enforced that since
  // it was written, but the disliked list used to be offered whole — every liked
  // chip included — so an answer file written before this could hold a band on
  // both sides, and buildProfile would then write two adjustments to it and let
  // whichever ran last win. Liked is kept, because it is the question asked first.
  answers.disliked = (answers.disliked || []).filter((k) => !(answers.liked || []).includes(k));

  // What the two rules on the chips mean. Shown above each list rather than once
  // at the top, because the second list is a long scroll from the first.
  function chipKey() {
    const item = (reads, label) => `<span class="chip-key-item" data-reads="${reads}">${esc(label)}</span>`;
    return `<p class="chip-key">${item('fiction', 'Fiction')}${item('nonfiction', 'Nonfiction')}${item('both', 'Either')}</p>`;
  }

  function viewStart() {
    // Grouped under headings in the reader's words. Sixty chips in one run is a
    // wall nobody reads to the end of; eight short lists can be skimmed and whole
    // groups skipped by someone who has no opinion about them.
    // A chip already claimed by the other list is not offered here. Asking
    // someone what puts them off and listing back the things they just said they
    // read for is a question that answers itself, and picking both wrote two
    // contradictory adjustments to the same band.
    const other = (which) => (which === 'liked' ? 'disliked' : 'liked');
    const chips = (which) => groupedChipsFor(answers.reads).map((g) => {
      const avail = g.chips.filter((c) => !answers[other(which)].includes(`${c.dim}:${c.band}`));
      if (!avail.length) return '';
      return `
      <div class="chip-group" role="group" aria-labelledby="g-${which}-${esc(cssId(g.dim))}">
        <p class="label chip-group-head" id="g-${which}-${esc(cssId(g.dim))}">${esc(g.label)}</p>
        <div class="start-chips">${avail.map((c) => {
          const key = `${c.dim}:${c.band}`;
          const on = answers[which].includes(key);
          // Fiction and nonfiction chips are told apart by a rule down the left
          // edge and by the word in the accessible name, never by the colour
          // alone: a reader who cannot see the difference is told it.
          const reads = c.reads || 'both';
          const said = reads === 'both' ? '' : `, a ${reads} answer`;
          return `<button class="start-chip" data-action="pick" data-which="${which}" data-key="${esc(key)}"
            data-reads="${esc(reads)}" aria-pressed="${on}"
            aria-label="${esc(c.label)}${said}">${esc(c.label)}</button>`;
        }).join('')}</div>
      </div>`;
    }).join('');

    const ready = answersReady(answers);

    return `
      ${viewHead({
        eyebrow: 'Three questions, about two minutes',
        title: 'Make these scores yours.',
        lede: `Every number in this feed is one reader’s taste. Pick <strong>${MIN_PICKS}</strong> or more — at least one of them something that puts you off — and the feed re-ranks against yours instead. You can sharpen it any time afterwards on the Profile screen.`,
      })}

      <div class="start">
        <section class="start-block">
          <p class="eyebrow">First, and it does the most</p>
          <h2>What do you read?</h2>
          <p>The published profile docks nonfiction 45 points out of 100, which is one reader’s exclusion rather than a fact about books. Nothing below repairs that on its own.</p>
          <div class="start-chips">${READS.map((r) => `<button class="start-chip start-reads" data-action="reads" data-value="${esc(r.id)}"
            aria-pressed="${answers.reads === r.id}">${esc(r.label)}<span class="reads-note">${esc(r.note)}</span></button>`).join('')}</div>
        </section>

        <section class="start-block">
          <p class="eyebrow">Second</p>
          <h2>What do you read for?</h2>
          <p>Anything that makes you want to open a book.</p>
          ${chipKey()}
          ${chips('liked')}
        </section>

        <section class="start-block">
          <p class="eyebrow">Third, and it matters as much</p>
          <h2>What puts you off?</h2>
          <p>A model with nothing to push against ranks everything alike, so this list is worth as much as the one above it. Anything you picked above is not repeated here.</p>
          ${chipKey()}
          ${chips('disliked')}
        </section>

        <section class="start-block">
          <p class="eyebrow">And last</p>
          <h2>Is there anything you simply won’t read?</h2>
          <p>Different from the list above. A dislike is weighed against everything else a book has going for it; this is the thing that closes the book whatever else is true, so it comes off the score at full force.</p>
          <div class="start-chips">${REFUSALS.map((r) => `<button class="start-chip" data-action="refuse"
            data-key="${esc(r.key)}" aria-pressed="${answers.refused.includes(r.key)}">${esc(r.label)}</button>`).join('')}</div>
          <div class="start-foot" data-ready="${ready.ready}">
            <p>${ready.ready
              ? `${ico('check')}Ready — ${ready.picks} answers is enough to re-rank the feed`
              : ready.needPicks
                ? `${ready.picks} of ${MIN_PICKS}${ready.needDislikes ? ', and one thing that puts you off' : ''}`
                : 'One more: something that puts you off'}</p>
            <div class="remind-actions">
              <button class="start-chip" data-action="satire" aria-pressed="${answers.satire}">I like satire and comic novels</button>
              <button class="btn btn-solid" data-action="build-profile" ${ready.ready ? '' : 'disabled'}>Build it ${ico('arrow')}</button>
            </div>
          </div>
        </section>

        <p class="privacy">Nothing here leaves this browser, and every part of it stays editable on the Profile screen afterwards.</p>
      </div>`;
  }

  // buildProfile bumps a dimension's weight for each pick beyond the first, and
  // rewrites two of them outright for a nonfiction reader, so its weights do not
  // total 100. The Profile screen refuses to save anything that does not, and a
  // reader who onboards and then opens Profile would land on a total they never
  // chose with Save already disabled. So the weights are scaled back to exactly
  // 100 here rather than in lib/onboard.mjs, which has tests and a calibration
  // suite behind it. Largest remainder, so the rounding does not lose a point.
  function normalizeWeights(weights) {
    const ids = FEED.dimensions.map((d) => d.id);
    const raw = ids.map((id) => weights[id] ?? FEED.dimensions.find((d) => d.id === id).weight);
    const sum = raw.reduce((a, b) => a + b, 0);
    if (!sum) return weights;
    const scaled = raw.map((w) => w / sum * 100);
    const floors = scaled.map(Math.floor);
    let left = 100 - floors.reduce((a, b) => a + b, 0);
    const order = scaled
      .map((w, i) => ({ i, frac: w - Math.floor(w) }))
      .sort((a, b) => b.frac - a.frac);
    for (const { i } of order) { if (left <= 0) break; floors[i]++; left--; }
    return Object.fromEntries(ids.map((id, i) => [id, floors[i]]));
  }

  function applyBuiltProfile() {
    if (!answersReady(answers).ready) return;
    const built = buildProfile(profileForOverrides(), answers);
    overrides = sync.stamp({ ...built, weights: normalizeWeights(built.weights) });
    write(OVERRIDES_KEY, overrides);
    write(ANSWERS_KEY, answers);
    profileVersion++;
    state.draftWeights = null;
    setView('foryou');
    toast('Your profile is in. The feed is ranked by it now.');
    announce('Profile built. Every score has been recalculated against your answers.');
    syncNow();
    // The first moment there is something worth losing. Before the answers there
    // was nothing to keep and the offer was noise; after them it is a browser
    // cache away from gone.
    if (!signedInNow()) {
      needAuth('Sign in to keep it.',
        'You have just built a profile that is held in this browser and nowhere else. Clearing your history would take it.');
    }
  }

  // ------------------------------------------------------------ dossier

  let lastFocus = null;
  let lastFocusKey = null;

  function openDossier(id, { push = true } = {}) {
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
    // Pushed after the dossier is open, so the entry records the state it is
    // leaving the reader in rather than the one before it.
    if (push) pushHistory();
  }

  // Closing is going back. The × , the scrim and Escape all land here, and all
  // three have to leave the history where the swipe would: a dossier closed
  // without popping its entry means the next back gesture reopens it.
  function closeDossier() {
    if ($('dossier').hidden) return;
    if (history.state?.dossier) { history.back(); return; }
    shutDossier();
  }

  function shutDossier() {
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
    const tags = tagsFor(e).slice(0, 7);

    // The case block and the quote block were printing the same sentence. blurbOf
    // reads the first mention that has a standfirst; the quote below sets that
    // same standfirst in a blockquote with a byline under it. On most books they
    // are one text, so the dossier said it, then said it again in italics.
    //
    // The quote is the one that gives way. It is the weaker of the two — the same
    // words with more furniture — and the block above it is where a reader looks
    // first. Where a book has a second review with something else to say, that
    // one is quoted instead, which is better than either.
    const blurb = blurbOf(e, 420);
    const same = (t) => normalizeQuote(t) === normalizeQuote(blurb);
    // A second review with something else to say, where there is one — 114 books
    // in the archive have one. `cited` is the review this section is about
    // whether or not it has a quote left to give.
    const fresh = blurb
      ? e.mentions.find((x) => (x.standfirst || '').trim() && !same(x.standfirst))
      : m;
    const cited = fresh || m;
    // Where the only standfirst is the sentence already printed above, the block
    // keeps its attribution and its link and drops the repetition. Suppressing
    // the whole section instead took the way out to the actual review with it,
    // on 662 of 823 books.
    const quote = fresh?.standfirst || '';

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
        ${jacket(e, 'dossier')}
        <div>
          <p class="dossier-score">
            ${!hasProfile()
              ? `<span class="dossier-state" data-state="none">${esc(sourceLine(e))}</span>`
              : `${scored ? `<b>${shownScore(e, s).toFixed(1)}<small>FIT</small></b>` : ''}
            <span class="dossier-state" data-state="${scored && rec ? 'rec' : 'none'}">${
              scored ? (rec ? 'Recommended for you' : 'Below your threshold') :
              status === 'reviewed-unscored' ? 'Described · no score' : 'Not yet described'}</span>
            ${scored && !readTheReview(e) ? '<span class="dossier-state" data-state="none">Length and press only</span>'
              : scored && fromAuthor(e) ? '<span class="dossier-state" data-state="none">From the author’s account</span>' : ''}`}
          </p>
          <h2 id="dossier-title">${esc(b.title)}</h2>
          ${b.author ? `<p class="dossier-author">${esc(b.author)}</p>` : ''}
          ${facts ? `<p class="dossier-facts">${esc(facts)}</p>` : ''}
        </div>
      </div>

      <div class="dossier-actions">
        <button class="btn ${on ? '' : 'btn-solid'}" data-action="save" data-id="${esc(e.id)}" aria-pressed="${on}">
          ${ico('bookmark')}<span>${on ? 'On your shelf' : 'Save to shelf'}</span></button>
        <button class="btn" data-action="pass" data-id="${esc(e.id)}" aria-pressed="${passed(e)}">${
          passed(e) ? 'Passed — put it back' : 'Pass for now'}</button>
      </div>

      <section class="dossier-block">
        <p class="eyebrow">${!hasProfile() ? 'What this book is' : scored ? 'The case for it' : 'What is known'}</p>
        ${hasProfile() ? `<h3>${whyHtml(e, s, 4) || esc(caseFor(e, s))}</h3>` : ''}
        ${blurb ? `<p>${esc(blurb)}</p>` : ''}
      </section>

      ${!hasProfile() ? `<section class="dossier-block">
        <p class="eyebrow">How this book is described</p>
        ${tags.length ? `<div class="tags">${tags.map((t) => `<button class="tag" data-action="tag" data-tag="${esc(t.label)}" data-kind="${esc(t.kind)}"
          aria-label="Show other books tagged ${esc(t.label)}">${esc(t.label)}</button>`).join('')}</div>` : ''}
        <p style="margin-top:14px">These words come from what was written about the book. Answer three questions and they become a score: what each one is worth is the part that is yours.</p>
        <button class="btn btn-solid" style="margin-top:14px" data-action="go" data-view="start">Build your taste profile ${ico('arrow')}</button>
      </section>` : `<section class="dossier-block">
        <p class="eyebrow">${scored ? 'Transparent scoring' : 'Evidence status'}</p>
        <span class="dossier-head-note">Profile v${esc(String(FEED.profileRevision))}</span>
        <h3>${scored ? `Why it earned ${shownScore(e, s).toFixed(1)}` : 'Why there is no score'}</h3>
        <p>${esc(scoreNarrative(e, s))}</p>
        ${scored ? `<p class="dossier-facts" style="margin-top:14px">${
          percentileOf(e, s) != null ? `Top ${Math.max(1, 100 - percentileOf(e, s))}% of your archive` : ''
        } · ${e.score.dimensionsFired} of ${FEED.dimensions.length} dimensions read${
          e.score.shrunk && Math.abs(e.score.shrinkPull || 0) >= 1
            ? ` · pulled ${e.score.shrinkPull > 0 ? 'up' : 'down'} ${Math.abs(e.score.shrinkPull / 10).toFixed(1)} toward the field on thin evidence` : ''
        }</p>` : ''}
        ${scored && fired.length ? `<div class="bars">${fired.map((d) => `<div class="bar-row">
          <span class="bar-name">${esc(d.name)}</span>
          <span class="bar-track"><span class="bar-fill" style="width:${Math.round(d.score * d.weight / maxc * 100)}%"></span></span>
          <span class="bar-val">${d.score}</span></div>`).join('')}</div>` : ''}
        ${tags.length ? `<div class="tags">${tags.map((t) => `<button class="tag" data-action="tag" data-tag="${esc(t.label)}" data-kind="${esc(t.kind)}"
          aria-label="Show other books tagged ${esc(t.label)}">${esc(t.label)}</button>`).join('')}</div>` : ''}
      </section>`}

      ${cited?.reviewUrl ? `<section class="dossier-block">
        <p class="eyebrow">${e.reviewCount > 0 ? 'From the review' : fromAuthor(e) ? 'From the author’s account' : 'From the listing'}</p>
        ${quote ? `<blockquote class="quote">${esc(quote.length > 300 ? `${quote.slice(0, 300).replace(/\s+\S*$/, '')}…` : quote)}
          <span class="quote-source">${esc(cited.source.name)} · ${esc(fmtDate(cited.reviewDate))}${cited.byline ? ` · ${esc(cited.byline)}` : ''}</span>
        </blockquote>`
        : `<p class="dossier-facts">${esc(cited.source.name)} · ${esc(fmtDate(cited.reviewDate))}${cited.byline ? ` · ${esc(cited.byline)}` : ''}</p>`}
        <p><a href="${esc(cited.reviewUrl)}" target="_blank" rel="noopener">${
          e.reviewCount > 0 ? `Read the ${esc(cited.source.short)} review` : `Open the ${esc(cited.source.short)} source`} ↗</a></p>
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
      return 'Something has been written about this book, but it did not supply enough dependable evidence across the eight dimensions to support a number. The book stays visible; the ranking stays blank.';
    }
    if (status === 'awaiting-review') {
      return 'This book is known from a catalogue listing alone — nobody has described it, not a critic and not the author. It can be found and saved now, and it will be placed as soon as anyone writes about it.';
    }
    // A score with nothing from the review behind it needs saying outright, not
    // softening: two of the eight dimensions read the catalogue rather than the
    // prose, and a book where only those fired has been ranked on its length and
    // its publisher.
    if (!readTheReview(e)) {
      const s6 = e.score?.dimensions?.D6, s7 = e.score?.dimensions?.D7;
      const from = [s6 && !s6.defaulted ? 'its length' : null, s7 && !s7.defaulted ? 'its publisher' : null]
        .filter(Boolean).join(' and ') || 'catalogue data';
      const src = e.reviewCount > 0 ? 'the review' : 'the description';
      return `Nothing in ${src} spoke to the profile. This number is built from ${from} alone, so it is a placeholder for a reading rather than one.`;
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

  // A switch and a band score take effect the moment they are changed. Only the
  // seven weights wait for Save, because only they have to add up to something.
  function setOverride(group, key, value) {
    const next = { ...overrides, [group]: { ...overrides[group] } };
    if (value === null || value === undefined) delete next[group][key];
    else next[group][key] = value;
    overrides = sync.stamp(next);
    write(OVERRIDES_KEY, overrides);
    profileVersion++;
    render();
    syncNow();
  }

  function toggleGuardrail(i) {
    const g = GUARDRAILS[i];
    setOverride(g.group, g.key, guardrailOn(g) ? false : null);
  }

  function setAversion(key, strength) {
    const next = { ...overrides, aversions: { ...overrides.aversions } };
    if (strength === 'off') delete next.aversions[key];
    else if (Object.keys(next.aversions).length >= MAX_AVERSIONS && !next.aversions[key]) {
      toast(`That is ${MAX_AVERSIONS} already. Take one off first.`, { error: true });
      return;
    } else next.aversions[key] = strength;
    overrides = sync.stamp(next);
    write(OVERRIDES_KEY, overrides);
    profileVersion++;
    render();
    syncNow();
  }

  function togglePenalty(id) {
    const f = penalties().find((x) => x.id === id);
    if (f) setOverride('adjustments', f.id, penaltyOn(f) ? false : null);
  }

  function setBand(dimId, bandId, value) {
    const d = FEED.dimensions.find((x) => x.id === dimId);
    const b = (d?.bands || []).find((x) => x.id === bandId);
    if (!b) return;
    const n = Math.max(0, Math.min(10, Math.round(Number(value))));
    if (!Number.isFinite(n)) return;
    setOverride('bands', bandKey(dimId, bandId), n === b.score ? null : n);
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
    // A sync replaces the weights, so it is a profile change like any other.
    // This was the one path that changed them without saying so, which cost
    // nothing while everything recomputed on every render and would have shown
    // a stale answer the moment anything was cached against the version.
    profileVersion++;
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

  // `user` is the truth once Firebase has answered; before that, the remembered
  // account is, and only for a reader who was signed in when they left. Pulled
  // out because the reminder band and the first-visit prompt both have to ask it
  // without repainting the chrome.
  const signedInNow = () => Boolean(user)
    || (Boolean(read(ACCOUNT_KEY, null)) && read(sync.RETURNING_KEY, false) === true);

  // An ordering of the reader's own, living in one browser and nowhere else. Not
  // a failure — nothing is broken and nothing has been lost — but the one thing
  // about this app a reader would be sorry to learn too late, and the only
  // honest reason to ask a stranger for an account.
  // What to do when a reader reaches for something an account is required for.
  //
  // The two of these were a toast — a line of text at the bottom of the screen
  // saying sign in first, with no way to do it from where it appeared. A reader
  // who wanted the weekly roundup had to read the toast, find the sidebar, and
  // start again. `why` names the specific thing they were reaching for, because
  // "sign in" without it is a demand rather than an answer.
  //
  // The button carries `data-auth`, so it is warmed on pointerdown and signs in
  // on click through the paths that already exist. Google's window has to open
  // inside the gesture; a button that first downloads a script gets eaten.
  function needAuth(heading, why) {
    const dlg = $('needauth');
    if (!dlg?.showModal) { toast(why); return; }
    $('needauth-title').textContent = heading;
    $('needauth-why').textContent = why;
    if (!dlg.open) dlg.showModal();
  }

  const profileAtRisk = () => !signedInNow() && !isEmpty(overrides);

  // Whether this reader has said anything about themselves yet. Everything that
  // claims to be about them is gated on it.
  //
  // The app ships with one real reader's profile — weights, bands, the lot —
  // because a scorer needs numbers to run and those are the numbers it was built
  // and calibrated against. That is defensible for the build and indefensible
  // for a stranger: a first visit was showing somebody else's taste under the
  // heading "For you", their weights on a screen called Profile, and a number
  // out of ten that measured fit to a person the reader has never met. The books
  // are a public archive and stay browsable. The opinions are not, until there
  // is somebody to have them.
  const hasProfile = () => !isEmpty(overrides);

  const AT_RISK_LABEL = 'Your profile is saved in this browser only. Sign in with Google to keep it.';

  function showAuth({ failing = false } = {}) {
    const account = read(ACCOUNT_KEY, null);
    const signedIn = signedInNow();
    const name = user ? (user.displayName || user.email || 'your account') : account?.name;
    const word = signedIn ? 'Sign out' : 'Sign in';
    // Standing, and deliberately not dismissable: it stops being shown by signing
    // in, which is the only thing that stops it being true.
    const atRisk = profileAtRisk();

    $('auth-word').textContent = word;
    for (const el of $$('[data-auth] > span')) el.textContent = word;
    for (const el of $$('[data-at-risk]')) el.hidden = !atRisk;
    $('auth').setAttribute('aria-label', signedIn ? `Signed out of ${name}` : atRisk ? AT_RISK_LABEL : 'Sign in with Google');

    // The dot is a mark; this is the sentence behind it, beside the control that
    // fixes it. A mark nobody can get an explanation for is worse than no mark.
    const note = !signedIn
      ? (atRisk
        ? 'Your profile and your saved books are in this browser only. Sign in to keep them, and to read the same feed on your other devices.'
        : 'Saves stay on this device until you sign in.')
      : failing
        ? `Signed in as ${name}. Not syncing right now — your books are safe on this device.`
        : `Signed in as ${name}. Your books sync across your devices.`;
    $('auth-note').textContent = note;
    for (const el of $$('[data-auth-note]')) el.textContent = note;
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

  // ------------------------------------------------------ asking, once and again

  // A stranger's first minute is the only one where interrupting them is
  // affordable, and it is also the one where it is warranted: every number on
  // screen is ranked against one reader's taste, and nothing says so until you
  // go looking on the Profile screen. So this says it once, offers the two
  // minutes that fix it, and never asks again.
  //
  // It leads with the profile rather than the account because the profile is
  // what a stranger actually gains, and it needs no account at all. Signing in
  // is offered underneath for what it really buys: not losing the thing they are
  // about to build.
  const FIRSTRUN_KEY = 'litfeed:firstrun';
  const FIRSTRUN_MS = 20000;
  const REMIND_HIDDEN_KEY = 'litfeed:remind-hidden';
  let promptSpentBefore = false;

  const remindHidden = () => {
    try { return sessionStorage.getItem(REMIND_HIDDEN_KEY) === '1'; } catch { return false; }
  };

  // What the prompt leaves behind. A reader asked once who comes back without a
  // profile is reading a feed ranked against somebody else's taste, and the
  // likeliest reason is that they were mid-something and closed the dialog
  // rather than that they weighed it and declined. So it is said again, quietly,
  // in the flow rather than over the top of anything.
  function showRemind() {
    const el = $('remind');
    if (!el) return;
    el.hidden = !(promptSpentBefore && isEmpty(overrides) && !signedInNow()
      && !remindHidden() && state.view !== 'start');
  }

  function bindOnboarding() {
    $('remind-build').addEventListener('click', () => setView('start'));
    $('remind-hide').addEventListener('click', () => {
      // The visit, not for ever. A permanent dismissal would be the third time
      // this reader is asked the same question, and a reminder they cannot quiet
      // for an afternoon is the kind that gets the site closed.
      try { sessionStorage.setItem(REMIND_HIDDEN_KEY, '1'); } catch { /* private mode: it stays up */ }
      showRemind();
    });
    showRemind();

    const dlg = $('firstrun');
    // No <dialog> support, no prompt. A modal faked out of a div is one more way
    // for a first visit to go wrong, and the app is complete without this.
    if (!dlg || typeof dlg.showModal !== 'function') return;
    if (read(FIRSTRUN_KEY, false) === true) return;
    // A reader who already has an ordering of their own, or is already signed in,
    // has had this conversation.
    if (!isEmpty(overrides) || signedInNow()) { write(FIRSTRUN_KEY, true); return; }

    // Foreground time, not wall clock. A tab opened and left behind three others
    // has read nothing, and a dialog waiting there is an ambush rather than an
    // offer.
    let ms = 0;
    let last = Date.now();
    let timer = null;
    const stop = () => { clearInterval(timer); timer = null; };
    const spent = () => { write(FIRSTRUN_KEY, true); stop(); };

    // The key records that the question was asked, not that it was answered, and
    // it is written the moment the dialog is shown rather than when it closes.
    // Escape, the backdrop and the three buttons then all cost nothing to get
    // right, and there is no exit that can leave a reader open to being asked a
    // second time. Closing writes it too, which is redundant and free — except
    // where a `close` event never arrives, which is a real browser and the
    // reason this does not depend on one.
    dlg.addEventListener('close', spent);
    document.addEventListener('visibilitychange', () => { last = Date.now(); });

    timer = setInterval(() => {
      const now = Date.now();
      if (document.hidden) { last = now; return; }
      ms += now - last;
      last = now;
      if (ms < FIRSTRUN_MS) return;
      stop();
      // Twenty seconds is long enough for the reader to have got there on their
      // own, or to be reading the builder already. Either way the offer is moot.
      if (state.view === 'start' || !isEmpty(overrides) || signedInNow()) { spent(); return; }
      spent();
      dlg.showModal();
    }, 500);

    $('firstrun-build').addEventListener('click', () => { dlg.close(); setView('start'); });
    // Sign in and go, without waiting on the popup or the round trip.
    //
    // The order is the point: an account attached before the first question
    // means the profile is kept as it is built, rather than the reader being
    // asked a second time once they have something to lose. The builder is where
    // they were headed either way, the profile does not need the account to be
    // built, and a sign-in that fails should leave them building rather than
    // stranded on an error.
    $('firstrun-signin').addEventListener('click', () => { dlg.close(); doAuth(); setView('start'); });
    $('firstrun-later').addEventListener('click', () => dlg.close());
    // Return runs the search and blurs the field. Blurring is the whole point on
    // a phone: it is what puts the keyboard away, and until it did, the results
    // were behind it. `enterkeyhint="search"` labels the key.
    document.addEventListener('submit', (ev) => {
      if (ev.target.id !== 'askform') return;
      ev.preventDefault();
      $('sq')?.blur();
      queueSearch({ now: true });
    });

    $('needauth-later').addEventListener('click', () => $('needauth').close());
    // Signing in from the dialog closes it. doAuth is already bound to every
    // [data-auth] control and re-renders on its own.
    $('needauth-signin').addEventListener('click', () => $('needauth').close());
  }

  // ------------------------------------------------------------ navigation

  const VIEWS = {
    foryou: viewForYou,
    search: viewSearch,
    feed: viewFeed,
    all: viewAll,
    saved: viewSaved,
    taste: viewTaste,
    profile: viewProfile,
    start: viewStart,
  };

  // ------------------------------------------------------------ history
  //
  // The back gesture is the navigation on a phone, and this app had no history
  // at all: every section swap and every dossier happened inside one entry, so
  // swiping back left the app entirely and swiping forward could not bring you
  // to where you were.
  //
  // The URL is deliberately not touched. Putting the section in a hash would
  // make a copied address open on whatever screen the copier was looking at,
  // and a link to this app has to open the app — the same reason the last
  // session's view is not restored from storage. What is pushed is state, so
  // back and forward work for the length of a visit and a shared address still
  // opens the front.
  //
  // The dossier is an entry of its own, which is the part that pays for itself:
  // a book opened on a phone closes with the gesture the reader already uses
  // rather than by finding a small × in a corner.
  const historyState = () => ({ view: state.view, dossier: dossierOpenId() || null });

  function pushHistory() {
    // A file:// page has no usable history and throws on pushState. The app
    // already refuses to run there, but this must not be what breaks first.
    try { history.pushState(historyState(), ''); } catch { /* not served over http */ }
  }

  function setView(view) {
    if (!VIEWS[view]) return;
    if (view === state.view && !dossierOpenId()) return;
    applyView(view);
    pushHistory();
  }

  function applyView(view) {
    if (!VIEWS[view]) return;
    if (!$('dossier').hidden) shutDossier();
    state.view = view;
    state.openMenu = null;
    state.limit = ROW_PAGE;
    state.allLimit = CARD_PAGE;
    state.searchLimit = SEARCH_PAGE;
    clearTimeout(searchTimer);
    state.searching = false;
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
    // The reminder and the at-risk mark both turn on whether this reader has an
    // ordering of their own, so they are set wherever that can have changed
    // rather than left until the next thing that happens to repaint the chrome.
    showRemind();
    showAuth();
  }

  function render() {
    setStatusCard();
    computeStats();
    rankAll();
    const root = $('view-root');
    root.innerHTML = `<div class="view">${VIEWS[state.view]()}</div>`;
    // The strip lives outside view-root so it stays put while the page under it
    // scrolls, and it is only drawn on the page it belongs to.
    const strip = $('weekpick-slot');
    const stripHtml = state.view === 'foryou' ? weekStrip() : '';
    strip.innerHTML = stripHtml;
    strip.hidden = !stripHtml;
    bindJackets(strip);
    bindJackets(root);
    bindMore();
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
        case 'kind': state.kind = btn.dataset.value; state.openMenu = null; savePrefs(); render(); break;
        case 'tag': {
          state.tag = btn.dataset.tag;
          closeDossier();
          // For you is an edit rather than a list — a spotlight and four picks —
          // so there is nothing there for a filter to act on. Following a tag
          // from it means going to the list where the answer can be shown.
          if (state.view === 'foryou' || state.view === 'saved' || state.view === 'taste' || state.view === 'profile') {
            setView('feed');
          } else {
            render();
          }
          window.scrollTo({ top: 0, behavior: 'smooth' });
          announce(`Filtered to books tagged ${state.tag}.`);
          break;
        }
        case 'tag-all':
          // Everything with this tag, not only what scored well: the scope goes
          // back to the whole archive, because a reader asking for every book on
          // a subject is asking past their own profile on purpose.
          state.allScope = 'any';
          setView('all');
          window.scrollTo({ top: 0, behavior: 'smooth' });
          break;
        case 'clear-tag': state.tag = null; render(); announce('Tag filter cleared.'); break;
        case 'unpick': {
          const key = btn.dataset.key;
          answers.liked = answers.liked.filter((k) => k !== key);
          answers.disliked = answers.disliked.filter((k) => k !== key);
          write(ANSWERS_KEY, answers);
          // Rebuilding rather than subtracting: the weights are a function of the
          // whole set of answers, so taking one out by hand would leave numbers
          // that no set of picks would ever have produced.
          if (answersReady(answers).ready) {
            const built = buildProfile(profileForOverrides(), answers);
            overrides = sync.stamp({ ...built, weights: normalizeWeights(built.weights) });
            write(OVERRIDES_KEY, overrides);
            profileVersion++;
            state.draftWeights = null;
            syncNow();
            toast('Removed. Every score has been recalculated.');
          } else {
            toast('Removed. Too few left to build a profile — add some back.');
          }
          render();
          break;
        }
        case 'scope':
          if (state.view === 'all') state.allScope = btn.dataset.value;
          else state.scope = btn.dataset.value;
          state.openMenu = null; savePrefs(); render();
          break;
        case 'toggle': state[btn.dataset.value] = !state[btn.dataset.value]; savePrefs(); render(); break;
        case 'clear':
          state.q = ''; state.recommendedOnly = false; state.shortOnly = false;
          state.tag = null; state.kind = 'any';
          state.scope = 'any'; state.allScope = 'any';
          savePrefs(); render();
          break;
        case 'more-rows': state.limit += ROW_PAGE; render(); break;
        case 'more-search': state.searchLimit += SEARCH_PAGE; render(); break;
        case 'clear-search':
          state.sq = ''; state.sqRun = ''; state.searchLimit = SEARCH_PAGE; render();
          $('sq')?.focus();
          announce('Search cleared.');
          break;
        case 'example':
          state.sq = btn.dataset.q;
          queueSearch({ now: true });
          break;
        case 'more-cards': state.allLimit += CARD_PAGE; render(); break;
        case 'save-profile': saveProfile(); break;
        case 'roundup': toggleRoundup(); break;
        case 'guardrail': toggleGuardrail(Number(btn.dataset.guardrail)); break;
        case 'penalty': togglePenalty(btn.dataset.penalty); break;
        case 'export': exportVerdicts(); break;
        case 'build-profile': applyBuiltProfile(); break;
        case 'reads':
          answers.reads = btn.dataset.value;
          // Switching to fiction drops the subject chips, so any that were picked
          // have to go with them rather than sit in the profile unseen.
          {
            const keep = new Set(chipsFor(answers.reads).map((c) => `${c.dim}:${c.band}`));
            answers.liked = answers.liked.filter((k) => keep.has(k));
            answers.disliked = answers.disliked.filter((k) => keep.has(k));
          }
          render();
          break;
        case 'pick': {
          const { which, key } = btn.dataset;
          const list = answers[which];
          const i = list.indexOf(key);
          if (i >= 0) list.splice(i, 1); else list.push(key);
          // A band cannot be both liked and disliked, so picking one side drops
          // the other rather than letting the two overrides fight.
          const other = which === 'liked' ? 'disliked' : 'liked';
          answers[other] = answers[other].filter((k) => k !== key);
          render();
          break;
        }
        case 'satire': answers.satire = !answers.satire; render(); break;
        case 'refuse': {
          const k = btn.dataset.key;
          const i = answers.refused.indexOf(k);
          if (i >= 0) answers.refused.splice(i, 1);
          else if (answers.refused.length < MAX_AVERSIONS) answers.refused.push(k);
          render();
          break;
        }
        case 'aversion': setAversion(btn.dataset.key, btn.dataset.strength); break;
        // No preventDefault: the anchor navigates itself. It carries a data-action
        // only so that the row it sits inside — which is a button, and would
        // otherwise catch the click and open the dossier instead — loses the
        // closest() race to it.
        case 'review':
          analytics.track('review_opened', { bookId: btn.dataset.id, source: btn.dataset.source });
          break;
        case 'buy':
          write('litfeed:last-retailer', btn.dataset.retailer);
          analytics.track('retailer_opened', { bookId: btn.dataset.id, retailer: btn.dataset.retailer, resolution: btn.dataset.resolution });
          break;
        default: break;
      }
    });

    document.addEventListener('change', (ev) => {
      const el = ev.target;
      if (el.dataset?.bandDim) setBand(el.dataset.bandDim, el.dataset.bandId, el.value);
    });

    // Search filters as the reader types. The field is re-created on every
    // render, so the caret and the focus are restored by hand.
    document.addEventListener('input', (ev) => {
      if (ev.target.id === 'sq') {
        state.sq = ev.target.value;
        queueSearch();
        return;
      }
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

    // Google's window is opened from inside the click, and a browser only allows
    // that from a gesture — a click that first waits for a script to download is
    // a click the popup blocker eats. `pointerdown` fires before it and is still
    // the reader reaching for the button, so nothing is fetched for anyone who
    // never does. Signed in, the button signs out and needs none of this.
    const warmAuth = () => { if (!signedInNow()) sync.warm().catch(() => {}); };
    for (const el of [$('auth'), $('firstrun-signin'), ...$$('[data-auth]')]) {
      el.addEventListener('pointerdown', warmAuth, { passive: true });
    }
    $('auth').addEventListener('click', doAuth);
    for (const el of $$('[data-auth]')) el.addEventListener('click', doAuth);
    $('scrim').addEventListener('click', closeDossier);
    window.addEventListener('scroll', queueMore, { passive: true });
    window.addEventListener('resize', queueMore, { passive: true });

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
    // Whether this device already holds a subscription, asked once. It touches
    // no network and loads no SDK — the answer is in the browser's own service
    // worker registration — so it costs a reader who has never turned this on
    // nothing at all.
    push.current().then((sub) => { if (sub) { roundupOn = true; render(); } }).catch(() => {});

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

    // Is this copy of the app the one that was published?
    //
    // index.html is the entry point, so it cannot carry a version stamp of its
    // own, and GitHub Pages serves it with max-age=600 and gives no way to
    // change that. An installed web app has no reload gesture either — swiping
    // it away closes the window and leaves the cache where it was — so a reader
    // can be left running an old build with no way to escape it. That is exactly
    // what happened, twice in one evening.
    //
    // feed.json is fetched with `cache: 'no-cache'`, so it is the one file that
    // is always current, and the publish stamps the build's version into it.
    // A mismatch means the HTML this page came from is stale, and the fix is one
    // reload at a URL the cache has never seen.
    //
    // Guarded by the session so a version that somehow never matches reloads
    // once and then gives up, rather than spinning.
    const mine = new URL(import.meta.url).searchParams.get('v');
    if (FEED.assetVersion && mine && FEED.assetVersion !== mine) {
      const already = sessionStorage.getItem('litfeed:freshenedTo');
      if (already !== FEED.assetVersion) {
        try { sessionStorage.setItem('litfeed:freshenedTo', FEED.assetVersion); } catch { /* private mode */ }
        location.replace(`${location.pathname}?v=${encodeURIComponent(FEED.assetVersion)}`);
        return;
      }
    }

    loadPrefs();
    loadOverrides();
    openVisit();
    retune();

    // The status card asserts a profile version and a recommend threshold. Both
    // are true of the build and neither is true of a reader who has not answered
    // anything, so before there is a profile it reports the archive instead —
    // which is the thing that does exist.
    setStatusCard();
    $('rebuilt-line').textContent = rebuiltPhrase(FEED.builtAt);

    bindGlobal();
    showAuth();
    render();

    // The entry the visit starts on. Without it the first back gesture reads a
    // null state and there is nothing to restore to.
    try { history.replaceState(historyState(), ''); } catch { /* not served over http */ }
    window.addEventListener('popstate', (ev) => {
      // Both directions land here, and neither may push: the browser has already
      // moved the pointer, and pushing on top of it would make forward
      // unreachable and back a loop.
      const to = ev.state || { view: 'foryou', dossier: null };
      if (to.dossier) {
        if (dossierOpenId() !== to.dossier) {
          if (to.view && to.view !== state.view) applyView(to.view);
          openDossier(to.dossier, { push: false });
        }
        return;
      }
      if (!$('dossier').hidden) shutDossier();
      if (to.view && to.view !== state.view) applyView(to.view);
    });

    // Read before bindOnboarding, which writes this key: the reminder is for the
    // visit after the one that spent the prompt, not for the same one.
    promptSpentBefore = read(FIRSTRUN_KEY, false) === true;
    bindOnboarding();
  }

  boot();
})();
