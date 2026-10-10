/** Password management regression through the exact combined-verification API. Synthetic only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryCredentialStore } from '../server/store.mjs';
import { verifyPassword, hotp } from '../server/crypto.mjs';
import { NOW, OLD, NEW, SECRET, savedRecovery, initial, fixture, commit } from './helpers/method-change-fixture.ts';

test('passwordless registered-wallet login sets first password after fresh wallet and email verification without nonexistent factors', async t => {
  const f = await fixture({ passwordless: true }); t.after(f.close); const c = f.client(); await c.login();
  const proof = await f.authorize(c, { action: 'password.initial', newPassword: NEW }); assert.equal((await commit(c, proof)).status, 200);
  await c.call('bootstrap'); assert.equal((await c.call('password', { username: 'tester', password: NEW, account: f.signer.address, chainId: '1' })).status, 200);
});
test('replacement overrides configured hash and revokes existing sessions without changing other methods', async t => {
  const f = await fixture(); t.after(f.close); const c = f.client(), other = f.client(); await c.login(); await other.login();
  const before = await f.store.read('xiongan:tester'), proof = await f.authorize(c, { action: 'password.replace', newPassword: NEW });
  assert.equal((await commit(c, proof)).status, 200); assert.equal((await other.call('session')).status, 401);
  const after = await f.store.read('xiongan:tester'); assert.deepEqual(after.registration, before.registration); assert.equal(after.enabledMethods, before.enabledMethods);
  await c.call('bootstrap'); const body = { username: 'tester', account: f.signer.address, chainId: '1' };
  assert.equal((await c.call('password', { ...body, password: OLD })).status, 401); assert.equal((await c.call('password', { ...body, password: NEW })).status, 200);
});
test('replacing a disabled password preserves its disabled selection', async t => {
  const f = await fixture({ credential: { enabledMethods: ['wallet'] } }); t.after(f.close); const c = f.client(); await c.login();
  const proof = await f.authorize(c, { action: 'password.replace', newPassword: NEW }); assert.equal((await commit(c, proof)).status, 200);
  assert.deepEqual((await f.store.read('xiongan:tester')).enabledMethods, ['wallet']);
  await c.call('bootstrap'); assert.equal((await c.call('password', { username: 'tester', password: NEW, account: f.signer.address, chainId: '1' })).status, 401);
});
test('initial versus replacement purpose is explicit and bound to the current credential state', async t => {
  for (const passwordless of [true, false]) {
    const f = await fixture({ passwordless }); t.after(f.close); const c = f.client(); await c.login();
    const wrong = await c.call('account/change/start', { action: passwordless ? 'password.replace' : 'password.initial', newPassword: NEW });
    assert.equal(wrong.status, 409); assert.equal((await f.store.read('xiongan:tester')).passwordHash, undefined);
  }
});
test('strict input refuses account selectors, wrong origin, CSRF, tenant and malformed password values', async t => {
  const f = await fixture(); t.after(f.close); const c = f.client(); await c.login();
  for (const extra of [{ username: 'other' }, { account: f.signer.address }, { trustedDevice: true }, { newPassword: 'short' }, { newPassword: 'x'.repeat(1025) }]) {
    assert.equal((await c.call('account/change/start', { action: 'password.replace', newPassword: NEW, ...extra })).status, 400);
  }
  for (const header of [{ Origin: 'https://other.invalid' }, { 'X-Wallet-Tenant': 'other' }, { 'X-Wallet-CSRF': 'wrong' }])
    assert.ok([401, 403].includes((await c.call('account/change/start', { action: 'password.replace', newPassword: NEW }, header)).status));
});
test('existing disabled TOTP is mandatory, and saved recovery code consumption is atomic with password replacement', async t => {
  const f = await fixture({ totp: true, credential: { enabledMethods: ['password', 'wallet'] } }); t.after(f.close); const c = f.client(); await c.login();
  const before = await f.store.read('xiongan:tester'), proof = await f.authorize(c, { action: 'password.replace', newPassword: NEW }, { existingCode: savedRecovery, recovery: true });
  assert.deepEqual(await f.store.read('xiongan:tester'), before); assert.equal((await commit(c, proof)).status, 200);
  const after = await f.store.read('xiongan:tester'); assert.equal(after.secret, SECRET); assert.equal(after.recoveryHashes.length, 0); assert.deepEqual(after.enabledMethods, ['password', 'wallet']);
});
test('reserved factors require their answer and fresh scoped email proof with or without an existing authenticator', async t => {
  for (const totp of [true, false]) {
    const f = await fixture({ totp, profile: true }); t.after(f.close); const c = f.client(); await c.login();
    const proof = await f.authorize(c, { action: 'password.replace', newPassword: NEW }); assert.equal(f.messages.length, 1);
    assert.equal((await commit(c, proof)).status, 200); assert.equal((await f.store.read('xiongan:tester')).secret, totp ? SECRET : undefined);
  }
});
test('TOTP-only and stale independent sessions cannot manage passwords', async t => {
  const f = await fixture({ totp: true }); t.after(f.close); const c = f.client(); await c.call('bootstrap');
  assert.equal((await c.call('totp', { username: 'tester', account: f.signer.address, chainId: '1', code: hotp(SECRET, Math.floor(NOW / 30000)) })).status, 200);
  assert.equal((await c.call('account/change/start', { action: 'password.replace', newPassword: NEW })).data.error, 'AUTH_RECENT_INDEPENDENT_LOGIN_REQUIRED');
  await c.login(); f.state.now += 300_000; assert.equal((await c.call('account/change/start', { action: 'password.replace', newPassword: NEW })).data.error, 'AUTH_RECENT_INDEPENDENT_LOGIN_REQUIRED');
});
test('logout, expiry, reversed time and changed revision invalidate password changes before commit', async t => {
  for (const kind of ['logout', 'expiry', 'reverse', 'revision']) {
    const f = await fixture(); t.after(f.close); const c = f.client(); await c.login();
    const proof = await f.authorize(c, { action: 'password.replace', newPassword: NEW });
    if (kind === 'logout') await c.call('logout', {}); if (kind === 'expiry') f.state.now = proof.expiresAt; if (kind === 'reverse') f.state.now = NOW - 1;
    if (kind === 'revision') await f.store.transaction('xiongan:tester', (prior: any) => ({ ...prior, revision: prior.revision + 1 }));
    assert.notEqual((await commit(c, proof)).status, 200); assert.equal((await f.store.read('xiongan:tester')).passwordHash, undefined);
  }
});
test('concurrent distinct password changes cannot overwrite a newer hash or revision', async t => {
  const f = await fixture(); t.after(f.close); const a = f.client(), b = f.client(); await a.login(); await b.login();
  const other = 'synthetic competing replacement', one = await f.authorize(a, { action: 'password.replace', newPassword: NEW });
  const two = await f.authorize(b, { action: 'password.replace', newPassword: other });
  const results = await Promise.all([commit(a, one), commit(b, two)]); assert.equal(results.filter(r => r.status === 200).length, 1);
  const after = await f.store.read('xiongan:tester'); assert.equal(after.revision, 2); assert.equal(await verifyPassword(results[0].status === 200 ? NEW : other, after.passwordHash), true);
});
test('new password must be prepared before verification and cannot be swapped at commit', async t => {
  const f = await fixture(); t.after(f.close); const c = f.client(); await c.login(); const proof = await f.authorize(c, { action: 'password.replace', newPassword: NEW });
  assert.equal((await commit(c, proof, { password: 'synthetic substituted password' })).status, 400);
  assert.equal((await commit(c, proof)).status, 200); assert.equal(await verifyPassword(NEW, (await f.store.read('xiongan:tester')).passwordHash), true);
});
test('malformed persisted password cannot fall back to previously configured credentials', async t => {
  const store = new MemoryCredentialStore(initial({ credential: { passwordHash: 'invalid' } })), f = await fixture({ store }); t.after(f.close); const c = f.client();
  await c.call('bootstrap'); const result = await c.call('password', { username: 'tester', password: OLD, account: f.signer.address, chainId: '1' });
  assert.equal(result.status, 503); assert.equal(result.data.error, 'AUTH_PASSWORD_STATE_REFUSED');
});
