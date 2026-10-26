// The score on a one-to-ten scale, and the rule for what earns the tag.
//
// Kept apart from scoring because it answers a different question. The score says
// how close a book sits to the profile; the tag says whether we know enough about
// the book to put that number in front of someone. A 7.4 on a review we could not
// tie to a title, or on a book nobody has established is fiction, is not a
// recommendation — it is a number about some prose.
//
// Under web/lib because the browser needs it too: once saves tune the score, the
// tuned number has to be turned into a mark out of ten and tested against the
// threshold by exactly the same rule the build used, or the feed and the build
// would disagree about what counts as a recommendation.

export const RECOMMEND_AT = 7;

export function outOfTen(total) {
  return Math.max(1, Math.round(total) / 10);
}

export function isRecommended({ scored, identity, fiction, inWindow, hasBook, at = RECOMMEND_AT }) {
  if (!hasBook) return { ok: false, because: 'no book was identified in the review' };

  // Identity is a flag now, not a gate. A loosely-extracted title is worth hearing
  // about with a caveat attached; silence was the worse failure.
  // No fiction gate. Known nonfiction now carries a 45-point penalty and cannot
  // reach the threshold on its own; holding back a book merely because nobody has
  // catalogued it yet was suppressing 71 books for a fact about metadata.
  if (inWindow === false) return { ok: false, because: 'published outside the window' };
  // Thin evidence is handled by the 6.9 cap rather than by a gate: a book read on
  // two dimensions simply cannot reach the threshold, so no separate refusal needed.
  if (outOfTen(scored.total) < at) return { ok: false, because: `scores ${outOfTen(scored.total)}, below ${at}` };
  return { ok: true, because: 'scores at or above the threshold on evidence' };
}
