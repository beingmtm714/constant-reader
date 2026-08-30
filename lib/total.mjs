// Turning seven dimension scores into one number.
//
// Under web/lib rather than lib because bin/serve.mjs serves web/ and refuses
// anything above it, so a module the browser imports has to live here. That is
// already the rule vector.mjs follows: lib/describe.mjs reaches down into
// web/lib for it rather than the other way around.
//
// Pulled out of score.mjs because two callers need it and they must agree. The
// build computes a total once against this profile. The browser recomputes it
// whenever a reader overrides a band's score or a dimension's weight, and if the
// two arithmetics drifted apart the feed would disagree with its own build about
// what a book is worth.
//
// Everything above the weighted sum stays in score.mjs. This takes the dimension
// scores as given and applies only what the profile says to do with them: score on
// what fired, cap what is thin, and let the prose floor overrule the rest.

// A dimension the review never spoke to should not be scored as if it had, so the
// sum runs over what fired and is scaled back up. Measured by weight rather than by
// count: D6 needs a page count and D7 a publisher, and for a book published this
// year the catalogue often has neither.
export function weightedSum(dims, profile) {
  const fired = profile.dimensions.filter((d) => !dims[d.id].defaulted);
  const firedWeight = fired.reduce((sum, d) => sum + d.weight, 0);
  const evidence = profile.evidenceRule || { minDimensions: 5, minWeight: 55 };
  const renormalised = firedWeight >= evidence.minWeight;
  const raw = renormalised
    ? fired.reduce((sum, d) => sum + dims[d.id].score * d.weight, 0) / firedWeight * 10
    : profile.dimensions.reduce((sum, d) => sum + dims[d.id].score * d.weight, 0) / 10;
  return { raw, fired, firedWeight, renormalised };
}

// How far a thin score is pulled back toward the middle of the field.
//
// Renormalising over what fired lets a handful of dimensions carry the whole
// number: a book that fires one dimension at 10 out of 10 lands above a book
// that fires six and averages 8, on one data point against six. The cap that
// used to guard this was a cliff - a flat 6.9 for everything under 30 points of
// fired weight, which flattened 330 books into one value and, measured, was not
// binding on a single one of them.
//
// Shrinkage does the same job continuously. The score is the weighted average of
// what actually fired and a phantom book sitting at the corpus mean, carrying
// `weight` points of its own. A book firing 80 points of evidence barely moves;
// a book firing 8 lands most of the way back at the middle, which is the honest
// place for it. Standard Bayesian average, the shape the IMDb ranking uses.
//
// The prior travels in feed.json so the browser reaches the same number when a
// reader re-weights a dimension. With no prior configured this is a no-op and
// the old cap still applies, which is what keeps the calibration fixtures valid.
export function shrink(raw, firedWeight, prior) {
  if (!prior || !prior.weight) return { value: raw, shrunk: false };
  const value = (prior.weight * prior.mean + firedWeight * raw) / (prior.weight + firedWeight);
  return { value, shrunk: true, pull: value - raw };
}

// The weighted sum, the adjustments already totalled by the caller, and the two
// rules that overrule a sum rather than contribute to it.
export function totalFrom({ dims, profile, adjustmentPoints = 0, excluded = false }) {
  const { raw: base, fired, firedWeight, renormalised } = weightedSum(dims, profile);

  const evidence = profile.evidenceRule || {};
  const partialEvidence = !renormalised;

  // Shrinkage is about how much evidence there is, so it applies to the weighted
  // average of what fired and to nothing else. The profile's own penalties are
  // deliberate rules rather than weak evidence, and they are added afterwards at
  // full force - smoothing a stated exclusion toward the middle of the field
  // would be the profile disagreeing with itself.
  const pulled = shrink(base, firedWeight, profile.prior);
  let raw = pulled.value + adjustmentPoints;
  // The cap stays as the fallback for a profile with no prior computed yet.
  if (!pulled.shrunk && partialEvidence && evidence.cap != null && raw > evidence.cap) raw = evidence.cap;

  // Trap 3: below the prose floor nothing compensates. Applied after the weighted
  // sum so a book can be perfect on architecture and still not surface.
  const floor = profile.proseFloor || { maxBandScore: 1, cap: 60 };
  let proseFloorApplied = false;
  if (!excluded && dims.D4.score <= floor.maxBandScore && raw > floor.cap) {
    raw = floor.cap;
    proseFloorApplied = true;
  }

  const total = excluded ? 0 : Math.max(0, Math.min(100, Math.round(raw * 10) / 10));
  return { total, raw, fired, firedWeight, renormalised, partialEvidence, proseFloorApplied,
    shrunk: pulled.shrunk, shrinkPull: pulled.shrunk ? Math.round(pulled.pull * 10) / 10 : 0 };
}
