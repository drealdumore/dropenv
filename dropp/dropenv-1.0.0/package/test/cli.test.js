'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const packageDir = path.join(__dirname, '..');
const cli = path.join(packageDir, 'bin', 'dropenv.js');
const server = path.join(packageDir, 'relay', 'server.js');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
  const listener = http.createServer();
  await new Promise((resolve, reject) => listener.listen(0, '127.0.0.1', resolve).once('error', reject));
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return port;
}

async function startRelay(port, dataDir) {
  const env = { ...process.env, PORT: String(port), DATA_DIR: dataDir };
  delete env.DATABASE_URL;
  const child = spawn(process.execPath, [server], {
    env,
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`Relay exited with code ${child.exitCode}`);
    try {
      if ((await fetch(`${base}/api/health`)).ok) return { child, base };
    } catch {}
    await pause(50);
  }
  child.kill();
  throw new Error('Relay did not become ready');
}

async function stopRelay(child) {
  if (child.exitCode !== null) return;
  child.kill();
  await new Promise(resolve => child.once('exit', resolve));
}

function runCli(args, env) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: packageDir,
    env,
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  return result;
}

test('saved relay lets CLI create a link and retrieve it without browser steps', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dropenv-cli-'));
  const configFile = path.join(dataDir, 'config.json');
  const secretFile = path.join(dataDir, 'sender.env');
  fs.writeFileSync(secretFile, 'CLI_SECRET=terminal-only\n');
  const port = await freePort();
  const relay = await startRelay(port, path.join(dataDir, 'relay'));
  const env = { ...process.env, DROPENV_CONFIG_FILE: configFile };
  delete env.DROPENV_RELAY;
  t.after(async () => {
    await stopRelay(relay.child);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  let result = runCli(['config', '--relay', relay.base], env);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile, 'utf8')), { relay: relay.base });

  result = runCli([secretFile], env);
  assert.equal(result.status, 0, result.stderr);
  const link = result.stdout.trim();
  assert.match(link, new RegExp(`^${relay.base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/#d=[\\w-]+&key=[\\w-]+$`));

  result = runCli(['pull', link], env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'CLI_SECRET=terminal-only\n');
  assert.match(result.stderr, /Drop burned/);

  const id = new URL(link).hash.match(/#d=([\w-]+)/)[1];
  const response = await fetch(`${relay.base}/api/drops/${id}`);
  assert.equal(response.status, 410);
});

test('config rejects non-http relay URLs', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dropenv-config-'));
  const env = { ...process.env, DROPENV_CONFIG_FILE: path.join(dir, 'config.json') };
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = runCli(['config', '--relay', 'file:///tmp/relay'], env);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /base http\(s\) URL/);
  assert.equal(fs.existsSync(env.DROPENV_CONFIG_FILE), false);
});
