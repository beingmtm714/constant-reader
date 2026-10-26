// The roundup sender. Reads every subscribed device out of Firestore and pokes
// whichever ones are eligible today; the service worker in the browser works
// out what to say.
//
// Run by .github/workflows/notify.yml on Monday, Wednesday and Saturday
// mornings, 55 minutes after that day's build has put a fresh feed.json on the
// site — the same three days the build itself runs on. Not every device gets
// poked every run: each one chose "weekly" (Monday only) or "every refresh"
// (all three) on the Profile screen, and that choice travels with its
// Firestore device doc. `--dry-run` prints what it would send and writes
// nothing.
//
// **The push carries no payload.** That is a deliberate limit and it buys two
// things. The sender needs only a VAPID signature — an ES256 JWT, forty lines of
// node:crypto — instead of the RFC 8291 encryption a payload would require, so
// this project keeps its zero dependencies and hand-rolled crypto stays out of
// the path. And nobody's recommendations pass through Apple or Google: the push
// says that there is news, and the app fetches the news from its own public
// feed. A push service that logged everything it relayed would learn that a
// device exists and nothing about who reads what.

import { createSign, createPrivateKey, createPublicKey } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PROJECT = 'constant-reader-93f05';
const DRY = process.argv.includes('--dry-run');

// gcloud supplies the Firestore access token. In Actions it is on PATH and
// signed in as the service account by the workflow; GCLOUD overrides the path.
const GCLOUD = process.env.GCLOUD || 'gcloud';

// What each group was last told about. The workflow carries this file between
// runs in the Actions cache; NOTIFY_STATE overrides where it lives.
const STATE = process.env.NOTIFY_STATE || join(ROOT, 'data', 'notify-state.json');

// The VAPID contact a push service can reach if this sender misbehaves. The
// spec accepts a mailto: or an https: URL; the site's own address keeps any
// mailbox out of the source.
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'https://www.constantreader.app/';

const say = (...a) => console.log(...a);
const b64 = (buf) => Buffer.from(buf).toString('base64url');

// ------------------------------------------------------------------ vapid

function vapidKey() {
  const path = join(ROOT, 'vapid.key');
  if (!existsSync(path)) {
    throw new Error(`vapid.key is missing from ${ROOT}. Without it nothing can be signed and no notification can be sent.`);
  }
  return readFileSync(path, 'utf8').trim();
}

// A P-256 private key as raw base64url — which is what `web-push
// generate-vapid-keys` prints — wrapped into the PKCS#8 DER that node's signer
// wants. The prefix is the fixed ASN.1 header for an EC private key on P-256;
// only the 32 key bytes differ, so this is assembly rather than encoding.
function pkcs8(rawBase64url) {
  const d = Buffer.from(rawBase64url, 'base64url');
  if (d.length !== 32) throw new Error(`vapid.key is ${d.length} bytes, expected 32`);
  const prefix = Buffer.from('308141020100301306072a8648ce3d020106082a8648ce3d030107042730250201010420', 'hex');
  const der = Buffer.concat([prefix, d]);
  return `-----BEGIN PRIVATE KEY-----\n${der.toString('base64').replace(/(.{64})/g, '$1\n')}\n-----END PRIVATE KEY-----\n`;
}

// The public key, derived so the two can never drift apart. A JWT signed with
// one key and presented with another is rejected by the push service with a 403
// that says nothing useful.
function publicKey(rawBase64url) {
  const key = createPrivateKey(pkcs8(rawBase64url));
  const der = createPublicKey(key).export({ type: 'spki', format: 'der' });
  return b64(der.subarray(der.length - 65));
}

function vapidHeader(endpoint, priv) {
  const audience = new URL(endpoint).origin;
  const header = b64(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64(JSON.stringify({
    aud: audience,
    // Twelve hours. The spec caps it at 24 and a push service rejects anything
    // longer, clock skew included.
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: VAPID_SUBJECT,
  }));
  const signer = createSign('SHA256');
  signer.update(`${header}.${claims}`);
  // Node signs ECDSA as DER by default; JOSE wants the raw r||s pair.
  const der = signer.sign(pkcs8(priv));
  const sig = derToJose(der);
  return { jwt: `${header}.${claims}.${b64(sig)}`, key: publicKey(priv) };
}

function derToJose(der) {
  let offset = 2;
  if (der[1] & 0x80) offset += der[1] & 0x7f;
  const readInt = () => {
    const len = der[offset + 1];
    let start = offset + 2;
    let end = start + len;
    while (der[start] === 0 && end - start > 32) start += 1;
    const out = Buffer.alloc(32);
    der.copy(out, 32 - (end - start), start, end);
    offset = end;
    return out;
  };
  const r = readInt();
  const s = readInt();
  return Buffer.concat([r, s]);
}

// --------------------------------------------------------------- firestore

function token() {
  try {
    return execFileSync(GCLOUD, ['auth', 'print-access-token'], { encoding: 'utf8' }).trim();
  } catch (err) {
    throw new Error(`could not get a Google access token from ${GCLOUD}: ${err.message}`);
  }
}

const API = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

async function get(path, auth) {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${auth}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`firestore ${res.status} on ${path}: ${await res.text()}`);
  return res.json();
}

const plain = (fields = {}) => Object.fromEntries(
  Object.entries(fields).map(([k, v]) => [k, v.stringValue ?? v.integerValue ?? v.booleanValue ?? null]),
);

// Every device belonging to every reader. Owner credentials read straight past
// the security rules, which is the same door the rules themselves were deployed
// through; the rules are what stop one reader reaching another's, and they are
// not what stops this.
async function devices(auth) {
  const readers = await get('/readers?pageSize=300', auth);
  const out = [];
  for (const doc of readers?.documents || []) {
    const uid = doc.name.split('/').pop();
    const page = await get(`/readers/${uid}/devices?pageSize=50`, auth);
    for (const d of page?.documents || []) {
      const sub = plain(d.fields);
      if (sub.endpoint) out.push({ uid, id: d.name.split('/').pop(), ...sub });
    }
  }
  return out;
}

async function forget(uid, id, auth) {
  await fetch(`${API}/readers/${uid}/devices/${id}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${auth}` },
  }).catch(() => {});
}

// ------------------------------------------------------------------ sending

async function poke(sub, priv) {
  const { jwt, key } = vapidHeader(sub.endpoint, priv);
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `vapid t=${jwt}, k=${key}`,
      TTL: '86400',
      // The roundup is worth waking a phone for, whether it lands once a week
      // or up to three times.
      Urgency: 'normal',
      'Content-Length': '0',
    },
  });
  return res.status;
}

// -------------------------------------------------------------------- state

// What was recommended last time each frequency group ran. The service worker
// does its own counting for the sentence it shows, but the decision *whether
// to send at all* belongs here: a stretch with nothing new should be quiet,
// and a phone that buzzes to say "no new recommendations" is a phone that
// gets this switched off.
//
// Two groups because they run on different schedules. "every" checks on
// every build day (Monday, Wednesday, Saturday) and its baseline moves every
// time. "weekly" only checks on Monday, so its baseline has to hold across
// the Wednesday and Saturday runs in between — otherwise a book that arrived
// Thursday would already be marked seen by the time Monday came around to
// tell a weekly subscriber about it, and they would never hear about it at
// all. One shared baseline for both would quietly starve the weekly group.
function loadState() {
  try { return JSON.parse(readFileSync(STATE, 'utf8')); } catch { return {}; }
}

function lastSeen(all, group) {
  const g = all[group];
  return g ? new Set(g.recommended || []) : null;
}

function remember(all, group, ids) {
  all[group] = { recommended: [...ids], at: new Date().toISOString() };
}

function saveState(all) {
  mkdirSync(dirname(STATE), { recursive: true });
  writeFileSync(STATE, JSON.stringify(all, null, 1));
}

// ---------------------------------------------------------------------- run

const feed = JSON.parse(readFileSync(join(ROOT, 'web/data/feed.json'), 'utf8'));
const recommended = (feed.books || []).filter((e) => e.recommended).map((e) => e.id);
const ids = new Set(recommended);
// getDay(): 0 Sunday .. 6 Saturday. The deploy job and this one both run Monday/Wednesday/Saturday, so "today" is always one of 1,
// 3 or 6 when this runs on schedule — but a manual or --dry-run invocation on
// any other day should still behave sanely rather than assume a build day.
const isMonday = new Date().getDay() === 1;

const state = loadState();
const groups = {};
for (const group of ['every', 'weekly']) {
  if (group === 'weekly' && !isMonday) continue; // baseline untouched until Monday
  const seen = lastSeen(state, group);
  const fresh = seen ? recommended.filter((id) => !seen.has(id)) : recommended;
  groups[group] = { seen, fresh };
  say(`\n  ${group}: ${recommended.length} recommended, ${
    seen ? `${fresh.length} new since its last check` : 'no previous check on record'}`);
}

// A group with nothing to compare against has nothing "new" yet either — it
// records the state and sends nothing to that group. One silent first run is
// a much better first impression than telling everyone about everything.
const eligible = Object.entries(groups).filter(([, g]) => g.seen && g.fresh.length).map(([name]) => name);
for (const [name, g] of Object.entries(groups)) {
  if (!g.seen || !g.fresh.length) {
    if (!DRY) remember(state, name, ids);
    say(g.seen ? `  ${name}: nothing new, sent nothing.` : `  ${name}: first run, recorded and sent nothing.`);
  }
}

if (!eligible.length) {
  if (!DRY) saveState(state);
  say('');
  process.exit(0);
}

const priv = vapidKey();
const auth = token();
const subs = await devices(auth);
// A device with no frequency on record predates this feature and behaved
// like today's only mode did: weekly.
const targets = subs.filter((s) => eligible.includes(s.frequency || 'weekly'));
say(`\n  ${subs.length} subscribed device(s), ${targets.length} eligible today`);

if (DRY) {
  for (const s of targets) say(`    would poke ${s.endpoint.slice(0, 60)}… (${s.frequency || 'weekly'})`);
  say('\n  --dry-run: nothing sent, nothing recorded.\n');
  process.exit(0);
}

let sent = 0, dropped = 0;
for (const sub of targets) {
  let status;
  try { status = await poke(sub, priv); } catch (err) { say(`    error ${err.message}`); continue; }
  // 404 and 410 are the push service saying this address is dead — the app was
  // deleted from the Home Screen, or the subscription expired. Keeping it means
  // failing on it every check for ever.
  if (status === 404 || status === 410) { await forget(sub.uid, sub.id, auth); dropped += 1; continue; }
  if (status >= 200 && status < 300) { sent += 1; continue; }
  say(`    ${status} from ${new URL(sub.endpoint).host}`);
}

for (const name of eligible) remember(state, name, ids);
saveState(state);
say(`  sent ${sent}, dropped ${dropped} dead subscription(s)\n`);
