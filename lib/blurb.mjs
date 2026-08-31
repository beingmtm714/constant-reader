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

// The page a standfirst arrived on, still attached to the front of it.
//
// Two publications syndicate their CMS chrome inside the description field, and
// it reads as the app's own account of the book. World Literature Today ships a
// section label, the reviewer's address, a publication timestamp and the whole
// bibliographic block before the first real sentence: "FICTION [email removed]
// Mon, 08/24/2026 - 15:42 Author: Morgan Day Astra House. 2026. 192 pages. If
// ever there were a phrase I wouldn't have expected..." Ancillary Review leads
// with the reviewer's name and an "Under Review:" heading carrying the citation.
//
// Each pattern is anchored to the start and each stops at the point the prose
// begins, so a review that happens to discuss a page count keeps its sentence.
const HEAD_FURNITURE = [
  // WLT: everything from the section label to the last element of the citation.
  // The block always ends in "N pages." or a bare year, and the review follows.
  /^(?:FICTION|NONFICTION|VERSE|POETRY|DRAMA|REVIEWS?)\b[\s\S]{0,400}?\b\d{1,4}\s+pages?\.\s+(?=[A-Z“"'])/,
  /^(?:FICTION|NONFICTION|VERSE|POETRY|DRAMA|REVIEWS?)\b[\s\S]{0,400}?\b(?:19|20)\d\d\.\s+(?=[A-Z“"'])/,
  // Ancillary: "Matthew Eatough Under Review: <citation>. <review>"
  /^[\s\S]{0,60}?\bUnder Review:[\s\S]{0,300}?(?:Press|Books|Publishing|House|Editions)[^.]{0,40}\.\s+(?=[A-Z“"'])/i,
  /^[\s\S]{0,60}?\bUnder Review:[\s\S]{0,300}?\b(?:19|20)\d\d\.\s+(?=[A-Z“"'])/i,
  // Anything still carrying a redacted address is a form, not a sentence.
  /^[\s\S]{0,300}?\[email removed\]\s*(?:[\s\S]{0,300}?\b\d{1,4}\s+pages?\.)?\s*/,
];

const norm = (s) => String(s || '')
  .replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"')
  .replace(/[\u2013\u2014]/g, '-').replace(/\s+/g, ' ').trim();

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// "(Oxford University Press, 2025)", optionally followed by "by Stefan Collini".
const CITE = /^\s*\((?:[^()]{2,90}?),\s*((?:19|20)\d\d)\)\s*/;

// Where a scraped review body stops being the review.
//
// The body is the best text this pipeline has - Publishers Weekly runs to 2,800
// characters where its standfirst is 128 - and it arrives with the page around
// it still attached. PW ends every review with its own furniture and then, worse,
// with the opening lines of its reviews of the author's other books: "Agent:
// Chris Parris-Lamb, Gernert Co. (Oct.) DETAILS share BUY THIS BOOK close
// Details Reviewed on: 08/25/2026 Genre: Fiction Amazon Apple Books Bookshop
// Share Post Copy Link Print More By and About this Author chevron_right Book
// Reviews Articles The Art of Fielding..." - which scores this book on a
// different book's review.
//
// Cut at the earliest marker rather than trying to match the whole tail: which
// widgets a page carries varies, and the first one is always past the prose.
const BODY_ENDS = [
  /\s+DETAILS\s+share\s+BUY THIS BOOK/i,
  /\s+Agent:\s+\S/,
  /\s+Reviewed on:\s+\d/i,
  /\s+(?:By and About this Author|chevron_right|Print More\b)/i,
  /\s+Support (?:our show|this podcast)\b/i,
  /\s+Learn more about your ad choices/i,
  /\s+This episode featured a conversation with/i,
  // The host's own bio and sign-off, which every New Books Network note carries:
  // "...conducted by Dr. Miranda Melcher whose book focuses on post-conflict
  // military integration... You can find Miranda's interviews on New Books with
  // Miranda Melcher, wherever you get your podcasts." Ninety of them survived the
  // first pass of markers, each ending in a paragraph about the interviewer
  // rather than about the book.
  /\s+(?:This interview was )?conducted by (?:Dr\.?|Professor)\s/i,
  /\s+You can find [A-Z][a-z]+(?:'s|’s)? interviews\b/i,
  /\s+wherever you (?:get|find) (?:your|us)\b/i,
  // And the reviews site asking to be shared, which is not about the book either.
  /\s+(?:It seems small|Leave a comment or review|like and share our)/i,
  /\s+if you buy them through our\b/i,
  /\s+(?:check|see) the show notes\b/i,
  /\s+(?:can be found|found) on (?:Twitter|Bluesky|Instagram|Substack|Facebook)\b/i,
];

export function trimBody(raw) {
  let text = String(raw || '');
  let cut = text.length;
  for (const re of BODY_ENDS) {
    const m = text.match(re);
    if (m && m.index != null && m.index < cut) cut = m.index;
  }
  // A marker inside the first hundred characters is a false positive, not a tail.
  return (cut > 100 ? text.slice(0, cut) : text).trim();
}

export function cleanBlurb(raw, { title = '', author = '' } = {}) {
  let text = norm(raw);
  if (!text) return '';

  for (const re of TAIL_JUNK) text = text.replace(re, '').trim();
  text = text.replace(SIGNOFF, '').trim();

  // The furniture comes off the front only when a real sentence is left behind.
  // A note that is nothing but its own masthead is better handled by the caller,
  // which has a publisher's description to fall back on.
  for (const re of HEAD_FURNITURE) {
    if (!re.test(text)) continue;
    const cut = text.replace(re, '').trim();
    // Only when a real sentence is left behind. A note that is nothing but its
    // own masthead is better handled by the caller, which has a publisher's
    // description to fall back on.
    if (cut.length >= 60) { text = cut; break; }
  }

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

// Which of the texts on a record actually describes the book.
//
// The row used to print the first mention's standfirst and nothing else, which
// meant two failures at once. Where a publication syndicates its own page
// furniture the row printed the page. And 588 of 823 books carry a publisher's
// description that was never displayed at all — so a book whose only standfirst
// was a masthead showed "The reviews of it are indexed here without a summary"
// with a perfectly good paragraph sitting unused beside it.
//
// The critic still wins where the critic wrote a sentence. Publisher copy is
// written to sell and it reads like it; it is the fallback, not the preference,
// and it stays out of scoring entirely — `lib/score.mjs` never sees it, which is
// the distinction that matters. What is on offer here is a row that says what
// the book is instead of a row that says nothing.
const USABLE = 60;

// Still a form rather than a sentence, after cleaning had its turn.
const STILL_FURNITURE = [
  /\[email removed\]/i,
  /\b(?:Mon|Tue|Wed|Thu|Wed|Thu|Fri|Sat|Sun),\s+\d{2}\/\d{2}\/\d{4}/i,
  /^\s*(?:FICTION|NONFICTION|VERSE|POETRY|DRAMA|REVIEWS?)\b\s+\S/,
  /\bUnder Review:/i,
  /^\s*Author:\s/i,
  /^\s*From Other Press\b/i,
  // Book Marks' standfirst is its critic tally — "Critics: 11 Rave, 1 Mixed, 1
  // Pan." That is a real fact and the app already carries it as `criticTally`
  // and as a "critics raving" tag. It is not a description of the book.
  /^\s*Critics:\s*\d+\s+(?:Rave|Positive|Mixed|Pan)/i,
];

export function isUsableBlurb(text) {
  const t = norm(text);
  if (t.length < USABLE) return false;
  return !STILL_FURNITURE.some((re) => re.test(t.slice(0, 220)));
}

export function bestBlurb(entry, { max = 320 } = {}) {
  const title = entry?.book?.title || '';
  const author = entry?.book?.author || '';
  const cut = (t) => (t.length <= max ? t : `${t.slice(0, max).replace(/\s+\S*$/, '')}…`);

  const critics = (entry?.mentions || [])
    .map((m) => cleanBlurb(m?.standfirst || m?.excerpt || '', { title, author }))
    .filter(isUsableBlurb);
  if (critics.length) return { text: cut(critics[0]), from: 'review' };

  const listed = cleanBlurb(entry?.book?.description || '', { title, author });
  if (isUsableBlurb(listed)) return { text: cut(listed), from: 'publisher' };

  // Nothing long enough to be usable. A short critic line still beats silence and
  // is offered before giving up — but a line that is furniture is not, however
  // little else there is. "Critics: 11 Rave, 1 Mixed, 1 Pan." is a real fact the
  // app already carries as a tag; printed where the description goes it is a row
  // that has not read the book, dressed as a row that has.
  const anyCritic = (entry?.mentions || [])
    .map((m) => cleanBlurb(m?.standfirst || m?.excerpt || '', { title, author }))
    .find((t) => t.length > 0 && !STILL_FURNITURE.some((re) => re.test(t.slice(0, 220))));
  if (anyCritic) return { text: cut(anyCritic), from: 'review' };
  return { text: '', from: 'none' };
}
