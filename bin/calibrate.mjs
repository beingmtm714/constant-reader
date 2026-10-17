#!/usr/bin/env node
// Runs the §11 calibration set through the scorer.
//
// The profile sets the tolerance itself: "If the model scores any of the twelve
// acquisitions below 70, or any pass above 65, the weights are wrong. Check D1 and
// D6 first."
//
// This validates the weights and the band mapping. It does not validate feed
// extraction — that is a separate problem with separate failure modes.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { score } from '../lib/score.mjs';
import { isRecommended, outOfTen } from '../web/lib/recommend.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'));

const profile = load('profile/taste-profile.json');
const lexicons = load('profile/lexicons.json');
const cal = load('profile/calibration.json');
const ruleTests = load('profile/rule-tests.json');
const { acquireFloor, passCeiling } = profile.calibrationTolerance;

const verbose = process.argv.includes('--verbose');
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
const GREEN = '\x1b[32m', RED = '\x1b[31m', YELLOW = '\x1b[33m', DIM = '\x1b[2m', OFF = '\x1b[0m';

const results = [];
for (const f of cal.fixtures) {
  if (only && f.id !== only) continue;
  const r = score({
    title: f.title, author: f.author, text: f.text, pages: f.pages,
    publisher: f.publisher, translated: f.translated, translator: f.translator,
    bookYear: f.year, subjects: ['Fiction'],
  }, profile, lexicons, { now: 2026 });

  let ok = true, expectation = '';
  if (f.expected === 'acquire') { ok = r.total >= acquireFloor; expectation = `>= ${acquireFloor}`; }
  else if (f.expected === 'pass') { ok = r.total <= passCeiling; expectation = `<= ${passCeiling}`; }
  else expectation = 'any';

  // A fixture the profile was deliberately changed away from. Its expected label
  // stays as the decision actually taken; the divergence records that the rules
  // moved, so the suite still catches regressions it did not sign off on.
  const diverged = (cal.divergences || []).find((d) => d.id === f.id);
  results.push({ f, r, ok, expectation, diverged: diverged && !ok ? diverged : null });
}

const w = (s, n) => String(s).padEnd(n).slice(0, n);
console.log(`\n  Calibration - reading taste profile rev ${profile.revision}`);
console.log(`  Acquisitions must score ${acquireFloor}+. Passes must score ${passCeiling} or below.\n`);
console.log(`  ${w('', 4)}${w('TITLE', 28)}${w('EXPECT', 11)}${w('SCORE', 8)}${w('BAND', 10)}WHY`);
console.log(`  ${'-'.repeat(100)}`);

for (const { f, r, ok } of results) {
  const mark = ok ? `${GREEN} ok ${OFF}` : (cal.divergences || []).some((d) => d.id === f.id) ? `${YELLOW} != ${OFF}` : `${RED} XX ${OFF}`;
  const why = r.filters.length
    ? `filtered: ${r.filters.map((x) => x.id).join(', ')}`
    : Object.values(r.dimensions).map((d) => `${d.dimension}:${d.score}`).join(' ') + (r.proseFloorApplied ? '  [prose floor]' : '');
  console.log(`  ${mark}${w(f.title, 28)}${w(f.expected, 11)}${w(r.total, 8)}${w(r.bandLabel, 10)}${DIM}${why}${OFF}`);
  if (verbose) {
    for (const d of Object.values(r.dimensions)) {
      console.log(`        ${d.dimension} ${String(d.score).padStart(2)}  ${w(d.label, 50)} ${DIM}${(d.evidence || []).slice(0, 6).join(', ')}${d.why ? ` -- ${d.why}` : ''}${OFF}`);
    }
    for (const a of r.adjustments) console.log(`        ${a.points > 0 ? '+' : ''}${a.points}  ${a.label}  ${DIM}[${(a.evidence || []).join(', ')}]${OFF}`);
    for (const x of r.filters) console.log(`        FILTER  ${x.label}  ${DIM}[${(x.evidence || []).slice(0, 5).join(', ')}]${OFF}`);
    console.log('');
  }
}

// ---------------------------------------------------------------- rule tests

const ruleResults = [];
if (!only) {
  for (const t of ruleTests.tests) {
    const r = score({ title: 'Test Fixture', author: 'A Writer', text: t.text,
      pages: 'pages' in t ? t.pages : 350, publisher: t.publisher,
      subjects: t.subjects ?? ['Fiction'], sections: t.sections },
      profile, lexicons, { now: 2026 });
    const applied = [...(r.adjustments || []), ...(r.notes || [])].find((a) => a.id === t.expect.penalty);
    let ok = true, got = '';
    if (t.expect.noPenalty) {
      const hit = [...(r.adjustments || []), ...(r.notes || [])].find((a) => a.id === t.expect.noPenalty);
      ok = !hit; got = hit ? `fired as ${hit.tier || 'flat'}` : 'did not fire';
    } else if (t.expect.penalty) {
      const tier = applied?.tier;
      const points = applied ? (applied.points ?? 0) : null;
      ok = tier === t.expect.tier && points === t.expect.points;
      got = applied ? `${tier} ${points}` : 'did not fire';
    } else if (t.expect.recommended !== undefined) {
      const c = t.context || {};
      const verdict = isRecommended({ scored: r, hasBook: true, identity: c.identity, fiction: c.fiction, inWindow: c.inWindow });
      ok = verdict.ok === t.expect.recommended
        && (!t.expect.because || verdict.because.includes(t.expect.because));
      got = `${outOfTen(r.total)}/10 ${verdict.ok ? 'tagged' : 'no tag'} - ${verdict.because}`;
    } else if (t.expect.dimension) {
      const d = r.dimensions[t.expect.dimension];
      ok = t.expect.band ? d.id === t.expect.band : d.score <= t.expect.maxScore;
      got = `${t.expect.dimension}:${d.score} ${d.id ?? 'default'}`;
    }
    ruleResults.push({ t, ok, got });
  }

  console.log(`\n  Rule tests - behaviour the §11 set does not reach\n`);
  for (const { t, ok, got } of ruleResults) {
    console.log(`  ${ok ? `${GREEN} ok ${OFF}` : `${RED} XX ${OFF}`}${w(t.id, 20)}${w(got, 26)}${DIM}${t.about}${OFF}`);
  }
  const rf = ruleResults.filter((x) => !x.ok).length;
  console.log(`\n  ${ruleResults.length - rf}/${ruleResults.length} rule tests pass.`);
}

const diverged = results.filter((x) => x.diverged);
const failed = results.filter((x) => !x.ok && !x.diverged);
const scored = results.filter((x) => x.f.expected !== 'borderline');
console.log(`\n  ${scored.length - failed.length - diverged.length}/${scored.length} within tolerance, ${diverged.length} deliberately diverged.`);
if (diverged.length) {
  console.log(`\n  ${YELLOW}Diverged from §11 by deliberate change:${OFF}`);
  for (const { f, r } of diverged) {
    const d = (cal.divergences || []).find((x) => x.id === f.id);
    console.log(`   ${YELLOW}!=${OFF} ${f.title} - you passed it, it now scores ${(r.total / 10).toFixed(1)}`);
    console.log(`      ${DIM}${d.reason}${OFF}`);
  }
}
const bl = results.find((x) => x.f.expected === 'borderline');
if (bl) console.log(`  Borderline: ${bl.f.title} scored ${bl.r.total} (${bl.r.bandLabel}) - §10.4 is still open.`);

const ruleFailed = ruleResults.filter((x) => !x.ok);
if (ruleFailed.length) {
  console.log(`\n  Rule tests failing:`);
  for (const { t, got } of ruleFailed) console.log(`   - ${t.id}: got ${got}`);
}
if (failed.length || ruleFailed.length) {
  console.log(`\n  Out of tolerance:`);
  for (const { f, r, expectation } of failed) {
    console.log(`   - ${f.title}: scored ${r.total}, expected ${expectation}${f.note ? ` -- ${f.note}` : ''}`);
  }
  console.log('');
  process.exit(1);
}
console.log('');
