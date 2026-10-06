/** Full offline package rehearsal. Every identity/key/password is a temporary synthetic fixture. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { Wallet } from 'ethers';
import { prepare, inspect, paths, probe } from '../deploy/auth-xiongan/install.mjs';
import { runOperatorActivate } from '../server/operator-activate.mjs';
import { hotp } from '../server/crypto.mjs';
import { verifyAuthArchive, unpackAuthArchive } from '../scripts/package/verify-auth.mjs';
import { renderEnrollmentQr, clearEnrollmentQr } from '../web/enrollment-qr.mjs';
const decode = createRequire(import.meta.url)('./vendor/jsqr.cjs');
const syntheticKey = Buffer.alloc(32, 0x5a);
const signer = new Wallet(`0x${'0'.repeat(63)}1`); // Publicly known local-only test signer, never funded or transmitted to a chain.
const tenant = 'rehearsal', origin = 'https://rehearsal.example.invalid:19447';
import { independentNode } from './helpers/independent-node.mjs';
const fixtureNode = await independentNode();
after(() => fixtureNode.cleanup());
const uid = process.getuid(), nodeUid = fixtureNode.uid;
function canvasFixture() {
  let width = 0, height = 0, pixels = new Uint8ClampedArray(0);
  const context = { fillStyle: '', fillRect(x, y, w, h) { const value = this.fillStyle === '#ffffff' ? 255 : 0; for (let r = y; r < y + h; r++) for (let c = x; c < x + w; c++) { const offset = (r * width + c) * 4; pixels.fill(value, offset, offset + 3); pixels[offset + 3] = 255; } } };
  return { hidden: true, get width() { return width; }, set width(v) { width = v; pixels = new Uint8ClampedArray(width * height * 4); }, get height() { return height; }, set height(v) { height = v; pixels = new Uint8ClampedArray(width * height * 4); }, getContext: () => context, pixels: () => pixels };
}
// Test only: real tempfile IO, injected ownership/TTY checks. This is not systemd/root identity evidence.
function activationFilesystem(privateRoots) {
  const annotate = (stat, path) => Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { uid: 0, gid: 0,
    mode: privateRoots.some(root => path === root || path.startsWith(root + '/')) ? stat.mode : (stat.mode & ~0o7777) | 0o755 });
  return { ...fs, lstat: async path => annotate(await fs.lstat(path), path), open: async (path, ...args) => {
    const handle = await fs.open(path, ...args);
    return new Proxy(handle, { get(object, key) { if (key === 'stat') return async () => annotate(await object.stat(), path); const value = object[key]; return typeof value === 'function' ? value.bind(object) : value; } });
  } };
}
async function startService(runtime, config, configPath) {
  const child = spawn(fixtureNode.node, ['server/main.mjs'], { cwd: runtime, env: { PATH: process.env.PATH, WALLET_AUTH_CONFIG: configPath, WALLET_AUTH_STORE_KEY: syntheticKey.toString('hex') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw Error(`PACKAGED_SERVICE_EXITED_${child.exitCode}: ${output.trim()}`);
    try { await probe(config); return { child, output: () => output }; } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  child.kill('SIGTERM'); throw Error('PACKAGED_SERVICE_START_TIMEOUT');
}
async function stopService(service) { if (service.child.exitCode === null) { const closed = once(service.child, 'exit'); service.child.kill('SIGTERM'); await closed; } }
function client(config) {
  const jar = new Map(); let csrf = '';
  return { async call(path, body, extra = {}) {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const response = await new Promise((yes, no) => {
      const req = request({ ...(config.socketPath ? { socketPath: config.socketPath } : { host: '127.0.0.1', port: config.port }), path: `/auth/${path}`, method: body === undefined ? 'GET' : 'POST',
        headers: { Host: new URL(config.origin).host, Origin: config.origin, 'X-Wallet-Tenant': config.tenant, 'X-Wallet-CSRF': csrf, Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...(encoded === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded) }), ...extra } }, res => {
        let raw = ''; res.on('data', chunk => { raw += chunk; }); res.on('end', () => { try { yes({ status: res.statusCode, headers: res.headers, data: JSON.parse(raw) }); } catch (error) { no(error); } });
      }); req.on('error', no); req.end(encoded);
    });
    for (const cookie of response.headers['set-cookie'] ?? []) { const [name, value] = cookie.split(';')[0].split('='); if (value) jar.set(name, value); else jar.delete(name); }
    if (response.status === 200 && response.data.csrf) csrf = response.data.csrf;
    return response;
  } };
}
test('verified offline package prepares, initializes synthetic credential, starts, enrolls local QR, consumes recovery and logs out across restart', { timeout: 45000 }, async t => {
  const manifestPath = resolve('dist/auth-package-manifest.json');
  const release = verifyAuthArchive(manifestPath); const manifest = JSON.parse(await fs.readFile(manifestPath));
  const runtime = unpackAuthArchive(join(dirname(manifestPath), manifest.artifact)); t.after(() => fs.rm(runtime, { recursive: true, force: true }));
  const root = await fs.mkdtemp(join(tmpdir(), 'wallet-auth-installed-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = paths(join(root, 'host'), tenant);
  for (const dir of [dirname(target.root), dirname(target.config), dirname(target.state), dirname(target.unit)]) await fs.mkdir(dir, { recursive: true, mode: 0o755 });
  const result = await prepare({ packageDirectory: runtime, target, uid, nodeUid, node: fixtureNode.node, origin, tenant, accounts: [{ username: 'synthetic-user', wallets: [{ account: signer.address, chainId: '8453' }] }], reservedPorts: [], reload: () => {} });
  assert.equal(result.sourceTree, release.source.tree); assert.equal(result.secretCreated, false);
  const statePath = join(target.state, 'credentials.enc'), configPath = join(target.config, 'auth.json');
  const prompts = ['PASSWORD', 'synthetic-user', 'synthetic-integration-password', 'synthetic-integration-password', 'CREATE']; let transcript = '';
  await runOperatorActivate(['--activate', '--tenant', tenant], { isTTY: true, fd: 0, setRawMode() {} }, { isTTY: true, fd: 1, write(value) { transcript += value; } }, {
    paths: { configDirectory: target.config, stateDirectory: target.state, config: configPath, key: join(target.config, 'store-key'), state: statePath },
    platform: 'linux', getuid: () => 0, geteuid: () => 0, environment: {}, ttyCheck: () => true,
    fs: activationFilesystem([target.config, target.state]), generateKey: () => Buffer.from(syntheticKey),
    terminalFactory: () => ({ question: async () => prompts.shift(), close() {} }),
  });
  assert.equal(prompts.length, 0); assert.equal(transcript.includes(syntheticKey.toString('hex')), false); assert.equal(transcript.includes('synthetic-integration-password'), false);
  const { config, receipt } = await inspect({ target, uid }); assert.ok(config.accounts[0].passwordHash);
  await fs.mkdir(target.socketDirectory, { recursive: true, mode: 0o755 });
  let service = await startService(receipt.runtime, config, configPath); t.after(() => stopService(service));
  const c = client(config), selected = { username: 'synthetic-user', account: signer.address, chainId: '8453' };
  assert.equal((await c.call('capabilities')).status, 200);
  assert.equal((await c.call('capabilities', undefined, { 'X-Wallet-Tenant': 'other' })).status, 403);
  assert.equal((await c.call('capabilities', undefined, { Host: 'wrong.example.invalid' })).status, 403);
  assert.equal((await c.call('password', { ...selected, password: 'synthetic-integration-password' })).status, 403);
  await c.call('bootstrap'); assert.equal((await c.call('password', { ...selected, password: 'synthetic-integration-password' })).status, 200);
  const setup = await c.call('totp/enroll/start', {}); assert.equal(setup.status, 200);
  const canvas = canvasFixture(); renderEnrollmentQr(canvas, setup.data.uri);
  assert.equal(decode(canvas.pixels(), canvas.width, canvas.height)?.data === setup.data.uri, true, 'independent local QR decoder must match actual installed-server URI');
  clearEnrollmentQr(canvas); assert.equal(canvas.pixels().length, 0);
  const code = hotp(setup.data.secret, Math.floor(Date.now() / 30000));
  const confirmed = await c.call('totp/enroll/confirm', { code }); assert.equal(confirmed.status, 200); assert.equal(confirmed.data.recoveryCodes.length, 8);
  assert.equal((await c.call('session')).status, 401);
  await c.call('bootstrap'); assert.equal((await c.call('totp', { ...selected, code })).status, 401);
  const recovery = { ...selected, code: confirmed.data.recoveryCodes[0], recovery: true };
  assert.equal((await c.call('totp', recovery)).status, 200); assert.equal((await c.call('logout', {})).status, 200); assert.equal((await c.call('session')).status, 401);
  const encrypted = await fs.readFile(statePath, 'utf8'); assert.equal(encrypted.includes(setup.data.secret), false); assert.equal(encrypted.includes(recovery.code), false);
  await stopService(service); service = await startService(receipt.runtime, config, configPath);
  const after = client(config); await after.call('bootstrap'); assert.equal((await after.call('totp', recovery)).status, 401);
  const challenge = (await after.call('challenge', { account: signer.address, chainId: '8453', method: 'wallet' })).data;
  assert.equal((await after.call('proof', { account: signer.address, chainId: '8453', id: challenge.id, signature: await signer.signMessage(challenge.message) })).status, 200);
  assert.equal((await after.call('logout', {})).status, 200);
  assert.equal(service.output().includes(setup.data.secret), false); assert.equal(service.output().includes(recovery.code), false);
});
