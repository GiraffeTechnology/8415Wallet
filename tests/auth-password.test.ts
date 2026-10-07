/** Password management uses only synthetic identities, factors and local stores. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet } from 'ethers';
import { createAuthService } from '../server/auth-service.mjs';
import { MemoryCredentialStore, openEncryptedStore } from '../server/store.mjs';
import { hashPassword, verifyPassword, hotp, digest } from '../server/crypto.mjs';

const initialNow = Date.UTC(2026, 9, 7, 12);
const oldPassword = 'synthetic old password only', password = 'synthetic new password only';
const oldHash = await hashPassword(oldPassword);
const answer = 'synthetic reserved answer phrase', answerHash = await hashPassword(answer);
const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const recoveryCodes = () => {
  const salt = 'synthetic-password-test-salt';
  const codes = Array.from({ length: 8 }, (_, index) => Array(8).fill(String(index + 1).repeat(4)).join('-'));
  return { salt, codes, hashes: codes.map(code => digest(`${salt}:${code}`)) };
};
const profile = () => ({ version: 1, email: 'reserved@example.invalid', questionId: 'recovery-phrase', answerHash, emailVerifiedAt: initialNow - 1000 });
const body = (purpose = 'initial', extra = {}) => ({ password, purpose, ...extra });

async function fixture(options: any = {}) {
  const signer = options.signer ?? Wallet.createRandom(), state = { now: initialNow }, messages: any[] = [];
  const store = options.store ?? new MemoryCredentialStore(options.initial ?? {});
  let handler: any;
  const server = createServer((req, res) => handler(req, res)); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const accounts = [{ username: 'tester', wallets: [{ account: signer.address, chainId: '1' }],
    ...(options.withPassword ? { passwordHash: oldHash } : {}), caFingerprints: [] }];
  const restart = (nextStore = store) => { handler = createAuthService({ origin, tenant: 'xiongan', accounts, store: nextStore,
    sendOtp: async (message: any) => { messages.push(message); }, now: () => state.now }); };
  restart();
  const client = () => {
    let csrf = ''; const jar = new Map<string, string>();
    const call = async (path: string, value?: any, extra = {}) => {
      const response = await fetch(`${origin}/auth/${path}`, { method: value === undefined ? 'GET' : 'POST',
        headers: { Origin: origin, 'X-Wallet-Tenant': 'xiongan', 'X-Wallet-CSRF': csrf,
          Cookie: [...jar].map(([key, value]) => `${key}=${value}`).join('; '),
          ...(value === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra },
        ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
      for (const cookie of response.headers.getSetCookie()) { const [key, value] = cookie.split(';')[0]!.split('='); if (value) jar.set(key!, value); else jar.delete(key!); }
      const data: any = await response.json(); if (response.ok && (data.csrf || data.session?.csrf)) csrf = data.csrf ?? data.session.csrf;
      return { status: response.status, data };
    };
    const walletLogin = async (wallet = signer) => {
      await call('bootstrap'); const selected = { account: wallet.address, chainId: '1' };
      const challenge = (await call('challenge', { ...selected, method: 'wallet' })).data;
      const result = await call('proof', { ...selected, id: challenge.id, signature: await wallet.signMessage(challenge.message) });
      assert.equal(result.status, 200, JSON.stringify(result)); return result;
    };
    const passwordLogin = async (value = password, wallet = signer, username = 'tester') => {
      await call('bootstrap'); return call('password', { username, password: value, account: wallet.address, chainId: '1' });
    };
    return { call, walletLogin, passwordLogin };
  };
  const prove = async (c: ReturnType<typeof client>) => {
    const start = await c.call('recovery/reset/start', { answer }); assert.equal(start.status, 200, JSON.stringify(start));
    const confirmed = await c.call('recovery/reset/confirm', { challengeId: start.data.challengeId, code: messages.at(-1).code });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed)); return confirmed.data.resetProof;
  };
  return { signer, state, store, client, messages, prove, restart, accounts,
    close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

function gate() {
  let release!: () => void, entered!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  return { pending, started, release, entered };
}
class GatedStore extends MemoryCredentialStore {
  constructor(initial = {}) { super(initial); }
  transactionGate: ReturnType<typeof gate> | null = null;
  readGate: ReturnType<typeof gate> | null = null;
  holdTransaction() { return this.transactionGate = gate(); }
  holdRead() { return this.readGate = gate(); }
  async transaction(username: string, update: any) {
    const waiting = this.transactionGate; this.transactionGate = null;
    if (waiting) { waiting.entered(); await waiting.pending; }
    return super.transaction(username, update);
  }
  async read(username: string) {
    const waiting = this.readGate; this.readGate = null;
    const result = await super.read(username);
    if (waiting) { waiting.entered(); await waiting.pending; }
    return result;
  }
}

test('passwordless registered-wallet login can set its first password without nonexistent factors', async t => {
  const f = await fixture({ initial: { 'xiongan:tester': { revision: 3, enabledMethods: ['wallet'], unrelated: { preserved: true } } } }); t.after(f.close);
  const a = f.client(), b = f.client(); assert.equal((await a.call('capabilities')).data.passwordManagement, true);
  await a.walletLogin(); await b.walletLogin();
  assert.equal((await a.call('account')).data.methods.password.bound, false);
  const result = await a.call('account/password', body()); assert.deepEqual(result, { status: 200, data: { updated: true, loggedOut: true } });
  const saved = await f.store.read('xiongan:tester'); assert.equal(saved.revision, 4);
  assert.deepEqual(saved.enabledMethods, ['wallet', 'password']); assert.deepEqual(saved.unrelated, { preserved: true });
  assert.equal(await verifyPassword(password, saved.passwordHash), true); assert.doesNotMatch(JSON.stringify(saved), /synthetic new password/);
  assert.equal((await a.call('account')).status, 401); assert.equal((await b.call('account')).status, 401);
  assert.equal((await a.passwordLogin()).status, 200); const state = (await a.call('account')).data;
  assert.deepEqual(state.methods.password, { available: true, bound: true, enabled: true }); assert.equal(state.methods.wallet.enabled, true);
  assert.doesNotMatch(JSON.stringify(state), /passwordHash|synthetic new password/);
});

test('replacement overrides configured hash, preserves enabled methods, and revokes in-flight old-password login', async t => {
  const store = new GatedStore({ 'xiongan:tester': { revision: 0, enabledMethods: ['password', 'wallet'] } });
  const f = await fixture({ store, withPassword: true }); t.after(f.close);
  const a = f.client(), b = f.client(); await a.walletLogin(); await b.call('bootstrap');
  const held = store.holdRead(), oldLogin = b.call('password', { username: 'tester', password: oldPassword, account: f.signer.address, chainId: '1' });
  await held.started;
  assert.equal((await a.call('account/password', body('replace'))).status, 200);
  held.release(); assert.equal((await oldLogin).status, 401);
  assert.deepEqual((await store.read('xiongan:tester')).enabledMethods, ['password', 'wallet']);
  assert.equal((await a.passwordLogin(oldPassword)).status, 401); assert.equal((await a.passwordLogin()).status, 200);
});

test('replacing a disabled password preserves its disabled selection', async t => {
  const f = await fixture({ withPassword: true, initial: { 'xiongan:tester': { revision: 0, enabledMethods: ['wallet'] } } }); t.after(f.close);
  const c = f.client(); await c.walletLogin(); assert.equal((await c.call('account/password', body('replace'))).status, 200);
  assert.deepEqual((await f.store.read('xiongan:tester')).enabledMethods, ['wallet']);
  assert.equal((await c.passwordLogin()).status, 401); await c.walletLogin();
  assert.deepEqual((await c.call('account')).data.methods.password, { available: true, bound: true, enabled: false });
});

test('initial versus replacement purpose is explicit and cannot overwrite a changed state', async t => {
  for (const withPassword of [false, true]) {
    const f = await fixture({ withPassword }); t.after(f.close); const c = f.client(); await c.walletLogin();
    const result = await c.call('account/password', body(withPassword ? 'initial' : 'replace'));
    assert.equal(result.status, 409); assert.equal(result.data.error, 'AUTH_SETUP_STATE_CHANGED'); assert.equal(await f.store.read('xiongan:tester'), null);
  }
});

test('strict input, origin, CSRF and tenant reject account selectors or unauthenticated bootstrap', async t => {
  const f = await fixture(); t.after(f.close); const c = f.client(); await c.call('bootstrap');
  assert.equal((await c.call('account/password', body())).status, 401); await c.walletLogin();
  for (const headers of [{ Origin: 'https://evil.example.invalid' }, { 'X-Wallet-Tenant': 'other' }, { 'X-Wallet-CSRF': 'wrong' }]) {
    assert.equal((await c.call('account/password', body(), headers)).status, headers['X-Wallet-CSRF'] ? 401 : 403);
  }
  for (const value of [body('unknown'), body('initial', { password: 'short' }), body('initial', { password: '你'.repeat(342) }),
    body('initial', { username: 'other' }), body('initial', { account: f.signer.address }), body('initial', { recovery: 'true' }),
    body('initial', { resetProof: 'unbound' }), body('initial', { enabledMethods: ['password'] })]) {
    assert.equal((await c.call('account/password', value)).data.error, 'AUTH_PASSWORD_INPUT_REFUSED');
  }
  assert.equal(await f.store.read('xiongan:tester'), null);
});

test('existing TOTP is mandatory even when disabled; unused recovery code is consumed atomically', async t => {
  const recovery = recoveryCodes(), prior = { revision: 2, secret, lastStep: -1, recoverySalt: recovery.salt,
    recoveryHashes: recovery.hashes, enabledMethods: ['wallet'], unrelated: 'preserved' };
  const f = await fixture({ initial: { 'xiongan:tester': prior } }); t.after(f.close); const c = f.client(); await c.walletLogin();
  assert.equal((await c.call('account/password', body())).status, 401);
  assert.deepEqual(await f.store.read('xiongan:tester'), prior);
  assert.equal((await c.call('account/password', body('initial', { existingCode: recovery.codes[0], recovery: true }))).status, 200);
  const saved = await f.store.read('xiongan:tester'); assert.equal(saved.secret, secret); assert.equal(saved.recoveryHashes.length, 7);
  assert.equal(saved.lastStep, -1); assert.equal(saved.unrelated, 'preserved'); assert.deepEqual(saved.enabledMethods, ['wallet', 'password']);
  await c.walletLogin(); assert.equal((await c.call('account/password', body('replace', { existingCode: recovery.codes[0], recovery: true }))).status, 401);
  assert.equal((await c.call('account/password', body('replace', { existingCode: hotp(secret, Math.floor(f.state.now / 30000)) }))).status, 200);
  assert.equal((await f.store.read('xiongan:tester')).lastStep, Math.floor(f.state.now / 30000));
});

test('reserved reset proof plus existing factor is required for initial and replacement, and bound to its session', async t => {
  const recovery = recoveryCodes(), prior = { revision: 2, secret, lastStep: -1, recoverySalt: recovery.salt,
    recoveryHashes: recovery.hashes, recoveryProfile: profile(), enabledMethods: ['wallet'] };
  const f = await fixture({ initial: { 'xiongan:tester': prior } }); t.after(f.close);
  const a = f.client(), b = f.client(); await a.walletLogin(); await b.walletLogin();
  const existingCode = recovery.codes[0];
  assert.equal((await a.call('account/password', body('initial', { existingCode, recovery: true }))).status, 401);
  assert.deepEqual(await f.store.read('xiongan:tester'), prior);
  const resetProof = await f.prove(a);
  assert.equal((await b.call('account/password', body('initial', { existingCode, recovery: true, resetProof }))).status, 401);
  assert.equal((await a.call('account/password', body('initial', { existingCode: 'wrong', resetProof }))).status, 401);
  assert.deepEqual(await f.store.read('xiongan:tester'), prior);
  assert.equal((await a.call('account/password', body('initial', { existingCode, recovery: true, resetProof }))).status, 200);
  const saved = await f.store.read('xiongan:tester'); assert.deepEqual(saved.recoveryProfile, prior.recoveryProfile); assert.equal(saved.recoveryHashes.length, 7);
  await a.walletLogin();
  assert.equal((await a.call('account/password', body('replace', { existingCode: recovery.codes[1], recovery: true, resetProof }))).status, 401);
  f.state.now += 60000; const replacementProof = await f.prove(a);
  assert.equal((await a.call('account/password', body('replace', { existingCode: recovery.codes[1], recovery: true, resetProof: replacementProof }))).status, 200);
});

test('reserved factors without TOTP still require their reset proof, without inventing an old TOTP', async t => {
  const f = await fixture({ initial: { 'xiongan:tester': { revision: 1, recoveryProfile: profile() } } }); t.after(f.close);
  const c = f.client(); await c.walletLogin(); assert.equal((await c.call('account/password', body())).status, 401);
  const resetProof = await f.prove(c); assert.equal((await c.call('account/password', body('initial', { resetProof }))).status, 200);
});

test('TOTP-only sessions and stale independent sessions cannot manage passwords', async t => {
  const f = await fixture({ initial: { 'xiongan:tester': { revision: 1, secret, lastStep: -1, recoveryHashes: [] } } }); t.after(f.close);
  const c = f.client(); await c.call('bootstrap');
  assert.equal((await c.call('totp', { username: 'tester', account: f.signer.address, chainId: '1', code: hotp(secret, Math.floor(f.state.now / 30000)) })).status, 200);
  assert.equal((await c.call('account/password', body())).data.error, 'AUTH_RECENT_INDEPENDENT_LOGIN_REQUIRED');
  await c.walletLogin(); f.state.now += 300000;
  assert.equal((await c.call('account/password', body())).data.error, 'AUTH_RECENT_INDEPENDENT_LOGIN_REQUIRED');
  assert.equal((await f.store.read('xiongan:tester')).passwordHash, undefined);
});

test('logout, expiry, reversed time and changed credential revision win before password commit', async t => {
  for (const action of ['logout', 'expiry', 'reverse', 'revision']) {
    const store = new GatedStore(), f = await fixture({ store }); t.after(f.close); const c = f.client(); await c.walletLogin();
    const held = store.holdTransaction(), update = c.call('account/password', body()); await held.started;
    if (action === 'logout') assert.equal((await c.call('logout', {})).status, 200);
    if (action === 'expiry') f.state.now += 300000;
    if (action === 'reverse') f.state.now--;
    if (action === 'revision') await store.transaction('xiongan:tester', () => ({ revision: 8, unrelated: true }));
    held.release(); assert.notEqual((await update).status, 200);
    assert.deepEqual(await store.read('xiongan:tester'), action === 'revision' ? { revision: 8, unrelated: true } : null);
  }
});

test('concurrent password updates cannot overwrite a newer hash or credential revision', async t => {
  const store = new GatedStore(), f = await fixture({ store }); t.after(f.close);
  const a = f.client(), b = f.client(); await a.walletLogin(); await b.walletLogin();
  const held = store.holdTransaction(), first = a.call('account/password', body('initial', { password: 'synthetic losing password' })); await held.started;
  assert.equal((await b.call('account/password', body())).status, 200);
  held.release(); assert.equal((await first).status, 401);
  const saved = await store.read('xiongan:tester'); assert.equal(saved.revision, 1); assert.equal(await verifyPassword(password, saved.passwordHash), true);
});

test('encrypted password overrides survive restart with the same key for configured and ordinary accounts', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wallet-password-test-'));
  const key = Buffer.alloc(32, 29), path = join(directory, 'credentials.json'), ordinary = Wallet.createRandom();
  let store = await openEncryptedStore(path, key), running: any;
  t.after(async () => { await running?.close(); await store.close(); await rm(directory, { recursive: true, force: true }); });
  const registration = { version: 1, email: 'ordinary@example.invalid', verifiedAt: initialNow };
  await store.transactionMany(['@registration:xiongan', 'xiongan:ordinary-user'], () => ({
    '@registration:xiongan': { version: 1, records: [{ username: 'ordinary-user', email: registration.email, verifiedAt: initialNow,
      ordinaryAccount: { username: 'ordinary-user', passwordHash: oldHash, wallets: [{ account: ordinary.address, chainId: '1' }], caFingerprints: [] } }] },
    'xiongan:ordinary-user': { revision: 1, registration, enabledMethods: ['wallet', 'password'], unrelated: 'ordinary preserved' },
  }));
  const f = await fixture({ store, withPassword: true }); running = f;
  for (const wallet of [f.signer, ordinary]) { const c = f.client(); await c.walletLogin(wallet); assert.equal((await c.call('account/password', body('replace'))).status, 200); }
  const raw = await readFile(path, 'utf8'); assert.equal(JSON.parse(raw).version, 1); assert.doesNotMatch(raw, /passwordHash|synthetic|ordinary@example/);
  await store.close(); store = await openEncryptedStore(path, key); f.restart(store);
  for (const [wallet, username] of [[f.signer, 'tester'], [ordinary, 'ordinary@example.invalid']] as const) {
    const c = f.client(); assert.equal((await c.passwordLogin(oldPassword, wallet, username)).status, 401);
    assert.equal((await c.passwordLogin(password, wallet, username)).status, 200); assert.equal((await c.call('account')).data.methods.password.enabled, true);
  }
  assert.equal((await store.read('xiongan:ordinary-user')).unrelated, 'ordinary preserved');
  assert.equal((await store.read('@registration:xiongan')).records[0].ordinaryAccount.passwordHash, oldHash);
});

test('malformed persisted password cannot fall back to the previously configured password', async t => {
  const f = await fixture({ withPassword: true, initial: { 'xiongan:tester': { revision: 1, passwordHash: 'corrupt' } } }); t.after(f.close);
  const result = await f.client().passwordLogin(oldPassword); assert.equal(result.status, 503); assert.equal(result.data.error, 'AUTH_PASSWORD_STATE_REFUSED');
});
