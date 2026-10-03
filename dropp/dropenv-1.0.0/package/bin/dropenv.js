#!/usr/bin/env node
'use strict';
// DropEnv CLI. Same wire format as the web app: AES-256-GCM, PBKDF2-SHA256 (200k), BIP-39 phrases.
// Encryption happens here; the relay only ever sees ciphertext.
const fs = require('fs'), path = require('path'), os = require('os'), { webcrypto: wc } = require('node:crypto'), sub = wc.subtle;
const VERSION = require('../package.json').version;
const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = u => Buffer.from(u).toString('base64url'), unb64 = s => new Uint8Array(Buffer.from(s, 'base64url'));
const rnd = n => wc.getRandomValues(new Uint8Array(n));
const TTL = { '10m': 600, '1h': 3600, '24h': 86400, '7d': 604800 };
const W = fs.readFileSync(path.join(__dirname, '..', 'bip39.txt'), 'utf8').split('\n').map(x => x.trim()).filter(Boolean);
const err = m => process.stderr.write(m + '\n');
const die = (m, code = 1) => { err('dropenv: ' + m); process.exit(code); };

// ---- crypto (mirrors the web page) ----
const kdf = async (s, salt) => sub.deriveKey({ name: 'PBKDF2', salt, iterations: 200000, hash: 'SHA-256' },
  await sub.importKey('raw', enc.encode(s), 'PBKDF2', false, ['deriveKey']), { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
const seal = async (k, iv, d) => new Uint8Array(await sub.encrypt({ name: 'AES-GCM', iv }, k, d));
const unseal = async (k, iv, d) => new Uint8Array(await sub.decrypt({ name: 'AES-GCM', iv }, k, d));
const bin = (n, l) => n.toString(2).padStart(l, '0'), sha = async e => new Uint8Array(await sub.digest('SHA-256', e));
const normP = p => p.trim().toLowerCase().split(/\s+/).join(' ');
const pid = async p => b64(await sha(enc.encode('dropenv-id:' + normP(p)))).slice(0, 12);
async function genPhrase() {
  const e = rnd(16), b = [...e].map(x => bin(x, 8)).join('') + bin((await sha(e))[0], 8).slice(0, 4);
  return Array.from({ length: 12 }, (_, i) => W[parseInt(b.slice(i * 11, i * 11 + 11), 2)]).join(' ');
}
async function checkPhrase(p) {
  const w = normP(p).split(' ');
  if (w.length !== 12) return 'The phrase needs exactly 12 words.';
  const ix = w.map(x => W.indexOf(x)), bad = ix.indexOf(-1);
  if (bad >= 0) return `"${w[bad]}" is not a BIP-39 word.`;
  const b = ix.map(i => bin(i, 11)).join(''), e = new Uint8Array(16).map((_, i) => parseInt(b.slice(i * 8, i * 8 + 8), 2));
  return bin((await sha(e))[0], 8).slice(0, 4) === b.slice(128) ? '' : 'Checksum failed. Check for a typo or wrong word order.';
}

// ---- io helpers ----
const readStdin = async () => { const c = []; for await (const x of process.stdin) c.push(x); return Buffer.concat(c).toString('utf8'); };
function ask(q) { // hidden prompt on the terminal
  return new Promise(res => {
    const si = process.stdin;
    if (!si.isTTY) die('No terminal to prompt on. Set DROPENV_PASSWORD instead.');
    process.stderr.write(q); let s = ''; si.setRawMode(true); si.resume(); si.setEncoding('utf8');
    const on = c => { for (const ch of c) {
      if (ch === '\r' || ch === '\n' || ch === '\u0004') { si.setRawMode(false); si.pause(); si.removeListener('data', on); err(''); return res(s); }
      if (ch === '\u0003') { err(''); process.exit(130); }
      if (ch === '\u007f' || ch === '\b') s = s.slice(0, -1); else s += ch; } };
    si.on('data', on);
  });
}
async function api(relay, method, id, body) {
  try {
    return await fetch(`${relay}/api/drops/${id}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body && JSON.stringify(body) });
  } catch (e) { die(`Cannot reach the relay at ${relay} (${e.cause?.code || e.message}). Use --relay or DROPENV_RELAY.`); }
}
const configFile = () => process.env.DROPENV_CONFIG_FILE || path.join(os.homedir(), '.dropenv', 'config.json');
function configuredRelay() {
  try {
    const c = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
    if (!c || typeof c !== 'object' || Array.isArray(c)) die(`Invalid config in ${configFile()}. Run "dropenv config --clear" and configure it again.`);
    return typeof c.relay === 'string' ? c.relay : '';
  } catch (e) {
    if (e.code === 'ENOENT') return '';
    die(`Cannot read config ${configFile()}: ${e.message}`);
  }
}
const relayOf = (a, fallback) => (a.relay || process.env.DROPENV_RELAY || configuredRelay() || fallback || 'http://localhost:8787').replace(/\/+$/, '');

function config(a) {
  const file = configFile();
  if (a.clear) {
    try { fs.rmSync(file, { force: true }); }
    catch (e) { die(`Cannot clear config ${file}: ${e.message}`); }
    err('Removed saved DropEnv config.');
    return;
  }
  if (a.relay !== undefined) {
    let url;
    try { url = new URL(a.relay); } catch { die('--relay must be an absolute http(s) URL.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
      die('--relay must be a base http(s) URL, for example https://drop.example.com.');
    }
    const relay = url.origin;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ relay }, null, 2) + '\n', { mode: 0o600 });
      if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
    } catch (e) { die(`Cannot save config ${file}: ${e.message}`); }
    err(`Saved default relay: ${relay}`);
    return;
  }
  err(`Default relay: ${relayOf({})}\nOverride with --relay URL or DROPENV_RELAY.`);
}

// ---- commands ----
async function push(a) {
  let file = a._[0], text;
  if (file === '-' || (!file && !process.stdin.isTTY)) text = await readStdin();
  else { file = file || '.env'; if (!fs.existsSync(file)) die(`File not found: ${file}`); text = fs.readFileSync(file, 'utf8'); }
  if (!text.trim()) die('Nothing to send: the input is empty.');
  if (Buffer.byteLength(text) > 65536) die('Input is over the 64 KB limit.');
  const ttl = TTL[a.ttl || '24h']; if (!ttl) die('--ttl must be one of 10m, 1h, 24h, 7d');
  const relay = relayOf(a), site = (a.site || process.env.DROPENV_SITE || relay).replace(/\/+$/, '') + '/';
  const pw = a.pw === true ? await ask('Password: ') : a.pw || process.env.DROPENV_PASSWORD || '';
  const iv = rnd(12), salt = rnd(16); let key, id, secret, phrase;
  if (a.phrase) {
    phrase = a.phrase === true ? await genPhrase() : normP(a.phrase);
    const pe = await checkPhrase(phrase); if (pe) die(pe);
    id = await pid(phrase); key = await kdf(phrase, salt);
  } else {
    key = await sub.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    secret = b64(await sub.exportKey('raw', key)); id = b64(rnd(9));
  }
  let ct = await seal(key, iv, enc.encode(text));
  const d = { mode: phrase ? 'phrase' : 'link', iv: b64(iv), salt: b64(salt), burn: !a['no-burn'], exp: Date.now() + ttl * 1000, pw: !!pw };
  if (pw) { const s2 = rnd(16), i2 = rnd(12); ct = await seal(await kdf(pw, s2), i2, ct); d.s2 = b64(s2); d.i2 = b64(i2); }
  d.ct = b64(ct);
  const r = await api(relay, 'PUT', id, d);
  if (!r.ok) die(r.status === 409 || r.status === 410 ? 'That phrase was already used. Try another.' : `The relay refused the drop (HTTP ${r.status}).`);
  const note = `Sealed ${Buffer.byteLength(text)} bytes. Expires in ${a.ttl || '24h'}${d.burn ? ', burns when opened' : ''}${pw ? ', password protected' : ''}.`;
  if (phrase) { console.log(phrase); err(`${note}\nShare the 12 words separately. Recipient: dropenv pull "<12 words>" --relay ${relay}  (or open ${site} > Open drop)`); }
  else { console.log(`${site}#d=${id}&key=${secret}`); err(note); }
}

async function pull(a) {
  const target = a._.join(' ').trim(); if (!target) die('Usage: dropenv pull <link | 12 words>');
  let relay = a.relay || process.env.DROPENV_RELAY, id, sec, phrase;
  const m = target.match(/#d=([\w-]+)&key=([\w-]+)/);
  if (m) { id = m[1]; sec = m[2]; if (!relay) try { relay = new URL(target).origin; } catch {} }
  else { phrase = normP(target); const pe = await checkPhrase(phrase); if (pe) die(pe); id = await pid(phrase); }
  relay = relayOf({ relay });
  const r = await api(relay, 'GET', id);
  if (r.status === 410) die('410 GONE: this drop was burned or has expired.');
  if (r.status === 404) die('404: no drop found for this link or phrase.');
  if (!r.ok) die(`Relay error (HTTP ${r.status}).`);
  const d = await r.json();
  const pw = d.pw ? (typeof a.pw === 'string' ? a.pw : process.env.DROPENV_PASSWORD || await ask('Password: ')) : '';
  let text;
  try {
    const key = d.mode === 'link' ? await sub.importKey('raw', unb64(sec), 'AES-GCM', false, ['decrypt']) : await kdf(phrase, unb64(d.salt));
    let ct = unb64(d.ct); if (d.pw) ct = await unseal(await kdf(pw, unb64(d.s2)), unb64(d.i2), ct);
    text = dec.decode(await unseal(key, unb64(d.iv), ct));
  } catch {
    if (!d.pw) die('Could not decrypt: the key or phrase does not match this drop.');
    d.tries = (d.tries || 0) + 1; await api(relay, 'PUT', id, d);
    die(d.tries >= 5 ? 'Too many wrong passwords. The drop was destroyed.' : `Wrong password. ${5 - d.tries} attempts left before the drop self-destructs.`);
  }
  if (a.out) { // output first, burn second: never lose the only copy
    if (fs.existsSync(a.out) && !a.force) die(`${a.out} exists. Use --force to overwrite.`);
    fs.writeFileSync(a.out, text, { mode: 0o600 }); fs.chmodSync(a.out, 0o600); err(`Wrote ${a.out} (mode 600).`);
  } else process.stdout.write(text.endsWith('\n') ? text : text + '\n');
  if (d.burn) { const x = await api(relay, 'DELETE', id); err(x.ok ? 'Drop burned. That was the only copy.' : 'Warning: could not burn the drop; it stays until it expires.'); }
  else err('Drop stays available until it expires.');
}

async function burn(a) {
  const t = a._.join(' ').trim(); if (!t) die('Usage: dropenv burn <link | id>');
  const m = t.match(/#d=([\w-]+)/), id = m ? m[1] : /^[\w-]{6,64}$/.test(t) ? t : null;
  if (!id) die('Give a DropEnv link or a drop id.');
  let relay = a.relay || process.env.DROPENV_RELAY; if (!relay && m) try { relay = new URL(t).origin; } catch {}
  const r = await api(relayOf({ relay }), 'DELETE', id); err(r.ok ? 'Burned.' : `Relay error (HTTP ${r.status}).`);
}

function serve(a) {
  if (a.port) process.env.PORT = a.port;
  const f = path.join(__dirname, '..', 'relay', 'server.js');
  if (!fs.existsSync(f)) die('relay/server.js is missing from this install.');
  require(f);
}

const HELP = `dropenv ${VERSION}  Paste. Encrypt. Share. Burn.

  dropenv [push] [file|-]     encrypt a file (default .env) or stdin, print a one-time link
  dropenv pull <link|words>   decrypt a drop to stdout (or --out file)
  dropenv burn <link|id>      destroy a drop now
  dropenv serve [--port N]    run your own relay and web app
  dropenv config --relay URL  save your default relay
  dropenv config [--clear]    show or clear the saved config

push options
  --ttl 10m|1h|24h|7d   lifetime (default 24h)      --no-burn   keep until expiry
  --pw                  prompt for a password       --phrase    use a 12-word phrase instead of a link
pull options
  --out FILE [--force]  write the file with mode 600
common
  --relay URL           relay to use (or DROPENV_RELAY / saved config; default http://localhost:8787)
  --site URL            base URL printed in links (or DROPENV_SITE; default: the relay)
  DROPENV_PASSWORD      password without a prompt (avoid putting secrets in argv)

examples
  dropenv .env --ttl 1h | pbcopy
  dropenv pull "https://drop.example.com/#d=...&key=..." --out .env
`;

function parse(v) {
  const a = { _: [] }, VAL = new Set(['ttl', 'relay', 'site', 'out', 'port']);
  for (let i = 0; i < v.length; i++) {
    const x = v[i];
    if (x === '-' || !x.startsWith('--')) { a._.push(x); continue; }
    const [k, val] = x.slice(2).split(/=(.*)/s);
    if (val !== undefined) a[k] = val;
    else if (VAL.has(k)) { if (v[i + 1] === undefined) die(`--${k} needs a value`); a[k] = v[++i]; }
    else if (k === 'phrase' && v[i + 1] && v[i + 1].includes(' ')) a[k] = v[++i];
    else a[k] = true;
  }
  return a;
}

(async () => {
  const argv = process.argv.slice(2), CMDS = ['push', 'pull', 'burn', 'serve', 'config', 'help', 'version'];
  const cmd = CMDS.includes(argv[0]) ? argv.shift() : (argv.length || !process.stdin.isTTY ? 'push' : 'help');
  if (argv.includes('-h') || argv.includes('--help') || cmd === 'help') return process.stdout.write(HELP);
  if (argv.includes('-v') || cmd === 'version') return console.log(VERSION);
  const a = parse(argv);
  await ({ push, pull, burn, serve, config }[cmd])(a);
})().catch(e => die(e.message));
