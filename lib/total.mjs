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

// The weighted sum, the adjustments already totalled by the caller, and the two
// rules that overrule a sum rather than contribute to it.
export function totalFrom({ dims, profile, adjustmentPoints = 0, excluded = false }) {
  const { raw: base, fired, firedWeight, renormalised } = weightedSum(dims, profile);
  let raw = base + adjustmentPoints;

  // Renormalising over a handful of dimensions lets those few carry the entire
  // number. Score it, but never above the line where the score becomes a claim.
  const evidence = profile.evidenceRule || {};
  const partialEvidence = !renormalised;
  if (partialEvidence && evidence.cap != null && raw > evidence.cap) raw = evidence.cap;

  // Trap 3: below the prose floor nothing compensates. Applied after the weighted
  // sum so a book can be perfect on architecture and still not surface.
  const floor = profile.proseFloor || { maxBandScore: 1, cap: 60 };
  let proseFloorApplied = false;
  if (!excluded && dims.D4.score <= floor.maxBandScore && raw > floor.cap) {
    raw = floor.cap;
    proseFloorApplied = true;
  }

  const total = excluded ? 0 : Math.max(0, Math.min(100, Math.round(raw * 10) / 10));
  return { total, raw, fired, firedWeight, renormalised, partialEvidence, proseFloorApplied };
}
