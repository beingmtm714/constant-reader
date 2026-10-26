// Asking a cover host for the size the page is actually going to draw.
//
// Both catalogues serve a thumbnail by default and both will serve something
// larger if asked. Neither was being asked. Google Books' `zoom=1` is 128px wide
// and the archive card draws its jacket at 222 CSS pixels on a desktop, which on
// a retina screen is 444 device pixels — a 3.5× upscale, and the reason every
// cover in the app looked soft.
//
// The first fix asked for a fixed width per slot and offered it at 1x and 2x.
// That was still wrong, and wrong in the way that mattered most, because a slot
// is not one width. The same card is 222px on a desktop shelf and 317px on a
// 375px phone — nearer 340 on a current one — and a phone draws three device
// pixels to the point. So a card that looked sharp on a laptop was being handed
// 460 pixels for a slot a thousand pixels wide, and still looked soft.
//
// So the width is not chosen here at all. Each slot declares a ladder of real
// files and a `sizes` rule saying how wide it will be at any viewport, and the
// browser picks — it is the only part of this that knows the layout, the screen
// density and the connection at the same time.
//
// This runs at render time rather than in the build, for two reasons. It fixes
// every cover already in the feed with no re-crawl. And the right width is a fact
// about where the image is being drawn, which the build cannot know.

// What each slot is, measured off the rendered page rather than guessed.
//
// `sizes` is a CSS expression and has to track the stylesheet. The card is one
// column inside the pane's padding on a phone and a fixed 222px column on the
// desktop shelf; the spotlight and the row are fixed at every width. The top of
// each ladder is what a phone at three device pixels to the point will ask for.
// `needs` is the narrowest file that can fill the slot without being stretched:
// the slot's widest CSS width at two device pixels to the point. Two rather than
// three on purpose — a phone draws three, but holding every cover to 1000px
// would throw away most of the archive's jackets to avoid a softness only
// visible beside a sharper one.
export const SLOTS = {
  row: {
    sizes: '60px',
    ladder: [120, 200, 300],
    needs: 120,
  },
  card: {
    sizes: '(max-width: 767px) calc(100vw - 58px), 222px',
    ladder: [240, 360, 480, 720, 1000],
    needs: 680,
  },
  spotlight: {
    sizes: '168px',
    ladder: [180, 360, 540],
    needs: 340,
  },
  dossier: {
    sizes: '(max-width: 767px) 120px, 108px',
    ladder: [140, 280, 420],
    needs: 260,
  },
};

// Can this jacket fill this slot, or would it be stretched across it?
//
// The measured width travels with the cover, so this is a comparison rather
// than a guess. A book whose jacket cannot fill the slot is better drawn: the
// typographic jacket is sharp at every size and was designed to be the majority
// face of the screen, and a stretched photograph in a cover slot is the one
// thing in this app that reads as broken rather than as absent.
//
// An unmeasured cover is assumed to be fine. The alternative is discarding real
// jackets over a fact nobody has established, which is the same mistake as
// scoring a book on defaults.
export function fillsSlot(width, slotName = 'card') {
  const slot = SLOTS[slotName] || SLOTS.card;
  if (width == null) return true;
  return width >= slot.needs;
}

const isGoogle = (u) => u.includes('books.google.com') || u.includes('books.googleusercontent.com');
const isOpenLibrary = (u) => u.includes('covers.openlibrary.org');

// Google Books. `zoom` is a coarse ladder — 1 is 128px, 2 is 300, 0 and 3 are
// 575 — and `w` overrides it with an exact width, up to at least 1600. `edge` is
// Google's page-curl decoration, which would be a picture of a paper effect
// rather than the jacket, so it comes off if a feed ever carries one.
function google(url, width) {
  try {
    const u = new URL(url);
    u.searchParams.set('w', String(Math.round(width)));
    u.searchParams.delete('edge');
    // A http URL on a https page is blocked outright, and Google serves both.
    u.protocol = 'https:';
    return u.toString();
  } catch { return url; }
}

// Open Library serves three fixed files off one id and nothing between them, so
// this is a choice rather than a resize. S is never chosen: it is about 45px
// wide, narrower than the smallest slot here before a retina screen doubles it.
const olSize = (url, size) => url.replace(/-(S|M|L)\.(jpg|png)$/i, `-${size}.$2`);

export function coverUrl(raw, width = 480) {
  const url = String(raw || '');
  if (!url) return '';
  if (isGoogle(url)) return google(url, width);
  if (isOpenLibrary(url)) return olSize(url, width > 200 ? 'L' : 'M');
  return url;
}

// Everything an `<img>` needs for one slot.
//
// Width descriptors rather than `1x, 2x`. A density descriptor describes the
// screen and says nothing about the layout, and the layout is what changed
// between the desktop shelf and the phone. With `w` and `sizes` the browser
// resolves both at once, and it will also step down on a slow connection, which
// a fixed pair of URLs cannot.
export function coverFor(raw, slotName = 'card') {
  const url = String(raw || '');
  const slot = SLOTS[slotName] || SLOTS.card;
  if (!url) return null;

  if (isGoogle(url)) {
    const widest = slot.ladder[slot.ladder.length - 1];
    return {
      // The fallback for a browser that ignores srcset. Second rung rather than
      // the widest, so an old browser is not handed a megabyte a card.
      src: google(url, slot.ladder[1] || widest),
      srcset: slot.ladder.map((w) => `${google(url, w)} ${w}w`).join(', '),
      sizes: slot.sizes,
      width: widest,
    };
  }

  if (isOpenLibrary(url)) {
    // Two usable files, and their real widths vary book to book — L is 328px on
    // one and larger on others. No width descriptor is claimed for that reason:
    // a `w` this cannot verify would have the browser skip a file it should take.
    // A card on a phone gets an upscale from this host whatever is asked, and no
    // srcset invents detail that was never served.
    return { src: olSize(url, slotName === 'row' ? 'M' : 'L'), srcset: '', sizes: '', width: 0 };
  }

  return { src: url, srcset: '', sizes: '', width: 0 };
}
