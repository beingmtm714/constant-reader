# Constant Reader — engineering handoff

Written 2026-08-30 for an engineer picking this up cold. It covers what the code is, how it fits together, why each significant decision was made, what is safe to change, and what is not. Read this alongside `README.md` (what the app does, in the product's own voice), `DESIGN.md` (the visual and interaction contract) and `.github/workflows/` (the deploy and the scheduled jobs). Where those and this disagree, this one was written last and says so explicitly in **Documentation drift** below.

---

## 1. Orientation

**What it is.** A feed of every book the literary press reviewed in the last ten years, each scored out of ten against a written reading-taste profile. Named for Dorothy Parker's *New Yorker* byline. It was called Ruskin until 2026-08-28 and lit-feed before that.

**Live at** https://www.constantreader.app — a Namecheap domain pointed at GitHub Pages, with a Let's Encrypt certificate GitHub issues and renews. `https://beingmtm714.github.io/constant-reader/` still answers and 301s to it. The older `/ruskin` URL is dead and does not redirect, because GitHub forwards a renamed repository for git operations and not its Pages site.

`.app` is HSTS-preloaded by Google, so there is no http:// version of this site at any point: a browser upgrades the request before it is made.

**One repository.** Source, crawler, tests and the deploy all live in `beingmtm714/constant-reader`. The static site is assembled from `web/` into `site/` by `npm run site` and deployed by a GitHub Pages Actions workflow; nothing outside `web/` is ever served.

**No dependencies and no build step.** Node ≥ 18, `type: module`, zero entries in `package.json` beyond scripts. Every parser, the HTTP cache, the RSS reader and the test harness are hand-written. That is deliberate: this is a private instrument maintained by one person, and a dependency tree is a maintenance surface that has to earn its place. Nothing in it has yet.

**Shape of the system.** A Node crawler and scorer writes one JSON file. A static browser app reads that file and nothing else. There is no database in the request path. The browser makes two kinds of network call after loading the page: optional Firebase sign-in, whose SDK is not fetched until a reader taps *Sign in*, and Search's meaning pass, which posts the question to the Ask worker (`worker/`, a Cloudflare Worker that holds the Anthropic key and nothing else). Search works without the worker, on keywords alone; `web/lib/ask.mjs` explains the two calls it makes and why the catalogue never leaves the browser.

```
sources.json ──▶ lib/sources.mjs ──▶ lib/books.mjs ──▶ lib/aggregate.mjs ──▶ lib/score.mjs ──▶ web/data/feed.json ──▶ web/app.js
   registry        fetch + extract      resolve            group by book         score              the payload            the browser
                                        (Open Library,     (one row per book)   (profile/*.json)
                                         Google Books)
```

---

## 2. Running it

```bash
npm run check        # tests + calibration; no network, run this first
npm run build        # crawl, resolve, score, write web/data/feed.json  (5–10 min warm cache)
npm start            # serve web/ at http://localhost:4123
```

| Script | What it does |
|---|---|
| `npm run build` | Full pipeline. Writes `data/store.json` (the archive) and `web/data/feed.json` (the payload). |
| `npm run build:fresh` | Same, ignoring the 12-hour HTTP cache. |
| `npm test` | 184 unit tests over the pure modules. No network. |
| `npm run calibrate` | Scores the 24 calibration fixtures plus 12 rule tests against the profile. No network. |
| `npm run calibrate:verbose` | Same, printing every dimension, its evidence and every adjustment. |
| `npm run check` | `test` then `calibrate`. This is the pre-commit gate. |
| `npm run sources` | Probes all 88 sources, enabled or not, and diagnoses each failure. Network. For an archive source it reports the backlog instead, because there is no URL to probe. |
| `npm run archive` | Twelve slices of back-issue discovery, then stops. Writes addresses to `data/archive/`, fetches no review. Network. |
| `npm run archive:status` | What has been discovered, what the build has taken, what is left. No network. |
| `npm run sources:fix` | Same, and flips anything that now works to `enabled` in `sources.json`. |
| `npm run tune` | Reads an exported verdicts file, proposes weight changes, shows what they break. **Writes nothing.** |
| `npm run site` | Assembles `web/` into `site/`, scans it, stamps asset URLs. Guarded — see §8. The Pages workflow deploys `site/`. |

**Undocumented build flags**, all on `bin/build.mjs`: `--source=nyrb` builds one publication, `--no-articles` skips every per-review page fetch (feeds only, much faster, much worse extraction), `--no-google` and `--no-ratings` skip those lookups. Useful when iterating on a single parser.

**`bin/fixture.mjs`** writes a 24-book `web/data/feed.json` from the calibration set so the UI can be worked on with no crawl at all. Real scorer, real tags, real reading. Not wired to an npm script; run it directly with `node bin/fixture.mjs`.

**What a fresh clone needs.** `.cache/`, `data/` and `web/data/` are gitignored, so a clone has no feed until `npm run build` runs; the app says so on screen if you forget. `google-books.key` is also gitignored and absent from a clone — the build runs without it and prints a red warning line, and every Google Books request will 429. See §8 for where the real key lives.

---

## 3. Repository layout

### `bin/` — entry points

| File | Purpose |
|---|---|
| `build.mjs` | The orchestrator. Fetch → extract → resolve → group → score → write. Also holds the two publication gates and the redaction rules. |
| `calibrate.mjs` | Runs `profile/calibration.json` and `profile/rule-tests.json` through the scorer and enforces the profile's own tolerance. |
| `test.mjs` | 156 unit tests in 24 groups. Hand-rolled harness: `describe`/`it`/`eq`/`ok`, one line per case, exit 1 on failure. |
| `site.mjs` | Copies `web/` into `site/` behind a secret scan and stamps asset URLs. Deploying is the Pages workflow's job. |
| `serve.mjs` | Static server for `web/`. Exists because `fetch()` will not read `file://`. Refuses any path above `web/`. |
| `check-sources.mjs` | Network probe of every source with a diagnosis per failure kind. |
| `tune.mjs` | Turns exported verdicts into a proposed weight change and shows the calibration damage. Read-only by design. |
| `fixture.mjs` | Synthetic feed for UI work. |

### `lib/` — the Node-side pipeline

| File | Purpose |
|---|---|
| `sources.mjs` | 1,242 lines and the hard half of the system. Per-publication listing fetchers and per-publication book extractors, plus the generic prose fallback and its guards. |
| `books.mjs` | Open Library and Google Books resolution, the match-confidence rules, and `merge()` — which decides what the row's metadata actually is and whether the title is corroborated as a book at all. |
| `aggregate.mjs` | Groups mentions into books, ranks mentions so the best-furnished one supplies metadata, and pools the critical text for one scoring pass. |
| `score.mjs` | The scorer. Band selection per dimension, the three non-linear rules, filters, penalties, bonuses, open-question tagging, fiction status. |
| `tags.mjs` | Turns a scored entry into the tag taxonomy the UI filters on, and builds the tag index. |
| `describe.mjs` | The short read on each book, assembled from `profile/phrases.json` and a nearest-neighbour against the twelve confirmed acquisitions. |
| `text.mjs` | Normalisation, negation-aware term matching, year and decade extraction, HTML stripping. |
| `xml.mjs` | RSS/Atom reader. |
| `http.mjs` | Fetch with an on-disk cache, per-host throttle, retry policy and the user-agent. |
| `store.mjs` | The accumulating archive: load, upsert, prune, atomic save. |
| `proxy.mjs` | Re-execs once with `NODE_USE_ENV_PROXY=1` when a proxy is configured. No-op otherwise. |

### `web/` — the published app (this directory, and only this, is served)

| File | Purpose |
|---|---|
| `index.html` | The whole document. Every section exists in the DOM at once; views are shown and hidden. |
| `app.css` | 1,550 lines. Tokens at the top, then masthead, controls, rows, detail, responsive, and a series of dated passes each of which carries its reasoning in a comment. |
| `app.js` | 2,173 lines, one IIFE, no framework. State object, filter, sort, render, events, boot. |
| `lib/total.mjs` | The weighted sum, renormalisation, thin-evidence cap and prose floor. **Imported by both the build and the browser.** |
| `lib/recommend.mjs` | `outOfTen()` and `isRecommended()`. Also imported by both. |
| `lib/vector.mjs` | The seven-dimension vector, the fired mask, weighted distance, nearest-of, mean-vector. Shared by `describe.mjs` and `taste.mjs`. |
| `lib/taste.mjs` | The saves-tune-the-score model: tag affinity, dimension tilt, author affinity, leave-one-out. |
| `lib/overrides.mjs` | A second reader's re-scoring of bands, re-weighting of dimensions, and undoing of rules. |
| `lib/onboard.mjs` | Six questions → an override object. |
| `lib/saved-books.mjs` | The verdict store: save, unsave (tombstone), migrate, list. Pure. |
| `lib/merge-profile.mjs` | Merging one reader's two devices. Pure, 19 tests, and the file most able to silently eat a save. |
| `lib/sync.mjs` | Firebase glue. The only part of the app that talks to a server. |
| `lib/firebase-config.mjs` | The public browser key. |
| `lib/shelves.mjs` | Builds the Collections shelves from the reader's own weights. Pure. |
| `lib/jacket.mjs` | The drawn typographic jacket for a book with no cover. Pure, deterministic. |
| `lib/blurb.mjs` | Cleans the publication's standfirst — podcast furniture, sign-offs, restated citations. Pure. |
| `lib/retailers.mjs` | Four retailer URL formats, in one place, verified against the live sites. |
| `lib/isbn.mjs` | Normalise, checksum, ISBN-10 → ISBN-13. |
| `lib/analytics.mjs` | Local-only event recording with a per-event property allowlist. |

**Note the import direction.** `lib/describe.mjs` and `lib/score.mjs` reach *down* into `web/lib/` for `vector.mjs`, `total.mjs` and `recommend.mjs`, never the other way. That is because `bin/serve.mjs` serves `web/` and refuses anything above it, so a module the browser imports has to physically live there. Anything shared by both halves goes in `web/lib/`.

### `profile/` — the taste model as data

| File | Purpose |
|---|---|
| `reading-taste-profile.md` | The source document, revision 2. Kept beside its encoding so the two can be diffed. |
| `taste-profile.json` | Weights, bands, hard filters, soft penalties, bonuses, thresholds, the evidence rule, the prose floor and the `amendments` array. |
| `lexicons.json` | The terms each band, filter, penalty and bonus fires on. 1,822 lines. |
| `phrases.json` | The wording of the read on each book: band phrases, openers by tier, connectors. |
| `calibration.json` | 24 hand-labelled fixtures (12 acquire, 11 pass, 1 borderline) plus 3 recorded divergences. |
| `rule-tests.json` | 12 tests covering behaviour the §11 fixture set cannot reach. |

**Everything the profile specifies lives here, not in code.** `lib/score.mjs` holds only the mapping — which band a set of matched terms earns, and the non-linear rules the profile states explicitly. Change a weight in the JSON and re-run `npm run calibrate`.

---

## 4. The build pipeline, stage by stage

### 4.1 The registry — `sources.json`

84 sources, 54 enabled. Each carries an `id`, `url`, `enabled`, and a `kind` or `article` or `titlePattern` naming which parser handles it. A disabled source keeps a `disabledReason` with a measured item and book count, and a `disabledKind` of either `technical` or `editorial`.

**That distinction is load-bearing.** `bin/check-sources.mjs` will never propose re-enabling an editorially disabled source, however well it answers — Harper's, the New Republic and Lit Hub all respond perfectly and are off because their feeds are essays and round-ups rather than reviews. Deleting a disabled source instead of recording why loses the measurement, and somebody spends an afternoon rediscovering it.

**Three source tiers, and the distinction decides whether text may score a book.**

1. **Review sources.** Judge a book. Their text scores it.
2. **Trade metadata** — Publishers Weekly. Says a book exists and supplies publisher, page count and ISBN. Merges with reviews.
3. **Catalogue and interview sources**, marked `critical: false`. Publisher catalogues (Verso, Coffee House) and the seventeen New Books Network channels. They establish existence and metadata and **never touch a score**. Jacket copy and author interviews never say the prose is the weakness, so the profile's negative signals cannot fire on them while its positive ones fire on everything. `lib/aggregate.mjs` pools only critical mentions; a book with none is `listedOnly` and forced unscored.

### 4.2 Fetching — `lib/http.mjs`

On-disk SHA1-keyed cache with a 12-hour TTL, a 500ms per-host throttle, and up to two retries.

**The user-agent is honest and must stay honest.** It declares `ConstantReader/1.0 (personal reading feed; +<url>)`. It used to claim to be Chrome 120, and the Hudson Review, n+1 and Public Books all answer 200 to an honest agent and 403 to the Chrome string, from the same machine and address, seconds apart. Their rule is not "no bots", it is "no bots claiming to be browsers". Three sources were written off as IP-blocked for four days over a header. Tested across all 35 then-enabled sources before switching: two better, thirty-three identical, none worse.

**429 is backed off harder than 5xx and honours `Retry-After`.** A rate limit is a request to wait rather than a refusal, and it was falling straight through to the error return — which for Google Books meant one burst limit disabling the source for a whole build, costing 600 books their page counts and jacket images.

### 4.3 Extraction — `lib/sources.mjs`

Three confidence tiers, and the app reports which one it used on every row.

**Tier 1, source-stated.** A publication that publishes a book-under-review block gives title, author, translator, publisher and page count outright. NYRB (`review-items` sidebar), the LRB (`.reviewed-items`, whose `icon-film` / `icon-exhibition` markers distinguish a book review from a film review), LARB (a `reviewed_media` JSON payload — the best of the three), Publishers Weekly, Bookforum, 4Columns, Public Books, Bryn Mawr Classical Review, and Book Marks' weekly list.

**Tier 2, house title format.** The Guardian's `Title by Author review`, Kirkus' author slug in the URL, Full Stop's `Title – Author`, the NYT's `Book Review: 'Title,' by Author`, the New Books Network's `Author, "Title" (Publisher, Year)`.

**Tier 3, the prose fallback.** Italicised titles and "by" patterns in the review's own text. This is where confidence drops; those rows are marked `unverified`.

Three parsers are worth knowing about in detail because they will break and they are not obvious:

- **Bookforum** runs on Nuxt and ships its page state as a minified IIFE, `window.__NUXT__=(function(a,b,c,…){…}(…))`, with repeated values hoisted into the parameter list — a field can read `publicationDate:w` and mean the string at position 22 of the argument list. `nuxtAliases()` rebuilds that map by splitting the argument list at top level; if the parameter and argument counts disagree it falls back to literals only rather than resolving against the wrong positions. Worth the trouble because the payload carries a `publications` array with title, author, publisher, ISBN and page count, plus the whole review body.
- **Publishers Weekly** anchors on the author's name rather than splitting on sentences, because "St. Martin's" has a full stop in the middle of the publisher's name. The spec line is `(320p) ISBN 978-…`, and everything before it back to the author is the imprint.
- **4Columns** publishes its whole run as a server-rendered archive table, so the category filter happens before any article is fetched. Every review opens with a centred bibliographic line whose page counts and prices are wrapped in `<span class="italic">`, so tags come off before it parses.

**The guards on the prose fallback are the interesting part**, because each one was added after a specific wrong answer shipped:

- `isRoundup()` — a season preview lists a hundred books with the markup a review uses for one. Six or more title-then-attribution pairs means the page names many books and is treated as naming none.
- `readsAsClause()` — a conjugated verb anywhere in the run means it is a sentence, not a title. `looksLikeTitle` only rejected one at the very end, which let "the Lusitania was sunk" through.
- `corroborates()` — the review's headline or URL has to name the title too. Without it, "The Little Rock convention was modeled on meetings held" became a book by "African Americans"; twelve of the thirteen books that tier found were fragments of the review's own prose.
- `NOT_A_TITLE` — "thinking", "pessimism" and "for" all arrived as candidate titles, and each matched a real book in the catalogue.
- `looksLikeName()` — two to five capitalised parts, particles and initials allowed, no digits, and no "review"/"novel"/"press" words.

### 4.4 Resolution — `lib/books.mjs`

Open Library answers the two questions the profile needs — first publication year and whether it is fiction — plus page count and publisher. It is weakest on books published in the last few months, which is most of a review feed, **so the review's own metadata block always wins** and Google Books fills the gaps.

**The match rules.** A title similarity of 0.72 with an author surname agreement is `strict`. Without an extracted author, an exact title at 0.9 is `loose` and marked `unverified` — because titles repeat, and "Killing Spree" matched a thriller when the review was about a poetry collection of the same name. An exact title with a *wrong* author at 0.95 is recorded as `authorMismatch`, kept as a pointer for the reader and never as a source of year, pages or subjects: a 2025 novel colliding with a 2014 namesake would otherwise fall straight out of the ten-year window.

**Google Books is given up on after three consecutive failures, not one.** The original code disabled it on the first 429, which is right for a hard refusal and wrong for a burst limit; the 2026-08-29 build stopped asking after the first one and finished with jacket images for 18% of the shelf while the same key answered 200 a minute later.

**`corroborated` is the existence gate and it weighs evidence by provenance.** A title with no catalogue record, no page count, no publisher and no ISBN is a string, not a book. The review's own metadata block counts however the title was extracted, because a publisher printing a page count and an ISBN beside a title is asserting it is a book. A catalogue match counts, because it was verified against an author. **Google counts only when there was an author to verify it against** — Open Library already refuses an authorless match on principle and Google had no such rule, so the moment the API key started working, Google supplied a page count and a publisher for every italicised run and the feed acquired *Jurassic Park*, *A Nightmare on Elm Street*, *Star Trek: Strange New Worlds* and *Coyote vs. Acme*, scored and carrying jacket images.

### 4.5 The archive — `lib/store.mjs`

Most of these feeds carry ten to twenty items, a fortnight of publishing at most, so rebuilding from scratch each time would make the feed permanently shallow. Entries persist in `data/store.json` and each run merges in what is new. Written to a `.tmp` file and renamed, so a crashed build cannot leave a half-written archive.

**Verdicts and first-seen dates survive a rebuild; everything derived is replaced.** A change to the scorer therefore reaches the whole archive at once. Pruning is age-only at 400 days and skips anything the reader has ruled on.

### 4.6 Grouping — `lib/aggregate.mjs`

**The unit is the book, not the review.** Three publications on one novel is one row with three mentions, scored in a single pass over all three texts. That is not tidiness: a Guardian standfirst fires three dimensions, and pooled with an NYRB essay on the same book it can fire seven — which is the difference between a capped 6.9 and a real score.

The key is `titleKey|surname`. Author-less mentions are reconciled onto an author-ful book of the same title only where the title is distinctive enough (twelve characters or three words) to be unlikely to collide. Mentions are ranked by identity tier, extraction confidence and whether they carry a page count, so the best-furnished mention supplies the metadata. The merged book object is composed field by field rather than spread, so anything not explicitly named is dropped on the way out.

### 4.7 Scoring — `lib/score.mjs` and `web/lib/total.mjs`

Seven weighted dimensions, mapping one-to-one onto the seven tag kinds:

| Dim | Name | Weight | Default | Bands | Tag kind |
|---|---|---|---|---|---|
| D1 | Historical causation | 20 | 3 | 6 | period |
| D2 | Subject engine | 14 | 5 | 20 (12 descriptive-only) | subject |
| D3 | Formal ambition | 18 | 5 | 7 | form |
| D4 | Prose register | 24 | 5 | 6 | prose |
| D5 | Tonal signature | 6 | 7 | 11 (5 descriptive-only) | tone |
| D6 | Scale and sprawl | 10 | 7 | 5 | scale |
| D7 | Independence and provenance | 8 | 4 | 5 | press |

**That one-to-one mapping is the whole basis of the profile builder**, and it is why a "why did you like it" answer can move one band rather than smearing across all seven.

**Band selection.** A dimension needs two distinct terms to earn its top bands (9 and 10) and one for the rest — the engine is what a review keeps returning to, not what it mentions once. The exception is a curated set of *decisive* terms in `lexicons.json` (`water rights`, `no protagonist`, `martial law`) that settle a band alone: they are not signals that need corroborating, where "land" and "the studio" are.

**Term matching is negation-aware** (`lib/text.mjs`). Reviews negate — "no land title, no union, nothing institutional" — and counting a negated term as a hit is the fastest way to score a domestic novel as a land novel. A negator within 60 characters, with no sentence boundary intervening, cancels the term. A term that *opens* with a negator carries its own negation: "no protagonist" is the signal, not the absence of one.

**Three non-linear rules the profile states explicitly**, each of which records `preRule` so it can be undone by a reader who does not hold it:

- **The prose floor (Trap 3).** When D4 lands at or below `maxBandScore`, the total is capped into Reserve however good the architecture is. That is the entire difference between *Ohio* and *The Deluge*. Applied after the weighted sum, in `total.mjs`.
- **The land-scale demotion (Trap 4).** The D2 land band drops from 10 to 6 when the subject is exact but nothing institutional or multi-decade stands behind it. *Homestead* and *Damnation Spring* both hit the engine precisely and were both passed; both single-couple, single-season.
- **The twist override.** A formal device that resolves into a reveal scores 3 rather than 9. The *Trust* failure. Only radical constraint and the invented archive survive it.

**Two evidence rules keep a thin score honest**, both in `total.mjs`:

- A dimension that never fired is **not** scored as a default. D6 falling to 4 because no catalogue recorded the page count is a fourteen-point penalty for a fact about the catalogue, so the sum runs over what fired and is scaled back up. Measured by *weight*, not by count.
- But renormalising a thin row lets the few that fired carry the whole number, so anything below the weight bar is **capped at 69** (6.9 out of ten). It can be scored and read. It cannot be claimed.
- Where nothing fired at all there is no score, and the row says so rather than showing a number assembled entirely from defaults.

**D6 reads D3's `preRule` score, not its final one.** D6 asks whether the book is formally ambitious, and the twist override is a judgement about how a device resolves; letting it travel into scale docks a long braided novel twice for one fact, and a reader who does not hold the twist rule cannot undo the second charge because it was never recorded as that rule's doing.

**Filters are penalties now, not gates.** `filterMode: "penalty"`. §4 of the profile document lists six hard filters as auto-excludes; on Michael's instruction of 2026-08-24 they became heavy negatives — nonfiction −45, satire −30, Pynchon −30, twist −15, sealed-present −10, book-club −20. Detection is unchanged and the row still names which rule fired; only the consequence changed. They are sized so nothing carrying one can reach the recommendation threshold: a fixture firing every dimension the profile has still lands at 4.7 with the nonfiction penalty applied, and there is a rule test pinning exactly that.

**`sealed_present` is deliberately cheap at −10** because D1 scoring zero already costs 18 points of weight on its own, and a heavy penalty would charge the same fault twice.

**The redemptive-ending penalty is three-tiered.** The document says a flat −10 for any warmth. The amendment of 2026-08-24 makes it −10 when the review calls the resolution sentimental, tidy, telegraphed or unearned; 0 when it marks the warmth as costly, resisted or strange; and −3, flagged on the row rather than buried, when the review says neither. A zero-point tier lands in `score.notes` rather than `score.adjustments`, and **`DESIGN.md` requires the caveat line to render `score.notes`** — burying it would reverse a decision the profile records.

**Descriptive-only bands.** Seventeen bands (five tone, six fiction subjects, six nonfiction subjects) carry `descriptiveOnly: true`, sit last in the pick order, and score at the dimension's default. They name a book the profile could not name before without moving a single existing number. This is the only safe way to add vocabulary to a scored profile, and there are tests pinning it.

### 4.8 The two publication gates — `bin/build.mjs`

Applied on the way *out*, not on the way in, because the store keeps what it has already seen and a rule added today has to be applied to yesterday's entries or the mistakes stay published forever.

- **`NOT_A_BOOK`** — a publisher's shop sells subscriptions, gift cards, tote bags and back-issue bundles, all arriving in the same feed with the same shape. Filtered by title at ingest and again on the way out.
- **`corroborated === false`** — nothing establishes this is a book. 30% of the archive was in that state on 2026-08-28 and it included a film, a television series and a games supplement, all scored and sorted as novels. Hiding them behind a filter was the wrong fix: they still got scored, still shipped in the payload and still had to be accounted for in the status line.

**The store keeps them regardless.** Mentions are the archive and the catalogue catches up on recent books over weeks, so a bare title today can resolve on a later run and appear then. This is a rule about what is published, not about what is remembered.

### 4.9 Redaction, in the same file

- **Email addresses are stripped from bylines and text.** World Literature Today's byline field arrived holding a reviewer's university email address, which the publish guard caught on its way to a public site. Redact rather than drop: the surrounding text is the review, and an address is the one part nobody agreed to put on the open web.
- **Feed boilerplate is cut from the standfirst.** A description field is not a standfirst; several feeds open theirs with a picture credit, which then reads as the app's own account of the book. "Featured image credit: Ketchup Entertainment Among the many genres covered at crimereads dot com is…" was the first sentence under a score.

---

## 4b. The back catalogue

Every source in `sources.json` is a syndication feed, and a feed is a window on the present: the Guardian's carries 20 items, the LRB's 22, Book Marks' 10. Crawl one every morning for a year and you have a year of reviews. The profile has always declared a window — five years as of 2026-08-31, ten before that — and until this existed the corpus held thirteen months.

**Discovery and extraction are separate, and that is the whole design.** `bin/archive.mjs` reads the index a publication keeps for its own readers — a sitemap, a table of back issues, a paginated listing — and writes review *addresses* to `data/archive/<id>.json`. It fetches no review and extracts no book. Then a `kind: 'archive'` source in `sources.json` hands the build a bounded slice of that backlog, and the build puts it through the same `extractBook` → resolve → score path every live review takes. One extraction path, one scorer, one store. A second pipeline that happens to agree with the first this morning is the kind that stops agreeing in a month and tells nobody.

**A slice is a unit of work small enough to abandon.** One month of a sitemap, one issue of a paper, one page of a listing. `npm run archive` does twelve and stops, which is twelve requests and nothing against the build that follows. The 06:20 job runs it before the build and ignores its exit code: a sitemap that 503s must not cost the day's feed. Discovery is set slightly ahead of what the build can swallow — the three working archive sources take 70 articles a run between them — so the backlog stays non-empty. The whole window fills over a few weeks of mornings.

**An entry is stamped `taken` before the build has done anything with it.** The store keys on the review URL, so re-offering one costs an update rather than a duplicate; leaving an entry untaken after a build that crashed on it would offer the same broken address every morning forever.

| Archive | Index | Resolution, measured |
|---|---|---|
| `4columns-archive` | The whole run in one server-rendered table | 18 books from 20 addresses |
| `larb-archive` | Pages 4+ of the same Next.js payload the live source reads three of | 14 from 15 |
| `lrb-archive` | Back issues by volume and number; volume is the year less 1978 | 13 from 23 |
| `nyt-archive` | Monthly sitemaps — **disabled** | 0 from 39 |

**The NYT is discovered and not used, and the reason is worth keeping.** The sitemaps work: `sitemap-2019-06.xml.gz` lists 102 book reviews, and five years of them would be the largest thing this crawl reaches. The article pages answer 403 to any crawler, including the build's own client, so the only metadata is the URL slug — and the NYT title pattern reads the headline's quotes and its "by", neither of which a slug has. A build over 39 of them resolved none. Reachable addresses without reachable pages is not a source. The discovery code stays in `lib/archive.mjs` because it works; re-enabling the source is a one-line change if the pages ever open.

**The Guardian is not here at all.** Its archive pages render their listings client-side, so the back catalogue needs an Open Platform API key, which is free and has to be registered by a person.

---

## 4c. Covers, and finding a better one

**Google's cover first, Open Library's only when Google has none.** This was the other way round, on the reasoning that a matched catalogue record is the more trustworthy source. It is, for facts. It is not, for pixels: Open Library serves three fixed sizes and its largest is about 300px, while Google renders the same jacket at 1000px. Measured across four books where both had it — 296, 328, 325 and 323 against 1000 every time.

**`bin/covers.mjs` goes back for the ones already in the store.** Changing the preference only helps books crawled after the change; the rest keep the address they were given. It walks `data/store.json`, asks Google for a jacket **by ISBN** — an exact key, where the first-pass search only had a title and an author — and rewrites `book.coverUrl`. Nothing else on the record: everything else was settled by a match with more to go on.

**It measures both before it swaps, and only ever goes up.** The width is read out of the JPEG or PNG header over a range request rather than by downloading the file, because Google will happily answer with a 128px thumbnail for a book whose scan is poor, and without the check this would trade Open Library's 300 real pixels for it. First full run: 51 improved, 4 already as good as they get, 107 with nothing on Google.

| | Before | After the first run |
|---|---:|---:|
| Google covers | 584 | 629 |
| Open Library covers | 56 | 45 |
| No cover, drawn jacket | 183 | 149 |

**It runs last in the daily job, bounded to forty books.** The build needs the Google Books quota for page counts and descriptions on books nobody has catalogued, which is worth more than a cover; anything found here lands in tomorrow's feed rather than competing for today's. The first full run exhausted the day's quota, which is why the remaining 107 are worth re-running rather than treating as final.

    npm run covers                 report what would change, write nothing
    npm run covers:write           do it
    node bin/covers.mjs --limit=50 a smaller bite

---

## 5. The payload — `web/data/feed.json`

One object. Top-level keys: `builtAt`, `windowYears`, `recommendAt`, `profileRevision`, `thresholds`, `dimensions` (each with `id`, `name`, `weight`, `default` and its bands), `evidenceRule`, `openQuestions`, `hardFilters`, `sources`, `surfacing`, `proseFloor`, `unresolvedReviews`, `tags` (the index), `books`.

**Bands travel with the feed** because a reader re-scoring a band in the browser needs to know what bands exist and what this profile paid for each — and the evidence rule and prose floor have to travel too, or the browser's arithmetic diverges from the build's.

Each book entry carries `id`, `book` (title, author, pages, publisher, ISBNs, `bookYear` with its `yearSource` and `yearPrecision`, `coverUrl`, `catalogued`, `corroborated`, `extraction`), `mentions[]`, `reviewCount`, `listedOnly`, `sources[]`, `firstReviewed`, `lastReviewed`, `categories`, `score` (the whole scoring object including per-dimension evidence, `preRule`, `dimensionRules`, `adjustments`, `notes`, `filters`, `risk`), `outOfTen`, `recommended`, `recommendedWhyNot`, `reading`, `inWindow`, `fiction`, `identity`, `tags[]`.

**Every dimension shows the terms it fired on**, precisely so a wrong score is visible as a wrong score. What it no longer ships is `matched`, the scorer's full working — every band of every dimension with its hit list, including the eighty-odd that hit nothing. The build needs it, `runFilters` reads it, and the browser has never once looked at it. On 785 books it was 1.72MB of a 6.7MB feed: a quarter of what every reader downloads, all of it zeroes. It stays in `data/store.json`, where the next build still reads it, and `bin/build.mjs` drops it on the way out.

---

## 6. The browser app

`web/app.js` is one IIFE, no framework, no virtual DOM. It reads `data/feed.json`, keeps a `state` object, filters, sorts and re-renders. Every view exists in the DOM and is shown or hidden.

**Views.** Collections (the landing screen), My feed, All books (with independent *how* — shelves or list — and *which* — Everything / Reviewed / Ahead of the reviews), Saved books, Taste, Your ordering, Build your profile.

**One test decides "unscored", everywhere**: `e.listedOnly || band === 'unscored' || band === 'unresolved'`. It was three slightly different tests before and each disagreement showed. If a fourth place needs it, it takes the same test or it will drift the same way.

### 6.1 Two layers of personalisation, and they compose

They are applied in a fixed order and must stay in it.

**Layer one — `web/lib/overrides.mjs`, the reader's ordering.** A band carries two things doing different jobs: a **label** describing the book, which is shared vocabulary, and a **score** ranking it, which is one reader's. "Comic" describes a novel the same way for everyone and is worth 4 to this profile and 10 to somebody who reads for comedy. A second reader can undo a rule, re-score a band, re-weight a dimension, or switch off a penalty — all without a rebuild. Rules are applied first, because undoing one changes which band is in play and therefore which band an override lands on. The arithmetic is not reimplemented: `overrides.mjs` calls the same `total.mjs` the build calls, so a re-scored row and a freshly built one cannot disagree.

**Layer two — `web/lib/taste.mjs`, the saves.** Borrowed deliberately from Acetate Club, the music app in the sibling repo. Nearest-neighbour against the saved set, a bounded penalty for what you keep dismissing, and naming the match — "reads like X, which you saved" — which is what makes a recommendation legible instead of oracular.

**One thing deliberately does not carry over.** Acetate's recommender says, in a comment, "the watchlist is the entire taste signal. No persistent profile exists beyond it." That is right there and wrong here: this app has a written profile at revision 2, seven weighted dimensions, twelve confirmed acquisitions and a 24-fixture calibration suite. Ten saves should not outvote that. **So the profile is the prior and the saves are a bounded correction**: the base score is never overwritten, the adjustment is capped at ±8 points out of 100, and both numbers are on the row.

Three components, from a `MIN_SIGNAL` floor of three saves:

- **Tag affinity** (budget 3.5), from saves and passes both, each measured against how often the tag was *available* to be saved. Only nine of the fourteen tag kinds are learnable: 127 of the feed's 186 tags were publisher imprints, nearly all on one or two books, and letting them in produced the model's first bad idea — *"you pass on books tagged HQ Digital"*, learned from a single pass.
- **Dimension tilt** (budget 3.5), where your saves run hotter or cooler than the field. A dimension fewer than four of your saves have evidence for is left out rather than guessed at. **Divided by the whole profile's weight, not by the fired weight** — the first version divided by the latter and tuned the thinnest books hardest, which is exactly backwards.
- **Author affinity** (budget 1), a small nudge for a surname you have saved before.

**Saved books are scored, and held out of their own scoring.** A saved book with no visible score is a score you cannot check, and an outlier inside your own collection is exactly the thing worth seeing. But a book cannot vote for itself: each save is roughly a tenth of its own evidence, and scoring saves against a model they helped build inflated them by 1.3 points on average and 2.2 at worst — putting your own collection at the top of the feed by construction. So each judged book is scored against a model rebuilt without it, cached by id on the shared model and thrown away whenever the verdicts change. Holding a book out can drop the rest below the three-save floor, so a saved book keeps the profile's own number until there are four saves to spare one from.

**The anchor is withheld when the model is demoting the book.** "Runs against your saves" and "reads like something you saved" in the same breath is a contradiction, and the reader is right to distrust both halves.

**Recommendation under tuning goes through the same `recommend.mjs` the build uses** — same rounding, same threshold, same module — so the two can never disagree. Everything the build refused for a reason other than the score stays refused; tuning only ever moves the number.

**Weights are a different matter and the browser will not touch them.** `npm run tune` proposes, re-scores all 24 fixtures under the proposal, and shows what breaks. It writes nothing. An earlier draft had `--apply`; it was removed after a test run silently rewrote `taste-profile.json` through `JSON.stringify`, reformatting a hand-commented document and leaving no amendment behind. The profile has an `amendments` array precisely because every departure from the spec is supposed to be explained by whoever made it.

### 6.2 Saving, sync and merge

**`web/lib/saved-books.mjs`** is the verdict store. The conceptual record is `{ id, userId, bookId, savedAt }` with `id` and `bookId` collapsed (the record is keyed by the book) and `userId` dropped (there is exactly one). Uniqueness on `(userId, bookId)` is therefore **structural** — a plain object keyed by bookId cannot hold the same book twice. A repeat save keeps the *first* timestamp, because that is when the decision was made. If accounts ever arrive, this file is where the userId scoping goes and nothing above it needs to know.

**Saving is optimistic.** The list changes and the screen redraws first, and only then is the write attempted. `localStorage` genuinely fails — private mode, a full quota — so when it throws, the previous list goes back exactly as it was, the reader is told, and the same action is offered again as a retry. This is the one write whose failure the reader needs to know about, so unlike the general `write()` helper it throws.

**Unsaving writes a tombstone, and that is not a detail.** The first build deleted the key, which cost a working unsave for anyone signed in: the reader removed a book, the sync that followed pulled the server copy which still held the save, the union merge read the missing key as "unknown on that device", and the book came straight back on screen. A signed-in reader could not remove a book at all. So `unsave()` writes `{ verdict: null, removedAt }`. Nothing above the file changed — `verdictOf` reads a null verdict as no verdict, so `isSaved`, `savedIds`, `savedCount` and `listSaved` all treat a tombstone as absent, which is what it is.

**`web/lib/merge-profile.mjs`** is the file most able to silently eat a save, so it is pure, separate from the Firebase glue, and carries 19 tests.

- Verdicts merge as a **union, never an intersection**. A book one device knows and the other does not is kept: silence is not disagreement, and a device offline for a month must not erase a month of saves by syncing.
- Where both sides saved the same book, **the earlier save wins** — one decision recorded twice, and `savedAt` is when the reader chose.
- Where one side saved and the other removed, **the later decision wins** — those are two different decisions, and a reader who unsaves on their phone has to see it stay gone on their laptop.
- **Keys come out sorted**, so two devices write the same *bytes* rather than merely the same facts. Object key order is insertion order in JavaScript, so merging A into B and B into A agreed on every verdict and still produced two different documents — a diff on the server on every sync, for no change at all.
- **Overrides are last-write-wins on the whole object**, because a weight and its band scores were chosen against each other and merging half of each produces an ordering nobody ever held.
- Theme, filter prefs, the last retailer and the analytics log stay on the device that made them: they describe a browser, not a reader.

**`web/lib/sync.mjs`** is the only part of the app that talks to a server, and it is inert until asked. The Firebase SDK is fetched from gstatic on the first tap of *Sign in*, and on later visits only because `litfeed:signed-in` says the reader already did. A signed-out load fetches nothing and renders every row. Every failure path ends in a message and a working signed-out app; nothing throws upward.

**Neither of Firebase's own flows works on iOS Safari here, and the reason is the same for both.** `signInWithRedirect` and `signInWithPopup` both route through `constant-reader-93f05.firebaseapp.com`, which writes its state to `sessionStorage` under a partition key and reads it back under a different one. Redirect was ruled out for that on 2026-08-29; the popup was believed safe because it stayed in one window, and on 2026-08-30 it returned the same handler's message — *"Unable to process request due to missing initial state"* — which is that page saying its own storage came back empty. Desktop Chrome does not partition this way, so the flow verified end to end on 2026-08-29 and still could not sign anyone in on a phone. **A flow verified only on desktop is not verified.**

**Google is asked for the token in the page, and Firebase is only handed the result.** `lib/sync.mjs` loads Google Identity Services from `accounts.google.com`, takes an access token from `initTokenClient`, and exchanges it with `signInWithCredential`. The auth handler is out of the path, so there is no third-party storage to partition. There is deliberately no fallback to either Firebase flow: both are broken in the browser most readers are holding. The OAuth web client id ships in `lib/sync.mjs` and is public by design — it names the app to Google and authorises nothing on its own, and the origin allowlist on the client is what decides who may ask. **Its secret is not in the repo and must never be.**

**`sync.warm()` runs on `pointerdown`, not on load and not on click.** Google's window is opened from inside the click handler, and a browser only allows that from a gesture — a click that first waits for a script to download is a click the popup blocker eats. `pointerdown` fires before the click and is still the reader reaching for the button, so a reader who never signs in still fetches nothing and invariant 11 holds.

### The roundup, and choosing how often

**Two frequencies, chosen per device on the Profile screen: weekly (Monday only) or every refresh (Monday, Wednesday, Saturday) — and a notification only when something new cleared the threshold.** `.github/workflows/notify.yml` fires 55 minutes after the build on all three build days, the same schedule the build itself runs on, and `bin/notify.mjs` decides who actually gets poked: each device's choice travels as a `frequency` field on its Firestore device doc, defaulting to `weekly` for anything subscribed before this existed.

**Two independent baselines, not one.** `every` moves forward on every run; `weekly`'s only moves on Monday, so a book that arrived Wednesday is still "new" when Monday's check runs for a weekly subscriber, rather than having already been marked seen by Wednesday's run on their behalf. A shared baseline would quietly starve the weekly group of exactly the books that arrived on the days it doesn't check.

A run with nothing new for a group is a silent run — a phone that buzzes to say "no new recommendations" is a phone that gets this switched off.

**The push carries no payload, and that is the design rather than a shortcut.** It buys two things. The sender needs only a VAPID signature — an ES256 JWT built from `node:crypto` — instead of the RFC 8291 payload encryption, so the project keeps its zero dependencies and hand-rolled crypto stays out of the delivery path. And no reader's recommendations pass through Apple or Google: the push says only that there is news, and `web/sw.js` fetches the news from the same public `feed.json` everyone else gets. A push service that logged everything it relayed would learn that a device exists and nothing about who reads what.

**`web/sw.js` has no `fetch` handler and must not grow one by accident.** A service worker that cached this app would be a second copy of it with its own idea of how fresh it is, and stale module caching has already produced two false conclusions in a single day. Offline reading is a real feature; it needs a version stamp and a way to break the cache, and it is not something to acquire while adding notifications.

**Subscriptions live at `readers/{uid}/devices/{id}`, not in the reader's document.** `sync.push()` writes that document with `setDoc` and no merge, so a subscription stored beside the verdicts would be erased by the next sync — silently, and a week before anyone noticed the notifications had stopped. A subcollection is out of that write's reach, and it lets one reader hold several devices, which is the ordinary case. `firestore.rules` states the subcollection explicitly, because a rule on a document does not reach its subcollections.

**Two keys and one guard.** `web/lib/push.mjs` ships the public half of the VAPID pair; `vapid.key` holds the private half beside `google-books.key`, gitignored twice. If the two ever stop being halves of the same pair, every push is refused with a 403, no browser shows anything, and the only symptom is a Monday where nobody's phone buzzed — there is no user-visible error at all. `npm test` derives the public key from `vapid.key` and asserts it matches what the app ships. **Regenerating the pair invalidates every existing subscription.**

**iOS is the whole reason this feature is mostly prose.** Web Push on iPhone exists only for a web app added to the Home Screen — Apple's rule since 16.4, not a Pages or Firebase limitation — and permission must be requested inside a tap. So `push.blocker()` checks `needs-install` *before* it checks support: on an iPhone in a Safari tab, `PushManager` is missing because the app is not installed, and "your browser cannot do this" is the wrong sentence to show someone whose browser can.

**Only Firebase gets to say a reader is signed out.** `watch()` reports `(user, { authoritative })`. A null user Firebase actually returned means the session is gone and the remembered account is cleared. A null user because the SDK never loaded means we could not ask, and the account stands — otherwise opening the app on a train signs the reader out and makes them redo the popup on the other side of the tunnel. Offline shows the `--warn` dot instead: signed in, not syncing, books safe on this device.

**Never the Google photo.** `photoURL` is an external request on every load, it 404s when Google rotates the id, and it drops a full-colour photograph into a palette that allows one red. The account control is a drawn monogram: one letter in Bodoni on `--surface-2`.

### 6.3 Collections and jackets

`web/lib/shelves.mjs` reads the dimension weights **in force**, including any the reader has changed, and builds one shelf per band for the heaviest dimensions. A reader who has pushed prose to the top gets prose shelves; the same feed gives someone else period shelves. That is the whole reason this is not a set of hardcoded categories.

Bookkeeping tags never become a shelf. Nor does `imprint` — 320 values across 874 books — with one exception: in the "Ahead of the reviews" pool the books have no review prose to tag from but every one has a publisher, and they are overwhelmingly Oxford, Cambridge, Verso, MIT and California. For new scholarly books the press is how you browse.

**One shelf per dimension.** Filling spare slots by rank gave "Short", "Mid-length" and "Long" three of seven shelves — page-count buckets, which measure a book rather than give anyone a reason to pick one up.

`web/lib/jacket.mjs` draws a typographic jacket for the ~20% of books with no cover image: title in Bodoni, author in mono caps, a doubled rule, one of five grounds. **Deterministic, hashed from the book id** (FNV-1a), because a shelf that reshuffles its colours on reload reads as a bug. The accent ground is one in five rather than one in two: a shelf where every second jacket is lacquer red stops reading as a shelf and starts reading as a warning. A dead cover URL falls back to it too, via an `error` handler — covers are refetched every morning and Google rotates volume ids.

**No external art and no Creative Commons image search.** Per-image licence review is real work with real failure modes, and an image pipeline reaching outside Open Library and Google Books would break the guarantee that the published site is a static file and a JSON blob.

### 6.4 Retailers and analytics

`web/lib/retailers.mjs` holds four URL formats in exactly one place, because those formats belong to somebody else and will rot. Verified against the live sites on 2026-08-25; the file records what each response actually was, including the two that could not be read directly (Amazon's `/s?k=` answers 503 to a datacentre IP, and Bookshop.org answers 403 behind Cloudflare — but its `/search?keywords=` 301-redirects to `/beta-search?keywords=`, which is the server naming its own preferred path).

**`isbn13` and `isbn13FromIsbn10` are kept apart deliberately.** Bookshop needs a 13 to deep-link and a valid 10 converts, but `linkResolution` reports what the *catalogue* held, because the question it answers is "are the sources carrying ISBN-13s, or are readers being dropped into a title search". Collapsing the two would make every ISBN-10 in the feed look like an ISBN-13.

**No ASIN is ever guessed from an ISBN-10.** It would be right for print and wrong for everything else, with no search box to recover from.

**`decorate()` refuses to write an empty tracking parameter.** No affiliate programme has been approved, so every link goes out clean; a placeholder value would be a broken parameter on every outbound link rather than a harmless no-op.

`web/lib/analytics.mjs` records to `localStorage` and **never sends anything anywhere**. No script is loaded, no request made, no identifier minted. Only the properties each event declares are kept, so an outbound URL or a retailer account cannot be recorded by accident — the privacy rule is enforced in the module rather than trusted to callers. A 500-event ring, not an audit trail.

---

## 7. The design contract

**Read `DESIGN.md` before writing any UI code here.** It is the single source of truth for visual style and it carries the reasons, not just the values. Highlights an incoming engineer will trip over:

- **Border radius is `0` everywhere.** The Deco corner is a chamfer or a step, not an arc. The one chamfer in the app is a single corner of a jacket card.
- **Brass sets no type at any size** and appears only on the masthead rule and a shelf head. A metallic dark enough to read stops looking like metal.
- **Rows are hairline-separated list items** — no cards, no shadows, no left-border accent stripes. Cards exist on Collections and nowhere else. There is no cover-image grid in the feed: the feed is a list you read, not a shelf you browse.
- **Detail expands inline on `--surface`, never a modal.** This app opens no dialogs, which is why the retailer chooser is a disclosure and the Taste screen is a screen.
- **Bands are never colour alone.** Always the word beside the mark.
- **No form control may set text under 16px on a coarse pointer.** iOS Safari zooms into anything smaller on focus and does not zoom back, which widens the page past the viewport. It presents as a layout bug and is not one — the layout measures clean at 375px while it happens.
- **`details:not([open]) > *:not(summary) { display: none }`** is load-bearing. Chrome hides a closed `<details>`'s children with `content-visibility` rather than `display: none`, and an explicit `display` on a child escapes it — the filters panel set `display: flex` on its grid and handed 158 controls to the keyboard on a panel that was not on screen.
- **The dock sits in the DOM directly after the bar it belongs to**, even though it is `position: fixed`. Written at the end of the document, the settings menu was tab stop 2,856 of 2,857.
- **A scroll listener, not an IntersectionObserver.** The observer is the tidier idea and it delivered no callbacks at all in an embedded webview, not even the initial one every observer is supposed to fire. Both mechanisms are wired now and both just call an idempotent `apply()`.
- Full WCAG 2.1 AA audit at 320, 390, 768 and 1440 is recorded at the foot of `DESIGN.md`, including two false positives recorded so nobody re-opens them and one accepted risk (2,699 focusable elements at 444 books, inherent to a list this length).

---

## 8. Deploy, secrets and the scheduled jobs

### 8.1 `npm run site`

One guard, before anything is deployed.

- **Every file about to go out is scanned** for absolute home paths, email addresses, credentials, Google API keys, assigned secrets and authorization headers. The scanner is deliberately narrow: one that cries wolf gets ignored, and matching a bare "token" would flag the app's own design tokens on every run. It has already caught a reviewer's email address on its way to a public site.

**One string is allowlisted and only one**: the Firebase browser key, as an exact literal. It is tested with `includes` against the whole match rather than compared for equality, because two rules catch that key and they capture different amounts of the line around it. **Never widen this to a file path or a looser pattern** — catching the *other* Google key, the server-side Books one, is the rule's entire job, and a rule with a hole shaped like a filename stops working the day somebody moves the file.

`site/` is rebuilt from scratch on every run, so nothing stale survives into a deploy. `CNAME` and `.nojekyll` live in `web/` and are copied with everything else.

### 8.2 The two keys, which must never be confused

| | `web/lib/firebase-config.mjs` | `google-books.key` |
|---|---|---|
| What | Firebase browser key | Google Books API key |
| Public? | **Yes, by design.** Ships to every browser. | **No.** An Actions secret, written to a file at build time. |
| Protected by | Firestore rules + the signed-in user's token + HTTP referrer restrictions | File permissions, gitignored twice |
| In git? | Yes | No — gitignored |

The Books key is a **file rather than an environment variable** because a key that silently vanishes from a scheduled job's environment is the failure this was meant to end. In Actions the workflow writes it from the `GOOGLE_BOOKS_KEY` secret. `lib/books.mjs` reads it at import; `googleKeyed()` reports whether it was found and the build prints a red line when it was not, because a missing key and a spent quota both end as "no Google Books" and need different things doing about them.

### 8.3 Firebase

Project **`constant-reader-93f05`**. Firestore native mode in **`nam5`, which is permanent**. Google sign-in only. Rules in `firestore.rules`: a reader may read and write `readers/{uid}` and nothing else — no shared collection, no public read, no listing. Deployed with the Firebase Rules API rather than the `firebase` CLI.

Authorised domains were set over the REST API and **the Pages origin is not authorised by default while `localhost` is**, which is the worst order to find a problem in.

Two failure modes present identically as "sign-in did nothing": `auth/configuration-not-found` means Authentication was never started, and `auth/admin-restricted-operation` means it is configured and the provider is off. Probing with `signInAnonymously` is the cheap way to tell them apart, because anonymous is not enabled and never should be. Note that `identityPlatform:initializeAuth` refuses with `BILLING_NOT_ENABLED` — that endpoint is the paid Identity Platform rather than Firebase Auth's free tier. **Do not enable billing to route around it**; starting Auth is a console action.

### 8.4 The Monday/Wednesday/Saturday jobs

`.github/workflows/deploy.yml` crawls, tests and deploys at 11:20 UTC on Monday, Wednesday and Saturday, and on demand. A push to `main` deploys the code change against the last feed without re-crawling. Three firings a week is plenty of freshness against how often the desks actually file. It ran daily until 2026-09-06.

The crawl is incremental: `data/store.json`, `data/archive/`, `.cache/` and the last `web/data/feed.json` are carried between runs in the Actions cache. A run with an empty cache crawls from nothing and produces a much shallower feed, so seed it once: the steps are in the workflow's header. Until the crawl is within 90% of the live feed's book count, a scheduled run saves its state but deploys the live feed.

`.github/workflows/notify.yml` sends the roundup 55 minutes after each build, so it never reads about the feed until the freshest possible copy exists. The two-day staleness guard it carries is still safe on this cadence: the longest gap between builds is Saturday to Monday, under two days.

Guards:

1. **One run at a time.** A `concurrency` group, because two crawls writing one archive would interleave their writes.
2. **Fresh output rather than an exit code.** On 2026-08-27 `bin/build.mjs` threw a `ReferenceError` on its first LARB article, printed the stack trace and **exited 0**. Nothing flagged it, the previous feed stayed in place, and a broken parser would have shipped silently. The workflow requires `feed.json` to be newer than it was and to parse with a non-empty `books` array.
3. **Tests before deploy.** `npm test` gates every deploy. Calibration runs and reports but does not gate, because one fixture (The Nix, 69 against a floor of 70) was already out of tolerance when the move happened.
4. **The secret scan**, inside `npm run site`.

Turn the schedule off by disabling the workflow in the Actions tab. A manual run still works after that.

---

## 8b. Cache busting, and why it exists

GitHub Pages serves this app with `cache-control: max-age=600`. A browser is told it may reuse `app.js`, `app.css` and every module for ten minutes without asking, iOS Safari holds ES modules a good deal longer than that, and **an installed web app has no reload gesture**: swiping it away closes the window and leaves the cache exactly where it was.

That cost this project real time three times. Twice a shipped fix was read as not shipped because the browser was serving an old `lib/*.mjs`. The third time Michael was looking at soft covers on a phone still running the code from before the fix, with no way to make it stop.

`bin/site.mjs` stamps every asset URL with `?v=<hash>` in `site/`. A new build is a new URL, so a stale entry can never be served for it.

- **The hash is of the assets, not the clock**, so a publish that changes nothing changes no URL and warm caches stay warm.
- **Module specifiers are rewritten too, not just the two entry files.** A relative specifier resolves against the importing URL *without* its query, so stamping `app.js` alone would leave the whole of `lib/` cached — which is exactly where the stale code was.
- **It happens in `site/` and never in `web/`.** Working files keep clean paths and `npm start` serves them unstamped.

**`index.html` cannot be stamped**, being the entry point, so it keeps the ten minutes — and an installed web app holds its start URL harder than a tab does. Stamping alone therefore left a reader able to sit on an old build with no way out, which is what happened.

**So the app checks whether it is the build that was published, and reloads itself if not.** `feed.json` is fetched with `cache: 'no-cache'`, making it the one file that is always current, and the publish writes the build's version into it as `assetVersion`. On boot, `app.js` reads its own version out of `import.meta.url` and compares. A mismatch means the HTML this page came from is stale, and it replaces the location with `?v=<current>` — a URL the cache has never seen.

- **It cannot loop.** The version it reloaded for is written to `sessionStorage`; a version that somehow never matches reloads once and then gives up.
- **It cannot fire locally.** `npm start` serves unstamped files, so `mine` is null and the check short-circuits.

That closes it: a reader on a stale build gets one reload and is current, without knowing anything happened.

---

## 9. Testing

**`npm test` — 156 tests, 24 groups, no network, currently all passing.** Covers ISBN arithmetic, retailer URL construction (asserted by origin, path and *decoded* parameters, so adding an affiliate tag does not fail a test that is not about that), the saved list, migration, listing, analytics property filtering, the taste model, pre-rule bands, reader overrides, the widened vocabulary, D6 propagation, two-device merge, shelves, jackets and blurb cleaning. Every ISBN in a fixture is checksum-valid — an invalid one makes a passing test mean something other than it appears to.

**`npm run calibrate` — 24 fixtures + 12 rule tests, currently 20/23 within tolerance with 3 recorded divergences and 12/12 rule tests passing.** The profile sets its own tolerance: every confirmed acquisition at 70 or above, every confirmed pass at 65 or below.

The three divergences are deliberate and recorded in `calibration.json` with reasons — *James*, *Martyr!* and *Homestead* were all passes in §11 and now score above 7 under the softened D2/D5/D6 and the raised D4. The fixture's expected label is left as what actually happened; the divergence is the record of the rules having moved, so the suite still catches regressions it did not sign off on. *Manhattan Beach* is the one deliberate borderline and lands at 74.3 — the model reads formal ambition as a strong preference rather than a hard requirement, which is open question §10.4 still open rather than an answer.

**The rule tests cover what the fixture set cannot reach.** All three of §11's redemptive-ending fixtures are penalised before the tier logic can matter, so that rule was effectively untested until those cases existed. Each rule test differs from its neighbour in one respect only.

**What calibration does not test.** It validates the weights and the band mapping against 24 hand-labelled books whose descriptive text was written to sit in the register of review copy. **It does not test extraction**, which is a separate problem with separate failure modes and no test coverage at all. Treat a score as triage — a reason to read the review, not a reading of the book. §12 of the profile warns that correlation in the positive set is not a criterion until the dimension has been varied against a controlled slate, and that warning applies directly.

**There is no end-to-end test and no extraction test suite.** That is the single largest gap in this codebase. Adding one would mean checking a handful of real HTML fixtures into the repo and asserting what each parser gets out of them; every parser regression to date has been found in production.

---

## 10. Invariants — the things that must not be broken

1. **`web/lib/total.mjs` is imported by both halves.** If a scoring rule moves out of it into one side only, a re-scored row and a freshly built one will disagree about what a book is worth. Same for `recommend.mjs`.
2. **A publisher's own words never score a book.** `critical: false` on a source is checked in `aggregate.mjs` (pooling) and set in `sources.mjs` (listing). Both, or the rule is only half applied.
3. **Every weight, band, threshold and lexicon term lives in `profile/`.** Never in code. Change one and re-run `npm run calibrate`.
4. **Every rule that rewrites a dimension records `preRule`.** That is the only reason a reader who does not hold the rule can undo it.
5. **`npm run tune` writes nothing.** A script suggesting a change is not the same as a person deciding on one, and the `amendments` array exists so every departure from the spec is explained by whoever made it.
6. **Only `web/` is ever served**, and only through `bin/site.mjs` with its scan intact.
7. **The site-scan allowlist stays one exact literal string.**
8. **The user-agent stays honest.**
9. **A disabled source is never deleted.** The `disabledReason` records the measured count, which says what would have to change for the decision to change.
10. **New bands arrive `descriptiveOnly` and last in the pick order**, so vocabulary can grow without moving a single existing number.
11. **The app must open, read and rank with no network and no account.** The Firebase SDK is not bundled, not preloaded and not imported at start.
12. **Do not measure a source's yield in extractions.** Reactor scored 22 of 29, the best rate in the registry, and was mostly television. Measure in books.

---

## 11. Hard-won lessons, condensed

- **Three things that looked like IP blocks were not.** A dishonest user-agent, then a missing Google Books key, then a burst rate limit given up on after one 429. Anything on this project that looks like an IP block should be assumed to be something else until measured.
- **`bin/build.mjs` has thrown a stack trace and exited 0.** Check the output, never the exit code.
- **Ask a site where its feed is** rather than guessing `/feed` and `/rss`. The `<link rel="alternate">` in the head is authoritative, and it found Boston Review's real path, Haymarket's, and that the TLS has moved to `the-tls.com`.
- **A device-verification wall is not an IP problem** and does not change with your address. `check-sources.mjs` distinguishes it from a CAPTCHA interstitial and a bare 403 for exactly that reason, and nothing here tries to work around one.
- **Google Books answers 429 on a burst and 200 a minute later.** Distinguish a spent daily quota from a burst before disabling a source for a whole run.
- **A working API key can let bad data back in through a door that was already unlocked.** The `italics-corroborated` tier tests relevance, not book-ness; the existence gate caught the rest until Google started corroborating authorless titles.

---

## 12. Documentation drift

Found while writing this. None of it is a bug, but an engineer trusting the prose over the JSON will be wrong.

- **`SCORING.md` describes the evidence rule as "55 of the 100 points of weight" and a "five-dimension bar".** `profile/taste-profile.json` sets `evidenceRule.minWeight` to **30**, and `total.mjs` measures by weight only — there is no dimension-count test. The 30-point bar is deliberate and its own note says so: a PW notice firing two or three dimensions is worth hearing about, and the alternative was never hearing about it. The `cap` of 69 (6.9 out of ten) is unchanged and correct in both. **The JSON is authoritative.**
- **`SCORING.md` says the prose floor is "implemented at 1 or below on the estimated scale".** The JSON sets `proseFloor.maxBandScore` to **2**, and its own note says 2. **The JSON is authoritative.**
- **`SCORING.md` says "nineteen sources" and lists nineteen.** The registry holds 84 with 54 enabled. `DESIGN.md` says 54 of 84.
- **`SCORING.md` is headed "# Review Feed"** and refers to the app by no name. The app is Constant Reader.
- **Book counts drift across all three documents** (291, 692, 801, 874 appear in different places) because each was written after a different build. Treat every count as a dated snapshot; the live number is whatever the last build printed.
- **`bin/build.mjs`'s `--no-google` and `--no-ratings` flags are undocumented** in both the file header and `SCORING.md`.

Fixing these is a small, safe first commit for whoever takes this over, and a good way to read the profile JSON closely.

---

## 13. Open work, in priority order

1. **Listed versus scored in one feed.** Roughly half the archive has no score and the two interleave by date, so a run of unscored books pushes scored ones down. Collections answers this for the landing screen — every shelf leads with scored books — and *All books* gives the unscored pool its own address, but the feed itself still needs a view, a toggle or a sort rule.
2. **No extraction test suite.** See §9. This is the largest structural gap.
3. **BookPage and the Christian Science Monitor** review constantly and yield nothing: their titles sit unmarked in plain-text descriptions. An article parser would fix both. The `possessive-quoted` tier in `fromGenericText` was added for exactly this shape and found nothing for either.
4. **Page count is unknown for most books published this year.** It no longer drags the score, since unfired dimensions are renormalised away, but it does mean one fewer dimension toward the evidence bar. It resolves itself as catalogues catch up.
5. **Short standfirsts are the binding limit on the whole thing.** A Guardian review gives a paragraph; an NYRB review gives several thousand words. Most rows in any given fortnight fire three or four of the seven dimensions. Expect the recommended count to be low and sometimes zero — that is the evidence bar working, not an empty feed.
6. **Native iOS** was costed at two to three weeks and deferred. The only thing it bought was CloudKit sync, and Firebase now does that across every browser rather than only Apple's, so the case is weaker than when it was deferred.
7. **Reader consensus** is thin. Goodreads retired its RSS feeds and has no public API; StoryGraph, LibraryThing, Bookshop and Shepherd all 403 automated clients. Open Library's ratings are wired in and sparse. If reader consensus matters more later, the honest route is a Goodreads export rather than a scrape.

---

## 14. What not to do

- Do not redesign the UI without being asked. `DESIGN.md` is the contract and it carries the reasons.
- Do not add a source without measuring what it yields **in books**, and do not enable one that answers well but files essays.
- Do not let a publisher's own words score a book.
- Do not delete a disabled source.
- Do not widen the site-scan allowlist.
- Do not put the Google Books key in an environment variable.
- Do not add a network sink to analytics; the footer promises everything a reader does stays in their browser.
- Do not reach for an image pipeline outside Open Library and Google Books; the published site is a static file and a JSON blob, and that guarantee is worth more than the missing 20% of covers.
- Do not move a weight without adding a line to the `amendments` array explaining who decided and why.
