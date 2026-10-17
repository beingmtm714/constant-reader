# Reading Taste Profile — Fiction Recommendation Spec

**Revision 2.** Built for tuning a personal book recommendation engine. Derived from stated favorites, explicit rejections, and revealed preference (which titles from candidate lists were actually saved versus passed over).

**What changed in rev 2:** the ground-truth positive set doubled from six titles to twelve. The dominant thesis of rev 1 — that every acquisition was a period novel set 1860–1948 — was falsified. Four of the six new acquisitions are contemporary-set or dual-timeline. Weights, filters, and traps have been rebuilt accordingly. The old thesis is preserved in §12 as a cautionary note about small-sample overfitting.

---

## 1. Ground truth

### Confirmed positives — canon

Stated, unprompted favorites. The anchor set.

| Title | Author | Year | Why it anchors |
|---|---|---|---|
| Underworld | Don DeLillo | 1997 | Top of canon. Systems-scale, polyphonic, an object traveling through decades, no protagonist at the center. Explicitly corrected as the DeLillo anchor — **not** White Noise. |
| American Pastoral | Philip Roth | 1997 | Narrator reconstructing an unknowable life against a national rupture. Industrial decline, generational catastrophe. |
| The Savage Detectives | Roberto Bolaño | 1998 | Structural ambition, testimonial polyphony, political menace, literary obsession. |
| The Secret History | Donna Tartt | 1992 | Aesthetic obsession, closed world, dread. |
| (author-level) | Josh Weil | — | Rural precision, quiet lyric register. |

### Confirmed positives — acquired and kept

**Highest-value signal in the profile.** Twelve titles across two rounds.

**Round 1**

| Title | Author | Year | Setting | Pages | Distortion | Engine |
|---|---|---|---|---|---|---|
| Now I Surrender | Álvaro Enrigue (tr. Wimmer) | 2026 | 19th c. Southwest/Mexico | ~400 | none | Conquest, violence |
| The Director | Daniel Kehlmann | 2024 | 1930s–40s Europe | ~340 | none | Artist under fascism |
| Biography of X | Catherine Lacey | 2023 | Alt-timeline 1945–96 US | ~400 | alternate history | Art, secession, invented national past |
| The Antidote | Karen Russell | 2025 | Nebraska, 1935 | ~430 | magical realism | Dust Bowl, land, amnesia |
| Angel Down | Daniel Kraus | 2026 | WWI | short | metaphysical horror | War, faith, cosmic dread |
| Rednecks | Taylor Brown | 2024 | West Virginia, 1921 | ~300 | none | Blair Mountain, labor, political violence |

**Round 2**

| Title | Author | Year | Setting | Pages | Distortion | Engine |
|---|---|---|---|---|---|---|
| The Sport of Kings | C.E. Morgan | 2016 | Kentucky, 3 generations | ~560 | none | Land, bloodstock, inheritance |
| Ohio | Stephen Markley | 2018 | Rust Belt, one night + flashback | ~490 | none | Post-industrial decay, the 2000s |
| The Topeka School | Ben Lerner | 2019 | Kansas, 1990s + present | ~290 | braided POV, essayistic | Institutional formation of political speech |
| The Nix | Nathan Hill | 2016 | Chicago 1968 + 2011 | ~620 | dual timeline | Generational politics, reconstruction |
| Ducks, Newburyport | Lucy Ellmann | 2019 | Ohio, contemporary | ~1000 | single sentence | Dread, industrial food, guns, water |
| Mercury Pictures Presents | Anthony Marra | 2022 | LA and Italy, 1940s | ~430 | polyphonic, playful | Film production under the wartime state |

### Confirmed negatives — explicit

| Item | Nature of rejection |
|---|---|
| Thomas Pynchon | Voice and comedic tone rejected; subject matter appealing. **Do not resolve this by recommending Pynchon-adjacent authors.** |
| Trust — Hernan Diaz | Prose admired, structure called trite. The archival frame resolved too neatly. |
| Nonfiction, all | An entire strong nonfiction slate declined outright. Hard filter. |
| Race/ethnicity as organizing subject | Stated directly: more interested in political, water, land, real estate. **See §7 Trap 2 — this filter was over-applied in rev 1 and has been narrowed.** |

### Revealed negatives — presented and passed over

Contemporary-set: Vera or Faith (Shteyngart), Chain-Gang All-Stars (Adjei-Brenyah), Wellness (Nathan Hill), Long Island Compromise (Brodesser-Akner), Martyr! (Akbar), The Shards (Ellis), The Emperor of Gladness (Vuong), The Rabbit Hutch (Gunty), The Deluge (Markley), The Candy House (Egan), The Glass Hotel (Mandel), The Immortal King Rao (Vara), Ministry for the Future (Robinson), Termination Shock (Stephenson), American War (El Akkad).

Period-set: James, The Trees (Everett), Wandering Stars (Orange), Let Us Descend (Ward), The Buffalo Hunter Hunter (Stephen Graham Jones), Blackouts (Torres), North Woods (Mason), The Vaster Wilds (Groff), Night Watch (Phillips), Cahokia Jazz (Spufford), Homestead (Moustakis), Damnation Spring (Davidson), Inland (Obreht), Golden Hill (Spufford), Manhattan Beach (Egan), The Cold Millions (Walter), Barkskins (Proulx), The Night Watchman (Erdrich), Unsheltered (Kingsolver), The Great Divide (Henríquez).

Note the significant passes: **Nathan Hill's Wellness passed, Nathan Hill's The Nix acquired.** Same author, same reconstruction instinct — the difference is scale, era-span, and political subject. **Markley's The Deluge passed twice, Markley's Ohio acquired.** Same author again. These two pairs are the single most diagnostic data in the profile.

---

## 2. The core thesis (revised)

**The organizing principle is not period. It is scale plus formal ambition plus institutional causation.**

Ten of twelve acquisitions are either 400+ pages, formally extreme, or both. Every acquisition treats an *institution or system* as the real protagonist — a levee board, a union local, a film studio, a debate circuit, a bloodstock operation, a psychoanalytic foundation, a Dust Bowl county — and uses individual lives as instruments for reading that system.

Contemporary settings are fully in range **when the book is explaining how the present was manufactured.** The Nix runs 1968 to 2011. The Topeka School runs the 1990s to now. Ohio runs the 2000s into their wreckage. What was passed over was not contemporary fiction but *contemporary fiction without historical causation* — books about a marriage, a career, a diagnosis, a feed.

Three secondary axes, all newly visible in round 2:

- **Sprawl is real.** Rev 1 called the stated preference for length contradicted by behavior. Round 2 refutes that flatly: 620, 560, 1000, 490 pages. The round-1 acquisitions were short because the candidate slates were short.
- **Institutional formation.** How a person is *made* by a school, a league, a plant, a farm, a studio, a movement. This is the subject beneath the subject.

---

## 3. Scoring dimensions

Weights sum to 100.

### D1 — Historical causation (weight 18)

Does the book explain how a present state of affairs was produced?

| Score | Condition |
|---|---|
| 10 | Dual or multi-timeline explicitly linking a historical rupture to the present (The Nix, Topeka School) |
| 10 | Period-set with the causal argument running forward implicitly (Rednecks, The Antidote, Mercury Pictures) |
| 9 | Multi-generational single-family or single-place sweep (Sport of Kings) |
| 8 | Contemporary-set but structured as aftermath of a specific historical process (Ohio, Ducks) |
| 3 | Contemporary-set with historical texture but no causal argument |
| 0 | Contemporary-set, causally sealed in the present — a marriage, a career, an illness, an internet |

**This replaces rev 1's "period setting" dimension, which was overfit.** Setting year is now a weak proxy, not a criterion.

### D2 — Subject engine (weight 18)

What drives causation in the plot, not what the book is thematically "about."

| Score | Engine |
|---|---|
| 10 | Land title, water rights, extraction, labor conflict, expropriation, real estate, resource law |
| 9 | State violence, political repression, insurgency, occupation, conquest |
| 9 | Institutional formation — schools, leagues, studios, unions, foundations, plants |
| 8 | Art or artists operating under political constraint |
| 6 | Religion, faith formation, theodicy, a belief system being built |
| 4 | Money and finance in the abstract |
| 2 | Family trauma, marriage, career, identity |
| 0 | Contemporary media culture, tech, wellness, internet life |

### D3 — Formal ambition (weight 18)

| Score | Condition |
|---|---|
| 10 | Radical constraint sustained at length (Ducks, Newburyport; Angel Down) |
| 10 | Alternate history or invented archive reframing national history (Biography of X, The Antidote) |
| 9 | Genuine polyphony — multiple voices, no center, documentary interstitials |
| 8 | Braided timelines or registers where the braid carries the argument (The Nix, Topeka School) |
| 5 | Conventional structure, exceptional prose |
| 3 | Formal device resolving into a twist or reveal |
| 0 | Device without consequence |

**Rev 1 rule retained, narrowed:** a formal frame in service of a purely psychological reveal scores 3, not 9. This is the *Trust* failure. But note The Nix and The Topeka School both do reconstruct a parent psychologically and were acquired — the difference is that the psychology is routed through 1968 and through Cold War Kansas respectively. Psychology is fine when it is *also* history.

### D4 — Prose register (weight 14)

| Score | Register |
|---|---|
| 10 | Lyric with dread underneath; quiet and loud both available; sentence-level distinctiveness |
| 9 | Dense, baroque, incantatory (Sport of Kings, Ducks) |
| 8 | Spare and precise (Weil mode) |
| 4 | Clean and functional — architecture carries it |
| 1 | Comic-maximalist, wry, quippy |
| 0 | Workshop-flat |

Note: Ohio scores ~6 here and was acquired, while The Deluge scores ~4 and was passed twice. The floor sits between those two.

### D5 — Tonal signature (weight 10)

| Score | Tone |
|---|---|
| 10 | Dread-forward, atmospheric, menacing, unresolved |
| 8 | Elegiac, haunted, mythic |
| 7 | Angry, indicting, morally hot (Sport of Kings, Ohio) |
| 6 | Cold, clinical, detached |
| 3 | Warm, humane, redemptive |
| 0 | Comic, satirical, farcical as the primary mode |

Satire remains close to disqualifying. Mercury Pictures is playful without being satirical — the distinction is whether the book's stance toward its subject is *superior*.

### D6 — Scale and sprawl (weight 14)

Weight raised from 8. Round 2 confirmed this as a real driver.

| Score | Condition |
|---|---|
| 10 | 500+ pages, multi-strand, decades-spanning |
| 9 | 400–500 pages with real structural ambition |
| 8 | Under 300 pages but formally extreme |
| 4 | 300–400 pages, conventional |
| 1 | Short and conventional |

### D7 — Independence and provenance (weight 8)

| Score | Signal |
|---|---|
| 10 | Independent or small press: Graywolf, Coffee House, New Directions, Fitzcarraldo, Archipelago, Deep Vellum, Two Lines, And Other Stories, Open Letter, Transit, Catapult, Tin House, Biblioasis |
| 8 | Literary imprint of a major house: FSG, Riverhead, Knopf, Hogarth, Pantheon, Simon & Schuster literary |
| 8 | Work in translation; Natasha Wimmer as translator is a strong positive on its own |
| 4 | Commercial imprint, literary positioning |
| 1 | Book club marketing apparatus, celebrity endorsement as primary positioning |

### Setting geography — deliberately not scored

Nine of twelve acquisitions are set in the American interior. **This is a confound, not a preference, and must not be scored.** The candidate slates that produced those acquisitions were built around land, labor, extraction, and agricultural subjects — and American fiction on those subjects is disproportionately set in the interior. Region is downstream of D2, not independent of it.

Confirmed directly by the reader after rev 2 proposed a regional modifier: region is not a factor. Do not reintroduce it, and treat any future regional correlation in the data as an artifact of subject selection unless it survives a slate where subject and geography are varied independently.

---

## 4. Hard filters — auto-exclude

1. **Nonfiction.**
2. **Satire as primary mode.**
3. **Pynchon and direct stylistic descendants.**
4. **Structural device resolving into a twist.**
5. **Contemporary-set fiction with no historical causal argument** — replaces rev 1's blanket contemporary exclusion, which was wrong.
6. **Anything marketed primarily as book club fiction.**

**Removed in rev 2:** the blanket "race or ethnicity as central engine" filter. See Trap 2.

---

## 5. Soft penalties

| Penalty | Condition |
|---|---|
| −15 | Household-name author with a current prestige-TV adaptation |
| −10 | Genre framing explicit and load-bearing (vampire novel, thriller, procedural) rather than absorbed |
| −10 | Redemptive ending, healing arc, earned resolution |
| −8 | First-person protagonist who is a writer processing their own life, with no political frame |
| −5 | Under 250 pages and conventionally structured |

**Removed in rev 2:** the −8 penalty for a present-day framing narrator bookending a historical story. The Nix and The Topeka School both do exactly this and were acquired.

---

## 6. Thresholds

| Score | Action |
|---|---|
| 78+ | Lead recommendation, full argument |
| 62–77 | Present with an explicit flag naming the risk. Flagging works — surface the objection rather than hiding it. |
| 45–61 | Reserve |
| <45 | Do not surface |

Three to five titles per request. Exception: an explicit request for volume, in which case group by subject axis rather than ranking flat. A 25-item grouped list produced a 24% acquisition rate — the highest of any format tried.

---

## 7. Known traps

**Trap 1 — Overfitting to a small positive set.** Rev 1 built its entire thesis on six books and produced a rule ("period only, 1860–1948") that the next six acquisitions demolished. Require at least fifteen positives before treating any single dimension as near-deterministic, and always express the dominant hypothesis as falsifiable.

**Trap 2 — The race filter, over-applied.** Rev 1 hard-excluded books where race was the central engine, based on a direct statement of preference. But The Sport of Kings was acquired *after* being explicitly flagged for exactly that, and The Antidote engages dispossession throughout. The real rule is narrower: books where racial history is the *sole* engine, with no land, labor, or institutional machinery underneath it, have consistently been passed (James, Wandering Stars, Let Us Descend, The Trees). Books where it runs through property, inheritance, or labor have been acquired. Score via D2, do not filter.

**Trap 3 — Prose is a floor, not a tiebreaker.** The Deluge scores near-perfectly on subject, scale, and systems-thinking and was declined twice on sentences alone. But Ohio, with unremarkable prose, was acquired. The floor is real and it sits low — around a 5 on D4 — but below it nothing compensates.

**Trap 4 — Land fiction at the wrong scale.** Homestead and Damnation Spring hit the subject engine precisely and were passed — both single-couple, single-season. Sport of Kings, three generations on the same Kentucky ground, was acquired. Land requires institutional or multi-decade scale.

**Trap 5 — Prizes are evidence quality, not ranking signal.** Pulitzer and NBA winners have a poor hit rate (James, Night Watch, Blackouts, The Rabbit Hutch — all passed). Do not weight prizes into the score. Use them only to source reliable critical evidence.

**Trap 6 — Same author, different book.** Nathan Hill and Stephen Markley each have one acquisition and one pass. Never recommend on author identity. Score every title independently.

---

## 8. Evidence and justification requirements

Stated preference: answers grounded in peer-reviewed research or official, vetted documents where possible. For fiction this governs how recommendations are *justified*, not what qualifies.

**Acceptable:** prize citations from the awarding body directly (pulitzer.org, nationalbook.org, thebookerprizes.com), reviews in LARB, NYRB, NPR, Kirkus, Publishers Weekly, Shelf Awareness, Chicago Review of Books, academic press catalogs, scholarly reviews.

**Not acceptable:** publisher blurb copy, Goodreads aggregate ratings, Amazon editorial copy, commercial listicles.

Each recommendation should carry: publication year, publisher/imprint, translator if applicable, page count, setting-year range, and one piece of vetted critical evidence. State plainly when a title falls outside a requested window rather than quietly including it.

---

## 9. Cold start and exploration

- **Default window:** last 10 years. Negotiable — it has been widened twice on request. Flag out-of-window titles explicitly rather than suppressing them.
- **Exploration budget:** one in five recommendations should test an *Open* hypothesis from §10 rather than maximize expected score.
- **Never** re-recommend a discussed title without flagging it as an intentional repeat with new reasoning.
- **Adjacent domains for tie-breaking:** film taste runs Criterion, MUBI, A24, SpectreVision — atmospheric and dread-forward over jump-scare, international and classic fully in range. A novel that fits MUBI's programming logic is likely in range. Music taste favors literary, politically grounded, regionally specific, small-label work; the same instinct applies to publishing.
- **Geography is not a tie-breaker.** Do not use setting location to rank, in either direction. See §3.
- **Creative reference:** an in-development project concerns a mass event that produces a new religion and a pilgrimage settlement. Novels where a catastrophe generates a belief system carry an additional bonus as working reference.

---

## 10. Open questions

**Resolved in rev 2:**
- ~~Does the 1948 ceiling hold?~~ **No.** Falsified by four acquisitions.
- ~~Is sprawl actually wanted?~~ **Yes.** Confirmed decisively.
- ~~Is the race filter about subject or register?~~ **Partially resolved** — see Trap 2. Narrowed to a scoring input.

**Still open:**
1. **How explicit can the supernatural be?** Magical realism and metaphysical horror both landed; an explicit vampire novel did not. Test with folk horror or a ghost story with no genre framing.
2. **Is translation a genuine positive?** Two of twelve. Test with a translated European or Latin American historical novel at length.
3. **Where is the lower bound on length?** Angel Down and The Topeka School are both short and both landed, but both are formally unusual. Test a conventionally structured novel under 250 pages — expected to fail.
4. **Where does Manhattan Beach actually land?** With the regional penalty removed it becomes a genuine borderline case rather than a clear pass — period-set, institutional, waterfront labor, 400+ pages, but conventional in form. It is now the cleanest single test of whether D3 formal ambition is a hard requirement or a strong preference.
5. **Does the D4 prose floor hold below Ohio?** Test one book with genuinely plain prose and perfect scores elsewhere.
6. **Is genre absorption possible at all?** Every explicitly genre-framed candidate has been passed. Test one literary novel with a fully absorbed genre skeleton.

---

## 11. Calibration set

Score with current weights and check against expected labels.

| Title | Expected | Reason |
|---|---|---|
| Biography of X | Acquire | Alt-history national past, invented archive, dread |
| The Antidote | Acquire | 1935, land, magical realism, interior setting |
| Rednecks | Acquire | 1921, labor insurrection, Appalachia |
| Angel Down | Acquire | WWI, sustained formal constraint, horror |
| The Director | Acquire | Artist under fascism, cold register |
| Now I Surrender | Acquire | Conquest, violence, translated, structural menace |
| The Sport of Kings | Acquire | Kentucky land, three generations, baroque prose, 560pp |
| Ohio | Acquire | Rust Belt aftermath, multi-voice, 490pp |
| The Topeka School | Acquire | Institutional formation of political speech, braided |
| The Nix | Acquire | 1968→2011, reconstruction, 620pp |
| Ducks, Newburyport | Acquire | 1000pp single sentence, Ohio, dread |
| Mercury Pictures Presents | Acquire | Studio under wartime state, polyphonic, 1940s |
| The Deluge | Pass | Architecture perfect; prose below floor |
| Wellness | Pass | Contemporary, causally sealed, comic |
| James | Pass | Race-engine with no land or institutional machinery |
| Vera, or Faith | Pass | Satirical, near-future, short |
| Martyr! | Pass | Psychological reconstruction, no historical causation |
| Trust | Pass | Device resolves; called trite |
| Homestead | Pass | Land subject exact; scale far too small |
| The Buffalo Hunter Hunter | Pass | Explicit genre framing, race-engine |
| The Rabbit Hutch | Pass | Contemporary, causally sealed |
| Long Island Compromise | Pass | Comic-maximalist, suburban, contemporary |
| Manhattan Beach | Borderline | Period, institutional, waterfront labor, 400+pp — but conventional in form. Predicted pass on D3 alone. Unverified; see §10.4. |
| The Candy House | Pass | Polyphonic and ambitious but contemporary tech subject |

If the model scores any of the twelve acquisitions below 70, or any pass above 65, the weights are wrong. Check D1 and D6 first — those two carry the rev 2 correction.

---

## 12. Cautionary note: what rev 1 got wrong

Rev 1 stated, with confidence: *"Every single confirmed acquisition is a period novel set between roughly 1860 and 1948. Not one acquisition is contemporary-set."*

That was true of the six books available. It was also an artifact of which candidates had been presented — the slates that produced those six were heavily period-weighted, and the contemporary candidates on offer happened to be satirical or domestic, which are separately disqualifying. The rule confused a filter's *output* with the reader's *criterion*.

Guard against this structurally: whenever a dimension appears to be near-deterministic, check whether the negative examples were ever genuinely available to be chosen. A dimension that has never been independently varied has not been tested.

**Rev 2 then made the same error again.** It observed that nine of twelve acquisitions were set in the American interior and proposed a ±6 regional modifier. The reader rejected it immediately. The correlation was real but derivative: slates built around land, labor, and extraction produce interior settings by default, so geography had never been varied independently of subject either. Two rounds, two confounds, both caught only after the fact.

The operational lesson: **correlation in the positive set is not a criterion until the dimension has been varied against a controlled slate.** Before promoting any observed pattern to a scoring dimension, ask what a candidate would look like that scores high on this pattern and low on everything else — and whether such a candidate was ever actually offered. If not, the pattern is a description of the recommender, not of the reader.
