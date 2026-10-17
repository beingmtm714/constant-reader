// A short read on how a book sits against the profile.
//
// Built from the same dimension bands the score is built from, so the sentence and
// the number can never disagree. Nothing is generated at runtime by a model — the
// phrasing comes from profile/phrases.json and the comparison is a distance
// calculation against the twelve confirmed acquisitions. That comparison is the
// same one web/lib/taste.mjs makes against the books you have actually saved;
// both go through web/lib/vector.mjs.

import { DIMS, vectorOf, weightsFrom, nearestOf } from '../web/lib/vector.mjs';

export { vectorOf };

// Deterministic pick, so a row reads the same way on every rebuild.
function pick(list, seed) {
  if (!list?.length) return '';
  let h = 0;
  for (let i = 0; i < String(seed).length; i++) h = (h * 31 + String(seed).charCodeAt(i)) >>> 0;
  return list[h % list.length];
}

function joinClauses(parts) {
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

// The nearest confirmed acquisition. The saved-books tuner asks the same
// question of a different reference set, which is why the arithmetic moved to
// web/lib/vector.mjs rather than being written twice.
export function nearest(vector, references, profile) {
  return nearestOf(vector, references, weightsFrom(profile.dimensions));
}

export function describe(scored, book, entry, profile, phrases, references) {
  const P = phrases.bands;
  const C = phrases.connectors;
  const seed = entry.id || book.title || '';
  const dims = scored.dimensions;
  const phraseFor = (d) => P[d.dimension]?.[d.id] || '';

  const named = DIMS.map((id) => dims[id]).filter((d) => d && !d.defaulted && d.id);
  const defaulted = DIMS.filter((id) => dims[id]?.defaulted);
  const thin = defaulted.length >= 3;

  if (scored.filters.length) {
    return {
      summary: `${C.filtered} ${scored.filters.map((f) => (f.label || f.id).toLowerCase()).join('; ')}.`,
      caveats: [], strengths: [], drags: [],
    };
  }

  // Provenance is worth a clause at the end, never a headline. "A literary imprint"
  // as the only thing said about a book is noise dressed as a finding.
  const isProvenance = (d) => d.dimension === 'D7';
  const provenance = named.find((d) => isProvenance(d) && (d.id === 'indie' || d.id === 'translation'));

  const substantive = named.filter((d) => !isProvenance(d));
  const strengths = substantive.filter((d) => d.score >= 8)
    .sort((a, b) => b.score * b.weight - a.score * a.weight)
    .map(phraseFor).filter(Boolean).slice(0, 3);
  const middling = substantive.filter((d) => d.score > 4 && d.score < 8)
    .sort((a, b) => b.score * b.weight - a.score * a.weight)
    .map(phraseFor).filter(Boolean).slice(0, 2);
  const weaknesses = substantive.filter((d) => d.score <= 4)
    .sort((a, b) => (10 - b.score) * b.weight - (10 - a.score) * a.weight)
    .map(phraseFor).filter(Boolean).slice(0, 2);

  const total = scored.total;
  const tier = total >= 78 ? 'high' : total >= 70 ? 'good' : total >= 62 ? 'near' : total >= 45 ? 'some' : 'off';
  const sentences = [];
  const body = strengths.length ? strengths : middling;

  // When most of the dimensions never fired, saying so is the only honest reading.
  if (defaulted.length >= 4 || (thin && !body.length)) {
    const registered = named.map((d) => (d.name || d.dimension).toLowerCase());
    sentences.push(registered.length
      ? `Too little in this review to place the book — only ${joinClauses(registered)} registered.`
      : 'Too little in this review to place the book at all.');
    if (body.length) sentences.push(`What did: ${joinClauses(body)}.`);
  } else {
    sentences.push(pick(phrases.openers[tier], seed));
    if (body.length) {
      const clause = joinClauses(body) + (provenance ? `, ${phraseFor(provenance)}` : '');
      sentences.push(`${capitalise(clause)}.`);
    } else {
      sentences.push('The review gives too little away to say what kind of book it is.');
    }
  }

  const drags = [...weaknesses];
  for (const a of scored.adjustments || []) if (a.points < 0) drags.push(a.label.toLowerCase());
  if (scored.proseFloorApplied) drags.push('prose below the floor, which nothing else compensates for');
  if (drags.length) sentences.push(`${pick(C.against, seed)} ${joinClauses(drags.slice(0, 3))}.`);

  // An anchor drawn from a mostly-defaulted vector says more about the defaults than
  // about the book, so thin rows get none.
  if (references.length && !thin) {
    const near = nearest(vectorOf(scored), references, profile);
    if (near && near.distance < 0.32) sentences.push(`${C.anchor} ${near.title}.`);
  }

  // A score high enough to recommend, on a book nobody has named, needs saying.
  if (total >= 70 && entry.identity === 'unverified') {
    sentences.push('It scores well, but the book itself came out of loose pattern-matching on the review — worth opening the review before believing the number.');
  }

  const caveats = [];
  if (thin) caveats.push(C.thin);
  if (entry.fiction === 'unknown') caveats.push(C.unknownFiction);
  if (entry.inWindow === false) caveats.push(C.outOfWindow);

  return { summary: sentences.filter(Boolean).join(' '), caveats, strengths, drags: drags.slice(0, 3) };
}

function capitalise(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
