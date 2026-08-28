// Building a profile from six questions.
//
// A reader arriving here has no reading-taste document, no twelve confirmed
// acquisitions and no calibration suite. What they have is a few minutes and
// some opinions. This turns those opinions into the same override object the
// Profile screen writes, so nothing downstream knows the difference.
//
// Two rules shape it.
//
// The answer has to name a band, not a dimension. "I like the prose" says D4
// matters and nothing about which prose: McCarthy and Carver sit at opposite
// ends of that dimension. So the chips below are band labels, and picking one
// moves that band's score rather than only its dimension's weight.
//
// And the starting point is not this profile. The published feed carries one
// reader's weights, and handing those to a stranger makes their feed a copy of
// his until they have answered enough to escape it. So a new profile begins
// with those weights pulled halfway to uniform.

import { EMPTY, bandKey } from './overrides.mjs';

// Halfway. Not all the way: a perfectly flat profile scores every book the same
// and hands a newcomer a feed with no shape at all, which teaches them nothing
// about what the app does. Halfway keeps the literary-fiction prior legible
// while letting six answers actually move it.
export const SHRINK = 0.5;

export function shrunkWeights(profile, lambda = SHRINK) {
  const dims = profile.dimensions || [];
  if (!dims.length) return {};
  const uniform = dims.reduce((s, d) => s + d.weight, 0) / dims.length;
  const out = {};
  for (const d of dims) {
    const w = Math.round(lambda * uniform + (1 - lambda) * d.weight);
    if (w !== d.weight) out[d.id] = w;
  }
  return out;
}

// The bands worth asking about: the ones that most separate one reader from
// another. All 52 would be a form, not a question.
export const CHIPS = [
  { dim: 'D4', band: 'baroque', label: 'Dense, baroque prose' },
  { dim: 'D4', band: 'spare', label: 'Spare, precise prose' },
  { dim: 'D4', band: 'lyric_dread', label: 'Lyric, with dread under it' },
  { dim: 'D4', band: 'quippy', label: 'Comic, wry prose' },
  { dim: 'D5', band: 'dread', label: 'Dread and menace' },
  { dim: 'D5', band: 'elegiac', label: 'Elegiac, haunted' },
  { dim: 'D5', band: 'comic', label: 'Comic and satirical' },
  { dim: 'D5', band: 'hardboiled', label: 'Hardboiled, noir' },
  { dim: 'D5', band: 'gothic', label: 'Gothic, uncanny' },
  { dim: 'D5', band: 'warm', label: 'Warm and humane' },
  { dim: 'D3', band: 'constraint', label: 'Formal constraint' },
  { dim: 'D3', band: 'polyphony', label: 'Many voices, no centre' },
  { dim: 'D3', band: 'conventional', label: 'Told straight' },
  { dim: 'D3', band: 'device_twist', label: 'A late reveal' },
  { dim: 'D1', band: 'dual_timeline', label: 'Two timelines' },
  { dim: 'D1', band: 'period_causal', label: 'Set in the past' },
  { dim: 'D1', band: 'sealed', label: 'Firmly in the present' },
  { dim: 'D2', band: 'land', label: 'Land, labour, extraction' },
  { dim: 'D2', band: 'state_violence', label: 'States and their violence' },
  { dim: 'D2', band: 'domestic', label: 'Family and marriage' },
  { dim: 'D2', band: 'crime', label: 'Crime and the law' },
  { dim: 'D2', band: 'media_tech', label: 'Internet life' },
  { dim: 'D6', band: 'sprawl', label: 'Long and sprawling' },
  { dim: 'D6', band: 'short_conv', label: 'Short' },
  { dim: 'D7', band: 'indie', label: 'Independent presses' },
  { dim: 'D7', band: 'bookclub', label: 'Book-club picks' },
];

const LIKED = 9;
const DISLIKED = 2;
// Picking three prose chips says prose is what you read for. The dimension gains
// weight for each pick beyond the first, which is the only signal here about
// what matters rather than what is liked.
const WEIGHT_PER_EXTRA = 6;

/**
 * Turn the answers into an override object.
 * liked / disliked are arrays of `${dim}:${band}` keys; nonfiction and satire
 * are booleans meaning "yes, I read this".
 */
export function buildProfile(profile, { liked = [], disliked = [], nonfiction = false, satire = false } = {}) {
  const o = { ...EMPTY, weights: shrunkWeights(profile), bands: {}, rules: {}, adjustments: {} };

  const bump = {};
  const apply = (keys, score) => {
    for (const key of keys) {
      const [dim, band] = key.split(':');
      const d = (profile.dimensions || []).find((x) => x.id === dim);
      const b = (d?.bands || []).find((x) => x.id === band);
      if (!b) continue;
      o.bands[bandKey(dim, band)] = score;
      bump[dim] = (bump[dim] || 0) + 1;
    }
  };
  apply(liked, LIKED);
  apply(disliked, DISLIKED);

  for (const [dim, n] of Object.entries(bump)) {
    if (n < 2) continue;
    const d = (profile.dimensions || []).find((x) => x.id === dim);
    if (!d) continue;
    const base = o.weights[dim] ?? d.weight;
    o.weights[dim] = Math.min(60, base + (n - 1) * WEIGHT_PER_EXTRA);
  }

  // One question here is worth more than five votes, and it is the only part of
  // the profile a reader can state outright rather than have inferred.
  if (nonfiction) o.adjustments.nonfiction = false;
  if (satire) { o.adjustments.satire = false; o.adjustments.pynchon = false; }

  // A reader who says they like a late reveal does not hold the rule that scores
  // one at 3 whatever the review earned.
  if (liked.includes('D3:device_twist')) o.rules.twist_override = false;

  return o;
}
