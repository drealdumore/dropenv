'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const { Pool } = require('pg');

const serverFile = path.join(__dirname, 'server.js');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function launch(port, databaseUrl, dataDir) {
  const child = spawn(process.execPath, [serverFile], {
    env: { ...process.env, PORT: String(port), DATABASE_URL: databaseUrl, DATA_DIR: dataDir },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`Relay exited with code ${child.exitCode}`);
    try {
      if ((await fetch(`${base}/api/health`)).ok) return { child, base };
    } catch {}
    await pause(100);
  }
  child.kill();
  throw new Error('PostgreSQL relay did not become ready');
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill();
  await new Promise(resolve => child.once('exit', resolve));
}

test('PostgreSQL drops and burn markers survive relay restarts', {
  skip: !process.env.DROPENV_TEST_DATABASE_URL && 'Set DROPENV_TEST_DATABASE_URL to run PostgreSQL integration tests',
}, async t => {
  const databaseUrl = process.env.DROPENV_TEST_DATABASE_URL;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dropenv-pg-test-'));
  const port = await freePort();
  const id = `pgtest${randomBytes(12).toString('hex')}`;
  const pool = new Pool({ connectionString: databaseUrl });
  let relay;
  t.after(async () => {
    if (relay) await stop(relay.child);
    await pool.query('DELETE FROM dropenv_drops WHERE id = $1', [id]).catch(() => {});
    await pool.end();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  relay = await launch(port, databaseUrl, dataDir);
  const drop = {
    mode: 'link',
    iv: 'dGVzdGl2',
    salt: 'dGVzdHNhbHQ',
    ct: 'cG9zdGdyZXMtY2lwaGVydGV4dA',
    exp: Date.now() + 60_000,
    burn: true,
    pw: true,
    s2: 'dGVzdHNhbHQ',
    i2: 'dGVzdGl2',
  };
  let response = await fetch(`${relay.base}/api/drops/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(drop),
  });
  assert.equal(response.status, 200);
  await stop(relay.child);

  relay = await launch(port, databaseUrl, dataDir);
  response = await fetch(`${relay.base}/api/drops/${id}`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ct, drop.ct);

  response = await fetch(`${relay.base}/api/drops/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...drop, tries: 1 }),
  });
  assert.equal(response.status, 200);
  response = await fetch(`${relay.base}/api/drops/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...drop, tries: 0 }),
  });
  assert.equal(response.status, 200);
  response = await fetch(`${relay.base}/api/drops/${id}`);
  assert.equal((await response.json()).tries, 1);

  response = await fetch(`${relay.base}/api/drops/${id}`, { method: 'DELETE' });
  assert.equal(response.status, 200);
  await stop(relay.child);

  relay = await launch(port, databaseUrl, dataDir);
  response = await fetch(`${relay.base}/api/drops/${id}`);
  assert.equal(response.status, 410);
});
