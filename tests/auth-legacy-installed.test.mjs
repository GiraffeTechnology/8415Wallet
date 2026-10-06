/** Real TCP-to-Unix packaged runtime journey using only temporary synthetic identities. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, readFile, writeFile, mkdir, readlink } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { request } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fixture, key, node, record } from './helpers/auth-legacy-host.mjs';
import { selectPort, probe } from '../deploy/auth-xiongan/install.mjs';
import { migrateLegacy } from '../deploy/auth-xiongan/migrate-legacy.mjs';
import { verifyAuthArchive, unpackAuthArchive } from '../scripts/package/verify-auth.mjs';
import { openEncryptedStore } from '../server/store.mjs';
import { hotp, digest, hashPassword } from '../server/crypto.mjs';
function client(config) {
  const jar = new Map(); let csrf = '';
  return { async call(path, body) {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const response = await new Promise((yes, no) => {
      const req = request({ ...(config.socketPath ? { socketPath: config.socketPath } : { host: '127.0.0.1', port: config.port }), path: `/auth/${path}`, method: body === undefined ? 'GET' : 'POST',
        headers: { Host: new URL(config.origin).host, Origin: config.origin, 'X-Wallet-Tenant': config.tenant, 'X-Wallet-CSRF': csrf, Cookie: [...jar].map(([k,v]) => `${k}=${v}`).join('; '), ...(encoded === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded) }) } }, res => {
        let raw = ''; res.on('data', b => { raw += b; }); res.on('end', () => { try { yes({ status: res.statusCode, headers: res.headers, data: JSON.parse(raw) }); } catch (e) { no(e); } });
      }); req.on('error', no); req.end(encoded);
    });
    for (const cookie of response.headers['set-cookie'] ?? []) { const [k,v] = cookie.split(';')[0].split('='); if(v) jar.set(k,v); else jar.delete(k); }
    if (response.status === 200 && response.data.csrf) csrf = response.data.csrf;
    return response;
  } };
}
test('installed migration retains actual consumed TOTP/recovery state, password login, verified mail and encrypted identity', { timeout: 60000 }, async t => {
  const f = await fixture(t), manifest = resolve('dist/auth-package-manifest.json'); verifyAuthArchive(manifest);
  const description = JSON.parse(await readFile(manifest));
  const runtime = unpackAuthArchive(join(dirname(manifest), description.artifact));
  // Fixture cleanup is scoped to files created by this test, never a production path.
  const { rm } = await import('node:fs/promises'); t.after(() => rm(runtime, { recursive: true, force: true }));
  f.options.packageDirectory = runtime;
  await cp(join(runtime, 'node_modules'), join(f.options.legacySource, 'node_modules'), { recursive: true });
  f.config.port = await selectPort([443]); f.config.accounts[0].passwordHash = await hashPassword('synthetic-migration-password');
  await writeFile(f.options.legacyConfig, JSON.stringify(f.config));
  await writeFile(f.options.legacyProxy, (await readFile(f.options.legacyProxy, 'utf8')).replace('127.0.0.1:18587', `127.0.0.1:${f.config.port}`));
  const recovery = '1111-2222-3333-4444-5555-6666-7777-8888', step = Math.floor(Date.now() / 30000);
  const store = await openEncryptedStore(f.options.legacyState, key);
  await store.transaction('xiongan:fixture-user', prior => ({ ...prior, lastStep: step - 2, recoverySalt: 'synthetic-salt', recoveryHashes: [digest(`synthetic-salt:${recovery}`)] })); await store.close();
  let service, output = '';
  async function start() {
    const runtime = await readlink(join(f.target.root, 'current')), config = JSON.parse(await readFile(f.options.legacyConfig));
    if (config.socketPath) await mkdir(f.target.socketDirectory, { recursive: true, mode: 0o755 });
    service = spawn(node.node, ['server/main.mjs'], { cwd: runtime, env: { PATH: process.env.PATH, WALLET_AUTH_CONFIG: f.options.legacyConfig, WALLET_AUTH_STORE_KEY: key.toString('hex') }, stdio: ['ignore', 'pipe', 'pipe'] });
    service.stdout.on('data', b => { output += b; }); service.stderr.on('data', b => { output += b; });
    for (let i = 0; i < 100; i++) {
      if (service.exitCode !== null) throw Error(`SYNTHETIC_RUNTIME_EXIT_${service.exitCode}`);
      try { await probe(config); return; } catch { await new Promise(r => setTimeout(r, 50)); }
    }
    throw Error('SYNTHETIC_RUNTIME_START_TIMEOUT');
  }
  async function stop() { if (service && service.exitCode === null) { const closed = once(service, 'exit'); service.kill('SIGTERM'); await closed; } }
  t.after(stop); await start();
  const selected = { username: 'fixture-user', account: f.config.accounts[0].wallets[0].account, chainId: '8453' }, code = hotp(record.secret, step);
  const old = client(f.config); await old.call('bootstrap'); assert.equal((await old.call('totp', { ...selected, code })).status, 200);
  await old.call('logout', {}); await old.call('bootstrap'); assert.equal((await old.call('totp', { ...selected, code: recovery, recovery: true })).status, 200);
  await old.call('logout', {});
  const ciphertext = await readFile(f.options.legacyState), keyBytes = await readFile(f.options.legacyKey);
  const host = f.options.run;
  f.options.run = async (file, args) => { if (args[0] === 'stop') await stop(); const result = await host(file, args); if (args[0] === 'start') await start(); return result; };
  f.options.probe = probe;
  assert.equal((await migrateLegacy(f.options)).status, 'legacy-imported-proxy-enabled');
  assert.deepEqual(await readFile(f.options.legacyState), ciphertext); assert.deepEqual(await readFile(f.options.legacyKey), keyBytes);
  const config = JSON.parse(await readFile(f.options.legacyConfig)), current = client(config);
  await current.call('bootstrap'); assert.equal((await current.call('totp', { ...selected, code })).status, 401); assert.equal((await current.call('totp', { ...selected, code: recovery, recovery: true })).status, 401);
  assert.equal((await current.call('password', { ...selected, password: 'synthetic-migration-password' })).status, 200);
  const account = await current.call('account'); assert.equal(account.status, 200); assert.equal(account.data.registration.complete, true); assert.equal(account.data.registration.email, 'fixture@example.invalid');
  assert.equal((await current.call('logout', {})).status, 200); await stop();
  const after = await openEncryptedStore(f.options.legacyState, key); const saved = await after.read('xiongan:fixture-user'); await after.close();
  assert.equal(saved.lastStep, step); assert.deepEqual(saved.recoveryHashes, []); assert.deepEqual(saved.registration, record.registration);
  for (const secret of [key.toString('hex'), record.secret, recovery, 'fixture@example.invalid']) assert.equal(output.includes(secret), false);
});
