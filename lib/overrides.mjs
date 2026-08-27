// One reader's ordering laid over the shared vocabulary.
//
// A band carries two things doing different jobs. Its label describes the book:
// "braided", "comic", "independent press". Its score ranks that description for one
// reader, and D5 running dread 10 down to comic 4 is a fact about Michael rather
// than a fact about tone. The feed is built once against his ordering, so a second
// reader needs a way to disagree with it without a rebuild.
//
// Three kinds of disagreement, in the order they are applied:
//
//   rules   - undo a non-linear rule you do not hold. The twist override scores a
//             resolving device at 3 whatever the review earned; a reader who likes
//             a late reveal restores the band from the preRule the scorer recorded.
//   bands   - re-score a band. Comic at 9 instead of 4.
//   weights - re-weight a dimension. Prose at 10 instead of 24.
//
// Rules first, because undoing one changes which band is in play and therefore
// which band score an override applies to.
//
// The arithmetic is not reimplemented here. lib/total.mjs is the same module the
// build uses, so a re-scored row and a freshly built one cannot disagree.

import { totalFrom } from './total.mjs';

export const EMPTY = { rules: {}, bands: {}, weights: {}, adjustments: {} };

export function normalizeOverrides(o) {
  return { ...EMPTY, ...(o || {}) };
}

export const bandKey = (dimension, bandId) => `${dimension}:${bandId}`;

// Has this reader said anything at all? An empty override set must return the
// profile's own number untouched rather than a recomputed approximation of it.
export function isEmpty(o) {
  const n = normalizeOverrides(o);
  return ['rules', 'bands', 'weights', 'adjustments'].every((k) => Object.keys(n[k]).length === 0);
}

// The dimension as this reader would have scored it. Returns the original object
// when nothing applies, so callers can test identity to see if anything moved.
function applyToDimension(dim, o) {
  let out = dim;

  // A rule this reader does not hold, undone. Only possible where the scorer
  // recorded what the rule displaced, which is why preRule exists at all.
  if (out.rule && o.rules[out.rule] === false && out.preRule) {
    out = {
      ...out,
      id: out.preRule.id,
      score: out.preRule.score,
      label: out.preRule.label,
      defaulted: out.preRule.defaulted ?? out.defaulted,
      ruleUndone: out.rule,
      rule: undefined,
      preRule: undefined,
    };
  }

  // A band re-scored. Applied after the rule so it lands on the band actually in
  // play: undoing the twist and then re-scoring "braided" scores the braid.
  if (out.id != null) {
    const override = o.bands[bandKey(out.dimension, out.id)];
    if (typeof override === 'number' && override !== out.score) {
      out = { ...out, score: override, bandRescored: { from: out.score, to: override } };
    }
  }
  return out;
}

// The profile with this reader's weights in it. Weights are not renormalised to a
// hundred: totalFrom divides by the weight that actually fired, so the scale comes
// out in the wash and a reader who doubles one weight has doubled it relative to
// the rest, which is what they meant.
function applyToProfile(profile, o) {
  const weights = o.weights;
  if (!Object.keys(weights).length) return profile;
  return {
    ...profile,
    dimensions: profile.dimensions.map((d) =>
      (typeof weights[d.id] === 'number' ? { ...d, weight: weights[d.id] } : d)),
  };
}

// Penalties and filters this reader has switched off. The nonfiction filter at
// minus forty-five is one reader's exclusion sitting in a shared config, and a
// reader who reads nonfiction has to be able to drop it.
function adjustmentPointsFor(score, o) {
  return (score.adjustments || [])
    .filter((a) => o.adjustments[a.id] !== false)
    .reduce((sum, a) => sum + (a.points || 0), 0);
}

/**
 * Rescore one built entry against a reader's overrides.
 * Returns the profile's own numbers unchanged when the reader has said nothing.
 */
export function rescore(score, profile, rawOverrides) {
  const o = normalizeOverrides(rawOverrides);
  if (isEmpty(o) || !score || !score.dimensions) {
    return { total: score?.total ?? null, dimensions: score?.dimensions ?? {}, changed: false, base: score?.total ?? null };
  }

  const dimensions = {};
  let moved = false;
  for (const [id, dim] of Object.entries(score.dimensions)) {
    const next = applyToDimension(dim, o);
    if (next !== dim) moved = true;
    dimensions[id] = next;
  }

  const p = applyToProfile(profile, o);
  const weightsMoved = p !== profile;
  const points = adjustmentPointsFor(score, o);
  const pointsMoved = points !== (score.adjustments || []).reduce((s, a) => s + (a.points || 0), 0);

  // An excluded row stays excluded only while the reader still holds the filter
  // that excluded it. Dropping the filter has to be able to bring the book back.
  const stillExcluded = (score.filters || []).some((f) => o.adjustments[f.id] !== false)
    && (score.band === 'excluded');

  const t = totalFrom({ dims: dimensions, profile: p, adjustmentPoints: points, excluded: stillExcluded });

  // Recompute the contribution so a row can show where its number came from under
  // this reader's weights rather than the profile's. Copied rather than assigned
  // into: a dimension nothing moved is still the object the built entry holds, and
  // writing through it would let one reader's weights leak into the stored feed and
  // into the next reader's rescore.
  for (const d of p.dimensions) {
    const dim = dimensions[d.id];
    if (dim) dimensions[d.id] = { ...dim, weight: d.weight, contribution: Math.round(dim.score * d.weight) / 10 };
  }

  return {
    ...t,
    dimensions,
    base: score.total,
    changed: moved || weightsMoved || pointsMoved,
    delta: Math.round((t.total - score.total) * 10) / 10,
  };
}

// What this reader has actually changed, for a settings screen to list back and for
// a row to explain itself with. A reader should be able to see their own profile.
export function summarize(o, profile) {
  const n = normalizeOverrides(o);
  const bandLabel = (key) => {
    const [dim, id] = key.split(':');
    const d = (profile.dimensions || []).find((x) => x.id === dim);
    const b = (d?.bands || []).find((x) => x.id === id);
    return { dimension: dim, dimensionName: d?.name, band: id, label: b?.label, was: b?.score };
  };
  return {
    rules: Object.entries(n.rules).filter(([, v]) => v === false).map(([id]) => id),
    bands: Object.entries(n.bands).map(([k, v]) => ({ ...bandLabel(k), now: v })),
    weights: Object.entries(n.weights).map(([id, w]) => {
      const d = (profile.dimensions || []).find((x) => x.id === id);
      return { dimension: id, name: d?.name, was: d?.weight, now: w };
    }),
    adjustments: Object.entries(n.adjustments).filter(([, v]) => v === false).map(([id]) => id),
  };
}
