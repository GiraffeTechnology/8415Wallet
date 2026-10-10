import { isPlatformPasswordProfile, passwordPanelAction } from '../web/tenant-password-routing.mjs';
import * as uiI18n from '../web/i18n.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Wallet, verifyMessage, getAddress, hashMessage, Interface, getBytes } from 'ethers';
import { WalletLogin, WalletLoginError } from '../web/login-core.mjs';
import { AccountAuthClient } from '../web/account-auth.mjs';
import { clearEnrollmentQr, renderEnrollmentQr } from '../web/enrollment-qr.mjs';
const source = readFileSync(new URL('../web/wallet-auth.mjs', import.meta.url), 'utf8')
  .replace(/^import[^\n]*\n/gm, '').replace(/^export \{[^\n]*\n/gm, '').replace('export const walletLogin', 'const walletLogin');
// Exercise the real combined-verification module with deterministic dialog input.
// This is handler/DOM-model coverage; hosted Chromium remains a separate gate.
const changeSource = readFileSync(new URL('../web/method-change-ui.mjs', import.meta.url), 'utf8')
  .replace(/^import[^\n]*\n/gm, '').replace(/export (?=(?:async )?function)/g, '');
class DialogElement {
  tagName: string; children: DialogElement[] = []; parentElement: DialogElement | null = null;
  handlers = new Map<string, Function[]>(); attributes = new Map<string, string>();
  textContent = ''; private storedValue = ''; type = ''; hidden = false; open = false; checked = false; isConnected = true; className = ''; id = '';
  onShow: (dialog: DialogElement) => void;
  constructor(tag: string, onShow: (dialog: DialogElement) => void) { this.tagName = tag; this.onShow = onShow; }
  get value(): string { return this.storedValue || (this.tagName === 'select' ? this.children[0]?.value ?? '' : ''); }
  set value(value: string) { this.storedValue = value; }
  append(child: DialogElement) { this.children.push(child); child.parentElement = this; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  addEventListener(name: string, handler: Function) { const list = this.handlers.get(name) ?? []; list.push(handler); this.handlers.set(name, list); }
  fire(name: string) { for (const handler of this.handlers.get(name) ?? []) handler({ preventDefault() {} }); }
  showModal() { this.open = true; queueMicrotask(() => { if (this.open) this.onShow(this); }); }
  close() { this.open = false; this.fire('close'); }
  focus() {}
  remove() { this.isConnected = false; if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); }
}
const descendants = (root: DialogElement): DialogElement[] => [root, ...root.children.flatMap(descendants)];
function fixture(method: string, profile = Promise.resolve<any>({ tenant: { id: 'xiongan' } })) {
  const signer = Wallet.createRandom(), origin = 'https://wallet.example.invalid:18443', elements = new Map<string, any>(), requests: any[] = [], calls: string[] = [];
  const state = { hold: null as null | Promise<void>, accountHold: null as null | Promise<void>, fail: false, revoked: false, enrolled: false, cancelled: false, badAccount: false, mailAvailable: true, reserved: false, rejectPath: '', rejectCode: 'AUTH_REFUSED', recoveryHold: null as null | Promise<void>, registrationHold: null as null | Promise<void>, registrationConfirmHold: null as null | Promise<void>, registeredEmail: 'tester@example.invalid' as string | null, registrationCancelled: false, signatureHold: null as null | Promise<void>, passwordManagement: true, passwordBound: true, passwordEnabled: true, stale: false, passwordHold: null as null | Promise<void>, capabilitiesHold: null as null | Promise<void>, sessionHold: null as null | Promise<void>, passwordBadResponse: false, passwordNetworkFailure: false, changeCode: 'synthetic-recovery', changeRecovery: true, changeAnswer: 'synthetic private recovery phrase', changeIdentity: '', dialogHold: false };
  const timers = new Map<number, () => void>(), windowEvents = new Map<string, (event?: any) => unknown>();
  let timerId = 0;
  const issuedAt = Date.now();
  const session = { id: 'a'.repeat(43), csrf: 'b'.repeat(43), tenant: 'xiongan', origin, username: 'tester', account: signer.address, chainId: '1', kind: method, issuedAt, expiresAt: issuedAt + 900000 };
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, { hidden: true, inert: true, textContent: '', value: '', checked: false, disabled: false,
      handlers: new Map(), addEventListener(event: string, handler: () => unknown) { this.handlers.set(event, handler); } });
    return elements.get(id);
  };
  element('wallet-login-method').value = method; element('auth-username').value = 'tester'; element('auth-password').value = 'synthetic-password-only'; element('auth-code').value = '123456';
  const providerEvents = new Map<string, Set<() => void>>();
  const provider = { on(event: string, fn: () => void) { if (!providerEvents.has(event)) providerEvents.set(event, new Set()); providerEvents.get(event)!.add(fn); }, removeListener(event: string, fn: () => void) { providerEvents.get(event)?.delete(fn); }, async request({ method, params }: any) { calls.push(method);
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [signer.address]; if (method === 'eth_chainId') return '0x1'; if (method === 'personal_sign') { if (state.signatureHold) await state.signatureHold; return signer.signMessage(getBytes(params[0])); } throw Error('Unexpected provider call'); } };
  let changeIntent: any = null, changeExpiry = 0;
  const fetcher = async (url: URL, options: any) => {
    const path = url.pathname.slice(6), body = options.body ? JSON.parse(options.body) : null; requests.push({ path, options, body });
    let data: any;
    if (path === 'capabilities') { if (state.capabilitiesHold) await state.capabilitiesHold; data = { schema: '8415wallet-auth/1', tenant: 'xiongan', origin, methods: ['password', 'totp', 'wallet', 'ca'], ...(state.passwordManagement ? { passwordManagement: true, methodManagement: 'combined-v1' } : {}), registration: { available: state.mailAvailable, emailRequired: true } }; }
    else if (path === 'bootstrap') data = { csrf: 'preauth' };
    else if (path === 'session') { if (state.sessionHold) await state.sessionHold; data = session; }
    else if (path === 'challenge') { session.kind = body.method; data = { id: 'w'.repeat(43), tenant: 'xiongan', origin, account: signer.address, chainId: '1', method: body.method, message: 'Synthetic registered-wallet login proof' }; }
    else if (path === 'account') {
      if (state.accountHold) await state.accountHold;
      data = { schema: '8415wallet-account/1', tenant: 'xiongan', origin, username: 'tester', account: state.badAccount ? Wallet.createRandom().address : signer.address, chainId: '1',
        methods: { password: { enabled: state.passwordBound && state.passwordEnabled, bound: state.passwordBound }, wallet: { enabled: true, bound: true }, ca: { enabled: false, bound: false }, totp: { enabled: state.enrolled, bound: state.enrolled } },
        registration: { required: !state.registeredEmail, complete: !!state.registeredEmail, email: state.registeredEmail, emailMasked: state.registeredEmail ? 't***@example.invalid' : null, emailOtpAvailable: state.mailAvailable },
        recovery: { configured: state.reserved, emailOtpAvailable: state.mailAvailable, questionId: state.reserved ? 'recovery-phrase' : null, emailMasked: state.reserved ? 't***@example.invalid' : null },
        methodChange: { available: state.mailAvailable, factor: state.passwordBound ? 'password' : 'wallet', verifiedEmailRequired: !state.registeredEmail && !state.reserved, emailMasked: state.registeredEmail || state.reserved ? 't***@example.invalid' : null, existingCodeRequired: state.enrolled, existingAnswerRequired: state.reserved, trustedDeviceSupported: false },
        authenticator: { enrolled: state.enrolled, pending: false }, management: { freshIndependentLogin: ['password', 'wallet', 'ca'].includes(session.kind) && !state.stale, reauthenticateBy: state.stale ? Date.now() - 1 : session.issuedAt + 300000, existingCodeRequired: state.enrolled } };
    }
    else if (path === 'account/change/start') {
      changeIntent = structuredClone(body); changeExpiry = session.issuedAt + 300000;
      if (body.action.startsWith('recovery.') && state.recoveryHold) await state.recoveryHold;
      if (body.action.startsWith('email.') && state.registrationHold) await state.registrationHold;
      data = { changeId: 'c'.repeat(43), action: body.action, origin, tenant: 'xiongan', account: signer.address, chainId: '1', factor: body.identityMethod,
        existingCodeRequired: state.enrolled, existingAnswerRequired: state.reserved, emailMasked: 't***@example.invalid', expiresAt: changeExpiry,
        message: `Purpose: ${body.action}; no login or transaction authority\nOrigin: ${origin}\nAccount: ${signer.address}` };
    }
    else if (path === 'account/change/verify') data = { changeId: 'c'.repeat(43), emailMasked: 't***@example.invalid', digits: 8, expiresAt: changeExpiry };
    else if (path === 'account/change/confirm') {
      if (changeIntent.action.startsWith('totp.') && state.hold) await state.hold;
      data = { changeProof: 'e'.repeat(43), action: changeIntent.action, expiresAt: Math.min(Date.now() + 120000, changeExpiry), newEmailRequired: false,
        ...(changeIntent.action.startsWith('totp.') ? { secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', uri: 'otpauth://totp/synthetic' } : {}) };
    }
    else if (path === 'account/change/commit') {
      if (changeIntent.action.startsWith('password.')) {
        if (state.passwordHold) await state.passwordHold;
        if (state.passwordNetworkFailure) throw Error('Synthetic connection loss');
      }
      data = state.passwordBadResponse ? { updated: true } : { updated: true, loggedOut: true, action: changeIntent.action,
        ...(changeIntent.action.startsWith('totp.') ? { enrolled: true, recoveryCodes: ['synthetic-recovery-code'] } : {}) };
    }
    else if (path === 'account/change/cancel') { state.cancelled = true; data = { cancelled: true, confirmationInProgress: false }; }
    else if (path === 'logout') { state.revoked = true; data = { loggedOut: true }; }
    else if (path === 'registration/start') { if (state.registrationHold) await state.registrationHold; data = { challengeId: 's'.repeat(43), expiresAt: Date.now() + 300000, emailMasked: 't***@example.invalid', digits: 8 }; }
    else if (path === 'registration/verify') data = { verified: true, registrationId: 'v'.repeat(43), expiresAt: Date.now() + 300000 };
    else if (path === 'registration/challenge') data = { id: 'w'.repeat(43), tenant: 'xiongan', origin, account: signer.address, chainId: '1', method: 'wallet', message: 'Synthetic ordinary account proof\nurn:8415wallet:purpose:registration' };
    else if (path === 'registration/confirm') { if (state.registrationConfirmHold) await state.registrationConfirmHold; session.kind = 'wallet'; state.registeredEmail = 'tester@example.invalid'; data = { registered: true, session }; }
    else if (path === 'registration/cancel') { state.registrationCancelled = true; data = { cancelled: true }; }
    else if (path === 'recovery/reset/start') { if (state.recoveryHold) await state.recoveryHold; data = { challengeId: 'c'.repeat(43), expiresAt: Date.now() + 300000, emailMasked: 't***@example.invalid', digits: 8 }; }
    else if (path === 'recovery/reset/confirm') data = { resetProof: 'p'.repeat(43), expiresAt: Date.now() + 120000 };
    else if (path === 'recovery/cancel') data = { cancelled: true };
    else if (['password', 'totp', 'proof'].includes(path)) { if (state.hold) await state.hold; data = state.fail ? { error: 'AUTH_REFUSED' } : session; }
    else throw Error(`Unexpected mock route: ${path}`);
    if (state.rejectPath === path) data = { error: state.rejectCode };
    return { ok: state.rejectPath !== path && !(state.fail && ['password', 'totp'].includes(path)), text: async () => JSON.stringify(data) };
  };
  class BoundClient extends AccountAuthClient { constructor({ tenant }: any) { super({ tenant, origin, fetcher }); } }
  const dialogFields: DialogElement[] = [];
  const onDialog = (dialog: DialogElement) => {
    if (state.dialogHold) return;
    const nodes = descendants(dialog), select = nodes.find(node => node.tagName === 'select');
    if (select && state.changeIdentity) { select.value = state.changeIdentity; select.fire('change'); }
    for (const input of nodes.filter(node => node.tagName === 'input')) {
      dialogFields.push(input);
      const label = input.parentElement?.children.find(node => node.tagName === 'span')?.textContent;
      if (label === uiI18n.t('change.originalPassword')) input.value = 'synthetic-password-only';
      else if (label === uiI18n.t('change.existingCode')) input.value = state.changeCode;
      else if (label === uiI18n.t('change.existingAnswer')) input.value = state.changeAnswer;
      else if (input.type === 'checkbox') input.checked = state.changeRecovery;
      else if (label === uiI18n.t('change.emailCode')) input.value = '12345678';
    }
    nodes.find(node => node.tagName === 'form')!.fire('submit');
  };
  const document = { getElementById: element, addEventListener() {}, body: new DialogElement('body', onDialog), activeElement: null,
    createElement: (tag: string) => new DialogElement(tag, onDialog) };
  const setTimer = (handler: () => void) => { timers.set(++timerId, handler); return timerId; }, clearTimer = (id: number) => timers.delete(id);
  const changeUi = new Function('document', 'setTimeout', 'clearTimeout', 'msg', 'paint', 'WalletLoginError',
    `${changeSource}\nreturn { authorizeMethodChange, commitMethodChange, cancelMethodChangeUi };`)(document, setTimer, clearTimer, uiI18n.msg, uiI18n.paint, WalletLoginError);
  const sdk = { ...uiI18n, ...changeUi, WalletLogin, WalletLoginError, AccountAuthClient: BoundClient, verifyMessage, getAddress, hashMessage, Interface,
    clearEnrollmentQr, renderEnrollmentQr,
    isPlatformPasswordProfile, passwordPanelAction, getReleaseProfile: () => profile, acquireWalletUi: () => Symbol(), releaseWalletUi() {} };
  const login = new Function('document', 'globalThis', 'setTimeout', 'clearTimeout', ...Object.keys(sdk), `${source}\nreturn walletLogin;`)(
    document, { ethereum: provider, location: { origin }, addEventListener(event: string, handler: (event?: any) => unknown) { windowEvents.set(event, handler); } },
    (handler: () => void) => { timers.set(++timerId, handler); return timerId; }, (id: number) => timers.delete(id), ...Object.values(sdk));
  return { ready: profile, element, state, dialogFields, document, session, login, requests, calls, timers, windowEvents, emit: (event: string) => { for (const fn of providerEvents.get(event) ?? []) fn(); }, click: (id: string) => element(id).handlers.get('click')(), change: () => element('wallet-login-method').handlers.get('change')() };
}
for (const method of ['password', 'totp']) test(`actual ${method} UI handler clears credentials, requests only account access and unlocks verified identity`, async () => {
  const f = fixture(method); await f.click('wallet-login'); assert.equal(f.element('wallet-private').hidden, false, f.element('wallet-login-status').textContent);
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
  const f = fixture('password'); await f.click('wallet-login'); await f.click('auth-manage-open'); await f.click('auth-enroll-start');
  assert.match(f.element('auth-enroll-secret').textContent, /GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ/);
  f.element('auth-enroll-code').value = '123456'; await f.click('auth-enroll-confirm');
  assert.equal(f.element('wallet-private').hidden, true); assert.equal(f.element('auth-enroll-secret').textContent, '');
  assert.equal(f.element('auth-recovery-output').hidden, false); assert.match(f.element('auth-recovery-codes').textContent, /synthetic-recovery/);
  f.click('auth-recovery-dismiss'); assert.equal(f.element('auth-recovery-codes').textContent, '');
});
test('actual enrollment UI discards a late secret after logout', async () => {
  const f = fixture('password'); await f.click('wallet-login'); await f.click('auth-manage-open'); let release!: () => void; f.state.hold = new Promise<void>(r => { release = r; });
  const pending = f.click('auth-enroll-start'); await new Promise(resolve => setImmediate(resolve)); f.click('wallet-logout'); release(); await pending;
  assert.equal(f.element('auth-enroll-secret').textContent, ''); assert.equal(f.element('wallet-private').hidden, true);
  assert.equal(f.element('auth-enroll-qr').hidden, true); assert.equal(f.element('auth-enroll-qr').width, 0);
});
test('cancelling pending enrollment clears localized manual text and pixels before network completion', async () => {
  const f = fixture('password'); await f.click('wallet-login'); await f.click('auth-manage-open'); await f.click('auth-enroll-start');
  await f.click('auth-enroll-cancel');
  assert.equal(f.element('auth-enroll-secret').textContent, ''); assert.equal(f.element('auth-enroll-qr').width, 0);
  assert.equal(f.element('auth-enroll-qr').hidden, true);
});
test('enrollment expiry removes manual text and canvas backing pixels', async () => {
  const f = fixture('password'); await f.click('wallet-login'); await f.click('auth-manage-open'); await f.click('auth-enroll-start');
  const expiry = [...f.timers.values()].at(-1)!; expiry();
  assert.equal(f.element('auth-enroll-secret').textContent, '');
  assert.equal(f.element('auth-enroll-qr').width, 0); assert.equal(f.element('auth-enroll-qr-help').hidden, true);
});
for (const event of ['pagehide', 'pageshow']) test(`page lifecycle ${event} cannot retain enrollment text or pixels`, async () => {
  const f = fixture('password'); await f.click('wallet-login'); await f.click('auth-manage-open'); await f.click('auth-enroll-start');
  f.windowEvents.get(event)!({ persisted: true });
  assert.equal(f.element('auth-enroll-secret').textContent, ''); assert.equal(f.element('auth-enroll-qr').width, 0);
  assert.equal(f.element('wallet-private').hidden, true); assert.throws(() => f.login.assert());
});
for (const { id } of uiI18n.LOCALES) test(`locale ${id} cannot unlock login or revive enrollment secrets after logout`, async () => {
  uiI18n.setLocale('en', { persist: false }); const f = fixture('password');
  uiI18n.setLocale(id, { persist: false }); assert.equal(f.element('wallet-private').hidden, true); assert.deepEqual(f.calls, []); assert.deepEqual(f.requests, []);
  await f.click('wallet-login'); await f.click('auth-manage-open'); await f.click('auth-enroll-start'); assert.equal(f.element('wallet-private').hidden, false);
  const binding = f.login.capture(), callCount = f.calls.length, requestCount = f.requests.length;
  uiI18n.setLocale('en', { persist: false }); uiI18n.setLocale(id, { persist: false });
  f.login.assert(binding); assert.equal(f.calls.length, callCount); assert.equal(f.requests.length, requestCount);
  assert.match(f.element('auth-enroll-secret').textContent, /GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ/);
  f.click('wallet-logout'); uiI18n.setLocale('en', { persist: false }); uiI18n.setLocale(id, { persist: false });
  assert.equal(f.element('auth-enroll-secret').textContent, ''); assert.equal(f.element('auth-recovery-codes').textContent, '');
  assert.equal(f.element('wallet-private').hidden, true); assert.equal(f.element('wallet-private').inert, true); assert.throws(() => f.login.assert());
  uiI18n.setLocale('en', { persist: false });
});


test('public entry is request-free and explicit setup checks capabilities without requesting provider access', async () => {
  const f = fixture('totp'); assert.deepEqual(f.calls, []); assert.equal(f.requests.length, 0); await f.ready; await f.click('auth-initial-open');
  assert.equal(f.element('auth-management').hidden, false); assert.equal(f.element('auth-enrollment').hidden, true);
  assert.equal(f.element('wallet-login-method').value, 'wallet'); assert.equal(f.element('auth-existing-fields').hidden, true);
  assert.deepEqual(f.calls, []); assert.deepEqual(f.requests.map(r => r.path), ['capabilities']);
  f.click('auth-management-close'); assert.equal(f.element('auth-management').hidden, true);
  await f.ready; await f.click('auth-manage-open'); assert.equal(f.element('auth-management').hidden, false);
  assert.deepEqual(f.calls, []); assert.deepEqual(f.requests.map(r => r.path), ['capabilities', 'capabilities']);
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
  await f.click('auth-enroll-start'); assert.equal(f.requests.find(r => r.path === 'account/change/start').body.action, 'totp.initial'); assert.equal(f.requests.find(r => r.path === 'account/change/verify').body.existingCode, undefined);
  await f.click('auth-enroll-cancel'); f.click('wallet-logout');
  f.state.enrolled = true; await f.click('wallet-login'); await f.click('auth-manage-open');
  assert.equal(f.element('auth-existing-fields').hidden, true);
  f.element('auth-existing-code').value = 'synthetic-recovery'; f.element('auth-existing-recovery').checked = true;
  await f.click('auth-enroll-start'); assert.equal(f.requests.filter(r => r.path === 'account/change/start').at(-1).body.action, 'totp.replace'); assert.equal(f.requests.filter(r => r.path === 'account/change/verify').at(-1).body.recovery, true); assert.equal(f.requests.filter(r => r.path === 'account/change/verify').at(-1).body.existingCode, 'synthetic-recovery');
  assert.equal(f.element('auth-existing-code').value, '');
});
test('management refuses substituted account metadata without exposing or activating controls', async () => {
  const f = fixture('password'); f.state.badAccount = true; await f.click('wallet-login'); await f.click('auth-manage-open');
  assert.equal(f.element('auth-method-states').hidden, true); assert.equal(f.element('auth-enrollment').hidden, true);
  await f.click('auth-enroll-start'); assert.equal(f.requests.some(r => r.path === 'account/change/start'), false);
});
test('a late account status cannot reappear after logout', async () => {
  const f = fixture('password'); let release!: () => void; f.state.accountHold = new Promise<void>(resolve => { release = resolve; });
  const pending = f.click('wallet-login'); await new Promise(resolve => setImmediate(resolve)); f.click('wallet-logout'); release(); await pending;
  assert.equal(f.element('auth-method-states').hidden, true); assert.equal(f.element('auth-state-password').textContent, '');
});
test('repeated setup clicks make one request and cancel invalidates a pending start before its secret returns', async () => {
  const f = fixture('password'); await f.click('wallet-login'); await f.click('auth-manage-open'); let release!: () => void; f.state.hold = new Promise<void>(resolve => { release = resolve; });
  const pending = f.click('auth-enroll-start'); await new Promise(resolve => setImmediate(resolve));
  await f.click('auth-enroll-start'); await f.click('auth-enroll-cancel'); release(); await pending;
  assert.equal(f.requests.filter(r => r.path === 'account/change/start').length, 1);
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
  assert.equal(f.requests.some(r => r.path === 'account/change/start'), false);
});

test('method checkboxes submit multiple enabled methods and sign out after confirmed change', async () => {
  const f = fixture('password'); await f.click('wallet-login'); await f.click('auth-manage-open');
  assert.equal(f.element('auth-enable-password').checked, true); assert.equal(f.element('auth-enable-wallet').checked, true);
  f.element('auth-enable-wallet').checked = false; await f.click('auth-methods-save');
  const sent = f.requests.find(r => r.path === 'account/change/start'); assert.deepEqual(sent.body.enabledMethods, ['password']);
  assert.equal(f.element('wallet-private').hidden, true); assert.equal(f.element('auth-state-password').textContent, '');
});
test('reserved-email enrollment clears the answer before network completion and requires code confirmation', async () => {
  const f = fixture('password'); f.state.mailAvailable = true; await f.click('wallet-login'); await f.click('auth-manage-open');
  f.element('auth-reserved-email').value = 'tester@example.invalid'; f.element('auth-reserved-question-id').value = 'recovery-phrase'; f.element('auth-reserved-answer').value = 'synthetic private recovery phrase';
  let release!: () => void; f.state.recoveryHold = new Promise<void>(resolve => { release = resolve; });
  const pending = f.click('auth-recovery-enroll'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.element('auth-reserved-answer').value, ''); assert.equal(f.element('auth-email-code-fields').hidden, true);
  release(); await pending; assert.equal(f.element('auth-email-code-fields').hidden, true);
  assert.deepEqual(f.requests.filter(r => r.path.startsWith('account/change/') && !r.path.endsWith('/cancel')).map(r => r.path), ['account/change/start', 'account/change/verify', 'account/change/confirm', 'account/change/commit']);
  assert.equal(f.requests.find(r => r.path === 'account/change/confirm').body.code, '12345678');
  assert.equal(f.dialogFields.every(field => field.type === 'checkbox' || field.value === ''), true);
  assert.equal(f.element('wallet-private').hidden, true); assert.equal(f.element('auth-email-code').value, ''); assert.equal(f.element('auth-reserved-email').value, '');
});
test('generic reset stays destination-bound but cannot replace combined authenticator verification', async () => {
  const f = fixture('password'); f.state.mailAvailable = true; f.state.reserved = true; f.state.enrolled = true;
  await f.click('wallet-login'); await f.click('auth-manage-open');
  f.element('auth-reset-answer').value = 'synthetic private recovery phrase'; f.element('auth-reserved-email').value = 'attacker@example.invalid';
  await f.click('auth-reset-start'); const start = f.requests.find(r => r.path === 'recovery/reset/start'); assert.deepEqual(Object.keys(start.body), ['answer']);
  f.element('auth-email-code').value = '12345678'; await f.click('auth-email-confirm');
  f.element('auth-existing-code').value = 'synthetic-recovery'; f.element('auth-existing-recovery').checked = true;
  await f.click('auth-enroll-start'); const setup = f.requests.find(r => r.path === 'account/change/start');
  assert.equal(setup.body.action, 'totp.replace'); assert.equal(setup.body.resetProof, undefined);
  const verified = f.requests.find(r => r.path === 'account/change/verify');
  assert.equal(verified.body.existingCode, 'synthetic-recovery'); assert.equal(verified.body.recovery, true); assert.equal(verified.body.existingAnswer, f.state.changeAnswer);
  assert.equal(f.requests.filter(r => r.path === 'account/change/confirm').length, 1);
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
  assert.equal(f.element('auth-email-code-fields').hidden, true); assert.equal(f.element('auth-reserved-answer').value, '');
  assert.equal(f.requests.some(r => r.path === 'account/change/start' || r.path === 'account/change/commit'), false);
});
test('unavailable email transport cannot send or fake a configured recovery state', async () => {
  const f = fixture('password'); f.state.mailAvailable = false; await f.click('wallet-login'); await f.click('auth-manage-open');
  assert.equal(f.element('auth-recovery-enroll').disabled, true); assert.equal(f.element('auth-reset-start').disabled, true);
  await f.click('auth-recovery-enroll'); await f.click('auth-reset-start'); assert.equal(f.requests.some(r => r.path.startsWith('recovery/')), false);
});

test('mistyped enrollment confirmation keeps the exact pending ID and permits retry without a new setup', async () => {
  const f = fixture('password'); await f.click('wallet-login'); await f.click('auth-manage-open'); await f.click('auth-enroll-start');
  f.state.rejectPath = 'account/change/commit'; f.element('auth-enroll-code').value = 'wrong'; await f.click('auth-enroll-confirm');
  assert.equal(f.element('auth-confirm-fields').hidden, false); assert.equal(f.element('auth-enroll-secret').textContent, '');
  f.state.rejectPath = ''; f.element('auth-enroll-code').value = '123456'; await f.click('auth-enroll-confirm');
  assert.deepEqual(f.requests.filter(r => r.path === 'account/change/commit').map(r => r.body.changeProof), ['e'.repeat(43), 'e'.repeat(43)]);
  assert.equal(f.requests.filter(r => r.path === 'account/change/start').length, 1); assert.equal(f.element('auth-recovery-output').hidden, false);
});
for (const action of ['totp.replace', 'recovery.replace']) test(`refused ${action} retries fresh combined verification without reusing generic reset proof`, async () => {
  const f = fixture('password'); f.state.mailAvailable = true; f.state.reserved = true; f.state.enrolled = true;
  await f.click('wallet-login'); await f.click('auth-manage-open');
  const button = action === 'totp.replace' ? 'auth-enroll-start' : 'auth-recovery-enroll';
  f.element('auth-reserved-email').value = 'tester@example.invalid'; f.element('auth-reserved-question-id').value = 'recovery-phrase';
  f.element('auth-reserved-answer').value = 'synthetic replacement answer';
  f.state.rejectPath = 'account/change/verify'; f.state.changeCode = 'wrong'; await f.click(button);
  assert.equal(f.requests.some(r => r.path === 'account/change/commit'), false); assert.equal(f.element('auth-enroll-secret').textContent, '');
  f.state.rejectPath = ''; f.state.changeCode = 'corrected'; f.element('auth-reserved-answer').value = 'synthetic replacement answer'; await f.click(button);
  const attempts = f.requests.filter(r => r.path === 'account/change/start'); assert.deepEqual(attempts.map(r => r.body.action), [action, action]);
  assert.equal(attempts.every(r => r.body.resetProof === undefined), true);
  assert.deepEqual(f.requests.filter(r => r.path === 'account/change/verify').map(r => r.body.existingCode), ['wrong', 'corrected']);
  assert.equal(f.requests.filter(r => r.path === 'account/change/confirm').length, 1);
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

async function signupVerified(f: ReturnType<typeof fixture>) {
  f.state.mailAvailable = true; await f.click('auth-registration-open');
  f.element('auth-registration-email').value = 'tester@example.invalid'; await f.click('auth-registration-start');
  f.element('auth-registration-code').value = '12345678'; await f.click('auth-registration-verify');
}
test('ordinary signup verifies email before any provider request and binds a wallet session with optional password', async () => {
  const f = fixture('password'); await signupVerified(f); assert.deepEqual(f.calls, []);
  assert.equal(f.element('auth-registration-wallet-fields').hidden, false); assert.equal(f.element('wallet-private').hidden, true);
  f.element('auth-registration-password').value = 'synthetic-password-only'; f.element('auth-registration-password-confirm').value = 'synthetic-password-only';
  await f.click('auth-registration-finish');
  assert.equal(f.element('wallet-private').hidden, false); assert.equal(f.login.assert().kind, 'wallet');
  assert.equal(f.element('auth-registration-password').value, ''); assert.equal(f.element('auth-registration-code').value, '');
  const created = f.requests.find(r => r.path === 'registration/confirm'); assert.equal(created.body.registrationId, 'v'.repeat(43)); assert.equal(created.body.password, 'synthetic-password-only');
  assert.equal(created.body.account, f.session.account); assert.equal(created.body.username, undefined); assert.equal(created.body.role, undefined);
  assert.equal(f.element('auth-reserved-email').value, 'tester@example.invalid'); assert.equal(f.element('auth-reserved-email').readOnly, true);
});
test('an unverified or mistyped signup code never reaches a wallet-control request', async () => {
  const f = fixture('password'); f.state.mailAvailable = true; await f.click('auth-registration-open');
  await f.click('auth-registration-finish'); assert.deepEqual(f.calls, []);
  f.element('auth-registration-email').value = 'tester@example.invalid'; await f.click('auth-registration-start');
  f.state.rejectPath = 'registration/verify'; f.element('auth-registration-code').value = 'wrong'; await f.click('auth-registration-verify');
  assert.equal(f.element('auth-registration-code-fields').hidden, false); assert.equal(f.element('auth-registration-wallet-fields').hidden, true);
  assert.deepEqual(f.calls, []); assert.equal(f.element('auth-registration-code').value, '');
});
test('optional signup password mismatch is refused before any wallet prompt', async () => {
  const f = fixture('password'); await signupVerified(f); f.element('auth-registration-password').value = 'long-synthetic-password'; f.element('auth-registration-password-confirm').value = 'different';
  await f.click('auth-registration-finish'); assert.deepEqual(f.calls, []); assert.match(f.element('auth-registration-status').textContent, /match/);
});
test('closing delayed signup mail clears fields and refuses late challenge or language revival', async () => {
  const f = fixture('password'); f.state.mailAvailable = true; await f.click('auth-registration-open');
  f.element('auth-registration-email').value = 'tester@example.invalid'; let release!: () => void;
  f.state.registrationHold = new Promise<void>(resolve => { release = resolve; }); const pending = f.click('auth-registration-start');
  await new Promise(resolve => setImmediate(resolve)); f.click('auth-registration-close'); release(); await pending;
  assert.equal(f.element('auth-registration').hidden, true); assert.equal(f.element('auth-registration-email').value, ''); assert.deepEqual(f.calls, []);
  for (const { id } of uiI18n.LOCALES) { uiI18n.setLocale(id, { persist: false }); assert.equal(f.element('auth-registration-status').textContent, ''); }
  uiI18n.setLocale('en', { persist: false }); assert.equal(f.state.registrationCancelled, true);
});
test('cancel during submitted signup prevents late automatic login', async () => {
  const f = fixture('password'); await signupVerified(f); let release!: () => void;
  f.state.registrationConfirmHold = new Promise<void>(resolve => { release = resolve; }); const pending = f.click('auth-registration-finish');
  await new Promise(resolve => setImmediate(resolve)); f.click('auth-registration-close'); release(); await pending;
  assert.equal(f.element('wallet-private').hidden, true); assert.equal(f.element('auth-registration').hidden, true); assert.throws(() => f.login.assert());
});
test('existing-account email migration keeps login available, clears OTP and signs out only after verification', async () => {
  const f = fixture('password'); f.state.mailAvailable = true; f.state.registeredEmail = null; await f.click('wallet-login'); await f.click('auth-manage-open');
  assert.equal(f.element('wallet-private').hidden, false); assert.match(f.element('auth-registration-account-state').textContent, /needs a verified/);
  let release!: () => void; f.state.registrationHold = new Promise<void>(resolve => { release = resolve; });
  f.element('auth-registration-account-email').value = 'tester@example.invalid'; const pending = f.click('auth-registration-account-start');
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.element('wallet-private').hidden, false); assert.equal(f.requests.some(r => r.path === 'account/change/commit'), false);
  release(); await pending;
  assert.equal(f.element('wallet-private').hidden, true); assert.equal(f.element('auth-registration-account-code').value, '');
  assert.equal(f.requests.filter(r => r.path === 'account/change/start').length, 1);
  assert.equal(f.requests.find(r => r.path === 'account/change/start').body.action, 'email.initial');
  assert.equal(f.requests.find(r => r.path === 'account/change/confirm').body.code, '12345678');
  assert.equal(f.dialogFields.every(field => field.type === 'checkbox' || field.value === ''), true);
});

for (const event of ['accountsChanged', 'chainChanged', 'disconnect']) test(`provider ${event} during signup signing cancels before account creation request`, async () => {
  const f = fixture('password'); await signupVerified(f); let release!: () => void;
  f.state.signatureHold = new Promise<void>(resolve => { release = resolve; }); const pending = f.click('auth-registration-finish');
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.calls.includes('personal_sign'), true); f.emit(event); release(); await pending;
  assert.equal(f.requests.some(r => r.path === 'registration/confirm'), false); assert.equal(f.element('wallet-private').hidden, true); assert.equal(f.element('auth-registration-email').value, '');
});
test('locale switches during verified signup retain consent-free form values without repeating requests', async () => {
  const f = fixture('password'); await signupVerified(f); f.element('auth-registration-password').value = 'synthetic-signup-password';
  const requests = f.requests.length;
  for (const { id } of uiI18n.LOCALES) { uiI18n.setLocale(id, { persist: false }); assert.equal(f.element('auth-registration-wallet-fields').hidden, false); assert.equal(f.element('auth-registration-password').value, 'synthetic-signup-password'); }
  assert.equal(f.requests.length, requests); assert.deepEqual(f.calls, []); f.click('auth-registration-close'); uiI18n.setLocale('en', { persist: false });
});

test('signup expiry cancels server-side pending registration and clears the verified proof', async () => {
  const f = fixture('password'); await signupVerified(f); const expiry = [...f.timers.values()].at(-1)!; expiry();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.state.registrationCancelled, true);
  assert.equal(f.element('auth-registration-wallet-fields').hidden, true); assert.equal(f.element('auth-registration-code-fields').hidden, true);
  await f.click('auth-registration-finish'); assert.deepEqual(f.calls, []);
});
test('legacy migration verifies reserved factors inside the exact combined flow without a generic reset proof', async () => {
  const f = fixture('password'); f.state.mailAvailable = true; f.state.reserved = true; f.state.registeredEmail = null;
  await f.click('wallet-login'); await f.click('auth-manage-open');
  assert.equal(f.element('auth-registration-account-start').disabled, false); assert.equal(f.element('auth-registration-change-help').hidden, true);
  f.element('auth-registration-account-email').value = 'tester@example.invalid'; await f.click('auth-registration-account-start');
  assert.equal(f.requests.find(r => r.path === 'account/change/verify').body.existingAnswer, f.state.changeAnswer);
  assert.equal(f.requests.some(r => r.path.startsWith('recovery/reset/')), false);
  assert.equal(f.requests.find(r => r.path === 'account/change/commit').body.changeProof, 'e'.repeat(43));
});

test('UI session fixture uses one clock instant and never fabricates an overlong session on a clock tick', async () => {
  const originalNow = Date.now; let tick = originalNow() - 1000, f: ReturnType<typeof fixture>;
  try { Date.now = () => ++tick; f = fixture('totp'); } finally { Date.now = originalNow; }
  assert.equal(f.session.expiresAt - f.session.issuedAt, 900000);
  await f.click('wallet-login'); assert.equal(f.element('wallet-private').hidden, false);
});

function passwordEntries(f: ReturnType<typeof fixture>, value = 'synthetic-new-password') {
  f.element('auth-new-password').value = value; f.element('auth-new-password-confirm').value = value;
}
test('passwordless registered account sets its first password through the actual handler without an old password', async () => {
  const f = fixture('wallet'); f.state.passwordBound = false;
  await f.click('wallet-login'); await f.click('auth-initial-open');
  assert.equal(f.element('auth-password-fields').hidden, false); assert.equal(f.element('auth-password-save').disabled, false);
  assert.equal(f.element('auth-password-save').textContent, uiI18n.t('account.passwordInitial'));
  assert.equal(f.element('auth-password-factor-help').hidden, true); assert.equal(f.element('auth-password-reset-help').hidden, true);
  assert.equal(f.element('auth-existing-fields').hidden, true);
  passwordEntries(f); const providerCalls = f.calls.length; await f.click('auth-password-save');
  const request = f.requests.find(r => r.path === 'account/change/commit');
  assert.deepEqual(request.body, { changeProof: 'e'.repeat(43) });
  assert.deepEqual(f.requests.find(r => r.path === 'account/change/start').body, { action: 'password.initial', newPassword: 'synthetic-new-password', identityMethod: 'wallet' });
  assert.equal(f.requests.find(r => r.path === 'account/change/verify').body.originalPassword, undefined);
  assert.equal(request.options.credentials, 'same-origin'); assert.equal(request.options.headers['X-Wallet-CSRF'], f.session.csrf);
  assert.equal(f.calls.slice(providerCalls).filter(method => method === 'personal_sign').length, 1);
  assert.equal(f.element('auth-new-password').value, ''); assert.equal(f.element('auth-new-password-confirm').value, '');
  assert.equal(f.element('wallet-private').hidden, true); assert.equal(f.element('auth-password-fields').hidden, true);
  assert.equal(f.element('wallet-login-status').textContent, uiI18n.t('account.passwordSaved')); assert.throws(() => f.login.assert());
});
test('password replacement uses bound state even when password login is disabled and never changes the enabled-method selection', async () => {
  const f = fixture('wallet'); f.state.passwordEnabled = false;
  await f.click('wallet-login'); await f.click('auth-manage-open');
  assert.equal(f.element('auth-enable-password').checked, false); assert.equal(f.element('auth-enable-wallet').checked, true);
  assert.equal(f.element('auth-password-save').textContent, uiI18n.t('account.passwordReplace'));
  passwordEntries(f); await f.click('auth-password-save');
  assert.deepEqual(f.requests.find(r => r.path === 'account/change/start').body, { action: 'password.replace', newPassword: 'synthetic-new-password', identityMethod: 'password' });
  assert.deepEqual(f.requests.find(r => r.path === 'account/change/commit').body, { changeProof: 'e'.repeat(43) });
  assert.equal(f.requests.some(r => r.body?.action === 'methods'), false);
});
for (const value of ['', 'short', '密'.repeat(342)]) test(`password validation rejects ${value ? value.length : 'empty'} characters before network activity and clears both inputs`, async () => {
  const f = fixture('password'); await f.click('wallet-login'); await f.click('auth-manage-open'); passwordEntries(f, value);
  const before = f.requests.length; await f.click('auth-password-save');
  assert.equal(f.requests.length, before); assert.equal(f.element('auth-password-status').textContent, uiI18n.t('account.passwordMismatch'));
  assert.equal(f.element('auth-new-password').value, ''); assert.equal(f.element('auth-new-password-confirm').value, '');
});
test('mismatched passwords are cleared without submitting or retaining them in localized output', async () => {
  const f = fixture('password'); await f.click('wallet-login'); await f.click('auth-manage-open'); passwordEntries(f);
  f.element('auth-new-password-confirm').value = 'synthetic-other-password'; await f.click('auth-password-save');
  assert.equal(f.requests.some(r => r.path === 'account/change/start' || r.path === 'account/change/commit'), false);
  for (const { id } of uiI18n.LOCALES) { uiI18n.setLocale(id, { persist: false }); assert.equal(f.element('auth-new-password').value, ''); assert.equal(f.element('auth-new-password-confirm').value, ''); assert.equal(f.element('auth-password-status').textContent.includes('synthetic'), false); }
  uiI18n.setLocale('en', { persist: false });
});
for (const method of ['wallet-local', 'totp', 'recovery']) test(`initial setup from ${method} chooses registered wallet without an automatic connection or signature`, async () => {
  const f = fixture(method === 'recovery' ? 'totp' : method); await f.ready;
  if (method === 'recovery') { f.session.kind = 'recovery'; f.element('auth-recovery').checked = true; }
  if (method !== 'wallet-local') await f.click('wallet-login');
  const calls = f.calls.length; await f.click('auth-initial-open');
  assert.equal(f.element('wallet-login-method').value, 'wallet'); assert.equal(f.calls.length, calls);
  assert.equal(f.element('auth-password-fields').hidden, true); assert.equal(f.element('auth-password-save').disabled, true);
});
test('initial setup overrides an unauthenticated Password selection without asking for a nonexistent password', async () => {
  const f = fixture('password'); await f.ready; await f.click('auth-initial-open');
  assert.equal(f.element('wallet-login-method').value, 'wallet'); assert.equal(f.element('auth-password-label').hidden, true);
  assert.equal(f.element('auth-password').value, ''); assert.equal(f.element('auth-new-password').disabled, true);
  assert.deepEqual(f.calls, []); assert.deepEqual(f.requests.map(r => r.path), ['capabilities']);
});
test('initial setup preserves an already authenticated fresh independent password session', async () => {
  const f = fixture('password'); await f.click('wallet-login'); const binding = f.login.capture(), calls = f.calls.length;
  await f.click('auth-initial-open'); f.login.assert(binding);
  assert.equal(f.element('wallet-login-method').value, 'password'); assert.equal(f.element('auth-password-fields').hidden, false);
  assert.equal(f.calls.length, calls); assert.equal(f.requests.some(r => r.path === 'logout'), false);
});
for (const fresh of [false, true]) test(`unsupported password-management capability explains the same-origin upgrade with ${fresh ? 'fresh login' : 'public settings'}`, async () => {
  const f = fixture('password'); await f.ready; f.state.passwordManagement = false;
  if (fresh) await f.click('wallet-login'); await f.click('auth-manage-open');
  assert.equal(f.element('auth-password-state').textContent, uiI18n.t('account.passwordUpgrade'));
  assert.equal(f.element('auth-password-fields').hidden, true); assert.equal(f.element('auth-new-password').disabled, true);
  passwordEntries(f); await f.click('auth-password-save'); assert.equal(f.requests.some(r => r.path === 'account/change/start' || r.path === 'account/change/commit'), false);
  assert.equal(f.element('auth-new-password').value, '');
});
for (const method of ['totp', 'password']) test(`${method === 'totp' ? 'authenticator-only' : 'stale independent'} session cannot write a password`, async () => {
  const f = fixture(method); f.state.stale = method === 'password'; await f.click('wallet-login'); await f.click('auth-manage-open');
  assert.equal(f.element('auth-password-fields').hidden, true); assert.equal(f.element('auth-password-save').disabled, true);
  passwordEntries(f); await f.click('auth-password-save'); assert.equal(f.requests.some(r => r.path === 'account/change/start' || r.path === 'account/change/commit'), false);
  assert.equal(f.element('auth-new-password').value, '');
});
for (const bound of [false, true]) test(`${bound ? 'replacement' : 'initial password'} verifies all configured factors again after refusal`, async () => {
  const f = fixture('wallet'); f.state.passwordBound = bound; f.state.enrolled = true; f.state.reserved = true; f.state.mailAvailable = true;
  await f.click('wallet-login'); await f.click('auth-manage-open');
  assert.equal(f.element('auth-password-factor-help').hidden, false); assert.equal(f.element('auth-password-reset-help').hidden, true);
  assert.equal(f.element('auth-password-save').disabled, false);
  f.state.rejectPath = 'account/change/verify'; passwordEntries(f); f.state.changeCode = 'wrong'; await f.click('auth-password-save');
  assert.equal(f.requests.some(r => r.path === 'account/change/commit'), false);
  f.state.rejectPath = ''; passwordEntries(f); f.state.changeCode = 'synthetic-unused-recovery'; await f.click('auth-password-save');
  const sent = f.requests.filter(r => r.path === 'account/change/start'); assert.equal(sent.length, 2);
  assert.equal(sent.every(r => r.body.resetProof === undefined && r.body.action === `password.${bound ? 'replace' : 'initial'}`), true);
  const verified = f.requests.filter(r => r.path === 'account/change/verify'); assert.deepEqual(verified.map(r => r.body.existingCode), ['wrong', 'synthetic-unused-recovery']);
  assert.equal(verified.every(r => r.body.existingAnswer === f.state.changeAnswer && r.body.recovery === true), true);
  assert.equal(f.requests.filter(r => r.path === 'account/change/confirm').length, 1);
  assert.deepEqual(f.requests.find(r => r.path === 'account/change/commit').body, { changeProof: 'e'.repeat(43) });
  assert.equal(f.dialogFields.every(field => field.type === 'checkbox' || field.value === ''), true);
});
test('repeated password clicks submit once and cancellation clears inputs before a late result', async () => {
  const f = fixture('password'); await f.click('wallet-login'); await f.click('auth-manage-open'); passwordEntries(f);
  let release!: () => void; f.state.passwordHold = new Promise<void>(resolve => { release = resolve; });
  const pending = f.click('auth-password-save'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.element('auth-new-password').value, ''); assert.equal(f.element('auth-new-password-confirm').value, '');
  assert.equal(f.element('auth-password-save').disabled, true); await f.click('auth-password-save'); await f.click('auth-password-cancel'); release(); await pending;
  assert.equal(f.requests.filter(r => r.path === 'account/change/commit').length, 1); assert.equal(f.element('wallet-private').hidden, true);
  assert.equal(f.element('wallet-login-status').textContent, uiI18n.t('account.passwordSubmitted'));
});
test('cancel before a live-session check finishes cannot submit the captured password later', async () => {
  const f = fixture('password'); await f.click('wallet-login'); await f.click('auth-manage-open'); passwordEntries(f);
  let release!: () => void; f.state.sessionHold = new Promise<void>(resolve => { release = resolve; });
  const pending = f.click('auth-password-save'); await new Promise(resolve => setImmediate(resolve)); await f.click('auth-password-cancel'); release(); await pending;
  assert.equal(f.requests.some(r => r.path === 'account/change/start' || r.path === 'account/change/commit'), false); assert.equal(f.element('wallet-private').hidden, true);
});
for (const event of ['auth-password-cancel', 'auth-management-close', 'wallet-logout', 'popstate', 'keydown', 'pagehide', 'pageshow', 'accountsChanged', 'chainChanged', 'disconnect']) test(`${event} clears unsent password fields and locale changes cannot revive them`, async () => {
  const f = fixture('password'); await f.click('wallet-login'); await f.click('auth-manage-open'); passwordEntries(f);
  if (['accountsChanged', 'chainChanged', 'disconnect'].includes(event)) f.emit(event);
  else if (f.windowEvents.has(event)) f.windowEvents.get(event)!({ key: 'Escape', persisted: true });
  else await f.click(event);
  for (const { id } of uiI18n.LOCALES) { uiI18n.setLocale(id, { persist: false }); assert.equal(f.element('auth-new-password').value, ''); assert.equal(f.element('auth-new-password-confirm').value, ''); }
  assert.equal(f.requests.some(r => r.path === 'account/change/start' || r.path === 'account/change/commit'), false); uiI18n.setLocale('en', { persist: false });
});
test('management freshness expiry clears password entry and refuses submission', async () => {
  const f = fixture('password'); await f.click('wallet-login'); await f.click('auth-manage-open'); passwordEntries(f);
  const expire = [...f.timers.values()].at(-1)!; const originalNow = Date.now;
  try { Date.now = () => f.session.issuedAt + 300001; expire(); assert.equal(f.element('auth-new-password').value, ''); assert.equal(f.element('auth-password-fields').hidden, true); await f.click('auth-password-save'); }
  finally { Date.now = originalNow; }
  assert.equal(f.requests.some(r => r.path === 'account/change/start' || r.path === 'account/change/commit'), false);
});
test('close invalidates delayed capability results and never exposes password controls', async () => {
  const f = fixture('password'); let release!: () => void; f.state.capabilitiesHold = new Promise<void>(resolve => { release = resolve; });
  const pending = f.click('auth-initial-open'); await new Promise(resolve => setImmediate(resolve)); f.click('auth-management-close'); release(); await pending;
  assert.equal(f.element('auth-management').hidden, true); assert.equal(f.element('auth-password-fields').hidden, true); assert.deepEqual(f.calls, []);
});
for (const failure of ['passwordBadResponse', 'passwordNetworkFailure'] as const) test(`${failure} locks the account and does not automatically replay the password write`, async () => {
  const f = fixture('password'); await f.click('wallet-login'); await f.click('auth-manage-open'); passwordEntries(f); f.state[failure] = true;
  await f.click('auth-password-save'); assert.equal(f.requests.filter(r => r.path === 'account/change/commit').length, 1);
  assert.equal(f.element('wallet-private').hidden, true); assert.equal(f.element('wallet-login-status').textContent, uiI18n.t('account.passwordSubmitted'));
  assert.equal(f.element('auth-new-password').value, '');
});
for (const code of ['AUTH_UNAVAILABLE', 'AUTH_UNEXPECTED_SERVER_FAILURE', 'malformed-error']) test(`${code} after password submission is treated as an unknown outcome and cannot be replayed`, async () => {
  const f = fixture('password'); await f.click('wallet-login'); await f.click('auth-manage-open'); passwordEntries(f);
  f.state.rejectPath = 'account/change/commit'; f.state.rejectCode = code; await f.click('auth-password-save');
  assert.equal(f.element('wallet-private').hidden, true); assert.equal(f.element('auth-password-fields').hidden, true);
  assert.equal(f.element('wallet-login-status').textContent, uiI18n.t('account.passwordSubmitted')); assert.throws(() => f.login.assert());
  passwordEntries(f); await f.click('auth-password-save'); assert.equal(f.requests.filter(r => r.path === 'account/change/commit').length, 1);
  assert.equal(f.element('auth-new-password').value, ''); assert.equal(f.element('auth-new-password-confirm').value, '');
});
for (const code of ['AUTH_RECENT_INDEPENDENT_LOGIN_REQUIRED', 'AUTH_SETUP_STATE_CHANGED']) test(`${code} ends stale password management instead of retrying old account state`, async () => {
  const f = fixture('password'); await f.click('wallet-login'); await f.click('auth-manage-open'); passwordEntries(f);
  f.state.rejectPath = 'account/change/commit'; f.state.rejectCode = code; await f.click('auth-password-save');
  assert.equal(f.element('wallet-private').hidden, true); assert.equal(f.element('auth-password-fields').hidden, true);
  assert.equal(f.requests.filter(r => r.path === 'account/change/commit').length, 1); assert.equal(f.element('auth-new-password').value, '');
});
test('password recovery link stays within the open workflow without history navigation or automatic requests', async () => {
  const f = fixture('password'); f.state.reserved = true; f.state.mailAvailable = true; await f.click('wallet-login'); await f.click('auth-manage-open');
  let prevented = false, focused = false, scrolled = false;
  f.element('auth-reset-answer').focus = () => { focused = true; }; f.element('auth-recovery-settings').scrollIntoView = () => { scrolled = true; };
  const requests = f.requests.length, calls = f.calls.length;
  f.element('auth-password-recovery-link').handlers.get('click')({ preventDefault() { prevented = true; } });
  assert.equal(prevented && focused && scrolled, true); assert.equal(f.element('auth-management').hidden, false);
  assert.equal(f.requests.length, requests); assert.equal(f.calls.length, calls);
});
for (const action of ['cancel', 'expire']) test(`reset proof ${action} clears password entry and cannot bypass fresh combined verification`, async () => {
  const f = fixture('password'); f.state.reserved = true; f.state.mailAvailable = true; await f.click('wallet-login'); await f.click('auth-manage-open');
  f.element('auth-reset-answer').value = 'synthetic private recovery phrase'; await f.click('auth-reset-start');
  f.element('auth-email-code').value = '12345678'; await f.click('auth-email-confirm'); passwordEntries(f);
  if (action === 'cancel') await f.click('auth-email-cancel'); else [...f.timers.values()].at(-1)!();
  assert.equal(f.element('auth-new-password').value, ''); assert.equal(f.element('auth-new-password-confirm').value, '');
  await f.click('auth-password-save'); assert.equal(f.requests.some(r => r.path === 'account/change/start' || r.path === 'account/change/commit'), false);
  passwordEntries(f); await f.click('auth-password-save');
  assert.equal(f.requests.filter(r => r.path === 'account/change/verify').length, 1);
  assert.equal(f.requests.find(r => r.path === 'account/change/verify').body.existingAnswer, f.state.changeAnswer);
  assert.equal(f.requests.find(r => r.path === 'account/change/start').body.resetProof, undefined);
});

for (const button of ['auth-initial-open', 'auth-manage-open']) {
  for (const tenant of ['default', 'xiongan']) test(`delayed ${tenant} profile ignores premature ${button} events`, async () => {
    let resolve!: (profile: any) => void;
    const pending = new Promise<any>(r => { resolve = r; });
    const f = fixture('password', pending);
    assert.equal(f.element(button).disabled, true);
    await f.click(button); await f.click(button);
    assert.equal(f.element('auth-management').hidden, true);
    assert.equal(f.requests.length, 0);
    resolve({ tenant: { id: tenant }, deployment: { url: `https://${tenant === 'default' ? '' : 'xiongan.'}8415wallet.com/web/index.html` } });
    await f.ready; await Promise.resolve();
    assert.equal(f.element('auth-management').hidden, true);
    assert.equal(f.requests.length, 0);
    assert.equal(f.element(button).disabled, tenant === 'default');
    assert.equal(f.element(button).hidden, tenant === 'default');
    await f.click(button);
    assert.equal(f.element('auth-management').hidden, tenant === 'default');
    assert.equal(f.requests.some(r => r.path === 'capabilities'), tenant !== 'default');
  });
}
for (const button of ['auth-initial-open', 'auth-manage-open']) test(`refused profile keeps ${button} disabled and request-free`, async () => {
  const f = fixture('password', Promise.reject(Error('RELEASE_LOCATION_MISMATCH')));
  await f.ready.catch(() => {}); await Promise.resolve();
  await f.click(button);
  assert.equal(f.element(button).disabled, true);
  assert.equal(f.element('auth-management').hidden, true);
  assert.equal(f.requests.length, 0);
});


for (const event of ['auth-management-close', 'wallet-logout', 'popstate', 'keydown', 'pagehide', 'accountsChanged', 'expire']) test(`${event} closes the real combined identity dialog and clears unsent factors without starting a change`, async () => {
  const f = fixture('password'); f.state.enrolled = true; f.state.reserved = true;
  await f.click('wallet-login'); await f.click('auth-manage-open'); f.state.dialogHold = true;
  const pending = f.click('auth-enroll-start'); await new Promise(resolve => setImmediate(resolve));
  const dialog = f.document.body.children.find(node => node.tagName === 'dialog'); assert.ok(dialog);
  const inputs = descendants(dialog).filter(node => node.tagName === 'input' && node.type !== 'checkbox');
  assert.equal(inputs.length, 3); for (const input of inputs) input.value = 'synthetic unsent factor';
  assert.equal(f.requests.some(r => r.path === 'account/change/start'), false);
  if (event === 'expire') [...f.timers.values()].at(-1)!();
  else if (event === 'accountsChanged') f.emit(event);
  else if (f.windowEvents.has(event)) f.windowEvents.get(event)!({ key: 'Escape', persisted: true });
  else await f.click(event);
  await pending;
  assert.equal(f.document.body.children.length, 0); assert.equal(inputs.every(input => input.value === ''), true);
  assert.equal(f.requests.some(r => r.path === 'account/change/start' || r.path === 'account/change/commit'), false);
  for (const { id } of uiI18n.LOCALES) { uiI18n.setLocale(id, { persist: false }); assert.equal(f.element('auth-enroll-secret').textContent, ''); }
  uiI18n.setLocale('en', { persist: false });
});
