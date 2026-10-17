// Text matching for the taste scorer.
//
// Two things make this more than an indexOf: reviews negate ("no land title, no
// union, nothing institutional"), and they quote other books. Counting a negated
// term as a hit is the fastest way to score a domestic novel as a land novel.

const NEGATORS = /\b(no|not|nor|without|never|nothing|neither|hardly|barely|lacks?|lacking|isn'?t|aren'?t|wasn'?t|rather than|instead of|far from|fails? to|refuses? to)\b/i;

const WORD = /[a-z0-9]/i;

export function normalize(s) {
  return String(s || '')
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, ' - ')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

// True when `term` at position `i` is preceded by a negator close enough to be
// governing it, and no sentence boundary intervenes.
function isNegated(hay, i) {
  const start = Math.max(0, i - 60);
  let window = hay.slice(start, i);
  const stop = Math.max(window.lastIndexOf('. '), window.lastIndexOf('; '));
  if (stop !== -1) window = window.slice(stop + 1);
  return NEGATORS.test(window);
}

// Whole-word-ish containment: the character on each side of the match must not
// continue the word. Phrases with spaces are matched as-is.
export function findTerm(hay, term) {
  const t = term.toLowerCase();
  const out = [];
  let i = hay.indexOf(t);
  while (i !== -1) {
    const before = i > 0 ? hay[i - 1] : ' ';
    const after = i + t.length < hay.length ? hay[i + t.length] : ' ';
    const headOk = !WORD.test(before) || !WORD.test(t[0]);
    const tailOk = !WORD.test(after) || !WORD.test(t[t.length - 1]);
    if (headOk && tailOk) out.push(i);
    i = hay.indexOf(t, i + 1);
  }
  return out;
}

// Match a list of terms against the haystack. Returns distinct terms that hit
// at least once un-negated, plus the terms that hit only under negation.
export function matchTerms(hay, terms) {
  const hits = [];
  const negated = [];
  for (const term of terms || []) {
    const positions = findTerm(hay, term);
    if (!positions.length) continue;
    // A term that opens with a negator carries its own negation - "no protagonist"
    // is the signal, not the absence of one. Checking the text in front of it would
    // let a neighbouring "no" cancel it.
    const selfNegating = NEGATORS.test(term.split(/\s+/)[0] || '');
    if (selfNegating || positions.some((p) => !isNegated(hay, p))) hits.push(term);
    else negated.push(term);
  }
  return { hits, negated, count: hits.length };
}

// Years a review names, restricted to plausible setting years. "1920s" yields
// 1920. Anything within the last 15 years is treated as present, not period.
export function findYears(hay, now = new Date().getFullYear()) {
  const years = new Set();
  for (const m of hay.matchAll(/\b(1[6-9]\d{2}|20[0-2]\d)s?\b/g)) {
    const y = Number(m[1]);
    if (y >= 1600 && y <= now) years.add(y);
  }
  return [...years].sort((a, b) => a - b);
}

export function decadeWords(hay) {
  const out = [];
  const map = {
    'nineteen-twenties': 1920, 'nineteen-thirties': 1930, 'nineteen-forties': 1940,
    'nineteen-fifties': 1950, 'nineteen-sixties': 1960, 'nineteen-seventies': 1970,
    'the twenties': 1920, 'the thirties': 1930, 'the forties': 1940,
    'the fifties': 1950, 'the sixties': 1960, 'the seventies': 1970, 'the eighties': 1980,
  };
  for (const [k, v] of Object.entries(map)) if (findTerm(hay, k).length) out.push(v);
  return out;
}

export function stripHtml(s) {
  // Feeds double-encode: the Guardian ships &lt;p&gt; inside a CDATA block, so a
  // single strip-then-decode leaves the tags behind as literal text.
  let out = String(s || '');
  for (let pass = 0; pass < 2; pass++) {
    out = out
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ');
    out = decodeEntities(out);
  }
  return out.replace(/\s+/g, ' ').trim();
}

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/g, ' ')
    .replace(/&#8217;|&#039;|&#39;|&rsquo;|&lsquo;|&apos;/g, "'")
    .replace(/&#8220;|&#8221;|&ldquo;|&rdquo;|&quot;/g, '"')
    .replace(/&#8212;|&mdash;|&#8211;|&ndash;/g, ' - ')
    .replace(/&hellip;|&#8230;/g, '...')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;|&#38;/g, '&')
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(Number(n)); } catch { return ' '; } })
    .replace(/&[a-z]+;/gi, ' ');
}
