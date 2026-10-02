import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { recoveryGuidance } from '../src/xiongan/recoveryView.ts';
import { reviewAgentRequest } from '../src/xiongan/agentRequest.ts';

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
  const reads = [element('read-asset'), element('read-collisions')];
  reads[0].dataset.read = 'asset'; reads[1].dataset.read = 'collisions';
  const hooks: Record<'request' | 'chain' | 'verify' | 'status' | 'read' | 'collisions' | 'prepare' | 'accept' | 'execute', () => Promise<any>> = {
    request: async () => [address], chain: async () => '0x88bb0', verify: async () => undefined,
    status: async () => ({ status: 'idle' }), read: async () => 'current asset',
    prepare: async () => ({ digest, consent: {} }), accept: async () => 'memory-only-signature',
    execute: async () => ({ submitted: true }), collisions: async () => ({ scopeNote: 'only these tokens', collisions: [] }),
  };
  let executions = 0, prepares = 0, accepts = 0;
  let collisionIds: bigint[] = [];
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
    ResponsibilityWalletSession: Session, ControlAdapterError, recoveryGuidance, reviewAgentRequest, acquireWalletUi: () => Symbol(), releaseWalletUi: () => {},
    WalletSession: class {
      assetView() { return hooks.read(); }
      collisions(ids: bigint[]) { collisionIds = ids; return hooks.collisions(); }
    },
    RpcErc8415Reader: class {}, Eip1193ReadTransport: class {}, BrowserPublicOperationStore: class {},
    renderAssetView: (v: unknown) => v,
    renderCollisions: (v: unknown) => v,
    CollisionScanError: class extends Error {},
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
  return { hooks, element, click, state, collisionIds: () => collisionIds, emit: (event: string) => events.get(event)!(),
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

test('collision review reads the explicit token set without any send', async () => {
  const f = fixture(); await f.connect();
  f.element('collision-token-ids').value = '1, 2,3';
  f.element('tokenId').value = 'unrelated input';
  await f.click('read-collisions');
  assert.deepEqual(f.collisionIds(), [1n, 2n, 3n]);
  assert.match(f.element('result').textContent, /only these tokens/);
  assert.equal(f.counts().executions, 0);
});

test('collision review rejects duplicate, empty and malformed input before scanning', async () => {
  const f = fixture(); await f.connect();
  f.hooks.collisions = async () => { assert.fail('must not scan'); };
  for (const input of ['', '1,1', '1,', '-1', '1.5', '0x1', Array(33).fill('1').join(',')]) {
    f.element('collision-token-ids').value = input;
    await f.click('read-collisions');
    assert.deepEqual(f.collisionIds(), []);
    assert.match(f.element('result').textContent, /REFUSED/);
  }
});

test('late collision result is discarded after a wallet change', { timeout: 5000 }, async () => {
  const f = fixture(); await f.connect();
  const gate = deferred(), entered = deferred();
  f.hooks.collisions = () => { entered.resolve(); return gate.promise; };
  f.element('collision-token-ids').value = '1,2';
  const pending = f.click('read-collisions');
  await entered.promise;
  f.emit('accountsChanged'); gate.resolve({ stale: true }); await pending;
  assert.equal(f.element('result').textContent, 'CONTROL_CONNECTION_CHANGED');
});

test('unavailable collision data is not rendered as a clean report or raw error', async () => {
  const f = fixture(); await f.connect();
  f.hooks.collisions = async () => { throw new Error('private provider diagnostic'); };
  f.element('collision-token-ids').value = '1,2';
  await f.click('read-collisions');
  assert.equal(f.element('result').textContent, 'CONTROL_UI_OPERATION_REFUSED');
  assert.equal(f.counts().executions, 0);
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
