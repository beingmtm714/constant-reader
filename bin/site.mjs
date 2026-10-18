#!/usr/bin/env node
// Assembles the static site from web/ into site/, which the Pages workflow
// deploys. Nothing outside web/ is ever served.
//
// The files about to go out are scanned first for the handful of things that
// must never be published, because a static site is a permanent, indexed copy.
//
//   npm run site               build site/
//   npm run site -- --out=dir  build somewhere else

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, rmSync, cpSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (n, d) => (argv.find((a) => a.startsWith(`--${n}=`)) || `=${d}`).split('=').slice(1).join('=');

const out = join(root, opt('out', 'site'));
const LIVE = 'https://www.constantreader.app/';

const die = (msg) => { console.error(`\n  ${msg}\n`); process.exit(1); };

// ---------------------------------------------------------------- checks

const feed = join(root, 'web', 'data', 'feed.json');
if (!existsSync(feed)) die('No web/data/feed.json. Run `npm run build` first, or the site publishes with nothing in it.');

const built = JSON.parse(readFileSync(feed, 'utf8'));
const ageDays = Math.floor((Date.now() - Date.parse(built.builtAt)) / 86400000);

// What must never leave this machine. Deliberately narrow: a scanner that cries
// wolf gets ignored, and "token" alone matches this app's own design tokens.
const FORBIDDEN = [
  [/\/Users\/[a-z]/i, 'an absolute home path'],
  [/[\w.+-]+@(?!example\.)[\w-]+\.[a-z]{2,}/i, 'an email address'],
  [/\b(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})\b/, 'a credential'],
  // The Google Books key is read at build time and never written into web/, so this
  // is a backstop rather than the defence. It is here because a key that only ever
  // lives in one gitignored file is exactly the kind that gets pasted into a config
  // object later.
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'a Google API key'],
  [/(api[_-]?key|client[_-]?secret|access[_-]?token)\s*[:=]\s*["'][^"']{8,}/i, 'an assigned secret'],
  [/Authorization\s*:\s*["'`]?(Bearer|Basic)\s/i, 'an authorization header'],
];

const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === '.DS_Store') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p); else files.push(p);
  }
}(join(root, 'web')));

// The one string that is allowed to match and still ship: the Firebase web config
// key, which identifies the project to the browser and is public by design. It is
// allowlisted as an exact string rather than by carving out its file or loosening
// the pattern, because the rule's whole job is to catch the *other* Google key -
// the server-side Books one - and a rule with a hole shaped like a filename is a
// rule that stops working the day someone moves the file.
//
// It is tested against the whole match rather than compared to it, because two rules
// catch this key and they capture different amounts of the line around it: the
// AIza rule matches the bare key, and the assigned-secret rule matches
// "apiKey: 'AIza...". An equality check passed the first and failed the second,
// which is how the first attempt at this got refused. The exact key must still
// appear inside the match, so the allowlist is no looser than one literal string.
const PUBLIC_KEYS = ['AIzaSyAvJLmjkycIXXLaPTfjTgPIovSnUZoU1Eo'];
const isPublic = (match) => PUBLIC_KEYS.some((k) => match.includes(k));

const found = [];
for (const f of files) {
  if (/\.(png|jpe?g|gif|woff2?|ico)$/i.test(f)) continue;
  const text = readFileSync(f, 'utf8');
  for (const [re, what] of FORBIDDEN) {
    const m = text.match(re);
    if (m && isPublic(m[0])) continue;
    if (m) found.push(`${relative(root, f)}: ${what} — ${m[0].slice(0, 60)}`);
  }
}
if (found.length) {
  die(`Refusing to build the site. It is public and these would go with it:\n\n${found.map((x) => `    ${x}`).join('\n')}`);
}

// ---------------------------------------------------------------- copy

console.log(`
  ${built.books.length} books, built ${ageDays === 0 ? 'today' : `${ageDays}d ago`}`);
console.log(`  web/  ->  ${relative(root, out) || out}/`);

// Rebuilt from nothing every time, so a file deleted from web/ cannot linger
// in a deploy.
rmSync(out, { recursive: true, force: true });
cpSync(join(root, 'web'), out, { recursive: true, filter: (src) => !src.endsWith('.DS_Store') });

checkPreviewUrls(out);
writeAskUrl(out);
stampVersion(out);
console.log(`  Ready to deploy: ${relative(root, out) || out}/
`);



// Where search sends a question to be read for meaning (worker/). It comes
// from the environment because it is a deploy setting, not code: the
// workflow passes the ASK_URL repository variable, and without one the site
// ships keyword search only, which is what `npm start` always serves. Written
// before stamping so the stamp covers it.
function writeAskUrl(dir) {
  const url = (process.env.ASK_URL || '').trim();
  if (!url) { console.log('  Ask: off (no ASK_URL), search is keyword-only'); return; }
  if (!/^https:\/\/[^\s'"]+$/.test(url)) die(`ASK_URL must be an https address, not ${JSON.stringify(url)}`);
  writeFileSync(join(dir, 'lib', 'ask-config.mjs'), `export const ASK_URL = ${JSON.stringify(url)};\n`);
  console.log(`  Ask: ${url}`);
}

// Open Graph needs absolute URLs, so index.html carries this site's address in
// two places rather than deriving it. A guard rather than a rewrite: if the site
// ever moves, the right answer is for a person to notice, not for the publish to
// quietly point a link preview somewhere else.
function checkPreviewUrls(dir) {
  const html = readFileSync(join(dir, 'index.html'), 'utf8');
  const urls = [...html.matchAll(/(?:property="og:(?:url|image)"|name="twitter:image") content="([^"]+)"/g)].map((m) => m[1]);
  if (!urls.length) die('index.html carries no og:url or og:image, so a shared link previews as a bare address.');
  const wrong = urls.filter((u) => !u.startsWith(LIVE));
  if (wrong.length) die(`These preview URLs do not point at ${LIVE}:\n    ${wrong.join('\n    ')}`);
}

// ---------------------------------------------------------------- versioning

// Why every asset URL carries a build stamp.
//
// GitHub Pages serves this app with `cache-control: max-age=600`, which means a
// browser is told it may reuse app.js, app.css and every module for ten minutes
// without asking. iOS Safari holds ES modules a good deal longer than that, and
// there is no reload gesture in an installed web app: swiping it away closes the
// window and leaves the cache exactly where it was.
//
// That has now cost this project real time three times. Twice a shipped fix was
// read as not shipped because the browser was serving an old lib/*.mjs, and once
// Michael was looking at soft covers on a phone that was still running the code
// from before the fix, with no way to make it stop.
//
// A query string is enough to end it: a new build is a new URL, so a stale entry
// can never be served for it. The stamp is a hash of the assets themselves
// rather than the time, so a publish that changes nothing changes no URL and the
// caches that are warm stay warm.
//
// The rewrite happens in site/, never in web/. Working files keep
// clean paths, and `npm start` serves them unstamped.
function stampVersion(dir) {
  const assets = ['app.js', 'app.css', ...readdirSync(join(dir, 'lib')).filter((f) => f.endsWith('.mjs')).sort().map((f) => `lib/${f}`)];
  const h = createHash('sha256');
  for (const rel of assets) h.update(readFileSync(join(dir, rel)));
  const v = h.digest('hex').slice(0, 10);

  // index.html points at the two entry files.
  const indexPath = join(dir, 'index.html');
  writeFileSync(indexPath, readFileSync(indexPath, 'utf8')
    .replace(/href="app\.css(\?v=[^"]*)?"/g, `href="app.css?v=${v}"`)
    .replace(/src="app\.js(\?v=[^"]*)?"/g, `src="app.js?v=${v}"`));

  // Every module import inside them. A relative specifier resolves against the
  // importing URL without its query, so stamping the entry alone would leave the
  // whole of lib/ cached — which is exactly where the stale code was.
  for (const rel of assets.filter((f) => f.endsWith('.js') || f.endsWith('.mjs'))) {
    const file = join(dir, rel);
    writeFileSync(file, readFileSync(file, 'utf8')
      .replace(/(from\s+['"])(\.[^'"]+\.mjs)(['"])/g, `$1$2?v=${v}$3`)
      .replace(/(import\(\s*['"])(\.[^'"]+\.mjs)(['"])/g, `$1$2?v=${v}$3`));
  }
  // The version also goes into the feed, which is the one file the running app
  // always revalidates. That is what lets a stale copy of the app notice it is
  // stale: index.html is the entry point and so cannot carry a stamp of its own,
  // and GitHub Pages gives no way to shorten its ten minutes.
  const feedPath = join(dir, 'data', 'feed.json');
  const feed = JSON.parse(readFileSync(feedPath, 'utf8'));
  feed.assetVersion = v;
  writeFileSync(feedPath, JSON.stringify(feed));

  console.log(`  Stamped ${assets.length} assets with ?v=${v}`);
}
