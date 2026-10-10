/** Deterministic management-dialog lifecycle tests, not physical-browser acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeMethodChange, commitMethodChange, cancelMethodChangeUi } from '../web/method-change-ui.mjs';
import { setLocale } from '../web/i18n.mjs';
const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
class Element {
  tagName: string; children: Element[] = []; parentElement: Element | null = null; handlers = new Map<string, Function[]>();
  attributes = new Map<string, string>(); textContent = ''; value = ''; type = ''; hidden = false; open = false; checked = false;
  isConnected = true; className = ''; id = '';
  constructor(tag: string) { this.tagName = tag; }
  append(child: Element) { this.children.push(child); child.parentElement = this; if (this.tagName === 'select' && this.children.length === 1) this.value = child.value; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  addEventListener(name: string, handler: Function) { const values = this.handlers.get(name) ?? []; values.push(handler); this.handlers.set(name, values); }
  fire(name: string) { for (const handler of this.handlers.get(name) ?? []) handler({ preventDefault() {} }); }
  showModal() { this.open = true; }
  close() { this.open = false; this.fire('close'); }
  focus() {}
  remove() { this.isConnected = false; if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); }
}
function all(root: Element): Element[] { return [root, ...root.children.flatMap(all)]; }
async function spin(predicate: () => boolean) { for (let n = 0; n < 100; n++) { if (predicate()) return; await new Promise(resolve => setImmediate(resolve)); } assert.fail('Expected dialog transition did not occur'); }
function fixture(t: any, options: any = {}) {
  const previous = (globalThis as any).document, body = new Element('body');
  (globalThis as any).document = { body, activeElement: null, createElement: (tag: string) => new Element(tag) };
  const state = { origin: 'https://wallet.example.invalid', tenant: 'xiongan', account: `0x${'1'.repeat(40)}`, chainId: '1',
    methods: { password: { bound: !options.passwordless }, wallet: { enabled: true } }, authenticator: { enrolled: !!options.enrolled }, recovery: { configured: !!options.recovery, questionId: 'recovery-phrase' },
    management: { reauthenticateBy: Date.now() + 300_000 } };
  const calls: any[] = [], signatures: any[] = []; let intent: any, valid = true;
  const client = { async change(action: string, input: any = {}) {
    calls.push({ action, input: structuredClone(input) });
    if (action === 'start') { intent = structuredClone(input); return { ...state, changeId: 'c'.repeat(43), action: intent.action, factor: input.identityMethod,
      message: `Purpose: ${intent.action}; no login or transaction authority\nOrigin: ${state.origin}\nAccount: ${state.account}`,
      emailMasked: 'v***@example.invalid', expiresAt: state.management.reauthenticateBy }; }
    if (action === 'verify') { await options.verifyGate?.(); return { changeId: 'c'.repeat(43), digits: 8, emailMasked: 'v***@example.invalid', expiresAt: state.management.reauthenticateBy }; }
    if (action === 'confirm') { await options.confirmGate?.(); return { changeProof: 'p'.repeat(43), action: options.wrongAction ?? intent.action, expiresAt: Date.now() + 110_000,
      newEmailRequired: !!options.newEmail, ...(options.newEmail ? { emailMasked: 'n***@example.invalid' } : {}),
      ...(intent.action.startsWith('totp.') && intent.action !== 'totp.unbind' ? { secret: SECRET, uri: `otpauth://totp/synthetic?secret=${SECRET}` } : {}) }; }
    if (action === 'commit') return { updated: true, loggedOut: true, action: intent.action };
    return { cancelled: true };
  } };
  const provider = { async request(request: any) { signatures.push(request); await options.signatureGate?.(); return `0x${'1'.repeat(130)}`; } };
  const dialog = () => body.children.find(element => element.tagName === 'dialog')!;
  const field = (label: string) => all(dialog()).find(element => element.tagName === 'label' && element.children.some(child => child.textContent === label))?.children.find(child => child.tagName === 'input');
  const choose = (method: string) => { const select = all(dialog()).find(element => element.tagName === 'select')!; select.value = method; select.fire('change'); };
  const submit = () => all(dialog()).find(element => element.tagName === 'form')!.fire('submit');
  const begin = (input: any) => authorizeMethodChange({ client, intent: input, state, provider, isCurrent: () => valid });
  const email = async () => { await spin(() => !!dialog() && !!field('Eight-digit email code')); field('Eight-digit email code')!.value = '12345678'; submit(); };
  t.after(() => { cancelMethodChangeUi(); (globalThis as any).document = previous; setLocale('en', { document: null, persist: false }); });
  return { state, client, calls, signatures, begin, choose, submit, field, dialog, email, revoke: () => { valid = false; }, isCurrent: () => valid };
}

test('management dialog collects original password and current factors once, then a fresh email OTP for exact intent', async t => {
  const f = fixture(t, { enrolled: true, recovery: true }), intent = { action: 'password.replace', newPassword: 'synthetic new password' };
  const pending = f.begin(intent); f.choose('password');
  f.field('Original password')!.value = 'synthetic original password'; f.field('Current authenticator or saved recovery code')!.value = '123456';
  f.field('Existing security answer')!.value = 'synthetic answer phrase'; f.submit(); await f.email();
  const proof = await pending; assert.equal(proof.action, 'password.replace'); assert.equal(intent.newPassword, ''); assert.equal(f.signatures.length, 0);
  assert.deepEqual(f.calls.map(call => call.action), ['start', 'verify', 'confirm']);
  assert.equal(f.calls[1].input.originalPassword, 'synthetic original password'); assert.equal(f.calls[1].input.existingCode, '123456');
  assert.equal(f.dialog(), undefined);
  const result = await commitMethodChange({ client: f.client, proof, state: f.state, isCurrent: f.isCurrent }); assert.equal(result.loggedOut, true);
});
test('passwordless initial enrollment asks only for registered-wallet signature and email code', async t => {
  const f = fixture(t, { passwordless: true }); const pending = f.begin({ action: 'totp.initial' }); f.choose('wallet');
  assert.equal(f.field('Original password')!.parentElement!.hidden, true); assert.equal(f.field('Current authenticator or saved recovery code'), undefined);
  f.submit(); await f.email(); const proof = await pending;
  assert.equal(f.signatures.length, 1); assert.equal(f.signatures[0].method, 'personal_sign'); assert.equal(f.calls[1].input.originalPassword, undefined);
  assert.equal(proof.secret, SECRET); assert.equal(f.calls.some(call => call.action === 'commit'), false);
});
test('explicit bound-wallet selection supports lost password without calling it a trusted device', async t => {
  const f = fixture(t); const pending = f.begin({ action: 'password.replace', newPassword: 'synthetic new password' });
  f.field('Original password')!.value = 'must be cleared'; f.choose('wallet'); assert.equal(f.field('Original password')!.value, '');
  f.submit(); await f.email(); await pending;
  assert.equal(f.calls[0].input.identityMethod, 'wallet'); assert.equal(f.calls[1].input.originalPassword, undefined); assert.equal(f.signatures.length, 1);
});
test('Cancel clears visible input and refuses late wallet-signature completion', async t => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(t, { passwordless: true, signatureGate: () => gate }); const pending = f.begin({ action: 'totp.initial' }); const rejection = assert.rejects(pending, /LOGIN_CANCELLED/);
  f.choose('wallet'); f.submit(); await spin(() => f.signatures.length === 1); cancelMethodChangeUi(); release(); await rejection;
  assert.equal(f.dialog(), undefined); assert.equal(f.calls.some(call => call.action === 'verify'), false);
});
test('identity/session change discards a late email confirmation without exposing the new seed', async t => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(t, { confirmGate: () => gate }); const pending = f.begin({ action: 'totp.initial' }); const rejection = assert.rejects(pending, /LOGIN_CANCELLED/);
  f.choose('password'); f.field('Original password')!.value = 'synthetic'; f.submit(); await f.email(); await spin(() => f.calls.some(call => call.action === 'confirm'));
  f.revoke(); cancelMethodChangeUi(); release(); await rejection; assert.equal(f.dialog(), undefined); assert.equal(f.calls.some(call => call.action === 'commit'), false);
});
test('changing locale leaves private inputs and verification state in place without another API request', async t => {
  const f = fixture(t); const pending = f.begin({ action: 'methods', enabledMethods: ['wallet'] }); const rejection = assert.rejects(pending, /LOGIN_CANCELLED/);
  f.choose('password'); const password = f.field('Original password')!; password.value = 'synthetic unsent password';
  setLocale('zh-Hans', { document: null, persist: false }); assert.equal(password.value, 'synthetic unsent password'); assert.equal(f.calls.length, 0);
  cancelMethodChangeUi(); await rejection; assert.equal(password.value, '');
});
test('different new email is verified before commit', async t => {
  const f = fixture(t, { newEmail: true }); const pending = f.begin({ action: 'email.replace', email: 'new@example.invalid' });
  f.choose('password'); f.field('Original password')!.value = 'synthetic'; f.submit(); await f.email(); const proof = await pending;
  const committing = commitMethodChange({ client: f.client, proof, state: f.state, isCurrent: f.isCurrent }); await f.email(); await committing;
  assert.equal(f.calls.at(-1).action, 'commit'); assert.equal(f.calls.at(-1).input.newEmailCode, '12345678');
});

test('a cross-action server response cannot be consumed or expose an unrelated method', async t => {
  const f = fixture(t, { wrongAction: 'totp.unbind' }); const pending = f.begin({ action: 'totp.initial' });
  const rejection = assert.rejects(pending, /LOGIN_SERVER_RESPONSE_REFUSED/);
  f.choose('password'); f.field('Original password')!.value = 'synthetic'; f.submit(); await f.email(); await rejection;
  assert.equal(f.calls.some(call => call.action === 'commit'), false); assert.equal(f.dialog(), undefined);
});
