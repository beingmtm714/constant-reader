#!/usr/bin/env node
// Probes every source, enabled or not, and reports what the network actually says.
//
// The disabled ones are disabled because they failed from the machine this was
// built on. Several of those failures are IP-reputation blocks, which means they
// may well succeed from a laptop on a home connection — but that is a guess until
// something measures it, which is what this does.
//
//   node bin/check-sources.mjs            report only
//   node bin/check-sources.mjs --fix      also flip anything that now works to enabled

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ensureProxyAware } from '../lib/proxy.mjs';
import { Http } from '../lib/http.mjs';
import { parseFeed } from '../lib/xml.mjs';

ensureProxyAware();

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const registryPath = join(root, 'sources.json');
const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
const fix = process.argv.includes('--fix');

const GREEN = '\x1b[32m', RED = '\x1b[31m', YELLOW = '\x1b[33m', DIM = '\x1b[2m', OFF = '\x1b[0m';
const http = new Http({ cacheDir: join(root, '.cache'), ttlHours: 0, delayMs: 400 });

// What a failure actually is, which decides whether it is worth retrying elsewhere.
function diagnose(res, body) {
  if (!res.ok) {
    const s = res.status;
    if (s === 403 || s === 401) return { kind: 'blocked', note: 'refused outright - usually IP reputation or a WAF rule' };
    if (s === 404) return { kind: 'gone', note: 'no feed at this path any more' };
    if (s === 429) return { kind: 'ratelimited', note: 'rate limited' };
    return { kind: 'error', note: res.error || `HTTP ${s}` };
  }
  const head = body.slice(0, 400).toLowerCase();
  if (/verifying your device|toadmash|monocle|challenge-platform|cf-browser-verification/.test(head)) {
    return { kind: 'js-challenge', note: 'device-verification wall - needs a real browser, not an IP change' };
  }
  if (/sgcaptcha|captcha|are you a robot/.test(head)) {
    return { kind: 'captcha', note: 'CAPTCHA interstitial - usually IP reputation' };
  }
  if (/^\s*<!doctype html|^\s*<html/.test(head) && !/<rss|<feed|<\?xml/.test(head)) {
    return { kind: 'not-a-feed', note: 'serves HTML at the feed path' };
  }
  return null;
}

const results = [];
for (const source of registry.sources) {
  // An archive source has no URL to check. What matters about it is whether
  // bin/archive.mjs has left it anything to do, so that is what gets reported.
  if (source.kind === 'archive') {
    const path = join(root, 'data', 'archive', `${source.backlog || source.id}.json`);
    let left = 0, total = 0;
    if (existsSync(path)) {
      try {
        const b = JSON.parse(readFileSync(path, 'utf8'));
        total = (b.entries || []).length;
        left = (b.entries || []).filter((e) => !e.taken).length;
      } catch { /* reported as empty below */ }
    }
    results.push({
      source, ok: left > 0, count: left,
      why: left ? null : { kind: 'backlog', note: total ? 'every discovered address has been handed to a build' : 'nothing discovered yet - run npm run archive' },
    });
    continue;
  }
  if (source.kind === 'larb') {
    const res = await http.get(source.url, { allowCache: false });
    const ok = res.ok && res.body.includes('__NEXT_DATA__');
    results.push({ source, ok, count: ok ? (res.body.match(/"slug":/g) || []).length : 0, why: ok ? null : diagnose(res, res.body || '') });
    continue;
  }
  const res = await http.get(source.url, { allowCache: false });
  const why = diagnose(res, res.body || '');
  const items = res.ok && !why ? parseFeed(res.body, source.url) : [];
  results.push({ source, ok: items.length > 0, count: items.length, why: why || (res.ok && !items.length ? { kind: 'empty', note: 'parsed but carried no items' } : null) });
}

const w = (s, n) => String(s).padEnd(n).slice(0, n);
console.log(`\n  Source check - ${results.length} sources\n`);
console.log(`  ${w('', 5)}${w('SOURCE', 16)}${w('STATE', 10)}${w('ITEMS', 7)}WHAT HAPPENED`);
console.log(`  ${'-'.repeat(100)}`);

const newlyWorking = [], stillBroken = [], regressions = [], offByChoice = [];
for (const r of results) {
  const wasEnabled = r.source.enabled;
  let mark, note;
  if (r.ok) {
    mark = `${GREEN} ok ${OFF}`;
    // Reachable is not the same as wanted. Harper's, the New Republic and Lit Hub
    // all answer perfectly well; they are off because their feeds are essays and
    // round-ups rather than reviews, and re-enabling them would just add noise.
    const editorial = r.source.disabledKind === 'editorial';
    note = wasEnabled ? '' : editorial
      ? `${DIM}reachable, off by choice - ${r.source.disabledReason ?? ''}${OFF}`
      : `${YELLOW}works now - currently disabled${OFF}`;
    if (!wasEnabled && !editorial) newlyWorking.push(r);
    if (!wasEnabled && editorial) offByChoice.push(r);
  } else {
    mark = `${RED} XX ${OFF}`;
    note = `${r.why?.kind ?? 'failed'} - ${r.why?.note ?? ''}`;
    if (wasEnabled) regressions.push(r); else stillBroken.push(r);
  }
  console.log(`  ${mark} ${w(r.source.short, 16)}${w(wasEnabled ? 'enabled' : 'disabled', 10)}${w(r.count || '-', 7)}${DIM}${note}${OFF}`);
}

console.log('');
if (regressions.length) {
  console.log(`  ${RED}${regressions.length} enabled source${regressions.length === 1 ? '' : 's'} stopped working:${OFF}`);
  for (const r of regressions) console.log(`   - ${r.source.name}: ${r.why?.note}`);
  console.log('');
}
if (newlyWorking.length) {
  console.log(`  ${GREEN}${newlyWorking.length} disabled source${newlyWorking.length === 1 ? '' : 's'} answered from this machine:${OFF}`);
  for (const r of newlyWorking) console.log(`   - ${r.source.name} (${r.count} items)`);
  console.log(fix ? '' : `\n  Re-run with --fix to enable them, then 'npm run build'.\n`);
}
if (offByChoice.length) {
  console.log(`  ${DIM}${offByChoice.length} reachable but deliberately off (editorial, not technical):${OFF}`);
  for (const r of offByChoice) console.log(`   ${DIM}- ${r.source.name}: ${r.source.disabledReason}${OFF}`);
  console.log('');
}
if (stillBroken.length) {
  const jsWalled = stillBroken.filter((r) => r.why?.kind === 'js-challenge');
  console.log(`  ${DIM}${stillBroken.length} still unavailable:${OFF}`);
  for (const r of stillBroken) console.log(`   ${DIM}- ${r.source.name}: ${r.why?.kind} - ${r.why?.note}${OFF}`);
  if (jsWalled.length) {
    console.log(`\n  ${YELLOW}Note:${OFF} a device-verification wall is the publisher deliberately blocking automated`);
    console.log(`  clients. That does not change with your IP, and this tool will not work around it.`);
  }
  console.log('');
}

if (fix && newlyWorking.length) {
  for (const r of newlyWorking) {
    const entry = registry.sources.find((s) => s.id === r.source.id);
    entry.enabled = true;
    delete entry.disabledReason;
    delete entry.disabledKind;
  }
  writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n');
  console.log(`  Enabled ${newlyWorking.length} source${newlyWorking.length === 1 ? '' : 's'} in sources.json. Run 'npm run build'.\n`);
}
