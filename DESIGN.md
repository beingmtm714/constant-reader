# DESIGN.md

Rewritten 2026-08-30, when the app became the jewel editorial desk. The light celadon system this replaced is gone: its palette, its top masthead, its dock and its inline detail panel are all superseded, and nothing below describes them. The accessibility review at the end is kept as history and says which shell it audited.

## The name and the mark

**Constant Reader.** Dorothy Parker's byline for the *New Yorker* book column, 1927 to 1933, under which she reviewed weekly and took most of them apart. A phrase rather than a person, so it makes no claim on an estate the way a surname would, and it names the reader instead of the critic, which is what this is: not a critic issuing verdicts, but one reader who keeps showing up and has opinions about all of it. That "constant" also describes a cron job at 06:20 is the other half of the joke.

**The mark is the beveled CR monogram.** A garnet tile, a brass hairline, an inset porcelain frame, and the two letters cut on the diagonal the way a bookplate sets them — C raised to the left, R dropped to the right. It is drawn in paths, it is the same drawing in the masthead, the favicon and the home-screen icon, and it ships as one `<symbol>` in the icon sprite so the tab and the page can never disagree.

The three raster icons are generated from `web/icons/cr-appicon.svg`, which carries a full-bleed lacquer ground so the maskable one has no transparent corner to crop into. Regenerate them with:

    qlmanage -t -s 512 -o /tmp web/icons/cr-appicon.svg
    cp /tmp/cr-appicon.svg.png web/icons/constant-reader-512.png
    sips -z 192 192 web/icons/constant-reader-512.png --out web/icons/constant-reader-192.png
    sips -z 180 180 web/icons/constant-reader-512.png --out web/icons/constant-reader-180.png

The illustrated book-on-a-table mark is retired. It was a picture where the rest of the system is type, it needed two raster files to follow the theme, and at 16px it was a grey blob. A monogram is legible at every size the app uses it at and can be recoloured from the token table like everything else.

**The wordmark is the full name, at every width.** Desktop sets it in the display face over a mono subtitle, `INDEPENDENT READING INTELLIGENCE`. Mobile drops the subtitle and keeps the mark and the name. It never truncates and it never steps back to the mark alone: 60px of header at 320px holds both, which is the whole reason the header exists rather than a three-part masthead.

## The direction

Read this before writing any UI code in this repository. It is the single source of truth for visual style here.

It is a private reading instrument and it should look like a private literary desk rather than a commerce catalogue. Editorial, dense, typographic, quiet. The score is a judgment set in type, never a gauge.

**A New York magazine office at two in the morning, 1929, with the lamp off.** Bottle-green lacquer, oxidised brass, a garnet proof mark, porcelain stock. Dark jewel grounds carry the shelves — malachite, lapis, garnet, olive — and they alternate, because a shelf of one colour stops reading as a shelf and starts reading as a table.

**One theme.** The palette is the design rather than a preference, so a device set to light gets the same lacquer. The theme toggle is gone and `color-scheme` is `dark`, full stop. There is no second table to keep in sync and no second set of contrast measurements to maintain.

Legibility outranks the reference. Nothing here is dark for atmosphere.

## Color

| Token | Value | Use |
|---|---:|---|
| `--paper` | `#182526` | Page canvas |
| `--lacquer` | `#132624` | Sidebar, mobile chrome, deep panels |
| `--porcelain` | `#eee9dd` | Primary headings and bright text |
| `--ink` | `#e9e4d8` | Body foreground |
| `--graphite` | `#c4bdae` | Secondary copy |
| `--muted-ink` | `#9c978c` | Metadata |
| `--brass` | `#b69a62` | Ornamental rules, eyebrows, premium borders |
| `--oxblood` | `#c38994` | Links, score numerals, the focus ring |
| `--oxblood-rich` | `#744451` | The mark's ground |
| `--garnet` | `#4e1d2a` | Hero and one card family |
| `--malachite` | `#143429` | Green card family |
| `--petrol-deep` | `#213a37` | Active navigation, dashboards, dark green surfaces |
| `--lapis` | `#1c304a` | Blue card family |
| `--lapis-line` | `#7d97bd` | The nonfiction rule on the taste chips |
| `--olive-jade` | `#243012` | Olive card family |
| `--hairline` | `#c4bdae2e` | Default dividers |
| `--hairline-dark` | `#c4bdae57` | Stronger dividers, control borders |
| `--destructive` | `#d46868` | Destructive feedback only |

**Brass sets eyebrows and rules and nothing longer.** The old rule was that brass sets no type at any size, for the reason gilt did not: a metallic dark enough to read stops looking like metal. On these grounds it clears comfortably at label sizes, so it carries the mono eyebrow, which is four words. It never sets a sentence and never sets body copy.

**State is never colour alone.** A recommendation carries the word, a save carries a filled bookmark and a changed accessible name, a switch carries its `aria-checked`.

**The four shelf grounds were re-cut, 2026-09-06.** An axe-core pass found 85 failing instances of `--brass`, `--oxblood` and `--graphite` text against all four - none of the originals cleared 4.5:1. Deepened and re-saturated in HSL rather than just darkened toward black (roughly +20 points of saturation, -10 to -15 of lightness, hue held): a jewel tone is exactly that combination, and it is also what buys the contrast a flat darken alone would not - a version tried at the old saturation still needed the backgrounds pushed nearly black to clear 4.5:1, indistinguishable from each other and from the page. All three text tokens now clear 4.6:1 or better against all four grounds, unchanged.

## Typography

Four faces, four jobs, and the division never breaks.

- Display: `"Bodoni 72", "Bodoni MT", "Bodoni Moda", Didot, "Iowan Old Style", Georgia, serif`
- Editorial text: `"Source Serif 4", Charter, "Bitstream Charter", "Sitka Text", Georgia, serif`
- Interface: `"IBM Plex Sans", "Avenir Next", Avenir, "Helvetica Neue", Helvetica, Arial, sans-serif`
- Metadata: `"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace`

The stacks are local-first, and Bodoni 72 ships only on macOS. Bodoni Moda, Source Serif 4 and IBM Plex Sans are also fetched from Google Fonts, because without them a Windows or Android reader gets Georgia in all three slots and the division collapses into one face. Nothing in the layout depends on them arriving.

Display headings take tight leading and negative tracking: `.95` to `1.05`, `-.02em` to `-.03em`. The page H1 runs to 68px at 1440 and clamps down to 38px at 320. Labels and metadata are uppercase mono at 8–10px with `.11em` to `.16em` of tracking, and they are short by construction. Body copy is the editorial serif at 15–17px. Every control is the interface sans.

**Scores are set, not reported.** The numeral is Bodoni in oxblood with a mono `/ 10` beside it. It is editorial annotation and never a bar, a ring or a dial.

## Spacing, shape and ornament

Corner radius is `4px` on panels and cards and `0–2px` on controls. The Deco corner is a chamfer or a step, never an arc, and the one chamfer in the system is the clipped bottom-right corner of the spotlight.

Separation comes from hairlines and space, never elevation. The only shadows in the app are on cover images, where a jacket lying on a ground is the thing being drawn.

**Four ornamental devices, one place each.** A brass outer rule, an inset stepped border, a clipped corner and a small diamond — all on the spotlight and nowhere below it. A device used everywhere is not a device.

Forbidden: gradients, soft card shadows, glass effects, pill-heavy UI, bright white surfaces.

## Motion

Fast `120ms`, easing `cubic-bezier(0, 0, .25, 1)`. Transform and opacity only, and in practice colour and opacity are all that move. `prefers-reduced-motion: reduce` sets every duration to `0ms`.

Hover may raise contrast, reveal `View dossier` or strengthen a brass border. **Cards do not translate and nothing springs.** The machine age is the reference and its motion is mechanical.

## Copy register

Dry, short, declarative, willing to be unkind about a book. "Evidence too thin" is right. "This book may not be a strong match for your preferences" is not.

**Every change to a reader-facing string runs through `/final-draft` before it ships.** Not the code comments and not the commit message: the strings a reader sees, in `web/app.js`, `web/index.html` and the reason lines in `web/lib/search.mjs`. It is a copy register rather than a preference, and a register only holds if the same seven passes run on every sentence that joins it. The pass that earns its place here is the fourth: it checks every number against the source, which is how a dossier shipped saying a book lacked evidence "across the seven dimensions" while the row above it said eight.

**Every figure on screen is counted from the feed.** The review totals, the taste strip, the calibration dial. Nothing is written into the markup, because a number in the markup is a number that goes stale the next morning and nobody notices.

**A missing score is information, not a judgement**, and the copy says which kind: a review that gave too little dependable evidence, or a book no critic has reached. Neither is ever shown as a zero and neither is ever ordered against a number.

## The shell

**Desktop, 1024px and up.** A fixed 258px lacquer sidebar at full viewport height. Main content starts at 258px and is constrained to 1038px with 72px of breathing room inside the pane. The sidebar carries, in order: the mark and wordmark, seven sections, the profile status card, Sign in, and the local-save note. Active navigation is a petrol-deep field with porcelain text.

**Below 1024px.** A sticky 60px lacquer header with the full wordmark and one brass-outlined menu button. The menu expands beneath it with all seven sections and Sign in. A fixed 68px bar holds four of them in four equal columns — For you, Search, All books, Saved — and the page reserves bottom padding so the bar never covers a control. Review feed is reached from the menu instead: a fifth column at 320px gives every label 64px and truncates all four of the others to keep one.

**Seven sections over one book record.** For you, Search, Review feed, All books, Saved, Taste, Profile. Every section opens with the same editorial header — mono eyebrow, Bodoni H1, Source Serif introduction, optional right-aligned status — and closes with the shared colophon.

## Refusing a book is evidence

**For you had no way to refuse.** The feed row and the dossier have both carried a pass the whole time; the front page, which is where a reader actually meets a recommendation and so where a disagreement with it is worth the most, carried only a bookmark. There is a pass on the card and on the spotlight now.

**And a pass taught the model nothing until three saves existed.** `buildTasteModel` switched on at `saved.length >= MIN_SIGNAL` and at nothing else, so a reader who passed on twenty books in a row got twenty books hidden and not one score changed. Refusing twenty books is a strong statement about taste and it was being thrown away.

**It is two gates now, not one lowered gate**, because the halves of the model do not run on the same evidence.

- **Tag affinity is symmetric.** It already counted a pass as evidence against a tag. It runs at five verdicts of either kind.
- **The dimension tilt and the nearest-neighbour anchor need books you liked.** There is no such thing as the average of the books you refused standing in for a book you would want. They still wait for three saves, and `model.anchored` is the flag that says so.

Five passes and no saves moves 295 of 823 books, every one of them downward, each row naming the tag it was marked down for. Nothing can go up from passes alone, which is the correct and the honest result.

**More passes are asked for than saves — five against three — because a pass is weaker evidence.** A save says this one; a pass says not this one, and there are many more ways for a book to be wrong than right.

**The held sample backfills.** Passing a card on the blank-slate front page used to leave a hole in a shelf of eight, and a shelf with a hole in it reads as a fault rather than as the card having gone. A replacement is drawn and appended, so nothing already on screen moves.

## Why a book is where it is, in one plain sentence

Every line explaining a score used to be generated prose. Six sentence templates picked by a hash of the book's id — **"Strong on subject, and structure does not let it down"**, **"Subject carries it; structure holds the rest up"** — plus **"Your saves lift this: it runs with your saves on structure (D1), you save books tagged cities & housing."** Variety standing in for an explanation. Every one of them named a dimension the reader never chose, in a grammar that sounded like a judgement and carried none.

**One shape now, everywhere: `Because you [verb]: [tags]`.**

- `Because you saved: land & labour, sprawling`
- `Because you passed on: satire`
- `Because you picked: braided, land & labour, a novel`

The verb says where the evidence came from — what the reader saved, what they passed on, or what they picked when they built the profile — and all three are things the reader did and can check. The tags are the same words on the chips directly below the line, so the sentence and the chips agree instead of appearing to contradict each other.

**Where nothing the reader has said bears on the book**, the line says the most that can honestly be claimed and no more: "Read on subject and tone, none of which you have ruled on." It never invents a judgement to fill the space.


## The feed is one long list

**No pagination.** A button that said "Show 14 more of 812" made the reader ask for a shelf they were already looking at. The list grows as it is scrolled, 600px ahead of the reader so the next page is there before they arrive at it.

**The button is still in the document.** An infinite list that is only a scroll sentinel strands a keyboard, and a screen reader has nothing to announce; the button remains, visually hidden, becomes visible again on focus, and is what the scroll handler presses. One control, two ways to reach it.

**It is driven by scroll position rather than by an `IntersectionObserver`, and that is deliberate.** The observer is the tidier version and it was written first. It is also the one that can silently never fire — a zero-height viewport is enough — and a hidden button that is never pressed leaves a reader at the end of fourteen rows with no way to ask for more, which is worse than the button they started with. The throttle is a clock rather than a frame for the same reason: `requestAnimationFrame` does not run in a backgrounded tab, and a reader who switches away mid-scroll and back should not find a list that has stopped growing.

## Back is a gesture, so there has to be a history

The app pushed no history at all: every section swap and every dossier happened inside one entry, so a back swipe left the app and a forward swipe could not return.

**The URL is deliberately untouched.** Putting the section in a hash would make a copied address open on whatever screen the copier was looking at, and a link to this app has to open the app — the same reason the last session's view is not restored from storage. What is pushed is state, so back and forward work for the length of a visit and a shared address still opens the front.

**The dossier is an entry of its own**, which is the part that pays for itself: a book opened on a phone closes with the gesture the reader already uses rather than by finding a small × in a corner. Closing is going back — the ×, the scrim and Escape all pop the entry rather than hiding the panel, because a dossier closed without popping means the next back gesture reopens it.

## The home indicator is not padding

Every fixed thing at the bottom of the screen has to clear the strip a phone reserves for its home indicator, and the bar was doing the opposite of clearing it.

`* { box-sizing: border-box }` is set at the top of the stylesheet, so a `padding-bottom: env(safe-area-inset-bottom)` on an element with `height: 66px` comes **out of** the 66px rather than being added to it. On a phone reporting a 34px inset the icons and labels had 42px to live in instead of 67, and sat directly on the indicator.

**A bar is its controls plus the reservation, never its controls with the reservation taken out.** `height: calc(68px + env(safe-area-inset-bottom))`.

Three other things touch that edge and all three now clear it: the pane's bottom padding, so content is not hidden behind a bar that is taller than it says; the dossier, which is full-screen and whose last controls are Save and Pass; and the toast, which was positioned to clear the bar's old flat height.

**Verified by simulating a 34px inset** rather than by reading the rules: controls 67px, 34px of clear space below the labels, dossier padding 74px.

The top edge had the same bug in the opposite direction: `.topbar` was a flat `height: 60px` with no `env(safe-area-inset-top)` at all, so on a phone with a notch or Dynamic Island the bar sat under it rather than below it and the clock and signal icons overlapped the app's own header. Same fix, same reasoning, top instead of bottom: `height: calc(60px + env(safe-area-inset-top))` with the inset added as top padding rather than taken out of the 60px. The two sticky things that stack directly under the bar and assumed its old fixed height — `.menu-panel` and `#weekpick-slot` — get their `top` offset adjusted by the same `calc()` so they still land flush against it; the desktop-only `#weekpick-slot { top: 0 }` override is untouched, since there is no sticky header there to clear.

## A field re-created mid-keystroke is a field that just lost focus

The reader's own description of it was exact: the keyboard "works but works poorly" — slower and less responsive than typing anywhere else in iOS. It was not slow; it was closing. `#sq`, the ask-in-your-own-words field, is destroyed and rebuilt by `render()` on every view change the same as everything else on the page, and the search input handler already knew that and debounced the render so a keystroke would not blow away the node underneath the finger typing it. What it did not do, that the toolbar's own `#q` field (fixed for the identical symptom earlier) does do, is put the reader back in the field once the debounced render lands. So the field the reader was typing into stopped existing for a moment 180ms after they paused, a new one took its place, and nothing told the browser to focus it — which on iOS is indistinguishable from the keyboard being dismissed. Landing back on the dismissed keyboard's old position was itself landing on whatever had reflowed into that space once the keyboard closed, which on the Search screen is the bottom tab bar — so a reader trying to tap back into the field, or trying to hit Return again, could just as easily hit "For You" instead. One bug, two symptoms.

Fixed the same way `#q` was: `go()`, the function that actually runs the search and re-renders, checks `document.activeElement` immediately before it calls `render()` — not at the keystroke, since a submit blurs the field on purpose first and that has to stick — and if the field it is about to destroy is the one focused, it puts the new one's focus and caret back where they were once the render lands.

## Card spacing

The card had no rhythm. `.card-body` set a 5px flex gap and then every child brought its own margin — 8 under the source, 9 above the blurb, 10 above the tags, 5 above the line at the bottom — and `.card-author` was a `<p>` that had kept the browser's 1em default, which opened **the widest gap in the card between the title and the author**, the tightest pair in it.

One rhythm now, set in one place, and nothing else inside the card may set a margin: 6 under the eyebrow, 3 between title and author because they are one unit, then an even 12 between the blocks that are separate thoughts.

**The shelf stays one column on a phone, and two was tried and reverted.** Two columns fit three books to a screen instead of one, and they made the shelf look untidy: a card is as tall as its own title, blurb and tags, no two are the same length, so a two-up grid is a row of ragged bottoms and the eye reads the raggedness before it reads the books. A single column has nothing to be ragged against. The tall card is the price and it is the right one.

## The tags in the sentence are the tags on the row

`Because you picked: braided, land & labour, a novel` — each of those is a button, and following one filters to it exactly as the chips below the line do. A line that names the reason a book is here and then makes the reader find that word again among the chips is asking them to do the app's work.

They are set as part of the sentence rather than as chips dropped into the middle of it: a brass underline, the sentence's own size and weight.

## A pass has to look like a pass

`setVerdict` is a toggle — set a verdict that is already set and it clears. The pass button on a card shipped without saying so, and **All books keeps passed books on purpose**, being a record rather than an opinion. So a reader who pressed × on a book already passed silently un-passed it, and it came back to the feed with nothing on screen having changed.

Every pass control now carries its state: the card's × becomes a way back, the row's button reads "Passed", the dossier's reads "Passed — put it back". The second press still clears the verdict, which is right, but it is now a labelled action rather than a surprise.

## What a stranger is told

The blank-slate rule — that nothing claiming to be about the reader is shown before there is a reader — was applied to the views and not to the two dialogs or to the copy around them. Six places had drifted out of true.

**The first-visit dialog was arguing with the page behind it.** It said "These scores aren't yours yet" and "Everything here is ranked against one reader's taste profile". Both were true before the app became a blank slate. Neither is now: a reader who has answered nothing sees no scores at all, and every list is in the order the press filed it — which the page underneath states in as many words. It says that instead.

**Its sign-in button signs in and then opens the builder**, and that order is the point: answer the three questions with an account already attached and the profile is kept from the first answer, rather than the reader being asked a second time once they have something to lose. An account is what makes a taste profile outlive this browser and follow a reader to another one — so the button says that, "Sign in first, so it is kept", rather than naming a flow.

Between the two buttons the whole proposition is stated: the first gives you recommendations, the second keeps them.

**Two lines still described a random eight that no longer exists.** "Reload for a different eight" and "these eight lean" were written when the front page had nothing to show a stranger but a random sample. It leads with the week's reviews now, so the sample is gone and forty-four lines of code with it.

**"Until you answer they belong to the reader this was built for"** is a fact about how the app was made, not about anything a stranger can see or act on.

Also: an em dash the house style forbids, "export" offered to someone with an empty shelf, "press return to close the keyboard" on a desktop, and a dialog promising the feed would open "on your phone" to a reader holding one.

## For you opens on what changed

**The front page was the same every morning, and that was structural rather than a data problem.** `edit()` sorts strictly by score, so the top of the page was the highest-scoring book in the whole archive followed by the next four. That set only moves when something outscores it, which is roughly weekly whatever arrives.

Measured against the feed: the desks file about **17 reviews a day** into this archive and **8 of them are books it has never seen**. There was material to show and the page was not showing it.

**The page now opens on what the press wrote since the reader was last here**, ordered by fit. `lastReviewed` rather than `firstReviewed`, because a book reviewed a month ago that got a second review last night is news too, and the second review is often the more interesting one.

**The cutoff does not advance on a reload.** Two keys are stored, the visit and the cutoff it is drawing against, and the cutoff only moves when a visit is an hour or more after the last. Refresh five minutes later and the same books are still new. A gap of more than a fortnight is capped, because coming back after a month should open on a readable page rather than four hundred books.

## Critics before the author's own account

The list of what arrived is ordered by fit, and that buried the thing a reader opens the app for. Measured over two days of arrivals: **9 critic reviews against 12 author accounts** — the New Books Network files interviews faster than any desk files reviews — so a podcast interview that happened to score higher sat above the New York Times.

`lib/sources.mjs` is already explicit that these are different classes of text: a critic on a book they have read is the only text allowed to say whether it is any good, and an author describing their own book says what it is about and cannot say that. The order now follows that: **critics first, each group by fit, the author accounts after them.**

Nothing is hidden. The author accounts follow in the same list, every row already says which it is, and a line under the heading says what the split was — because a reader who sees an interview above a review should know it was not ranked above it.

## The week's pick

**The best pick is now the best of the week, and it is a strip rather than a spotlight.** It is anchored to Monday, so it is the same book on Friday as it was on Tuesday — the one thing on the page that should not change, and therefore the one thing that does not need the room. Cover, name, score, arrow, stuck under the header.

It is rendered outside `view-root` so it survives a re-render and does not scroll away with the page it introduces, and it is drawn only on For you.

**The wrapper is what sticks, not the strip inside it.** A sticky element can only travel within its own parent's box, and a parent exactly as tall as its one child has nowhere to travel — the first version scrolled away with the page. Worth remembering the next time something sticky does not stick.

Without a profile it is "Pick of the week" rather than "Your pick of the week", it carries no score, and it is the newest of the week rather than the highest-scoring.

## The reserve slot

**A feed sorted strictly by score only ever offers what it already believes.** That is what a recommender is for, and it is also its one structural failure: a model that is wrong about a reader never finds out, because the books that would tell it are the ones it ranks last. It hardens rather than learns, the shelf narrows, and the app reads the narrowing as agreement.

So one slot on For you is spent on the opposite question, under its own brass rule, headed **One it cannot place**.

**Not a random book.** Random is noise, and a reader shown noise stops trusting the shelf. The pick is the book whose verdict would resolve the most of what the model does not know.

**Uncertainty is concrete here rather than statistical.** `model.tags` holds only the tags that have appeared on a book the reader has ruled on, so a tag absent from it has never had a verdict either way — the model has no opinion and `tuneEntry` skips it. What learning one is worth is how much of the corpus it would explain, which is `availability`, already counted. A book scores as the sum of the square roots of the corpus coverage of its unseen tags: breadth counts, and it does not dominate.

A tag on fewer than eight books is skipped. 127 of the tags in the feed are imprints on one or two books, and an explorer chasing those would offer a different obscurity every morning and learn nothing that transfers.

**This is the cheap half of a bandit and none of the arithmetic** — no posterior, no confidence interval, no regret bound. What carries over is that a recommender has to spend something on finding out it is wrong.

**It is held until the model changes.** The page re-renders on every save, filter and tag, and a slot that deals a new book each time is churn; the point is to get a verdict on one book. It changes when `profileVersion` does, which is also exactly when the answer to "what does it not know" moves. It also stands down if the reader rules on it or filters it away.

**It says what it is before it says what the book is.** A shelf called "for you" that quietly included something the model did not believe in would be lying by omission, and the reason the book is there is the reason to rule on it. The section names the tags it has never had a verdict on. It does not claim the book is unscored — the profile scores everything, and the row shows that number like any other.

Nothing appears before the model is ready, because a model with no verdicts is not uncertain about tags, it is simply absent.

## All books is a shelf, not a build report

**The score-status board is gone.** It counted how many books the scorer had placed, how many it had read from a review against an author's own account, and how many carried too little evidence for a number — a quarter of the screen, above the shelf, on the page a reader opens to browse. Most mornings two of its four figures were zero. The heading over it, "Every book, clearly accounted for", is the voice of somebody defending a pipeline to the person who built it.

**Nothing went with it.** Its four figures doubled as the scope filter, and that filter already lives in the Filters menu beside the other three.

What the page says instead is what a stranger needs: how many books are here, in what order, and the one thing that makes this page different from the feed — it does not hide what the profile scores badly.

**The test for a page's header: would a reader who has never seen the app want it.** A count of what the scorer managed is a fact about the app. A count of what is on the shelf is a fact about the shelf.

## Filters, and where they apply

**One toolbar, three views, and a view leaves out the parts it cannot honour rather than showing them doing nothing.** For you had no controls at all: a reader who set "fiction only" on the feed, opened the front page and found nonfiction at the top could not tell whether the filter had failed or the page simply did not have one. It has the field, the kind and the length now, and the filter button carries a count so a short list explains itself before the menu is opened.

It does not have scope, which asks how much is known about a book — For you only ever holds scored ones, so the menu would be options that do nothing. It does not have sort, because its order is the edit it is making.

**The drawn eight a stranger sees are filtered on the way out, not redrawn.** A filter that dealt a new hand would read as the page losing its place, which is the same reason the sample is drawn once for the session at all.

## What a card carries

A card is a cover, a title, an author, **a description and up to five tags**. It used to carry the title, the author and the words "Fiction, probably" — the one fact the cover already gives — with the rest of what the app knows about the book two taps away in the dossier. The tags lead with what kind of book it is, because that is what a reader sorts by at a glance, then with whatever the reviews actually said.

## Covers

**A jacket does not pick its own width; it declares a ladder and lets the browser pick.** Both cover hosts serve a thumbnail unless asked otherwise, and neither was being asked: the archive card draws at 222 CSS pixels on a desktop — 444 on a retina screen — and was handed Google's 128px default.

Asking for a fixed width per slot fixed the desktop and left the phone soft, which is the failure worth remembering. **A slot is not one width.** The same card is 222px on a desktop shelf and 317px on a 375px phone, and a phone draws three device pixels to the point, so the card that looked sharp on a laptop was being handed 460 pixels for a slot a thousand pixels wide. Each slot now declares a `sizes` rule and a ladder of real files, up to 1000px for a card, and the browser resolves layout, density and connection at once.

**And a cover that cannot fill its slot is drawn rather than stretched.** This is the part that stops the app looking broken. Every cover's real width — the widest its host will actually render — is measured by `bin/covers.mjs` and travels with it, so the renderer compares rather than guesses.

Measured across the archive: **465 covers are 800px or more, 194 are 300 to 499, and 15 are under 300**, with 149 books carrying no cover at all. A 400px jacket is more than a 60px row needs and a fraction of what a card wants, so the same book shows its real cover in the feed and a drawn one on the shelf. Each slot names the narrowest file that can fill it — the slot's widest CSS width at two device pixels to the point, two rather than three because holding every cover to 1000px would discard most of the archive's jackets to avoid a softness only visible beside a sharper one.

| Slot | Needs | Real cover | Drawn jacket |
|---|---:|---:|---:|
| Row | 120px | 674 | 149 |
| Dossier | 260px | 668 | 155 |
| Spotlight | 340px | 466 | 357 |
| Card | 680px | 465 | 358 |

**An unmeasured cover is assumed to be fine**, because discarding a real jacket over a fact nobody established is the wrong error. That makes the measuring pass in `bin/covers.mjs` the thing that keeps the rule honest, and it runs nightly: without it every book crawled tomorrow would be assumed fine and the small ones would go back to being stretched.

**Stock photography was considered and rejected on evidence.** Pulling an openly-licensed image per book by its tags does not work: keyword search over museum catalogues matches titles and artist names rather than subjects, so "church faith devotional" returns a landscape by Frederic Church and "factory work industry" a plate from the Worcester Porcelain Factory. Wikimedia Commons has real subject categories but returns uncurated snapshots. An image in a cover slot is read as the jacket, so a wrong one is worse than none — and the drawn jacket is already sharp at every size and designed to be the majority face of the screen.

Open Library claims no width descriptors: its L is 328px on one book and larger on another, and a `w` this cannot verify would have the browser skip a file it should have taken.

This runs at render time rather than in the build, so all 674 covers already in the feed are sized without a re-crawl.

## Asking for an account

**A reader who reaches for something that needs an account is offered the account, not told about it.** Both gates were a toast: a line at the bottom of the screen saying to sign in, with no way to do it from where it appeared. It is a dialog now, and it fires in two places — after a profile is built, which is the first moment there is something worth losing, and on the roundup, which is sent to devices and cannot know which are yours.

The dialog names the specific thing that was reached for, because "sign in" without it is a demand rather than an answer. **And it says outright that there is no separate account to create**: signing in with Google makes the account if there is not one, there is no form and no password to choose. Inventing a second button for a flow that does not exist would be the worse copy.

Its button carries `data-auth`, so it is warmed on `pointerdown` through the path that already exists. Google's window has to open inside the gesture, and a button that first downloads a script gets eaten by the popup blocker.

## Fiction and nonfiction on the taste screen

**The two are told apart by a rule down the chip's left edge**, oxblood for fiction and `--lapis-line` for nonfiction, with a key above each list. The rule is on the edge rather than in the fill because a chip is a control with a pressed state, and colouring the whole thing would put two meanings in one channel. Every chip also carries the word in its accessible name — "Novels, a fiction answer" — because state is never colour alone.

**A chip already claimed by the other list is not offered.** Asking someone what puts them off and listing back what they just said they read for is a question that answers itself, and picking both wrote two contradictory adjustments to the same band.

## One description, once

The dossier printed the same sentence twice on **689 of 823 books**. The case block reads the first mention that has a standfirst; the quote block set that same standfirst in a blockquote with a byline under it. On most books they are one text.

The quote gives way, not the case block: it is the same words with more furniture, and the block above it is where a reader looks first. Where a book has a second review with something else to say — 114 of them — that one is quoted instead, which is better than either. **The attribution and the link to the review stay in both cases.** Dropping the whole section instead took the way out to the actual review with it, on 662 books.

## What a row says about a book

The row prints one sentence about a book and it is the most-read text in the app. Two failures put a web page there instead.

**A few publications syndicate their own CMS chrome inside the description field.** World Literature Today ships a section label, the reviewer's address, a timestamp and the whole bibliographic block before the first real sentence: "FICTION [email removed] Mon, 08/24/2026 - 15:42 Author: Morgan Day Astra House. 2026. 192 pages. If ever there were a phrase…". Ancillary Review leads with the reviewer's name and an "Under Review:" heading carrying the citation. Every furniture rule is anchored to the start and stops where the prose begins, so a critic writing about a book's length keeps their sentence.

**And 588 of 823 books carried a publisher's description that was never displayed.** `blurbOf` read the mentions and nothing else, so a book whose only standfirst was a masthead printed "The reviews of it are indexed here without a summary" with a good paragraph sitting unused in the same record.

`bestBlurb` picks rather than taking the first. **The critic wins wherever the critic wrote a sentence.** Publisher copy is written to sell and reads like it, so it is the fallback rather than the preference — and it stays out of the scoring entirely, which is the line that matters: `lib/score.mjs` never sees it. Furniture is never printed even as a last resort, because "Critics: 11 Rave, 1 Mixed, 1 Pan." is a fact the app already carries as a tag, and set where the description goes it is a row that has not read the book dressed as a row that has.

Measured over the archive: rows opening with furniture went from 72 to 12, and 25 rows that said nothing now say something. The 12 that remain are short taglines rather than forms.

## Searching without freezing the field

Two costs, and they are different. The BM25 index is built once over the whole archive and takes 447ms at 823 books — a visible stall that grows with the corpus. Each search after that is 17ms. Neither may happen on the keystroke, because the field has to keep up with a thumb.

**A keystroke records what was typed and schedules.** The scheduler waits 180ms for the typing to settle, puts the spinner up, yields two frames so the browser can paint it, and then searches. A spinner rendered in the same task as the work it describes is never seen. There is a timer behind the frame callback, because `requestAnimationFrame` does not fire in a backgrounded tab and a search begun before switching away would otherwise never finish.

**The spinner is only shown for the index build.** Showing it for a 17ms search is a flash, and a flash reads as a fault.

**Return runs the search and blurs the field**, which is what puts a phone keyboard away; until it did, the results were behind the keyboard. `enterkeyhint="search"` labels the key.

**Results belong to what was searched for, not to what is in the field.** The two differ while a keystroke settles, and `state.sqRun` is the one the view reads.

## Why a search result is here

The row does not repeat the bands it matched. They were being printed as a bare unlabelled list a line above a different list of the book's other tags, and two lists side by side read as two sets contradicting each other.

**The tags the query matched are marked in the tag row itself**, in brass, sorted to the front, with the fact in their accessible name. The line above carries only what a tag cannot show: the words that were found in the text, the words the app added on the reader's behalf, the requirements it applied, and the reference book where there is one.

## Search

The reader types a sentence and the app answers out of the books it has read about. It is the reason to come here rather than to a search engine, so it carries three obligations the rest of the app already carries: say what it understood, say why each row is in the answer, and never let a profile invent a match.

**It runs in the browser against the feed already loaded.** No model, no API call, no index on the wire. A key in a static page is a key anybody can spend, and a client-side embedding model is thirty megabytes for a corpus whose whole feed is under seven. The app also already holds the right vocabulary: the scorer reads eight dimensions off every book and files the result as tags, and a request for a kind of book is mostly a request for a handful of those.

**Three ways a query can carry a request, and it may use any one alone.** A concept phrase that maps to bands — "family saga" to generational sweep. Words matched by BM25 over the title, the description and every review. Requirements — a length, a year, a kind, a translation — which filter rather than nudge, because a reader who asked for books under 300 pages does not want a 700-page book at the top for matching three tags. "Like X" resolves to a book in the corpus and ranks by distance in the dimension space the Taste page uses.

**Taste re-ranks and can never create.** The fit multiplies relevance rather than adding to it, so a book the query did not ask for scores zero however well it fits, and the best a profile can do is move a genuine answer by a third. Without a profile the ranking is relevance alone and the rows carry no score.

**A word the reader typed and a word the app added on their behalf are named separately.** "Grief" is searched for alongside "mourning", and the row says which one it found. Presenting an expansion as something they asked for is how a search engine loses trust.

**What it cannot do, said on the page rather than discovered.** It matches on what critics and publishers wrote, so a request shaped like a kind of book is answered and a request shaped like a mood is guessed at. The concept table in `web/lib/search.mjs` is hand-written on purpose: it is the one place where somebody's idea of what "beach read" means is written down, and it should be arguable rather than mined.

**A wrong answer has to be a legible wrong answer.** The readback panel above the results names every band it went looking for, every requirement it applied and every word it kept, so a reader can tell a thin archive from a misunderstanding and knows which word to change.

## The eight dimensions

Revision 3, 2026-08-30. Rebuilt because a measurement said the profile was paying 42 of its 100 points to two dimensions that were silent on nine books in ten: prose register fired on 9% of the archive and formal ambition on 11%, while the most reliable signal in the whole scoring pass was a page count.

| id | name | weight | read from | fires on |
|---|---|---:|---|---:|
| D1 | **Structure** | 16 | prose | 63% |
| D2 | **Subject** | 26 | prose and catalogue | 71% |
| D3 | **Form** | 12 | the record | 50% |
| D4 | **Register** | 20 | prose | 24% |
| D5 | **Tone** | 10 | prose | 23% |
| D6 | **Scale** | 8 | the record | 76% |
| D7 | **Provenance** | 8 | the record | 99% |

The ids are opaque handles and were kept through the revision so saved verdicts, taste vectors and stored weights survive it. The names are what anyone reads, and they changed. Band ids changed too, so a band override written under revision 2 no longer matches and is dropped, which is the correct migration rather than a bug.

**Structure absorbed formal ambition.** Historical causation and formal ambition were two dimensions asking one question - how is this book built - and both were starving. A braided novel linking a rupture to the present was scored twice for one fact; a book that was merely well-made fired neither. Merged, with a comparative and a chronicle band added so a nonfiction shape has somewhere to land, it fires on 63%.

**Subject is the heaviest thing here**, because measured against every other signal on the record it carries the most information: 20 bands at 4.00 bits.

**Form, Scale and Provenance are read off the record**, and are marked `fromRecord`. They say what the book is; they do not say that anyone has described it. That distinction is load-bearing.

### Register was mined, not written

The nonfiction bands were hand-written and fired on 9% of the archive. Rewriting them by intuition would have produced more of the same, so the terms were mined instead: every one- and two-word gram in 348 nonfiction texts, scored by log-odds against 144 fiction texts, with anything already claimed by a lexicon excluded.

The result was not a longer list of synonyms. It was **a band that did not exist**. `argues` appears in 62 nonfiction descriptions and no novel at all; `shows how` 44 and none; `examines` 53 against one. The most common register in serious nonfiction is a case argued in plain expository prose, and there was nowhere for it to land — so `expository` was added, at 6, which is evidence rather than judgement.

Register went from 24% to 46%, and nonfiction from 3% to 59%.

**The same mine run over fiction found nothing, and that is the finding.** Its top forty terms are plot and marketing — "decides", "finds himself", "her mother", "debut novel", "bestselling author". Only 26% of fiction descriptions mention how the book is written at all, against Register's current 21%, so the ceiling is set by the corpus rather than by the lexicon and there are about five points left in it. Reviewers describe what a novel is about; publishers describe who will like it. Neither describes the prose.

The six points between them were mostly the two-hit rule: a band scoring 9 or 10 needs two signals, so "beautifully written" alone cannot award a 10. That rule is right and stays. The terms added were the mid-score ones a single signal can carry.

**Discipline that made the mine usable.** Terms already claimed by any dimension were excluded, so it could not rediscover what was there. Candidates were kept only where they appeared in one class and almost never in the other - `global`, `policy`, `institutions` and `indigenous` all ranked highly and were all dropped, because they describe what a book is about and would have stolen from Subject. And every addition was measured for cross-fire afterwards, which is how the 19 novels wearing a nonfiction register were caught.

### Fiction and nonfiction are described in different vocabularies

The mine that produced `expository` was run again over fiction, on the review
bodies rather than the standfirsts, and it returned no prose vocabulary at all.
What it returned instead was `narrator` (24 fiction against 2 nonfiction), `the
plot` (14 against 0), `premise` (10 against 1), `protagonist` (10 against 2),
`the characters` (8 against 2).

That is not a failed mine. It is the finding. **Reviewers describe a novel's
point of view and its engine; they describe its prose for barely a third of
books.** Nonfiction is the mirror image, described by how it argues, which is why
`expository` mined out cleanly and carries 59% of it.

So D8 Narration exists and is fiction-only: many voices, interior, unreliable
narrator, ensemble, one narrator, plot-driven. It fires on 35% of fiction against
Register's 18% there, which is the point — for a novel this is the question the
corpus can actually answer.

Nonfiction defaults on it, and that costs nothing: a silent dimension is not
evidence and does not drag a score. The invariant is enforced after the
classification rather than predicted before it, because `runFilters` reaches
nonfiction by routes the early gate cannot see, and a biography of Norman Mailer
does not have a narrator.

### How to test a lexicon, and how not to

A dimension that fires on a third of the archive is either missing vocabulary or
reading everything there is. Telling those apart is the whole question, and the
first attempt at it got the answer backwards.

**The method that fails.** Write a list of words the dimension ought to catch,
count how many books contain one, compare that with what the dimension reads. If
the two numbers are close, conclude there is nothing left. This is what was done
for Tone, and the numbers agreed almost exactly - 20% against 19% - and the
conclusion was wrong. A ceiling measured against a hand-written list measures the
list. The list had `funny` and `hilarious` and no word for devastating.

**The method that works.** Write a candidate vocabulary far wider than the
lexicon, several families per dimension, deliberately including words you expect
to reject. Then for each candidate measure three things on the real pooled text:
how many books contain it, how many of those have the dimension silent, and how
many are hits in the title alone. Rank by the second number. Anything already
claimed by any dimension is excluded, so the test cannot rediscover what is
there.

Read the top of that list by hand, because the arithmetic cannot tell a tone from
a subject. `learned` is usually the verb. `care` is usually "care about". `cast`
is usually a shadow. `plot` is often a plot of land, in an archive this
preoccupied with who owns which field. Every one of those ranked well and none of
them went in.

**A ceiling can only be claimed when the test vocabulary is wider than the
lexicon.** Run across all eight dimensions, the candidate lists reached 31% of
books for Structure, 49% for Subject and 22% for Register, against dimensions
already firing on 60%, 73% and 45%. Those dimensions read more than the test knew
to ask for, so nothing about their limits was established and the audit says so
rather than guessing. Only Tone and the fiction side of Register have had a test
wider than what they read.

**Form, Scale and Provenance are not minable at all.** They are read off the
record - a catalogue subject, a page count, an imprint - so their coverage is a
fact about how complete the metadata is, not about vocabulary.

### The questions have to match what the profile can hold

A chip is a `dimension:band` key, and `buildProfile` skips any band that does not
exist — silently, which is the danger. Revision 3 moved formal ambition into
Structure and gave D3 to Form, and **six chips went on being offered while writing
nothing at all**: formal constraint, many voices, told straight, a late reveal,
set in the past, and book-club picks. A reader could answer them and change
nothing.

Worse than the dead chips was what had never been asked. Narration carries 8
points and had no chip at all. The nonfiction registers — the whole reason for
asking a nonfiction reader anything — had none either, so someone who knew
exactly what they wanted from nonfiction had no way to say it. Nor did Form, nor
the two tone registers added the same week.

The vocabulary is now 64 chips covering all eight dimensions, and `reads` gates
them both ways: a nonfiction reader is not asked about gothic novels or
narrators, a fiction reader is not asked about monographs. They are asked in the
order a reader thinks, which is also roughly the order the profile weights — what
it is about, then what kind of book, then how it reads. Subject carries 22 points
and used to sit fifth.

**Grouped, and labelled in the reader's words.** Sixty chips in one
undifferentiated run is a wall: nobody reads to the end of it, and the ones at the
bottom may as well not be offered. They are eight short lists now — what it's
about, what kind of book, how it's written, how it feels, how it's built, who's
telling it, how long, who published it — and a reader with no opinion about a
whole group can skip it at a glance.

**Five answers is enough, and the page says so.** Five picks move the median score
by nearly three points and turn 76 recommendations into about 170, which is the
difference between a feed and a list. Asking for more up front buys accuracy
nobody stays to give. One of the five has to be something they will not read,
because a model with nothing to push against ranks everything alike and the
dislike list is the only pressure available at the start.

Below the minimum the count reads "3 of 5", Build is disabled, and the reader is
told what is still missing. At five the rule under the foot turns brass, the count
becomes a sentence — *Ready, 5 answers is enough to re-rank the feed* — and the
button comes alive. Nobody has to count for themselves, and nobody has to guess
whether more would be better. The Profile screen holds the whole vocabulary for
anyone who wants to sharpen it afterwards.

**Three tests in `bin/test.mjs` now fail the build** if a chip points at a band
the profile does not have, if a refusal does, or if any dimension carrying weight
has nothing that asks about it. A question the app cannot answer is worse than no
question, and this is the kind of rot that is invisible from the outside.

### The same test, run against every hand-written list

The method above is not only for lexicons. Anything in this app that maps a value
space with a list somebody wrote is testable the same way: enumerate the space,
run the list over it, and read what falls through, ranked by how many books it
costs. Run across the whole app it found four things.

**Provenance was misreading a fifth of the archive.** The academic-press pattern
had `university` and not the abbreviations, so 83 imprints and 159 books fell
through to "a general trade imprint" — U California Press, U Chicago Press,
Stanford UP, JHU Press, UNC Press, McGill-Queen's UP. Scholarly presses scoring 4
where they had earned 7. `UP` cannot go in the case-insensitive list, because
under `/i` it matches every "up" in every blurb, so the abbreviations are a second
test run against the publisher with case intact. Books read as a scholarly press
went from 186 to 308.

**Narration's tags were malformed and invisible.** `KIND_OF` in `tags.mjs` mapped
D1 through D7 and was never given D8, so 77 tags shipped as
`id: "undefined:one-narrator"` with no kind at all, and the interface — which
filters tags by kind — dropped every one of them silently.

**The body trimmer was leaving the host's biography on.** Ninety New Books Network
notes still ended in a paragraph about the interviewer rather than the book:
"...conducted by Dr. Miranda Melcher whose book focuses on post-conflict military
integration... You can find Miranda's interviews wherever you get your podcasts."
Now cut, along with the review sites asking to be shared.

**And two lists came back clean, which is also a result.** `SUBJECT_BANDS` leaves
151 of 180 catalogue subjects unmapped, but the ones it drops are genres and forms
— Fiction, Poetry, Thriller — which belong to Form rather than to Subject. And
the 96 books whose fiction status is unknown are unknown because 90 of them carry
no catalogue subject at all. That is a metadata gap, not a list that is too short,
and no amount of vocabulary fixes it.

### Tone, and the two registers that had nowhere to land

Tone was the thinnest dimension at 19%. The first mine compared it against a
thirty-seven word mood list, found the two numbers almost equal, and concluded
there was nothing to find. That conclusion was wrong, and the way it was wrong is
worth keeping: a ceiling measured against a hand-written list measures the list.

What is true is that the books with no tone at all are academic nonfiction
described without affect - mined against the books where Tone fires, they return
`insights`, `archives`, `examines how`, `oxford university`, `communities`, and
not one tone word in the top twenty-six. That floor is real. The ceiling was not.

**The ceiling was my list's, not the corpus's.** That first pass tested a
thirty-seven word mood list and concluded Tone was at its limit. Tested against a
proper affect vocabulary the answer changed: `tragic` appears in 13 books,
`devastating` in 9, `brutal` in 9, `harrowing` in 5, `cutting` in 11, `serious`
in 14 — and none of them had anywhere to land. The gap was not synonyms for bands
that existed. It was two registers that did not.

**Harrowing** — devastating, unflinching, brutal, bleak, stark, tragic — is now
the second largest band in the dimension at 52 books. **Grave** — sobering,
solemn, weighty, meditative, unhurried — is the register most serious nonfiction
is written in. Comic gained the synonyms it was missing: cutting, biting,
caustic, humorous, witty, irreverent.

Tone went from 19% to 31%, and on fiction from 36% to 49%.

Two terms were audited out after the first build. `grave` is a burial place three
times in four in this archive — it fired on a book about cemeteries — and
`considered` is nearly always the verb. A band stands on the words that only ever
mean the tone.

**And the finding that mattered.** 76 bands across the archive fire on
nothing but words in the book's title. For subject and form that is fair -
*Europe: A New History* is history, *Birding While Indian: A Mixed-Blood Memoir*
is a memoir, and a title names what a book is about. For the dimensions that
describe the reading it is not: *Pentagon Capitalism: How the Cold War...* was
scored cold in tone, *Moving Toward Freedom* warm, *A Tender Age* warm, *Lessons
for a Warming Planet* a popular treatment. None of those is a judgement about the
book; each is a word that happens to be on the cover.

So Register, Tone and Narration may not be carried by the title alone. 17 bands
were refused on the next build, and `warm` fell from 75 books to 50.

### What Open Library does not have

`first_sentence`, `subject_place`, `subject_time` and `subject_person` were
measured against fourteen titles from this archive: 7%, 0%, 0%, 0%. These are
books published in 2025 and 2026, and Open Library's rich fields fill in for
older, widely-catalogued works. `subject` and the reader ratings are already
requested. Google Books is the same story from the other side: `searchInfo.
textSnippet` is a truncated copy of the description already ingested, and
`viewability: PARTIAL` on 838 volumes buys a reader link rather than any text.

There is no untapped metadata source here. The text this pipeline has is the
review body, and the work that pays is reading it better.

### Evidence is only what somebody wrote

Three of the seven fire on almost everything, because a page count and a publisher are on every record. Counting them as evidence would mean a book looked well-understood because we knew who published it, which is exactly the trap the old 6.9 cap existed to catch. A calibration fixture caught it again the day these dimensions started firing on every row: a book with a mood, an imprint and nothing else scored 9.2.

So `evidenceWeight` counts only the dimensions that read prose - Structure, Subject, Register, Tone - and it is what both shrinkage and renormalisation read. Knowing a book's page count can no longer license a score to speak for the whole book.

### The threshold is a share, not a number

A weighted average over seven dimensions is a mean, and means regress. Once every dimension fires, almost every book lands near the middle: the restructure put 464 of 769 books inside a single band and left 14 above 7.0. An absolute threshold became unreachable by arithmetic rather than by judgement.

So the profile states how selective it wants to be - `recommendShare`, currently the top 12% - and the build finds the number that delivers it against this corpus. The score on the row is still the transparent weighted sum showing its working; the line it has to clear is the one that keeps the shortlist the size the reader asked for. The sidebar says "Top 12% is recommended" and the Profile screen carries the number.

### Aversions

Every other control models attraction. A weighted sum can say "I care about prose"; it cannot say "I will not read a book that resolves into a twist, however good the rest of it is". A low band score is compensatory by construction and a strength offsets it, and bouncing off a book is not like that.

So an aversion is the reader's own, keyed `dimension:band`, and it is subtracted after the sum at full force: **mild** -8, **strong** -20, **never** takes the book out. Capped at eight, because a veto list long enough to be comfortable is long enough to empty the shelf. The builder asks for them in a question of their own - separate from "what puts you off", and worded to draw the distinction - and the Profile screen carries the four-state picker.

The profile's own penalties are the same mechanism with the profile author's name on it rather than the reader's, and both are added at full force after shrinkage. Smoothing a stated refusal toward the middle of the field would be the profile disagreeing with itself.

## Component rules

- **Cards are the shelf.** Cover, score badge, source, title, author, a one-line match rationale and a bookmark. Four columns at 1024, two at 768, one below. Grounds alternate malachite, lapis, garnet, olive. `View dossier` appears on hover and focus and is never the only route in.
- **The match rationale is built, not written.** It names the dimensions the review actually fired on. Four books whose reviews fired the same two dimensions would otherwise carry the same sentence four times across one shelf, so the phrasing rotates on the book's id: stable per book, varied across a row. The claim never changes, only the sentence.
- **Feed rows** are `78px 92px 1fr 104px` with `24px` gaps on desktop. Below 1024 they become `58px 1fr`, the score moves under the cover, and Save and Pass become full-width controls beneath everything.
- **The dossier is the one modal in the app**, and it replaced the inline detail panel. A centred tall editorial sheet over a dark scrim on desktop, a near-full-screen sheet with internal scrolling on mobile. It traps focus, closes on Escape and on its own button, restores focus to the control that opened it, and locks background scroll. Every cover, title, `View dossier` and Why link opens it, and it is the only place a book is read.
- **The dossier's scoring block shows its working**: the profile version, a narrative sentence built from the dimensions that fired, and a hairline bar per dimension with the number beside it carrying the actual meaning. An unscored book replaces all of it with the evidence-status explanation and keeps the rest of the record.
- **Sort and filter are menus**, with radio and checkbox semantics, closing on selection, on Escape and on an outside click. Their state survives moving between Review feed and All books.
- **Save toggles in place**, updates every instance of the book at once, and announces through a live region. **Pass** removes a book from the recommending views — For you and Review feed — after an undo-capable notification, and leaves the archive record alone.
- **The Profile screen is where a reader overrules the profile outright**, which is the opposite of what Taste does: saves move a score by at most 0.8 and can never touch a rule. Seven weight sliders totalling 100, a band editor under each, four named guardrails and the penalties the profile applies.
- **The weights wait for Save; everything else does not.** The total updates as the sliders move and Save is refused unless it is exactly 100, because only the weights have to add up to something. A band score or a switch takes effect the moment it changes, and a feed that re-ranked under a dragging thumb would be unreadable.
- **Band scores are closed on arrival.** The weight says how much a dimension counts; the bands say what counts as a good answer within it, and that second half is where a disagreement usually lives — "comic" describes a novel the same way for everyone and is worth 4 to this profile and 10 to somebody who reads for comedy. Seven dimensions carry forty-six bands between them, and a screen that opens as forty-six number fields is a spreadsheet. A band the reader has moved says what it was worth before, and nothing else on the row is coloured.
- **A penalty is not an exclusion.** A book carrying one is still scored and still shown. Switch one off and its points come back.
- **The score is never a gauge.** Not on a card, not on a row, not in the dossier.

### Tags

**A tag comes from the review and from nothing else.** The feed carries thirteen kinds and most of them are facts about our own bookkeeping rather than about the book: `caveat` holds "thin evidence" and "book unverified", `rule` and `question` hold which of the profile's rules fired, `attention` holds how many critics turned up, `imprint` and `press` hold the publisher. `scale` is a page count wearing a word and `genre` is a catalogue subject.

Five kinds survive that test — `period`, `subject`, `form`, `prose`, `tone` — and each is read out of review prose by keyword, so a tag on a row is always something a critic wrote. Nothing else is ever drawn as a tag, anywhere: not on a row, not on a card, not in a dossier, not in the taste strip.

**Every book also carries what it is**, ahead of anything a critic said, drawn in brass so the standing fact reads apart from the read. Fiction, Fiction probably, Nonfiction, Unclassified — the classification is on all 811 records, so no book is ever bare, and where the catalogue is narrower than that (Poetry, Comics, Mystery & thriller, SF fantasy & horror, Religion) its own word follows. This is a fact about the book rather than about our coverage, which is the line the caveat tags failed.

**How far to trust a number is not a tag.** "Recommended", "Length and press only", "Evidence too thin" and "Awaiting review" are statuses. They sit beside the score, where the reader is already looking.

### What a score is made of

**Shrinkage, not a cap.** Renormalising over what fired lets a handful of dimensions carry a whole number: a book firing one dimension at 10 out of 10 used to outrank a book firing six and averaging 8. The old guard was a flat 6.9 cap under 30 points of fired weight, which flattened 330 books into one value and, measured, bound on none of them.

The score is now the weighted average of what fired and a phantom book sitting at the corpus mean, carrying 15 points of its own. A book firing 75 points of evidence keeps three quarters of its own number; a book firing 8 keeps a third. One measured consequence worth stating: **nothing can be recommended on one dimension** — a single-signal book tops out around 6.1, under the 7.0 line, without a rule saying so.

Shrinkage applies to the evidence and to nothing else. The profile's penalties are deliberate rules rather than weak evidence and are added at full force afterwards; smoothing a stated exclusion toward the middle would be the profile disagreeing with itself. The prior travels in `feed.json` so the browser reaches the same number when a reader re-weights a dimension.

**The catalogue is evidence.** 88% of the archive carries a subject from Google Books or Open Library, and its vocabulary is BISAC's top level. Measured against everything else on the record it is the richest signal there is — 92 values at 4.90 bits, against 3.88 for the keyword subject engine at 63% coverage. It was going in as raw text, where "History" is one word among six hundred. Read as a category it names a band outright, and subject engine now fires on 74% rather than 63%. Prose outranks it: a review that names the engine beats a shelving category.

**Percentile, beside the number.** A weighted sum out of a hundred is only legible next to the field it came from. The dossier says where a book sits in this archive and how many of the seven dimensions were actually read, recomputed whenever the reader's weights change.

**The starving dimension.** When a profile surfaces almost nothing, the useful answer is not "nothing matched" but which requirement is doing the excluding. Each dimension is zeroed in turn and the top twenty recounted; the one whose removal admits the most new books is named on the Taste screen, with its weight. Brute force over seven dimensions and eight hundred books, which at this size is a loop rather than an algorithm.

### Where a score is read from

**Three classes of text, not two.** A critic on a book they have read is the only text allowed to say whether it is any good. The author on their own book, at length, says what it is about and how it is built — which is what five of the seven dimensions actually ask. A publisher's catalogue entry is jacket copy and stays out.

The first version of this pipeline had only the first and the third, and filed author interviews with jacket copy on the reasoning that neither "says the prose is the weakness". Measured against this archive that was wrong on every axis. The author accounts carry a median of 600 characters against a newspaper standfirst's 128. A taste dimension fires on 68% of them against 29% of critic text. A low band fires on 14% against 5%, and a hard filter on 83% against 32% — the descriptive corpus is *harder* on its books, not softer. And where both corpora clear the evidence bar on fiction, the medians are 60.0 and 62.0. Excluding it suppressed 456 books on a hypothesis its own data contradicted.

**Never pooled.** The two corpora overlap on three books in the whole archive, so a critic's text is read alone where there is one and the author's account alone where there is not. Pooling would buy nothing and would let an author's words about their own book move a number a critic earned.

**The reader is told which.** `score.readFrom` is `reviews` or `author-account`, and it shows as a status beside the number — *From the author's account* — never as a tag. There is no discount attached to it, because the measurements say a label is right and a discount is not. The existing evidence cap does the rest: under 30 points of fired weight the total is capped at 6.9 whichever corpus it came from.

Publisher catalogue copy is still excluded — 37 books, unmeasured. The same experiment would settle it.

### A score the description did not touch

Five of the seven dimensions read prose, whether a critic's or the author's. The other two read the catalogue: D6 is a page count and D7 is a publisher. So a book can clear the evidence rule on those two alone — a number built from nothing anyone wrote, which is why those were the rows showing up with no descriptive tags at all.

That is not a tagging problem and it is not hidden. Those rows carry **Length and press only** beside the score, their card says so instead of claiming a match, the dossier's case for it reads "There is no case yet", and its scoring block names the two dimensions outright: *this number is built from its length and its publisher alone, so it is a placeholder for a reading rather than one.* The dimension bars show the same thing — two of seven, and neither of them about the book.

**"Not yet described" is now the honest name for the last state.** A book with nothing behind it but a catalogue listing — 80 records, down from 493 — is not waiting on a critic. It is waiting on anyone at all.

### Onboarding

Three surfaces for one fact: every score here is ranked against a taste profile, and until a reader builds one it is somebody else's.

**Asked once, after twenty seconds of foreground time.** Foreground, not wall clock: a tab opened and left behind three others has read nothing, and a dialog waiting there is an ambush rather than an offer. The key records that the question was asked rather than that it was answered, and it is written when the dialog is shown — so Escape, the backdrop and all three buttons cost nothing to get right, and no browser that fails to fire a `close` event can leave a reader open to being asked twice.

It leads with the profile rather than the account, because the profile is what a stranger gains and it needs no account at all. Signing in is offered underneath for what it really buys: not losing the thing they are about to build.

**Said again, quietly, on a later visit.** A band in the flow at the top of the pane, not fixed, because it is a standing fact about the feed below it rather than an alert and should scroll away with the thing it describes. Hiding lasts the visit, in `sessionStorage`: a permanent dismissal would be the third time this reader is asked the same question, and a reminder they cannot quiet for an afternoon is the kind that gets the site closed. It comes down the moment a profile exists, without waiting for a reload.

**After that, a mark on the control that fixes it.** A reader with an ordering of their own and no account has it in one browser and nowhere else. Not a failure — nothing is broken and nothing has been lost — but the one thing about this app a reader would be sorry to learn too late, and the only honest reason to ask a stranger for an account. A dot on Sign in, with the sentence behind it beside the same control. Standing and not dismissable: it stops being shown by signing in, which is the only thing that stops it being true.

**The app ships with one real reader's profile, and a stranger must never be shown it.** A scorer needs numbers to run, and the numbers this one has are the weights it was built and calibrated against — Michael's. That is right for the build and indefensible for a first visit, which was showing somebody else's taste under the heading *For you*, their weights on a screen called *Profile*, and a number out of ten that measured fit to a person the reader has never met.

So everything that claims to be about the reader is gated on `hasProfile()`, which is `!isEmpty(overrides)`. Without one, **Taste** and **Profile** are replaced by a panel saying what that page becomes and offering the one action that gets there — never somebody else's weights dressed up as a preview.

**For you is the exception, and it shows the app rather than an argument for it.** It was a pitch panel for one revision and that was wrong: the first-visit prompt already makes the case for signing in, so a second pitch where the shelf should be leaves a stranger with nothing to look at and no idea what they are being offered. It holds eight real books in the real layout — spotlight, shelf, newly reviewed — drawn at random, stated as random in the kicker and again under the first book. **Random is the honest word and the interface uses it**: the sample is not ranked, not scored, and never called an edit. The draw is held for the session, because a shelf that deals a new hand on every save and filter reads as a bug rather than as variety — the same reason the drawn jackets are hashed from the book id. The two browsable lists stay open, because the archive is a public record of what the press reviewed and is worth reading on its own, but they are ordered newest-first, carry no score, no *Recommended*, no coverage strip and no *best fit* sort, and they say so above the list rather than letting a chronological order be read as a ranking. The dossier drops its score, its case-for-it and its scoring breakdown, and keeps the blurb, the tags and the review.

**The test is whether a sentence would still be true for someone who has answered nothing.** "Reviewed by the NYT, 2026" survives it. "Recommended for you" does not, and neither does "Below your threshold", which is worse — it judges a reader against a bar they never set.

**A chip is gated to fiction or nonfiction by the corpus, never by how its label reads.** Thirty-seven of the sixty-four chips carried no `reads` tag, so a reader who answered "fiction" was still offered biography, university presses, climate and illness — subjects that read as nonfiction and measure as it too. The rule is that a chip is tied to one side only when the other side cannot be served: measured over 193 scored fiction books and 486 nonfiction, Institutions fires 1/38, Art and music 1/30, A life told 1/18, Work and the economy 1/15, Ecology 0/10 and Illness and care 0/7, and A late reveal goes the other way at 3/0. Everything else fires on both and stays open to both — the whole of tone, the whole of structure, Poetry at 8 fiction to 9 nonfiction, and subjects like Crime, Migration and Science that novels and histories both take up. **The labels mislead and the counts do not**: "Ecology and climate" sounds like it belongs to both and there is not one scored climate novel behind it, while "Told straight, start to finish" sounds like nonfiction and two novels carry it. Re-measure before adding a tag.

**The builder is a seventh view with no slot in the navigation.** Nobody arrives twice. Three questions on one screen rather than a wizard, because seeing all of them at once is what makes it feel short, and `lib/onboard.mjs` turns the answers into an override object.

`buildProfile` bumps a dimension's weight for each pick beyond the first, so its weights do not total 100 and the Profile screen refuses to save anything that does not. They are scaled back to exactly 100 on the way in, by largest remainder, in `app.js` rather than in `lib/onboard.mjs` — which has tests and a calibration suite behind it.

### The drawn jacket

A cover image exists for most books and never for all of them. A book reviewed the week it is published often has no jacket anywhere yet, which is exactly the book this feed is full of.

So the fallback is designed rather than apologised for. `web/lib/jacket.mjs` draws a typographic jacket: title in Bodoni, author in mono caps, a doubled rule, a ground picked from the token table. **This is period-correct rather than a concession** — jackets in the twenties and thirties were largely set, not illustrated. It is deterministic, hashed from the book id, because a shelf that reshuffles its colours on reload reads as a bug.

It is set in units of its own width, so the same component reads at 78px in a feed row and at 215px on a card.

**Three ways a cover fails and all three fall back.** No URL at all. An error, including a 404 already in the browser cache — which resolves before a handler can be attached and never fires again, so the finished-and-empty state is tested as well as listened for. And a request that simply never arrives, bounded at ten seconds: long enough that a slow connection still gets the real jacket, short enough that an unreachable host does not leave an empty ground. A broken-image glyph is never shown.

No external art and no Creative Commons image search. Per-image licence review is real work with real failure modes, and an image pipeline reaching outside Open Library and Google Books would break the guarantee that the published site is a static file and a JSON blob.

## Accessibility

- WCAG 2.1 AA on all text and controls
- Focus: `2px solid var(--oxblood)` at `2px` offset, on every focusable element, one treatment
- Touch targets ≥ 44×44px below 1024px, with no exceptions in the current shell
- Every icon-only control has an `aria-label`; menus use `menuitemradio` and `menuitemcheckbox`; switches expose `aria-checked`; sliders expose an accessible name and `aria-valuetext`
- Saves and passes announce through an `aria-live="polite"` region
- Keyboard: tab order follows visual order, the dossier traps focus and wraps at both ends, Escape closes the dossier then an open menu then the mobile panel, in that order
- **No horizontal scroll at 320, 390, 768, 1024 or 1440.** Two causes, and the second is the one that bites: no control may set a width the viewport cannot meet — every grid child needs `min-width: 0` or a search field's intrinsic width will push the page wide — and **no form control may set text under 16px on a coarse pointer**, because iOS Safari zooms in on focus and does not zoom back
- **Sections preview rather than render whole.** 14 rows and 16 cards, with an explicit control for more. 811 books at six controls each is not a tab order.

## Do not

- No hardcoded hex or px in component rules. Tokens only.
- No rounded corners beyond the 4px panel radius. No arcs on ornament.
- **No Deco pastiche.** No sunbursts, no zigzags, no stepped ziggurat borders, no chevrons, no skyscraper motifs. The period reference lives in the type, the palette, the four ornaments on the spotlight and the square-ish corners, and that is the whole budget. A single sunburst turns this from a review into a themed restaurant.
- **No brass on running text.** Eyebrows and rules only.
- No second theme. No light mode, no toggle.
- No glassmorphism, no gradient fills, no elastic easing, no card translation on hover.
- No colour-only status.
- No score rendered as a gauge, ring, bar or progress element.
- No number written into the markup that the feed can count.
- No control visible by default that gets touched less than once a session.

## Accessibility review, 2026-08-28

Audited against the previous shell — the top masthead, the dock and the inline detail panel — all of which the 2026-08-30 rewrite replaced. Kept because three of its findings are rules rather than fixes, and those rules carried forward: a fixed element belongs in the document where it belongs to the keyboard, `details:not([open]) > *:not(summary) { display: none }` because Chrome's `content-visibility` leaks tab stops out of a closed panel, and 44px targets are not negotiable at phone width.

Its two recorded false positives no longer apply: neither the filter checkboxes nor the publication chips exist in the current shell.

Its one accepted risk — 2,699 focusable elements at 444 books — is answered rather than accepted now. Sections preview 14 rows or 16 cards and ask before rendering more.
