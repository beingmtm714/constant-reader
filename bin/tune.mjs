#!/usr/bin/env node
// What your saves argue the profile's weights should be — and what that breaks.
//
//   node bin/tune.mjs                       read the exported verdicts in data/
//   node bin/tune.mjs --file=verdicts.json  read a specific export
//
// The browser tunes a *score* live, which is the right place for it: a save
// should visibly do something. A *weight* is a different kind of change. The
// weights are a written document at revision 2, with twenty-four calibration
// fixtures behind them and an `amendments` array recording why each departure
// from the original spec was made. The whole reason that apparatus exists is
// that nobody gets to move a weight without saying so.
//
// So this writes nothing. It proposes, re-scores every fixture under the
// proposal, prints what would break, and prints the exact edit. An earlier
// draft had an --apply flag; it was removed after it silently rewrote the
// profile through JSON.stringify on a test run — reformatting a hand-commented
// document and leaving no amendment behind. Applying it is a decision, and a
// decision belongs in an edit you make and can explain.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { score } from '../lib/score.mjs';
import { buildTasteModel, weightProposal } from '../web/lib/taste.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'));

const args = process.argv.slice(2);
const arg = (n) => args.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
const flag = (n) => args.includes(`--${n}`);

const GREEN = '\x1b[32m', RED = '\x1b[31m', YELLOW = '\x1b[33m', DIM = '\x1b[2m', OFF = '\x1b[0m';
const w = (s, n) => String(s).padEnd(n).slice(0, n);

const profile = load('profile/taste-profile.json');
const lexicons = load('profile/lexicons.json');
const cal = load('profile/calibration.json');
const { acquireFloor, passCeiling } = profile.calibrationTolerance;

// ---------------------------------------------------------------- the saves

// The feed carries the books; the export carries the verdicts. Both are files
// this app already writes, so there is no new format and nothing to keep in
// sync — "Export my verdicts" in the footer produces exactly what this reads.
const feedPath = join(root, 'web', 'data', 'feed.json');
if (!existsSync(feedPath)) {
  console.error(`\n  No feed to read. Run 'npm run build' first.\n`);
  process.exit(1);
}
const feed = JSON.parse(readFileSync(feedPath, 'utf8'));

// resolve() rather than join(): an absolute --file path joined onto the cwd
// becomes a nonsense path under it, and silently reports the wrong file missing.
const exportPath = arg('file')
  ? resolve(process.cwd(), arg('file'))
  : join(root, 'data', 'verdicts.json');

if (!existsSync(exportPath)) {
  console.error(`\n  No verdicts at ${exportPath}.`);
  console.error(`  Open the feed, press "Export my verdicts" in the footer, and save the file there`);
  console.error(`  — or point at it with --file=<path>.\n`);
  process.exit(1);
}

const raw = JSON.parse(readFileSync(exportPath, 'utf8'));
// The export is a list of rows carrying the verdict and enough of the book to
// read without the feed. Re-key it into the shape the model wants.
const verdicts = {};
for (const row of raw.verdicts || []) {
  const id = row.id || feed.books.find((b) => b.book.title === row.title)?.id;
  if (id) verdicts[id] = { verdict: row.verdict, savedAt: row.savedAt ?? null };
}

const model = buildTasteModel(verdicts, feed.books, feed.dimensions);

console.log(`\n  Tuning against ${model.savedCount} saved and ${model.passedCount} passed`);
console.log(`  ${DIM}exported ${raw.exported || 'at an unknown time'}, profile revision ${profile.revision}${OFF}\n`);

if (!model.ready) {
  console.log(`  Not enough saved to argue anything. ${model.savedCount} of the ${3} needed.\n`);
  process.exit(0);
}

const names = Object.fromEntries(feed.dimensions.map((d) => [d.id, d.name]));
const proposal = weightProposal(model, names);

if (!proposal.length) {
  console.log(`  ${GREEN}Your saves agree with the profile.${OFF} No dimension is far enough off its`);
  console.log(`  weighting to argue for a change.\n`);
  process.exit(0);
}

console.log(`  ${w('', 4)}${w('DIMENSION', 34)}${w('NOW', 6)}${w('ARGUED', 8)}${w('SAVES', 8)}${w('FIELD', 8)}N`);
console.log(`  ${'-'.repeat(78)}`);
for (const p of proposal) {
  const mark = p.delta > 0 ? `${GREEN} +  ${OFF}` : `${YELLOW} -  ${OFF}`;
  console.log(`  ${mark}${w(`${p.id} · ${p.name}`, 34)}${w(p.current, 6)}${w(`${p.suggested} (${p.delta > 0 ? '+' : ''}${p.delta})`, 8)}${w(p.savedMean, 8)}${w(p.fieldMean, 8)}${p.n}`);
}

// ---------------------------------------------------------------- the damage

// Re-score every fixture under the proposed weights and compare verdicts. This
// is the whole point of the script: a weight change that reads sensibly in a
// table can still drop three acquisitions below the floor.
const proposed = structuredClone(profile);
for (const p of proposal) {
  proposed.dimensions.find((d) => d.id === p.id).weight = p.suggested;
}

const run = (prof) => cal.fixtures.map((f) => {
  const r = score({
    title: f.title, author: f.author, text: f.text, pages: f.pages,
    publisher: f.publisher, translated: f.translated, translator: f.translator,
    bookYear: f.year, subjects: ['Fiction'],
  }, prof, lexicons, { now: 2026 });
  const ok = f.expected === 'acquire' ? r.total >= acquireFloor
    : f.expected === 'pass' ? r.total <= passCeiling : true;
  return { f, total: r.total, ok };
});

const before = run(profile);
const after = run(proposed);

const broke = [];
const fixed = [];
for (let i = 0; i < before.length; i++) {
  if (before[i].ok && !after[i].ok) broke.push({ ...after[i], was: before[i].total });
  if (!before[i].ok && after[i].ok) fixed.push({ ...after[i], was: before[i].total });
}

const total = proposed.dimensions.reduce((s, d) => s + d.weight, 0);
console.log(`\n  Weights would total ${total}${total !== 100 ? ` ${YELLOW}(not 100 — the scorer renormalises, but the shares shift)${OFF}` : ''}.`);

console.log(`\n  Against the ${cal.fixtures.length} calibration fixtures:`);
const moved = after.map((a, i) => ({ ...a, was: before[i].total })).filter((x) => Math.abs(x.total - x.was) >= 0.5);
console.log(`  ${moved.length} fixtures move by half a point or more.`);

if (fixed.length) {
  console.log(`\n  ${GREEN}Would start passing:${OFF}`);
  for (const x of fixed) console.log(`   ${GREEN}+${OFF} ${w(x.f.title, 30)} ${x.was} -> ${x.total} (wants ${x.f.expected})`);
}
if (broke.length) {
  console.log(`\n  ${RED}Would break:${OFF}`);
  for (const x of broke) console.log(`   ${RED}x${OFF} ${w(x.f.title, 30)} ${x.was} -> ${x.total} (wants ${x.f.expected})`);
} else {
  console.log(`\n  ${GREEN}Nothing that passes now would break.${OFF}`);
}

// ---------------------------------------------------------------- the edit

console.log(`\n  ${DIM}Nothing has been written. To take this proposal, edit${OFF} profile/taste-profile.json:`);
for (const p of proposal) {
  console.log(`    ${w(`${p.id}`, 5)} weight ${p.current} -> ${p.suggested}`);
}
console.log(`  ${DIM}then add a line to its ${OFF}amendments${DIM} array saying that the change came from`);
console.log(`  ${model.savedCount} saves rather than from the spec, and re-run ${OFF}npm run check${DIM}.${OFF}`);
if (broke.length) {
  console.log(`\n  ${RED}Read the breakage above first.${OFF} ${broke.length} fixture${broke.length === 1 ? '' : 's'} that pass${broke.length === 1 ? 'es' : ''} today would`);
  console.log(`  stop. That is not necessarily a reason not to do it — the D2/D4/D5/D6 softening`);
  console.log(`  broke three on purpose and recorded them as divergences — but it is a reason to`);
  console.log(`  do it deliberately rather than because a script suggested it.`);
}
console.log('');
