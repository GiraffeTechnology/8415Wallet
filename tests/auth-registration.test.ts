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
import { hashPassword, hotp, digest } from '../server/crypto.mjs';

const password = 'synthetic-registration-password', hash = await hashPassword(password);
const answer = 'synthetic reserved answer phrase', answerHash = await hashPassword(answer);
const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const initialNow = Date.UTC(2026, 9, 6, 14);
async function fixture(options: any = {}) {
  const signer = Wallet.createRandom(), state = { now: initialNow }, messages: any[] = [];
  const store = options.store ?? new MemoryCredentialStore(options.initial ?? {});
  let handler: any;
  const server = createServer((req, res) => handler(req, res)); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const accounts = [{ username: 'legacy-user', passwordHash: hash, wallets: [{ account: signer.address, chainId: '1' }], caFingerprints: ['a'.repeat(64)] }];
  const restart = (nextStore = store, extra = {}) => { handler = createAuthService({ origin, tenant: 'xiongan', accounts, store: nextStore,
    sendOtp: options.noMail ? null : options.sendOtp ?? (async (message: any) => { messages.push(message); }), now: () => state.now, ...extra }); };
  restart();
  const client = () => {
    let csrf = ''; const jar = new Map<string, string>();
    const call = async (path: string, body?: any, extra = {}) => {
      const response = await fetch(`${origin}/auth/${path}`, { method: body === undefined ? 'GET' : 'POST',
        headers: { Origin: origin, 'X-Wallet-Tenant': 'xiongan', 'X-Wallet-CSRF': csrf,
          Cookie: [...jar].map(([key, value]) => `${key}=${value}`).join('; '), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      for (const cookie of response.headers.getSetCookie()) { const [key, value] = cookie.split(';')[0]!.split('='); if (value) jar.set(key!, value); else jar.delete(key!); }
      const data: any = await response.json(); if (response.ok && (data.csrf || data.session?.csrf)) csrf = data.csrf ?? data.session.csrf;
      return { status: response.status, data };
    };
    const login = () => call('password', { username: 'legacy-user', password, account: signer.address, chainId: '1' });
    return { call, login };
  };
  const begin = async (c: ReturnType<typeof client>, email = 'New.User@example.invalid', wallet = Wallet.createRandom()) => {
    const bootstrap = (await c.call('bootstrap')).data;
    const start = await c.call('registration/start', { email }); assert.equal(start.status, 200, JSON.stringify(start));
    const code = messages.findLast(message => message.to === email.replace(/@(.+)$/, (_match, host) => `@${host.toLowerCase()}`))?.code;
    const verified = await c.call('registration/verify', { challengeId: start.data.challengeId, code }); assert.equal(verified.status, 200, JSON.stringify(verified));
    const selected = { account: wallet.address, chainId: '1' }, registrationId = verified.data.registrationId;
    const challenge = await c.call('registration/challenge', { ...selected, registrationId }); assert.equal(challenge.status, 200, JSON.stringify(challenge));
    const body = { ...selected, registrationId, id: challenge.data.id, signature: await wallet.signMessage(challenge.data.message) };
    return { body, wallet, start: start.data, verified: verified.data, challenge: challenge.data, code, bootstrap };
  };
  return { client, signer, state, store, messages, begin, origin, accounts, restart, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

// Prepare an exact management change, including explicit independent proof and fresh email OTP.
async function prepareChange(f: any, c: any, intent: any, factors: any = {}, wallet = f.signer) {
  const start = await c.call('account/change/start', intent); assert.equal(start.status, 200, JSON.stringify(start));
  const independent = start.data.factor === 'wallet' ? { signature: await wallet.signMessage(start.data.message) } : { originalPassword: password };
  const verified = await c.call('account/change/verify', { changeId: start.data.changeId, ...independent, ...factors }); assert.equal(verified.status, 200, JSON.stringify(verified));
  const proof = await c.call('account/change/confirm', { changeId: start.data.changeId, code: f.messages.at(-1).code }); assert.equal(proof.status, 200, JSON.stringify(proof));
  return { ...proof.data, ...(proof.data.newEmailRequired ? { newEmailCode: f.messages.at(-1).code } : {}) };
}
const applyChange = (c: any, proof: any) => c.call('account/change/commit', { changeProof: proof.changeProof, ...(proof.newEmailRequired ? { newEmailCode: proof.newEmailCode } : {}) });

test('signup requires verified email and purpose-bound EOA proof and creates only an ordinary account', async t => {
  const f = await fixture(); t.after(f.close); const c = f.client();
  assert.deepEqual((await c.call('capabilities')).data.registration, { available: true, emailRequired: true });
  assert.equal((await c.call('registration/start', { email: 'new@example.invalid' })).status, 403);
  const pending = await f.begin(c);
  assert.equal(f.messages[0].purpose, 'registration'); assert.match(pending.challenge.message, /purpose:registration/);
  assert.match(pending.challenge.message, /No administrator or tenant-management authority/);
  assert.match(pending.challenge.message, /tenant:xiongan/); assert.match(pending.challenge.message, /Chain ID: 1/);
  assert.equal((await c.call('account')).status, 401);
  const result = await c.call('registration/confirm', { ...pending.body, password }); assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(result.data.registered, true); assert.equal(result.data.session.kind, 'wallet');
  const state = (await c.call('account')).data;
  assert.deepEqual(state.registration, { required: false, complete: true, email: 'New.User@example.invalid', emailMasked: 'N***@example.invalid', emailOtpAvailable: true });
  assert.equal(state.methods.password.enabled, true); assert.equal(state.methods.ca.bound, false);
  const directory = await f.store.read('@registration:xiongan'), record = directory.records[0];
  assert.deepEqual(Object.keys(record.ordinaryAccount).sort(), ['caFingerprints', 'passwordHash', 'username', 'wallets']);
  assert.match(record.ordinaryAccount.passwordHash, /^scrypt-v1\$/); assert.equal(record.ordinaryAccount.passwordHash.includes(password), false);
  assert.equal((await c.call('registration/confirm', pending.body)).status, 403); // session CSRF cannot stand in for preauth
  await c.call('logout', {}); await c.call('bootstrap');
  assert.equal((await c.call('password', { username: 'new.user@EXAMPLE.INVALID', password, ...pending.body, signature: undefined })).status, 200);
});

test('email OTP alone never logs in, and privileged/account selectors are refused', async t => {
  const f = await fixture(); t.after(f.close); const c = f.client(); await c.call('bootstrap');
  for (const extra of [{ role: 'admin' }, { tenant: 'other' }, { username: 'operator' }, { caFingerprints: ['b'.repeat(64)] }]) {
    assert.equal((await c.call('registration/start', { email: 'x@example.invalid', ...extra })).status, 400);
  }
  const start = (await c.call('registration/start', { email: 'x@example.invalid' })).data;
  assert.equal((await c.call('registration/challenge', { registrationId: start.challengeId, account: f.signer.address, chainId: '1' })).status, 401);
  const verified = await c.call('registration/verify', { challengeId: start.challengeId, code: f.messages[0].code }); assert.equal(verified.status, 200);
  assert.equal((await c.call('session')).status, 401);
  assert.equal((await c.call('email', { code: f.messages[0].code, account: f.signer.address, chainId: '1' })).status, 404);
  assert.equal((await c.call('registration/verify', { challengeId: start.challengeId, code: f.messages[0].code })).status, 401);
});

test('wallet proof rejects wrong origin, tenant, chain, address, login-purpose signature and replay', async t => {
  const f = await fixture(); t.after(f.close);
  for (const fault of ['chain', 'address', 'signature', 'origin', 'tenant']) {
    const c = f.client(), pending = await f.begin(c, `${fault}@example.invalid`);
    const body: any = { ...pending.body }, headers: any = {};
    if (fault === 'chain') body.chainId = '8453';
    if (fault === 'address') body.account = Wallet.createRandom().address;
    if (fault === 'signature') body.signature = await pending.wallet.signMessage(pending.challenge.message.replace('purpose:registration', 'purpose:login'));
    if (fault === 'origin') headers.Origin = 'https://evil.example.invalid';
    if (fault === 'tenant') headers['X-Wallet-Tenant'] = 'other';
    assert.notEqual((await c.call('registration/confirm', body, headers)).status, 200);
  }
  assert.equal(await f.store.read('@registration:xiongan'), null);
});

test('OTP attempts, expiry, clock reversal, wrong browser, cancelled and superseded flows fail closed', async t => {
  const f = await fixture(); t.after(f.close); const c = f.client(), other = f.client(); await c.call('bootstrap'); await other.call('bootstrap');
  const start = (await c.call('registration/start', { email: 'otp@example.invalid' })).data;
  const body = { challengeId: start.challengeId, code: f.messages[0].code };
  assert.notEqual((await other.call('registration/verify', body)).status, 200);
  for (let n = 0; n < 5; n++) assert.equal((await c.call('registration/verify', { ...body, code: 'wrong' })).status, 401);
  assert.notEqual((await c.call('registration/verify', body)).status, 200);
  for (const reason of ['cancel', 'bootstrap', 'logout', 'expiry', 'reverse']) {
    const d = f.client(), flow = await f.begin(d, `${reason}@example.invalid`);
    if (reason === 'cancel') await d.call('registration/cancel', {});
    if (reason === 'bootstrap') await d.call('bootstrap');
    if (reason === 'logout') await d.call('logout', {});
    if (reason === 'expiry') f.state.now = flow.challenge.expiresAt;
    if (reason === 'reverse') f.state.now--;
    assert.notEqual((await d.call('registration/confirm', flow.body)).status, 200);
    f.state.now += 60000;
  }
});

test('concurrent confirmations create one record; case variants and duplicate configured/dynamic wallet bindings cannot register', async t => {
  const f = await fixture(); t.after(f.close); const a = f.client(), flow = await f.begin(a);
  const results = await Promise.all([a.call('registration/confirm', flow.body), a.call('registration/confirm', flow.body)]);
  assert.equal(results.filter(result => result.status === 200).length, 1);
  f.state.now += 60000;
  const duplicateEmail = f.client(), emailFlow = await f.begin(duplicateEmail, 'new.user@EXAMPLE.INVALID');
  assert.equal((await duplicateEmail.call('registration/confirm', emailFlow.body)).status, 401);
  const configured = f.client(), configuredFlow = await f.begin(configured, 'configured@example.invalid', f.signer);
  assert.equal((await configured.call('registration/confirm', configuredFlow.body)).status, 401);
  const dynamic = f.client(), dynamicFlow = await f.begin(dynamic, 'dynamic@example.invalid', flow.wallet);
  assert.equal((await dynamic.call('registration/confirm', dynamicFlow.body)).status, 401);
  assert.equal((await f.store.read('@registration:xiongan')).records.length, 1);
});

test('different browsers racing the same verified email or wallet cannot overwrite an ordinary account', async t => {
  const f = await fixture(); t.after(f.close);
  const a = f.client(), first = await f.begin(a, 'race@example.invalid'); f.state.now += 60000;
  const b = f.client(), second = await f.begin(b, 'RACE@example.invalid');
  const emails = await Promise.all([a.call('registration/confirm', first.body), b.call('registration/confirm', second.body)]);
  assert.equal(emails.filter(result => result.status === 200).length, 1);
  const wallet = Wallet.createRandom(), c = f.client(), third = await f.begin(c, 'third@example.invalid', wallet);
  const d = f.client(), fourth = await f.begin(d, 'fourth@example.invalid', wallet);
  const wallets = await Promise.all([c.call('registration/confirm', third.body), d.call('registration/confirm', fourth.body)]);
  assert.equal(wallets.filter(result => result.status === 200).length, 1);
  assert.equal((await f.store.read('@registration:xiongan')).records.length, 2);
});

test('legacy migration preserves wallet/password/CA/TOTP/recovery/method state and revokes sessions', async t => {
  const savedCode = '1111-2222-3333-4444-5555-6666-7777-8888';
  const initial = { revision: 7, secret, lastStep: -1, recoverySalt: 'synthetic-salt', recoveryHashes: [digest(`synthetic-salt:${savedCode}`)],
    enabledMethods: ['password', 'wallet', 'totp'], unrelated: { journal: 'preserved' }, recoveryProfile: { version: 1,
      email: 'old@example.invalid', emailVerifiedAt: initialNow - 1, questionId: 'recovery-phrase', answerHash } };
  const f = await fixture({ initial: { 'xiongan:legacy-user': initial } }); t.after(f.close);
  const c = f.client(), other = f.client(); await c.call('bootstrap'); await c.login(); await other.call('bootstrap'); await other.login();
  assert.equal((await c.call('account')).data.registration.required, true);
  assert.equal((await c.call('registration/email/start', { email: 'migrated@example.invalid' })).data.error, 'AUTH_CHANGE_FLOW_REQUIRED');
  const proof = await prepareChange(f, c, { action: 'email.initial', email: 'migrated@example.invalid' }, { existingCode: savedCode, recovery: true, existingAnswer: answer });
  assert.deepEqual(f.messages.map((message: any) => message.to), ['old@example.invalid', 'migrated@example.invalid']);
  assert.equal((await applyChange(c, proof)).status, 200);
  const saved = await f.store.read('xiongan:legacy-user');
  assert.equal(saved.secret, secret); assert.equal(saved.revision, 8); assert.deepEqual(saved.unrelated, initial.unrelated);
  assert.deepEqual(saved.enabledMethods, initial.enabledMethods); assert.deepEqual(saved.recoveryHashes, []);
  assert.equal(saved.recoveryProfile.answerHash, answerHash); assert.equal(saved.recoveryProfile.email, 'migrated@example.invalid');
  assert.equal((await other.call('session')).status, 401);
  await c.call('bootstrap'); assert.equal((await c.login()).status, 200); assert.equal((await c.call('account')).data.methods.ca.bound, true);
});

test('migration without reserved factors requires a new independent proof; TOTP alias remains server verified', async t => {
  const f = await fixture({ initial: { 'xiongan:legacy-user': { revision: 1, secret, lastStep: -1, recoveryHashes: [] } } }); t.after(f.close);
  const c = f.client(); await c.call('bootstrap'); await c.login();
  const proof = await prepareChange(f, c, { action: 'email.initial', email: 'legacy@example.invalid' }, { existingCode: hotp(secret, Math.floor(f.state.now / 30000)) });
  assert.equal((await applyChange(c, proof)).status, 200);
  f.state.now += 30000; await c.call('bootstrap');
  assert.equal((await c.call('totp', { username: 'LEGACY@EXAMPLE.INVALID', account: f.signer.address, chainId: '1', code: hotp(secret, Math.floor(f.state.now / 30000)) })).status, 200);
  assert.equal((await c.call('account/change/start', { action: 'email.replace', email: 'new@example.invalid' })).status, 403);
});

test('registration and recovery email stay coherent and reset never accepts a new recipient', async t => {
  const f = await fixture(); t.after(f.close); const c = f.client(), flow = await f.begin(c);
  assert.equal((await c.call('registration/confirm', flow.body)).status, 200);
  const body = { action: 'recovery.initial', email: 'different@example.invalid', questionId: 'recovery-phrase', answer };
  assert.equal((await c.call('account/change/start', body)).data.error, 'AUTH_REGISTRATION_EMAIL_MISMATCH');
  const proof = await prepareChange(f, c, { ...body, email: 'New.User@example.invalid' }, {}, flow.wallet);
  assert.equal((await applyChange(c, proof)).status, 200);
  await c.call('bootstrap'); const challenge = (await c.call('challenge', { account: flow.wallet.address, chainId: '1', method: 'wallet' })).data;
  await c.call('proof', { account: flow.wallet.address, chainId: '1', id: challenge.id, signature: await flow.wallet.signMessage(challenge.message) });
  assert.equal((await c.call('recovery/reset/start', { answer, email: 'attacker@example.invalid' })).status, 400);
  const pending = (await c.call('account/change/start', { action: 'email.replace', email: 'new-address@example.invalid' })).data;
  assert.notEqual((await c.call('account/change/verify', { changeId: pending.changeId })).status, 200);
});

test('old encrypted v1 credentials and newly registered directory survive restart without rekey or plaintext', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'registration-store-')); let reopened: any;
  t.after(async () => { await reopened?.close(); await rm(folder, { recursive: true, force: true }); });
  const path = join(folder, 'state.enc'), key = Buffer.alloc(32, 19), store = await openEncryptedStore(path, key);
  await store.transaction('xiongan:legacy-user', () => ({ revision: 4, unrelated: { retained: true } }));
  const f = await fixture({ store }); t.after(f.close); const c = f.client(), flow = await f.begin(c, 'persisted@example.invalid');
  const done = await c.call('registration/confirm', { ...flow.body, password }); assert.equal(done.status, 200);
  const raw = await readFile(path, 'utf8'); assert.equal(JSON.parse(raw).version, 1); assert.doesNotMatch(raw, /persisted@example|user-|passwordHash|unrelated/);
  await store.close(); reopened = await openEncryptedStore(path, key); f.restart(reopened);
  assert.deepEqual((await reopened.read('xiongan:legacy-user')).unrelated, { retained: true });
  const d = f.client(); await d.call('bootstrap');
  assert.equal((await d.call('password', { username: 'PERSISTED@example.invalid', password, account: flow.wallet.address, chainId: '1' })).status, 200);
  assert.equal((await c.call('session')).status, 401);
});

test('invalid directory and configured/dynamic collisions fail closed, without replacing existing store data', async t => {
  for (const raw of [{ version: 9, records: [] }, { version: 1, records: [{}] }, { version: 1, records: [], admin: true }]) {
    const store = new MemoryCredentialStore({ '@registration:xiongan': raw }), f = await fixture({ store }); t.after(f.close);
    assert.equal((await f.client().call('capabilities')).status, 503); assert.deepEqual(await store.read('@registration:xiongan'), raw);
  }
  const f = await fixture(); t.after(f.close); const c = f.client(), flow = await f.begin(c);
  const result = await c.call('registration/confirm', flow.body); assert.equal(result.status, 200);
  f.restart(f.store, { accounts: [...f.accounts, { username: 'collision', wallets: [{ account: flow.wallet.address, chainId: '1' }] }] });
  assert.equal((await f.client().call('capabilities')).status, 503);
});

test('email transport unavailable fails closed and unauthenticated account-state lookup is refused', async t => {
  const f = await fixture({ noMail: true }); t.after(f.close); const c = f.client();
  assert.equal((await c.call('capabilities')).data.registration.available, false); await c.call('bootstrap');
  assert.equal((await c.call('registration/start', { email: 'new@example.invalid' })).data.error, 'AUTH_EMAIL_UNAVAILABLE');
  assert.equal((await c.call('registration/email/start', { email: 'new@example.invalid' })).status, 401);
  assert.equal((await c.call('account')).status, 401); assert.equal(f.messages.length, 0);
});

function gate() {
  let release!: () => void, entered!: () => void;
  return { waiting: new Promise<void>(resolve => { release = resolve; }), started: new Promise<void>(resolve => { entered = resolve; }), release: () => release(), entered: () => entered() };
}
class DelayedStore extends MemoryCredentialStore {
  beforeCommit: ReturnType<typeof gate> | null = null; persisting: ReturnType<typeof gate> | null = null; nextRead: ReturnType<typeof gate> | null = null;
  async read(key: string) {
    const hold = this.nextRead; this.nextRead = null; const result = await super.read(key);
    if (hold) { hold.entered(); await hold.waiting; } return result;
  }
  async transactionMany(keys: string[], update: any) {
    const hold = this.beforeCommit; this.beforeCommit = null;
    if (hold) { hold.entered(); await hold.waiting; }
    return super.transactionMany(keys, update);
  }
  async persist(data: any) {
    const hold = this.persisting; this.persisting = null;
    if (hold) { hold.entered(); await hold.waiting; }
    return super.persist(data);
  }
}

test('cancel/logout during mail, queued commit, or persisted commit cannot auto-login a dismissed signup', async t => {
  const mailGate = gate(), messages: any[] = [];
  const mailed = await fixture({ sendOtp: async (message: any) => { messages.push(message); mailGate.entered(); await mailGate.waiting; } }); t.after(mailed.close);
  const c = mailed.client(); await c.call('bootstrap'); const sending = c.call('registration/start', { email: 'late@example.invalid' });
  await mailGate.started; await c.call('registration/cancel', {}); mailGate.release(); assert.notEqual((await sending).status, 200);
  for (const durable of [false, true]) {
    const store = new DelayedStore(), f = await fixture({ store }); t.after(f.close); const d = f.client(), flow = await f.begin(d);
    const hold = gate(); if (durable) store.persisting = hold; else store.beforeCommit = hold;
    const confirming = d.call('registration/confirm', flow.body); await hold.started;
    const cancel = await d.call('registration/cancel', {}); assert.equal(cancel.data.confirmationInProgress, durable);
    hold.release(); assert.notEqual((await confirming).status, 200); assert.equal((await d.call('session')).status, 401);
    assert.equal(Boolean(await store.read('@registration:xiongan')), durable);
  }
});

test('atomic directory/credential commit failures preserve old state and leave the store unhealthy', async () => {
  class FailedStore extends MemoryCredentialStore { constructor(data: any) { super(data); } async persist() { throw new Error('synthetic storage failure'); } }
  const store = new FailedStore({ old: { value: 1 } });
  await assert.rejects(store.transactionMany(['directory', 'credential'], () => ({ directory: { x: 1 }, credential: { revision: 1 } })), /storage failure/);
  await assert.rejects(store.read('old'), /UNHEALTHY/);
  const healthy = new MemoryCredentialStore({ old: { value: 1 } });
  await assert.rejects(healthy.transactionMany(['old', 'new'], () => { throw new Error('abort'); }), /abort/);
  assert.deepEqual(await healthy.read('old'), { value: 1 }); assert.equal(await healthy.read('new'), null);
});

test('store capacity refuses oversize before persistence, preserving old usable credentials and restart', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'registration-capacity-')), path = join(folder, 'state.enc'), key = Buffer.alloc(32, 21);
  let store = await openEncryptedStore(path, key);
  t.after(async () => { await store.close(); await rm(folder, { recursive: true, force: true }); });
  await store.transaction('legacy', () => ({ revision: 4, retained: true }));
  const before = await readFile(path, 'utf8');
  await assert.rejects(store.transactionMany(['directory', 'new-user'], () => ({ directory: { oversized: 'x'.repeat(4 * 1024 * 1024) }, 'new-user': { revision: 1 } })), /CAPACITY/);
  assert.equal(await readFile(path, 'utf8'), before); assert.deepEqual(await store.read('legacy'), { revision: 4, retained: true });
  await store.transaction('legacy', (prior: any) => ({ ...prior, revision: 5 })); await store.close(); store = await openEncryptedStore(path, key);
  assert.equal((await store.read('legacy')).revision, 5); assert.equal(await store.read('new-user'), null);
});

test('competing legacy migrations and signup cannot claim the same tenant email or stale account revision', async t => {
  const f = await fixture(); t.after(f.close);
  const a = f.client(), b = f.client(); await a.call('bootstrap'); await a.login(); await b.call('bootstrap'); await b.login();
  const first = await prepareChange(f, a, { action: 'email.initial', email: 'first-legacy@example.invalid' });
  const second = await prepareChange(f, b, { action: 'email.initial', email: 'second-legacy@example.invalid' });
  const outcomes = await Promise.all([applyChange(a, first), applyChange(b, second)]);
  assert.equal(outcomes.filter(result => result.status === 200).length, 1); assert.equal((await f.store.read('@registration:xiongan')).records.length, 1);
  const g = await fixture(); t.after(g.close); const signup = g.client(), flow = await g.begin(signup, 'mixed-race@example.invalid');
  const migrating = g.client(); await migrating.call('bootstrap'); await migrating.login();
  const migration = await prepareChange(g, migrating, { action: 'email.initial', email: 'MIXED-RACE@example.invalid' });
  const race = await Promise.all([signup.call('registration/confirm', flow.body), applyChange(migrating, migration)]);
  assert.equal(race.filter(result => result.status === 200).length, 1); assert.equal((await g.store.read('@registration:xiongan')).records.length, 1);
});

test('email replacement verifies old reserved answer/email and new email, atomically moving alias and recovery recipient', async t => {
  const f = await fixture(); t.after(f.close); const c = f.client(), flow = await f.begin(c, 'before@example.invalid');
  const created = await c.call('registration/confirm', { ...flow.body, password }); assert.equal(created.status, 200);
  const reserved = await prepareChange(f, c, { action: 'recovery.initial', email: 'before@example.invalid', questionId: 'recovery-phrase', answer });
  assert.equal((await applyChange(c, reserved)).status, 200);
  await c.call('bootstrap'); assert.equal((await c.call('password', { username: 'before@example.invalid', password, account: flow.wallet.address, chainId: '1' })).status, 200);
  const offset = f.messages.length, proof = await prepareChange(f, c, { action: 'email.replace', email: 'after@example.invalid' }, { existingAnswer: answer });
  assert.deepEqual(f.messages.slice(offset).map((message: any) => message.to), ['before@example.invalid', 'after@example.invalid']);
  assert.equal((await applyChange(c, proof)).status, 200);
  const credential = await f.store.read(`xiongan:${created.data.session.username}`);
  assert.equal(credential.registration.email, 'after@example.invalid'); assert.equal(credential.recoveryProfile.email, 'after@example.invalid');
  await c.call('bootstrap'); assert.equal((await c.call('password', { username: 'before@example.invalid', password, account: flow.wallet.address, chainId: '1' })).status, 401);
  assert.equal((await c.call('password', { username: 'after@example.invalid', password, account: flow.wallet.address, chainId: '1' })).status, 200);
  const again = await c.call('recovery/reset/start', { answer }); assert.equal(again.status, 200); assert.equal(f.messages.at(-1).to, 'after@example.invalid');
});

test('migration cancellation/revocation prevents queued writes and never erases prior credentials', async t => {
  for (const action of ['account/change/cancel', 'logout']) {
    const store = new DelayedStore(), f = await fixture({ store }); t.after(f.close); const c = f.client(); await c.call('bootstrap'); await c.login();
    const proof = await prepareChange(f, c, { action: 'email.initial', email: 'cancel-migration@example.invalid' });
    const hold = gate(); store.beforeCommit = hold; const confirming = applyChange(c, proof);
    await hold.started; await c.call(action, {}); hold.release(); assert.notEqual((await confirming).status, 200);
    assert.equal(await store.read('@registration:xiongan'), null); assert.equal((await store.read('xiongan:legacy-user'))?.registration, undefined);
  }
});

test('registration mail has bounded attempts, consistent existing-email starts and no delivery retry after failures', async t => {
  const f = await fixture(); t.after(f.close); const c = f.client(); await c.call('bootstrap');
  assert.equal((await c.call('registration/start', { email: 'bounded@example.invalid' })).status, 200);
  assert.equal((await c.call('registration/start', { email: 'BOUNDED@example.invalid' })).status, 429);
  for (let n = 1; n < 4; n++) { f.state.now += 60000; assert.equal((await c.call('registration/start', { email: 'bounded@example.invalid' })).status, 200); }
  f.state.now += 60000; assert.equal((await c.call('registration/start', { email: 'bounded@example.invalid' })).status, 429); assert.equal(f.messages.length, 4);
  let sends = 0; const failed = await fixture({ sendOtp: async () => { sends++; throw new Error('private SMTP detail'); } }); t.after(failed.close);
  const d = failed.client(); await d.call('bootstrap');
  assert.deepEqual((await d.call('registration/start', { email: 'fail@example.invalid' })).data, { error: 'AUTH_EMAIL_UNAVAILABLE' }); assert.equal(sends, 1);
});

test('ordinary-account capacity refuses additional signup without changing existing accounts or blocking legacy login', async t => {
  const records: any[] = [], initial: Record<string, any> = {};
  for (let i = 0; i < 1000; i++) {
    const username = `synthetic-${i}`, email = `capacity-${i}@example.invalid`, registration = { version: 1, email, verifiedAt: initialNow - 1 };
    records.push({ username, email, verifiedAt: registration.verifiedAt, ordinaryAccount: { username, caFingerprints: [],
      wallets: [{ account: `0x${(i + 1).toString(16).padStart(40, '0')}`, chainId: '1' }] } });
    initial[`xiongan:${username}`] = { revision: 1, registration };
  }
  initial['@registration:xiongan'] = { version: 1, records };
  const f = await fixture({ initial }); t.after(f.close); const c = f.client(), flow = await f.begin(c);
  assert.equal((await c.call('registration/confirm', flow.body)).status, 503);
  assert.equal((await f.store.read('@registration:xiongan')).records.length, 1000);
  const legacy = f.client(); await legacy.call('bootstrap'); assert.equal((await legacy.login()).status, 200);
  assert.equal((await legacy.call('account')).data.registration.required, true);
});

test('partial registration state is refused on restart before any account can authenticate', async t => {
  const f = await fixture({ initial: { 'xiongan:legacy-user': { revision: 1,
    registration: { version: 1, email: 'orphan@example.invalid', verifiedAt: initialNow - 1 } } } }); t.after(f.close);
  assert.equal((await f.client().call('capabilities')).status, 503);
  const g = await fixture(); t.after(g.close); const c = g.client(), flow = await g.begin(c);
  const result = await c.call('registration/confirm', flow.body); assert.equal(result.status, 200);
  await g.store.transaction(`xiongan:${result.data.session.username}`, (prior: any) => ({ ...prior, registration: undefined }));
  g.restart(); assert.equal((await g.client().call('capabilities')).status, 503);
});

test('cancel between durable account commit and session issuance prevents a late session; preauth can revoke an issued signup session', async t => {
  const store = new DelayedStore(), f = await fixture({ store }); t.after(f.close); const c = f.client(), flow = await f.begin(c);
  const hold = gate(); store.nextRead = hold;
  const confirming = c.call('registration/confirm', flow.body); await hold.started;
  assert.equal((await store.read('@registration:xiongan')).records.length, 1);
  assert.equal((await c.call('registration/cancel', {})).data.confirmationInProgress, true);
  hold.release(); assert.notEqual((await confirming).status, 200); assert.equal((await c.call('session')).status, 401);
  const d = f.client(), second = await f.begin(d, 'issued@example.invalid');
  assert.equal((await d.call('registration/confirm', second.body)).status, 200);
  assert.equal((await d.call('session')).status, 200);
  assert.equal((await d.call('registration/cancel', {}, { 'X-Wallet-CSRF': second.bootstrap.csrf })).status, 200);
  assert.equal((await d.call('session')).status, 401);
});

test('signup cancellation remains available after the operation rate budget is exhausted', async t => {
  const f = await fixture(); t.after(f.close); const c = f.client(), flow = await f.begin(c);
  for (let i = 0; i < 100; i++) await c.call('registration/challenge', { registrationId: flow.body.registrationId, account: flow.wallet.address, chainId: '1' });
  assert.equal((await c.call('registration/challenge', { registrationId: flow.body.registrationId, account: flow.wallet.address, chainId: '1' })).status, 429);
  assert.deepEqual((await c.call('registration/cancel', {})).data, { cancelled: true, confirmationInProgress: false });
  assert.equal(await f.store.read('@registration:xiongan'), null);
});
