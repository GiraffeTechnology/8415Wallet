import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Executes the actual UI handlers with deterministic provider/DOM boundaries.
// This is a connection-lifecycle regression, not genuine wallet/UI acceptance.
const source = readFileSync(new URL('../web/app.mjs', import.meta.url), 'utf8')
  .replace(/^import[\s\S]*?;\r?\n/gm, '');
const address = `0x${'1'.repeat(40)}`;
const digest = `0x${'2'.repeat(64)}`;
function deferred() {
  let resolve!: (value?: any) => void;
  const promise = new Promise<any>(r => { resolve = r; });
  return { promise, resolve };
}
function fixture() {
  const elements = new Map<string, any>(), events = new Map<string, () => void>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, { value: '1', textContent: '', checked: false,
      files: [], disabled: false, dataset: {}, handlers: new Map(),
      addEventListener(name: string, fn: () => Promise<void>) { this.handlers.set(name, fn); } });
    return elements.get(id);
  };
  const actions = ['account', 'read', 'reserve-payment'].map(name => {
    const node = element(name); node.dataset.action = name; return node;
  });
  const reads = [element('read-asset')]; reads[0].dataset.read = 'asset';
  const hooks: Record<'request' | 'chain' | 'verify' | 'status' | 'read' | 'prepare' | 'accept' | 'execute', () => Promise<any>> = {
    request: async () => [address], chain: async () => '0x88bb0', verify: async () => undefined,
    status: async () => ({ status: 'idle' }), read: async () => 'current asset',
    prepare: async () => ({ digest, consent: {} }), accept: async () => 'memory-only-signature',
    execute: async () => ({ submitted: true }),
  };
  let executions = 0, prepares = 0, accepts = 0;
  const provider = { request: async () => undefined, on(name: string, fn: () => void) { events.set(name, fn); } };
  class ControlAdapterError extends Error { code: string; constructor(code: string) { super(code); this.code = code; } }
  class Session {
    consent = { prepare: () => { prepares++; return hooks.prepare(); }, accept: () => { accepts++; return hooks.accept(); } };
    accounts = { account: () => hooks.read() };
    status() { return hooks.status(); }
    execute() { executions++; return hooks.execute(); }
  }
  const document = { getElementById: element, querySelectorAll(selector: string) {
    return selector === '[data-action]' ? actions : selector === '[data-read]' ? reads : [...elements.values()];
  } };
  const sdk = {
    ResponsibilityWalletSession: Session, ControlAdapterError,
    WalletSession: class { assetView() { return hooks.read(); } },
    RpcErc8415Reader: class {}, Eip1193ReadTransport: class {}, BrowserPublicOperationStore: class {},
    renderAssetView: (v: unknown) => v,
    verifyControlDeployment: () => hooks.verify(),
    controlRpc: (_p: unknown, method: string) => method === 'eth_requestAccounts' ? hooks.request() : hooks.chain(),
  };
  const state = new Function('document', 'globalThis', ...Object.keys(sdk), `${source}
    return () => ({ connected: plainWallet !== null, linked: session !== null, actor,
      reviewed: review !== null, signed: signed !== null, busy });`)(document, { ethereum: provider }, ...Object.values(sdk));
  const click = async (id: string, event = 'click') => element(id).handlers.get(event)();
  const file = (id: string, data: unknown) => { element(id).files = [{ size: 1, text: async () => JSON.stringify(data) }]; };
  file('deployment', { schema: '8415-controls-testnet/1', chainId: '560048',
    token: { address, runtimeCodeHash: digest }, controller: { address, runtimeCodeHash: digest }, payment: null });
  file('consent-file', { consent: { expectedRevision: '0', tokenId: '1', deadline: '1', recipientNonce: '0', paymentAmount: '0' },
    documents: { incoming: { terms: { scheme: 'utf8-keccak256' } }, inherited: [] } });
  return { hooks, element, click, state, emit: (event: string) => events.get(event)!(),
    counts: () => ({ executions, prepares, accepts }),
    load: () => click('deployment', 'change'),
    async connect() { await click('deployment', 'change'); await click('connect'); },
    async sign() { await click('review'); element('acknowledge').checked = true; await click('accept'); } };
}

for (const phase of ['request', 'chain', 'verify', 'status'] as const) {
  test(`account event during connection ${phase} cannot resurrect the old session`, { timeout: 5000 }, async () => {
    const f = fixture(); await f.load(); const gate = deferred(), entered = deferred();
    f.hooks[phase] = () => { entered.resolve(); return gate.promise; };
    const pending = f.click('connect'); await entered.promise;
    f.emit('accountsChanged'); gate.resolve(phase === 'request' ? [address] : phase === 'chain' ? '0x88bb0' : {});
    await pending;
    assert.equal(f.state().connected, false); assert.equal(f.state().linked, false); assert.equal(f.state().actor, null);
    assert.equal(f.element('result').textContent, 'CONTROL_CONNECTION_CHANGED');
    assert.equal(f.counts().executions, 0);
  });
}
test('failed reconnect cannot retain the prior connected session', async () => {
  const f = fixture(); await f.connect(); assert.equal(f.state().connected, true);
  f.hooks.request = async () => { throw new Error('private provider diagnostic'); };
  await f.click('connect'); assert.equal(f.state().connected, false);
  assert.equal(f.element('result').textContent, 'CONTROL_UI_OPERATION_REFUSED');
});
test('delayed review cannot restore stale terms after an account change', { timeout: 5000 }, async () => {
  const f = fixture(); await f.connect(); const gate = deferred(), entered = deferred();
  f.hooks.prepare = () => { entered.resolve(); return gate.promise; };
  const pending = f.click('review'); await entered.promise; f.emit('accountsChanged');
  gate.resolve({ digest, consent: {} }); await pending;
  assert.equal(f.state().reviewed, false); assert.equal(f.element('terms').textContent, 'No review prepared');
  assert.equal(f.element('acknowledge').checked, false);
});
test('delayed signature is discarded after an account change and cannot be forwarded', async () => {
  const f = fixture(); await f.connect(); await f.click('review');
  f.element('acknowledge').checked = true; const gate = deferred(); f.hooks.accept = () => gate.promise;
  const pending = f.click('accept'); f.emit('accountsChanged'); gate.resolve('never-display-this'); await pending;
  assert.equal(f.state().signed, false); await f.click('connect'); await f.click('forward');
  assert.equal(f.counts().executions, 0); assert.equal(f.element('result').textContent, 'CONTROL_IN_MEMORY_CONSENT_REQUIRED');
});
test('completed acceptance survives intentional same-chain seller switching', async () => {
  const f = fixture(); await f.connect(); await f.sign(); assert.equal(f.state().signed, true);
  f.emit('accountsChanged'); await f.click('connect'); await f.click('forward');
  assert.equal(f.counts().executions, 1); assert.equal(f.state().signed, false);
});
for (const event of ['chainChanged', 'disconnect']) {
  test(`${event} clears completed in-memory acceptance as well as review`, async () => {
    const f = fixture(); await f.connect(); await f.sign(); f.emit(event);
    assert.equal(f.state().signed, false); assert.equal(f.state().reviewed, false);
    assert.equal(f.state().connected, false); assert.equal(f.element('terms').textContent, 'No review prepared');
  });
}
test('deployment reload clears completed acceptance', async () => {
  const f = fixture(); await f.connect(); await f.sign(); await f.load();
  assert.equal(f.state().signed, false); assert.equal(f.state().connected, false);
});
test('late read does not overwrite the connection-change result', async () => {
  const f = fixture(); await f.connect(); const gate = deferred(); f.hooks.read = () => gate.promise;
  const pending = f.click('account'); f.emit('accountsChanged'); gate.resolve('stale account'); await pending;
  assert.equal(f.element('result').textContent, 'CONTROL_CONNECTION_CHANGED');
});
test('late send result is not attributed to the new account and is never retried', async () => {
  const f = fixture(); await f.connect(); await f.sign(); const gate = deferred(); f.hooks.execute = () => gate.promise;
  const pending = f.click('forward'); f.emit('accountsChanged'); gate.resolve({ submitted: true }); await pending;
  assert.equal(f.counts().executions, 1); assert.equal(f.element('result').textContent, 'CONTROL_CONNECTION_CHANGED');
  await f.click('connect'); assert.equal(f.counts().executions, 1);
});
