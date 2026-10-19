# Review Feed

A feed of every book the literary press reviewed, published in the last ten years, each one scored out of ten against revision 2 of the reading taste profile.

**The unit is the book, not the review.** Three publications on the same novel is one row carrying three mentions, scored in a single pass over all three texts. That is not tidiness — evidence about a book is cumulative, and one standfirst is not enough to read a book by. It reads the publications, works out which book each review is actually about, resolves that book to a publication date and a page count, scores it, writes a short read on how it sits against the profile, and sorts on review date and on the book's own publication date.

The feed does not filter on taste. Everything in the window is there, scored, whether it is close to the profile or nowhere near it. Anything scoring **7 or above** carries a **Recommended** tag, and the tag is a filter: click it on a row, or the counter above the feed, to see only those.

## Running it

```bash
npm run calibrate   # check the scorer still agrees with the profile's own §11 answers
npm run build       # read the publications, resolve, score, write web/data/feed.json
npm start           # serve the app at http://localhost:4123
```

No dependencies, no install step. `npm run build` takes a few minutes on a cold cache and seconds afterwards; `--fresh` ignores the cache, `--source=nyrb` does one publication, `--no-articles` skips the per-review page fetches.

## What it reads

Nineteen sources: Publishers Weekly, Book Marks, NYRB, the LRB, LARB, the New Yorker, the Guardian's fiction desk, the NYT Book Review, the Atlantic, the Paris Review, the Chicago and Cleveland Reviews of Books, the LA Times, Full Stop, Electric Literature, The Millions, Kirkus, Bookforum and 4Columns.

**Book Marks is the consensus signal.** Lit Hub's review aggregator publishes a weekly Best Reviewed list, and one post is a dozen books rather than one — each line carrying title, author, publisher and a tally of how the critics landed ("4 Rave, 1 Positive"). That tally becomes a tag you can gather on.

On reader opinion specifically: Goodreads retired its RSS feeds and has no public API, and StoryGraph, LibraryThing, Bookshop and Shepherd all refuse automated clients outright — each returns 403. What remains reachable is Open Library's ratings, which are wired in but thin (eight books in the current archive, mostly single ratings), and Reddit's r/books feed, which parses but is overwhelmingly news links and FAQ threads rather than anything a book can be identified from. If reader consensus matters more later, the honest route is a Goodreads export rather than a scrape.

**Publishers Weekly is the odd one out and the important one.** The literary press tells you whether a book is any good; PW tells you it exists. It reviews nearly everything the trade publishes, and every review page prints the publisher, the page count and the ISBN — precisely the two dimensions, scale and provenance, that the catalogue leaves dark for a book published this year. Its reviews are short, so PW rarely carries a book on its own merits. Its value is that it merges: a PW notice and an NYRB essay on the same novel become one row with the NYRB's prose and PW's metadata, and that combination is what clears the evidence bar. PW reviews two or three months ahead of publication and the literary press reviews at publication, so the overlap is near zero in any single fortnight and accumulates as the archive deepens.

**Bookforum and 4Columns come in through HTML rather than a feed, and both beat the feed they replace.** Bookforum runs on Nuxt and ships its whole page state as a minified function call, `window.__NUXT__=(function(a,b,c,…){…}(…))`, with repeated values hoisted into the parameter list — a field can read `publicationDate:w` and mean the string at position 22 of the argument list. Rebuilding that map is worth the trouble, because the payload carries a `publications` array with title, author, publisher, ISBN and page count, plus the entire review body. Thirty-three of its thirty-five extractions carry a page count and all thirty-five carry a publisher. 4Columns publishes its whole run as one server-rendered archive table — date, category, critic and title per row — so the Literature, Nonfiction, Poetry and Graphic Novels rows are picked before any article is fetched, and each review opens with a bibliographic line giving publisher and extent. Its twenty-seven extractions are complete on both.

One thing Bookforum's structure will not tell you: its `/fiction` desk covers writing *about* fiction as well as fiction itself, so a study of literary agents sits there beside the novels. The index says which desk commissioned the review, not what kind of book is under it, and nothing here reads it as a genre claim.

Seven more are in `sources.json` marked `enabled: false` with the reason, rather than deleted. Four are off for technical reasons and three for editorial ones, and the distinction is recorded as `disabledKind` so the checker never proposes re-enabling a feed that was switched off on purpose.

The Baffler, n+1 and Public Books fail in ways consistent with IP reputation — a bare 403 and two CAPTCHA interstitials — so they stand a fair chance of answering from a home connection. **The TLS is different**: its `/rss` path returns a device-verification wall, which is the publisher deliberately blocking automated clients rather than blocking a datacentre. That does not change with your IP, and nothing here tries to work around it.

Harper's, the New Republic and Lit Hub all answer fine. They are off because their feeds are essays, politics and daily round-ups rather than reviews, and enabling them adds noise rather than coverage.

## Finding the book

This is the hard part and the part most likely to be wrong. Three tiers, and the app tells you which one it used for every row.

NYRB and the LRB publish a book-under-review block on the article page, so those give title, author, translator, publisher and page count outright — the LRB even distinguishes a book review from a film review in its markup. The Guardian, Kirkus and Full Stop each have a house title format that parses without touching the article. Everything else falls back to italicised titles and "by" patterns in the review's own prose, which is where confidence drops, and those rows are marked **book unverified** and kept out of the recommendation lanes unless the catalogue confirms them.

Open Library then supplies first publication year, page count, publisher and subject headings. It is weak on books published in the last few months, which is most of a review feed, so the review's own metadata always wins and Google Books fills remaining gaps. Google Books is rate-limited per IP and was unreachable from the machine this was built on, so that path is implemented and its failure behaviour is verified, but its success path has not been exercised — expect it to fill in a good number of page counts on your machine, and to say so in the build summary if it stops answering.

## The score, and the tag

Seven and above is not an arbitrary line. The profile's own §11 sets the acquire floor at 70 out of 100, so 7.0 out of 10 is exactly the point the twelve books already acquired all clear. The calibration proves it: run `npm run calibrate` and every one of them scores 7.0 or better.

**The profile scores; it does not exclude.** §4 of the document lists six hard filters as auto-excludes. On Michael's instruction they are now heavy negatives instead — nonfiction −45, satire and Pynchon −30, book-club positioning −20, a resolving twist −15, contemporary-and-causally-sealed −10. Detection is unchanged and the row still names which rule fired; only the consequence changed. A nonfiction book gets a real number, it is just a low one, and it stays visible and sortable. The penalties are sized so nothing carrying one can reach the recommendation threshold: a fixture firing every dimension the profile has still lands at 4.6 once the nonfiction penalty applies.

One consequence worth stating plainly: with nothing excluded and no fiction gate, the nonfiction *detector* matters more than it did, not less. A miss now means a nonfiction book can be recommended rather than merely shown.

A score is a claim, so two things gate the tag on top of the number. The book has to be **identified** — a title lifted out of loose prose matching cannot be recommended, whatever it scores. And it has to have been read on **enough of the profile to mean it** — 55 of the 100 points of weight. Rows failing either are still scored and still shown, with the reason stated on the row.

There is no longer a fiction gate. Requiring positive proof that a book was fiction, on top of penalising known nonfiction, was holding back 71 books for a fact about metadata rather than about the book.

Two rules keep the number honest where the evidence is thin. A dimension that never fired is **not** scored as a default — D6 falling to 4 because no catalogue has recorded the page count is a fourteen-point penalty for a fact about the catalogue, so the score is renormalised over the dimensions that actually fired. But renormalising a thin row lets the few that fired carry the whole number, and a book read on four dimensions could otherwise show a perfect ten, so anything below the five-dimension bar is **capped at 6.9**. It can be scored and read. It cannot be claimed.

Where nothing fired at all, there is no score — the row says so rather than showing a number assembled entirely from defaults.

## The read on each book

Every identified book carries a sentence or two on how it sits against the profile: what it has that the profile wants, what drags, and which of the twelve confirmed acquisitions it sits nearest to. That last one is a weighted distance across the seven dimensions, not a subject match, and it is withheld when the evidence is thin — an anchor computed from mostly-defaulted dimensions describes the defaults, not the book.

None of it is model-generated at build time. The phrasing lives in `profile/phrases.json` and is editable like everything else in `profile/`; the sentence and the number are built from the same bands, so they cannot disagree.

## Scoring

The source document is `profile/reading-taste-profile.md`, kept beside its encoding so the two can be diffed. Everything the profile specifies lives in `profile/`, not in code. `taste-profile.json` holds the weights, the bands, the hard filters, the soft penalties and the thresholds; `lexicons.json` holds the terms each band fires on; `calibration.json` holds the §11 set. Change a weight there and re-run `npm run calibrate`.

Three rules in the profile are not a weighted sum and are implemented separately. The **prose floor** (Trap 3) caps a book into Reserve when a review names the prose as its weakness, however good the architecture is — that is the entire difference between Ohio and The Deluge. The **land-scale demotion** (Trap 4) drops the subject engine from 10 to 6 when the land subject is exact but nothing institutional or multi-decade stands behind it, which is Homestead and Damnation Spring. And the **twist override** scores a formal device at 3 rather than 9 when the review says it resolves, which is Trust.

One rule has been amended since revision 2 of the document. The profile's §5 penalises a redemptive ending a flat ten points; Michael's tuning is that a warm ending is not disqualifying unless it is cliched or obvious. So the penalty is now three-tiered: the full ten when the review calls the resolution sentimental, tidy, telegraphed or unearned; nothing at all when the review marks the warmth as costly, resisted or strange; and three points, flagged on the row rather than buried, when the review says neither. Warmth that costs nothing still shows on the row as a note, because it is a fact about the book worth seeing. D5's tonal bands are untouched — this is about how a book ends, not its overall register. The amendment and its provenance are recorded in `taste-profile.json`; a revision 3 of the document should absorb it.

Two calibration decisions are worth knowing. The keyword estimate of prose register runs about two points below the profile's own hand-scores, so the floor is implemented at 1 or below on the estimated scale rather than at 5 — the note in `taste-profile.json` says so at the point of use. And a dimension needs two distinct terms to earn its top bands, one to earn the rest, except for a curated set of decisive phrases — "water rights", "no protagonist", "martial law" — that settle a band alone.

`npm run calibrate` runs the §11 set and enforces the profile's own tolerance: every acquisition at 70 or above, every pass at 65 or below. All 23 scored fixtures are inside it. It then runs `profile/rule-tests.json`, which covers behaviour the §11 set cannot reach — all three of its redemptive-ending fixtures are hard-filtered before the penalty can matter, so that rule was effectively untested until those cases existed. Each rule test differs from its neighbour in one respect only. Manhattan Beach, the one deliberate borderline, lands at 70.4 — the model reads formal ambition as a strong preference rather than a hard requirement, which is §10.4 still open rather than an answer.

**What that number does not mean.** The calibration fixtures are 24 hand-labelled books whose descriptive text was written to sit in the register of review copy. It tests the weights and the band mapping. It does not test extraction, and it is fitted to a set small enough that §12's warning applies directly: correlation in the positive set is not a criterion until the dimension has been varied against a controlled slate. Treat a score as triage — a reason to read the review, not a reading of the book. Every dimension shows the terms it fired on precisely so a wrong score is visible as a wrong score.

## Using it

Sorting takes a primary and a secondary key, so review date then book publication date is the default and either can lead. Filters cover publication, the rolling ten-year window, minimum score, minimum page count, and free text.

Two switches are on by default. **Inside the ten-year window** applies the timescale; out-of-window titles are flagged rather than suppressed when you turn it off, as §9 asks. **Hide catalogued nonfiction** keeps out what the catalogue, the title or the publication's own section tags establish as not a novel — the profile hard-filters nonfiction. Everything else shows: books whose fiction status is unknown, books whose identification is loose, books that score 2.

**Only where the book is identified** is off by default and worth turning on when the noise gets tiring. **Group by subject engine** switches the list to the format the profile records as having the best acquisition rate of anything tried.

Save and Pass write to your browser, and to a document in your own Google account if you sign in. Sign-in is optional, off by default, and the Firebase SDK is not fetched at all until you ask for it, so the app opens and ranks with no network and no account. **Export my verdicts** produces a JSON file with the verdict, the book's metadata and the seven dimension scores for each — which is the input a revision 3 of the profile would want, since revealed preference is the highest-value signal in it.

## Saved books, and finding a copy

The feed always had two verdicts per book, saved and passed, kept in this browser's `localStorage`. **Saved Books** is that same list given a screen of its own, reachable from the masthead, sorted by when it was saved, by title or by author. It is one list, not a second one: a parallel store would let the two disagree about what is saved, so the existing record was widened to carry a timestamp and anything written by an earlier build is migrated on read. A save from before timestamps existed keeps its save and sorts last under *recently saved*, rather than being given a date it never had.

Uniqueness is structural. The record is an object keyed by book id, so the same book cannot occupy two rows and saving twice is an overwrite rather than a duplicate — and a repeat save keeps the *first* timestamp, because that is when the decision was made.

Saving is optimistic: the list changes and the screen redraws first, and only then is the write attempted. `localStorage` genuinely fails — private mode, a full quota — so when it throws, the previous list goes back exactly as it was, the reader is told, and the same action is offered again as a retry.

**Find a copy** opens a chooser under the row with Amazon, ThriftBooks, AbeBooks and Bookshop.org, in that order, each link built from the most precise identifier the book carries: a verified ASIN, then ISBN-13, ISBN-10, title and author, and finally title alone. All four are always listed; the last one used moves to the front next time. Nothing here fetches a retailer page, quotes a price, claims a book is in stock, or touches a cart, and no retailer offers a supported way for a third party to write to a wish list, so there is no wish-list sync either. The chooser expands inline rather than opening a modal, because `DESIGN.md` says this app opens none.

Every URL format lives in `web/lib/retailers.mjs` and nowhere else, because those formats belong to somebody else and will rot. They were checked against the live sites on 2026-08-25: ThriftBooks' `?b.search=` 302-redirects to the work page, and both AbeBooks forms answer 200. Amazon's `/s?k=` answers 503 to a datacentre IP, which is Amazon throttling search for bots rather than a wrong path. Bookshop.org answers 403 to every HTML request from here behind a Cloudflare challenge, so its response body could not be read — but its `/search?keywords=` **301-redirects to `/beta-search?keywords=`**, which is the server naming its own preferred path, and that is the one used.

Only 116 of 291 books currently carry an ISBN-13, which is what Bookshop.org needs to deep-link rather than search. That number is a fact about the sources: PW, Bookforum and 4Columns print an ISBN in their metadata blocks and the rest do not, and Open Library only fills the gap for books it has catalogued. A valid ISBN-10 is converted locally where one is available — but the link still reports itself as `isbn10` to analytics, because the question that number answers is what the *catalogue* is carrying, and collapsing the two would make every ISBN-10 in the feed look like an ISBN-13.

Events are recorded to `localStorage` and never sent anywhere. The app had no analytics before this and a network sink would contradict the footer's promise that everything a reader does stays in their browser; it is still worth recording, because "how often do I go looking for a copy, and does the score predict it" is a question about the profile. Only the properties each event declares are kept, so an outbound URL or a retailer account cannot be recorded by accident.

No affiliate programme has been approved for this app, so every link goes out clean. `decorate()` refuses to write an empty tracking parameter, which would be a broken parameter on every outbound link rather than a harmless no-op.

## Saving tunes the score

Borrowed, deliberately, from Acetate Club — the music app in the sibling repo, whose recommender ranks new releases by similarity to the records in your crate and tells you which one it matched: *"because this sounds like X."* Its crate modal puts the thesis plainly: **your crate isn't just a list to save, it's the engine.** Four of its mechanics carry over more or less intact.

Nearest-neighbour against the saved set rather than a fixed reference. A bounded penalty for the clusters you keep dismissing — Acetate scales its by the most-dismissed cluster and caps the effect at 45%, so one loud cluster cannot zero everything out; here the same idea runs symmetrically, since passing on a book teaches as much as saving one. And naming the match, which is the part that makes a recommendation legible instead of oracular.

**Saved books are scored too, and held out of their own scoring.** Acetate drops the crate from its candidate set — it is recommending records you do not have. This feed is not a recommendation list but a scored record of everything reviewed, so a saved book with no visible score is a score you cannot check, and an outlier inside your own collection is exactly the thing worth seeing. But a book cannot be allowed to vote for itself: each save is roughly a tenth of its own evidence, and scoring saves against a model they helped build inflated them by 1.3 points on average and 2.2 at worst — putting your own collection at the top of the feed by construction. So each judged book is scored against a model rebuilt without it, cached by id and thrown away whenever the verdicts change. The row says which comparison it made: *from your saves* on a book you have not ruled on, *vs your other saves* on one you have. Holding a book out can drop the rest below the three-save floor, which is why a saved book keeps the profile's own number until there are four saves to spare one from.

**One thing deliberately does not carry over.** A comment at the top of Acetate's recommender reads: *"the watchlist is the entire taste signal. No persistent profile exists beyond it."* That is right there and wrong here. This app has a written profile at revision 2, seven weighted dimensions, twelve confirmed acquisitions and a twenty-four-fixture calibration suite. Ten saves should not outvote that. So the profile is the prior and the saves are a bounded correction to it: the base score is never overwritten, the adjustment is capped at ±0.8 out of ten, and both numbers are on the row.

It runs in the browser, on every render. That is what makes a save feel like it did something — the feed re-ranks immediately, with no rebuild and no server, and the state it learns from is the saved list that was already being persisted.

Three components, from a `MIN_SIGNAL` floor of three saves:

- **Tag affinity**, from saves and passes both, each measured against how often the tag was available to be saved rather than against a raw count. Only nine of the fourteen tag kinds are learnable: 127 of the feed's 186 tags are publisher imprints, nearly all on one or two books, and letting them in produced the model's first bad idea — *"you pass on books tagged HQ Digital"*, learned from a single pass.
- **Dimension tilt**, the one component that says something about the profile rather than about a book: where the books you save run hotter or cooler than the field. A dimension fewer than four of your saves have evidence for is left out rather than guessed at.
- **Author affinity**, a small nudge for a surname you have saved before.

Plus the anchor — *"reads like X, which you saved"* — which carries no points, and is withheld when the model is demoting the book, because *runs against your saves* and *reads like something you saved* in the same breath is a contradiction the reader is right to distrust.

The tuning scales with evidence: a book read on one dimension moves less than one read on six. That was wrong in the first draft, which divided by the fired weight rather than by the whole profile and so tuned the thinnest books hardest — exactly backwards. Against the current feed, roughly half the books move by less than a third of a point, none move by more than half the cap, and nothing the profile penalised is tuned back over the recommendation line.

**Weights are a different matter, and this will not touch them.** `npm run tune` reads an exported verdicts file, prints the weight changes your saves argue for, re-scores all twenty-four calibration fixtures under the proposal, and shows what would break. It writes nothing. An earlier draft had an `--apply` flag; it was removed after a test run silently rewrote `taste-profile.json` through `JSON.stringify` — reformatting a hand-commented document and leaving no amendment behind. The profile has an `amendments` array precisely because every departure from the original spec is supposed to be explained by whoever made it, and a script suggesting a change is not the same as a person deciding on one.

## Known limits

Short standfirsts are thin evidence, and it is the binding limit on this whole thing. A Guardian review gives a paragraph; an NYRB review gives several thousand words. Most rows in any given fortnight fire three or four of the seven dimensions, which caps them at 6.9 and keeps them out of the recommendations by design. Expect the recommended count to be low and sometimes zero — that is the evidence bar doing its job, not an empty feed.

Page count is unknown for most books published this year. It no longer drags the score, since unfired dimensions are renormalised away rather than defaulted, but a missing page count does mean one fewer dimension toward the five-dimension bar. It resolves itself as the catalogues catch up, or as Google Books answers from your machine.

The feed accumulates. Most of these publications carry ten to twenty items, a fortnight at most, so `data/store.json` keeps everything seen and each run merges in what is new. Sorting by book publication date only gets interesting once there is a back catalogue to sort, which means running the build on a schedule. Verdicts and first-seen dates survive a rebuild; everything derived is recomputed, so a change to the scorer reaches the whole archive at once.

Build output is not committed — `.cache/`, `data/` and `web/data/` are ignored, since the archive grows with every run. A fresh clone needs one `npm run build` before the app has anything to show, and it says so on screen if you forget.

Nothing here judges a book. It reads what critics wrote about it and matches that against a document describing what has been acquired before.
