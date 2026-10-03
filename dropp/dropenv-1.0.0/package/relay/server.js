#!/usr/bin/env node
// DropEnv relay. Zero dependencies (Node 18+). Run: node server.js [port]
// Holds ciphertext in RAM only. It never sees keys, phrases or passwords.
const http = require('http'), fs = require('fs'), path = require('path');
const PORT = +process.argv[2] || +process.env.PORT || 8787;
const MAX_TTL = 7 * 864e5, MAX_BODY = 131072, MAX_DROPS = 5000, MAX_TOMBS = 1e5;
const drops = new Map(), gone = new Set(), hits = new Map();
const HEAD = {
  'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; img-src data:; base-uri 'none'; frame-ancestors 'none'",
};
const burn = id => { drops.delete(id); gone.add(id); if (gone.size > MAX_TOMBS) gone.delete(gone.values().next().value); };
const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { ...HEAD, 'Content-Type': type });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};
const str = (v, n) => typeof v === 'string' && v.length <= n ? v : null;

http.createServer((req, res) => {
  const now = Date.now(), ip = req.socket.remoteAddress;
  const recent = (hits.get(ip) || []).filter(t => now - t < 6e4); recent.push(now); hits.set(ip, recent);
  if (recent.length > 120) return send(res, 429, { error: 'rate limited' });
  const p = new URL(req.url, 'http://x').pathname;

  if (p === '/' || p === '/index.html')
    return fs.readFile(path.join(__dirname, 'dropenv.html'), (e, b) =>
      e ? send(res, 500, { error: 'dropenv.html must sit next to server.js' }) : send(res, 200, b.toString(), 'text/html; charset=utf-8'));
  if (p === '/api/health') return send(res, 200, { dropenv: 1, drops: drops.size });

  const m = p.match(/^\/api\/drops\/([\w-]{6,64})$/);
  if (!m) return send(res, 404, { error: 'not found' });
  const id = m[1];

  if (req.method === 'GET') {
    const d = drops.get(id);
    if (!d) return send(res, gone.has(id) ? 410 : 404, { error: gone.has(id) ? 'gone' : 'not found' });
    if (now > d.exp) { burn(id); return send(res, 410, { error: 'gone' }); }
    return send(res, 200, d);
  }
  if (req.method === 'DELETE') { if (drops.has(id)) burn(id); return send(res, 200, { ok: 1 }); }
  if (req.method !== 'PUT') return send(res, 405, { error: 'method not allowed' });

  let size = 0, body = '';
  req.on('data', c => { size += c.length; if (size > MAX_BODY) req.destroy(); else body += c; });
  req.on('end', () => {
    let x; try { x = JSON.parse(body); } catch { return send(res, 400, { error: 'bad json' }); }
    const d = {
      mode: x.mode === 'phrase' ? 'phrase' : 'link', iv: str(x.iv, 64), salt: str(x.salt, 64), ct: str(x.ct, 120000),
      exp: Math.min(+x.exp, now + MAX_TTL), burn: !!x.burn, pw: !!x.pw, tries: Math.min(x.tries | 0, 5),
      s2: str(x.s2, 64) || undefined, i2: str(x.i2, 64) || undefined,
    };
    if (!d.iv || !d.salt || !d.ct || !Number.isFinite(d.exp) || (d.pw && !(d.s2 && d.i2))) return send(res, 400, { error: 'bad drop' });
    if (gone.has(id)) return send(res, 410, { error: 'gone' });
    const old = drops.get(id);
    if (old) { // same drop may only update its failed-attempt counter
      if (old.ct !== d.ct || old.iv !== d.iv) return send(res, 409, { error: 'id in use' });
      if (d.tries >= 5) { burn(id); return send(res, 410, { error: 'gone' }); }
      old.tries = d.tries; return send(res, 200, { ok: 1 });
    }
    if (drops.size >= MAX_DROPS) return send(res, 503, { error: 'relay full' });
    drops.set(id, d); send(res, 200, { ok: 1 });
  });
}).listen(PORT, () => console.log(`DropEnv relay on http://localhost:${PORT}  (RAM only, restart wipes all drops)`));

setInterval(() => {
  const n = Date.now();
  for (const [id, d] of drops) if (n > d.exp) burn(id);
  for (const [ip, h] of hits) if (!h.some(t => n - t < 6e4)) hits.delete(ip);
}, 6e4).unref();
