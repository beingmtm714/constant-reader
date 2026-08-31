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
// What a reader is asked, and it has to match what the profile can hold.
//
// Every chip is a `dimension:band` key, and buildProfile skips any band that no
// longer exists - silently, which is the danger. Revision 3 moved formal
// ambition into Structure and gave D3 to Form, and six chips went on being
// offered while writing nothing at all: formal constraint, many voices, told
// straight, a late reveal, set in the past, and book-club picks. They are
// remapped below. `bin/test.mjs` now fails if any chip points at a band the
// profile does not have, so this cannot rot again unnoticed.
//
// `reads` gates a chip to a kind of reader: `nonfiction` chips are hidden from
// someone who only reads novels, `fiction` chips from someone who only reads
// nonfiction. A question about narrators is not a question for a monograph.
export const CHIPS = [
  // How the sentences read - fiction.
  { dim: 'D4', band: 'baroque', label: 'Dense, baroque prose', reads: 'fiction' },
  { dim: 'D4', band: 'spare', label: 'Spare, precise prose', reads: 'fiction' },
  { dim: 'D4', band: 'lyric_dread', label: 'Lyric, with dread under it', reads: 'fiction' },
  { dim: 'D4', band: 'quippy', label: 'Comic, wry prose', reads: 'fiction' },

  // How the sentences read - nonfiction. These had no chips at all, so a reader
  // could not say what they wanted from nonfiction however clearly they knew.
  { dim: 'D4', band: 'creative_nonfiction', label: 'Nonfiction written like a novel', reads: 'nonfiction' },
  { dim: 'D4', band: 'academic', label: 'Scholarly, with its apparatus', reads: 'nonfiction' },
  { dim: 'D4', band: 'expository', label: 'A case argued in plain prose', reads: 'nonfiction' },
  { dim: 'D4', band: 'reported', label: 'Reported and investigative', reads: 'nonfiction' },
  { dim: 'D4', band: 'dense_theory', label: 'Dense and theoretical', reads: 'nonfiction' },
  { dim: 'D4', band: 'confessional', label: 'Personal and confessional', reads: 'nonfiction' },
  { dim: 'D4', band: 'pop_subject', label: 'Popular treatments for a general reader', reads: 'nonfiction' },

  // Tone.
  { dim: 'D5', band: 'dread', label: 'Dread and menace' },
  { dim: 'D5', band: 'harrowing', label: 'Devastating, unflinching' },
  { dim: 'D5', band: 'elegiac', label: 'Elegiac, haunted' },
  { dim: 'D5', band: 'grave', label: 'Sober and weighty' },
  { dim: 'D5', band: 'indicting', label: 'Angry and indicting' },
  { dim: 'D5', band: 'comic', label: 'Comic and satirical' },
  { dim: 'D5', band: 'hardboiled', label: 'Hardboiled, noir', reads: 'fiction' },
  { dim: 'D5', band: 'gothic', label: 'Gothic, uncanny', reads: 'fiction' },
  { dim: 'D5', band: 'warm', label: 'Warm and humane' },
  { dim: 'D5', band: 'propulsive', label: 'Propulsive and taut' },

  // How the book is built. These four moved from D3 to D1 in revision 3.
  { dim: 'D1', band: 'constraint', label: 'Formal constraint' },
  { dim: 'D1', band: 'polyphony', label: 'Many voices, no centre' },
  { dim: 'D1', band: 'braid', label: 'Braided timelines' },
  { dim: 'D1', band: 'chronicle', label: 'Told straight, start to finish' },
  { dim: 'D1', band: 'device_twist', label: 'A late reveal' },
  { dim: 'D1', band: 'dual_timeline', label: 'Two timelines' },
  { dim: 'D1', band: 'generational', label: 'A family or a place across generations' },
  { dim: 'D1', band: 'comparative', label: 'Cases set against each other', reads: 'nonfiction' },
  { dim: 'D1', band: 'sealed', label: 'Firmly in the present' },

  // Who is telling it. Fiction only - the dimension does not fire otherwise.
  { dim: 'D8', band: 'character_interior', label: 'Close and interior', reads: 'fiction' },
  { dim: 'D8', band: 'multi_voice', label: 'Several narrators', reads: 'fiction' },
  { dim: 'D8', band: 'unreliable', label: 'A narrator you cannot trust', reads: 'fiction' },
  { dim: 'D8', band: 'ensemble', label: 'A large cast', reads: 'fiction' },
  { dim: 'D8', band: 'plot_driven', label: 'Driven by plot', reads: 'fiction' },

  // What kind of book.
  { dim: 'D3', band: 'novel', label: 'Novels', reads: 'fiction' },
  { dim: 'D3', band: 'stories', label: 'Short stories', reads: 'fiction' },
  { dim: 'D3', band: 'history', label: 'History', reads: 'nonfiction' },
  { dim: 'D3', band: 'memoir', label: 'Memoir and biography', reads: 'nonfiction' },
  { dim: 'D3', band: 'essays', label: 'Essays', reads: 'nonfiction' },
  { dim: 'D3', band: 'monograph', label: 'Scholarly monographs', reads: 'nonfiction' },
  { dim: 'D3', band: 'reportage', label: 'Long-form reporting', reads: 'nonfiction' },
  { dim: 'D3', band: 'poetry', label: 'Poetry' },

  // What it is about.
  { dim: 'D2', band: 'land', label: 'Land, labour, extraction' },
  { dim: 'D2', band: 'state_violence', label: 'States and their violence' },
  { dim: 'D2', band: 'institution', label: 'Institutions and how they form' },
  { dim: 'D2', band: 'faith', label: 'Faith and belief' },
  { dim: 'D2', band: 'domestic', label: 'Family and marriage' },
  { dim: 'D2', band: 'crime', label: 'Crime and the law' },
  { dim: 'D2', band: 'media_tech', label: 'Internet life' },
  { dim: 'D2', band: 'urban', label: 'Cities and housing' },
  { dim: 'D2', band: 'economy', label: 'Work and the economy' },
  { dim: 'D2', band: 'technology_power', label: 'Technology and power' },
  { dim: 'D2', band: 'lives', label: 'A life, told' },
  { dim: 'D2', band: 'arts', label: 'Art and music' },
  { dim: 'D2', band: 'science', label: 'Science' },
  { dim: 'D2', band: 'medicine', label: 'Illness and care' },
  { dim: 'D2', band: 'ecology', label: 'Ecology and climate' },
  { dim: 'D2', band: 'migration', label: 'Migration and exile' },

  // Length and press.
  { dim: 'D6', band: 'sprawl', label: 'Long and sprawling' },
  { dim: 'D6', band: 'short_conv', label: 'Short' },
  { dim: 'D7', band: 'indie', label: 'Independent presses' },
  { dim: 'D7', band: 'academic_press', label: 'University presses', reads: 'nonfiction' },
  { dim: 'D7', band: 'acclaimed', label: 'Books more than one critic reviewed' },
];


// Fiction readers see the fiction chips; nonfiction readers see those plus the
// subject chips, because a subject is a subject either way.
// A chip marked `fiction` is hidden from someone who reads only nonfiction, and
// the other way round. Someone who reads both sees everything.
// Asked in the order a reader thinks, which is also roughly the order the profile
// weights: what it is about first, then what kind of book, then how it reads.
// Subject carries 22 of the 100 points and used to sit fifth in the list.
//
// Grouped, and labelled in the reader's words rather than the profile's. Sixty
// chips in one undifferentiated run is a wall: nobody reads to the end of it, and
// the ones at the bottom may as well not be offered. Under a heading they are
// eight short lists, and a reader who cares about none of them can skip a whole
// group at a glance.
// How much a reader has to say before the feed is theirs.
//
// Not many. Five picks moves the median score by nearly three points and turns
// 76 recommendations into about 170, which is the difference between a feed and
// a list. Asking for more up front buys accuracy nobody stayed to give: the
// Profile screen holds the whole vocabulary for anyone who wants to sharpen it
// later, and saves keep tuning it either way.
//
// One of the five has to be something they will not read. A model with nothing
// to push against ranks everything alike, and the dislike list is the only place
// that pressure comes from at the start.
export const MIN_PICKS = 5;
export const MIN_DISLIKES = 1;

export function answersReady({ liked = [], disliked = [] } = {}) {
  const picks = liked.length + disliked.length;
  return { picks, ready: picks >= MIN_PICKS && disliked.length >= MIN_DISLIKES,
    needPicks: Math.max(0, MIN_PICKS - picks), needDislikes: Math.max(0, MIN_DISLIKES - disliked.length) };
}

export const GROUPS = [
  { dim: 'D2', label: 'What it’s about' },
  { dim: 'D3', label: 'What kind of book' },
  { dim: 'D4', label: 'How it’s written' },
  { dim: 'D5', label: 'How it feels' },
  { dim: 'D1', label: 'How it’s built' },
  { dim: 'D8', label: 'Who’s telling it' },
  { dim: 'D6', label: 'How long' },
  { dim: 'D7', label: 'Who published it' },
];

const ASK_ORDER = GROUPS.map((g) => g.dim);

export const chipsFor = (reads) => CHIPS
  .filter((c) => !c.reads || reads === 'both' || c.reads === reads)
  .slice()
  .sort((a, b) => ASK_ORDER.indexOf(a.dim) - ASK_ORDER.indexOf(b.dim));

// The same set, in the groups the builder draws. A group with nothing left in it
// after the `reads` gate is dropped rather than shown empty.
export const groupedChipsFor = (reads) => GROUPS
  .map((g) => ({ ...g, chips: chipsFor(reads).filter((c) => c.dim === g.dim) }))
  .filter((g) => g.chips.length);

// What you read at all, asked before what you like about it.
//
// Nonfiction carries a 45-point penalty in the published profile, which is one
// reader's exclusion rather than a fact about books. A nonfiction reader who is
// never asked gets a feed where every book they want is pushed 45 points down,
// and no amount of picking prose and tone repairs that. So this is the first
// question and it is the one with the largest single effect.
export const READS = [
  { id: 'fiction', label: 'Fiction', note: 'Novels and stories.' },
  { id: 'nonfiction', label: 'Nonfiction', note: 'History, science, biography, reporting, ideas.' },
  { id: 'both', label: 'Both', note: 'No strong preference.' },
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
// What a reader will not read, as against what they would rather not.
//
// Every other control here models attraction, and a weighted sum can only ever
// say "I care about this". It cannot say "I will not read a book that resolves
// into a twist, however good the rest of it is" - a low band score is
// compensatory by construction and a strength offsets it. Bouncing off a book is
// not like that, so an aversion is subtracted after the sum at full force.
//
// Deliberately a short list of legible refusals rather than the whole band
// vocabulary. Seventy-five checkboxes is not a question, and the Profile screen
// carries the full granularity for anyone who wants it.
export const REFUSALS = [
  { key: 'D1:device_twist', label: 'A twist that reframes the whole book' },
  { key: 'D1:sealed', label: 'Contemporary stories sealed in the present' },
  { key: 'D5:comic', label: 'Comic or satirical as the main mode' },
  { key: 'D4:pop_subject', label: 'Popular treatments for the general reader' },
  { key: 'D4:flat', label: 'Prose the reviewers call flat' },
  { key: 'D3:memoir', label: 'Memoir and biography' },
  { key: 'D4:dense_theory', label: 'Dense theory' },
  { key: 'D3:poetry', label: 'Poetry' },
  { key: 'D6:sprawl', label: 'Very long books' },
  { key: 'D2:media_tech', label: 'Internet and tech culture' },
];

export function buildProfile(profile, { liked = [], disliked = [], refused = [], strength = 'strong', reads = 'fiction', satire = false } = {}) {
  const nonfiction = reads === 'nonfiction' || reads === 'both';
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

  // The single largest correction available, and the only one a reader can state
  // outright rather than have inferred from what they picked.
  if (nonfiction) o.adjustments.nonfiction = false;
  // Someone who reads only nonfiction is not served by a profile that weights
  // formal ambition and prose register above what a book is actually about.
  if (reads === 'nonfiction') {
    const w = o.weights;
    const get = (id) => w[id] ?? (profile.dimensions || []).find((d) => d.id === id)?.weight ?? 0;
    w.D2 = Math.min(40, Math.round(get('D2') * 1.6));
    w.D3 = Math.max(4, Math.round(get('D3') * 0.6));
  }
  if (satire) { o.adjustments.satire = false; o.adjustments.pynchon = false; }

  // A reader who says they like a late reveal does not hold the rule that scores
  // one at 3 whatever the review earned.
  if (liked.includes('D3:device_twist')) o.rules.twist_override = false;

  // What the reader said they will not read. Strong by default: a refusal stated
  // in answer to "is there anything you simply won't read" is not a mild
  // preference, and `never` is left for the Profile screen to set deliberately.
  o.aversions = {};
  for (const key of refused) o.aversions[key] = strength;

  return o;
}
