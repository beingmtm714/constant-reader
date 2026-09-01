// Asking this app for a book in your own words.
//
// The point of the feature is that a reader who wants "a contemporary Great
// American Novel" comes here instead of to a search engine or a chatbot. That
// sets the bar: the answer has to come from books this app has actually read
// about, it has to say why each one is here, and where a reader has a profile
// it has to take their taste into account without letting taste smuggle in a
// book that does not answer the question.
//
// Everything runs in the browser against the feed already loaded. No model, no
// API call, no embedding file to ship. Three reasons that is the right trade
// and not a compromise:
//
//   1. This is a static site on GitHub Pages. A query-time API call needs a key
//      in the page, and a key in the page is a key anybody can spend.
//   2. A client-side embedding model is thirty megabytes for a corpus whose
//      whole feed is under seven.
//   3. The app already has a vocabulary for exactly this. The scorer reads
//      eight dimensions off every book and files the result as tags — "generational
//      sweep", "sprawling", "harrowing", "migration & exile". A natural-language
//      query is mostly a request for a handful of those. Matching a query to
//      bands the corpus is already labelled with beats matching it to a vector
//      nobody can inspect, because the result can be explained in the words the
//      rest of the app uses.
//
// What that buys, and what it does not. A query shaped like a kind of book —
// "family saga", "funny novel about work", "short books in translation" — is
// answered well, because those are band requests and the bands exist. A query
// shaped like a vibe — "something that feels like early Denis Johnson" — is
// answered by the nearest-neighbour path if the author is in the corpus, and
// otherwise falls back to plain text matching and will be mediocre. That
// ceiling is a fact about the method and the UI says so rather than hiding it.

import { DIMS, distance, vectorOf, weightsFrom } from './vector.mjs?v=78f5eeab0f';

// ------------------------------------------------------------------ tokens

// Words that carry no signal in a query about books, plus the ones that carry
// signal only as part of the ask itself — "recommend", "looking", "want".
// Stripping the ask is what makes a sentence behave like a query.
const STOP = new Set(`a an and are as at be been but by can do for from get give had has have
he her him his how i if in into is it its me my of on or our out she so some that the their them
then there these they this those to too us was we were what when where which who will with would
you your book books novel read reading recommend recommendation recommendations recommended suggest
suggestions want wanting looking look find me something anything please like about kind sort type
new best good great top favourite favorite really very much more most any all just`.split(/\s+/));

// Deliberately crude. A Porter stemmer would collapse "reporting" and "reportage"
// onto one stem and also collapse "novel" onto "novell"; at this corpus size the
// plural rule is most of the benefit and none of the surprises.
function stem(w) {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && w.endsWith('es') && !/[aeiou]es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

export function tokenize(text, { keepStop = false } = {}) {
  return String(text || '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && (keepStop || !STOP.has(w)))
    .map(stem);
}

// ------------------------------------------------------------- the concepts

// A query names a kind of book; the corpus is labelled with bands. This table is
// the bridge, and it is hand-written on purpose: it is the one place in the app
// where somebody's idea of what "beach read" means is written down, and it
// should be arguable rather than mined.
//
// `tags` are tag labels as tagsFor produces them, so a concept can only ask for
// something the corpus can actually answer. `expand` are extra words fed to the
// text match, for concepts that are partly about subject matter.
const CONCEPTS = [
  // Shapes of book that have a name.
  { phrase: 'great american novel', tags: ['a novel', 'generational sweep', 'sprawling'], expand: ['america', 'american', 'nation'] },
  { phrase: 'family saga', tags: ['generational sweep', 'a novel'], expand: ['family', 'generation'] },
  { phrase: 'multigenerational', tags: ['generational sweep'] },
  { phrase: 'campus novel', tags: ['a novel', 'institutional'], expand: ['campus', 'university', 'college', 'professor'] },
  { phrase: 'coming of age', tags: ['childhood & school'], expand: ['adolescence', 'boyhood', 'girlhood'] },
  { phrase: 'historical fiction', tags: ['historical texture', 'chronicle', 'a novel'] },
  { phrase: 'historical novel', tags: ['historical texture', 'chronicle', 'a novel'] },
  { phrase: 'set in the past', tags: ['historical texture', 'chronicle'] },
  // "Contemporary" is two requests at once: a book set now, and a book published
  // recently. Only the first is a band. Reading it as the band alone put Jane
  // Eyre in the answer to "a contemporary Great American Novel", which is the
  // kind of result that makes somebody go back to a search engine.
  { phrase: 'contemporary', tags: ['sealed in the present', 'internet life'], recent: true },
  { phrase: 'present day', tags: ['sealed in the present'], recent: true },
  { phrase: 'modern life', tags: ['sealed in the present', 'internet life'], recent: true },
  { phrase: 'right now', tags: ['sealed in the present'], recent: true },
  { phrase: 'alternate history', tags: ['invented archive'] },
  { phrase: 'dystopia', tags: ['invented archive', 'SF, fantasy & horror'], expand: ['dystopian', 'authoritarian'] },
  { phrase: 'speculative', tags: ['invented archive', 'SF, fantasy & horror'] },
  { phrase: 'science fiction', tags: ['SF, fantasy & horror'] },
  { phrase: 'sci fi', tags: ['SF, fantasy & horror'] },
  { phrase: 'fantasy', tags: ['SF, fantasy & horror'] },
  { phrase: 'horror', tags: ['SF, fantasy & horror', 'gothic', 'dread'] },
  { phrase: 'thriller', tags: ['Mystery & thriller', 'propulsive', 'plot-driven'] },
  { phrase: 'mystery', tags: ['Mystery & thriller', 'crime & the law'] },
  { phrase: 'detective', tags: ['hardboiled', 'Mystery & thriller', 'crime & the law'] },
  { phrase: 'noir', tags: ['hardboiled', 'cold'] },
  { phrase: 'true crime', tags: ['crime & the law', 'reportage'] },
  { phrase: 'gothic', tags: ['gothic'] },
  { phrase: 'romance', tags: ['Romance', 'warm'] },
  { phrase: 'love story', tags: ['Romance', 'domestic', 'warm'] },

  // Form.
  { phrase: 'short stories', tags: ['stories'] },
  { phrase: 'story collection', tags: ['stories'] },
  { phrase: 'essay collection', tags: ['essays'] },
  { phrase: 'essays', tags: ['essays'] },
  { phrase: 'memoir', tags: ['memoir', 'confessional'] },
  { phrase: 'biography', tags: ['a life, told', 'history'] },
  { phrase: 'history', tags: ['history', 'chronicle'] },
  { phrase: 'reportage', tags: ['reportage', 'reported'] },
  { phrase: 'journalism', tags: ['reportage', 'reported'] },
  { phrase: 'poetry', tags: ['poetry', 'Poetry'] },
  { phrase: 'poems', tags: ['poetry', 'Poetry'] },
  { phrase: 'graphic novel', tags: ['graphic work', 'Comics'] },
  { phrase: 'comics', tags: ['graphic work', 'Comics'] },

  // Prose and voice.
  { phrase: 'beautifully written', tags: ['lyric prose', 'baroque prose'] },
  { phrase: 'lyrical', tags: ['lyric prose'] },
  { phrase: 'gorgeous prose', tags: ['lyric prose', 'baroque prose'] },
  { phrase: 'spare', tags: ['spare prose'] },
  { phrase: 'minimalist', tags: ['spare prose'] },
  { phrase: 'stripped down', tags: ['spare prose'] },
  { phrase: 'maximalist', tags: ['baroque prose', 'sprawling'] },
  { phrase: 'experimental', tags: ['formal constraint', 'polyphonic', 'braided'] },
  { phrase: 'avant garde', tags: ['formal constraint', 'polyphonic'] },
  { phrase: 'formally inventive', tags: ['formal constraint', 'braided'] },
  { phrase: 'unreliable narrator', tags: ['unreliable narrator'] },
  { phrase: 'multiple narrators', tags: ['many voices', 'polyphonic'] },
  { phrase: 'many voices', tags: ['many voices', 'polyphonic'] },
  { phrase: 'ensemble', tags: ['ensemble cast'] },
  { phrase: 'character study', tags: ['interior'] },
  { phrase: 'quiet', tags: ['interior', 'spare prose'] },
  { phrase: 'plot driven', tags: ['plot-driven', 'propulsive'] },

  // Tone.
  { phrase: 'funny', tags: ['comic', 'comic prose'] },
  { phrase: 'comic', tags: ['comic', 'comic prose'] },
  { phrase: 'hilarious', tags: ['comic', 'comic prose'] },
  { phrase: 'satire', tags: ['comic', 'ironic'] },
  { phrase: 'sad', tags: ['elegiac', 'harrowing', 'grave'] },
  { phrase: 'devastating', tags: ['harrowing', 'grave'] },
  { phrase: 'heartbreaking', tags: ['harrowing', 'elegiac'] },
  { phrase: 'bleak', tags: ['grave', 'cold', 'dread'] },
  { phrase: 'grief', tags: ['elegiac'], expand: ['grief', 'mourning', 'loss'] },
  { phrase: 'unsettling', tags: ['dread', 'surreal'] },
  { phrase: 'creepy', tags: ['dread', 'gothic'] },
  { phrase: 'weird', tags: ['surreal'] },
  { phrase: 'surreal', tags: ['surreal'] },
  { phrase: 'angry', tags: ['indicting'] },
  { phrase: 'polemic', tags: ['indicting'] },
  { phrase: 'uplifting', tags: ['warm'] },
  { phrase: 'comforting', tags: ['warm'] },
  { phrase: 'page turner', tags: ['propulsive', 'plot-driven'] },
  { phrase: 'gripping', tags: ['propulsive'] },
  { phrase: 'beach read', tags: ['propulsive', 'warm', 'comic'] },

  // Subject.
  { phrase: 'climate', tags: ['ecology & climate'] },
  { phrase: 'nature', tags: ['ecology & climate', 'land & labour'] },
  { phrase: 'farming', tags: ['land & labour'] },
  { phrase: 'rural', tags: ['land & labour'] },
  { phrase: 'war', tags: ['state violence'], expand: ['war', 'soldier', 'occupation'] },
  { phrase: 'politics', tags: ['state violence', 'institutional'] },
  { phrase: 'immigration', tags: ['migration & exile'] },
  { phrase: 'immigrant', tags: ['migration & exile'] },
  { phrase: 'exile', tags: ['migration & exile'] },
  { phrase: 'diaspora', tags: ['migration & exile'] },
  { phrase: 'illness', tags: ['illness & care'] },
  { phrase: 'caregiving', tags: ['illness & care'] },
  { phrase: 'disability', tags: ['illness & care'] },
  { phrase: 'money', tags: ['money', 'work & the economy'] },
  { phrase: 'capitalism', tags: ['money', 'work & the economy'] },
  { phrase: 'finance', tags: ['money'] },
  { phrase: 'work', tags: ['work & the economy'] },
  { phrase: 'labor', tags: ['work & the economy', 'land & labour'] },
  { phrase: 'technology', tags: ['technology & power', 'internet life'] },
  { phrase: 'artificial intelligence', tags: ['technology & power'], expand: ['ai', 'algorithm'] },
  { phrase: 'silicon valley', tags: ['technology & power'] },
  { phrase: 'the internet', tags: ['internet life'] },
  { phrase: 'social media', tags: ['internet life'] },
  { phrase: 'religion', tags: ['faith'] },
  { phrase: 'faith', tags: ['faith'] },
  { phrase: 'art', tags: ['art & music', 'art under the state'] },
  { phrase: 'music', tags: ['art & music'] },
  { phrase: 'science', tags: ['science'] },
  { phrase: 'cities', tags: ['cities & housing'] },
  { phrase: 'housing', tags: ['cities & housing'] },
  { phrase: 'school', tags: ['childhood & school'] },
  { phrase: 'sports', tags: ['sport'] },
  { phrase: 'family', tags: ['domestic'], expand: ['family', 'mother', 'father'] },
  { phrase: 'marriage', tags: ['domestic'] },
  { phrase: 'motherhood', tags: ['domestic'], expand: ['mother', 'motherhood'] },
  { phrase: 'crime', tags: ['crime & the law'] },
  { phrase: 'the law', tags: ['crime & the law', 'institutional'] },

  // Press and reception.
  { phrase: 'small press', tags: ['independent press'] },
  { phrase: 'indie press', tags: ['independent press'] },
  { phrase: 'independent publisher', tags: ['independent press'] },
  { phrase: 'university press', tags: ['scholarly press', 'scholarly'] },
  { phrase: 'academic', tags: ['scholarly', 'scholarly press'] },
  { phrase: 'acclaimed', tags: ['widely reviewed', 'critics raving'] },
  { phrase: 'buzzy', tags: ['widely reviewed'] },
  { phrase: 'talked about', tags: ['widely reviewed'] },
  { phrase: 'in translation', tags: ['in translation'] },
  { phrase: 'translated', tags: ['in translation'] },
];

// Longest phrase first, so "great american novel" is claimed before "novel" or
// "american" can be picked off it.
const CONCEPTS_BY_LENGTH = CONCEPTS
  .map((c) => ({ ...c, words: c.phrase.split(' ') }))
  .sort((a, b) => b.words.length - a.words.length);

// ------------------------------------------------------------- the facets

// Things a query can ask for that are not tags: a length, a kind, a date, a
// resemblance. Each is lifted out of the text before the rest is matched, so
// "short novels in translation from the last two years" leaves nothing behind
// that would drag the text match sideways.
const KIND_WORDS = {
  fiction: 'fiction', novel: 'fiction', novels: 'fiction', fiction: 'fiction',
  nonfiction: 'nonfiction', 'non-fiction': 'nonfiction', nonfic: 'nonfiction',
};

const MONTHS = 'january february march april may june july august september october november december';

function detectFacets(raw) {
  let text = ` ${raw.toLowerCase()} `;
  const facets = {};
  const echo = [];
  const eat = (re, fn) => {
    const m = re.exec(text);
    if (!m) return false;
    if (fn(m) === false) return false;
    text = text.replace(re, ' ');
    return true;
  };

  // "like Rachel Cusk", "similar to Trust", "if I liked The Overstory". The name
  // is kept whole rather than tokenized, because the nearest-neighbour path
  // needs to look it up in the corpus by title or author.
  eat(/\b(?:like|similar to|reminds me of|if i (?:liked|loved)|in the vein of|fans of)\s+([a-z0-9'’.\- ]{3,60}?)(?=\s*(?:,|;|\.|$|\bbut\b|\band\b|\bthat\b|\bwith\b))/i, (m) => {
    facets.similarTo = m[1].trim();
    echo.push(`like ${facets.similarTo}`);
  });

  eat(/\bunder\s+(\d{2,4})\s*(?:pages|pp\.?|page)\b/, (m) => {
    facets.maxPages = Number(m[1]);
    echo.push(`under ${facets.maxPages} pages`);
  });
  eat(/\b(?:short|slim|brief|quick read|novella)\b/, () => {
    if (facets.maxPages) return false;
    facets.maxPages = 300;
    echo.push('short');
  });
  eat(/\b(?:long|epic|doorstopper|sprawling|big)\b/, () => {
    if (facets.maxPages) return false;
    facets.minPages = 450;
    echo.push('long');
  });

  eat(/\b(?:in|from)?\s*(?:the\s+)?(?:last|past)\s+(\d{1,2}|a|two|three|five|ten)\s+years?\b/, (m) => {
    const words = { a: 1, two: 2, three: 3, five: 5, ten: 10 };
    facets.sinceYear = new Date().getFullYear() - (words[m[1]] ?? Number(m[1]) ?? 1);
    echo.push(`since ${facets.sinceYear}`);
  });
  eat(/\b(?:this year|out now|just out|newly published|brand new|recent|recently)\b/, () => {
    if (facets.sinceYear) return false;
    facets.sinceYear = new Date().getFullYear() - 1;
    echo.push('recent');
  });
  eat(/\b(?:from|in|since)\s+((?:19|20)\d{2})\b/, (m) => {
    facets.sinceYear = Number(m[1]);
    echo.push(`since ${facets.sinceYear}`);
  });
  // A bare year, but never one that is part of a month-and-year date.
  eat(new RegExp(`(?<!(?:${MONTHS})\\s)\\b((?:19|20)\\d{2})\\b`), (m) => {
    facets.year = Number(m[1]);
    echo.push(String(facets.year));
  });

  eat(/\b(?:in translation|translated(?: from [a-z]+)?)\b/, () => {
    facets.translated = true;
    echo.push('in translation');
  });
  eat(/\b(?:debut|first novel|first book)\b/, () => {
    facets.debut = true;
    echo.push('debut');
  });

  // The kind word sets the facet and is then eaten, because as a search term it
  // is worse than useless: "nonfiction about artificial intelligence" was
  // matching the literal string "nonfiction" in review copy and ranking a book
  // on landscape architecture above Jill Lepore. "novel" is left in, because it
  // is also the signal behind the "a novel" form tag.
  for (const [word, kind] of Object.entries(KIND_WORDS)) {
    if (!new RegExp(`\\b${word}\\b`).test(text)) continue;
    facets.kind = kind;
    echo.push(kind === 'fiction' ? 'fiction' : 'nonfiction');
    if (!/novel/.test(word)) text = text.replace(new RegExp(`\\b${word}\\b`, 'g'), ' ');
    break;
  }

  return { facets, echo, rest: text.trim() };
}

// ------------------------------------------------------------------ parse

export function parse(query) {
  const raw = String(query || '').trim();
  if (!raw) return { raw, empty: true, terms: [], tags: [], facets: {}, echo: [], concepts: [] };

  const { facets, echo, rest } = detectFacets(raw);

  // Concepts are matched over the surviving words with stopwords kept, because
  // "in translation" and "the internet" are phrases whose middles are stopwords.
  const words = tokenize(rest, { keepStop: true });
  const claimed = new Array(words.length).fill(false);
  const tags = new Map();
  const concepts = [];
  const expand = [];

  for (const c of CONCEPTS_BY_LENGTH) {
    const target = c.words.map(stem);
    for (let i = 0; i + target.length <= words.length; i++) {
      if (claimed.slice(i, i + target.length).some(Boolean)) continue;
      if (!target.every((t, k) => words[i + k] === t)) continue;
      for (let k = 0; k < target.length; k++) claimed[i + k] = true;
      concepts.push(c.phrase);
      // A phrase of several words is a stronger request than a single word that
      // happens to be in the table, so it gets more of the intent budget.
      const strength = Math.min(1, 0.55 + 0.25 * target.length);
      for (const t of c.tags) tags.set(t, Math.max(tags.get(t) || 0, strength));
      expand.push(...(c.expand || []));
      if (c.recent) facets.preferRecent = true;
      break;
    }
  }

  // Everything the concepts did not claim becomes the text query, along with the
  // words the concepts asked to add.
  const leftover = words.filter((w, i) => !claimed[i] && !STOP.has(w));
  const terms = [...new Set([...leftover, ...expand.map(stem)])];

  return {
    raw,
    empty: false,
    terms,
    // The unexpanded half, kept apart so the UI can say which words it looked for
    // rather than reciting an expansion the reader never typed.
    typed: leftover,
    tags: [...tags].map(([label, weight]) => ({ label, weight })),
    concepts,
    facets,
    echo,
  };
}

// ------------------------------------------------------------------ index

// BM25 over one document per book, built once from the feed already in memory.
// The corpus is under a thousand books and a couple of megabytes of text, so
// this is a loop rather than a data structure problem, and it adds nothing to
// what the page downloads.
const K1 = 1.4;
const B = 0.72;

export function buildIndex(books, { text = defaultText } = {}) {
  const docs = [];
  const df = new Map();
  let total = 0;

  for (const e of books) {
    const fields = text(e);
    const tf = new Map();
    // Title and author are weighted by repetition rather than by a separate
    // field score: a reader typing a title wants that book first, and three
    // copies of the title in the bag does that with no second formula.
    const bag = [
      ...tokenize(fields.title), ...tokenize(fields.title), ...tokenize(fields.title),
      ...tokenize(fields.author), ...tokenize(fields.author),
      ...tokenize(fields.tags), ...tokenize(fields.tags),
      ...tokenize(fields.body),
    ];
    for (const w of bag) tf.set(w, (tf.get(w) || 0) + 1);
    for (const w of tf.keys()) df.set(w, (df.get(w) || 0) + 1);
    docs.push({ id: e.id, tf, len: bag.length });
    total += bag.length;
  }

  return { docs, df, N: docs.length, avgdl: total / Math.max(1, docs.length), byId: new Map(docs.map((d) => [d.id, d])) };
}

function defaultText(e) {
  return {
    title: [e.book?.title, e.book?.subtitle].filter(Boolean).join(' '),
    author: e.book?.author || '',
    tags: (e.tags || []).map((t) => t.label).join(' '),
    body: [
      e.book?.description,
      e.book?.publisher,
      (e.book?.subjects || []).join(' '),
      ...(e.mentions || []).flatMap((m) => [m.reviewTitle, m.standfirst, m.byline]),
    ].filter(Boolean).join(' '),
  };
}

function bm25(index, doc, terms) {
  let s = 0;
  const hits = [];
  for (const t of terms) {
    const f = doc.tf.get(t);
    if (!f) continue;
    const n = index.df.get(t) || 0;
    const idf = Math.log(1 + (index.N - n + 0.5) / (n + 0.5));
    s += idf * (f * (K1 + 1)) / (f + K1 * (1 - B + B * doc.len / index.avgdl));
    hits.push(t);
  }
  return { score: s, hits };
}

// ------------------------------------------------------------------ search

const clamp01 = (x) => Math.max(0, Math.min(1, x));

export function search(query, books, opts = {}) {
  const {
    index,
    // (entry) -> number out of ten, or null when the reader has no profile.
    fitOf = () => null,
    dimensions = [],
    limit = 40,
    // Relevance below this is not an answer to the question, whatever the fit.
    floor = 0.08,
  } = opts;

  const q = parse(query);
  if (q.empty) return { query: q, results: [], total: 0 };

  const idx = index || buildIndex(books);

  // "Like X" resolves to a book in the corpus and then to its dimension vector,
  // which is the same arithmetic the Taste page uses to say what a save resembles.
  let reference = null;
  if (q.facets.similarTo) {
    reference = findReference(q.facets.similarTo, books);
  }
  // A reference book is only compared on the dimensions it actually fired. A
  // defaulted dimension is the absence of evidence, and averaging it in made
  // "like Rachel Cusk" answer with a monograph on the death penalty: the two
  // books agreed on four dimensions neither of them had any evidence for.
  const weights = weightsFrom(dimensions);
  const refVector = reference ? vectorOf(reference.score) : null;
  const refWeights = reference
    ? weights.map((w, i) => (reference.score?.dimensions?.[DIMS[i]]?.defaulted ? 0 : w))
    : weights;
  const refKind = reference ? kindOf(reference) : null;

  // The text half is normalised against the best document rather than against an
  // absolute, because BM25 totals depend on how many words the query has.
  const lexical = [];
  let bestLex = 0;
  for (const e of books) {
    const doc = idx.byId.get(e.id);
    const r = doc && q.terms.length ? bm25(idx, doc, q.terms) : { score: 0, hits: [] };
    if (r.score > bestLex) bestLex = r.score;
    lexical.push(r);
  }

  const wantedTags = new Map(q.tags.map((t) => [t.label, t.weight]));
  const tagBudget = [...wantedTags.values()].reduce((s, w) => s + w, 0);

  const rows = [];
  for (let i = 0; i < books.length; i++) {
    const e = books[i];
    const lex = bestLex ? lexical[i].score / bestLex : 0;

    // Which of the asked-for bands this book actually carries.
    const matchedTags = [];
    let tagScore = 0;
    for (const t of e.tags || []) {
      const w = wantedTags.get(t.label);
      if (w == null) continue;
      matchedTags.push(t.label);
      tagScore += w;
    }
    const intent = tagBudget ? tagScore / tagBudget : 0;

    // Kinds do not resemble each other however the arithmetic falls out. Asking
    // for something like a novelist and being handed a monograph is not a near
    // miss, it is a wrong answer.
    const near = refVector && e.score?.dimensions && kindOf(e) === refKind
      ? 1 - distance(vectorOf(e.score), refVector, refWeights)
      : 0;

    // Facets are requirements, not preferences: a reader who asked for books
    // under 300 pages does not want a 700-page book at the top because it
    // matched three tags. A book with no page count is not excluded — an unknown
    // is not a failure — but it does not get the credit either.
    const { ok, satisfied, wanted, missing } = facetFit(e, q.facets);
    if (!ok) continue;

    // Three ways a query can carry a request, and a query is allowed to use only
    // one of them. "Short novels in translation" names no tag and no term, and
    // before this it scraped past the floor on a rounding error.
    const asks = (q.terms.length ? 1 : 0) + (tagBudget ? 1 : 0) + (wanted ? 1 : 0);
    const facetFrac = wanted ? satisfied / wanted : 0;
    let relevance = asks
      ? ((q.terms.length ? lex : 0) + (tagBudget ? intent : 0) + (wanted ? facetFrac : 0)) / asks
      : 0;

    // Evidence from two independent directions is worth more than the same total
    // from one. Without this, a book carrying the right band but not one of the
    // reader's words outranked a book carrying both.
    if (q.terms.length && tagBudget && lex > 0 && intent > 0) relevance += 0.15 * Math.min(lex, intent);

    if (refVector) relevance = reference.id === e.id ? 1 : 0.3 * relevance + 0.7 * Math.max(0, near - 0.5) * 2;

    // "Contemporary" asks for a book published in this decade as well as one set
    // now. A preference, not a filter, because the publication year is missing or
    // wrong often enough that excluding on it would throw away real answers.
    if (q.facets.preferRecent) {
      const year = e.book?.bookYear;
      if (year != null) relevance *= year >= new Date().getFullYear() - 6 ? 1 : year >= 2010 ? 0.75 : 0.35;
    }

    relevance = clamp01(relevance);
    if (relevance < floor) continue;

    // Taste re-ranks within relevance and can never create it. Multiplying keeps
    // that true by construction: a book the query did not ask for scores zero
    // however well it fits, and the best a profile can do is move a genuine
    // answer up or down by a third.
    const fit = fitOf(e);
    const total = fit == null ? relevance : relevance * (0.7 + 0.3 * clamp01(fit / 10));

    rows.push({
      e,
      relevance,
      fit,
      total,
      why: reason({ matchedTags, hits: lexical[i].hits, typed: q.typed, echo: q.echo, missing, reference, near }),
      matchedTags,
    });
  }

  rows.sort((a, b) => b.total - a.total || (b.fit ?? 0) - (a.fit ?? 0));
  return { query: q, reference, results: rows.slice(0, limit), total: rows.length };
}

// Which book "like X" meant. Title first and whole, because a reader naming a
// book means that book; then author, where the best-reviewed one stands for the
// name. Nothing fuzzy: a wrong guess here silently reranks the entire answer.
function findReference(name, books) {
  const want = tokenize(name).join(' ');
  if (!want) return null;
  const byTitle = books.find((e) => tokenize(e.book?.title).join(' ') === want && e.score?.dimensions);
  if (byTitle) return byTitle;
  const byAuthor = books
    .filter((e) => tokenize(e.book?.author).join(' ').includes(want) && e.score?.dimensions)
    .sort((a, b) => (b.score?.total || 0) - (a.score?.total || 0))[0];
  return byAuthor || null;
}

const kindOf = (e) => (e.fiction === 'confirmed' || e.fiction === 'likely' ? 'fiction'
  : e.fiction === 'nonfiction' ? 'nonfiction' : 'unknown');

// `wanted` counts the requirements the query made; `satisfied` counts the ones
// this book is on record as meeting. A book that is merely not disqualified —
// no page count, no catalogued year — passes but scores nothing, which is what
// keeps an unknown from reading as a match.
function facetFit(e, f) {
  const missing = [];
  let satisfied = 0, wanted = 0;
  const pages = e.book?.pages ?? null;

  if (f.maxPages != null) {
    wanted++;
    if (pages != null && pages > f.maxPages) return { ok: false };
    if (pages != null) satisfied++; else missing.push('page count unknown');
  }
  if (f.minPages != null) {
    wanted++;
    if (pages != null && pages < f.minPages) return { ok: false };
    if (pages != null) satisfied++; else missing.push('page count unknown');
  }
  if (f.translated) {
    wanted++;
    if (e.book?.translated === false) return { ok: false };
    if (e.book?.translated) satisfied++; else missing.push('translation unconfirmed');
  }
  if (f.kind) {
    wanted++;
    const k = kindOf(e);
    if (k !== 'unknown' && k !== f.kind) return { ok: false };
    if (k === f.kind) satisfied++; else missing.push(`${f.kind} unconfirmed`);
  }
  if (f.debut) {
    wanted++;
    const hay = `${e.book?.description || ''} ${(e.mentions || []).map((m) => m.standfirst).join(' ')}`.toLowerCase();
    if (/\b(debut|first novel|first book)\b/.test(hay)) satisfied++;
  }

  const year = e.book?.bookYear ?? null;
  if (f.year != null) {
    wanted++;
    if (year != null && year !== f.year) return { ok: false };
    if (year != null) satisfied++; else missing.push('year unknown');
  }
  if (f.sinceYear != null) {
    wanted++;
    if (year != null && year < f.sinceYear) return { ok: false };
    if (year != null) satisfied++; else missing.push('year unknown');
  }
  return { ok: true, satisfied, wanted, missing };
}

// The row's own account of why it is here, in the app's register: name the
// evidence, never assert a feeling. "Matched" is a claim about the record.
// The row's own account of why it is here, in the app's register: name the
// evidence, never assert a feeling.
//
// It does not repeat the bands. Those are already on the row as tags, and
// printing them again a line above — a bare list, unlabelled, next to a
// different list of the book's other tags — read as two sets contradicting each
// other. The tags that matched are marked in the tag row instead, in the one
// place the reader is already looking, and this line carries only what a tag
// cannot show.
function reason({ matchedTags, hits, typed, echo, missing, reference, near }) {
  const parts = [];
  if (reference) {
    parts.push(`${Math.round(near * 100)}% of the way to ${reference.book?.title || 'the book you named'} across the eight dimensions`);
  }
  // A word the reader typed and a word the app added on their behalf are
  // different claims, and the row says which is which. Presenting an expansion
  // as something they asked for is how a search engine loses trust.
  const typedHits = hits.filter((h) => typed.includes(h));
  const addedHits = hits.filter((h) => !typed.includes(h));
  if (typedHits.length) parts.push(`“${typedHits.slice(0, 4).join('”, “')}” in the text`);
  if (addedHits.length) parts.push(`also read for “${addedHits.slice(0, 3).join('”, “')}”`);
  for (const e of echo) parts.push(e);
  for (const m of missing) parts.push(m);
  if (parts.length) return `Matched ${parts.join(' · ')}`;
  if (matchedTags.length) {
    return `Matched on ${matchedTags.length === 1 ? 'the tag marked below' : 'the tags marked below'}`;
  }
  return 'Matched on the review text';
}

// What the search box offers before anybody has typed. Written as questions a
// reader would actually ask, not as a feature list, and every one of them
// exercises a different path through the parser.
export const EXAMPLES = [
  'a contemporary Great American Novel',
  'short novels in translation',
  'funny books about work',
  'devastating memoir about illness',
  'experimental fiction with many voices',
  'history of money and empire',
];
