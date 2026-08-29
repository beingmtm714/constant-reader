// A drawn jacket for a book with no cover image.
//
// Open Library has a cover for 46 of 692 books and Google Books fills a good deal
// more, but never all of them: a book reviewed the week it was published often has
// no jacket anywhere yet, which is exactly the book this feed is full of. So the
// fallback is not an apology for a missing image, it is the majority face of the
// screen and has to be designed as one.
//
// It is typographic, which is period-correct rather than a concession. Jackets in
// the twenties and thirties were largely set, not illustrated: a title in a Didone,
// a rule, the author in caps, and a ground colour. That is a jacket this app can
// draw honestly from what it already knows, and it never looks like a broken image.
//
// Deterministic: the same book gets the same jacket on every device and every
// build, because a shelf that reshuffles its colours on reload reads as a bug.
// Pure — id and title in, description out. The DOM is built by app.js.

// FNV-1a. Small, stable, and no dependency; the only requirement is that the same
// string gives the same number everywhere, which Math.random and Date cannot.
export function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < String(str).length; i++) {
    h ^= String(str).charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// Five grounds, all built from tokens that already exist, so both themes follow
// without a second table. Brass is absent on purpose: DESIGN.md gives it to the
// masthead rule and forbids it on type at any size, and a jacket is mostly type.
//
// The accent grounds are the loudest thing on the screen, so they are outnumbered
// four to one rather than given equal weight: a shelf where every second jacket is
// lacquer red stops reading as a shelf and starts reading as a warning.
export const GROUNDS = [
  { id: 'paper', bg: 'var(--surface)', ink: 'var(--ink)', rule: 'var(--ink)' },
  { id: 'reverse', bg: 'var(--ink)', ink: 'var(--bg)', rule: 'var(--bg)' },
  { id: 'board', bg: 'var(--surface-2)', ink: 'var(--ink)', rule: 'var(--ink)' },
  { id: 'quiet', bg: 'var(--bg)', ink: 'var(--ink)', rule: 'var(--rule-strong)' },
  { id: 'lacquer', bg: 'var(--accent)', ink: 'var(--bg)', rule: 'var(--bg)' },
];

// Where the doubled rule sits. The thick-thin pair is the period's device and
// DESIGN.md reserves it for the masthead; a jacket is the one other place it
// earns its keep, because that is what it was for on a real jacket of the period.
export const RULES = ['above', 'below', 'both'];

// A long title set large enough to fill a jacket stops being readable, so the size
// steps down as the title grows rather than the title being cut. Nothing is
// truncated: a jacket whose title ends in an ellipsis is worse than a small title.
export function titleSize(title) {
  const n = String(title || '').length;
  if (n <= 14) return 'xl';
  if (n <= 28) return 'lg';
  if (n <= 52) return 'md';
  return 'sm';
}

export function jacketFor(book) {
  const id = book?.id || book?.title || '';
  const h = hash(id);
  return {
    ground: GROUNDS[h % GROUNDS.length],
    rule: RULES[(h >> 8) % RULES.length],
    size: titleSize(book?.title),
    title: book?.title || 'Untitled',
    author: book?.author || '',
  };
}
