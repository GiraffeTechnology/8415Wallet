import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Wallet, verifyMessage, getAddress, hashMessage, Interface, getBytes } from 'ethers';
import { WalletLogin, WalletLoginError } from '../web/login-core.mjs';
const source = readFileSync(new URL('../web/wallet-auth.mjs', import.meta.url), 'utf8')
  .replace(/^import[^\n]*\n/gm, '').replace(/^export \{[^\n]*\n/gm, '').replace('export const walletLogin', 'const walletLogin');
function deferred() { let resolve!: () => void; return { promise: new Promise<void>(r => { resolve = r; }), resolve: () => resolve() }; }
function fixture() {
  const signer = Wallet.createRandom(), calls: string[] = [], elements = new Map<string, any>(), lifecycle = new Map<string, (event?: any) => void>();
  const config = deferred();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, { hidden: id === 'wallet-private' || id === 'wallet-logout', inert: id === 'wallet-private', textContent: '', disabled: false,
      handlers: new Map(), addEventListener(event: string, handler: () => unknown) { this.handlers.set(event, handler); } });
    return elements.get(id);
  };
  const provider = { on() {}, removeListener() {}, async request({ method, params }: any) {
    calls.push(method);
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [signer.address];
    if (method === 'eth_chainId') return '0x1';
    if (method === 'eth_getCode') return '0x';
    if (method === 'personal_sign') return signer.signMessage(getBytes(params[0]));
    throw new Error('Unexpected provider method');
  } };
  const sdk = { WalletLogin, WalletLoginError, verifyMessage, getAddress, hashMessage, Interface,
    getReleaseProfile: () => config.promise, acquireWalletUi: () => Symbol(), releaseWalletUi() {} };
  const login = new Function('document', 'globalThis', 'setTimeout', 'clearTimeout', ...Object.keys(sdk), `${source}\nreturn walletLogin;`)(
    { getElementById: element, addEventListener: (event: string, callback: any) => lifecycle.set(event, callback) },
    { ethereum: provider, location: { origin: 'https://wallet.example.invalid:18443' }, addEventListener: (event: string, callback: any) => lifecycle.set(event, callback) },
    () => 1, () => {}, ...Object.values(sdk));
  return { config, calls, element, login, click: (id: string) => element(id).handlers.get('click')(), event: (name: string, value?: any) => lifecycle.get(name)!(value) };
}
for (const cancel of ['logout', 'pagehide', 'restored-page']) test(`actual login handler ${cancel} cancels before a delayed release profile can request signing`, async () => {
  const f = fixture(), pending = f.click('wallet-login'); assert.deepEqual(f.calls, []);
  if (cancel === 'logout') f.click('wallet-logout');
  if (cancel === 'pagehide') f.event('pagehide');
  if (cancel === 'restored-page') f.event('pageshow', { persisted: true });
  f.config.resolve(); await pending;
  assert.deepEqual(f.calls, []); assert.equal(f.element('wallet-private').hidden, true); assert.throws(() => f.login.assert(), /LOGIN_REQUIRED/);
  await f.click('wallet-login'); assert.equal(f.element('wallet-private').hidden, false); assert.equal(f.calls.filter(v => v === 'personal_sign').length, 1);
  f.click('wallet-logout'); assert.equal(f.element('wallet-private').hidden, true);
});
test('actual login handler coalesces repeat clicks while release profile is pending', async () => {
  const f = fixture(), pending = f.click('wallet-login'); await f.click('wallet-login'); f.config.resolve(); await pending;
  assert.equal(f.calls.filter(v => v === 'personal_sign').length, 1); assert.equal(f.element('wallet-private').hidden, false);
});
