// A tag taxonomy for the feed.
//
// Two sources. What the publication says about the book - the section Publishers
// Weekly filed it under, the categories a feed carried - and what the scorer read out
// of the reviews, which is the band each dimension landed in. Both become the same
// kind of object so one click filters on either.

const BAND_LABELS = {
  D1: {
    dual_timeline: 'dual timeline', constraint: 'formal constraint', alt_archive: 'invented archive',
    polyphony: 'polyphonic', generational: 'generational sweep', braid: 'braided',
    aftermath: 'aftermath', comparative: 'comparative', chronicle: 'chronicle',
    texture_only: 'historical texture', device_twist: 'resolving twist', sealed: 'sealed in the present',
  },
  D2: {
    land: 'land & labour', state_violence: 'state violence', institution: 'institutional',
    art_under_state: 'art under the state', faith: 'faith', finance: 'money',
    domestic: 'domestic', media_tech: 'internet life',
    crime: 'crime & the law', migration: 'migration & exile', medicine: 'illness & care',
    ecology: 'ecology & climate', youth: 'childhood & school', sport: 'sport',
    urban: 'cities & housing', economy: 'work & the economy',
    technology_power: 'technology & power', lives: 'a life, told',
    arts: 'art & music', science: 'science',
  },
  D3: {
    novel: 'a novel', stories: 'stories', history: 'history', reportage: 'reportage',
    essays: 'essays', monograph: 'monograph', memoir: 'memoir', poetry: 'poetry',
    graphic: 'graphic work', reference: 'reference',
  },
  D4: {
    lyric_dread: 'lyric prose', baroque: 'baroque prose', spare: 'spare prose',
    functional: 'clean prose', quippy: 'comic prose', flat: 'prose panned',
    creative_nonfiction: 'creative nonfiction', academic: 'scholarly', dense_theory: 'theoretical',
    reported: 'reported', confessional: 'confessional', pop_subject: 'popular treatment', expository: 'expository',
  },
  D5: {
    dread: 'dread', harrowing: 'harrowing', grave: 'grave', elegiac: 'elegiac', indicting: 'indicting', cold: 'cold',
    warm: 'warm', comic: 'comic',
    hardboiled: 'hardboiled', gothic: 'gothic', surreal: 'surreal',
    ironic: 'ironic', propulsive: 'propulsive',
  },
  D6: {
    sprawl: 'sprawling', long_ambit: 'long', short_formal: 'short but formal',
    mid_conv: 'mid-length', short_conv: 'short',
  },
  D8: {
    multi_voice: 'many voices', character_interior: 'interior', unreliable: 'unreliable narrator',
    ensemble: 'ensemble cast', single_voice: 'one narrator', plot_driven: 'plot-driven',
  },
  D7: {
    indie: 'independent press', literary: 'literary imprint', academic_press: 'scholarly press',
    acclaimed: 'widely reviewed', trade: 'commercial imprint',
  },
};

const KIND_OF = { D1: 'period', D2: 'subject', D3: 'form', D4: 'prose', D5: 'tone', D6: 'scale', D7: 'press', D8: 'narration' };

// Section names publications actually use, mapped to something worth clicking.
const SECTION_TAGS = {
  fiction: ['Fiction', 'genre'],
  nonfiction: ['Nonfiction', 'genre'],
  'mystery-thriller': ['Mystery & thriller', 'genre'],
  'sci-fi-fantasy-horror': ['SF, fantasy & horror', 'genre'],
  'romance-erotica': ['Romance', 'genre'],
  poetry: ['Poetry', 'genre'],
  // 4Columns files novels under Literature; Bookforum's channel is Fiction or Culture.
  literature: ['Fiction', 'genre'],
  'graphic-novels': ['Comics', 'genre'],
  comics: ['Comics', 'genre'],
  childrens: ['Children’s', 'genre'],
  'inspirational-fiction': ['Inspirational fiction', 'genre'],
  religion: ['Religion', 'genre'],
  lifestyle: ['Lifestyle', 'genre'],
};

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function tagsFor(entry) {
  const out = new Map();
  const add = (label, kind) => {
    const id = `${kind}:${slug(label)}`;
    if (!out.has(id)) out.set(id, { id, label, kind });
  };

  // What the scorer read. A defaulted dimension says nothing, so it earns no tag.
  for (const [dim, d] of Object.entries(entry.score.dimensions)) {
    if (d.defaulted || !d.id) continue;
    const label = BAND_LABELS[dim]?.[d.id];
    if (label) add(label, KIND_OF[dim]);
  }

  // What the publication filed it under - but only where the label is a real genre.
  // Feed categories are mostly housekeeping ("Latest", "Reviews") or the author's own
  // name, and turning those into tags produced 283 of them, nearly all useless.
  for (const c of entry.categories || []) {
    const known = SECTION_TAGS[slug(c)];
    if (known) add(known[0], known[1]);
  }

  if (entry.book.translated) add('in translation', 'press');
  if (entry.book.publisher) add(entry.book.publisher, 'imprint');

  // Rules that fired, which are worth being able to gather in one place.
  for (const f of entry.score.filters || []) add(f.label || f.id, 'rule');
  if (entry.score.proseFloorApplied) add('below the prose floor', 'rule');
  for (const q of entry.score.openQuestions || []) add(`tests ${q.id}`, 'question');

  // How much to trust the row.
  if (entry.identity === 'unverified') add('book unverified', 'caveat');
  if (entry.fiction === 'unknown') add('fiction unverified', 'caveat');
  if (entry.score.scoredOnPartialEvidence) add('thin evidence', 'caveat');
  if (entry.inWindow === false) add('outside the window', 'caveat');
  if (entry.reviewCount > 1) add(`${entry.reviewCount} reviews`, 'attention');
  if (entry.book.readerRating) add('reader-rated', 'attention');
  // The critic consensus, as a tag you can gather on.
  const raves = /(\d+)\s+Rave/i.exec(entry.book.criticTally || '');
  if (raves && Number(raves[1]) >= 3) add('critics raving', 'attention');
  else if (entry.book.criticTally) add('critic-tallied', 'attention');

  return [...out.values()];
}

// Tag -> how many books carry it, so the UI can show a directory and drop tags that
// only ever appear once.
export function buildIndex(books) {
  const index = new Map();
  for (const b of books) {
    for (const t of b.tags || []) {
      if (!index.has(t.id)) index.set(t.id, { ...t, count: 0 });
      index.get(t.id).count++;
    }
  }
  return [...index.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}
