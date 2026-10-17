// Scores a candidate against the reading taste profile (rev 2).
//
// Every weight, band and threshold comes from profile/taste-profile.json and every
// term from profile/lexicons.json. The logic here is only the mapping: which band
// a set of matched terms earns, and the three non-linear rules the profile states
// explicitly — the D4 prose floor, the Trap 4 land-scale demotion, and the hard
// filters.
//
// A dimension needs two distinct terms to earn its top bands (9 and 10) and one to
// earn the rest. The engine is what a review keeps returning to, not what it
// mentions once.

import { normalize, matchTerms, findYears, decadeWords } from './text.mjs';
import { totalFrom } from '../web/lib/total.mjs';

const MIN_HITS_TOP = 2; // bands scoring 9 or 10
const PRESENT_HORIZON = 15; // years back that still count as "now", not "period"

const band = (dim, id) => dim.bands.find((b) => b.id === id);

function pickBand(hay, dim, lex, order) {
  const matched = {};
  const decisive = {};
  for (const id of order) {
    matched[id] = matchTerms(hay, lex[id] || []);
    decisive[id] = matchTerms(hay, lex[`${id}_decisive`] || []);
  }
  for (const id of order) {
    const b = band(dim, id);
    if (!b) continue;
    // A decisive term settles the band by itself. "Water rights", "no protagonist",
    // "martial law" are not signals that need corroborating; "land" and "the studio"
    // are, which is why the ordinary list still needs two.
    if (decisive[id].count >= 1)
      return { id, score: b.score, label: b.label, evidence: [...decisive[id].hits, ...matched[id].hits], matched, decisive: true };
    const need = b.minHits ?? (b.score >= 9 ? MIN_HITS_TOP : 1);
    if (matched[id].count >= need) return { id, score: b.score, label: b.label, evidence: matched[id].hits, matched };
  }
  return { id: null, score: dim.default, label: 'No clear signal', evidence: [], matched, defaulted: true };
}

// ---------------------------------------------------------------- D1

// D1 - Structure. How the book is built.
//
// Historical causation and formal ambition were two dimensions asking one
// question, and both were starving: 43% and 11%. A braided novel linking a
// rupture to the present was scored twice for one fact, and a book that was
// merely well-built fired neither. Merged, they read every structural signal
// the archive carries into one band, and a comparative or chronological
// nonfiction shape now has somewhere to land instead of defaulting.
const STRUCTURE = ['dual_timeline', 'constraint', 'alt_archive', 'polyphony', 'generational',
  'braid', 'aftermath', 'comparative', 'chronicle', 'texture_only', 'device_twist', 'sealed'];

function scoreD1(hay, dim, lex, now, d2) {
  const res = pickBand(hay, dim, lex.D1, STRUCTURE);

  // A formal frame in service of a reveal scores 3, not 9. The Trust failure.
  // Only radical constraint and the invented archive survive a twist. The rule
  // moved here with the band it demotes to: formal ambition and historical
  // causation are one dimension now, so the judgement about how a device
  // resolves belongs to the dimension that reads devices.
  const twist = matchTerms(hay, lex.D1.device_twist || []);
  if (twist.count >= 1 && res.id !== 'constraint' && res.id !== 'alt_archive' && res.id !== 'device_twist') {
    const b = band(dim, 'device_twist');
    return { id: 'device_twist', score: b.score, label: b.label, evidence: twist.hits,
      rule: 'twist_override',
      preRule: { id: res.id, score: res.score, label: res.label, defaulted: res.defaulted },
      why: 'The device resolves into a reveal.' };
  }
  // A period the review dates but never argues from is texture, not structure.
  if (res.defaulted) {
    const years = (hay.match(/\b(1[6-9]\d\d|20[0-2]\d)\b/g) || []).length;
    if (years >= 2) {
      const b = band(dim, 'texture_only');
      return { id: 'texture_only', score: b.score, label: b.label, evidence: [], why: 'Dated, but the review never argues from the dates.' };
    }
  }
  return res;
}


// ---------------------------------------------------------------- D2

// The catalogue already knows what the book is about.
//
// 88% of this archive carries a subject from Google Books or Open Library, and
// its vocabulary is BISAC's top level — History, Political Science, Biography,
// Science. Measured against every other signal on the record it is the richest
// one there is: 92 distinct values at 4.90 bits, against 3.88 for the keyword
// subject engine at 63% coverage.
//
// It was going into the scorer as raw text, where "History" is one word among
// six hundred and fires nothing. Read as a category instead it names a band
// outright, with no keyword luck involved. That does not move this reader's
// numbers — the bands it lands on are the descriptive ones, worth the same 5 as
// the default — and that is the point: it makes a subject preference actionable
// on 88% of the corpus rather than 63%, for whoever states one.
const SUBJECT_BANDS = {
  'history': null, // a period, not an engine — D1 reads this
  'political science': 'institution',
  'social science': 'institution',
  'law': 'crime',
  'true crime': 'crime',
  'biography & autobiography': 'lives',
  'biography': 'lives',
  'business & economics': 'economy',
  'science': 'science',
  'nature': 'ecology',
  'art': 'arts',
  'music': 'arts',
  'performing arts': 'arts',
  'literary criticism': 'arts',
  'literary collections': 'arts',
  'language arts & disciplines': 'arts',
  'photography': 'arts',
  'design': 'arts',
  'religion': 'faith',
  'philosophy': 'faith',
  'body, mind & spirit': 'faith',
  'architecture': 'urban',
  'education': 'youth',
  'family & relationships': 'domestic',
  'technology & engineering': 'technology_power',
  'computers': 'technology_power',
  'health & fitness': 'medicine',
  'medical': 'medicine',
  'psychology': 'medicine',
  'sports & recreation': 'sport',
  'games & activities': 'sport',
  'travel': 'migration',
  'social science / emigration & immigration': 'migration',
  'political science / world': 'state_violence',
  'history / military': 'state_violence',
};

function subjectBand(candidate) {
  for (const raw of candidate.subjects || []) {
    const key = String(raw).toLowerCase().trim();
    if (key in SUBJECT_BANDS) return SUBJECT_BANDS[key];
    // BISAC ships "Social Science / Anthropology"; the head is what we map.
    const head = key.split('/')[0].trim();
    if (head in SUBJECT_BANDS) return SUBJECT_BANDS[head];
  }
  return null;
}

function scoreD2(hay, dim, lex, ctx, candidate = {}) {
  const order = ['land', 'state_violence', 'institution', 'art_under_state', 'faith', 'finance', 'domestic', 'media_tech',
    // Descriptive-only bands, last by design: they fire only where none of the
    // profile's own engines did, so they cannot move a number in this profile.
    'crime', 'migration', 'medicine', 'ecology', 'youth', 'sport',
    'urban', 'economy', 'technology_power', 'lives', 'arts', 'science'];
  const res = pickBand(hay, dim, lex.D2, order);

  // The prose said nothing, so ask the catalogue. Never the other way round: a
  // review that names the engine outranks a top-level shelving category.
  if (res.defaulted) {
    const id = subjectBand(candidate);
    const b = id ? band(dim, id) : null;
    if (b) {
      return { id, score: b.score, label: b.label, evidence: candidate.subjects.slice(0, 3),
        why: 'From the catalogue’s own subject rather than from the text.', fromCatalogue: true };
    }
  }

  // Trap 4 — land fiction at the wrong scale. Homestead and Damnation Spring hit the
  // subject engine precisely and were passed; both single-couple, single-season. Land
  // requires institutional or multi-decade scale.
  if (res.id === 'land') {
    const institutional = res.matched.institution?.count >= 1;
    const multiDecade = ctx.d1Band === 'dual_timeline' || ctx.d1Band === 'generational' || ctx.generational || (ctx.pages || 0) >= 450;
    if (!institutional && !multiDecade) {
      return { ...res, score: 6, demoted: true, label: res.label,
        rule: 'trap4_land_scale',
        preRule: { id: res.id, score: res.score, label: res.label },
        why: 'Trap 4 — the land engine is exact but the scale is not. No institution behind it and no multi-decade span.' };
    }
  }
  return res;
}

// ---------------------------------------------------------------- D4

// D4 - Register. Two vocabularies, one dimension.
//
// The fiction bands describe a novel's prose: lyric, baroque, spare, flat. None
// of them fires on a monograph, and measured across this archive that left the
// heaviest dimension in the profile firing on 3% of nonfiction against 21% of
// fiction. So nonfiction gets its own registers, because what a reader wants
// from nonfiction is a different question.
//
// A book the catalogue calls fiction is never read against them. Everything
// else tries the nonfiction registers first and falls back to the fiction ones,
// so a novel nobody has classified still scores as it did.
// Specific registers first, expository last: it is the default mode of serious
// nonfiction and it fires on nearly half of it, so a book that is also
// scholarly, reported or confessional should be named as the narrower thing.
const NF_REG = ['creative_nonfiction', 'academic', 'dense_theory', 'reported', 'confessional',
  'pop_subject', 'expository'];
const FIC_REG = ['lyric_dread', 'baroque', 'spare', 'functional', 'quippy', 'flat'];

const looksFiction = (c) => c.sourceIsFictionOnly === true
  || (c.subjects || []).some((x) => /\bfiction\b|\bnovel|short stories/i.test(String(x)));

function scoreD4(hay, dim, lex, candidate = {}, isFiction = null) {
  // An explicit negative verdict on the prose outranks any positive adjective in
  // the same review.
  for (const id of ['flat', 'quippy']) {
    const res = matchTerms(hay, lex.D4[id] || []);
    if (res.count >= 2) {
      const b = band(dim, id);
      return { id, score: b.score, label: b.label, evidence: res.hits, why: 'The review names the prose as the book\'s weakness.' };
    }
  }
  if (isFiction ?? looksFiction(candidate)) return pickBand(hay, dim, lex.D4, FIC_REG);
  const nf = pickBand(hay, dim, lex.D4, NF_REG);
  return nf.defaulted ? pickBand(hay, dim, lex.D4, FIC_REG) : nf;
}


// D3 - Form. What kind of book it is.
//
// Read from the record rather than the prose: the classification is on every
// book, the catalogue subject on 88% of them, and a page count on 76%. That
// makes this the one text-independent dimension that still says something about
// the reading rather than about the packaging, which is why it exists at all.
const FORM_SUBJECTS = [
  [/poetry/i, 'poetry'], [/comic|graphic novel/i, 'graphic'],
  [/biography|autobiograph|memoir/i, 'memoir'], [/^history|history\b/i, 'history'],
  [/reference|handbook|manual|dictionary|encyclop/i, 'reference'],
  [/literary collections|essays/i, 'essays'],
];
function scoreD3(hay, dim, candidate, register, isFiction = null) {
  const out = (id, why, ev = []) => { const b = band(dim, id); return { id, score: b.score, label: b.label, evidence: ev, why }; };
  const subjects = (candidate.subjects || []).join(' ');
  for (const [re, id] of FORM_SUBJECTS) {
    if (re.test(subjects)) return out(id, 'From the catalogue’s own subject.', (candidate.subjects || []).slice(0, 2));
  }
  const fiction = isFiction ?? (candidate.sourceIsFictionOnly === true || /\bfiction\b|\bnovel/i.test(subjects));
  if (fiction) {
    if (/\b(stories|a collection|linked stories|short fiction)\b/i.test(hay)) return out('stories', 'The review calls it stories.');
    return out('novel', 'Catalogued as fiction.');
  }
  // Nonfiction takes its form from the register the prose earned, which is the
  // only other thing we know about how it is written.
  const byRegister = { academic: 'monograph', dense_theory: 'monograph', reported: 'reportage',
    creative_nonfiction: 'reportage', confessional: 'memoir', pop_subject: 'reference' };
  if (register && byRegister[register.id]) return out(byRegister[register.id], 'Inferred from how it is written.');
  if (/\b(essays|essay collection)\b/i.test(hay)) return out('essays', 'The text calls it essays.');
  return { id: null, score: dim.default, label: 'Form not established', evidence: [], defaulted: true };
}

// D7 - Provenance. Who published it, and whether anyone reviewed it.
//
// Two facts that are on every record for free, and the closest thing the archive
// has to a proxy for how demanding a book is. Multiple reviews outrank the
// imprint: being covered twice is a harder thing to arrange than a good logo.
// Two tests, because the abbreviations only work case-sensitively.
//
// The first version of this had `university` and nothing else, and an audit of
// every publisher in the archive against it found 83 imprints and 159 books -
// a fifth of the corpus - falling through to "a general trade imprint": U
// California Press, U Chicago Press, Stanford UP, JHU Press, UNC Press,
// McGill-Queen's UP. Scholarly presses scoring 4 where they had earned 7.
//
// `UP` cannot go in the case-insensitive list: under /i it matches every "up"
// in every blurb. So the initialisms and the abbreviated forms are tested
// against the publisher on its own, with case intact.
const ACADEMIC_PRESS = /university|univ\.?\b|press of|academic|routledge|springer|palgrave|brill|anthem|mit press|duke|cornell|yale|princeton|harvard|oxford|cambridge|johns hopkins|wayne state|mcgill|policy press|beacon press/i;
const ACADEMIC_ABBR = /\bU\.? ?[A-Z][a-z]+ Press\b|\b[A-Z][A-Za-z'-]+ UP\b|\b(JHU|NYU|UNC|NUS|MIT|LSU|SUNY|CUNY|UCL)\b/;
const INDIE_PRESS = /verso|coffee house|graywolf|new directions|fitzcarraldo|and other stories|deep vellum|catapult|semiotext|two lines|archipelago|tin house|soft skull|melville house|dalkey|charco|peirene|pushkin|europa editions|transit books|open letter|dorothy/i;
const LITERARY_IMPRINT = /riverhead|farrar|fsg|knopf|pantheon|picador|granta|jonathan cape|hamish hamilton|bloomsbury|faber|vintage|scribner|little, brown|norton|doubleday|viking|hogarth|tin house/i;

function scoreD7(hay, dim, candidate) {
  const out = (id, why, ev = []) => { const b = band(dim, id); return { id, score: b.score, label: b.label, evidence: ev, why }; };
  const p = [candidate.publisher, ...(candidate.publishers || [])].filter(Boolean).join(' ');
  if ((candidate.reviewCount || 0) > 1) return out('acclaimed', `${candidate.reviewCount} publications reviewed it.`);
  if (INDIE_PRESS.test(p)) return out('indie', 'An independent press.', [candidate.publisher]);
  if (ACADEMIC_PRESS.test(p) || ACADEMIC_ABBR.test(p)) return out('academic_press', 'A scholarly press.', [candidate.publisher]);
  if (LITERARY_IMPRINT.test(p)) return out('literary', 'A literary imprint.', [candidate.publisher]);
  if (p) return out('trade', 'A general trade imprint.', [candidate.publisher]);
  return { id: null, score: dim.default, label: 'Publisher unknown', evidence: [], defaulted: true };
}

// D8 - Narration. How the story is told, and only for stories.
//
// Register asks how the sentences read. This asks who is telling and what
// carries the book, which is a different question and the one this corpus
// actually answers about fiction.
//
// The evidence for that is in the corpus rather than in a theory. Mined against
// nonfiction, the terms fiction reviews reach for are `narrator` (24 against 2),
// `the plot` (14 against 0), `premise` (10 against 1), `protagonist` (10 against
// 2), `the characters` (8 against 2). Not one prose descriptor among them:
// reviewers describe a novel's point of view and its engine, and describe its
// prose for barely a third of books. So the dimension follows the evidence.
//
// Fiction only. On a monograph these terms either do not appear or mean
// something else, and the dimension defaults, which costs nothing - a silent
// dimension is not evidence and does not drag a score. Nonfiction is answered by
// Register, which is the mirror of this and fires on 59% of it.
const NARRATION = ['multi_voice', 'unreliable', 'character_interior', 'ensemble', 'plot_driven', 'single_voice'];

function scoreD8(hay, dim, lex, isFiction) {
  if (!isFiction) return { id: null, score: dim.default, label: 'Not a story', evidence: [], defaulted: true };
  return pickBand(hay, dim, lex.D8 || {}, NARRATION);
}

// ---------------------------------------------------------------- D6

// Length on its own is not scale. Both demotions here read D3, so a reader who does
// not share the formal-ambition preference inherits it through D6 unless the band's
// own score is recoverable. Same shape as the D2 and D3 rules: keep the number the
// band declares, say which rule moved it.
function demote(res, score, rule) {
  return { ...res, score, rule, preRule: { id: res.id, score: res.score, label: res.label } };
}

function scoreD6(hay, dim, pages, d3, ctx) {
  const out = (id, why) => { const b = band(dim, id); return { id, score: b.score, label: b.label, evidence: pages ? [`${pages} pp.`] : [], why }; };
  if (!pages) return { id: null, score: dim.default, label: 'Page count unknown', evidence: [], defaulted: true };
  const ambitious = d3 >= 8;
  const spanning = ctx.d1Band === 'dual_timeline' || ctx.d1Band === 'generational' || ctx.generational;
  if (pages >= 500) return (ambitious || spanning)
    ? out('sprawl', `${pages} pages, multi-strand or decades-spanning.`)
    : demote(out('sprawl', `${pages} pages, but the review shows no multi-strand or decades-spanning structure.`), 9, 'd6_sprawl_without_ambition');
  if (pages >= 400) return ambitious
    ? out('long_ambit', `${pages} pages with real structural ambition.`)
    : demote(out('long_ambit', `${pages} pages, conventionally structured.`), 6, 'd6_length_without_ambition');
  if (pages < 300 && d3 >= 8) return out('short_formal', `${pages} pages but formally extreme.`);
  if (pages >= 300) return out('mid_conv', `${pages} pages, conventional.`);
  return out('short_conv', `${pages} pages, conventional.`);
}

// ---------------------------------------------------------------- filters

function runFilters(hay, lex, cand, dims, matched) {
  const fired = [];
  const L = lex.filters;

  const subjects = normalize((cand.subjects || []).join(' | '));
  const olSaysFiction = /\bfiction\b/.test(subjects);
  // The profile hard-filters nonfiction outright, so a catalogued book whose subject
  // headings never say fiction is treated as nonfiction rather than as a maybe.
  const olSaysNonfiction = Boolean(subjects) && !olSaysFiction;
  // The publication files its own reviews by subject. "Law, Politics, United States"
  // with no literary section anywhere is the New York Review saying, in its own
  // metadata, that this is not a novel.
  const sections = (cand.sections || []).map((t) => normalize(String(t)));
  const sectionSaysFiction = sections.some((t) => (L.sectionFiction || []).includes(t));
  // One tag is not a verdict. Publications label inconsistently, and a piece tagged
  // "books in translation, latest" is not thereby nonfiction. Require that the
  // nonfiction tags actually outnumber everything else on the piece.
  const nfTags = sections.filter((t) => (L.sectionNonfiction || []).includes(t));
  // Unless the label is the word itself. A desk that files a review under
  // "Nonfiction" is not tagging loosely, it is stating the genre, and 4Columns
  // and Publishers Weekly both do exactly that.
  // "Nonfiction" outranks "Literature" when a book carries both, because outlets
  // use Literature to mean books-in-general and Nonfiction to mean this one is not
  // a novel. Only the loose majority test defers to a fiction label.
  const decisiveNonfiction = sections.some((t) => (L.sectionNonfictionDecisive || []).includes(t));
  const sectionSaysNonfiction = decisiveNonfiction
    || (!sectionSaysFiction && nfTags.length >= 2 && nfTags.length >= sections.length - nfTags.length);

  const nf = matchTerms(hay, L.nonfiction);
  const fic = matchTerms(hay, L.fiction);
  // "A History of the Novel in Britain" trips every fiction keyword there is. The
  // shape of the title settles it where the vocabulary cannot.
  const fullTitle = [cand.title, cand.subtitle].filter(Boolean).join(': ');
  // Deliberately narrow. "The Book of Chuck", "The Art of Fielding", "The Age of
  // Innocence" are all novels, so "book of", "art of", "age of", "world of" and
  // "story of" cannot be nonfiction markers. What survives is the shape a work of
  // history or biography actually takes.
  const titleIsNonfiction = /^(a |an |the )?(history|lives|biography|making|rise|fall|letters|essays|memoirs?|diaries) of\b/i.test(fullTitle)
    || /^(a |an |the )?(history|biography|memoir|essays) \b/i.test(fullTitle)
    || /:\s*(a|an|the)?\s*(history|biography|life|lives|memoir|study|portrait|account|chronicle|investigation)\b/i.test(fullTitle)
    || /\b(the lives of|the life of|a life of|an oral history)\b/i.test(fullTitle)
    // Subtitle shapes a novel does not take. "X and the Making of Y" is the
    // house style of academic and trade history; ": How", ": Why" and ": Inside"
    // announce an argument or a piece of reporting, never a plot.
    || /\band the (making|unmaking|remaking|rise|fall|birth|death|invention|creation|shaping|end) of\b/i.test(fullTitle)
    || /:\s*(how|why|inside)\b/i.test(fullTitle)
    || /:\s*(a|an|the)?\s*(story|secret history|untold story|hidden history|invention|reckoning|reporter)\b/i.test(fullTitle);
  // The catalogue still gets the last word on fiction. "Biography of X" is a novel
  // shaped like a life, and only the catalogue knows that; the title-shape test
  // cannot be allowed to overrule it.
  if (sectionSaysNonfiction || (!olSaysFiction && !sectionSaysFiction
      && (olSaysNonfiction || titleIsNonfiction || (nf.count >= 2 && nf.count > fic.count)))) {
    fired.push({
      id: 'nonfiction',
      evidence: olSaysNonfiction ? ['catalogued as nonfiction']
        : titleIsNonfiction ? [`the title says so: "${fullTitle}"`]
        : sectionSaysNonfiction ? [`filed by the publication under ${sections.join(', ')}`]
        : nf.hits,
    });
  }

  const sat = matchTerms(hay, L.satire_primary);
  if (sat.count >= 1 || (matched.D5?.id === 'comic' && (matched.D5.evidence || []).length >= 3))
    fired.push({ id: 'satire', evidence: sat.count ? sat.hits : matched.D5.evidence });

  const pyn = matchTerms(hay, L.pynchon);
  if (pyn.count >= 1) fired.push({ id: 'pynchon', evidence: pyn.hits });

  const tw = matchTerms(hay, L.twist);
  if (tw.count >= 1) fired.push({ id: 'twist', evidence: tw.hits });

  if (dims.D1.score === 0) fired.push({ id: 'sealed_present', evidence: dims.D1.evidence });

  const bc = matchTerms(hay, L.bookclub);
  if (bc.count >= 1) fired.push({ id: 'bookclub', evidence: bc.hits });

  return fired;
}

function runPenalties(hay, lex, cand, dims) {
  const fired = [];
  const P = lex.penalties;
  const add = (id, evidence, tier) => fired.push({ id, evidence, tier });

  if (matchTerms(hay, P.prestige_tv).count >= 1) add('prestige_tv', matchTerms(hay, P.prestige_tv).hits);

  const genre = matchTerms(hay, P.genre_framing);
  const absorbed = matchTerms(hay, P.genre_absorbed);
  if (genre.count >= 1 && absorbed.count === 0) add('genre_framing', genre.hits);

  // A warm ending is not disqualifying on its own. What costs the book is warmth
  // that arrives on cue — sentimental, tidy, telegraphed. Warmth the review marks as
  // costly, resisted or strange costs nothing, and where the review says neither the
  // penalty is small and visible rather than decisive.
  const red = matchTerms(hay, P.redemptive);
  if (red.count >= 1) {
    const cliche = matchTerms(hay, P.redemptive_cliche);
    const earned = matchTerms(hay, P.redemptive_earned);
    const tier = cliche.count > earned.count ? 'cliche' : earned.count > 0 ? 'earned' : 'unclear';
    const evidence = [...red.hits, ...(tier === 'cliche' ? cliche.hits : tier === 'earned' ? earned.hits : [])];
    add('redemptive', evidence, tier);
  }

  const wn = matchTerms(hay, P.writer_narrator);
  if (wn.count >= 1 && dims.D2.score < 8) add('writer_narrator', wn.hits);

  if (cand.pages && cand.pages < 250 && dims.D3.score < 8) add('short_conv', [`${cand.pages} pp.`]);

  return fired;
}

function runBonuses(hay, lex, cand) {
  const fired = [];
  const cat = matchTerms(hay, lex.bonuses.catastrophe_religion);
  if (cat.count >= 1) fired.push({ id: 'catastrophe_religion', evidence: cat.hits });
  const w = matchTerms(hay, lex.bonuses.wimmer);
  const wimmerCredit = /wimmer/i.test(cand.translator || '');
  if (w.count >= 1 || wimmerCredit) fired.push({ id: 'wimmer', evidence: w.count ? w.hits : ['tr. Natasha Wimmer'] });
  return fired;
}

function openQuestions(hay, lex, cand, dims) {
  const tags = [];
  const sup = matchTerms(hay, lex.signals.supernatural);
  if (sup.count >= 1) tags.push({ id: 'Q1', evidence: sup.hits });
  if (cand.translated && (cand.pages || 0) >= 350 && dims.D1.score >= 8) tags.push({ id: 'Q2', evidence: ['translated', `${cand.pages} pp.`] });
  if (cand.pages && cand.pages < 250 && dims.D3.score <= 5) tags.push({ id: 'Q3', evidence: [`${cand.pages} pp.`, 'conventional form'] });
  if (dims.D1.score >= 9 && dims.D2.score >= 9 && (cand.pages || 0) >= 400 && dims.D3.score <= 5) tags.push({ id: 'Q4', evidence: ['period, institutional, long, conventional in form'] });
  if (dims.D4.score <= 4 && dims.D1.score >= 8 && dims.D2.score >= 8 && dims.D6.score >= 8) tags.push({ id: 'Q5', evidence: ['plain prose, strong everywhere else'] });
  const genre = matchTerms(hay, lex.penalties.genre_framing);
  const absorbed = matchTerms(hay, lex.penalties.genre_absorbed);
  if (genre.count >= 1 && absorbed.count >= 1) tags.push({ id: 'Q6', evidence: [...genre.hits, ...absorbed.hits] });
  return tags;
}

// Whether a fired filter still removes the book. Under the amended profile it does
// not - it costs points like anything else.
function excludedByFilters(profile, filters) {
  return (profile.filterMode || 'exclude') !== 'penalty' && filters.length > 0;
}

// ---------------------------------------------------------------- entry point

export function score(candidate, profile, lexicons, opts = {}) {
  const now = opts.now || new Date().getFullYear();
  const dimById = Object.fromEntries(profile.dimensions.map((d) => [d.id, d]));
  const hay = normalize([
    candidate.title, candidate.author, candidate.reviewTitle, candidate.standfirst,
    candidate.text, (candidate.subjects || []).join(' '), candidate.publisher,
  ].filter(Boolean).join('. '));

  const gen = matchTerms(hay, lexicons.D1.generational).count >= 2;

  const d2Raw = pickBand(hay, dimById.D2, lexicons.D2,
    ['land', 'state_violence', 'institution', 'art_under_state', 'faith', 'finance', 'domestic', 'media_tech',
    // Descriptive-only bands, last by design: they fire only where none of the
    // profile's own engines did, so they cannot move a number in this profile.
    'crime', 'migration', 'medicine', 'ecology', 'youth', 'sport',
    'urban', 'economy', 'technology_power', 'lives', 'arts', 'science']);
  const D1 = scoreD1(hay, dimById.D1, lexicons, now, d2Raw.score);
  const ctx = { d1Band: D1.id, generational: gen, pages: candidate.pages };
  const D2 = scoreD2(hay, dimById.D2, lexicons, ctx, candidate);

  // Whether this is fiction, settled before any register is picked.
  //
  // It used to be settled after the dimensions, because it read the nonfiction
  // hard filter, and that filter needed the dimensions. Revision 3 withdrew the
  // filter, so the circle is gone and the answer can come first - which it has
  // to, because the register vocabularies are disjoint and picking the wrong one
  // put a nonfiction register on 19 novels. Everything else it reads is on the
  // record or in the text: a catalogue subject, the section a publication filed
  // it under, a fiction-only source, or the review calling it a novel.
  // The nonfiction filter is a lexicon match on the same text, so it can be
  // asked here rather than waiting for runFilters, which needs the dimensions
  // this answer is about to gate. Without it the early call and the final
  // classification disagreed on four books, and a biography of Norman Mailer was
  // scored for its narrator.
  const looksNonfiction = matchTerms(hay, lexicons.filters?.nonfiction || []).count >= 1
    && matchTerms(hay, lexicons.filters?.fiction || []).count === 0;
  const form = looksNonfiction
    ? { status: 'nonfiction', why: 'Filtered as nonfiction.' }
    : fictionStatus(hay, lexicons, candidate, []);
  const isFiction = form.status === 'confirmed' || form.status === 'likely';

  const D4 = scoreD4(hay, dimById.D4, lexicons, candidate, isFiction);
  const D3 = scoreD3(hay, dimById.D3, candidate, D4, isFiction);
  const D5 = pickBand(hay, dimById.D5, lexicons.D5,
    ['dread', 'harrowing', 'elegiac', 'indicting', 'cold', 'warm', 'comic',
      'hardboiled', 'gothic', 'surreal', 'ironic', 'propulsive', 'grave']);
  // D6 asks whether the book is formally ambitious, and it must ask the band D3
  // earned rather than the band D3 was left with. The twist override is a judgement
  // about how a device resolves; letting it travel into scale docks a long braided
  // novel twice for one fact, and a reader who does not hold the twist rule cannot
  // undo the second charge because it was never recorded as that rule's doing.
  // Length is not scale without structure behind it, and Structure is the
  // dimension that now carries that - D3 became Form in revision 3.
  const D6 = scoreD6(hay, dimById.D6, candidate.pages, D1.preRule?.score ?? D1.score, ctx);
  const D7 = scoreD7(hay, dimById.D7, candidate);
  const D8 = scoreD8(hay, dimById.D8, lexicons, isFiction);

  const dims = { D1, D2, D3, D4, D5, D6, D7, D8 };
  for (const [id, d] of Object.entries(dims)) {
    d.dimension = id;
    d.name = dimById[id].name;
    d.weight = dimById[id].weight;
    d.contribution = Math.round(d.score * dimById[id].weight) / 10;
    // What the band is worth in this profile, before any of the profile's own
    // non-linear rules moved it. A reader who does not hold the rule needs the
    // number the band declares, and the rule name to know what to undo.
    const decl = d.id ? band(dimById[id], d.id) : null;
    d.bandScore = decl ? decl.score : null;
    d.ruleAdjusted = d.score !== (d.preRule ? d.preRule.score : d.bandScore ?? d.score);
  }

  // A title names what a book is about. It does not describe how the book reads.
  //
  // 76 bands across this archive fire on nothing but words in the title, and for
  // subject and form that is fair - "Europe: A New History" is history, "Birding
  // While Indian: A Mixed-Blood Memoir" is a memoir. For the dimensions that
  // describe the reading it is not: "Pentagon Capitalism: How the Cold War..."
  // was scored cold in tone, "Moving Toward Freedom" warm, "A Tender Age" warm,
  // "Lessons for a Warming Planet" a popular treatment. None of those is a
  // judgement about the book; each is a word that happens to be on the cover.
  //
  // So Register, Tone and Narration may not be carried by the title alone.
  const titleWords = normalize(candidate.title || '');
  for (const id of ['D4', 'D5', 'D8']) {
    const dim = dims[id];
    const ev = (dim.evidence || []).filter((e) => typeof e === 'string');
    if (dim.defaulted || !ev.length) continue;
    if (ev.every((e) => titleWords.includes(normalize(e)))) {
      dims[id] = { ...dim, id: null, score: dimById[id].default,
        label: 'No clear signal', evidence: [], defaulted: true, titleOnly: true };
    }
  }

  const filters = runFilters(hay, lexicons, candidate, dims, dims);

  // Narration is fiction-only, and the gate that decided it ran before the
  // filters did. runFilters reaches nonfiction by routes the early check cannot
  // see - a section header, a decisive term - so rather than predict it, the
  // invariant is enforced once the classification is final. A biography of
  // Norman Mailer does not have a narrator.
  if (filters.some((f) => f.id === 'nonfiction') && !dims.D8.defaulted) {
    dims.D8 = { ...dims.D8, id: null, score: dimById.D8.default, label: 'Not a story',
      evidence: [], defaulted: true };
  }
  const fiction = filters.some((f) => f.id === 'nonfiction') ? fictionStatus(hay, lexicons, candidate, filters) : form;
  const penalties = runPenalties(hay, lexicons, candidate, dims);
  const bonuses = runBonuses(hay, lexicons, candidate);

  // The weighted sum and the two rules that overrule it live in total.mjs, because
  // the browser has to reach the same number when a reader re-scores a band.
  let adjustmentPoints = 0;
  const adjustments = [];
  // Things worth showing that cost nothing — a warm ending the review says is earned
  // is a fact about the book, not a mark against it.
  const notes = [];

  for (const p of penalties) {
    const def = profile.softPenalties.find((x) => x.id === p.id);
    if (!def) continue;
    // A penalty may be graduated: the tier decides both the points and the wording.
    const tier = p.tier ? def.tiers?.find((t) => t.id === p.tier) : null;
    const points = tier ? tier.points : def.points;
    const label = tier ? tier.label : def.label;
    adjustmentPoints += points;
    if (points !== 0) adjustments.push({ ...p, points, label });
    else notes.push({ id: p.id, tier: p.tier, label, evidence: p.evidence });
  }
  // The profile determines the score; it does not decide what appears. What were
  // hard filters are heavy negatives, sized to push a book out of the recommendation
  // band while leaving it visible, scored and sortable like everything else.
  if ((profile.filterMode || 'exclude') === 'penalty') {
    for (const f of filters) {
      const def = profile.hardFilters.find((x) => x.id === f.id);
      if (!def || typeof def.points !== 'number') continue;
      adjustmentPoints += def.points;
      adjustments.push({ ...f, points: def.points, label: def.label });
    }
  }

  for (const b of bonuses) {
    const def = profile.bonuses.find((x) => x.id === b.id);
    if (def) { adjustmentPoints += def.points; adjustments.push({ ...b, points: def.points, label: def.label }); }
  }

  const excluded = (profile.filterMode || 'exclude') !== 'penalty' && filters.length > 0;
  const {
    total, fired: firedDims, firedWeight, evidenceWeight, renormalised: renormalise,
    proseFloorApplied: capped,
  } = totalFrom({ dims, profile, adjustmentPoints, excluded: excludedByFilters(profile, filters) });
  const bandDef = excluded
    ? { id: 'excluded', label: 'Excluded', action: 'Hard filter.' }
    : profile.thresholds.bands.find((b) => total >= b.min);

  return {
    total,
    band: bandDef.id,
    bandLabel: bandDef.label,
    action: bandDef.action,
    dimensions: dims,
    filters: filters.map((f) => ({ ...f, ...profile.hardFilters.find((x) => x.id === f.id) })),
    adjustments,
    proseFloorApplied: capped,
    // Every place the profile's own preferences moved a dimension off its band, in
    // one list. The prose floor is already reversible from its flag because it caps
    // the total rather than rewriting a band; these rewrite bands, so they need the
    // pre-rule value recorded on the dimension to be undone.
    dimensionRules: Object.values(dims)
      .filter((d) => d.rule)
      .map((d) => ({ dimension: d.dimension, rule: d.rule, from: d.preRule, to: d.score })),
    dimensionsFired: firedDims.length,
    scoredOnPartialEvidence: !renormalise,
    firedWeight,
    // What fired that was actually about the book, as against looked up. This is
    // the number shrinkage and renormalisation both read - see web/lib/total.mjs.
    evidenceWeight,
    renormalised: renormalise,
    notes,
    fiction,
    openQuestions: openQuestions(hay, lexicons, candidate, dims),
    risk: buildRisk(dims, filters, adjustments, capped, candidate, profile, now),
  };
}

// §8 asks every recommendation to carry vetted evidence. Fiction is the first thing
// that has to be evidenced, because nonfiction is a hard filter: a book nobody has
// classified and no reviewer has called a novel is not quietly assumed to be one.
const FICTION_DECISIVE = [
  'the novel', 'a novel', 'his novel', 'her novel', 'their novel', 'this novel',
  'debut novel', 'first novel', 'new novel', 'novella', 'the novella',
  'story collection', 'collection of stories', 'short stories', 'the novelist',
  'a work of fiction', 'in the novel', 'the protagonist', 'fictional', 'a tale',
  'this tale', 'his fiction', 'her fiction', 'their fiction', 'novelistic',
  'the characters', 'her narrator', 'his narrator', 'the book\'s narrator',
];

function fictionStatus(hay, lex, cand, filters) {
  if (filters.some((f) => f.id === 'nonfiction')) return { status: 'nonfiction', why: 'Filtered as nonfiction.' };
  if (cand.subjects?.length && /\bfiction\b/.test(normalize(cand.subjects.join(' ')))) {
    return { status: 'confirmed', why: 'Catalogued as fiction.' };
  }
  // The publication filing a review under Fiction is the publication of record saying
  // so, and it is available for the recent books the catalogue has not reached yet.
  const section = (cand.sections || []).find((t) => /^fiction$/i.test(String(t).trim()));
  if (section) return { status: 'confirmed', why: `Filed under Fiction by the publication.` };
  if (cand.sourceIsFictionOnly) return { status: 'confirmed', why: 'The source feed carries fiction reviews only.' };
  const hits = matchTerms(hay, FICTION_DECISIVE);
  if (hits.count >= 1) return { status: 'likely', why: `The review calls it one: ${hits.hits.slice(0, 3).join(', ')}.` };
  return { status: 'unknown', why: 'Nothing in the catalogue or the review establishes that this is fiction.' };
}

// The 62–77 band is presented with the objection surfaced, not hidden. This builds
// that objection out of whatever actually dragged the score down.
function buildRisk(dims, filters, adjustments, capped, cand, profile, now) {
  const notes = [];
  if (capped) notes.push('The review names the prose as the weak point. The profile treats that as a floor, not a tradeoff.');
  const weakest = Object.values(dims).filter((d) => !d.defaulted).sort((a, b) => a.score * a.weight - b.score * b.weight)[0];
  if (weakest && weakest.score <= 4) notes.push(`${weakest.name} is the drag: ${weakest.label.toLowerCase()}.`);
  for (const a of adjustments) if (a.points < 0) notes.push(`${a.label} (${a.points}).`);
  const defaulted = Object.values(dims).filter((d) => d.defaulted).map((d) => d.dimension);
  if (defaulted.length >= 3) notes.push(`Thin evidence — ${defaulted.join(', ')} fell back to defaults, so this score is a guess more than a read.`);
  if (cand.bookYear && cand.bookYear < now - (profile.window?.years || 10)) notes.push(`Published ${cand.bookYear}, outside the ${profile.window.years}-year window.`);
  return notes;
}
