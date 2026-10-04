import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet, getBytes } from 'ethers';
import { createAuthService } from '../server/auth-service.mjs';
import { MemoryCredentialStore, openEncryptedStore } from '../server/store.mjs';
import { hashPassword, hotp } from '../server/crypto.mjs';
const password = 'synthetic-account-password', hash = await hashPassword(password);
async function fixture(options: any = {}) {
  const signer = Wallet.createRandom(), state = { now: Date.now() }, store = options.store ?? new MemoryCredentialStore();
  let handler: any;
  const server = createServer((req, res) => handler(req, res)); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address() as { port: number }, origin = `http://127.0.0.1:${address.port}`;
  const account = { username: 'tester', passwordHash: hash, wallets: [{ account: signer.address, chainId: '1' }], caFingerprints: options.fingerprints ?? [] };
  handler = createAuthService({ origin, tenant: 'xiongan', accounts: [account], store, now: () => state.now, ...options });
  const client = () => {
    const jar = new Map<string, string>(); let csrf = '';
    const call = async (path: string, body?: any, headers: Record<string, string> = {}) => {
      const response = await fetch(`${origin}/auth/${path}`, { method: body === undefined ? 'GET' : 'POST',
        headers: { 'X-Wallet-Tenant': 'xiongan', 'X-Wallet-CSRF': csrf, Origin: origin, Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      for (const cookie of response.headers.getSetCookie()) { const [name, value] = cookie.split(';')[0]!.split('='); if (value) jar.set(name!, value); else jar.delete(name!); }
      const data = await response.json() as any; if (response.ok && data.csrf) csrf = data.csrf;
      return { status: response.status, data, headers: response.headers };
    };
    return { call, bootstrap: () => call('bootstrap'), login: (extra = {}) => call('password', { username: 'tester', password, account: signer.address, chainId: '1', ...extra }), jar };
  };
  return { client, signer, origin, state, store, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}
test('password authentication has origin, CSRF, tenant, fixed wallet binding and revocable HttpOnly session', async t => {
  const f = await fixture(); t.after(f.close); const c = f.client();
  assert.equal((await c.login()).status, 403); await c.bootstrap();
  for (const extra of [{ username: 'missing' }, { password: 'wrong' }, { account: Wallet.createRandom().address }, { chainId: '8453' }]) {
    const result = await c.login(extra); assert.equal(result.status, 401); assert.equal(result.data.error, 'AUTH_REFUSED');
  }
  assert.equal((await c.call('password', {}, { Origin: 'https://evil.invalid' })).status, 403);
  assert.equal((await c.call('capabilities', undefined, { 'X-Wallet-Tenant': 'other' })).status, 403);
  const login = await c.login(); assert.equal(login.status, 200); assert.equal(login.data.kind, 'password');
  assert.match(login.headers.get('set-cookie')!, /HttpOnly; SameSite=Strict/); assert.equal(login.headers.get('cache-control'), 'no-store');
  assert.equal(login.data.token, undefined); assert.equal(login.data.password, undefined);
  assert.equal((await c.call('session')).status, 200);
  assert.equal((await c.call('logout', {})).status, 200); assert.equal((await c.call('session')).status, 401);
});
test('TOTP enrollment requires independent recent login, confirmation, single-use codes and recovery', async t => {
  const f = await fixture(); t.after(f.close); const c = f.client(); await c.bootstrap(); await c.login();
  const setup = await c.call('totp/enroll/start', {}); assert.equal(setup.status, 200); assert.match(setup.data.uri, /^otpauth:\/\/totp\//);
  assert.equal((await c.call('totp/enroll/confirm', { code: 'wrong' })).status, 401);
  const code = hotp(setup.data.secret, Math.floor(f.state.now / 30000));
  const enabled = await c.call('totp/enroll/confirm', { code }); assert.equal(enabled.status, 200); assert.equal(enabled.data.recoveryCodes.length, 8);
  assert.equal((await c.call('session')).status, 401);
  const loginBody = { username: 'tester', account: f.signer.address, chainId: '1', code };
  await c.bootstrap(); assert.equal((await c.call('totp', loginBody)).status, 401);
  f.state.now += 30000; loginBody.code = hotp(setup.data.secret, Math.floor(f.state.now / 30000));
  assert.equal((await c.call('totp', loginBody)).status, 200);
  assert.equal((await c.call('totp/enroll/start', {})).status, 403);
  const other = f.client(); await other.bootstrap(); assert.equal((await other.call('totp', loginBody)).status, 401);
  const recovery = { ...loginBody, code: enabled.data.recoveryCodes[0], recovery: true };
  assert.equal((await other.call('totp', recovery)).status, 200);
  const third = f.client(); await third.bootstrap(); assert.equal((await third.call('totp', recovery)).status, 401);
});
test('TOTP replay state updates serialize concurrent requests and authenticator replacement revokes sessions', async t => {
  const f = await fixture(); t.after(f.close); const c = f.client(); await c.bootstrap(); await c.login();
  const setup = await c.call('totp/enroll/start', {}); await c.call('totp/enroll/confirm', { code: hotp(setup.data.secret, Math.floor(f.state.now / 30000)) });
  f.state.now += 30000;
  const a = f.client(), b = f.client(); await a.bootstrap(); await b.bootstrap();
  const body = { username: 'tester', account: f.signer.address, chainId: '1', code: hotp(setup.data.secret, Math.floor(f.state.now / 30000)) };
  assert.deepEqual((await Promise.all([a.call('totp', body), b.call('totp', body)])).map(r => r.status).sort(), [200, 401]);
  await c.bootstrap(); await c.login(); assert.equal((await c.call('totp/enroll/start', {})).status, 401);
  f.state.now += 30000;
  const replacement = await c.call('totp/enroll/start', { existingCode: hotp(setup.data.secret, Math.floor(f.state.now / 30000)) });
  assert.equal(replacement.status, 200); assert.notEqual(replacement.data.secret, setup.data.secret);
  assert.equal((await c.call('totp/enroll/confirm', { code: hotp(replacement.data.secret, Math.floor(f.state.now / 30000)) })).status, 200);
  assert.equal((await a.call('session')).status, 401); assert.equal((await b.call('session')).status, 401);
});
test('local private-key proof uses a server nonce and rejects replay, wrong message and cancelled challenge', async t => {
  const f = await fixture(); t.after(f.close); const c = f.client(); await c.bootstrap();
  const selected = { account: f.signer.address, chainId: '1' };
  const challenge = (await c.call('challenge', { ...selected, method: 'wallet' })).data;
  assert.match(challenge.message, /urn:8415wallet:tenant:xiongan/);
  const proof = { ...selected, id: challenge.id, signature: await f.signer.signMessage(challenge.message) };
  assert.equal((await c.call('proof', proof)).status, 200);
  const d = f.client(); await d.bootstrap(); assert.equal((await d.call('proof', proof)).status, 401);
  const bad = (await d.call('challenge', { ...selected, method: 'wallet' })).data;
  assert.equal((await d.call('proof', { ...selected, id: bad.id, signature: await f.signer.signMessage(getBytes('0x1234')) })).status, 401);
  const cancelled = (await d.call('challenge', { ...selected, method: 'wallet' })).data;
  await d.call('logout', {});
  assert.equal((await d.call('proof', { ...selected, id: cancelled.id, signature: await f.signer.signMessage(cancelled.message) })).status, 403);
});
test('sessions expire, reject clock reversal and rate-bound repeated login attempts', async t => {
  const f = await fixture(); t.after(f.close); const c = f.client(); await c.bootstrap(); const login = await c.login();
  f.state.now = login.data.expiresAt; assert.equal((await c.call('session')).status, 401);
  await c.bootstrap(); const second = await c.login(); f.state.now = second.data.issuedAt - 1; assert.equal((await c.call('session')).status, 401);
  f.state.now += 1; await c.bootstrap();
  for (let n = 0; n < 10; n++) await c.call('totp', { username: 'nobody', code: '123456', account: f.signer.address, chainId: '1' });
  assert.equal((await c.call('totp', { username: 'nobody', code: '123456', account: f.signer.address, chainId: '1' })).status, 429);
});
test('encrypted credentials survive restart without plaintext secrets; tampering and a second writer fail closed', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'auth-store-test-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'credentials.enc'), key = Buffer.alloc(32, 11), initial = await openEncryptedStore(path, key);
  await initial.transaction('tester', () => ({ secret: 'SYNTHETIC-TOTP-SECRET', lastStep: 123, revision: 4, recoveryHashes: ['hash'] }));
  assert.doesNotMatch(await readFile(path, 'utf8'), /SYNTHETIC|tester|lastStep/);
  await assert.rejects(openEncryptedStore(path, key), /EEXIST/); await initial.close();
  const restored = await openEncryptedStore(path, key); assert.equal((await restored.read('tester')).lastStep, 123); await restored.close();
  await assert.rejects(openEncryptedStore(path, Buffer.alloc(32, 22)));
});
test('CA account binding is fingerprint-based and logout invalidates an in-flight proof', async t => {
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; });
  const fingerprint = 'd'.repeat(64);
  const f = await fixture({ fingerprints: [fingerprint], verifyCa: async ({ message }: any) => {
    assert.match(message, /Purpose: login only/); entered(); await gate; return { fingerprint };
  } }); t.after(f.close);
  const c = f.client(); await c.bootstrap(); const selected = { account: f.signer.address, chainId: '1' };
  const challenge = (await c.call('challenge', { ...selected, method: 'ca' })).data;
  const proof = c.call('proof', { ...selected, id: challenge.id, signature: 'synthetic', certificateChain: 'synthetic', algorithm: 'ECDSA-SHA256' });
  await started; await c.call('logout', {}); release(); assert.equal((await proof).status, 403);
  const other = f.client(); await other.bootstrap(); const next = (await other.call('challenge', { ...selected, method: 'ca' })).data;
  const result = await other.call('proof', { ...selected, id: next.id, signature: 'synthetic', certificateChain: 'synthetic', algorithm: 'ECDSA-SHA256' });
  assert.equal(result.status, 200); assert.equal(result.data.kind, 'ca');
});
test('TOTP setup cancellation, expiry and exhausted confirmation attempts do not enroll', async t => {
  const f = await fixture(); t.after(f.close); const c = f.client(); await c.bootstrap(); await c.login();
  const first = (await c.call('totp/enroll/start', {})).data; await c.call('totp/enroll/cancel', {});
  assert.equal((await c.call('totp/enroll/confirm', { code: hotp(first.secret, Math.floor(f.state.now / 30000)) })).status, 401);
  const second = (await c.call('totp/enroll/start', {})).data;
  for (let n = 0; n < 5; n++) assert.equal((await c.call('totp/enroll/confirm', { code: 'invalid' })).status, 401);
  assert.equal((await c.call('totp/enroll/confirm', { code: hotp(second.secret, Math.floor(f.state.now / 30000)) })).status, 401);
  f.state.now += 5 * 60000;
  assert.equal((await c.call('totp/enroll/start', {})).status, 403);
  assert.equal(await f.store.read('xiongan:tester'), null);
});
test('a failed credential write leaves the store unhealthy rather than risking replay', async () => {
  class FailedStore extends MemoryCredentialStore { async persist() { throw Error('synthetic storage failure'); } }
  const store = new FailedStore(); await assert.rejects(store.transaction('tester', () => ({ lastStep: 1 })), /storage failure/);
  await assert.rejects(store.read('tester'), /UNHEALTHY/); await assert.rejects(store.transaction('tester', () => ({})), /UNHEALTHY/);
});
