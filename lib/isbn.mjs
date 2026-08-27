// ISBN normalising, checking and converting.
//
// Lives under web/lib because both halves of the app need it: the browser imports
// it as a module, and bin/test.mjs imports the same file. One copy, no build step.
//
// The reason this is its own module rather than three lines inside the retailer
// code: Bookshop.org will only take an ISBN-13, and roughly half the ISBNs the
// review pages print are ISBN-10s off a copyright page. Converting one to the
// other is the difference between a deep link to the book and a search box.

// Reviews print ISBNs with hyphens, catalogues without, and PW does both on the
// same page. Digits and a possible trailing X are the whole of the identity.
export function normalizeIsbn(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  // Hyphen-minus, the Unicode dashes a typesetter may substitute, and any
  // whitespace. Written as escapes because a literal dash range inside a
  // character class is too easy to misread as three separate characters.
  const cleaned = String(value).replace(/[\s\u002d\u2010-\u2015\u2212]/g, '').toUpperCase();
  return /^[0-9]{9}[0-9X]$|^[0-9]{13}$/.test(cleaned) ? cleaned : null;
}

// Sum of digit × (10 down to 1), divisible by 11. The last position may be X for 10.
export function isValidIsbn10(value) {
  const isbn = normalizeIsbn(value);
  if (!isbn || isbn.length !== 10) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(isbn[i]) * (10 - i);
  sum += isbn[9] === 'X' ? 10 : Number(isbn[9]);
  return sum % 11 === 0;
}

// Alternating weights of 1 and 3, sum divisible by 10.
export function isValidIsbn13(value) {
  const isbn = normalizeIsbn(value);
  if (!isbn || isbn.length !== 13) return false;
  let sum = 0;
  for (let i = 0; i < 13; i++) sum += Number(isbn[i]) * (i % 2 === 0 ? 1 : 3);
  return sum % 10 === 0;
}

export function isValidIsbn(value) {
  return isValidIsbn10(value) || isValidIsbn13(value);
}

// Prefix 978, drop the old check digit, recompute. Only a *valid* ISBN-10
// converts: a mistyped one would otherwise produce a well-formed ISBN-13 that
// points at a different book, which is worse than falling back to a search.
export function isbn10ToIsbn13(value) {
  if (!isValidIsbn10(value)) return null;
  const body = `978${normalizeIsbn(value).slice(0, 9)}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(body[i]) * (i % 2 === 0 ? 1 : 3);
  return `${body}${(10 - (sum % 10)) % 10}`;
}

// The best ISBN-13 obtainable from a book, whether it arrived as one or not.
export function bestIsbn13(book) {
  if (!book) return null;
  if (isValidIsbn13(book.isbn13)) return normalizeIsbn(book.isbn13);
  return isbn10ToIsbn13(book.isbn10);
}
