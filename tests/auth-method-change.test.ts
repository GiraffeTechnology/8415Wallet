/** Synthetic identities only. No production credentials or email are accessed. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet } from 'ethers';
import { MemoryCredentialStore, openEncryptedStore } from '../server/store.mjs';
import { verifyPassword, hotp } from '../server/crypto.mjs';
import { NOW, OLD, NEW, ANSWER, SECRET, EMAIL, savedRecovery, profile, initial, fixture, commit } from './helpers/method-change-fixture.ts';

test('legacy mutation paths fail closed with explicit migration error; login and account status survive', async t => {
  const f = await fixture(); t.after(f.close); const c = f.client(); await c.login();
  for (const route of ['account/password', 'account/methods', 'totp/enroll/start', 'totp/enroll/confirm', 'recovery/enroll/start', 'registration/email/start']) {
    const response = await c.call(route, {}); assert.equal(response.status, 409); assert.equal(response.data.error, 'AUTH_CHANGE_FLOW_REQUIRED');
  }
  assert.equal((await c.call('session')).status, 200); const account = (await c.call('account')).data;
  assert.equal(account.methodChange.factor, 'password'); assert.equal(account.methodChange.trustedDeviceSupported, false);
});
test('session, OTP, generic reset proof and absent original-password verification cannot authorize a change', async t => {
  const f = await fixture(); t.after(f.close); const c = f.client(); await c.login(); const before = await f.store.read('xiongan:tester');
  const start = (await c.call('account/change/start', { action: 'password.replace', newPassword: NEW })).data;
  assert.equal(start.secret, undefined); assert.equal((await c.call('account/change/confirm', { changeId: start.changeId, code: '00000000' })).status, 403);
  assert.equal((await c.call('account/change/verify', { changeId: start.changeId })).status, 403);
  assert.equal((await commit(c, { changeProof: 'generic-reset-proof' })).status, 403);
  assert.equal(f.messages.length, 0); assert.deepEqual(await f.store.read('xiongan:tester'), before);
});
test('old password plus fresh verified-email OTP commits once and revokes every session', async t => {
  const f = await fixture(); t.after(f.close); const c = f.client(), other = f.client(); await c.login(); await other.login();
  const proof = await f.authorize(c, { action: 'password.replace', newPassword: NEW });
  assert.equal(f.messages.length, 1); assert.equal(f.messages[0].to, EMAIL); assert.equal(f.messages[0].purpose, 'method-change');
  assert.equal((await f.store.read('xiongan:tester')).passwordHash, undefined);
  assert.deepEqual((await Promise.all([commit(c, proof), commit(c, proof)])).map(r => r.status).sort(), [200, 401]);
  const after = await f.store.read('xiongan:tester'); assert.equal(after.revision, 2); assert.equal(await verifyPassword(NEW, after.passwordHash), true);
  assert.equal((await other.call('session')).status, 401); assert.equal((await c.call('session')).status, 401);
});
test('passwordless initial TOTP uses fresh exact wallet proof and prior-email OTP, then verifies new code', async t => {
  const f = await fixture({ passwordless: true }); t.after(f.close); const c = f.client(); await c.login();
  const proof = await f.authorize(c, { action: 'totp.initial' }); assert.match(proof.uri, /^otpauth:\/\/totp/);
  assert.deepEqual((await c.call('account')).data.authenticator, { enrolled: false, pending: true, expiresAt: proof.expiresAt, replacement: false });
  assert.equal((await f.store.read('xiongan:tester')).secret, undefined); assert.equal((await commit(c, proof, { code: 'bad' })).status, 403);
  const result = await commit(c, proof, { code: hotp(proof.secret, Math.floor(NOW / 30000)) });
  assert.equal(result.status, 200); assert.equal(result.data.recoveryCodes.length, 8); assert.equal((await f.store.read('xiongan:tester')).secret, proof.secret);
});
test('first password does not demand nonexistent password or TOTP; lost-password recovery can explicitly use bound wallet', async t => {
  for (const passwordless of [true, false]) {
    const f = await fixture({ passwordless }); t.after(f.close); const c = f.client(); await c.login();
    const proof = await f.authorize(c, { action: passwordless ? 'password.initial' : 'password.replace', newPassword: NEW, identityMethod: 'wallet' });
    assert.equal((await commit(c, proof)).status, 200); assert.equal(await verifyPassword(NEW, (await f.store.read('xiongan:tester')).passwordHash), true);
  }
});
test('replacement preserves old TOTP/recovery configuration until verified atomic activation', async t => {
  const f = await fixture({ totp: true, profile: true }); t.after(f.close); const c = f.client(); await c.login(); const before = await f.store.read('xiongan:tester');
  const proof = await f.authorize(c, { action: 'totp.replace' }, { existingCode: savedRecovery, recovery: true });
  assert.notEqual(proof.secret, SECRET); assert.deepEqual(await f.store.read('xiongan:tester'), before);
  assert.equal((await commit(c, proof, { code: 'bad' })).status, 403); assert.deepEqual(await f.store.read('xiongan:tester'), before);
  assert.equal((await commit(c, proof, { code: hotp(proof.secret, Math.floor(NOW / 30000)) })).status, 200);
  const after = await f.store.read('xiongan:tester'); assert.equal(after.secret, proof.secret); assert.deepEqual(after.recoveryProfile, before.recoveryProfile);
});
test('old TOTP and answer remain mandatory; cancel consumes no old factor', async t => {
  const f = await fixture({ totp: true, profile: true }); t.after(f.close); const c = f.client(); await c.login(); const before = await f.store.read('xiongan:tester');
  for (const extra of [{ existingCode: 'bad', existingAnswer: ANSWER }, { existingCode: hotp(SECRET, Math.floor(NOW / 30000)), existingAnswer: 'incorrect answer phrase' }]) {
    const start = (await c.call('account/change/start', { action: 'totp.replace' })).data;
    assert.notEqual((await c.call('account/change/verify', { changeId: start.changeId, originalPassword: OLD, ...extra })).status, 200);
  }
  const proof = await f.authorize(c, { action: 'totp.replace' }); await c.call('account/change/cancel', {});
  assert.equal((await commit(c, proof, { code: hotp(proof.secret, Math.floor(NOW / 30000)) })).status, 403); assert.deepEqual(await f.store.read('xiongan:tester'), before);
});
test('true unbind removes only TOTP and retains an independent enabled method', async t => {
  const f = await fixture({ totp: true, profile: true, credential: { enabledMethods: ['wallet', 'totp'] } }); t.after(f.close); const c = f.client(); await c.login();
  const proof = await f.authorize(c, { action: 'totp.unbind' }); assert.equal((await commit(c, proof)).status, 200);
  const after = await f.store.read('xiongan:tester'); for (const key of ['secret', 'lastStep', 'recoverySalt', 'recoveryHashes']) assert.equal(after[key], undefined);
  assert.deepEqual(after.enabledMethods, ['wallet']); assert.deepEqual(after.recoveryProfile, profile());
});
test('method selection cannot leave TOTP alone or enable an unbound factor; disabling preserves seed', async t => {
  const f = await fixture({ totp: true }); t.after(f.close); const c = f.client(); await c.login();
  assert.equal((await c.call('account/change/start', { action: 'methods', enabledMethods: ['totp'] })).data.error, 'AUTH_INDEPENDENT_METHOD_REQUIRED');
  assert.equal((await c.call('account/change/start', { action: 'methods', enabledMethods: ['wallet', 'ca'] })).data.error, 'AUTH_METHOD_UNAVAILABLE');
  const proof = await f.authorize(c, { action: 'methods', enabledMethods: ['wallet'] }); assert.equal((await commit(c, proof)).status, 200);
  const after = await f.store.read('xiongan:tester'); assert.equal(after.secret, SECRET); assert.deepEqual(after.enabledMethods, ['wallet']);
});
test('cross-session, new-payload, purpose and old-binding substitutions are refused', async t => {
  const f = await fixture(); t.after(f.close); const c = f.client(), other = f.client(); await c.login(); await other.login();
  const proof = await f.authorize(c, { action: 'password.replace', newPassword: NEW });
  assert.equal((await commit(other, proof)).status, 403); assert.equal((await commit(c, proof, { action: 'totp.unbind' })).status, 400);
  assert.equal((await commit(c, proof, { newPassword: 'attacker replacement password' })).status, 400);
  await f.store.transaction('xiongan:tester', (prior: any) => ({ ...prior, enabledMethods: ['wallet'] }));
  assert.equal((await commit(c, proof)).status, 409); assert.equal((await f.store.read('xiongan:tester')).passwordHash, undefined);
});
test('wallet proof cannot come from login, another action or another account', async t => {
  const f = await fixture({ passwordless: true }); t.after(f.close); const c = f.client(); await c.login();
  for (const variant of ['login', 'operation', 'account']) {
    const start = (await c.call('account/change/start', { action: 'totp.initial' })).data;
    const signature = variant === 'account' ? await Wallet.createRandom().signMessage(start.message) :
      await f.signer.signMessage(variant === 'login' ? 'ordinary login' : start.message.replace('totp.initial', 'password.initial'));
    assert.equal((await c.call('account/change/verify', { changeId: start.changeId, signature })).status, 403);
  }
  assert.equal(f.messages.length, 0);
});
test('expiry, restart, logout and credential-revision changes invalidate proofs without mutation', async t => {
  for (const mode of ['expiry', 'restart', 'logout', 'revision']) {
    const f = await fixture(); t.after(f.close); const c = f.client(); await c.login();
    const proof = await f.authorize(c, { action: 'password.replace', newPassword: NEW });
    if (mode === 'expiry') f.state.now = proof.expiresAt; if (mode === 'restart') f.restart(); if (mode === 'logout') await c.call('logout', {});
    if (mode === 'revision') await f.store.transaction('xiongan:tester', (prior: any) => ({ ...prior, revision: prior.revision + 1 }));
    assert.notEqual((await commit(c, proof)).status, 200); assert.equal((await f.store.read('xiongan:tester')).passwordHash, undefined);
  }
});
test('initial email migration has no bootstrap cycle and cannot provide a reusable authority shortcut', async t => {
  const f = await fixture({ registered: false, passwordless: true }); t.after(f.close); const c = f.client(); await c.login();
  assert.equal((await c.call('account/change/start', { action: 'totp.initial' })).data.error, 'AUTH_VERIFIED_EMAIL_REQUIRED');
  const proof = await f.authorize(c, { action: 'email.initial', email: EMAIL }); assert.equal(proof.newEmailRequired, false);
  assert.equal((await commit(c, proof)).status, 200); await c.login(); assert.equal((await c.call('account')).data.registration.complete, true);
  assert.equal((await commit(c, proof)).status, 403); const enrollment = await f.authorize(c, { action: 'totp.initial' }); assert.equal(f.messages.length, 2);
  assert.equal((await commit(c, enrollment, { code: hotp(enrollment.secret, Math.floor(NOW / 30000)) })).status, 200);
});
test('recovery reservation is exact scoped and uses one combined email OTP', async t => {
  const f = await fixture(); t.after(f.close); const c = f.client(); await c.login();
  const proof = await f.authorize(c, { action: 'recovery.initial', email: EMAIL, questionId: 'first-school', answer: 'synthetic new recovery phrase' });
  assert.equal((await commit(c, proof)).status, 200); assert.equal(f.messages.length, 1); const after = await f.store.read('xiongan:tester');
  assert.equal(after.recoveryProfile.questionId, 'first-school'); assert.equal(await verifyPassword('synthetic new recovery phrase', after.recoveryProfile.answerHash), true);
});
test('email replacement verifies old and new addresses separately and rejects recipient substitution', async t => {
  const f = await fixture({ profile: true }); t.after(f.close); const c = f.client(); await c.login();
  assert.equal((await c.call('account/change/start', { action: 'email.replace', email: 'new@example.invalid', to: 'evil@example.invalid' })).status, 400);
  const proof = await f.authorize(c, { action: 'email.replace', email: 'new@example.invalid' }); assert.equal(proof.newEmailRequired, true);
  assert.deepEqual(f.messages.map(m => m.to), [EMAIL, 'new@example.invalid']);
  assert.equal((await commit(c, proof, { newEmailCode: f.messages[0].code })).status, 403);
  assert.equal((await commit(c, proof, { newEmailCode: f.messages[1].code })).status, 200);
  const after = await f.store.read('xiongan:tester'); assert.equal(after.registration.email, 'new@example.invalid'); assert.equal(after.recoveryProfile.email, 'new@example.invalid');
});
test('origin, tenant and CSRF apply at method routes; unsupported device flags fail closed', async t => {
  const f = await fixture(); t.after(f.close); const c = f.client(); await c.login();
  for (const headers of [{ Origin: 'https://evil.invalid' }, { 'X-Wallet-Tenant': 'other' }, { 'X-Wallet-CSRF': 'forged' }]) {
    assert.ok([401, 403].includes((await c.call('account/change/start', { action: 'totp.initial' }, headers)).status));
  }
  assert.equal((await c.call('account/change/start', { action: 'totp.initial', trustedDevice: true })).status, 400);
  assert.equal((await c.call('account/change/start', { action: 'totp.initial', identityMethod: 'device' })).status, 400);
});
test('encrypted durable update retains original store format and authenticator configuration', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'method-change-')); let reopened: any; t.after(async () => { if (reopened) await reopened.close(); await rm(dir, { recursive: true, force: true }); });
  const path = join(dir, 'credentials.enc'), key = Buffer.alloc(32, 47), store = await openEncryptedStore(path, key);
  const data = initial({ totp: true, profile: true }); await store.transactionMany(Object.keys(data), () => data);
  const f = await fixture({ store, totp: true, profile: true }); t.after(f.close); const c = f.client(); await c.login();
  const proof = await f.authorize(c, { action: 'password.replace', newPassword: NEW }); assert.equal((await commit(c, proof)).status, 200);
  const raw = await readFile(path, 'utf8'); assert.equal(JSON.parse(raw).version, 1);
  for (const secret of [SECRET, OLD, NEW, ANSWER, EMAIL, proof.changeProof]) assert.equal(raw.includes(secret), false);
  await store.close(); reopened = await openEncryptedStore(path, key);
  const after = await reopened.read('xiongan:tester'); assert.equal(after.secret, SECRET); assert.deepEqual(after.recoveryProfile, profile());
  assert.equal(await verifyPassword(NEW, after.passwordHash), true);
});

function gate() {
  let release!: () => void, entered!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; }), reached = new Promise<void>(resolve => { entered = resolve; });
  return { promise, reached, release, entered };
}
class QueuedStore extends MemoryCredentialStore {
  constructor(data: any) { super(data); }
  hold: ReturnType<typeof gate> | null = null;
  async transaction(key: string, update: any) {
    const hold = this.hold; this.hold = null;
    if (hold) { hold.entered(); await hold.promise; }
    return super.transaction(key, update);
  }
}
test('cancel/logout/revision/expiry win while an authorized write waits outside the atomic transaction', async t => {
  for (const mode of ['cancel', 'logout', 'revision', 'expiry']) {
    const store = new QueuedStore(initial()), f = await fixture({ store }); t.after(f.close); const c = f.client(); await c.login();
    const before = await store.read('xiongan:tester'), proof = await f.authorize(c, { action: 'password.replace', newPassword: NEW });
    const held = gate(); store.hold = held; const pending = commit(c, proof); await held.reached;
    if (mode === 'cancel') { const result = await c.call('account/change/cancel', {}); assert.equal(result.data.cancelled, true); }
    if (mode === 'logout') await c.call('logout', {});
    if (mode === 'revision') await store.transaction('xiongan:tester', (prior: any) => ({ ...prior, revision: prior.revision + 1 }));
    if (mode === 'expiry') f.state.now = proof.expiresAt;
    held.release(); assert.notEqual((await pending).status, 200); const after = await store.read('xiongan:tester');
    assert.equal(after.passwordHash, before.passwordHash); assert.deepEqual(after.registration, before.registration);
  }
});
test('a write already persisting is reported in progress; cancel cannot falsely promise rollback', async t => {
  class PersistingStore extends MemoryCredentialStore {
    constructor(data: any) { super(data); }
    hold: ReturnType<typeof gate> | null = null;
    async persist() { if (this.hold) { this.hold.entered(); await this.hold.promise; } }
  }
  const store = new PersistingStore(initial()), f = await fixture({ store }); t.after(f.close); const c = f.client(); await c.login();
  const proof = await f.authorize(c, { action: 'password.replace', newPassword: NEW }); store.hold = gate();
  const pending = commit(c, proof); await store.hold.reached;
  const cancel = await c.call('account/change/cancel', {}); assert.equal(cancel.data.cancelled, false); assert.equal(cancel.data.confirmationInProgress, true);
  assert.equal((await c.call('account/change/start', { action: 'password.replace', newPassword: NEW })).data.error, 'AUTH_SETUP_STATE_CHANGED');
  store.hold.release(); assert.equal((await pending).status, 200); assert.equal(await verifyPassword(NEW, (await store.read('xiongan:tester')).passwordHash), true);
});
test('cancelling in-flight email delivery cannot resurrect authorization or return a new seed', async t => {
  const held = gate(), f = await fixture({ sendGate: () => { held.entered(); return held.promise; } }); t.after(f.close);
  const c = f.client(); await c.login(); const before = await f.store.read('xiongan:tester');
  const start = (await c.call('account/change/start', { action: 'totp.initial' })).data;
  const pending = c.call('account/change/verify', { changeId: start.changeId, originalPassword: OLD }); await held.reached;
  await c.call('account/change/cancel', {}); held.release(); assert.equal((await pending).status, 403);
  assert.equal((await c.call('account/change/confirm', { changeId: start.changeId, code: f.messages[0].code })).status, 403);
  assert.deepEqual(await f.store.read('xiongan:tester'), before);
});
test('old factor consumed by another login cannot be reused by a queued change proof', async t => {
  const f = await fixture({ totp: true }), c = f.client(); t.after(f.close); await c.login();
  const proof = await f.authorize(c, { action: 'totp.unbind' });
  await f.store.transaction('xiongan:tester', (prior: any) => ({ ...prior, lastStep: Math.floor(NOW / 30000) }));
  assert.equal((await commit(c, proof)).status, 403); assert.equal((await f.store.read('xiongan:tester')).secret, SECRET);
});
test('TOTP-only or stale independent login cannot begin a method change', async t => {
  const f = await fixture({ totp: true }), c = f.client(); t.after(f.close); await c.call('bootstrap');
  const login = await c.call('totp', { username: 'tester', account: f.signer.address, chainId: '1', code: hotp(SECRET, Math.floor(NOW / 30000)) }); assert.equal(login.status, 200);
  assert.equal((await c.call('account/change/start', { action: 'totp.unbind' })).data.error, 'AUTH_RECENT_INDEPENDENT_LOGIN_REQUIRED');
  await c.login(); f.state.now += 300_000;
  assert.equal((await c.call('account/change/start', { action: 'totp.unbind' })).data.error, 'AUTH_RECENT_INDEPENDENT_LOGIN_REQUIRED');
});
test('five invalid OTPs, unavailable mail and missing old email cannot fall back to single-session authority', async t => {
  const f = await fixture(), c = f.client(); t.after(f.close); await c.login();
  const start = (await c.call('account/change/start', { action: 'totp.initial' })).data;
  await c.call('account/change/verify', { changeId: start.changeId, originalPassword: OLD });
  const incorrect = f.messages[0].code === '00000000' ? '11111111' : '00000000';
  for (let n = 0; n < 5; n++) assert.equal((await c.call('account/change/confirm', { changeId: start.changeId, code: incorrect })).status, 403);
  assert.equal((await c.call('account/change/confirm', { changeId: start.changeId, code: f.messages[0].code })).status, 403);
  const absent = await fixture({ noMail: true }); t.after(absent.close); const a = absent.client(); await a.login();
  assert.equal((await a.call('account/change/start', { action: 'totp.initial' })).data.error, 'AUTH_EMAIL_UNAVAILABLE');
});

test('stale change identifiers cannot cancel or verify a newer prepared intent', async t => {
  const f = await fixture(); t.after(f.close); const c = f.client(); await c.login();
  const first = (await c.call('account/change/start', { action: 'totp.initial' })).data;
  const second = (await c.call('account/change/start', { action: 'password.replace', newPassword: NEW })).data;
  assert.notEqual(first.changeId, second.changeId);
  assert.equal((await c.call('account/change/cancel', { changeId: first.changeId })).status, 409);
  assert.equal((await c.call('account/change/verify', { changeId: first.changeId, originalPassword: OLD })).status, 403);
  assert.equal((await c.call('account/change/verify', { changeId: second.changeId, originalPassword: OLD })).status, 200);
  const proof = (await c.call('account/change/confirm', { changeId: second.changeId, code: f.messages.at(-1).code })).data;
  assert.equal((await c.call('account/change/cancel', { changeProof: 'x'.repeat(43) })).status, 409);
  assert.equal((await commit(c, proof)).status, 200);
});
test('corrupt authenticator state cannot be silently treated as a new binding', async t => {
  const f = await fixture({ credential: { secret: '' } }); t.after(f.close); const c = f.client(); await c.login();
  const result = await c.call('account/change/start', { action: 'totp.initial' }); assert.equal(result.status, 503);
  assert.equal(result.data.error, 'AUTH_CREDENTIAL_STATE_REFUSED'); assert.equal((await f.store.read('xiongan:tester')).secret, '');
});
