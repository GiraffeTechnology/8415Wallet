import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ControlAdapterError } from '../src/controls/authorization.ts';
import { parseLegacyClearingDeployment, CLEARING_NOTES } from '../src/wallet/legacyClearingSession.ts';

// Actual module handlers at deterministic DOM/provider boundaries. These tests
// are not genuine-wallet, physical-device or public-testnet acceptance.
const source = readFileSync(new URL('../web/legacy-clearing.mjs', import.meta.url), 'utf8').replace(/^import[\s\S]*?;\r?\n/gm, '');
const actor = `0x${'a'.repeat(40)}`, digest = `0x${'b'.repeat(64)}`;
function fixture() {
  const elements = new Map<string, any>(), events = new Map<string, () => void>(), lifecycle = new Map<string, (event: any) => void>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, { value: '', textContent: '', checked: false, files: [], disabled: false, handlers: new Map(), innerHTML: '',
      addEventListener(name: string, fn: (...args: any[]) => unknown) { this.handlers.set(name, fn); },
      querySelectorAll() { return [...elements.values()]; } });
    return elements.get(id);
  };
  for (const match of source.matchAll(/id="([^"]+)"/g)) element(match[1]!);
  let sends = 0, connects = 0, verifications = 0;
  const hooks = { profile: async (): Promise<unknown> => ({}), connect: async (): Promise<unknown> => [actor],
    verify: async (): Promise<unknown> => undefined, prepare: async (): Promise<any> => ({ digest, tradeKey: digest, facts: '{}', transaction: {} }),
    send: async (): Promise<any> => digest, status: async (): Promise<any> => ({ status: 'idle' }) };
  class Session {
    verify() { verifications++; return hooks.verify(); }
    status() { return hooks.status(); }
    prepare() { return hooks.prepare(); }
    submit() { sends++; return hooks.send(); }
    observe() { return Promise.resolve({ trade: 'read-only' }); }
    reconcile() { return Promise.resolve({ state: 'confirmed' }); }
    acknowledge() { return Promise.resolve(); }
    recover() { return Promise.resolve({ state: 'confirmed' }); }
    acknowledgeReplacement() { return Promise.resolve({ originalOutcome: 'superseded-not-successful' }); }
  }
  const provider = { request() {}, on(name: string, fn: () => void) { events.set(name, fn); } };
  const sdk = { LegacyClearingSession: Session, BrowserLegacyClearingStore: class {}, parseLegacyClearingDeployment, CLEARING_NOTES, ControlAdapterError,
    getReleaseProfile: () => hooks.profile(), controlRpc: () => { connects++; return hooks.connect(); }, acquireWalletUi: () => Symbol(), releaseWalletUi() {} };
  new Function('document', 'globalThis', ...Object.keys(sdk), source)({ getElementById: element, querySelectorAll: () => [...elements.values()] }, { ethereum: provider, addEventListener: (name: string, fn: (event: any) => void) => lifecycle.set(name, fn) }, ...Object.values(sdk));
  element('clearing-deployment').files = [{ size: 1, text: async () => JSON.stringify({ schema: '8415-legacy-clearing/1', chainId: '31337',
    escrow: { address: `0x${'c'.repeat(40)}`, runtimeCodeHash: digest }, projection: { address: `0x${'d'.repeat(40)}`, runtimeCodeHash: digest }, registerId: digest, verificationProfile: digest }) }];
  const click = async (id: string, type = 'click') => element(id).handlers.get(type)?.();
  return { element, click, hooks, lifecycle: (name: string) => lifecycle.get(name)!({ persisted: true }), emit: (name: string) => events.get(name)!(), counts: () => ({ sends, connects, verifications }),
    async connect() { await click('clearing-deployment', 'change'); await click('clearing-connect'); } };
}
function deferred() { let resolve!: (value: any) => void; return { promise: new Promise<any>(r => { resolve = r; }), resolve: (value: any) => resolve(value) }; }
test('release-profile refusal blocks wallet connection and all clearing operations', async () => {
  const f = fixture(); f.hooks.profile = async () => { throw new Error('RELEASE_LOCATION_MISMATCH'); };
  await f.connect(); await f.click('clearing-review-open'); await f.click('clearing-send');
  assert.deepEqual(f.counts(), { sends: 0, connects: 0, verifications: 0 }); assert.equal(f.element('clearing-result').textContent, 'CLEARING_UI_OPERATION_REFUSED');
});
test('actual clearing handlers require acknowledgement and discard the review after one send', async () => {
  const f = fixture(); await f.connect(); await f.click('clearing-review-open'); await f.click('clearing-send');
  assert.equal(f.counts().sends, 0); assert.match(f.element('clearing-result').textContent, /OWNER_REVIEW_REQUIRED/);
  f.element('clearing-acknowledge').checked = true; await f.click('clearing-send'); assert.equal(f.counts().sends, 1);
  await f.click('clearing-send'); assert.equal(f.counts().sends, 1); assert.equal(f.element('clearing-acknowledge').checked, false);
});
test('clearing Cancel and edited inputs invalidate unsent reviews', async () => {
  const f = fixture(); await f.connect();
  for (const [id, event] of [['clearing-cancel-review', 'click'], ['clearing-price', 'input']]) {
    await f.click('clearing-review-open'); f.element('clearing-acknowledge').checked = true; await f.click(id!, event!); await f.click('clearing-send');
    assert.equal(f.element('clearing-review').textContent, 'No clearing review prepared'); assert.equal(f.counts().sends, 0);
  }
});
test('late clearing review cannot survive an account or chain change', async () => {
  for (const event of ['accountsChanged', 'chainChanged', 'disconnect']) {
    const f = fixture(); await f.connect(); const gate = deferred(), entered = deferred();
    f.hooks.prepare = async () => { entered.resolve(null); return gate.promise; };
    const work = f.click('clearing-review-open'); await entered.promise; f.emit(event); gate.resolve({ digest, tradeKey: digest, facts: '{}' }); await work;
    assert.equal(f.element('clearing-review').textContent, 'No clearing review prepared'); assert.equal(f.element('clearing-result').textContent, 'CLEARING_CONNECTION_CHANGED'); assert.equal(f.counts().sends, 0);
  }
});
test('failed clearing reconnect cannot preserve the old session', async () => {
  const f = fixture(); await f.connect(); f.hooks.connect = async () => { throw new Error('private provider diagnostics'); };
  await f.click('clearing-connect'); await f.click('clearing-observe');
  assert.equal(f.element('clearing-result').textContent, 'CLEARING_CONNECTION_REQUIRED'); assert.equal(f.counts().sends, 0);
});
test('double send clicks reach at most one wallet request and raw provider failures stay sanitized', async () => {
  const f = fixture(); await f.connect(); await f.click('clearing-review-open'); f.element('clearing-acknowledge').checked = true;
  const gate = deferred(), entered = deferred(); f.hooks.send = async () => { entered.resolve(null); return gate.promise; };
  const first = f.click('clearing-send'); await entered.promise; await f.click('clearing-send'); gate.resolve(digest); await first;
  assert.equal(f.counts().sends, 1);
  f.hooks.prepare = async () => { throw new Error('private API key or provider response'); }; await f.click('clearing-review-open');
  assert.equal(f.element('clearing-result').textContent, 'CLEARING_UI_OPERATION_REFUSED');
});


test('clearing review and connection do not survive page exit or history restoration', async () => {
  for (const event of ['pagehide', 'pageshow']) {
    const f = fixture(); await f.connect(); await f.click('clearing-review-open');
    f.element('clearing-acknowledge').checked = true; f.lifecycle(event);
    await f.click('clearing-send'); assert.equal(f.counts().sends, 0);
    assert.equal(f.element('clearing-acknowledge').checked, false);
    assert.equal(f.element('clearing-review').textContent, 'No clearing review prepared');
    assert.equal(f.element('clearing-result').textContent, 'CLEARING_OWNER_REVIEW_REQUIRED');
  }
});
