// Asking a cover host for the size the page is actually going to draw.
//
// Both catalogues serve a thumbnail by default and both will serve something
// larger if asked. Neither was being asked. Google Books' `zoom=1` is 128×193
// and the archive card draws its jacket at 222×332 CSS pixels, which on a
// retina screen is 444×664 device pixels — a 3.5× upscale, and the reason every
// cover in the app looked soft. Open Library's `-M` is 180px wide into the same
// slot.
//
// This rewrites the URL at render time rather than at build time, for two
// reasons. It fixes all 640 covers already in the feed without a re-crawl. And
// the right width is a fact about where the image is being drawn — a 52px row
// and a 222px card want different files off the same URL — which the build
// cannot know and the renderer always does.
//
// Widths are CSS pixels, measured off the rendered page rather than guessed.
// `coverSrcSet` asks for each one twice over so a retina screen gets the file it
// needs and a plain one does not pay for it.
export const WIDTHS = {
  row: 60,         // 52px in the feed and the search results
  card: 230,       // 222px on the archive shelf, the widest slot here
  spotlight: 170,  // 168px on the For you hero
  dossier: 130,    // 108px beside the dossier title
};

export function coverUrl(raw, width = WIDTHS.card) {
  const url = String(raw || '');
  if (!url) return '';

  // Google Books. `zoom` is a coarse ladder — 1 is 128px, 2 is 300, 0 and 3 are
  // 575 — and `w` overrides it with an exact pixel width, so `w` is what gets
  // set. `edge=curl` is Google's page-curl decoration and would be a picture of
  // a paper effect rather than the jacket; it is stripped if a feed ever carries
  // one.
  if (url.includes('books.google.com') || url.includes('books.googleusercontent.com')) {
    try {
      const u = new URL(url);
      u.searchParams.set('w', String(Math.round(width)));
      u.searchParams.delete('edge');
      // http URLs on a https page are blocked outright, and Google serves both.
      u.protocol = 'https:';
      return u.toString();
    } catch { return url; }
  }

  // Open Library serves three fixed files off the same id, so this is a choice
  // rather than a resize. S is never chosen: it is about 45px wide, narrower
  // than the smallest slot in this app even before a retina screen doubles it.
  if (url.includes('covers.openlibrary.org')) {
    const size = width > 200 ? 'L' : 'M';
    return url.replace(/-(S|M|L)\.(jpg|png)$/i, `-${size}.$2`);
  }

  return url;
}

// The `srcset` for one slot: the slot's width, and twice it for a screen that can
// show twice it. Returns '' when the host has only one file to give, because a
// srcset offering the same URL at two densities is a lie the browser acts on.
export function coverSrcSet(raw, width = WIDTHS.card) {
  const one = coverUrl(raw, width);
  const two = coverUrl(raw, width * 2);
  if (!one || one === two) return '';
  return `${one} 1x, ${two} 2x`;
}
