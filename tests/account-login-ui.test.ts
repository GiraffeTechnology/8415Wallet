import * as uiI18n from '../web/i18n.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Wallet, verifyMessage, getAddress, hashMessage, Interface } from 'ethers';
import { WalletLogin, WalletLoginError } from '../web/login-core.mjs';
import { AccountAuthClient } from '../web/account-auth.mjs';
const source = readFileSync(new URL('../web/wallet-auth.mjs', import.meta.url), 'utf8')
  .replace(/^import[^\n]*\n/gm, '').replace(/^export \{[^\n]*\n/gm, '').replace('export const walletLogin', 'const walletLogin');
function fixture(method: string) {
  const signer = Wallet.createRandom(), origin = 'https://wallet.example.invalid:18443', elements = new Map<string, any>(), requests: any[] = [], calls: string[] = [];
  const state = { hold: null as null | Promise<void>, fail: false, revoked: false };
  const session = { id: 'a'.repeat(43), csrf: 'b'.repeat(43), tenant: 'xiongan', origin, account: signer.address, chainId: '1', kind: method, issuedAt: Date.now(), expiresAt: Date.now() + 900000 };
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
    else if (path === 'logout') { state.revoked = true; data = { loggedOut: true }; }
    else if (path === 'totp/enroll/start') { if (state.hold) await state.hold; data = { secret: 'SYNTHETIC_SETUP_SECRET', uri: 'otpauth://totp/test', expiresAt: Date.now() + 300000 }; }
    else if (path === 'totp/enroll/confirm') data = { enrolled: true, recoveryCodes: ['synthetic-recovery-code'], loggedOut: true };
    else { if (state.hold) await state.hold; data = state.fail ? { error: 'AUTH_REFUSED' } : session; }
    return { ok: !(state.fail && ['password', 'totp'].includes(path)), text: async () => JSON.stringify(data) };
  };
  class BoundClient extends AccountAuthClient { constructor({ tenant }: any) { super({ tenant, origin, fetcher }); } }
  const sdk = { ...uiI18n, WalletLogin, WalletLoginError, AccountAuthClient: BoundClient, verifyMessage, getAddress, hashMessage, Interface,
    getReleaseProfile: async () => ({ tenant: { id: 'xiongan' } }), acquireWalletUi: () => Symbol(), releaseWalletUi() {} };
  const login = new Function('document', 'globalThis', 'setTimeout', 'clearTimeout', ...Object.keys(sdk), `${source}\nreturn walletLogin;`)(
    { getElementById: element, addEventListener() {} }, { ethereum: provider, location: { origin }, addEventListener() {} }, () => 1, () => {}, ...Object.values(sdk));
  return { element, state, session, login, requests, calls, click: (id: string) => element(id).handlers.get('click')(), change: () => element('wallet-login-method').handlers.get('change')() };
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
