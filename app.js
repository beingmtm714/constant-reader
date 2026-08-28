/* Ruskin — reads data/feed.json, sorts, filters, explains. See DESIGN.md. */
import * as saved from './lib/saved-books.mjs';
import { RETAILERS, linkFor, canFindCopy } from './lib/retailers.mjs';
import { createAnalytics } from './lib/analytics.mjs';
import { buildTasteModel, tunedTotal, weightProposal, MIN_SIGNAL, MAX_ADJUSTMENT } from './lib/taste.mjs';
import { outOfTen, RECOMMEND_AT } from './lib/recommend.mjs';
import { rescore, summarize, isEmpty, bandKey, EMPTY as EMPTY_OVERRIDES } from './lib/overrides.mjs';
import { CHIPS, buildProfile } from './lib/onboard.mjs';

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const VERDICT_KEY = 'litfeed:verdicts';
  const PREFS_KEY = 'litfeed:prefs';
  // The reader's own ordering, kept apart from prefs because it is a different kind
  // of thing: prefs are how the feed is displayed, this is what the scores mean.
  const OVERRIDES_KEY = 'litfeed:overrides';
  let overrides = { ...EMPTY_OVERRIDES };
  const THEME_KEY = 'litfeed:theme';
  const EVENTS_KEY = 'litfeed:events';
  const RETAILER_KEY = 'litfeed:last-retailer';

  // No affiliate programme has been approved for this app, so nothing is
  // configured and every link goes out clean. If one ever is, the id belongs
  // here keyed by retailer and the link builder picks it up — see
  // lib/retailers.mjs, which refuses to write an empty tracking parameter.
  const AFFILIATES = {};

  let FEED = null;
  // One store for both verdicts. Anything written by a build from before saves
  // carried a timestamp is upgraded on the way in.
  let verdicts = saved.migrate(read(VERDICT_KEY, {}));
  let openRow = null;
  let openChooser = null;
  let toastTimer = null;

  const analytics = createAnalytics({
    load: () => read(EVENTS_KEY, []),
    store: (log) => write(EVENTS_KEY, log),
  });

  // An order is one decision, so it is one control. The comparator still takes a
  // primary and a secondary key with a direction each, because sorting a feed of
  // reviews genuinely needs both — a column of books all reviewed the same week
  // has to break its ties on something. What was wrong was asking the reader to
  // assemble that from four selects. These five are the orders worth having, and
  // each one names what you get rather than the field it sorts on.
  const ORDERS = {
    latest:    { label: 'newest reviews',  sort1: 'reviewDate', dir1: 'desc', sort2: 'bookDate',   dir2: 'desc' },
    fit:       { label: 'best fit',        sort1: 'score',      dir1: 'desc', sort2: 'reviewDate', dir2: 'desc' },
    published: { label: 'newest books',    sort1: 'bookDate',   dir1: 'desc', sort2: 'reviewDate', dir2: 'desc' },
    reviewed:  { label: 'most reviewed',   sort1: 'reviews',    dir1: 'desc', sort2: 'reviewDate', dir2: 'desc' },
    title:     { label: 'title A–Z',       sort1: 'title',      dir1: 'asc',  sort2: 'none',       dir2: 'asc'  },
  };

  const state = {
    q: '', order: 'latest',
    sort1: 'reviewDate', dir1: 'desc', sort2: 'bookDate', dir2: 'desc',
    minPages: null, minScore: null, sources: new Set(), tag: null,
    window: true, nonfiction: false, identity: false, penalised: false,
    recommendedOnly: false, group: false, unseen: false,
    view: 'feed', savedSort: 'recent', tune: true,
  };

  // Rebuilt whenever the verdicts change, which is what makes a save feel like
  // it did something: the feed re-ranks on the next render with no rebuild.
  let taste = null;
  const retune = () => { taste = buildTasteModel(verdicts, FEED?.books || [], FEED?.dimensions || []); };

  // The score a row is sorted and displayed by. With tuning off, or before there
  // is enough signal to learn from, this is exactly the profile's own number.
  // rescore() wants the same profile object the build scored against. Everything it
  // reads travels in feed.json: the dimensions with their bands, the evidence rule
  // and the prose floor.
  const profileForOverrides = () => ({
    dimensions: FEED.dimensions,
    evidenceRule: FEED.evidenceRule,
    proseFloor: FEED.proseFloor,
  });

  // Two layers, in order. The reader's ordering decides what the profile's own
  // number should have been; the saves then tune that number. They compose rather
  // than compete, which is why the override is applied first and handed on as the
  // base rather than added to the result.
  //
  // The taste model is still built from the profile's dimension vectors rather than
  // the overridden ones. A reader who re-scores a band changes what a book is
  // worth, not what it resembles, and nearest-neighbour asks about resemblance.
  function scoreOf(e) {
    const o = rescore(e.score, profileForOverrides(), overrides);
    const overridden = Boolean(o.changed);
    const base = overridden ? o.total : e.score.total;
    if (!state.tune || !taste?.ready) {
      return { base, delta: 0, total: base, reasons: [], nearest: null, tuned: false, overridden, profileBase: e.score.total };
    }
    // tunedTotal reads entry.score.total, so it has to be handed the overridden
    // number rather than left to read the profile's straight off the entry.
    const ent = overridden ? { ...e, score: { ...e.score, total: base, dimensions: o.dimensions } } : e;
    return { ...tunedTotal(ent, taste), overridden, profileBase: e.score.total };
  }

  // Recommendation under tuning follows the same rule the build follows — same
  // rounding, same threshold, same module — so the two can never disagree about
  // what counts. Everything the build refused for a reason other than the score
  // stays refused; tuning only ever moves the number.
  function recommendedNow(e, s) {
    if (!s.overridden && (!state.tune || !taste?.ready)) return e.recommended;
    if (!e.recommended && e.recommendedWhyNot && !/^scores /.test(e.recommendedWhyNot)) return false;
    return outOfTen(s.total) >= RECOMMEND_AT;
  }

  // ------------------------------------------------------------ storage

  function read(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  }
  function write(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
  }

  // Saving a book is the one write whose failure the reader needs to know about,
  // so unlike write() this one throws. Private mode and a full quota both land
  // here, and both mean the save did not happen however the button looks.
  function persist(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  // ------------------------------------------------------------ theme

  function initTheme() {
    const saved = read(THEME_KEY, null);
    if (saved) document.documentElement.dataset.theme = saved;
    $('theme').addEventListener('click', () => {
      const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      const current = document.documentElement.dataset.theme || (dark ? 'dark' : 'light');
      const next = current === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      write(THEME_KEY, next);
    });
  }

  // ------------------------------------------------------------ saving

  function toast(message, { error = false, retry = null } = {}) {
    const el = $('toast');
    el.classList.toggle('is-error', error);
    el.innerHTML = esc(message) + (retry ? ' <button class="btn" id="toast-retry">Try again</button>' : '');
    el.hidden = false;
    if (retry) $('toast-retry').addEventListener('click', () => { el.hidden = true; retry(); });
    clearTimeout(toastTimer);
    // An error with something to do about it stays until it is dealt with.
    if (!retry) toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
  }

  // Optimistic: the list changes and the screen redraws first, and only then is
  // the write attempted. If it throws, the previous list goes back exactly as it
  // was and the reader is told, with the same action offered again.
  function commit(next, { onOk, onFail }) {
    const previous = verdicts;
    verdicts = next;
    retune();
    render();
    try {
      persist(VERDICT_KEY, next);
      onOk?.();
    } catch {
      verdicts = previous;
      retune();
      render();
      onFail?.();
    }
  }

  function setSaved(bookId, wantSaved, surface) {
    const entry = FEED.books.find((x) => x.id === bookId);
    const next = wantSaved ? saved.save(verdicts, bookId) : saved.unsave(verdicts, bookId);
    commit(next, {
      onOk: () => {
        toast(wantSaved ? 'Saved for later.' : 'Removed from saved books.');
        analytics.track(wantSaved ? 'book_saved' : 'book_unsaved',
          { bookId, surface, score: entry?.outOfTen ?? undefined });
      },
      onFail: () => toast(
        wantSaved ? 'That book could not be saved.' : 'That book could not be removed.',
        { error: true, retry: () => setSaved(bookId, wantSaved, surface) }),
    });
  }

  // 'passed' shares the verdict store, so it takes the same optimistic path.
  function setVerdict(bookId, verdict) {
    const next = saved.setVerdict(verdicts, bookId, verdict);
    commit(next, {
      onFail: () => toast('That could not be saved to this browser.', {
        error: true, retry: () => setVerdict(bookId, verdict),
      }),
    });
  }

  // The bookmark is filled when saved and outlined when not, so the state is
  // carried by the shape as well as by the label — never by colour alone.
  function saveButton(e, surface) {
    const on = saved.isSaved(verdicts, e.id);
    const label = on ? 'Remove from saved books' : 'Save book';
    const glyph = on
      ? '<path d="M4 1h8a1 1 0 0 1 1 1v13l-5-3.5L3 15V2a1 1 0 0 1 1-1z" fill="currentColor"/>'
      : '<path d="M4 1h8a1 1 0 0 1 1 1v13l-5-3.5L3 15V2a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.5"/>';
    return `<button class="btn icon-btn js-save${on ? ' is-on' : ''}" data-id="${esc(e.id)}"
      data-surface="${esc(surface)}" data-want="${on ? 'unsave' : 'save'}"
      aria-pressed="${on}" aria-label="${label}" title="${label}">
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">${glyph}</svg>
      <span class="icon-btn-text">${on ? 'Saved' : 'Save'}</span>
    </button>`;
  }

  // ------------------------------------------------------------ helpers

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

  function reviewTime(e) { return Date.parse(e.lastReviewed || '') || 0; }

  // Book dates are a year, sometimes a month, and sometimes only a guess. Sorting
  // needs one number; the row says which of the three it is.
  function bookTime(e) {
    const y = e.book.bookYear;
    if (!y) return 0;
    let month = 6;
    if (e.book.editionDate) {
      const m = MONTHS.indexOf(String(e.book.editionDate).split(' ')[0].toLowerCase());
      if (m >= 0) month = m + 1;
    }
    return y * 100 + month;
  }

  function fmtDate(iso) {
    if (!iso) return 'undated';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return 'undated';
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function relative(iso) {
    const t = Date.parse(iso || '');
    if (!t) return '';
    const days = Math.round((Date.now() - t) / 86400000);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 30) return `${days}d ago`;
    if (days < 365) return `${Math.round(days / 30)}mo ago`;
    return `${Math.round(days / 365)}y ago`;
  }

  const SORTERS = {
    reviewDate: reviewTime,
    bookDate: bookTime,
    score: (e) => (e.outOfTen == null ? -1 : scoreOf(e).total),
    title: (e) => (e.book.title || '').toLowerCase(),
    reviews: (e) => e.reviewCount || 0,
    none: () => 0,
  };

  function compare(a, b) {
    const primary = cmpKey(a, b, state.sort1, state.dir1);
    if (primary !== 0) return primary;
    if (state.sort2 === 'none' || state.sort2 === state.sort1) return 0;
    return cmpKey(a, b, state.sort2, state.dir2);
  }

  function cmpKey(a, b, key, dir) {
    const fn = SORTERS[key] || SORTERS.reviewDate;
    const x = fn(a), y = fn(b);
    if (x === y) return 0;
    const asc = typeof x === 'string' ? (x < y ? -1 : 1) : (x < y ? -1 : 1);
    return dir === 'asc' ? asc : -asc;
  }

  // ------------------------------------------------------------ filtering

  const identified = (e) => e.identity === 'source-stated' || e.identity === 'catalogue-confirmed';
  const fictionOk = (e) => e.fiction === 'confirmed' || e.fiction === 'likely';

  function visible(e) {
    // Everything reviewed inside the window, scored. The only things held back are
    // reviews with no book behind them, hard-filtered ones, and — by default —
    // books the catalogue calls nonfiction.
    if (!e.book.title) return false;
    if (state.penalised && !e.score.filters.length) return false;
    if (state.recommendedOnly && !recommendedNow(e, scoreOf(e))) return false;
    if (state.identity && !identified(e)) return false;
    if (state.nonfiction && e.fiction === 'nonfiction') return false;
    if (state.window && e.inWindow === false) return false;
    if (state.minScore && (e.outOfTen == null ? 0 : outOfTen(scoreOf(e).total)) < state.minScore) return false;
    if (state.minPages && (!e.book.pages || e.book.pages < state.minPages)) return false;
    if (state.sources.size && !e.mentions.some((m) => state.sources.has(m.source.id))) return false;
    if (state.tag && !(e.tags || []).some((t) => t.id === state.tag)) return false;
    if (state.unseen && saved.verdictOf(verdicts, e.id)) return false;
    if (state.q) {
      const hay = [e.book.title, e.book.author, e.book.publisher,
        ...e.mentions.flatMap((m) => [m.reviewTitle, m.byline, m.source.name, m.standfirst])]
        .filter(Boolean).join(' ').toLowerCase();
      if (!state.q.toLowerCase().split(/\s+/).every((w) => hay.includes(w))) return false;
    }
    return true;
  }

  // ------------------------------------------------------------ rendering

  function bookLine(e) {
    const b = e.book;
    const bits = [];
    bits.push(`<span>${esc(e.sources.join(' · '))}</span>`);
    bits.push(`<span class="sep">·</span><span>${e.reviewCount === 1 ? 'reviewed' : `${e.reviewCount} reviews, latest`} ${esc(fmtDate(e.lastReviewed))}</span>`);
    if (b.bookYear) {
      const guess = b.yearSource === 'inferred-from-review';
      bits.push(`<span class="sep">·</span><span class="${guess ? 'guess' : ''}" title="${esc(yearProvenance(b))}">published ${b.editionDate ? esc(b.editionDate) : b.bookYear}${guess ? '?' : ''}</span>`);
    } else {
      bits.push(`<span class="sep">·</span><span class="guess">publication date unknown</span>`);
    }
    if (b.pages) bits.push(`<span class="sep">·</span><span>${b.pages} pp.</span>`);
    else bits.push(`<span class="sep">·</span><span class="guess">pages unknown</span>`);
    if (b.publisher) bits.push(`<span class="sep">·</span><span>${esc(b.publisher)}</span>`);
    if (b.translator) bits.push(`<span class="sep">·</span><span>tr. ${esc(b.translator)}</span>`);
    return bits.join('');
  }

  function yearProvenance(b) {
    return {
      openlibrary: 'First publication year from Open Library.',
      googlebooks: 'Publication year from Google Books.',
      'review-metadata': 'Edition date printed in the review.',
      'inferred-from-review': 'No catalogue record found. Assumed to be the year it was reviewed.',
    }[b.yearSource] || 'Publication date not established.';
  }

  // How far to trust the row, in one line rather than a second wall of chips.
  //
  // This used to be a row of bordered flags sitting directly above a row of tags
  // that already carried most of the same words: "book unverified" appeared twice
  // on every loose extraction. The chips now carry taste and nothing else, and
  // everything about how much to believe the number is said here, once.
  //
  // e.score.notes has to be in this list. Nothing else on the row shows it, and
  // the profile's amendment on warm endings turns on the note being visible —
  // three points, flagged on the row rather than buried, is the whole point of
  // that tier. Burying it here would reverse a decision the profile records.
  function caveatLine(e) {
    const out = [];
    if (!identified(e)) out.push('book unverified');
    if (e.fiction === 'unknown') out.push('fiction unverified');
    if (e.score.scoredOnPartialEvidence) out.push('thin evidence');
    if (e.inWindow === false) out.push(`outside the ${FEED.windowYears}-year window`);
    if (e.score.proseFloorApplied) out.push('below the prose floor');
    for (const n of e.score.notes || []) out.push(n.label);
    for (const q of e.score.openQuestions || []) out.push(`tests ${q.id}`);
    return out.length ? `<p class="caveat-line">${esc(out.join(' · '))}</p>` : '';
  }

  // What the row says about the book.
  //
  // This used to be `reading.summary`, which describes how a book sits against the
  // profile: what it has that the profile wants, what drags, and which confirmed
  // acquisition it sits nearest. That is a fact about the ranking rather than about
  // the book, and reading a feed of it tells you nothing about what any of these
  // books are. The publication's own standfirst does, it is written by someone who
  // read the thing, and every one of the 283 books in the current archive has one.
  //
  // The fit read has not been deleted. It moved into "Why this score", beside the
  // dimension bars it is built from, which is where the rest of the scoring
  // diagnostics went in the density pass.
  //
  // No model writes this. The sentence belongs to the publication, which is better
  // provenance than anything generated here, and it keeps the build free of a
  // model exactly as the README says it is.
  function describeBook(e) {
    const m = e.mentions.find((x) => (x.standfirst || '').trim()) || e.mentions.find((x) => (x.excerpt || '').trim());
    const text = (m?.standfirst || m?.excerpt || '').trim();
    if (!text) return '';
    let cut = text.length > 320 ? `${text.slice(0, 320).replace(/\s+\S*$/, '')}…` : text;
    // Several feeds publish a teaser cut mid-word - PW's stop dead at 128
    // characters. That is the publication's truncation rather than ours, and an
    // ellipsis says the sentence continues instead of implying it ended there.
    const clipped = cut !== text;
    if (!/[.!?…"'’”)]$/.test(cut)) cut += '…';
    // Clicking the description opens the row, so it carries the cursor and the
    // hover that say so. It is not a tab stop: the title beside it is a real
    // button pointing at the same panel, and so is "Why this score", which is two
    // keyboard routes to the same place already.
    return `<p class="reading js-open-soft">${esc(cut)}${clipped || text.length < 200 ? ' <span class="reading-more">read on</span>' : ''}</p>`;
  }

  // The whole standfirst, however long, plus every other publication's line on the
  // same book. The row shows one of these clipped to 320 characters; opening it is
  // how you get the rest, which is what clicking a description should do.
  function fullDescription(e) {
    const lines = e.mentions
      .map((m) => ({ src: m.source.short, text: (m.standfirst || m.excerpt || '').trim() }))
      .filter((x) => x.text);
    if (!lines.length) return '';
    return `<h3>${lines.length > 1 ? 'What the publications say' : 'What the publication says'}</h3>
      ${lines.map((l) => `<p class="reading">${esc(l.text)}<span class="reading-src">${esc(l.src)}</span></p>`).join('')}`;
  }

  // Every entry in a catalogue has a name on it. Where nothing was extracted and the
  // catalogue's exact-title match names an author, that name is shown: the row
  // already says "book unverified", so the caution is on the row rather than in a
  // blank space where the author should be.
  const authorOf = (e) => e.book.author || e.book.proposedAuthor || '';

  // Chips carry taste. The seven dimension kinds plus the genre a publication
  // filed it under are facts about the book; imprint, attention, caveat, question
  // and rule are facts about the metadata or about our own bookkeeping, and they
  // were three-quarters of the chips on a row. They live in the detail now.
  const CHIP_KINDS = new Set(['genre', 'subject', 'period', 'form', 'prose', 'tone', 'scale', 'press']);
  const chipTags = (e) => (e.tags || []).filter((t) => CHIP_KINDS.has(t.kind));
  const restTags = (e) => (e.tags || []).filter((t) => !CHIP_KINDS.has(t.kind));

  function row(e) {
    const b = e.book;
    const v = saved.verdictOf(verdicts, e.id);
    const title = b.title;
    const isUnresolved = e.score.band === 'unresolved' || e.score.band === 'unscored';

    const s = scoreOf(e);
    const rec = recommendedNow(e, s);
    const shown = isUnresolved ? '—' : outOfTen(s.total);

    return `<li><article class="row" data-id="${esc(e.id)}" data-band="${esc(e.score.band)}" data-rec="${rec}">
      <div class="score">
        <span class="num">${shown}</span>
        <span class="outof">${isUnresolved ? '' : '/ 10'}</span>
        ${rec ? `<button class="rec-mark js-rec" title="Show only recommended">★<span class="sr-only"> Recommended. Show only recommended books.</span></button>` : ''}
        ${s.tuned && !isUnresolved ? tuneMark(s) : ''}
      </div>
      <div>
        <h3 class="title"><button class="js-open" aria-expanded="false" aria-controls="d-${cssId(e.id)}">${esc(title)}${authorOf(e) ? `<span class="author">${esc(authorOf(e))}</span>` : ''}</button></h3>
        <p class="meta">${bookLine(e)}</p>
        ${s.tuned && !isUnresolved ? tuneLine(s) : ''}
        ${describeBook(e)}

        ${isUnresolved ? `<p class="risk">${e.score.band === 'unresolved'
          ? 'No book identified in this review, so it carries no score.'
          : 'Nothing in this review spoke to any dimension of the profile, so it carries no score.'}</p>` : ''}
        ${caveatLine(e)}
        <div class="row-links">
          <button class="btn js-why" aria-expanded="false" aria-controls="d-${cssId(e.id)}">Why this score</button>
          <a class="btn" href="${esc(e.mentions[0].reviewUrl)}" target="_blank" rel="noopener">${esc(e.mentions[0].source.short)}${e.reviewCount > 1 ? ` +${e.reviewCount - 1}` : ''}</a>
          ${findCopyHtml(e, 'feed')}
        </div>
        <div class="chooser" id="${chooserId(e, 'feed')}" hidden></div>
        <div class="detail" id="d-${cssId(e.id)}" hidden></div>
      </div>
      <div class="row-actions">
        ${saveButton(e, 'feed')}
        <button class="btn js-verdict ${v === 'passed' ? 'is-on' : ''}" data-verdict="passed" aria-pressed="${v === 'passed'}">Pass</button>
      </div>
    </article></li>`;
  }

  const cssId = (s) => String(s).replace(/[^a-z0-9]/gi, '-');

  function detail(e) {
    const dims = Object.values(e.score.dimensions);
    const dimHtml = dims.map((d) => `
      <div class="dim${d.defaulted ? ' is-default' : ''}">
        <span class="dim-id">${esc(d.dimension)}<br><span style="opacity:.7">×${d.weight}</span></span>
        <span class="dim-label">${esc(d.name)} — ${esc(d.label)}
          ${d.why ? `<span class="why">${esc(d.why)}</span>` : ''}
          ${(d.evidence || []).length ? `<span class="ev">${esc((d.evidence || []).slice(0, 8).join(' · '))}</span>` : ''}
          <span class="dim-track"><span class="dim-fill" style="width:${d.score * 10}%"></span></span>
        </span>
        <span class="dim-score">${d.score}</span>
      </div>`).join('');

    const adj = (e.score.adjustments || []).map((a) => `<li><span class="pts ${a.points > 0 ? 'plus' : ''}">${a.points > 0 ? '+' : ''}${a.points}</span> ${esc(a.label)} <span style="opacity:.6">${esc((a.evidence || []).slice(0, 4).join(', '))}</span></li>`).join('');

    const b = e.book;
    const meta = [
      ['Title', b.title + (b.subtitle ? `: ${b.subtitle}` : '')],
      ['Author', b.author || 'not extracted'],
      b.translator ? ['Translator', b.translator] : null,
      ['Publisher', b.publisher || 'unknown'],
      ['Pages', b.pages ? String(b.pages) : 'unknown — D6 fell back to its default'],
      ['Published', b.bookYear ? `${b.editionDate || b.bookYear} — ${yearProvenance(b)}` : 'unknown'],
      ['Fiction', `${e.fiction} — ${e.score.fiction?.why || ''}`],
      ['Identified by', `${b.extraction.method} (${e.identity})`],
      b.catalogueNote ? ['Catalogue', b.catalogueNote] : null,
      (b.alsoReviewed || []).length ? ['Also reviewed', b.alsoReviewed.join('; ')] : null,
    ].filter(Boolean);

    const mentionRows = e.mentions.map((m) => `<li>
      <a href="${esc(m.reviewUrl)}" target="_blank" rel="noopener">${esc(m.reviewTitle)}</a>
      <span style="opacity:.7"> — ${esc(m.source.name)}${m.byline ? `, ${esc(m.byline)}` : ''}, ${esc(fmtDate(m.reviewDate))}</span>
      <span style="opacity:.5"> · ${esc(m.extraction.method)}</span>
    </li>`).join('');

    const risk = (e.score.risk || []).slice(0, 3);
    const rest = restTags(e);

    return `
      ${fullDescription(e)}
      <div class="detail-actions">
        ${e.mentions.map((m) => `<a class="btn" href="${esc(m.reviewUrl)}" target="_blank" rel="noopener">Read the ${esc(m.source.short)} review</a>`).join('')}
        ${b.openLibraryUrl ? `<a class="btn" href="${esc(b.openLibraryUrl)}" target="_blank" rel="noopener">Catalogue</a>` : ''}
        ${findCopyHtml(e, 'detail')}
      </div>
      <div class="chooser" id="${chooserId(e, 'detail')}" hidden></div>

      ${e.reading?.summary ? `<h3>How it sits against the profile</h3>
        <p class="reading">${esc(e.reading.summary)}</p>` : ''}
      ${risk.length || e.reading?.caveats?.length ? `<h3>How far to trust it</h3>
        ${risk.map((r) => `<p class="risk">${esc(r)}</p>`).join('')}
        ${e.reading?.caveats?.length ? `<p class="reading-caveat">${esc(e.reading.caveats.join(' '))}</p>` : ''}` : ''}
      <h3>How the score was built</h3>
      <div class="dims">${dimHtml}</div>
      ${adj ? `<h3>Adjustments</h3><ul class="adjust">${adj}</ul>` : ''}
      ${(e.score.notes || []).length ? `<h3>Noted, at no cost</h3><ul class="adjust">${e.score.notes.map((n) => `<li><span class="pts" style="color:var(--ink-faint)">0</span> ${esc(n.label)} <span style="opacity:.6">${esc((n.evidence || []).slice(0, 5).join(', '))}</span></li>`).join('')}</ul>` : ''}
      ${e.score.proseFloorApplied ? `<h3>Prose floor</h3><p style="font-family:var(--mono);font-size:.75rem;margin:0">${esc(FEED.proseFloor.note)}</p>` : ''}
      ${e.score.filters.length ? `<h3>Profile rules fired</h3><ul class="adjust">${e.score.filters.map((f) => `<li>${esc(f.label || f.id)} <span style="opacity:.6">${esc((f.evidence || []).slice(0, 5).join(', '))}</span></li>`).join('')}</ul>` : ''}
      <h3>The book</h3>
      <dl class="kv">${meta.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
      <h3>${e.reviewCount === 1 ? 'The review' : `The ${e.reviewCount} reviews, scored together`}</h3>
      <ul class="adjust">${mentionRows}</ul>
      ${chipTags(e).length ? `<h3>Tagged</h3><div class="tags">${chipTags(e).map((t) => `<button class="tag-chip k-${esc(t.kind)}" data-tag="${esc(t.id)}" title="Show every book tagged ${esc(t.label)}">${esc(t.label)}</button>`).join('')}</div>` : ''}
      ${rest.length ? `<h3>Also tagged</h3><div class="tags">${rest.map((t) => `<button class="tag-chip k-${esc(t.kind)}" data-tag="${esc(t.id)}" title="Show every book tagged ${esc(t.label)}">${esc(t.label)}</button>`).join('')}</div>` : ''}
      <p style="font-family:var(--mono);font-size:.6875rem;color:var(--ink-faint);margin:var(--s4) 0 0">
        Scored by keyword against review prose. Treat it as triage, not as a reading of the book.
      </p>`;
  }

  // ------------------------------------------------------------ tuning

  // The delta beside the numeral. Signed and labelled, never colour alone —
  // the arrow and the number both say which way it went.
  function tuneMark(s) {
    const up = s.delta > 0;
    if (Math.abs(s.delta) < 0.3) return '';
    // A book you saved is scored against your *other* saves, so a negative mark
    // on one is not a contradiction — it is the useful case. It says this book
    // sits apart from the rest of what you keep.
    const why = s.judged
      ? `The profile scored this ${outOfTen(s.base)}. Against your other saves it moves ${up ? 'up' : 'down'} — this one ${up ? 'sits with' : 'sits apart from'} the rest of what you keep.`
      : `The profile scored this ${outOfTen(s.base)}; your saves moved it ${up ? 'up' : 'down'}.`;
    return `<span class="tune-mark ${up ? 'up' : 'down'}" title="${esc(why)}">
      ${up ? '▲' : '▼'} ${up ? '+' : '−'}${(Math.abs(s.delta) / 10).toFixed(1)}</span>`;
  }

  // Why it moved, in the same register as the rest of the row: the reasons the
  // model actually used, not a claim that it understands the book.
  function tuneLine(s) {
    const bits = s.reasons.map((r) => esc(r.label));
    if (s.nearest) bits.push(`reads like <em>${esc(s.nearest.title)}</em>, which you saved`);
    if (!bits.length) return '';
    const from = s.judged ? 'vs your other saves' : 'from your saves';
    return `<p class="tune-line"><span class="tune-from">${from}</span> ${bits.join(' · ')}</p>`;
  }

  // ------------------------------------------------------------ retailers

  // DESIGN.md is explicit that detail expands inline and never opens a modal, so
  // the chooser is a disclosure under the row rather than a sheet over it. It
  // behaves like a menu regardless: Escape closes it, and focus returns.
  function chooserHtml(e) {
    const order = retailerOrder();
    const options = order.map((r) => {
      const link = linkFor(r.id, purchaseIdentifiers(e), AFFILIATES);
      if (!link) return '';
      return `<li><a class="retailer" href="${esc(link.url)}" target="_blank" rel="noopener noreferrer"
        data-id="${esc(e.id)}" data-retailer="${esc(r.id)}" data-resolution="${esc(link.linkResolution)}">
        <span class="retailer-name">${esc(r.name)}</span>
        <span class="retailer-blurb">${esc(r.blurb)}</span>
        <span class="retailer-ext" aria-hidden="true">↗</span>
        <span class="sr-only">(opens in a new tab)</span>
      </a></li>`;
    }).join('');
    return `<div class="chooser-inner">
      <p class="chooser-note">Four places that may have a copy. This app does not know prices or what is in stock.</p>
      <ul class="retailers">${options}</ul>
    </div>`;
  }

  // The book fields the link builder needs, and nothing else.
  const purchaseIdentifiers = (e) => ({
    title: e.book.title, author: e.book.author,
    isbn10: e.book.isbn10, isbn13: e.book.isbn13, asin: e.book.asin,
  });

  // Remembering the last retailer is a convenience, not a filter: it moves one
  // option to the front and all four are always listed.
  function retailerOrder() {
    const last = read(RETAILER_KEY, null);
    const preferred = RETAILERS.find((r) => r.id === last);
    return preferred ? [preferred, ...RETAILERS.filter((r) => r.id !== last)] : RETAILERS;
  }

  // A book with no identifier and no title cannot be searched for at all. That is
  // the only case where the action is withheld, and the row says why rather than
  // showing a dead control.
  // Both views stay in the DOM and only one is shown, so a chooser id has to name
  // its surface as well as its book. Without that the saved screen's button
  // points aria-controls at the feed's panel, which is hidden, and opening it
  // does nothing visible.
  const chooserId = (e, surface) => `c-${surface}-${cssId(e.id)}`;

  function findCopyHtml(e, surface) {
    if (!canFindCopy(purchaseIdentifiers(e))) {
      const why = `nofind-${surface}-${cssId(e.id)}`;
      return `<button class="btn" disabled aria-describedby="${why}">Find a copy</button>
        <span class="no-find" id="${why}">No title or ISBN was extracted for this book, so there is nothing to search a retailer for.</span>`;
    }
    return `<button class="btn js-find" aria-expanded="false" aria-controls="${chooserId(e, surface)}"
      aria-haspopup="true" data-id="${esc(e.id)}">Find a copy</button>`;
  }

  // ------------------------------------------------------------ saved books

  // A cover is decoration, so its alt is empty and the initial standing in for a
  // missing one is hidden from assistive tech — the title is right beside it.
  // Open Library serves covers from its own host and a request for a book it has
  // no jacket for can fail late, so the fallback has to survive a broken image
  // as well as an absent url.
  function coverHtml(b) {
    const initial = esc((b.title || '?').trim().slice(0, 1).toUpperCase());
    const fallback = `<span class="cover cover-none" aria-hidden="true">${initial}</span>`;
    if (!b.coverUrl) return fallback;
    return `<img class="cover" src="${esc(b.coverUrl)}" alt="" loading="lazy" width="44" height="66"
      onerror="this.outerHTML=${esc(JSON.stringify(fallback))}">`;
  }

  function savedRow(row) {
    const e = row.entry;
    const b = e.book;
    const s = scoreOf(e);
    const bits = [b.author, b.publisher, b.pages ? `${b.pages} pp.` : null,
      b.editionDate || b.bookYear || null, b.translator ? `tr. ${b.translator}` : null]
      .filter(Boolean);

    return `<li><article class="saved-row" data-id="${esc(e.id)}">
      ${coverHtml(b)}
      <div class="saved-main">
        <h3 class="saved-title">${esc(b.title)}</h3>
        <p class="meta">${bits.length ? esc(bits.join(' · ')) : '<span class="guess">no further detail extracted</span>'}</p>
        <p class="meta"><span class="guess">saved ${esc(row.savedAt ? relative(row.savedAt) : 'before this list kept dates')}</span></p>
        ${s.tuned ? tuneLine(s) : ''}
        <div class="saved-actions">
          ${findCopyHtml(e, 'saved')}
          <button class="btn js-save" data-id="${esc(e.id)}" data-surface="saved" data-want="unsave"
            aria-label="Remove from saved books">Remove</button>
        </div>
        <div class="chooser" id="${chooserId(e, 'saved')}" hidden></div>
      </div>
      <div class="saved-score">
        <span class="num">${e.outOfTen == null ? '—' : outOfTen(s.total)}</span>
        <span class="outof">${e.outOfTen == null ? '' : '/ 10'}</span>
        ${s.tuned && e.outOfTen != null ? tuneMark(s) : ''}
      </div>
    </article></li>`;
  }

  function renderSaved() {
    const rows = saved.listSaved(verdicts, FEED.books, state.savedSort);
    const body = $('saved-body');

    if (!rows.length) {
      body.innerHTML = `<div class="panel"><h2>Nothing saved yet</h2><p>${esc(saved.EMPTY_COPY)}</p>
        <button class="btn" id="saved-to-feed">Back to the feed</button></div>`;
      $('saved-to-feed').addEventListener('click', () => setView('feed'));
    } else {
      body.innerHTML = `<ul class="list">${rows.map(savedRow).join('')}</ul>`;
    }

    // A saved book whose row has dropped out of the current feed is counted here
    // but cannot be listed, and saying so is better than silently showing fewer.
    const missing = saved.savedCount(verdicts) - rows.length;
    $('saved-status').textContent = rows.length
      ? `${rows.length} saved ${rows.length === 1 ? 'book' : 'books'} · sorted by ${saved.SORTS[state.savedSort].label.toLowerCase()}`
        + (missing > 0 ? ` · ${missing} more not in the current build` : '')
      : '';
    bindSaved();
  }

  // ------------------------------------------------------------ taste view

  // Acetate Club shows this as a modal on first visit to the crate — three
  // numbered points explaining that the crate is the engine. Same job here, but
  // it shows the actual learned model rather than a description of one, and it
  // is a screen rather than a dialog because this app opens no dialogs.
  function renderTaste() {
    const body = $('taste-body');
    const need = MIN_SIGNAL - (taste?.savedCount ?? 0);

    if (!taste?.ready) {
      body.innerHTML = `<div class="panel">
        <h2>Not enough saved to tune anything yet</h2>
        <p>Your saves are the signal. Save ${need} more ${need === 1 ? 'book' : 'books'} and the feed starts scoring against what you actually kept, on top of the profile rather than instead of it.</p>
        <button class="btn" id="taste-to-feed">Back to the feed</button></div>`;
      $('taste-to-feed').addEventListener('click', () => setView('feed'));
      return;
    }

    const tagRow = (t, dir) => `<li>
      <button class="tag-chip k-${esc(t.kind)}" data-tag="${esc(t.id)}">${esc(t.label)}</button>
      <span class="taste-count">${t.saves} saved${t.passes ? `, ${t.passes} passed` : ''} of ${t.available} in the feed</span>
      <span class="taste-bar" aria-hidden="true"><span class="taste-fill ${dir}" style="width:${Math.round(Math.abs(t.weight) * 100)}%"></span></span>
    </li>`;

    const tilt = taste.tilt.map((t) => {
      if (!t.enough) return `<div class="dim is-default">
        <span class="dim-id">${esc(t.id)}</span>
        <span class="dim-label">${esc(t.name || '')} — <span class="guess">too few saves with evidence here (${t.n})</span></span>
        <span class="dim-score">—</span></div>`;
      const pct = Math.min(100, Math.abs(t.delta) * 25);
      return `<div class="dim">
        <span class="dim-id">${esc(t.id)}</span>
        <span class="dim-label">${esc(t.name || '')}
          <span class="why">your saves average ${t.mine.toFixed(1)} where the whole feed averages ${t.field.toFixed(1)}, across ${t.n} saves</span>
          <span class="dim-track"><span class="dim-fill ${t.delta > 0 ? 'up' : 'down'}" style="width:${pct}%"></span></span>
        </span>
        <span class="dim-score">${t.delta > 0 ? '+' : '−'}${Math.abs(t.delta).toFixed(1)}</span></div>`;
    }).join('');

    const proposal = weightProposal(taste, Object.fromEntries(FEED.dimensions.map((d) => [d.id, d.name])));

    body.innerHTML = `
      <div class="taste-head">
        <p class="taste-lede">Your saved list is not just a list. It is the second half of the scoring — the profile says what you said you like, and these say what you actually kept.</p>
        <p class="taste-sub">${taste.savedCount} saved and ${taste.passedCount} passed, tuning ${esc(String(FEED.books.length))} books by at most ${(MAX_ADJUSTMENT / 10).toFixed(1)} out of ten in either direction. The profile's own number is never overwritten; you can see both on any row, and the toggle in the filters turns this off.</p>
      </div>

      <h3 class="taste-h">What you save under</h3>
      ${taste.strongestTags.length
        ? `<ul class="taste-list">${taste.strongestTags.map((t) => tagRow(t, 'up')).join('')}</ul>`
        : '<p class="taste-none">No tag has come up often enough yet to read as a preference.</p>'}

      <h3 class="taste-h">What you pass on</h3>
      ${taste.weakestTags.length
        ? `<ul class="taste-list">${taste.weakestTags.map((t) => tagRow(t, 'down')).join('')}</ul>`
        : '<p class="taste-none">Nothing yet. Passing on books teaches this as much as saving them does.</p>'}

      <h3 class="taste-h">Where your saves sit against the field</h3>
      <div class="dims">${tilt}</div>

      <h3 class="taste-h">What that argues about the profile</h3>
      ${proposal.length ? `
        <p class="taste-note">Nothing here has been applied. These are the weight changes your saves argue for; <code>npm run tune</code> prints the same table and then runs the calibration suite against it, so you can see which of the twenty-four fixtures a change would break before deciding.</p>
        <table class="taste-table">
          <thead><tr><th>Dimension</th><th>Now</th><th>Argued</th><th>Your saves</th><th>The field</th><th>n</th></tr></thead>
          <tbody>${proposal.map((p) => `<tr>
            <td>${esc(p.id)} · ${esc(p.name)}</td>
            <td class="num">${p.current}</td>
            <td class="num ${p.delta > 0 ? 'up' : 'down'}">${p.suggested} <span class="taste-count">(${p.delta > 0 ? '+' : ''}${p.delta})</span></td>
            <td class="num">${p.savedMean}</td>
            <td class="num">${p.fieldMean}</td>
            <td class="num">${p.n}</td></tr>`).join('')}</tbody>
        </table>`
        : '<p class="taste-none">Your saves do not yet disagree with the profile’s weighting by enough to argue for a change.</p>'}

      <p class="taste-foot">Two things this deliberately will not do. It will not overrule a rule the profile fired — a book penalised as nonfiction cannot be tuned back over the line. And it will not change a weight on its own: the profile is a written document with a calibration suite behind it, and a dozen saves is not enough evidence to edit it silently.</p>`;

    for (const chip of body.querySelectorAll('.tag-chip')) {
      chip.addEventListener('click', () => {
        state.tag = chip.dataset.tag;
        setView('feed');
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    }
  }

  // ------------------------------------------------------------ your ordering

  // The profile is one reader's ranking of a shared vocabulary. Every band carries
  // a label describing the book and a score ranking it, and only the second half is
  // personal: "comic" describes a novel the same way for everyone and is worth 4 to
  // this profile and 10 to somebody who reads for comedy.
  //
  // This screen is where a second reader disagrees with the ranking. It is the one
  // place in the app where the reader overrules the profile outright, which is the
  // opposite of what the Taste screen does: saves are a bounded correction that can
  // never overrule a rule, and these change what the rules are.

  const RULE_COPY = {
    twist_override: 'Score a formal device at 3 when the review says it resolves into a twist.',
    trap4_land_scale: 'Drop the land subject from 10 to 6 when nothing institutional or multi-decade stands behind it.',
    d6_sprawl_without_ambition: 'Drop a 500-page book below the top band when the review shows no multi-strand structure.',
    d6_length_without_ambition: 'Drop a 400-page book below its band when the review shows no structural ambition.',
  };

  const overridesDirty = () => !isEmpty(overrides);

  function saveOverrides() {
    write(OVERRIDES_KEY, overrides);
    $('profile-mark').hidden = !overridesDirty();
    render();
  }

  function setOverride(group, key, value) {
    const next = { ...overrides, [group]: { ...overrides[group] } };
    if (value === null || value === undefined) delete next[group][key];
    else next[group][key] = value;
    overrides = next;
    saveOverrides();
  }

  function resetOverrides() {
    overrides = { ...EMPTY_OVERRIDES };
    saveOverrides();
    renderProfile();
  }

  function renderProfile() {
    const P = profileForOverrides();
    const sum = summarize(overrides, P);
    const changes = sum.rules.length + sum.bands.length + sum.weights.length + sum.adjustments.length;

    const dims = P.dimensions.map((d) => {
      const w = overrides.weights[d.id] ?? d.weight;
      const moved = (d.bands || []).filter((b) => overrides.bands[bandKey(d.id, b.id)] != null).length
        + (overrides.weights[d.id] != null ? 1 : 0);
      const bands = (d.bands || []).map((b) => {
        const cur = overrides.bands[bandKey(d.id, b.id)] ?? b.score;
        return `<div class="ov-band">
          <label class="ov-band-label" for="b-${esc(d.id)}-${esc(b.id)}">${esc(b.label)}${b.descriptiveOnly ? '<span class="ov-note">not ranked by the profile</span>' : ''}</label>
          <input class="ov-num" type="number" min="0" max="10" step="1" id="b-${esc(d.id)}-${esc(b.id)}"
            data-band-dim="${esc(d.id)}" data-band-id="${esc(b.id)}" value="${cur}"
            aria-label="What ${esc(b.label)} is worth, out of ten">
          ${cur !== b.score ? `<span class="ov-was">was ${b.score}</span>` : '<span class="ov-was"></span>'}
        </div>`;
      }).join('');

      return `<details class="ov-dim">
        <summary class="more-toggle">
          ${esc(d.name)}
          <span class="more-count">weight ${w}${moved ? ` · ${moved} changed` : ''}</span>
        </summary>
        <div class="ov-dim-body">
          <div class="ov-band ov-weight">
            <label class="ov-band-label" for="w-${esc(d.id)}">How much this dimension counts</label>
            <input class="ov-num" type="number" min="0" max="100" step="1" id="w-${esc(d.id)}"
              data-weight="${esc(d.id)}" value="${w}" aria-label="Weight for ${esc(d.name)}">
            ${w !== d.weight ? `<span class="ov-was">was ${d.weight}</span>` : '<span class="ov-was"></span>'}
          </div>
          ${bands}
        </div>
      </details>`;
    }).join('');

    const ruleRows = Object.entries(RULE_COPY).map(([id, copy]) => `
      <label class="switch ov-switch">
        <input type="checkbox" data-rule="${esc(id)}" ${overrides.rules[id] === false ? '' : 'checked'}>
        <span>${esc(copy)}</span>
      </label>`).join('');

    const filterRows = (FEED.hardFilters || []).map((f) => `
      <label class="switch ov-switch">
        <input type="checkbox" data-adjustment="${esc(f.id)}" ${overrides.adjustments[f.id] === false ? '' : 'checked'}>
        <span>${esc(f.label)} <span class="ov-note">${f.points} points</span></span>
      </label>`).join('');

    $('profile-body').innerHTML = `
      <p class="ov-lede">Every score in the feed is this profile's opinion. The words are shared: "braided", "comic", "independent press" describe a book the same way for anyone. What they are worth is not. Change what they are worth here and the feed re-ranks, with no rebuild.</p>
      <p class="ov-sub">This is the one screen that overrules the profile. Your saves never do: they move a score by at most ${(MAX_ADJUSTMENT / 10).toFixed(1)} out of ten and cannot touch a rule.</p>

      <div class="ov-status">
        <p class="status">${changes ? `${changes} change${changes === 1 ? '' : 's'} in force` : 'Nothing changed. The feed is scored exactly as the profile scores it.'}</p>
        ${changes ? `<button class="btn" id="ov-reset">Reset to the profile</button>` : ''}
      </div>

      <h3 class="ov-h">What a book is worth</h3>
      <p class="ov-help">Each dimension holds the bands a review can land in. The number beside a band is what it earns out of ten.</p>
      ${dims}

      <h3 class="ov-h">Rules the profile applies</h3>
      <p class="ov-help">These rewrite a score after the band is picked. Switch one off and the band the review actually earned comes back.</p>
      <div class="toggle-row ov-rules">${ruleRows}</div>

      <h3 class="ov-h">What the profile refuses</h3>
      <p class="ov-help">Heavy penalties, not exclusions: a book carrying one is still scored and still shown. Switch one off and its points come back. Do you read nonfiction? This is where you say so.</p>
      <div class="toggle-row ov-rules">${filterRows}</div>`;

    bindProfile();
  }

  function bindProfile() {
    const body = $('profile-body');
    $('ov-reset')?.addEventListener('click', resetOverrides);

    for (const input of body.querySelectorAll('input[type="number"]')) {
      input.addEventListener('change', () => {
        const n = Number(input.value);
        if (!Number.isFinite(n)) return;
        if (input.dataset.weight) {
          const d = FEED.dimensions.find((x) => x.id === input.dataset.weight);
          setOverride('weights', d.id, n === d.weight ? null : n);
        } else {
          const d = FEED.dimensions.find((x) => x.id === input.dataset.bandDim);
          const b = (d.bands || []).find((x) => x.id === input.dataset.bandId);
          setOverride('bands', bandKey(d.id, b.id), n === b.score ? null : n);
        }
        renderProfile();
      });
    }

    for (const box of body.querySelectorAll('input[type="checkbox"]')) {
      box.addEventListener('change', () => {
        const group = box.dataset.rule ? 'rules' : 'adjustments';
        const key = box.dataset.rule || box.dataset.adjustment;
        setOverride(group, key, box.checked ? null : false);
        renderProfile();
      });
    }
  }

  // ------------------------------------------------------------ build a profile

  // Six questions, one screen. A wizard would be more ceremony than six questions
  // deserve, and seeing all of them at once is what makes it feel short.
  let startAnswers = { liked: [], disliked: [], nonfiction: false, satire: false };

  function renderStart() {
    const chips = (which) => CHIPS.map((c) => {
      const key = `${c.dim}:${c.band}`;
      const on = startAnswers[which].includes(key);
      return `<button class="chip start-chip" data-which="${which}" data-key="${esc(key)}" aria-pressed="${on}">${esc(c.label)}</button>`;
    }).join('');

    const n = startAnswers.liked.length + startAnswers.disliked.length;
    $('start-body').innerHTML = `
      <p class="ov-lede">Every score in this feed is one reader's taste, not yours. Four steps, about two minutes, and it ranks against you instead.</p>
      <ol class="start-steps">
        <li>Pick what you read for. Anything that makes you want to open a book.</li>
        <li>Pick what puts you off. This one matters as much: with nothing to push against, the feed ranks everything alike.</li>
        <li>Answer the two questions at the bottom.</li>
        <li>Tap <strong>Build it</strong>. The feed re-ranks straight away.</li>
      </ol>
      <p class="ov-sub">Skip anything you have no opinion about. Nothing here leaves this browser, and every part of it stays editable on the Profile screen afterwards.</p>

      <h3 class="ov-h">What do you read for?</h3>
      <p class="ov-help">Pick anything that makes you want to open a book.</p>
      <div class="start-chips">${chips('liked')}</div>

      <h3 class="ov-h">What puts you off?</h3>
      <p class="ov-help">This matters as much as the first list. A model with nothing to push against ranks everything alike.</p>
      <div class="start-chips">${chips('disliked')}</div>

      <h3 class="ov-h">Two things worth saying outright</h3>
      <div class="toggle-row ov-rules">
        <label class="switch ov-switch"><input type="checkbox" id="start-nonfiction" ${startAnswers.nonfiction ? 'checked' : ''}><span>I read nonfiction</span></label>
        <label class="switch ov-switch"><input type="checkbox" id="start-satire" ${startAnswers.satire ? 'checked' : ''}><span>I like satire and comic novels</span></label>
      </div>

      <div class="ov-status">
        <p class="status">${n ? `${n} answer${n === 1 ? '' : 's'}` : 'Nothing picked yet'}</p>
        <button class="btn btn-done" id="start-apply">Build it</button>
      </div>`;

    for (const chip of $('start-body').querySelectorAll('.start-chip')) {
      chip.addEventListener('click', () => {
        const { which, key } = chip.dataset;
        const list = startAnswers[which];
        const i = list.indexOf(key);
        if (i >= 0) list.splice(i, 1); else list.push(key);
        // A band cannot be both liked and disliked, so picking one side drops
        // the other rather than letting the two overrides fight.
        const other = which === 'liked' ? 'disliked' : 'liked';
        startAnswers[other] = startAnswers[other].filter((k) => k !== key);
        renderStart();
      });
    }
    $('start-nonfiction').addEventListener('change', (ev) => { startAnswers.nonfiction = ev.target.checked; });
    $('start-satire').addEventListener('change', (ev) => { startAnswers.satire = ev.target.checked; });
    $('start-apply').addEventListener('click', () => {
      overrides = buildProfile(profileForOverrides(), startAnswers);
      saveOverrides();
      setView('feed');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      toast('Your profile is in. The feed is ranked by it now, and the Profile screen has every part of it.');
    });
  }

  function setView(view) {
    state.view = view;
    savePrefs();
    $('feed-section').hidden = view !== 'feed';
    $('saved-section').hidden = view !== 'saved';
    $('taste-section').hidden = view !== 'taste';
    $('profile-section').hidden = view !== 'profile';
    $('start-section').hidden = view !== 'start';
    // The control bar sorts and filters the feed and means nothing on the saved
    // list, so it goes away rather than sitting there inert. Same for the
    // recommended tally and any tag filter still applied to the feed.
    document.querySelector('.controls').hidden = view !== 'feed';
    document.querySelector('.tally').hidden = view !== 'feed';
    if (view !== 'feed') $('tag-bar').hidden = true;
    for (const [id, name] of [['view-feed', 'feed'], ['view-saved', 'saved'], ['view-taste', 'taste'], ['view-profile', 'profile'], ['view-start', 'start']]) {
      if (view === name) $(id).setAttribute('aria-current', 'page');
      else $(id).removeAttribute('aria-current');
    }
    render();
    if (view === 'saved') {
      analytics.track('saved_books_viewed',
        { count: saved.savedCount(verdicts), sort: state.savedSort });
    }
  }

  // ------------------------------------------------------------ grouping

  const SUBJECT_LABELS = {
    land: 'Land, water, extraction, labour',
    state_violence: 'State violence, conquest, repression',
    institution: 'Institutional formation',
    art_under_state: 'Art under political constraint',
    faith: 'Faith and belief systems',
    finance: 'Money and finance',
    domestic: 'Family, marriage, identity',
    media_tech: 'Media, tech, internet life',
    null: 'Subject engine not established',
  };

  // What is set behind the closed disclosure. Every switch below is either off or
  // at its default in `state`, so counting departures from the default is exact
  // rather than a guess, and `window` and `tune` are defaults-on so they count
  // only when turned off.
  function hiddenFilterCount() {
    let n = state.sources.size;
    if (state.minScore != null) n++;
    if (state.minPages != null) n++;
    if (!state.window) n++;
    if (!state.tune) n++;
    for (const k of ['nonfiction', 'identity', 'penalised', 'group', 'unseen']) if (state[k]) n++;
    return n;
  }

  function render() {
    closeChooser();
    $('savedCount').textContent = saved.savedCount(verdicts);
    const mc = $('more-count');
    if (mc) { const n = hiddenFilterCount(); mc.textContent = n ? `${n} set` : ''; }
    // The icons carry whether a control is holding something, so they have to be
    // refreshed on every render rather than only when one is clicked: clearing a
    // tag from the feed changes the filter count without touching the toolbar.
    if (typeof syncTools === 'function') syncTools();
    if (state.view === 'saved') { renderSaved(); return; }
    if (state.view === 'taste') { renderTaste(); return; }
    if (state.view === 'profile') { renderProfile(); return; }
    if (state.view === 'start') { renderStart(); return; }

    const all = FEED.books;
    const shown = all.filter(visible).sort(compare);

    const active = state.tag ? (FEED.tags || []).find((t) => t.id === state.tag) : null;
    $('tag-bar').hidden = !active;
    if (active) {
      $('tag-bar').innerHTML = `<span class="lab-sm">${esc(active.kind)}</span>
        <strong>${esc(active.label)}</strong>
        <button class="btn" id="tag-clear">Clear</button>`;
      $('tag-clear').addEventListener('click', () => { state.tag = null; savePrefs(); render(); });
    }

    const recCount = all.filter((e) => recommendedNow(e, scoreOf(e)) && (!state.window || e.inWindow !== false)).length;
    $('recCount').textContent = recCount;
    $('recToggle').setAttribute('aria-pressed', String(state.recommendedOnly));

    const body = $('feed-body');
    if (!shown.length) {
      body.innerHTML = `<div class="panel">
        <h2>${state.recommendedOnly ? 'Nothing is recommended right now' : 'Nothing matches'}</h2>
        <p>${state.recommendedOnly
          ? 'Nothing in the current window scored 7 or above with the book properly identified. That is a real answer rather than an empty screen — the reviews are there, they just are not close enough to the profile. Clear this filter to read the rest.'
          : 'Every entry was filtered out. Try clearing the window or the publication filters.'}</p>
        <button class="btn" id="empty-reset">${state.recommendedOnly ? 'Show everything' : 'Reset filters'}</button>
      </div>`;
      $('empty-reset').addEventListener('click', () => {
        if (state.recommendedOnly) { state.recommendedOnly = false; savePrefs(); render(); }
        else resetFilters();
      });
    } else if (state.group) {
      const groups = new Map();
      for (const e of shown) {
        const id = e.score.dimensions.D2.id;
        const label = SUBJECT_LABELS[id] || SUBJECT_LABELS.null;
        if (!groups.has(label)) groups.set(label, []);
        groups.get(label).push(e);
      }
      const order = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
      body.innerHTML = order.map(([label, items]) =>
        `<h3 class="group-head">${esc(label)} <span style="opacity:.6">${items.length}</span></h3><ul class="list">${items.map(row).join('')}</ul>`).join('');
    } else {
      body.innerHTML = `<ul class="list">${shown.map(row).join('')}</ul>`;
    }

    const savedCount = saved.savedCount(verdicts);
    const passedCount = Object.values(verdicts).filter((v) => v.verdict === 'passed').length;
    const tuning = state.tune && taste?.ready
      ? ` · tuned by ${taste.savedCount} saves`
      : state.tune && taste ? ` · ${MIN_SIGNAL - taste.savedCount} more saves until tuning starts` : '';
    // A reader who has re-scored a band is looking at a feed ranked by something
    // the profile did not decide. The status line says so rather than leaving the
    // order unexplained.
    $('status').textContent = `${shown.length} ${shown.length === 1 ? 'book' : 'books'}, ${ORDERS[state.order]?.label || 'newest reviews'}`
      + (overridesDirty() ? ' · your ordering' : '');
    $('feed-note').textContent = state.group ? 'Grouped by subject engine — the format with the best acquisition rate in the profile.' : '';

    updateChipCounts(all);
    bindRows();
  }

  const label = (k) => ({ reviewDate: 'latest review date', bookDate: 'book publication date', score: 'fit score', reviews: 'number of reviews', title: 'title', none: '' }[k] || k);

  function updateChipCounts(all) {
    for (const chip of document.querySelectorAll('#sources .chip')) {
      const id = chip.dataset.value;
      const n = all.filter((e) => e.mentions.some((m) => m.source.id === id) && !e.score.filters.length).length;
      chip.querySelector('.n').textContent = n;
    }
  }

  // ------------------------------------------------------------ events

  // The title, the description and "Why this score" all open the same panel, so the
  // toggle lives in one place and every control on the row reports the same state.
  // A row that looks like a link and does nothing when clicked is the complaint
  // this answers: the title was set as a heading and read as one.
  function toggleRow(article, force) {
    const panel = article.querySelector('.detail');
    const why = article.querySelector('.js-why');
    const open = force ?? (why.getAttribute('aria-expanded') !== 'true');
    if (open) {
      const e = FEED.books.find((x) => x.id === article.dataset.id);
      panel.innerHTML = detail(e);
      bindSaveAndFind(panel);
      panel.hidden = false;
      article.classList.add('is-open');
      why.textContent = 'Hide the working';
      openRow = why;
    } else {
      panel.hidden = true;
      article.classList.remove('is-open');
      why.textContent = 'Why this score';
      openRow = null;
    }
    for (const c of article.querySelectorAll('.js-why, .js-open')) c.setAttribute('aria-expanded', String(open));
  }

  function bindRows() {
    for (const btn of document.querySelectorAll('.js-why, .js-open')) {
      btn.addEventListener('click', () => toggleRow(btn.closest('.row')));
    }
    // Mouse convenience only, which is why it is not a tab stop and carries no
    // role: the two buttons above reach the same panel from the keyboard.
    for (const p of document.querySelectorAll('.js-open-soft')) {
      p.addEventListener('click', () => toggleRow(p.closest('.row')));
    }
    for (const btn of document.querySelectorAll('.tag-chip')) {
      btn.addEventListener('click', () => {
        state.tag = btn.dataset.tag === state.tag ? null : btn.dataset.tag;
        savePrefs(); render();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    }
    for (const btn of document.querySelectorAll('.js-rec')) {
      btn.addEventListener('click', () => {
        state.recommendedOnly = true;
        savePrefs(); render();
        document.getElementById('recToggle').focus();
      });
    }
    for (const btn of document.querySelectorAll('.js-verdict')) {
      btn.addEventListener('click', () => {
        setVerdict(btn.closest('.row').dataset.id, btn.dataset.verdict);
      });
    }
    bindSaveAndFind($('feed-body'));
  }

  // Shared by both screens: the same save control and the same chooser appear on
  // a feed row and a saved row, so they are bound once against whichever
  // container drew them.
  function bindSaveAndFind(scope) {
    for (const btn of scope.querySelectorAll('.js-save')) {
      btn.addEventListener('click', () => {
        setSaved(btn.dataset.id, btn.dataset.want === 'save', btn.dataset.surface);
      });
    }
    for (const btn of scope.querySelectorAll('.js-find')) {
      btn.addEventListener('click', () => toggleChooser(btn));
    }
    for (const link of scope.querySelectorAll('.retailer')) {
      link.addEventListener('click', () => {
        write(RETAILER_KEY, link.dataset.retailer);
        analytics.track('retailer_link_opened', {
          bookId: link.dataset.id,
          retailer: link.dataset.retailer,
          linkResolution: link.dataset.resolution,
        });
      });
    }
  }

  function closeChooser() {
    if (!openChooser) return;
    const panel = document.getElementById(openChooser.getAttribute('aria-controls'));
    if (panel) panel.hidden = true;
    openChooser.setAttribute('aria-expanded', 'false');
    openChooser = null;
  }

  function toggleChooser(btn) {
    const panel = document.getElementById(btn.getAttribute('aria-controls'));
    const isOpen = btn.getAttribute('aria-expanded') === 'true';
    closeChooser();
    if (isOpen) return;
    const e = FEED.books.find((x) => x.id === btn.dataset.id);
    panel.innerHTML = chooserHtml(e);
    panel.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    openChooser = btn;
    bindSaveAndFind(panel);
    analytics.track('retailer_chooser_opened', { bookId: e.id });
    panel.querySelector('.retailer')?.focus();
  }

  function bindSaved() {
    bindSaveAndFind($('saved-body'));
  }

  function resetFilters() {
    Object.assign(state, {
      q: '', minPages: null, minScore: null, sources: new Set(), tag: null,
      window: true, nonfiction: false, identity: false, penalised: false,
      recommendedOnly: false, group: false, unseen: false,
    });
    // Tuning is not a filter and resetting the filters does not switch it off.
    $('q').value = ''; $('minPages').value = ''; $('minScore').value = '';
    $('fWindow').checked = true; $('fNonfiction').checked = false; $('fIdentity').checked = false;
    $('fPenalised').checked = false; $('fGroup').checked = false; $('fUnseen').checked = false;
    for (const c of document.querySelectorAll('.chip')) c.setAttribute('aria-pressed', 'false');
    savePrefs(); render();
  }

  function savePrefs() {
    write(PREFS_KEY, { ...state, sources: [...state.sources] });
  }

  function loadOverrides() {
    const stored = read(OVERRIDES_KEY, null);
    if (stored) overrides = { ...EMPTY_OVERRIDES, ...stored };
    $('profile-mark').hidden = !overridesDirty();
  }

  function loadPrefs() {
    const p = read(PREFS_KEY, null);
    if (!p) return;
    Object.assign(state, p, { sources: new Set(p.sources || []) });
    if (!ORDERS[state.order]) {
      const match = Object.entries(ORDERS).find(([, o]) => o.sort1 === state.sort1 && o.dir1 === state.dir1);
      state.order = match ? match[0] : 'latest';
    }
    Object.assign(state, ORDERS[state.order]);
    $('q').value = state.q || '';
    $('order').value = state.order;
    $('minPages').value = state.minPages || ''; $('minScore').value = state.minScore || '';
    $('fWindow').checked = state.window; $('fNonfiction').checked = state.nonfiction;
    $('fIdentity').checked = state.identity; $('fPenalised').checked = state.penalised;
    $('fGroup').checked = state.group; $('fUnseen').checked = state.unseen;
    $('fTune').checked = state.tune !== false;
  }

  function buildChips() {
    const used = new Set(FEED.books.flatMap((b) => b.mentions.map((m) => m.source.id)));
    $('sources').innerHTML = FEED.sources.filter((s) => used.has(s.id))
      .map((s) => `<button class="chip" data-value="${esc(s.id)}" aria-pressed="${state.sources.has(s.id)}">${esc(s.short)}<span class="n"></span></button>`).join('');
    for (const [el, set] of [[$('sources'), state.sources]]) {
      el.addEventListener('click', (ev) => {
        const chip = ev.target.closest('.chip');
        if (!chip) return;
        const v = chip.dataset.value;
        if (set.has(v)) set.delete(v); else set.add(v);
        chip.setAttribute('aria-pressed', set.has(v));
        savePrefs(); render();
      });
    }
  }

  // Nineteen publication chips and seven switches are a settings screen, not a
  // control bar, and they were the first thing on the page at every width. They
  // start closed everywhere now; the bar keeps the search and the sort, which is
  // what actually gets touched. The count in the summary says what is hiding, so
  // a filter left on is never invisible.
  // A scroll listener rather than an IntersectionObserver on a sentinel, which is
  // what this was. The observer is the tidier idea and it silently delivered no
  // callbacks at all in an embedded webview, not even the initial one every
  // observer is supposed to fire. A collapsing bar that quietly stops collapsing
  // is worse than a listener, and rAF throttling makes this cost a class toggle
  // per frame at most.
  //
  // The threshold is a band rather than a point, so a bar sitting exactly on the
  // line cannot flip back and forth on a one-pixel scroll.
  // Opening the app should put you at the top of the feed. Browsers restore the
  // last scroll position on a reload and on a back navigation, which on a
  // home-screen app means reopening it halfway down yesterday's books with the
  // bar already collapsed. There are no in-page anchors here for this to fight.
  function startAtTop() {
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
    window.scrollTo(0, 0);
    // Safari restores the position after load rather than before it, so once
    // more on the next frame.
    requestAnimationFrame(() => window.scrollTo(0, 0));
  }

  function bindTopbar() {
    const bar = document.getElementById('topbar');
    if (!bar) return;
    const ON = 90;
    const OFF = 60;
    let ticking = false;

    const top = document.getElementById('to-top');

    const apply = () => {
      ticking = false;
      const y = window.scrollY;
      const compact = bar.classList.contains('is-compact');
      if (!compact && y > ON) bar.classList.add('is-compact');
      else if (compact && y < OFF) bar.classList.remove('is-compact');
      // The way back appears at the same moment the top stops being one flick
      // away, which is the same threshold the bar collapses on.
      if (top) top.hidden = y <= ON;
    };

    top?.addEventListener('click', () => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      document.querySelector('h1')?.focus?.();
    });

    const schedule = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(apply);
    };

    window.addEventListener('scroll', schedule, { passive: true });

    // Belt and braces, because each of these has been seen doing nothing. In one
    // embedded webview the scroll event never fired at all while window.scrollY
    // moved from 0 to 1768; in the same view an IntersectionObserver delivered no
    // callback either, not even the initial one every observer owes you. Either
    // mechanism alone is a bar that silently stops collapsing, and they both just
    // call apply(), which is idempotent.
    if ('IntersectionObserver' in window) {
      const probe = document.createElement('div');
      probe.setAttribute('aria-hidden', 'true');
      probe.style.cssText = 'position:absolute;top:0;left:0;width:1px;height:80px;pointer-events:none;visibility:hidden';
      document.body.prepend(probe);
      new IntersectionObserver(schedule, { threshold: [0, 1] }).observe(probe);
    }

    apply();
  }

  // The three panels under the toolbar are one at a time. Opening the order
  // closes the search, because two of them stacked is the vertical space this
  // layout exists to save, and because only one of them is ever being used.
  //
  // A panel holding a value never closes on its own. A query still filtering the
  // feed, or an order that is not the default, with its control put away is
  // state the reader cannot see, which is the failure the filter count exists to
  // avoid. Those keep a dot on their icon instead.
  const PANELS = [
    { btn: 'search-toggle', panel: 'panel-search', held: () => Boolean(state.q) },
    { btn: 'order-toggle', panel: 'panel-order', held: () => state.order !== 'latest' },
    { btn: 'filters-toggle', panel: 'more', held: () => hiddenFilterCount() > 0 },
  ];

  function syncTools() {
    for (const { btn, panel, held } of PANELS) {
      const b = $(btn);
      const p = $(panel);
      if (!b || !p) continue;
      const open = panel === 'more' ? p.open : !p.hidden;
      b.setAttribute('aria-expanded', String(open));
      const dot = b.querySelector('.tool-dot');
      if (dot) dot.hidden = !held();
    }
  }

  function openPanel(which) {
    for (const { btn, panel } of PANELS) {
      const p = $(panel);
      if (!p) continue;
      const on = panel === which;
      if (panel === 'more') p.open = on; else p.hidden = !on;
      if (on) document.querySelector('.controls')?.classList.add('has-panel');
    }
    if (!which) document.querySelector('.controls')?.classList.remove('has-panel');
    syncTools();
  }

  function bindTools() {
    for (const { btn, panel } of PANELS) {
      const b = $(btn);
      if (!b) continue;
      b.addEventListener('click', () => {
        const p = $(panel);
        const open = panel === 'more' ? p.open : !p.hidden;
        openPanel(open ? null : panel);
        if (!open) p.querySelector('input, select, button')?.focus();
      });
    }

    // Escape closes whatever is open and puts focus back on the icon that opened
    // it, rather than leaving it inside a panel that is no longer there.
    document.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape') return;
      const open = PANELS.find(({ panel }) => {
        const p = $(panel);
        return p && (panel === 'more' ? p.open : !p.hidden);
      });
      if (!open) return;
      openPanel(null);
      $(open.btn).focus();
    });

    $('filters-done')?.addEventListener('click', () => { openPanel(null); $('filters-toggle').focus(); });
    syncTools();
  }

  // Sections, the theme and the build line: read once, then never again. Behind
  // the menu they cost one row instead of three.
  function bindMenu() {
    const btn = $('menu-toggle');
    const panel = $('menu-panel');
    if (!btn || !panel) return;
    const set = (open) => {
      panel.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
    };
    btn.addEventListener('click', (ev) => { ev.stopPropagation(); set(panel.hidden); });
    panel.addEventListener('click', (ev) => { if (ev.target.closest('.btn')) set(false); });
    document.addEventListener('click', (ev) => {
      if (panel.hidden) return;
      if (ev.target.closest('.dock')) return;
      set(false);
    });
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && !panel.hidden) { set(false); btn.focus(); }
    });
    set(false);
  }

  function bindDisclosure() {
    const more = document.getElementById('more');
    more.open = false;

    // The panel is most of the screen when it is open, and the bar it lives in is
    // sticky, so the summary scrolled away and left no way back out. Three ways
    // out now: the summary itself, a Done button at the foot of the panel, and
    // Esc. The bar also stops being sticky while the panel is open, so the page
    // behind it is not pinned under a control surface.
    more.addEventListener('toggle', () => {
      document.querySelector('.controls')?.classList.toggle('is-open', more.open);
      syncTools();
    });
  }

  // A directory of every tag carried by more than one book, so the taxonomy is
  // browsable rather than only discoverable by spotting a chip on a row.
  const KIND_ORDER = ['genre', 'subject', 'period', 'form', 'prose', 'tone', 'scale', 'press', 'imprint', 'attention', 'question', 'rule', 'caveat'];
  function buildTagDirectory() {
    const shared = (FEED.tags || []).filter((t) => t.count > 1);
    const byKind = new Map();
    for (const t of shared) {
      if (!byKind.has(t.kind)) byKind.set(t.kind, []);
      byKind.get(t.kind).push(t);
    }
    const order = KIND_ORDER.filter((k) => byKind.has(k)).concat([...byKind.keys()].filter((k) => !KIND_ORDER.includes(k)));
    $('tag-dir').innerHTML = order.map((kind) => `
      <div class="tag-group">
        <span class="legend">${esc(kind)}</span>
        <div class="chips">${byKind.get(kind).map((t) =>
          `<button class="tag-chip k-${esc(t.kind)}" data-tag="${esc(t.id)}">${esc(t.label)}<span class="n">${t.count}</span></button>`).join('')}</div>
      </div>`).join('');
    $('tag-dir').addEventListener('click', (ev) => {
      const chip = ev.target.closest('.tag-chip');
      if (!chip) return;
      state.tag = chip.dataset.tag === state.tag ? null : chip.dataset.tag;
      savePrefs(); render();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  function bindControls() {
    const rerender = () => { savePrefs(); render(); };
    let timer;
    $('q').addEventListener('input', (e) => {
      state.q = e.target.value.trim();
      clearTimeout(timer); timer = setTimeout(rerender, 140);
    });
    $('order').addEventListener('change', (ev) => {
      const o = ORDERS[ev.target.value] || ORDERS.latest;
      Object.assign(state, { order: ev.target.value, ...o });
      savePrefs(); render();
    });
    for (const [id, key] of []) {
      $(id).addEventListener('change', (e) => { state[key] = e.target.value; rerender(); });
    }
    $('minPages').addEventListener('change', (e) => { state.minPages = Number(e.target.value) || null; rerender(); });
    $('minScore').addEventListener('change', (e) => { state.minScore = Number(e.target.value) || null; rerender(); });
    $('recToggle').addEventListener('click', () => { state.recommendedOnly = !state.recommendedOnly; rerender(); });
    for (const [id, key] of [['fWindow', 'window'], ['fNonfiction', 'nonfiction'], ['fIdentity', 'identity'], ['fPenalised', 'penalised'], ['fGroup', 'group'], ['fUnseen', 'unseen']]) {
      $(id).addEventListener('change', (e) => { state[key] = e.target.checked; rerender(); });
    }
    $('reset').addEventListener('click', resetFilters);

    $('export').addEventListener('click', () => {
      const rows = Object.entries(verdicts).map(([id, record]) => {
        const { verdict, savedAt } = record;
        const e = FEED.books.find((x) => x.id === id);
        return e ? {
          verdict, savedAt, title: e.book.title, author: e.book.author, year: e.book.bookYear,
          isbn13: e.book.isbn13, isbn10: e.book.isbn10,
          pages: e.book.pages, publisher: e.book.publisher, score: e.score.total,
          dimensions: Object.fromEntries(Object.values(e.score.dimensions).map((d) => [d.dimension, d.score])),
          sources: e.sources, reviews: e.mentions.map((m) => m.reviewUrl),
        } : { verdict, savedAt, id };
      });
      const blob = new Blob([JSON.stringify({ exported: new Date().toISOString(), profileRevision: FEED.profileRevision, verdicts: rows }, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `reading-verdicts-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    });

    $('sources-info').addEventListener('click', () => {
      const off = FEED.sources.filter((s) => !s.enabled);
      const on = FEED.sources.filter((s) => s.enabled);
      alert(`Reading from ${on.length} publications:\n${on.map((s) => `  ${s.name}`).join('\n')}\n\nNot reading from ${off.length}:\n${off.map((s) => `  ${s.name} — ${s.disabledReason}`).join('\n')}`);
    });

    $('view-feed').addEventListener('click', () => setView('feed'));
    $('view-saved').addEventListener('click', () => setView('saved'));
    $('view-taste').addEventListener('click', () => setView('taste'));
    $('view-profile').addEventListener('click', () => setView('profile'));
    $('view-start').addEventListener('click', () => setView('start'));
    $('fTune').addEventListener('change', (ev) => { state.tune = ev.target.checked; rerender(); });
    $('savedSort').addEventListener('change', (ev) => {
      state.savedSort = ev.target.value;
      savePrefs();
      renderSaved();
      analytics.track('saved_books_viewed',
        { count: saved.savedCount(verdicts), sort: state.savedSort });
    });

    document.addEventListener('keydown', (ev) => {
      if (ev.key === '/' && state.view === 'feed' && document.activeElement !== $('q')) { ev.preventDefault(); $('q').focus(); }
      if (ev.key !== 'Escape') return;
      // The chooser is the innermost thing open, so it closes first.
      if (openChooser) { const btn = openChooser; closeChooser(); btn.focus(); return; }
      if (openRow) { openRow.click(); openRow.focus(); }
    });
  }

  // ------------------------------------------------------------ boot

  function skeleton() {
    $('feed-body').innerHTML = Array.from({ length: 6 }, () => `
      <div class="skeleton"><div class="sk num"></div>
      <div><div class="sk line w40"></div><div class="sk line w70"></div><div class="sk line w90"></div></div></div>`).join('');
  }

  function failure(message, detailText) {
    $('feed-body').innerHTML = `<div class="panel">
      <h2>${esc(message)}</h2>
      <p>${detailText}</p>
    </div>`;
    $('status').textContent = message;
  }

  async function boot() {
    initTheme();
    skeleton();
    let res;
    try {
      res = await fetch('data/feed.json', { cache: 'no-cache' });
    } catch {
      failure('The feed could not be loaded',
        `Opening <code>index.html</code> straight off disk blocks the fetch. Run <code>npm start</code> in <code>apps/lit-feed</code> and use the address it prints.`);
      return;
    }
    if (!res.ok) {
      failure('No feed has been built yet',
        `Run <code>npm run build</code> in <code>apps/lit-feed</code>. It reads the publications, resolves each review to a book and scores it, then writes <code>web/data/feed.json</code>.`);
      return;
    }
    FEED = await res.json();
    if (!FEED.books?.length) {
      failure('The feed is empty',
        `The build ran but found nothing. Check the source report it printed — a publication may have changed its feed.`);
      return;
    }

    $('built').textContent = `built ${relative(FEED.builtAt)} · ${FEED.books.length} books from ${FEED.books.reduce((n, b) => n + b.reviewCount, 0)} reviews`;
    // One line beside the wordmark. Everything the old subhead said about the
    // window, the revision and the threshold is true and none of it belongs in a
    // masthead: it was four lines of body copy crowding the navigation.
    $('masthead-sub').textContent = `${FEED.sources.filter((s) => s.enabled).length} publications, the last ${FEED.windowYears} years, scored out of ten.`;
    $('foot-note').innerHTML = `Everything the literary press reviewed in the last ${FEED.windowYears} years, scored against revision ${FEED.profileRevision} of the reading taste profile. ${FEED.recommendAt} and above is tagged recommended. Scores are a keyword reading of review prose, so treat one as triage rather than as a reading of the book; every dimension shows the terms it fired on, which is what makes a wrong score visible as a wrong score. Saving and passing writes to this browser only. Export it to feed the next revision of the profile.`;

    startAtTop();
    loadPrefs();
    loadOverrides();
    retune();
    $('savedSort').value = state.savedSort;
    buildChips();
    buildTagDirectory();
    bindControls();
    bindDisclosure();
    bindTopbar();
    bindTools();
    bindMenu();
    setView(['saved', 'taste', 'profile', 'start'].includes(state.view) ? state.view : 'feed');
  }

  boot();
})();
