import * as uiI18n from '../web/i18n.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Wallet, verifyMessage, getAddress, hashMessage, Interface } from 'ethers';
import { WalletLogin, WalletLoginError } from '../web/login-core.mjs';
import { AccountAuthClient } from '../web/account-auth.mjs';
import { clearEnrollmentQr, renderEnrollmentQr } from '../web/enrollment-qr.mjs';
const source = readFileSync(new URL('../web/wallet-auth.mjs', import.meta.url), 'utf8')
  .replace(/^import[^\n]*\n/gm, '').replace(/^export \{[^\n]*\n/gm, '').replace('export const walletLogin', 'const walletLogin');
function fixture(method: string) {
  const signer = Wallet.createRandom(), origin = 'https://wallet.example.invalid:18443', elements = new Map<string, any>(), requests: any[] = [], calls: string[] = [];
  const state = { hold: null as null | Promise<void>, accountHold: null as null | Promise<void>, fail: false, revoked: false, enrolled: false, cancelled: false, badAccount: false, mailAvailable: false, reserved: false, rejectPath: '', recoveryHold: null as null | Promise<void> };
  const timers = new Map<number, () => void>(), windowEvents = new Map<string, (event?: any) => unknown>();
  let timerId = 0;
  const session = { id: 'a'.repeat(43), csrf: 'b'.repeat(43), tenant: 'xiongan', origin, username: 'tester', account: signer.address, chainId: '1', kind: method, issuedAt: Date.now(), expiresAt: Date.now() + 900000 };
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, { hidden: true, inert: true, textContent: '', value: '', checked: false, disabled: false,
      handlers: new Map(), addEventListener(event: string, handler: () => unknown) { this.handlers.set(event, handler); } });
    return elements.get(id);
  };
  element('wallet-login-method').value = method; element('auth-username').value = 'tester'; element('auth-password').value = 'synthetic-password-only'; element('auth-code').value = '123456';
  const provider = { on() {}, removeListener() {}, async request({ method }: any) { calls.push(method);
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [signer.address]; if (method === 'eth_chainId') return '0x1'; throw Error('Unexpected provider call'); } };
  const fetcher = async (url: URL, options: any) => {
    const path = url.pathname.slice(6), body = options.body ? JSON.parse(options.body) : null; requests.push({ path, options, body });
    let data: any;
    if (path === 'capabilities') data = { schema: '8415wallet-auth/1', tenant: 'xiongan', origin, methods: ['password', 'totp'] };
    else if (path === 'bootstrap') data = { csrf: 'preauth' };
    else if (path === 'session') data = session;
    else if (path === 'account') {
      if (state.accountHold) await state.accountHold;
      data = { schema: '8415wallet-account/1', tenant: 'xiongan', origin, username: 'tester', account: state.badAccount ? Wallet.createRandom().address : signer.address, chainId: '1',
        methods: { password: { enabled: true, bound: true }, wallet: { enabled: true, bound: true }, ca: { enabled: false, bound: false }, totp: { enabled: state.enrolled, bound: state.enrolled } },
        recovery: { configured: state.reserved, emailOtpAvailable: state.mailAvailable, questionId: state.reserved ? 'recovery-phrase' : null, emailMasked: state.reserved ? 't***@example.invalid' : null },
        authenticator: { enrolled: state.enrolled, pending: false }, management: { freshIndependentLogin: method === 'password', reauthenticateBy: session.issuedAt + 300000, existingCodeRequired: state.enrolled } };
    }
    else if (path === 'logout') { state.revoked = true; data = { loggedOut: true }; }
    else if (path === 'totp/enroll/start') { if (state.hold) await state.hold; data = { enrollmentId: 'e'.repeat(43), secret: 'SYNTHETIC_SETUP_SECRET', uri: 'otpauth://totp/test', expiresAt: Date.now() + 300000 }; }
    else if (path === 'account/methods') data = { updated: true, loggedOut: true };
    else if (['recovery/enroll/start', 'recovery/reset/start'].includes(path)) { if (state.recoveryHold) await state.recoveryHold; data = { challengeId: 'c'.repeat(43), expiresAt: Date.now() + 300000, emailMasked: 't***@example.invalid', digits: 8 }; }
    else if (path === 'recovery/reset/confirm') data = { resetProof: 'p'.repeat(43), expiresAt: Date.now() + 120000 };
    else if (path === 'recovery/enroll/confirm') data = { configured: true, loggedOut: true };
    else if (path === 'recovery/cancel') data = { cancelled: true };
    else if (path === 'totp/enroll/cancel') { state.cancelled = true; data = { cancelled: true, confirmationInProgress: false }; }
    else if (path === 'totp/enroll/confirm') data = { enrolled: true, recoveryCodes: ['synthetic-recovery-code'], loggedOut: true };
    else { if (state.hold) await state.hold; data = state.fail ? { error: 'AUTH_REFUSED' } : session; }
    if (state.rejectPath === path) data = { error: 'AUTH_REFUSED' };
    return { ok: state.rejectPath !== path && !(state.fail && ['password', 'totp'].includes(path)), text: async () => JSON.stringify(data) };
  };
  class BoundClient extends AccountAuthClient { constructor({ tenant }: any) { super({ tenant, origin, fetcher }); } }
  const sdk = { ...uiI18n, WalletLogin, WalletLoginError, AccountAuthClient: BoundClient, verifyMessage, getAddress, hashMessage, Interface,
    clearEnrollmentQr, renderEnrollmentQr,
    getReleaseProfile: async () => ({ tenant: { id: 'xiongan' } }), acquireWalletUi: () => Symbol(), releaseWalletUi() {} };
  const login = new Function('document', 'globalThis', 'setTimeout', 'clearTimeout', ...Object.keys(sdk), `${source}\nreturn walletLogin;`)(
    { getElementById: element, addEventListener() {} }, { ethereum: provider, location: { origin }, addEventListener(event: string, handler: (event?: any) => unknown) { windowEvents.set(event, handler); } },
    (handler: () => void) => { timers.set(++timerId, handler); return timerId; }, (id: number) => timers.delete(id), ...Object.values(sdk));
  return { element, state, session, login, requests, calls, timers, windowEvents, click: (id: string) => element(id).handlers.get('click')(), change: () => element('wallet-login-method').handlers.get('change')() };
}
for (const method of ['password', 'totp']) test(`actual ${method} UI handler clears credentials, requests only account access and unlocks verified identity`, async () => {
  const f = fixture(method); await f.click('wallet-login'); assert.equal(f.element('wallet-private').hidden, false);
  assert.equal(f.element('auth-password').value, ''); assert.equal(f.element('auth-code').value, '');
  assert.equal(f.calls.includes('personal_sign'), false);
  const request = f.requests.find(v => v.path === method); assert.equal(request.body.username, 'tester'); assert.equal(request.body.account, f.session.account);
  assert.equal(request.options.credentials, 'same-origin'); assert.equal(request.options.headers['X-Wallet-Tenant'], 'xiongan');
  f.click('wallet-logout'); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.state.revoked, true); assert.equal(f.element('wallet-private').hidden, true);
});
test('actual password UI handles refusal without exposing account panels', async () => {
  const f = fixture('password'); f.state.fail = true; await f.click('wallet-login');
  assert.equal(f.element('wallet-private').hidden, true); assert.match(f.element('wallet-login-status').textContent, /AUTH_REFUSED/); assert.throws(() => f.login.assert());
});
test('actual account UI cancels late login when switching login methods', async () => {
  const f = fixture('password'); let release!: () => void; f.state.hold = new Promise<void>(r => { release = r; });
  const pending = f.click('wallet-login'); await new Promise(resolve => setImmediate(resolve));
  f.element('wallet-login-method').value = 'totp'; f.change(); release(); await pending;
  assert.equal(f.element('wallet-private').hidden, true); assert.throws(() => f.login.assert()); assert.equal(f.state.revoked, true);
});
test('actual enrollment UI clears setup secret and presents recovery codes once after confirmed enrollment', async () => {
  const f = fixture('password'); await f.click('wallet-login'); await f.click('auth-enroll-start');
  assert.match(f.element('auth-enroll-secret').textContent, /SYNTHETIC_SETUP_SECRET/);
  f.element('auth-enroll-code').value = '123456'; await f.click('auth-enroll-confirm');
  assert.equal(f.element('wallet-private').hidden, true); assert.equal(f.element('auth-enroll-secret').textContent, '');
  assert.equal(f.element('auth-recovery-output').hidden, false); assert.match(f.element('auth-recovery-codes').textContent, /synthetic-recovery/);
  f.click('auth-recovery-dismiss'); assert.equal(f.element('auth-recovery-codes').textContent, '');
});
test('actual enrollment UI discards a late secret after logout', async () => {
  const f = fixture('password'); await f.click('wallet-login'); let release!: () => void; f.state.hold = new Promise<void>(r => { release = r; });
  const pending = f.click('auth-enroll-start'); await new Promise(resolve => setImmediate(resolve)); f.click('wallet-logout'); release(); await pending;
  assert.equal(f.element('auth-enroll-secret').textContent, ''); assert.equal(f.element('wallet-private').hidden, true);
  assert.equal(f.element('auth-enroll-qr').hidden, true); assert.equal(f.element('auth-enroll-qr').width, 0);
});
test('cancelling pending enrollment clears localized manual text and pixels before network completion', async () => {
  const f = fixture('password'); await f.click('wallet-login'); await f.click('auth-enroll-start');
  await f.click('auth-enroll-cancel');
  assert.equal(f.element('auth-enroll-secret').textContent, ''); assert.equal(f.element('auth-enroll-qr').width, 0);
  assert.equal(f.element('auth-enroll-qr').hidden, true);
});
test('enrollment expiry removes manual text and canvas backing pixels', async () => {
  const f = fixture('password'); await f.click('wallet-login'); await f.click('auth-enroll-start');
  const expiry = [...f.timers.values()].at(-1)!; expiry();
  assert.equal(f.element('auth-enroll-secret').textContent, '');
  assert.equal(f.element('auth-enroll-qr').width, 0); assert.equal(f.element('auth-enroll-qr-help').hidden, true);
});
for (const event of ['pagehide', 'pageshow']) test(`page lifecycle ${event} cannot retain enrollment text or pixels`, async () => {
  const f = fixture('password'); await f.click('wallet-login'); await f.click('auth-enroll-start');
  f.windowEvents.get(event)!({ persisted: true });
  assert.equal(f.element('auth-enroll-secret').textContent, ''); assert.equal(f.element('auth-enroll-qr').width, 0);
  assert.equal(f.element('wallet-private').hidden, true); assert.throws(() => f.login.assert());
});
for (const { id } of uiI18n.LOCALES) test(`locale ${id} cannot unlock login or revive enrollment secrets after logout`, async () => {
  uiI18n.setLocale('en', { persist: false }); const f = fixture('password');
  uiI18n.setLocale(id, { persist: false }); assert.equal(f.element('wallet-private').hidden, true); assert.deepEqual(f.calls, []); assert.deepEqual(f.requests, []);
  await f.click('wallet-login'); await f.click('auth-enroll-start'); assert.equal(f.element('wallet-private').hidden, false);
  const binding = f.login.capture(), callCount = f.calls.length, requestCount = f.requests.length;
  uiI18n.setLocale('en', { persist: false }); uiI18n.setLocale(id, { persist: false });
  f.login.assert(binding); assert.equal(f.calls.length, callCount); assert.equal(f.requests.length, requestCount);
  assert.match(f.element('auth-enroll-secret').textContent, /SYNTHETIC_SETUP_SECRET/);
  f.click('wallet-logout'); uiI18n.setLocale('en', { persist: false }); uiI18n.setLocale(id, { persist: false });
  assert.equal(f.element('auth-enroll-secret').textContent, ''); assert.equal(f.element('auth-recovery-codes').textContent, '');
  assert.equal(f.element('wallet-private').hidden, true); assert.equal(f.element('wallet-private').inert, true); assert.throws(() => f.login.assert());
  uiI18n.setLocale('en', { persist: false });
});


test('first setup and management entry are available before login without provider or auth requests', async () => {
  const f = fixture('totp'); await f.click('auth-initial-open');
  assert.equal(f.element('auth-management').hidden, false); assert.equal(f.element('auth-enrollment').hidden, true);
  assert.equal(f.element('wallet-login-method').value, 'password'); assert.equal(f.element('auth-existing-fields').hidden, true);
  assert.deepEqual(f.calls, []); assert.deepEqual(f.requests, []);
  f.click('auth-management-close'); assert.equal(f.element('auth-management').hidden, true);
  await f.click('auth-manage-open'); assert.equal(f.element('auth-management').hidden, false);
  assert.deepEqual(f.calls, []); assert.deepEqual(f.requests, []);
});
for (const { id } of uiI18n.LOCALES) test(`login action follows method and ${id} without extra provider or network requests`, () => {
  const f = fixture('password');
  for (const [method, key] of [['password', 'account.loginPassword'], ['totp', 'account.loginTotp'], ['wallet', 'account.loginWallet'], ['ca', 'account.loginCa'], ['wallet-local', 'ui.018']]) {
    f.element('wallet-login-method').value = method; f.change();
    uiI18n.setLocale(id, { persist: false }); assert.equal(f.element('wallet-login').textContent, uiI18n.t(key!));
  }
  f.element('wallet-login-method').value = 'totp'; f.element('auth-recovery').checked = true; f.change();
  assert.equal(f.element('wallet-login').textContent, uiI18n.t('account.loginRecovery'));
  assert.deepEqual(f.calls, []); assert.deepEqual(f.requests, []); uiI18n.setLocale('en', { persist: false });
});
test('initial enrollment does not request an existing code, replacement does and retains other enabled methods', async () => {
  const f = fixture('password'); await f.click('wallet-login'); await f.click('auth-manage-open');
  assert.equal(f.element('auth-existing-fields').hidden, true);
  assert.equal(f.element('auth-state-password').textContent, uiI18n.t('account.enabled'));
  assert.equal(f.element('auth-state-wallet').textContent, uiI18n.t('account.enabled'));
  await f.click('auth-enroll-start'); assert.equal(f.requests.at(-1).body.purpose, 'initial');
  await f.click('auth-enroll-cancel'); f.click('wallet-logout');
  f.state.enrolled = true; await f.click('wallet-login'); await f.click('auth-manage-open');
  assert.equal(f.element('auth-existing-fields').hidden, false);
  f.element('auth-existing-code').value = 'synthetic-recovery'; f.element('auth-existing-recovery').checked = true;
  await f.click('auth-enroll-start'); assert.equal(f.requests.at(-1).body.purpose, 'replace'); assert.equal(f.requests.at(-1).body.recovery, true);
  assert.equal(f.element('auth-existing-code').value, '');
});
test('management refuses substituted account metadata without exposing or activating controls', async () => {
  const f = fixture('password'); f.state.badAccount = true; await f.click('wallet-login'); await f.click('auth-manage-open');
  assert.equal(f.element('auth-method-states').hidden, true); assert.equal(f.element('auth-enrollment').hidden, true);
  await f.click('auth-enroll-start'); assert.equal(f.requests.some(r => r.path === 'totp/enroll/start'), false);
});
test('a late account status cannot reappear after logout', async () => {
  const f = fixture('password'); let release!: () => void; f.state.accountHold = new Promise<void>(resolve => { release = resolve; });
  const pending = f.click('wallet-login'); await new Promise(resolve => setImmediate(resolve)); f.click('wallet-logout'); release(); await pending;
  assert.equal(f.element('auth-method-states').hidden, true); assert.equal(f.element('auth-state-password').textContent, '');
});
test('repeated setup clicks make one request and cancel invalidates a pending start before its secret returns', async () => {
  const f = fixture('password'); await f.click('wallet-login'); let release!: () => void; f.state.hold = new Promise<void>(resolve => { release = resolve; });
  const pending = f.click('auth-enroll-start'); await new Promise(resolve => setImmediate(resolve));
  await f.click('auth-enroll-start'); await f.click('auth-enroll-cancel'); release(); await pending;
  assert.equal(f.requests.filter(r => r.path === 'totp/enroll/start').length, 1);
  assert.equal(f.state.cancelled, true); assert.equal(f.element('auth-management-status').textContent, uiI18n.t('account.cancelled')); assert.equal(f.element('auth-enroll-secret').textContent, ''); assert.equal(f.element('auth-confirm-fields').hidden, true);
});
for (const event of ['popstate', 'keydown']) test(`${event} closes management and discards delayed setup`, async () => {
  const f = fixture('password'); await f.click('wallet-login'); await f.click('auth-manage-open');
  let release!: () => void; f.state.hold = new Promise<void>(resolve => { release = resolve; });
  const pending = f.click('auth-enroll-start'); await new Promise(resolve => setImmediate(resolve));
  f.windowEvents.get(event)!({ key: 'Escape' }); release(); await pending;
  assert.equal(f.element('auth-management').hidden, true); assert.equal(f.element('auth-enroll-secret').textContent, '');
});
test('authenticator login can see enabled methods but cannot initiate authenticator management', async () => {
  const f = fixture('totp'); f.state.enrolled = true; await f.click('wallet-login'); await f.click('auth-manage-open');
  assert.equal(f.element('auth-method-states').hidden, false); assert.equal(f.element('auth-enrollment').hidden, true);
  assert.equal(f.element('auth-reauthenticate').hidden, false); await f.click('auth-enroll-start');
  assert.equal(f.requests.some(r => r.path === 'totp/enroll/start'), false);
});

test('method checkboxes submit multiple enabled methods and sign out after confirmed change', async () => {
  const f = fixture('password'); await f.click('wallet-login'); await f.click('auth-manage-open');
  assert.equal(f.element('auth-enable-password').checked, true); assert.equal(f.element('auth-enable-wallet').checked, true);
  f.element('auth-enable-wallet').checked = false; await f.click('auth-methods-save');
  const sent = f.requests.find(r => r.path === 'account/methods'); assert.deepEqual(sent.body.enabledMethods, ['password']);
  assert.equal(f.element('wallet-private').hidden, true); assert.equal(f.element('auth-state-password').textContent, '');
});
test('reserved-email enrollment clears the answer before network completion and requires code confirmation', async () => {
  const f = fixture('password'); f.state.mailAvailable = true; await f.click('wallet-login'); await f.click('auth-manage-open');
  f.element('auth-reserved-email').value = 'tester@example.invalid'; f.element('auth-reserved-question-id').value = 'recovery-phrase'; f.element('auth-reserved-answer').value = 'synthetic private recovery phrase';
  let release!: () => void; f.state.recoveryHold = new Promise<void>(resolve => { release = resolve; });
  const pending = f.click('auth-recovery-enroll'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.element('auth-reserved-answer').value, ''); assert.equal(f.element('auth-email-code-fields').hidden, true);
  release(); await pending; assert.equal(f.element('auth-email-code-fields').hidden, false);
  f.element('auth-email-code').value = '12345678'; await f.click('auth-email-confirm');
  assert.equal(f.element('wallet-private').hidden, true); assert.equal(f.element('auth-email-code').value, ''); assert.equal(f.element('auth-reserved-email').value, '');
});
test('reset uses only the reserved identity and passes single-use reset proof alongside existing recovery', async () => {
  const f = fixture('password'); f.state.mailAvailable = true; f.state.reserved = true; f.state.enrolled = true;
  await f.click('wallet-login'); await f.click('auth-manage-open');
  f.element('auth-reset-answer').value = 'synthetic private recovery phrase'; f.element('auth-reserved-email').value = 'attacker@example.invalid';
  await f.click('auth-reset-start'); const start = f.requests.find(r => r.path === 'recovery/reset/start'); assert.deepEqual(Object.keys(start.body), ['answer']);
  f.element('auth-email-code').value = '12345678'; await f.click('auth-email-confirm');
  f.element('auth-existing-code').value = 'synthetic-recovery'; f.element('auth-existing-recovery').checked = true;
  await f.click('auth-enroll-start'); const setup = f.requests.find(r => r.path === 'totp/enroll/start');
  assert.equal(setup.body.purpose, 'replace'); assert.equal(setup.body.resetProof, 'p'.repeat(43)); assert.equal(setup.body.existingCode, 'synthetic-recovery'); assert.equal(setup.body.recovery, true);
  assert.equal(f.element('auth-reset-answer').value, ''); assert.equal(f.element('auth-email-code').value, '');
});
test('close discards delayed email challenge, clears all answers and prevents locale revival', async () => {
  const f = fixture('password'); f.state.mailAvailable = true; f.state.reserved = true; await f.click('wallet-login'); await f.click('auth-manage-open');
  let release!: () => void; f.state.recoveryHold = new Promise<void>(resolve => { release = resolve; });
  f.element('auth-reset-answer').value = 'synthetic private recovery phrase'; const pending = f.click('auth-reset-start');
  await new Promise(resolve => setImmediate(resolve)); f.click('auth-management-close'); release(); await pending;
  for (const { id } of uiI18n.LOCALES) { uiI18n.setLocale(id, { persist: false }); assert.equal(f.element('auth-email-code-fields').hidden, true); assert.equal(f.element('auth-recovery-verification-status').textContent, ''); }
  assert.equal(f.element('auth-reset-answer').value, ''); assert.equal(f.element('auth-management').hidden, true); uiI18n.setLocale('en', { persist: false });
});
test('canceling email verification clears its proof and confirmation cannot make a late request', async () => {
  const f = fixture('password'); f.state.mailAvailable = true; f.state.reserved = true; await f.click('wallet-login'); await f.click('auth-manage-open');
  f.element('auth-reset-answer').value = 'synthetic private recovery phrase'; await f.click('auth-reset-start');
  f.element('auth-email-code').value = '12345678'; await f.click('auth-email-confirm'); await f.click('auth-email-cancel');
  const before = f.requests.length; await f.click('auth-email-confirm'); assert.equal(f.requests.length, before);
  assert.equal(f.element('auth-email-code-fields').hidden, true); assert.equal(f.element('auth-reserve-fields').hidden, true);
});
test('unavailable email transport cannot send or fake a configured recovery state', async () => {
  const f = fixture('password'); await f.click('wallet-login'); await f.click('auth-manage-open');
  assert.equal(f.element('auth-recovery-enroll').disabled, true); assert.equal(f.element('auth-reset-start').disabled, true);
  await f.click('auth-recovery-enroll'); await f.click('auth-reset-start'); assert.equal(f.requests.some(r => r.path.startsWith('recovery/')), false);
});

test('mistyped enrollment confirmation keeps the exact pending ID and permits retry without a new setup', async () => {
  const f = fixture('password'); await f.click('wallet-login'); await f.click('auth-enroll-start');
  f.state.rejectPath = 'totp/enroll/confirm'; f.element('auth-enroll-code').value = 'wrong'; await f.click('auth-enroll-confirm');
  assert.equal(f.element('auth-confirm-fields').hidden, false); assert.equal(f.element('auth-enroll-secret').textContent, '');
  f.state.rejectPath = ''; f.element('auth-enroll-code').value = '123456'; await f.click('auth-enroll-confirm');
  assert.deepEqual(f.requests.filter(r => r.path === 'totp/enroll/confirm').map(r => r.body.enrollmentId), ['e'.repeat(43), 'e'.repeat(43)]);
  assert.equal(f.requests.filter(r => r.path === 'totp/enroll/start').length, 1); assert.equal(f.element('auth-recovery-output').hidden, false);
});
for (const target of ['totp/enroll/start', 'recovery/enroll/start']) test(`refused ${target} preserves unconsumed reset proof for corrected input`, async () => {
  const f = fixture('password'); f.state.mailAvailable = true; f.state.reserved = true; f.state.enrolled = true;
  await f.click('wallet-login'); await f.click('auth-manage-open'); f.element('auth-reset-answer').value = 'synthetic private recovery phrase'; await f.click('auth-reset-start');
  f.element('auth-email-code').value = '12345678'; await f.click('auth-email-confirm');
  const button = target === 'totp/enroll/start' ? 'auth-enroll-start' : 'auth-recovery-enroll';
  f.state.rejectPath = target; f.element('auth-existing-code').value = 'wrong'; await f.click(button);
  f.state.rejectPath = ''; f.element('auth-existing-code').value = 'corrected'; await f.click(button);
  assert.deepEqual(f.requests.filter(r => r.path === target).map(r => r.body.resetProof), ['p'.repeat(43), 'p'.repeat(43)]);
});

test('canceling reset verification during proof-dependent enrollment refuses the late TOTP secret', async () => {
  const f = fixture('password'); f.state.mailAvailable = true; f.state.reserved = true; f.state.enrolled = true;
  await f.click('wallet-login'); await f.click('auth-manage-open'); f.element('auth-reset-answer').value = 'synthetic private recovery phrase'; await f.click('auth-reset-start');
  f.element('auth-email-code').value = '12345678'; await f.click('auth-email-confirm');
  let release!: () => void; f.state.hold = new Promise<void>(resolve => { release = resolve; });
  const pending = f.click('auth-enroll-start'); await new Promise(resolve => setImmediate(resolve)); await f.click('auth-email-cancel'); release(); await pending;
  assert.equal(f.element('auth-enroll-secret').textContent, ''); assert.equal(f.element('auth-confirm-fields').hidden, true);
  assert.equal(f.element('wallet-private').hidden, true); assert.throws(() => f.login.assert());
});
