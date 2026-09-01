// Saves tune the score.
//
// The shape is lifted from Acetate Club's recommender, which ranks new releases
// by similarity to the records in your crate and tells you which one it matched:
// "because this sounds like X". Four mechanics carry over more or less intact —
// nearest-neighbour against the saved set rather than a fixed reference, a
// bounded penalty for the clusters you keep dismissing, exclusion of what you
// already have, and naming the match so a recommendation is legible instead of
// oracular.
//
// One thing deliberately does NOT carry over. Acetate says, in a comment at the
// top of its recommender, "the watchlist is the entire taste signal. No
// persistent profile exists beyond it." That is the right call there and the
// wrong one here: this app has a written profile at revision 2, seven weighted
// dimensions, twelve confirmed acquisitions and a twenty-four-fixture
// calibration suite. Ten saves should not be allowed to outvote that. So the
// profile is the prior and the saves are a bounded correction to it — the base
// score is never overwritten, the adjustment is capped, and both are shown.
//
// Everything here is pure. The browser runs it on every render, which is what
// makes a save feel like it did something: the feed re-ranks immediately, with
// no rebuild and no server.

import { DIMS, vectorOf, firedMask, weightsFrom, nearestOf, meanVector } from './vector.mjs?v=a8985e3957';
import { SAVED, PASSED, verdictOf } from './saved-books.mjs?v=a8985e3957';

// Below this, there is nothing to learn from and the honest thing is to say so.
// Acetate does the same by writing no recommendations at all for an empty crate.
export const MIN_SIGNAL = 3;

// The same floor for a reader who is refusing books rather than saving them.
//
// The model used to switch on at three *saves* and at nothing else, so a reader
// who passed on twenty books in a row taught it nothing at all: the passes were
// recorded, the books disappeared, and every remaining score was exactly what
// the profile had said before. Refusing twenty books is a strong statement about
// taste and it was being thrown away.
//
// It is not one gate, though, because the three parts do not all work from the
// same evidence. Tag affinity is symmetric — it already counted a pass as
// evidence against — so it can run on verdicts of either kind. The dimension
// tilt and the nearest-neighbour anchor need books you liked: there is no such
// thing as the average of the books you refused standing in for a book you would
// want. So passes open the half that can use them and no more.
export const MIN_JUDGMENTS = 5;

// The most the saves may move a score, on the 0–100 scale the profile uses.
// Eight points is ±0.8 out of ten: enough to reorder books that were already
// close and to push a 6.4 over the line, not enough to manufacture a
// recommendation out of a book the profile found nothing in.
export const MAX_ADJUSTMENT = 8;

// How that budget is split. Tags are the coarsest signal and the most legible;
// the dimension tilt is the one that actually says something about the profile;
// an author you have saved before is a small, near-certain nudge.
const BUDGET = { tags: 3.5, dimensions: 3.5, author: 1 };

// Acetate scales its dismissal penalty by the most-dismissed cluster and caps
// the effect at 45%, so one loud cluster cannot zero everything out. Same idea:
// affinity is measured against the strongest signal present, not in absolutes.
const PASS_WEIGHT = 1;

// Which tag kinds carry taste. The other five do not, and letting them in was
// the first thing that went wrong: 127 of the 186 tags in the feed are imprints,
// almost all of them on one or two books, so the model cheerfully concluded
// "you pass on books tagged HQ Digital" from a single pass. `attention` counts
// reviews, `caveat` describes how good our metadata is, and `question` is the
// profile's own bookkeeping — none of them are facts about a book. Acetate
// learns on genre_cluster for the same reason: the label has to mean something
// before a preference for it can.
const LEARNABLE_KINDS = new Set(['subject', 'genre', 'tone', 'form', 'period', 'scale', 'press', 'prose', 'rule']);

const learnable = (entry) => (entry.tags || []).filter((t) => LEARNABLE_KINDS.has(t.kind));

const surnameOf = (author) => {
  const parts = String(author || '').toLowerCase().replace(/[^a-z .'-]/g, '').split(/\s+/).filter(Boolean);
  const cut = parts.indexOf('and');
  const use = cut > 0 ? parts.slice(0, cut) : parts;
  return use.length ? use[use.length - 1] : '';
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---------------------------------------------------------------- the model

// Builds everything the tuner needs from the verdicts and the feed. Called once
// per render; cheap enough at feed scale that memoising it would cost more in
// staleness bugs than it saves.
export function buildTasteModel(verdicts, books, feedDimensions, { exclude = null } = {}) {
  const weights = weightsFrom(feedDimensions);
  const names = Object.fromEntries((feedDimensions || []).map((d) => [d.id, d.name]));
  const saved = [];
  const passed = [];
  for (const entry of books || []) {
    if (entry.id === exclude) continue;
    const v = verdictOf(verdicts, entry.id);
    if (v === SAVED) saved.push(entry);
    else if (v === PASSED) passed.push(entry);
  }

  const model = {
    weights,
    // Kept so the tuner knows which books need a leave-one-out model rather than
    // the shared one. Not an exclusion list: everything gets scored.
    judged: new Set([...saved, ...passed].map((e) => e.id)),
    // Lazily-built models with one book held out, cached by that book's id.
    loo: new Map(),
    source: { verdicts, books, feedDimensions },
    excluded: exclude,
    savedCount: saved.length,
    passedCount: passed.length,
    // `ready` means the model has something to say. `anchored` means it has
    // positive examples, which the tilt and the references require and passes
    // cannot supply.
    anchored: saved.length >= MIN_SIGNAL,
    ready: saved.length >= MIN_SIGNAL || (saved.length + passed.length) >= MIN_JUDGMENTS,
    tags: new Map(),
    // How often each learnable tag appears across the whole corpus. Kept on the
    // model because the explorer needs it: a tag on one book teaches almost
    // nothing whatever the reader says about it, and a tag on sixty teaches a
    // great deal.
    availability: new Map(),
    authors: new Set(),
    references: [],
    tilt: [],
    strongestTags: [],
    weakestTags: [],
  };
  if (!model.ready) { model.judged = new Set(); return model; }


  // --- tag affinity, both directions -------------------------------------
  // A tag you save under is evidence for; one you pass on is evidence against.
  // Raw counts would let a tag that appears on half the feed dominate, so each
  // is measured against how often it was available to be saved.
  const availability = new Map();
  for (const entry of books || []) {
    for (const t of learnable(entry)) availability.set(t.id, (availability.get(t.id) || 0) + 1);
  }

  const tally = new Map();
  const bump = (entry, delta) => {
    for (const t of learnable(entry)) {
      const row = tally.get(t.id) || { id: t.id, label: t.label, kind: t.kind, saves: 0, passes: 0 };
      if (delta > 0) row.saves += 1; else row.passes += PASS_WEIGHT;
      tally.set(t.id, row);
    }
  };
  saved.forEach((e) => bump(e, 1));
  passed.forEach((e) => bump(e, -1));

  // Net signal per tag, scaled by the strongest net signal present so the
  // budget is spent relative to the evidence rather than in absolutes.
  let strongest = 0;
  for (const row of tally.values()) {
    row.available = availability.get(row.id) || 1;
    row.net = row.saves - row.passes;
    // A tag seen once is a coincidence. Damp small counts rather than excluding
    // them, so the model warms up smoothly instead of switching on.
    row.confidence = Math.min(1, (row.saves + row.passes) / 3);
    row.signal = (row.net / row.available) * row.confidence;
    strongest = Math.max(strongest, Math.abs(row.signal));
  }
  for (const row of tally.values()) row.weight = strongest ? row.signal / strongest : 0;
  model.tags = tally;
  model.availability = availability;

  const ranked = [...tally.values()].filter((r) => r.saves + r.passes >= 2).sort((a, b) => b.weight - a.weight);
  model.strongestTags = ranked.filter((r) => r.weight > 0.15).slice(0, 6);
  model.weakestTags = ranked.filter((r) => r.weight < -0.15).reverse().slice(0, 4);

  // --- authors -----------------------------------------------------------
  for (const e of saved) { const s = surnameOf(e.book?.author); if (s) model.authors.add(s); }

  // --- reference vectors --------------------------------------------------
  // The saved books themselves, for the nearest-neighbour anchor. Thin rows are
  // left out: a vector that is mostly defaults describes the gaps in a review,
  // not the book, and would match everything equally badly.
  model.references = model.anchored
    ? saved
      .filter((e) => firedMask(e.score).filter(Boolean).length >= 3)
      .map((e) => ({ id: e.id, title: e.book?.title, author: e.book?.author, vector: vectorOf(e.score) }))
    : [];

  // --- dimension tilt -----------------------------------------------------
  // Where the books you save run hotter or cooler than the field. This is the
  // one component that says something about the profile itself rather than
  // about any book: a large positive tilt on D3 means you are saving formally
  // ambitious books more than the profile's weighting predicts.
  const savedMean = meanVector(saved);
  const fieldMean = meanVector(books || []);
  model.tilt = DIMS.map((id, i) => {
    const mine = model.anchored ? savedMean.mean[i] : null;
    const field = fieldMean.mean[i];
    // Four saves with evidence on a dimension is the floor for saying anything
    // about it; below that the mean is one book's opinion.
    if (mine === null || field === null || savedMean.counts[i] < 4) {
      return { id, name: names[id], delta: 0, mine, field, n: savedMean.counts[i], enough: false };
    }
    return { id, name: names[id], delta: mine - field, mine, field, n: savedMean.counts[i], enough: true };
  });

  return model;
}

// ---------------------------------------------------------------- applying

// The adjustment for one book, with the reasons that produced it. Returns the
// parts as well as the total so the row can show its working — the same
// discipline the score itself follows, where every dimension shows the terms it
// fired on so a wrong answer is visible as a wrong answer.
// A book you have saved is still scored — those are the books you like, and a
// score you cannot see on them is a score you cannot check. But it is scored
// against the *other* saves, not against a model it helped build. Each save is
// roughly a tenth of its own evidence, and letting a book vote for itself
// inflated the saves by 1.3 points on average and 2.2 at worst, which would put
// your own collection at the top of the feed by construction.
//
// So: leave-one-out. Rebuild the model without this book, cache it against the
// book's id, and score against that. The cache lives on the model, so it is
// thrown away and rebuilt whenever the verdicts change, which is the only time
// it could go stale.
function modelFor(entry, model) {
  if (!model.judged.has(entry.id)) return model;
  if (!model.loo.has(entry.id)) {
    const { verdicts, books, feedDimensions } = model.source;
    model.loo.set(entry.id, buildTasteModel(verdicts, books, feedDimensions, { exclude: entry.id }));
  }
  return model.loo.get(entry.id);
}

export function tuneEntry(entry, shared) {
  const empty = { delta: 0, reasons: [], nearest: null, tuned: false };
  if (!shared?.ready || !entry) return empty;

  const judged = shared.judged.has(entry.id);
  const model = modelFor(entry, shared);
  // Holding a book out can drop the remaining saves below the floor — at three
  // saves, removing one leaves two. Nothing to score it against, so it keeps the
  // profile's own number until there are enough saves to spare one.
  if (!model.ready) return { ...empty, judged, heldOut: true };

  const reasons = [];
  let delta = 0;

  // --- tags ---------------------------------------------------------------
  const tags = learnable(entry).map((t) => model.tags.get(t.id)).filter((r) => r && Math.abs(r.weight) > 0.15);
  if (tags.length) {
    // Mean rather than sum: a book carrying eight liked tags is not eight times
    // the evidence, it is one book that happens to be well described. But one
    // matching tag is not the same as three, so the mean is scaled by how much
    // of the book the tags actually cover.
    const mean = tags.reduce((s, r) => s + r.weight, 0) / tags.length;
    const coverage = Math.min(1, tags.length / 3);
    const part = clamp(mean, -1, 1) * coverage * BUDGET.tags;
    delta += part;
    const top = tags.slice().sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))[0];
    if (Math.abs(part) >= 0.3) {
      reasons.push({
        kind: 'tag',
        points: part,
        label: part > 0
          ? `you save books tagged ${top.label}`
          : `you pass on books tagged ${top.label}`,
      });
    }
  }

  // --- dimension tilt -----------------------------------------------------
  // Scored against this book's own fired dimensions only, weighted by how much
  // the profile already cares about each one.
  const v = vectorOf(entry.score);
  const fired = firedMask(entry.score);
  let tiltNum = 0, tiltDen = 0;
  // Per-dimension contributions, kept so the reason can name the dimension that
  // actually moved this book rather than the one with the biggest tilt overall.
  // Naming the global leader made every row say "D1" whatever it was scored on.
  const contributions = [];
  for (let i = 0; i < DIMS.length; i++) {
    const t = model.tilt[i];
    if (!fired[i] || !t.enough) continue;
    // Above the field mean on a dimension your saves also run above: agreement.
    const c = model.weights[i] * (t.delta / 10) * ((v[i] - t.field) / 10);
    contributions.push({ id: t.id, name: t.name, c });
    tiltNum += c;
    tiltDen += model.weights[i];
  }
  if (tiltDen) {
    // Divided by the whole profile's weight, not by the weight that fired. The
    // first version divided by the latter and got it exactly backwards: a book
    // with one lonely dimension had a tiny denominator and so was tuned hardest,
    // when a single dimension is the least one can know about a book. Against
    // the full 100 the term scales with how much of the book was actually read.
    const total = model.weights.reduce((a, b) => a + b, 0) || 100;
    const part = clamp((tiltNum / total) * 40, -1, 1) * BUDGET.dimensions;
    if (Math.abs(part) >= 0.3) {
      const lead = contributions.slice().sort((a, b) => Math.abs(b.c) - Math.abs(a.c))[0];
      // The dimension's name, and never its id. "It runs with your saves on
      // structure (D1)" put an internal handle in front of a reader and then
      // asked them to work out what running with their saves on it meant.
      const where = (lead.name || lead.id).toLowerCase();
      reasons.push({
        kind: 'dimension',
        points: part,
        label: part > 0
          ? `the books you save score like this one on ${where}`
          : `the books you save score differently on ${where}`,
      });
    }
    delta += part;
  }

  // --- author -------------------------------------------------------------
  const surname = surnameOf(entry.book?.author);
  if (surname && model.authors.has(surname)) {
    delta += BUDGET.author;
    reasons.push({ kind: 'author', points: BUDGET.author, label: `you saved ${entry.book.author} before` });
  }

  // --- nearest saved book -------------------------------------------------
  // Carries no points. It is the explanation, not the evidence — Acetate's
  // "because this sounds like X" reused as "reads like X, which you saved".
  const nearest = model.references.length
    ? nearestOf(v, model.references.filter((r) => r.id !== entry.id), model.weights)
    : null;
  // Withheld when the model is demoting the book. "Runs against your saves" and
  // "reads like something you saved" in the same breath is a contradiction, and
  // the reader is right to trust neither half of it. Proximity on the vector and
  // agreement with the tilt are different claims; only show the anchor when they
  // are not fighting.
  const near = nearest && nearest.distance < 0.3 && delta > -0.3 ? nearest : null;

  return {
    delta: clamp(delta, -MAX_ADJUSTMENT, MAX_ADJUSTMENT),
    reasons: reasons.sort((a, b) => Math.abs(b.points) - Math.abs(a.points)),
    nearest: near,
    tuned: Math.abs(delta) >= 0.3 || Boolean(near),
    judged,
  };
}

// Base score plus adjustment, on the same 0–100 scale, clamped to the scale.
// The base is kept alongside so the row can show both and nothing is lost.
export function tunedTotal(entry, model) {
  const base = entry?.score?.total ?? 0;
  const t = tuneEntry(entry, model);
  return { ...t, base, total: clamp(base + t.delta, 0, 100) };
}

// ---------------------------------------------------------------- reporting

// What the tuning would say about the profile itself, in the profile's own
// terms. This is the input to bin/tune.mjs, which turns it into a proposed
// weight change and then runs the calibration suite to show what that breaks.
// Nothing here changes a weight on its own.
export function weightProposal(model, dimensionNames = {}) {
  if (!model?.ready) return [];
  const total = model.weights.reduce((s, w) => s + w, 0) || 1;
  return model.tilt
    .filter((t) => t.enough && Math.abs(t.delta) >= 0.5)
    .map((t, i) => {
      const idx = DIMS.indexOf(t.id);
      const current = model.weights[idx];
      // A tilt of one full band on a ten-point scale argues for a tenth more
      // weight. Deliberately timid: this is a suggestion to a human reading a
      // calibration report, not a gradient step.
      const suggested = Math.round(clamp(current * (1 + (t.delta / 10) * 0.5), current - 6, current + 6));
      return {
        id: t.id,
        name: dimensionNames[t.id] || t.id,
        current,
        suggested,
        delta: suggested - current,
        savedMean: Math.round(t.mine * 10) / 10,
        fieldMean: Math.round(t.field * 10) / 10,
        n: t.n,
        share: Math.round((current / total) * 100),
      };
    })
    .filter((p) => p.delta !== 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}

// ---------------------------------------------------------------- exploring

// The one book on the shelf the model cannot place.
//
// Everything above ranks by what the model already believes, which is the whole
// point of it and also its one structural failure: a feed sorted strictly by
// score only ever offers what it already thinks you want, so a model that is
// wrong about you never finds out. It hardens instead of learning. The reader
// sees a narrower and narrower shelf and the app reads it as agreement.
//
// So one slot is spent on the opposite question. Not a random book — random is
// noise, and a reader who is shown noise stops trusting the shelf. The pick is
// the book whose verdict would resolve the most of what the model does not know.
//
// Uncertainty is concrete here rather than statistical. `model.tags` holds only
// the tags that have appeared on a book the reader ruled on, so a tag absent
// from it has never had a verdict either way — the model has no opinion, and
// `tuneEntry` skips it. The value of learning one is how much of the corpus it
// would explain, which is exactly `availability`. A book is worth showing in
// proportion to the corpus coverage of its tags the model has never seen.
//
// This is the cheap half of a bandit and none of the arithmetic: no posterior,
// no confidence interval, no regret bound. What carries over is the idea that a
// recommender has to spend something on finding out it is wrong.

// Below this a tag is a coincidence rather than a thing to learn about. Measured
// against the corpus: 127 of the tags in the feed are imprints on one or two
// books, and an explorer that chases those would offer a different obscurity
// every day and learn nothing transferable.
const MIN_COVERAGE = 8;

export function unknownCoverage(entry, model) {
  if (!model?.ready) return { score: 0, tags: [] };
  const unknown = [];
  for (const t of learnable(entry)) {
    if (model.tags.has(t.id)) continue;
    const seen = model.availability.get(t.id) || 0;
    if (seen < MIN_COVERAGE) continue;
    unknown.push({ id: t.id, label: t.label, kind: t.kind, seen });
  }
  // Square-rooted, so a book with one very common unknown tag is not beaten by a
  // book with four rare ones. Breadth counts; it should not dominate.
  const score = unknown.reduce((sum, t) => sum + Math.sqrt(t.seen), 0);
  return { score, tags: unknown.sort((a, b) => b.seen - a.seen) };
}

/**
 * Pick the book most worth a verdict.
 *
 * `eligible` is the caller's business: it should already exclude what the reader
 * has ruled on, what is unscored, and whatever is on screen elsewhere, because a
 * reserve pick that duplicates the shelf spends the slot on nothing.
 */
export function explore(eligible, model) {
  if (!model?.ready) return null;
  let best = null;
  for (const entry of eligible || []) {
    const { score, tags } = unknownCoverage(entry, model);
    if (!tags.length) continue;
    if (!best || score > best.score) best = { entry, score, tags };
  }
  return best;
}
