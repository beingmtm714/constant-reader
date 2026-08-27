// The seven-dimension vector, and distance between two of them.
//
// Two things measure distance in this app and they answer different questions —
// lib/describe.mjs asks "what confirmed acquisition does this resemble", and
// web/lib/taste.mjs asks "what book that you actually saved does this resemble".
// Same arithmetic, so it lives here once. (Acetate Club's own reuse audit puts
// the rule plainly: compose the shared source, don't copy it.)

export const DIMS = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7'];

export function vectorOf(scored) {
  return DIMS.map((id) => scored?.dimensions?.[id]?.score ?? 0);
}

// Which dimensions actually fired, as a mask. A defaulted dimension is the
// absence of evidence rather than a score of 5, and averaging it in would pull
// every thin book toward the middle and make them all look alike.
export function firedMask(scored) {
  return DIMS.map((id) => !scored?.dimensions?.[id]?.defaulted);
}

export function weightsFrom(dimensions) {
  const byId = new Map((dimensions || []).map((d) => [d.id, d.weight]));
  return DIMS.map((id) => byId.get(id) ?? 0);
}

// Weighted Euclidean distance, normalised to 0–1 so a threshold means the same
// thing whatever the weights currently are.
export function distance(a, b, weights) {
  const worst = Math.sqrt(weights.reduce((s, w) => s + w * 100, 0));
  if (!worst) return 1;
  const d = Math.sqrt(DIMS.reduce((s, _, i) => s + weights[i] * (a[i] - b[i]) ** 2, 0));
  return d / worst;
}

// The closest of a set of reference vectors, or null if there are none.
// Acetate's recommender takes the single best match rather than an average and
// then names it — "because this sounds like X" — which is the part that makes a
// recommendation legible instead of oracular.
export function nearestOf(vector, references, weights) {
  let best = null;
  for (const ref of references) {
    const d = distance(vector, ref.vector, weights);
    if (!best || d < best.distance) best = { ...ref, distance: d };
  }
  return best;
}

// Mean vector over a set, counting only the dimensions that fired in each member
// so a dimension nobody had evidence for does not read as a lukewarm 5.
export function meanVector(entries, toScored = (e) => e.score) {
  const sums = DIMS.map(() => 0);
  const counts = DIMS.map(() => 0);
  for (const e of entries) {
    const scored = toScored(e);
    const v = vectorOf(scored);
    const fired = firedMask(scored);
    for (let i = 0; i < DIMS.length; i++) {
      if (!fired[i]) continue;
      sums[i] += v[i];
      counts[i] += 1;
    }
  }
  return { mean: sums.map((s, i) => (counts[i] ? s / counts[i] : null)), counts };
}
