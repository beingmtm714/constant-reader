// The landing view: a few shelves instead of six hundred rows.
//
// The feed is a list you read down, and it stays that way — this sits in front of
// it. A reader arriving at 692 books ordered by date has no way in; a reader
// arriving at six shelves named after things they like has six.
//
// The shelves are built from the reader's own profile rather than from a fixed
// list, so they say something about this reader and not about books in general.
// Pure — books and profile in, shelves out. No DOM, no storage, no network.

// Bookkeeping tags, which describe what we know about a book rather than the book.
// DESIGN.md already keeps these off the row for the same reason; a shelf called
// "thin evidence" is a shelf of our own doubts.
const BOOKKEEPING = new Set(['caveat', 'attention', 'question', 'rule', 'press']);

// Imprint is 320 distinct values across the whole archive, so nearly every shelf
// it built there would hold one book, and it describes the publisher rather than a
// taste. It earns its place in exactly one pool: the books ahead of the reviews.
// Those have no review prose to tag from, so the profile's vocabulary barely
// touches them — but every one has a publisher, and they are overwhelmingly
// Oxford, Cambridge, Verso, MIT and California. For new scholarly books the press
// is how you browse, and 35 Oxford titles is a real shelf.
const NOT_A_TASTE = new Set(['imprint', 'genre']);

// A shelf nobody would scroll. Two books is a pair, not a collection, and the
// horizontal scroller looks broken holding one card.
const MIN_BOOKS = 4;
const MAX_PER_SHELF = 24;

const tagsOf = (entry) => entry?.tags || [];

// The dimensions the reader weights most heavily, highest first. This is what makes
// the landing page theirs: a reader who has pushed prose to the top gets prose
// shelves, and one who cares about period gets period shelves, from the same feed.
export function rankedKinds(profile, { only } = {}) {
  const weights = profile?.weights || {};
  const kinds = { D1: 'period', D2: 'subject', D3: 'form', D4: 'prose', D5: 'tone', D6: 'scale' };
  const ranked = Object.entries(kinds)
    .map(([dim, kind]) => ({ kind, weight: Number(weights[dim] ?? 1) }))
    .sort((a, b) => b.weight - a.weight)
    .map((x) => x.kind)
    .filter((kind) => !BOOKKEEPING.has(kind) && !NOT_A_TASTE.has(kind));
  return only === 'unscored' ? ['imprint', ...ranked] : ranked;
}

// Whether the profile has an opinion about this book at all. A catalogue or
// interview entry with no review behind it cannot be scored, and a shelf built
// from the reader's own weights has nothing to say about it.
export const scored = (e) => !e.listedOnly
  && e.score?.band !== 'unscored' && e.score?.band !== 'unresolved';

function pick(entries) {
  return entries.slice(0, MAX_PER_SHELF);
}

const byScore = (a, b) => (b.score?.total ?? -1) - (a.score?.total ?? -1);

// What each dimension is, in a reader's words. The band label itself is left
// exactly as the profile writes it — DESIGN.md is explicit that renaming a band is
// a product decision, not a design one — but "period-set" alone is a cryptic thing
// to head a shelf with, so the dimension it came from goes underneath rather than
// the word being changed.
const KIND_NOTE = {
  imprint: 'Everything here from one press.',
  period: 'When the book is set — one of the things your profile weights.',
  subject: 'What the book is about.',
  form: 'How the book is built.',
  prose: 'How the book is written.',
  tone: 'How the book reads.',
  scale: 'How big a book it is.',
};

// Sentence case for the head, because a shelf title is a heading and the profile
// writes its labels in running-text lower case. The word itself is untouched.
const headline = (label) => String(label).charAt(0).toUpperCase() + String(label).slice(1);

// One shelf per band, for the highest-weighted dimensions the reader holds.
function tagShelves(books, kinds) {
  const out = [];
  for (const kind of kinds) {
    const groups = new Map();
    for (const entry of books) {
      for (const tag of tagsOf(entry)) {
        if (tag.kind !== kind) continue;
        if (!groups.has(tag.label)) groups.set(tag.label, []);
        groups.get(tag.label).push(entry);
      }
    }
    for (const [label, entries] of groups) {
      // A press needs more than the four books a taste band does before it is
      // worth a heading of its own; there is a long tail of one-book imprints.
      if (entries.length < (kind === 'imprint' ? 8 : MIN_BOOKS)) continue;
      out.push({
        id: `${kind}:${label}`,
        kind,
        title: headline(label),
        note: KIND_NOTE[kind] || '',
        books: pick([...entries].sort(byScore)),
        total: entries.length,
      });
    }
  }
  return out;
}

// The two shelves that are not about a tag: what the profile recommends, and what
// arrived since yesterday. Both answer a question a reader actually arrives with.
function standingShelves(books, { only }) {
  const out = [];
  const recommended = books.filter((e) => e.recommended).sort(byScore);
  if (recommended.length >= MIN_BOOKS) {
    out.push({
      id: 'recommended', kind: 'standing', title: 'Recommended for you',
      note: 'Scores above the threshold in your profile.',
      books: recommended.slice(0, MAX_PER_SHELF), total: recommended.length,
    });
  }

  const dated = books
    .filter((e) => e.lastReviewed)
    .sort((a, b) => Date.parse(b.lastReviewed) - Date.parse(a.lastReviewed));
  if (dated.length >= MIN_BOOKS) {
    // In a pool with no reviews in it, "Reviewed this week" is a false heading:
    // the date on these is when the publisher announced the book or the author sat
    // down to talk about it, which is a different fact with the same shape.
    const reviewed = only !== 'unscored';
    out.push({
      id: 'latest', kind: 'standing',
      title: reviewed ? 'Reviewed this week' : 'Just arrived',
      note: reviewed
        ? 'The most recent reviews the crawl found.'
        : 'The most recently announced or discussed, ahead of any review.',
      books: dated.slice(0, MAX_PER_SHELF), total: dated.length,
    });
  }
  return out;
}

// Shelves are capped because this is a landing page, not a second feed: a reader
// who wants all 692 books has the feed one tap away, and twenty shelves of eight
// books is the same wall of text with more scrolling.
// `only` decides which archive the shelves are built from. Collections is the
// reader's own: every book on it is one the profile has an opinion about, because
// a shelf named after a taste is a claim, and a book nobody has reviewed cannot
// support it. All books builds the same shelves over everything, which is how a
// reader browses past their own profile rather than only inside it.
export function buildShelves(books, profile, { limit = 7, only = 'scored' } = {}) {
  const all = (books || []).filter((e) => (only === 'scored' ? scored(e) : true));
  if (!all.length) return [];

  const standing = standingShelves(all, { only });
  const tagged = tagShelves(all, rankedKinds(profile, { only }));

  // Best-scoring shelves first within each kind, so the strongest one for a
  // dimension leads and the long tail of four-book bands does not.
  const ranked = tagged.sort((a, b) => b.total - a.total);

  // One shelf per dimension, and no more. Filling the spare slots with whatever
  // ranked highest gave "Short", "Mid-length" and "Long" three of seven shelves —
  // page-count buckets, which are a measurement of a book rather than a reason to
  // pick one up. A reader browsing wants six different questions asked, not the
  // same question asked three times.
  const seen = new Set();
  const spread = [];
  for (const shelf of ranked) {
    if (seen.has(shelf.kind)) continue;
    seen.add(shelf.kind);
    spread.push(shelf);
  }

  // Books ahead of the reviews have almost no tags — there is no review prose to
  // read them out of — so one shelf per kind leaves the screen half empty. The
  // press is the exception that fills it, and several presses is a better browse
  // than one, so the spare slots go to them rather than staying blank.
  if (only === 'unscored') {
    for (const shelf of ranked) {
      if (spread.length >= limit - standing.length) break;
      if (shelf.kind === 'imprint' && !spread.includes(shelf)) spread.push(shelf);
    }
  }

  return [...standing, ...spread].slice(0, limit);
}
