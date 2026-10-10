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
const registration = { version: 1, email: 'synthetic@example.invalid', verifiedAt: 1 };
const initialCredential = { registration };
const initialStore = () => ({ 'xiongan:tester': initialCredential, '@registration:xiongan': { version: 1, records: [{ username: 'tester', email: registration.email, verifiedAt: 1 }] } });
async function fixture(options: any = {}) {
  const signer = Wallet.createRandom(), state = { now: Math.floor(Date.now() / 30000) * 30000 }, store = options.store ?? new MemoryCredentialStore(initialStore()), mailbox: any[] = [];
  let handler: any;
  const server = createServer((req, res) => handler(req, res)); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address() as { port: number }, origin = `http://127.0.0.1:${address.port}`;
  const account = { username: 'tester', ...(options.withoutPassword ? {} : { passwordHash: hash }), wallets: [{ account: signer.address, chainId: '1' }], caFingerprints: options.fingerprints ?? [] };
  handler = createAuthService({ origin, tenant: 'xiongan', accounts: [account, ...(options.additionalAccounts ?? [])], store, now: () => state.now, sendOtp: async (message: any) => { mailbox.push(message); }, ...options });
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
    // Every management helper traverses the real combined API. No legacy route
    // is translated by the server, and no stored/session flag substitutes proof.
    let setup: any = null;
    const authorize = async (intent: any, factors: any = {}) => {
      const start = await call('account/change/start', intent); if (start.status !== 200) return start;
      const verified = await call('account/change/verify', { changeId: start.data.changeId, originalPassword: password, ...factors });
      if (verified.status !== 200) return verified;
      const response = await call('account/change/confirm', { changeId: start.data.changeId, code: mailbox.at(-1).code });
      return { ...response, data: { ...response.data, changeId: start.data.changeId } };
    };
    const startSetup = async (body: any = {}) => {
      const result = await authorize({ action: `totp.${body.purpose ?? (body.existingCode ? 'replace' : 'initial')}` },
        { ...(body.existingCode === undefined ? {} : { existingCode: body.existingCode }), ...(body.recovery === undefined ? {} : { recovery: body.recovery }) });
      if (result.status === 200) setup = result.data;
      return result;
    };
    const confirmSetup = (body: any) => call('account/change/commit', { changeProof: body.changeProof ?? setup?.changeProof, code: body.code });
    const cancelSetup = (body: any = {}) => call('account/change/cancel', body);
    const methods = async (body: any) => {
      const proof = await authorize({ action: 'methods', enabledMethods: body.enabledMethods },
        { ...(body.existingCode === undefined ? {} : { existingCode: body.existingCode }), ...(body.recovery === undefined ? {} : { recovery: body.recovery }) });
      return proof.status === 200 ? call('account/change/commit', { changeProof: proof.data.changeProof }) : proof;
    };
    return { call, authorize, startSetup, confirmSetup, cancelSetup, methods, bootstrap: () => call('bootstrap'), login: (extra = {}) => call('password', { username: 'tester', password, account: signer.address, chainId: '1', ...extra }), jar };
  };
  return { client, signer, origin, state, store, mailbox, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
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
  const setup = await c.startSetup({}); assert.equal(setup.status, 200); assert.match(setup.data.uri, /^otpauth:\/\/totp\//);
  assert.equal((await c.confirmSetup({ code: 'wrong' })).status, 403);
  const code = hotp(setup.data.secret, Math.floor(f.state.now / 30000));
  const enabled = await c.confirmSetup({ code }); assert.equal(enabled.status, 200); assert.equal(enabled.data.recoveryCodes.length, 8);
  assert.equal((await c.call('session')).status, 401);
  const loginBody = { username: 'tester', account: f.signer.address, chainId: '1', code };
  await c.bootstrap(); assert.equal((await c.call('totp', loginBody)).status, 401);
  f.state.now += 30000; loginBody.code = hotp(setup.data.secret, Math.floor(f.state.now / 30000));
  assert.equal((await c.call('totp', loginBody)).status, 200);
  assert.equal((await c.startSetup({})).status, 403);
  const other = f.client(); await other.bootstrap(); assert.equal((await other.call('totp', loginBody)).status, 401);
  const recovery = { ...loginBody, code: enabled.data.recoveryCodes[0], recovery: true };
  assert.equal((await other.call('totp', recovery)).status, 200);
  const third = f.client(); await third.bootstrap(); assert.equal((await third.call('totp', recovery)).status, 401);
});
test('TOTP replay state updates serialize concurrent requests and authenticator replacement revokes sessions', async t => {
  const f = await fixture(); t.after(f.close); const c = f.client(); await c.bootstrap(); await c.login();
  const setup = await c.startSetup({}); await c.confirmSetup({ code: hotp(setup.data.secret, Math.floor(f.state.now / 30000)) });
  f.state.now += 30000;
  const a = f.client(), b = f.client(); await a.bootstrap(); await b.bootstrap();
  const body = { username: 'tester', account: f.signer.address, chainId: '1', code: hotp(setup.data.secret, Math.floor(f.state.now / 30000)) };
  assert.deepEqual((await Promise.all([a.call('totp', body), b.call('totp', body)])).map(r => r.status).sort(), [200, 401]);
  await c.bootstrap(); await c.login(); assert.equal((await c.startSetup({ purpose: 'replace' })).status, 401);
  f.state.now += 30000;
  const replacement = await c.startSetup({ existingCode: hotp(setup.data.secret, Math.floor(f.state.now / 30000)) });
  assert.equal(replacement.status, 200); assert.notEqual(replacement.data.secret, setup.data.secret);
  assert.equal((await c.confirmSetup({ code: hotp(replacement.data.secret, Math.floor(f.state.now / 30000)) })).status, 200);
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
  const first = (await c.startSetup({})).data; await c.cancelSetup({});
  assert.equal((await c.confirmSetup({ code: hotp(first.secret, Math.floor(f.state.now / 30000)) })).status, 403);
  const second = (await c.startSetup({})).data;
  for (let n = 0; n < 5; n++) assert.equal((await c.confirmSetup({ code: 'invalid' })).status, 403);
  assert.equal((await c.confirmSetup({ code: hotp(second.secret, Math.floor(f.state.now / 30000)) })).status, 403);
  f.state.now += 5 * 60000;
  assert.equal((await c.startSetup({})).status, 403);
  assert.deepEqual(await f.store.read('xiongan:tester'), initialCredential);
});
test('a failed credential write leaves the store unhealthy rather than risking replay', async () => {
  class FailedStore extends MemoryCredentialStore { async persist() { throw Error('synthetic storage failure'); } }
  const store = new FailedStore(); await assert.rejects(store.transaction('tester', () => ({ lastStep: 1 })), /storage failure/);
  await assert.rejects(store.read('tester'), /UNHEALTHY/); await assert.rejects(store.transaction('tester', () => ({})), /UNHEALTHY/);
});

// Deterministic storage gates model slow reads, queued writes, and an atomic write
// already in progress. These tests use only ephemeral accounts and TOTP secrets.
function pause() {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const waiting = new Promise<void>(resolve => { release = resolve; });
  return { started, entered, waiting, release };
}
class GatedCredentialStore extends MemoryCredentialStore {
  constructor() { super(initialStore()); }
  nextRead: ReturnType<typeof pause> | null = null;
  nextTransaction: ReturnType<typeof pause> | null = null;
  nextPersist: ReturnType<typeof pause> | null = null;
  holdRead() { return this.nextRead = pause(); }
  holdTransaction() { return this.nextTransaction = pause(); }
  holdPersist() { return this.nextPersist = pause(); }
  async read(username: string) {
    const gate = this.nextRead; this.nextRead = null;
    const value = await super.read(username);
    if (gate) { gate.entered(); await gate.waiting; }
    return value;
  }
  async transaction(username: string, update: any) {
    const gate = this.nextTransaction; this.nextTransaction = null;
    if (gate) { gate.entered(); await gate.waiting; }
    return super.transaction(username, update);
  }
  async persist(data: any) {
    const gate = this.nextPersist; this.nextPersist = null;
    if (gate) { gate.entered(); await gate.waiting; }
    return super.persist(data);
  }
}
const confirmation = (setup: any, now: number) => ({ changeProof: setup.changeProof, code: hotp(setup.secret, Math.floor(now / 30000)) });

test('account management status is authenticated, account-bound and secret-free', async t => {
  const fingerprint = 'e'.repeat(64), f = await fixture({ fingerprints: [fingerprint], verifyCa: async () => ({ fingerprint }) });
  t.after(f.close); const c = f.client();
  assert.equal((await c.call('account')).status, 401); await c.bootstrap();
  assert.equal((await c.call('account')).status, 401); const login = await c.login();
  const result = await c.call('account'); assert.equal(result.status, 200);
  assert.deepEqual(result.data, { schema: '8415wallet-account/1', tenant: 'xiongan', origin: f.origin,
    username: 'tester', account: f.signer.address, chainId: '1',
    methods: { password: { available: true, enabled: true, bound: true }, wallet: { available: true, enabled: true, bound: true }, ca: { available: true, enabled: true, bound: true }, totp: { available: true, enabled: false, bound: false } },
    recovery: { configured: false, emailMasked: null, questionId: null, emailOtpAvailable: true, questions: ['recovery-phrase', 'first-school', 'childhood-place'] },
    registration: { required: false, complete: true, email: registration.email, emailMasked: 's***@example.invalid', emailOtpAvailable: true },
    authenticator: { enrolled: false, pending: false, expiresAt: null, replacement: false },
    methodChange: { available: true, factor: 'password', verifiedEmailRequired: false, emailMasked: 's***@example.invalid', existingCodeRequired: false, existingAnswerRequired: false, trustedDeviceSupported: false },
    management: { freshIndependentLogin: true, reauthenticateBy: login.data.issuedAt + 300000, existingCodeRequired: false } });
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.doesNotMatch(JSON.stringify(result.data), /passwordHash|recoveryHashes|recoverySalt|secret|fingerprint|csrf|session/);
  assert.equal((await c.call('account', undefined, { 'X-Wallet-CSRF': 'wrong' })).status, 401);
  assert.equal((await c.call('account', undefined, { 'X-Wallet-Tenant': 'other' })).status, 403);
  assert.equal((await c.call('account', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await c.call('account?username=another')).status, 404);
  const setup = (await c.startSetup({ purpose: 'initial' })).data;
  const pending = (await c.call('account')).data;
  assert.deepEqual(pending.authenticator, { enrolled: false, pending: true, expiresAt: setup.expiresAt, replacement: false });
  assert.equal(pending.methods.totp.enabled, false);
  const enabled = await c.confirmSetup(confirmation(setup, f.state.now)); assert.equal(enabled.status, 200);
  assert.equal((await c.call('account')).status, 401);
  await c.bootstrap(); await c.login();
  const active = (await c.call('account')).data;
  for (const method of ['password', 'wallet', 'ca', 'totp']) assert.deepEqual(active.methods[method], { available: true, enabled: true, bound: true });
  assert.equal(active.authenticator.enrolled, true); assert.equal(active.management.existingCodeRequired, true);
  f.state.now += 300000;
  assert.equal((await c.call('account')).data.management.freshIndependentLogin, false);
  assert.equal((await c.startSetup({ purpose: 'replace', existingCode: enabled.data.recoveryCodes[0], recovery: true })).status, 403);
});

test('account status distinguishes server CA availability and per-account bindings without selecting one method globally', async t => {
  const f = await fixture({ withoutPassword: true, fingerprints: ['f'.repeat(64)] }); t.after(f.close);
  const c = f.client(); await c.bootstrap(); const selected = { account: f.signer.address, chainId: '1' };
  const challenge = (await c.call('challenge', { ...selected, method: 'wallet' })).data;
  assert.equal((await c.call('proof', { ...selected, id: challenge.id, signature: await f.signer.signMessage(challenge.message) })).status, 200);
  const status = (await c.call('account')).data;
  assert.deepEqual(status.methods.password, { available: true, enabled: false, bound: false });
  assert.deepEqual(status.methods.wallet, { available: true, enabled: true, bound: true });
  assert.deepEqual(status.methods.ca, { available: false, enabled: false, bound: true });
  assert.equal(status.management.freshIndependentLogin, true);
});

test('initial and replacement purposes fail closed on state changes; recovery replacement preserves other methods', async t => {
  const f = await fixture(); t.after(f.close); const c = f.client(); await c.bootstrap(); await c.login();
  assert.equal((await c.startSetup({ purpose: 'replace' })).data.error, 'AUTH_SETUP_STATE_CHANGED');
  const setup = (await c.startSetup({ purpose: 'initial' })).data;
  const enrolled = await c.confirmSetup(confirmation(setup, f.state.now));
  await c.bootstrap(); await c.login();
  assert.equal((await c.startSetup({ purpose: 'initial' })).data.error, 'AUTH_SETUP_STATE_CHANGED');
  assert.equal((await c.startSetup({ purpose: 'replace' })).status, 401);
  const replacement = await c.startSetup({ purpose: 'replace', existingCode: enrolled.data.recoveryCodes[0], recovery: true });
  assert.equal(replacement.status, 200); assert.equal(replacement.data.action, 'totp.replace');
  const pending = (await c.call('account')).data;
  assert.equal(pending.authenticator.enrolled, true); assert.equal(pending.authenticator.replacement, true);
  assert.equal((await f.store.read('xiongan:tester')).secret, setup.secret);
  assert.equal((await c.confirmSetup(confirmation(replacement.data, f.state.now))).status, 200);
  const recoveryClient = f.client(); await recoveryClient.bootstrap();
  assert.equal((await recoveryClient.call('totp', { username: 'tester', account: f.signer.address, chainId: '1', code: enrolled.data.recoveryCodes[1], recovery: true })).status, 401);
  await c.bootstrap(); assert.equal((await c.login()).status, 200);
  const after = (await c.call('account')).data; assert.equal(after.methods.password.enabled, true); assert.equal(after.methods.wallet.enabled, true);
});

test('TOTP and recovery sessions can inspect methods but cannot manage authenticator enrollment', async t => {
  const f = await fixture(); t.after(f.close); const c = f.client(); await c.bootstrap(); await c.login();
  const setup = (await c.startSetup({})).data;
  const enrolled = await c.confirmSetup(confirmation(setup, f.state.now));
  f.state.now += 30000;
  for (const recovery of [false, true]) {
    const other = f.client(); await other.bootstrap();
    const code = recovery ? enrolled.data.recoveryCodes[0] : hotp(setup.secret, Math.floor(f.state.now / 30000));
    assert.equal((await other.call('totp', { username: 'tester', account: f.signer.address, chainId: '1', code, recovery })).status, 200);
    const status = (await other.call('account')).data;
    assert.equal(status.authenticator.enrolled, true); assert.deepEqual(status.management, { freshIndependentLogin: false, reauthenticateBy: null, existingCodeRequired: true });
    assert.equal((await other.startSetup({ purpose: 'replace', existingCode: enrolled.data.recoveryCodes[1], recovery: true })).status, 403);
  }
});

test('cancel and logout invalidate enrollment starts delayed on credential reads', async t => {
  for (const action of ['account/change/cancel', 'logout']) {
    const store = new GatedCredentialStore(), f = await fixture({ store }); t.after(f.close);
    const c = f.client(); await c.bootstrap(); await c.login();
    const gate = store.holdRead(), start = c.startSetup({ purpose: 'initial' });
    await gate.started;
    assert.equal((await c.call(action, {})).status, 200); gate.release();
    const late = await start; assert.equal(late.status, action === 'logout' ? 401 : 403); assert.equal(late.data.secret, undefined);
    assert.deepEqual(await store.read('xiongan:tester'), initialCredential);
    if (action === 'account/change/cancel') assert.equal((await c.call('account')).data.authenticator.pending, false);
    else assert.equal((await c.call('account')).status, 401);
  }
});

test('a newer enrollment start supersedes delayed starts and rejects stale setup identifiers', async t => {
  const store = new GatedCredentialStore(), f = await fixture({ store }); t.after(f.close);
  const c = f.client(); await c.bootstrap(); await c.login();
  const gate = store.holdRead(), late = c.startSetup({}); await gate.started;
  const current = await c.startSetup({}); assert.equal(current.status, 200);
  gate.release(); assert.equal((await late).status, 403);
  const newer = (await c.startSetup({})).data;
  assert.notEqual(newer.changeProof, current.data.changeProof);
  assert.equal((await c.cancelSetup({ changeProof: current.data.changeProof })).data.error, 'AUTH_SETUP_STATE_CHANGED');
  assert.equal((await c.confirmSetup(confirmation(current.data, f.state.now))).data.error, 'AUTH_CHANGE_REFUSED');
  assert.equal((await c.confirmSetup(confirmation(newer, f.state.now))).status, 200);
  assert.equal((await store.read('xiongan:tester')).secret, newer.secret);
});

test('cancel and logout prevent confirmations waiting to enter a credential transaction', async t => {
  for (const action of ['account/change/cancel', 'logout']) {
    const store = new GatedCredentialStore(), f = await fixture({ store }); t.after(f.close);
    const c = f.client(); await c.bootstrap(); await c.login(); const setup = (await c.startSetup({})).data;
    const gate = store.holdTransaction(), confirm = c.confirmSetup(confirmation(setup, f.state.now));
    await gate.started;
    assert.equal((await c.call(action, {})).status, 200); gate.release(); assert.equal((await confirm).status, action === 'logout' ? 401 : 403);
    assert.deepEqual(await store.read('xiongan:tester'), initialCredential);
  }
});

test('two account sessions cannot confirm competing initial authenticator enrollments', async t => {
  const store = new GatedCredentialStore(), f = await fixture({ store }); t.after(f.close);
  const a = f.client(), b = f.client(); await a.bootstrap(); await a.login(); await b.bootstrap(); await b.login();
  const setupA = (await a.startSetup({})).data, setupB = (await b.startSetup({})).data;
  const gate = store.holdTransaction(), first = a.confirmSetup(confirmation(setupA, f.state.now)); await gate.started;
  assert.equal((await b.confirmSetup(confirmation(setupB, f.state.now))).status, 200);
  gate.release(); assert.equal((await first).status, 401);
  const credential = await store.read('xiongan:tester'); assert.equal(credential.revision, 1); assert.equal(credential.secret, setupB.secret);
  assert.equal((await a.call('account')).status, 401); assert.equal((await b.call('account')).status, 401);
});

test('credential revision changes reject pending confirms even before in-memory session revocation', async t => {
  const store = new GatedCredentialStore(), f = await fixture({ store }); t.after(f.close);
  const c = f.client(); await c.bootstrap(); await c.login(); const setup = (await c.startSetup({})).data;
  const gate = store.holdTransaction(), confirm = c.confirmSetup(confirmation(setup, f.state.now)); await gate.started;
  // An independently committed credential revision is authoritative, regardless
  // of the old session's previously successful read.
  await store.transaction('xiongan:tester', () => ({ ...initialCredential, revision: 4 }));
  gate.release(); assert.equal((await confirm).status, 409); assert.deepEqual(await store.read('xiongan:tester'), { ...initialCredential, revision: 4 });
  assert.equal((await c.call('account')).status, 401);
});

test('cancellation reports an already-submitted atomic confirmation rather than claiming rollback', async t => {
  const store = new GatedCredentialStore(), f = await fixture({ store }); t.after(f.close);
  const c = f.client(); await c.bootstrap(); await c.login(); const setup = (await c.startSetup({})).data;
  const gate = store.holdPersist(), confirm = c.confirmSetup(confirmation(setup, f.state.now)); await gate.started;
  const cancellation = await c.cancelSetup({ changeProof: setup.changeProof });
  assert.equal(cancellation.status, 200); assert.deepEqual(cancellation.data, { cancelled: false, confirmationInProgress: true });
  assert.equal((await c.startSetup({})).data.error, 'AUTH_SETUP_STATE_CHANGED');
  assert.equal((await c.call('logout', {})).status, 200);
  gate.release(); assert.equal((await confirm).status, 200);
  assert.equal((await store.read('xiongan:tester')).secret, setup.secret); assert.equal((await c.call('account')).status, 401);
});

test('account reads delayed past logout never return formerly authenticated state', async t => {
  const store = new GatedCredentialStore(), f = await fixture({ store }); t.after(f.close);
  const c = f.client(); await c.bootstrap(); await c.login(); const gate = store.holdRead(), status = c.call('account');
  await gate.started; await c.call('logout', {}); gate.release(); assert.equal((await status).status, 401);
});

test('setup and queued confirmation expire at the independent-login freshness deadline', async t => {
  const store = new GatedCredentialStore(), f = await fixture({ store }); t.after(f.close);
  const c = f.client(); await c.bootstrap(); const login = await c.login(); f.state.now += 299000;
  const setup = (await c.startSetup({})).data; assert.equal(setup.expiresAt, login.data.issuedAt + 300000);
  const gate = store.holdTransaction(), confirm = c.confirmSetup(confirmation(setup, f.state.now)); await gate.started;
  f.state.now += 1000; gate.release(); const rejected = await confirm;
  assert.equal(rejected.status, 403); assert.equal(rejected.data.error, 'AUTH_RECENT_INDEPENDENT_LOGIN_REQUIRED');
  assert.deepEqual(await store.read('xiongan:tester'), initialCredential);
  assert.equal((await c.call('account')).data.authenticator.pending, false);
});


test('method selection accepts only known bound available methods and retains an independent login', async t => {
  const f = await fixture(); t.after(f.close); const c = f.client();
  assert.equal((await c.methods({ enabledMethods: ['password'] })).status, 401);
  await c.bootstrap(); await c.login();
  for (const enabledMethods of [undefined, 'password', ['password', 'password'], ['password', 'email'], [null]]) {
    assert.equal((await c.methods({ enabledMethods })).data.error, 'AUTH_METHODS_REFUSED');
  }
  for (const enabledMethods of [['password', 'ca'], ['password', 'totp']]) {
    assert.equal((await c.methods({ enabledMethods })).data.error, 'AUTH_METHOD_UNAVAILABLE');
  }
  assert.equal((await c.methods({ enabledMethods: [] })).data.error, 'AUTH_INDEPENDENT_METHOD_REQUIRED');
  assert.deepEqual(await f.store.read('xiongan:tester'), initialCredential);
  assert.deepEqual((await c.methods({ enabledMethods: ['password', 'wallet'] })).data, { updated: true, loggedOut: true, action: 'methods' });
  assert.equal((await c.call('session')).status, 401);
  const stored = await f.store.read('xiongan:tester'); assert.deepEqual(stored.enabledMethods, ['password', 'wallet']); assert.equal(stored.revision, 1);
});

test('per-account choices persist, revoke every session and enforce each login without removing bindings', async t => {
  const f = await fixture(); t.after(f.close); const a = f.client(), b = f.client();
  await a.bootstrap(); await a.login(); await b.bootstrap(); await b.login();
  assert.equal((await a.methods({ enabledMethods: ['password'] })).status, 200);
  assert.equal((await a.call('session')).status, 401); assert.equal((await b.call('session')).status, 401);
  const selected = { account: f.signer.address, chainId: '1' }, token = f.client(); await token.bootstrap();
  const challenge = (await token.call('challenge', { ...selected, method: 'wallet' })).data;
  assert.equal((await token.call('proof', { ...selected, id: challenge.id, signature: await f.signer.signMessage(challenge.message) })).status, 401);
  await a.bootstrap(); assert.equal((await a.login()).status, 200);
  const status = (await a.call('account')).data;
  assert.deepEqual(status.methods.wallet, { available: true, enabled: false, bound: true });
  assert.equal((await a.methods({ enabledMethods: ['wallet'] })).status, 200);
  await b.bootstrap(); assert.equal((await b.login()).status, 401);
  await token.bootstrap(); const next = (await token.call('challenge', { ...selected, method: 'wallet' })).data;
  assert.equal((await token.call('proof', { ...selected, id: next.id, signature: await f.signer.signMessage(next.message) })).status, 200);
  assert.equal((await token.methods({ enabledMethods: ['password', 'wallet'] })).status, 200);
  await a.bootstrap(); assert.equal((await a.login()).status, 200);
  const restored = (await a.call('account')).data; assert.equal(restored.methods.password.enabled, true); assert.equal(restored.methods.wallet.enabled, true);
});

test('TOTP disable and re-enable require existing proof, preserve enrollment, and refuse disabled login before consuming a code', async t => {
  const f = await fixture(); t.after(f.close); const c = f.client(); await c.bootstrap(); await c.login();
  const setup = (await c.startSetup({})).data, enrolled = (await c.confirmSetup(confirmation(setup, f.state.now))).data;
  await c.bootstrap(); await c.login();
  assert.equal((await c.methods({ enabledMethods: ['totp'] })).data.error, 'AUTH_INDEPENDENT_METHOD_REQUIRED');
  assert.equal((await c.methods({ enabledMethods: ['password', 'wallet'] })).status, 401);
  assert.equal((await f.store.read('xiongan:tester')).revision, 1);
  assert.equal((await c.methods({ enabledMethods: ['password', 'wallet'], existingCode: enrolled.recoveryCodes[0], recovery: true })).status, 200);
  const disabled = await f.store.read('xiongan:tester'); assert.equal(disabled.secret, setup.secret); assert.equal(disabled.recoveryHashes.length, 7);
  const other = f.client(); await other.bootstrap();
  const body = { username: 'tester', account: f.signer.address, chainId: '1', code: enrolled.recoveryCodes[1], recovery: true };
  assert.equal((await other.call('totp', body)).status, 401);
  assert.equal((await f.store.read('xiongan:tester')).recoveryHashes.length, 7);
  await c.bootstrap(); await c.login(); const status = (await c.call('account')).data;
  assert.deepEqual(status.methods.totp, { available: true, enabled: false, bound: true }); assert.equal(status.authenticator.enrolled, true);
  assert.equal((await c.methods({ enabledMethods: ['password', 'wallet', 'totp'], existingCode: enrolled.recoveryCodes[1], recovery: true })).status, 200);
  await other.bootstrap(); assert.equal((await other.call('totp', { ...body, code: enrolled.recoveryCodes[2] })).status, 200);
  assert.equal((await other.methods({ enabledMethods: ['password', 'wallet', 'totp'] })).status, 403);
});

test('concurrent method updates and enrollment cannot overwrite a newer credential revision', async t => {
  const store = new GatedCredentialStore(), f = await fixture({ store }); t.after(f.close);
  const a = f.client(), b = f.client(); await a.bootstrap(); await a.login(); await b.bootstrap(); await b.login();
  const setup = (await a.startSetup({})).data;
  const gate = store.holdTransaction(), confirm = a.confirmSetup(confirmation(setup, f.state.now)); await gate.started;
  assert.equal((await b.methods({ enabledMethods: ['password'] })).status, 200);
  gate.release(); assert.equal((await confirm).status, 401);
  assert.deepEqual(await store.read('xiongan:tester'), { ...initialCredential, enabledMethods: ['password'], revision: 1 });
  await a.bootstrap(); await a.login(); const next = (await a.startSetup({})).data;
  assert.equal((await a.confirmSetup(confirmation(next, f.state.now))).status, 200);
  const after = await store.read('xiongan:tester'); assert.deepEqual(after.enabledMethods, ['password', 'totp']); assert.equal(after.revision, 2);
});

test('method updates reject stale independent login and logout during queued storage access', async t => {
  const store = new GatedCredentialStore(), f = await fixture({ store }); t.after(f.close);
  const c = f.client(); await c.bootstrap(); await c.login();
  const gate = store.holdTransaction(), update = c.methods({ enabledMethods: ['password'] }); await gate.started;
  await c.call('logout', {}); gate.release(); assert.equal((await update).status, 401); assert.deepEqual(await store.read('xiongan:tester'), initialCredential);
  await c.bootstrap(); await c.login(); f.state.now += 300000;
  assert.equal((await c.methods({ enabledMethods: ['password'] })).data.error, 'AUTH_RECENT_INDEPENDENT_LOGIN_REQUIRED');
});


test('a method policy change affects only its own account', async t => {
  const signer = Wallet.createRandom(), f = await fixture({ additionalAccounts: [{ username: 'other', passwordHash: hash,
    wallets: [{ account: signer.address, chainId: '1' }], caFingerprints: [] }] }); t.after(f.close);
  const a = f.client(), b = f.client(); await a.bootstrap(); await a.login(); await b.bootstrap();
  assert.equal((await b.login({ username: 'other', account: signer.address })).status, 200);
  assert.equal((await a.methods({ enabledMethods: ['password'] })).status, 200);
  const status = await b.call('account'); assert.equal(status.status, 200); assert.equal(status.data.username, 'other');
  assert.equal(status.data.methods.password.enabled, true); assert.equal(status.data.methods.wallet.enabled, true);
  assert.equal(await f.store.read('xiongan:other'), null);
});

test('reserved answer and prior verified email join exact identity and authenticator proof without a generic reset grant', async t => {
  const f = await fixture(); t.after(f.close); const c = f.client(); await c.bootstrap(); await c.login();
  const answer = 'synthetic reserved recovery answer';
  const reserved = await c.authorize({ action: 'recovery.initial', email: registration.email, questionId: 'recovery-phrase', answer });
  assert.equal(reserved.status, 200); assert.equal(f.mailbox.length, 1); assert.equal(f.mailbox[0].purpose, 'method-change');
  assert.equal(reserved.data.code, undefined); assert.equal(reserved.data.email, undefined);
  assert.equal((await c.call('account/change/commit', { changeProof: reserved.data.changeProof })).status, 200);
  assert.equal((await c.call('session')).status, 401);
  await c.bootstrap(); await c.login();
  const status = (await c.call('account')).data;
  assert.equal(status.recovery.configured, true); assert.equal(status.recovery.emailMasked, 's***@example.invalid');
  assert.equal(status.recovery.emailOtpAvailable, true); assert.equal(status.recovery.questionId, 'recovery-phrase');
  const setup = await c.authorize({ action: 'totp.initial' }, { existingAnswer: answer }); assert.equal(setup.status, 200);
  const enrolled = (await c.confirmSetup(confirmation(setup.data, f.state.now))).data;
  assert.equal((await f.store.read('xiongan:tester')).recoveryProfile.email, registration.email);
  await c.bootstrap(); await c.login(); const before = await f.store.read('xiongan:tester');
  const missing = await c.authorize({ action: 'totp.replace' }, { existingCode: enrolled.recoveryCodes[0], recovery: true });
  assert.equal(missing.status, 403); assert.deepEqual(await f.store.read('xiongan:tester'), before);
  const substituted = await c.call('account/change/start', { action: 'totp.replace', email: 'attacker@example.invalid' });
  assert.equal(substituted.status, 400); assert.equal(f.mailbox.length, 2);
  const invalid = await c.authorize({ action: 'totp.replace' }, { existingAnswer: answer, existingCode: 'invalid', recovery: true });
  assert.equal(invalid.status, 401); assert.deepEqual(await f.store.read('xiongan:tester'), before);
  const replacement = await c.authorize({ action: 'totp.replace' }, { existingAnswer: answer, existingCode: enrolled.recoveryCodes[0], recovery: true });
  assert.equal(replacement.status, 200); assert.equal(f.mailbox.length, 3);
  assert.equal(f.mailbox[2].to, registration.email); assert.equal(f.mailbox[2].purpose, 'method-change');
  assert.equal((await c.call('account/change/commit', { changeProof: 'generic-reset-proof', code: hotp(replacement.data.secret, Math.floor(f.state.now / 30000)) })).status, 403);
  assert.equal((await c.confirmSetup(confirmation(replacement.data, f.state.now))).status, 200);
  const after = await f.store.read('xiongan:tester'); assert.equal(after.recoveryProfile.email, registration.email); assert.equal(after.secret, replacement.data.secret);
});
