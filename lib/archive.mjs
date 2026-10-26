// Where each publication keeps its back issues, and how to read the index.
//
// A syndication feed answers "what is new". None of these does. They are the
// indexes a publication keeps for its own readers — a sitemap, a table of back
// issues, a paginated archive — and each one needs its own reading, which is why
// this is a table of small functions rather than a config block.
//
// Two rules hold across all of them.
//
// **Discovery finds addresses and nothing else.** No article is fetched here and
// no book is extracted. That happens later, in the build, through the same
// `extractBook` every live review goes through. A crawler that also parsed would
// be a second pipeline, and the second pipeline is always the one nobody notices
// has drifted.
//
// **A slice is a unit of work small enough to abandon.** One month of a sitemap,
// one issue of a paper, one page of a listing. The 06:20 job runs a handful and
// stops, so nothing here may assume it gets to finish.

const clean = (s) => String(s || '')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
  .replace(/&(amp|lt|gt|quot|#39|apos|nbsp|rsquo|lsquo|ldquo|rdquo);/g,
    (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”' }[e]))
  .replace(/\s+/g, ' ')
  .trim();

// A slug is the only title a sitemap gives, and it is a poor one — but the build
// fetches the article anyway, and its own extractor reads the real headline off
// the page. This exists so `filterItems` has a string to test against the
// exclusion list before anything is fetched, which is where the saving is.
function titleFromSlug(slug) {
  return clean(String(slug || '').replace(/\.html?$/, '').replace(/[-_]+/g, ' '))
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

const months = (cutoff) => {
  const out = [];
  const now = new Date();
  for (let y = now.getFullYear(); y >= cutoff; y--) {
    for (let m = 12; m >= 1; m--) {
      if (y === now.getFullYear() && m > now.getMonth() + 1) continue;
      out.push({ year: y, month: m, label: `${y}-${String(m).padStart(2, '0')}` });
    }
  }
  return out;
};

export const ARCHIVES = [
  {
    id: 'nyt-archive',
    short: 'NYT back',
    // Discovery works and is kept; the source is off. The sitemaps are exactly
    // what you would want — sitemap-2019-06.xml.gz lists 102 book reviews, and
    // five years of them would be the largest thing this crawl reaches — but the
    // article pages answer 403 to any crawler, including the build's own client.
    // That leaves the URL slug as the only metadata, and the NYT title pattern
    // reads the headline's quotes and its "by", neither of which a slug has. A
    // build over 39 of them resolved nothing. Reachable addresses without
    // reachable pages is not a source. One line to re-enable if they ever open.
    enabled: false,
    disabledReason: 'the article pages 403, so a slug is all there is to extract from',
    slices: months,
    url: (s) => `https://www.nytimes.com/sitemaps/new/sitemap-${s.year}-${String(s.month).padStart(2, '0')}.xml.gz`,
    parse(body, slice) {
      const out = [];
      const re = /https:\/\/www\.nytimes\.com\/(\d{4})\/(\d{2})\/(\d{2})\/books\/review\/([a-z0-9-]+)\.html/g;
      for (const m of body.matchAll(re)) {
        out.push({
          url: m[0],
          reviewTitle: titleFromSlug(m[4]),
          reviewDate: `${m[1]}-${m[2]}-${m[3]}T12:00:00.000Z`,
          slice: slice.label,
        });
      }
      return out;
    },
  },
  {
    id: 'lrb-archive',
    short: 'LRB back',
    // The paper is numbered rather than dated, and the issue page lists its own
    // contents; the live LRB source already knows how to read an article page.
    // Volume 43 opened on 7 January 2021 and volume 48 on 22 January 2026, so the
    // volume is the year less 1978. Issues run ascending inside a volume because
    // the current one is only part-published: starting at n24 and counting down
    // spent the first slice of every run on a 404.
    slices(cutoff) {
      const out = [];
      const now = new Date().getFullYear();
      for (let y = now; y >= cutoff; y--) {
        const vol = y - 1978;
        if (vol < 1) continue;
        for (let n = 1; n <= 24; n++) out.push({ vol, n, label: `v${vol}/n${String(n).padStart(2, '0')}` });
      }
      return out;
    },
    url: (s) => `https://www.lrb.co.uk/the-paper/v${s.vol}/n${String(s.n).padStart(2, '0')}`,
    parse(body, slice) {
      const out = [];
      const seen = new Set();
      for (const m of body.matchAll(/href="(\/the-paper\/v\d+\/n\d+\/[a-z0-9-]+\/[a-z0-9-]+)"/g)) {
        const url = `https://www.lrb.co.uk${m[1]}`;
        if (seen.has(url)) continue;
        seen.add(url);
        out.push({ url, reviewTitle: titleFromSlug(m[1].split('/').pop()), reviewDate: null, slice: slice.label });
      }
      return out;
    },
  },
  {
    id: 'larb-archive',
    short: 'LARB back',
    // The live source reads three pages of the same Next.js payload. This reads
    // the rest, and gives up when the archive runs out under it: past the last
    // real page every request costs a fetch and returns nothing, which over a
    // fortnight of mornings is a couple of hundred wasted requests.
    exhaustedOnEmpty: 2,
    slices() {
      const out = [];
      for (let p = 4; p <= 200; p++) out.push({ page: p, label: `page ${p}` });
      return out;
    },
    url: (s) => `https://lareviewofbooks.org/reviews/?page=${s.page}`,
    parse(body, slice) {
      const m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(body);
      if (!m) return [];
      let docs = [];
      try { docs = JSON.parse(m[1])?.props?.pageProps?.articles?.docs || []; } catch { return []; }
      return docs.filter((d) => d.slug).map((d) => ({
        url: `https://lareviewofbooks.org/article/${d.slug}/`,
        reviewTitle: clean(d.title) || titleFromSlug(d.slug),
        reviewDate: d.publish_date || null,
        slice: slice.label,
      }));
    },
  },
  {
    id: '4columns-archive',
    short: '4Columns back',
    // The whole run is one server-rendered table, so there is exactly one slice
    // and it is done in a single request. The live source caps itself at 30 rows
    // because it only wants what is new; this takes the rest.
    slices: () => [{ label: 'the whole run' }],
    url: () => 'https://4columns.org/archive',
    parse(body, slice) {
      const out = [];
      const seen = new Set();
      const BOOKISH = /literature|nonfiction|non-fiction|poetry|graphic/i;
      const ROW = /<a[^>]+href="(\/[a-z-]+\/[a-z0-9-]+)"[^>]*>([\s\S]{0,400}?)<\/a>/g;
      for (const m of body.matchAll(ROW)) {
        const url = `https://4columns.org${m[1]}`;
        if (seen.has(url)) continue;
        const row = clean(m[2]);
        if (!BOOKISH.test(m[1]) && !BOOKISH.test(row)) continue;
        const d = /(\d{2})\.(\d{2})\.(\d{2})/.exec(row);
        seen.add(url);
        out.push({
          url,
          reviewTitle: row.replace(/\d{2}\.\d{2}\.\d{2}/, '').trim() || titleFromSlug(m[1].split('/').pop()),
          reviewDate: d ? `20${d[3]}-${d[1]}-${d[2]}T12:00:00.000Z` : null,
          slice: slice.label,
        });
      }
      return out;
    },
  },
];

// One slice, fetched and read. Returns the addresses it found and nothing more.
export async function discover(archive, slice, http) {
  const res = await http.get(archive.url(slice));
  if (!res.ok) throw new Error(res.error || `HTTP ${res.status}`);
  return archive.parse(res.body, slice).filter((x) => x.url);
}
