// An accumulating store.
//
// Most of these feeds carry ten to twenty items, a fortnight of publishing at most.
// Rebuilding from scratch each time would make the feed permanently shallow, so
// entries persist and each run merges in what is new. Sorting by book publication
// date only becomes useful once there is a back catalogue to sort.

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

export function load(path) {
  if (!existsSync(path)) return { version: 1, firstBuilt: new Date().toISOString(), entries: {} };
  try {
    const s = JSON.parse(readFileSync(path, 'utf8'));
    if (!s.entries) s.entries = {};
    return s;
  } catch {
    return { version: 1, firstBuilt: new Date().toISOString(), entries: {} };
  }
}

export function save(path, store) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 1));
  renameSync(tmp, path);
}

export function key(item) {
  return `${item.sourceId}:${item.guid || item.url}`;
}

// Verdicts and first-seen dates survive a rebuild; everything the pipeline derives
// is replaced, so a scorer change takes effect on the whole archive at once.
export function upsert(store, entry) {
  const k = entry.id;
  const prev = store.entries[k];
  store.entries[k] = {
    ...entry,
    firstSeen: prev?.firstSeen || new Date().toISOString(),
    lastSeen: new Date().toISOString(),
    verdict: prev?.verdict ?? null,
  };
  return !prev;
}

export function prune(store, { maxAgeDays = 400 } = {}) {
  const cutoff = Date.now() - maxAgeDays * 86400000;
  let removed = 0;
  for (const [k, e] of Object.entries(store.entries)) {
    if (e.verdict) continue;
    const t = Date.parse(e.reviewDate || e.firstSeen || '') || 0;
    if (t && t < cutoff) { delete store.entries[k]; removed++; }
  }
  return removed;
}
