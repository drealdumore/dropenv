#!/usr/bin/env node
// DropEnv relay. It stores ciphertext only; keys, phrases and passwords stay with users.
const http = require('http'), fs = require('fs'), path = require('path');
const PORT = +process.argv[2] || +process.env.PORT || 8787;
const MAX_TTL = 7 * 864e5, MAX_BODY = 131072, MAX_DROPS = 5000, MAX_TOMBS = 1e5;
const drops = new Map(), gone = new Set(), hits = new Map();
const DATABASE_URL = process.env.DATABASE_URL;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DROPS_DIR = path.join(DATA_DIR, 'drops'), GONE_DIR = path.join(DATA_DIR, 'gone');
let tempId = 0, pool;
const HEAD = {
  'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; img-src data:; base-uri 'none'; frame-ancestors 'none'",
};
const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { ...HEAD, 'Content-Type': type });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};
const str = (v, n) => typeof v === 'string' && v.length <= n ? v : null;
const fileFor = (dir, id) => path.join(dir, `${id}.json`);

function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.${tempId++}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function markFileGone(id) {
  writeJson(fileFor(GONE_DIR, id), { t: 1 });
  drops.delete(id);
  gone.delete(id);
  gone.add(id);
  fs.rmSync(fileFor(DROPS_DIR, id), { force: true });
  while (gone.size > MAX_TOMBS) {
    const oldest = gone.values().next().value;
    gone.delete(oldest);
    fs.rmSync(fileFor(GONE_DIR, oldest), { force: true });
  }
}

function loadFiles() {
  fs.mkdirSync(DROPS_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(GONE_DIR, { recursive: true, mode: 0o700 });
  const tombstones = fs.readdirSync(GONE_DIR)
    .filter(name => /^[\w-]{6,64}\.json$/.test(name))
    .map(name => ({ name, mtime: fs.statSync(path.join(GONE_DIR, name)).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime);
  for (const item of tombstones.slice(0, Math.max(0, tombstones.length - MAX_TOMBS))) {
    fs.rmSync(path.join(GONE_DIR, item.name), { force: true });
  }
  for (const { name } of tombstones.slice(-MAX_TOMBS)) gone.add(name.slice(0, -5));

  const now = Date.now();
  for (const name of fs.readdirSync(DROPS_DIR)) {
    if (!/^[\w-]{6,64}\.json$/.test(name)) continue;
    const id = name.slice(0, -5), file = path.join(DROPS_DIR, name);
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!d || !Number.isFinite(d.exp) || typeof d.ct !== 'string' || gone.has(id)) {
        fs.rmSync(file, { force: true });
      } else if (now > d.exp) {
        markFileGone(id);
      } else {
        drops.set(id, d);
      }
    } catch (error) {
      console.error(`DropEnv: cannot load drop ${id}: ${error.message}`);
      fs.rmSync(file, { force: true });
    }
  }
}

async function initializeStore() {
  if (!DATABASE_URL) {
    loadFiles();
    return;
  }
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: DATABASE_URL, max: 5 });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dropenv_drops (
      id VARCHAR(64) PRIMARY KEY,
      payload JSONB,
      expires_at BIGINT NOT NULL,
      gone BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS dropenv_drops_expiry_idx ON dropenv_drops (expires_at) WHERE gone = FALSE');
  console.log('DropEnv relay using PostgreSQL storage');
}

async function getDrop(id) {
  if (!pool) {
    const d = drops.get(id);
    if (!d) return { drop: null, gone: gone.has(id) };
    if (Date.now() > d.exp) {
      markFileGone(id);
      return { drop: null, gone: true };
    }
    return { drop: d, gone: false };
  }
  const result = await pool.query('SELECT payload, expires_at, gone FROM dropenv_drops WHERE id = $1', [id]);
  const row = result.rows[0];
  if (!row) return { drop: null, gone: false };
  if (row.gone) return { drop: null, gone: true };
  if (Date.now() > Number(row.expires_at)) {
    await markDbGone(id);
    return { drop: null, gone: true };
  }
  return { drop: row.payload, gone: false };
}

async function countDrops() {
  if (!pool) return drops.size;
  const result = await pool.query('SELECT COUNT(*)::int AS count FROM dropenv_drops WHERE gone = FALSE');
  return result.rows[0].count;
}

async function saveDrop(id, d) {
  if (!pool) {
    if (gone.has(id)) return 410;
    const old = drops.get(id);
    if (old) {
      if (old.ct !== d.ct || old.iv !== d.iv) return 409;
      if (d.tries >= 5) {
        markFileGone(id);
        return 410;
      }
      old.tries = Math.max(old.tries || 0, d.tries);
      writeJson(fileFor(DROPS_DIR, id), old);
      return 200;
    }
    if (drops.size >= MAX_DROPS) return 503;
    writeJson(fileFor(DROPS_DIR, id), d);
    drops.set(id, d);
    return 200;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [id]);
    const result = await client.query('SELECT payload, gone FROM dropenv_drops WHERE id = $1 FOR UPDATE', [id]);
    const row = result.rows[0];
    if (row?.gone) {
      await client.query('COMMIT');
      return 410;
    }
    if (row) {
      const old = row.payload;
      if (old.ct !== d.ct || old.iv !== d.iv) {
        await client.query('COMMIT');
        return 409;
      }
      if (d.tries >= 5) {
        await client.query('UPDATE dropenv_drops SET payload = NULL, gone = TRUE, updated_at = NOW() WHERE id = $1', [id]);
        await client.query('COMMIT');
        return 410;
      }
      old.tries = Math.max(old.tries || 0, d.tries);
      await client.query('UPDATE dropenv_drops SET payload = $2::jsonb, updated_at = NOW() WHERE id = $1', [id, JSON.stringify(old)]);
      await client.query('COMMIT');
      return 200;
    }
    const count = await client.query('SELECT COUNT(*)::int AS count FROM dropenv_drops WHERE gone = FALSE');
    if (count.rows[0].count >= MAX_DROPS) {
      await client.query('COMMIT');
      return 503;
    }
    await client.query(
      'INSERT INTO dropenv_drops (id, payload, expires_at) VALUES ($1, $2::jsonb, $3)',
      [id, JSON.stringify(d), d.exp],
    );
    await client.query('COMMIT');
    return 200;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function markDbGone(id) {
  await pool.query(
    'UPDATE dropenv_drops SET payload = NULL, gone = TRUE, updated_at = NOW() WHERE id = $1 AND gone = FALSE',
    [id],
  );
}

async function deleteDrop(id) {
  if (!pool) {
    if (drops.has(id)) markFileGone(id);
    return;
  }
  await markDbGone(id);
}

async function cleanupExpired() {
  if (!pool) {
    const now = Date.now();
    for (const [id, d] of drops) if (now > d.exp) markFileGone(id);
    return;
  }
  await pool.query(
    'UPDATE dropenv_drops SET payload = NULL, gone = TRUE, updated_at = NOW() WHERE gone = FALSE AND expires_at < $1',
    [Date.now()],
  );
  const result = await pool.query('SELECT COUNT(*)::int AS count FROM dropenv_drops WHERE gone = TRUE');
  const excess = result.rows[0].count - MAX_TOMBS;
  if (excess > 0) {
    await pool.query(`
      WITH expired AS (
        SELECT id FROM dropenv_drops WHERE gone = TRUE ORDER BY updated_at DESC OFFSET $1
      )
      DELETE FROM dropenv_drops WHERE id IN (SELECT id FROM expired)
    `, [MAX_TOMBS]);
  }
}

async function handle(req, res) {
  const now = Date.now(), ip = req.socket.remoteAddress;
  const recent = (hits.get(ip) || []).filter(t => now - t < 6e4);
  recent.push(now);
  hits.set(ip, recent);
  if (recent.length > 120) return send(res, 429, { error: 'rate limited' });
  const p = new URL(req.url, 'http://x').pathname;

  if (p === '/' || p === '/index.html') {
    return fs.readFile(path.join(__dirname, 'dropenv.html'), (e, b) =>
      e ? send(res, 500, { error: 'dropenv.html must sit next to server.js' }) : send(res, 200, b.toString(), 'text/html; charset=utf-8'));
  }
  if (p === '/api/health') return send(res, 200, { dropenv: 1, drops: await countDrops() });

  const m = p.match(/^\/api\/drops\/([\w-]{6,64})$/);
  if (!m) return send(res, 404, { error: 'not found' });
  const id = m[1];

  if (req.method === 'GET') {
    const result = await getDrop(id);
    if (!result.drop) return send(res, result.gone ? 410 : 404, { error: result.gone ? 'gone' : 'not found' });
    return send(res, 200, result.drop);
  }
  if (req.method === 'DELETE') {
    await deleteDrop(id);
    return send(res, 200, { ok: 1 });
  }
  if (req.method !== 'PUT') return send(res, 405, { error: 'method not allowed' });

  let size = 0, body = '';
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) {
      send(res, 413, { error: 'drop too large' });
      req.destroy();
      return;
    }
    body += chunk;
  }
  let x;
  try { x = JSON.parse(body); } catch { return send(res, 400, { error: 'bad json' }); }
  if (!x || typeof x !== 'object' || Array.isArray(x)) return send(res, 400, { error: 'bad drop' });
  const exp = Number(x.exp);
  if (!Number.isFinite(exp) || exp <= Date.now()) return send(res, 400, { error: 'bad drop' });
  const d = {
    mode: x.mode === 'phrase' ? 'phrase' : 'link', iv: str(x.iv, 64), salt: str(x.salt, 64), ct: str(x.ct, 120000),
    exp: Math.min(exp, Date.now() + MAX_TTL), burn: !!x.burn, pw: !!x.pw, tries: Math.min(x.tries | 0, 5),
    s2: str(x.s2, 64) || undefined, i2: str(x.i2, 64) || undefined,
  };
  if (!d.iv || !d.salt || !d.ct || (d.pw && !(d.s2 && d.i2))) return send(res, 400, { error: 'bad drop' });
  const status = await saveDrop(id, d);
  if (status === 409) return send(res, 409, { error: 'id in use' });
  if (status === 410) return send(res, 410, { error: 'gone' });
  if (status === 503) return send(res, 503, { error: 'relay full' });
  return send(res, 200, { ok: 1 });
}

async function start() {
  await initializeStore();
  const server = http.createServer((req, res) => {
    handle(req, res).catch(error => {
      console.error(`DropEnv: request failed: ${error.stack || error}`);
      if (!res.headersSent) send(res, 500, { error: 'internal server error' });
      else res.destroy();
    });
  });
  server.listen(PORT, () => console.log(`DropEnv relay listening on port ${PORT}`));

  setInterval(() => {
    cleanupExpired().catch(error => console.error(`DropEnv: cleanup failed: ${error.stack || error}`));
    const n = Date.now();
    for (const [ip, h] of hits) if (!h.some(t => n - t < 6e4)) hits.delete(ip);
  }, 6e4).unref();
}

start().catch(error => {
  console.error(`DropEnv: failed to initialize storage: ${error.stack || error}`);
  process.exitCode = 1;
});
