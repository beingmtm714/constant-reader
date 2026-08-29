// Cleaning up the sentence a row shows about a book.
//
// The description is the publication's own standfirst, never a model's — that is
// deliberate and it stays. But a standfirst arrives shaped for the feed it came
// from, and the New Books Network's shape reads badly in a row that has already
// printed the title, the author and the publisher. It is a third of this archive,
// so its shape is worth handling.
//
// NBN episode notes open by restating the citation, and they do it in two grammars
// that have to be told apart:
//
//   "Literature and Learning: A History … (Oxford University Press, 2025) by
//    Stefan Collini The study and teaching of English literature is generally…"
//
//   "Unwelcome Shores: Black Refugees in America (Rutgers University Press, 2025)
//    is an ethnographic study of the Liberian refugee community…"
//
// In the first the citation is a heading and a new sentence follows it. In the
// second **the citation is the grammatical subject of the sentence**, and cutting
// it leaves "Liberian refugee community in Staten Island…" — a fragment that says
// less than the redundancy did. The first draft of this file cut both and produced
// exactly that, which is why the rule below is written around the difference.
//
// So: the title is only removed when a capitalised word follows, meaning a real
// sentence starts there. When lowercase follows, the title is doing grammatical
// work and only the parenthesis comes out, leaving "Unwelcome Shores: Black
// Refugees in America is an ethnographic study of…".
//
// Nothing is rewritten. Every word that survives was written by the publication.
// Pure — text in, text out.

const TAIL_JUNK = [
  /\s*Learn more about your ad choices\.?\s*Visit\s+\S+\s*$/i,
  /\s*Support (?:this podcast|our show)\b[\s\S]*$/i,
  /\s*(?:Become a supporter|Sign up) (?:of|for) this podcast\b[\s\S]*$/i,
  /\s*Hosted on Acast\b[\s\S]*$/i,
  /\s*See\s+\S*acast\.com\S*\s+for (?:more information|privacy)[\s\S]*$/i,
  /\s*Advertising Inquiries:[\s\S]*$/i,
  /\s*Privacy (?:&|and) Opt-Out:[\s\S]*$/i,
];

// The interviewer signing off, cut only from the last sentence so a book about
// doctoral study keeps its own sentences.
const SIGNOFF = /(?:^|(?<=[.!?]\s))[^.!?]{0,140}?\b(?:PhD candidate|doctoral (?:candidate|student|researcher)|postdoctoral (?:fellow|researcher)|hosts? the [^.!?]{0,40}podcast|is the host of)\b[^.!?]*[.!?]\s*$/i;

// A handful of NBN notes describe the episode before they describe the book:
// "In this episode of the Language on the Move Podcast, Ingrid Piller speaks with
// Yaron Matras about his new book Speech and the City…". Twelve of 383, and every
// one of them spends its opening sentence on who was interviewing whom. The
// sentence is dropped only when a real one follows it, because a note that is
// nothing but episode framing still says more than an empty row does.
const EPISODE_OPENER = /^(?:In (?:this|today's)[^.]{0,120}?episode\b[^.]*\.|[^.]{0,140}?\bhosts?\b[^.]{0,90}?\b(?:speaks|talks|chats|sits down)\s+with\b[^.]*\.|Today,?\s+I\s+(?:talked|spoke)\b[^.]*\.)\s*/i;

const norm = (s) => String(s || '')
  .replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"')
  .replace(/[\u2013\u2014]/g, '-').replace(/\s+/g, ' ').trim();

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// "(Oxford University Press, 2025)", optionally followed by "by Stefan Collini".
const CITE = /^\s*\((?:[^()]{2,90}?),\s*((?:19|20)\d\d)\)\s*/;

export function cleanBlurb(raw, { title = '', author = '' } = {}) {
  let text = norm(raw);
  if (!text) return '';

  for (const re of TAIL_JUNK) text = text.replace(re, '').trim();
  text = text.replace(SIGNOFF, '').trim();

  const afterOpener = text.replace(EPISODE_OPENER, '').trim();
  if (afterOpener.length >= 80) text = afterOpener;

  const t = norm(title);
  if (!t || t.length < 4) return text;

  // Does it open with this book's own title?
  const lead = new RegExp(`^${escapeRe(t)}`, 'i');
  if (!lead.test(norm(text))) return text;

  let rest = text.slice(t.length).replace(/^[\s:\u2014\u2013-]+/, '');
  const cite = rest.match(CITE);
  const afterCite = cite ? rest.slice(cite[0].length) : rest;

  // "by Stefan Collini" — matched against the author we already resolved rather
  // than guessed at, because "by Stefan Collini The study" gives a regex no way to
  // know where the name stops. The first draft kept "Collini" as the first word of
  // the description.
  let afterAuthor = afterCite;
  const a = norm(author);
  if (a) {
    const byAuthor = new RegExp(`^\\s*by\\s+${escapeRe(a)}\\s*[.,:\u2014-]?\\s*`, 'i');
    afterAuthor = afterCite.replace(byAuthor, '');
  }

  // A capital or an opening quote means a new sentence begins here, so the title
  // was a heading and can go. Anything else and the title was the subject.
  const startsNewSentence = /^["'“(]?[A-Z0-9]/.test(afterAuthor);

  if (startsNewSentence && afterAuthor.length >= 60) return afterAuthor.trim();

  // The title is carrying the sentence. Drop only the parenthesis, which is the
  // part the row's own metadata line already prints.
  if (cite) {
    const kept = `${text.slice(0, t.length)} ${afterCite}`.replace(/\s+/g, ' ').trim();
    if (kept.length >= 60) return kept;
  }
  return text;
}
