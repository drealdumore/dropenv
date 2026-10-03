'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const serverFile = path.join(__dirname, 'server.js');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function launch(port, dataDir) {
  const child = spawn(process.execPath, [serverFile], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`Relay exited with code ${child.exitCode}`);
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return { child, base };
    } catch {}
    await pause(50);
  }
  child.kill();
  throw new Error('Relay did not become ready');
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill();
  await new Promise(resolve => child.once('exit', resolve));
}

test('ciphertext and burn markers survive relay restarts', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dropenv-relay-'));
  const port = await freePort();
  const id = 'Persist123';
  const drop = {
    mode: 'link',
    iv: 'dGVzdGl2',
    salt: 'dGVzdHNhbHQ',
    ct: 'ZW5jcnlwdGVk',
    exp: Date.now() + 60_000,
    burn: true,
    pw: false,
  };
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  let relay = await launch(port, dataDir);
  try {
    let response = await fetch(`${relay.base}/api/drops/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(drop),
    });
    assert.equal(response.status, 200);
  } finally {
    await stop(relay.child);
  }

  relay = await launch(port, dataDir);
  try {
    let response = await fetch(`${relay.base}/api/drops/${id}`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ct, drop.ct);

    response = await fetch(`${relay.base}/api/drops/${id}`, { method: 'DELETE' });
    assert.equal(response.status, 200);
  } finally {
    await stop(relay.child);
  }

  relay = await launch(port, dataDir);
  try {
    const response = await fetch(`${relay.base}/api/drops/${id}`);
    assert.equal(response.status, 410);
  } finally {
    await stop(relay.child);
  }
});

test('failed password attempts cannot be reset by a stale client update', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dropenv-relay-'));
  const port = await freePort();
  const id = 'TryCount123';
  const drop = {
    mode: 'link',
    iv: 'dGVzdGl2',
    salt: 'dGVzdHNhbHQ',
    ct: 'ZW5jcnlwdGVk',
    exp: Date.now() + 60_000,
    burn: true,
    pw: true,
    s2: 'dGVzdHNhbHQ',
    i2: 'dGVzdGl2',
  };
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const relay = await launch(port, dataDir);
  t.after(() => stop(relay.child));

  let response = await fetch(`${relay.base}/api/drops/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(drop),
  });
  assert.equal(response.status, 200);
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
});

test('invalid drop JSON is rejected without stopping the relay', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dropenv-relay-'));
  const port = await freePort();
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const relay = await launch(port, dataDir);
  t.after(() => stop(relay.child));

  let response = await fetch(`${relay.base}/api/drops/Invalid123`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: 'null',
  });
  assert.equal(response.status, 400);
  response = await fetch(`${relay.base}/api/health`);
  assert.equal(response.status, 200);
});
