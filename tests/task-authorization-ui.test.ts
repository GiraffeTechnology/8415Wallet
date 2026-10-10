import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { freezeTaskObservationPolicy } from '../src/agent/receiptObservation.ts';
import { freezeTaskPolicy, emptyTaskBudget } from '../src/agent/taskContract.ts';
import { AccountAuthClient } from '../web/account-auth.mjs';
import { CATALOGS, setLocale } from '../web/i18n.mjs';
// Import the actual browser controller with its immutable core source entry. Tests
// do not depend on a previously generated dist directory or a fake success adapter.
const moduleText = readFileSync(new URL('../web/task-authorization.mjs', import.meta.url), 'utf8')
  .replace('../dist/browser/agent/taskContract.js', new URL('../src/agent/taskContract.ts', import.meta.url).href)
  .replace('../dist/browser/agent/receiptObservation.js', new URL('../src/agent/receiptObservation.ts', import.meta.url).href)
  .replace('../dist/browser/vendor/ethers.js', import.meta.resolve('ethers'));
const moduleUrl = `data:text/javascript;base64,${Buffer.from(moduleText).toString('base64')}`;
const { TaskAuthorizationClient, TaskAuthorizationFlow, normalizeExecutor, normalizeObservationContext } = await import(moduleUrl);
const uiText = readFileSync(new URL('../web/task-authorization-ui.mjs', import.meta.url), 'utf8')
  .replace('./task-authorization.mjs', moduleUrl).replace('./i18n.mjs', new URL('../web/i18n.mjs', import.meta.url).href);
const { mountTaskAuthorization } = await import(`data:text/javascript;base64,${Buffer.from(uiText).toString('base64')}`);
const origin = 'https://wallet.example.invalid', account = `0x${'11'.repeat(20)}`, now = 1900000000000;
const context = { origin, account, chainId: '1', tenant: 'xiongan' };
const executorIdentity = { schema: '8415-task-executor/1', agentId: 'synthetic-agent', agentVersion: '1', adapterId: 'synthetic-test-adapter', adapterVersion: '1', implementationDigest: `0x${'9'.repeat(64)}` };
const executor = { identity: executorIdentity, digest: `0x${createHash('sha256').update(JSON.stringify(executorIdentity)).digest('hex')}` };
const makeTask = (taskId = 'sale-1') => freezeTaskPolicy({ schema: '8415-agent-task/1', taskId, tenant: 'xiongan', origin,
  chainId: '1', actor: account, expiresAt: '1900003600', fees: { perOperationWei: '1000000000000001', totalWei: '2000000000000003' },
  intent: { kind: 'nft-sale', direction: 'sell', standard: 'ERC-721', contract: `0x${'22'.repeat(20)}`, tokenId: '9007199254740993123', quantity: '1',
    minimumProceeds: { currency: 'USD', amountMinor: '100001', minorUnit: 2, comparison: 'gt', basis: 'net' }, marketAdapters: ['market-reviewed'] } });
const receiptPolicy = freezeTaskObservationPolicy({ minimumConfirmations: '2' }); // Explicit synthetic test policy, not a product default.
const verifier = { verifierId: 'synthetic:receipt', verifierVersion: '1', verifierImplementationDigest: `0x${'8'.repeat(64)}` };
function observationFor(input: any, state = 'confirmed-at-depth') {
  return { schema: '8415-task-observation/1', taskDigest: input.task.digest, childDigest: input.childDigest,
    chainId: input.task.policy.chainId, actor: input.task.policy.actor, nonce: input.nonce ?? '1',
    attemptExecutorDigest: input.executorDigest, attemptGrantPolicyVersion: input.grantPolicyVersion ?? '1', originalTransactionHash: input.transactionHash,
    observationPolicy: receiptPolicy.policy, observationPolicyDigest: receiptPolicy.digest, state,
    blockNumber: state === 'pending' ? null : '100', blockHash: state === 'pending' ? null : `0x${'7'.repeat(64)}`,
    confirmations: ['pending', 'reorged'].includes(state) ? '0' : state === 'confirming' ? '1' : '2',
    replacementHash: state === 'superseded-at-depth' ? `0x${'6'.repeat(64)}` : null, observedAt: String(now / 1000),
    effect: state === 'confirmed-at-depth' ? 'exact-operation-observed' : 'not-established',
    protocolFinality: 'not-evaluated', economicFinality: 'not-evaluated', ...verifier };
}
function fixture() {
  const task = makeTask(), tasks = new Map([[task.digest, task]]), requests: any[] = [];
  const statuses = new Map<string, string>(); let hold: Promise<void> | null = null, error: any = null, lostResponse = false;
  const view = (digest: string) => ({ observationPolicy: null, receiptVerifier: null, observations: [], observationRevision: '0', completion: { state: 'not-attempted', fresh: false }, task: tasks.get(digest), executor, authorization: statuses.has(digest) ? {
    schema: '8415-task-authorization-reference/1', taskDigest: digest, reference: 'grant:fixture', status: statuses.get(digest), grantPolicyVersion: '1', credentialRevisionAtApproval: '2',
  } : null, effectiveStatus: statuses.get(digest) ?? 'pending', budget: statuses.has(digest) ? emptyTaskBudget(tasks.get(digest)!) : null,
  capabilities: { executable: false, adapterConfigured: false, receiptVerifierConfigured: false, missing: ['TASK_EXECUTION_ADAPTER_NOT_CONNECTED', 'TASK_RECEIPT_VERIFIER_NOT_CONNECTED'] } });
  const request = async (path: string, body: any) => {
    requests.push({ path, body: { ...body } });
    if (error) throw error;
    if (path === 'tasks/list') return { tasks: [...tasks.keys()].map(view), nextCursor: null, revision: '1' };
    if (path === 'tasks/status') return view(body.taskDigest);
    if (path === 'tasks/prepare') return { observationPolicy: null, receiptVerifier: null, purpose: 'authorize-task', challengeId: `challenge:${'a'.repeat(43)}`, executor, task: tasks.get(freezeTaskPolicy(body.policy).digest), expiresAt: now + 120000 };
    if (path === 'tasks/authorize') { if (hold) await hold; statuses.set(body.taskDigest, 'authorized'); if (lostResponse) throw Error('Network interrupted'); return view(body.taskDigest); }
    if (path === 'tasks/resume') return { ...view(body.taskDigest), continuation: { state: 'blocked', code: 'TASK_EXECUTION_ADAPTER_NOT_CONNECTED' } };
    if (path === 'tasks/revoke') { statuses.set(body.taskDigest, 'revoked'); return view(body.taskDigest); }
    throw Error('Unexpected request');
  };
  const client = new TaskAuthorizationClient({ request, context }), snapshots: any[] = [];
  const flow = new TaskAuthorizationFlow({ client, now: () => now, onChange: (snapshot: any) => snapshots.push(snapshot) });
  return { task, tasks, requests, statuses, view, client, flow, request, snapshots,
    setHold: (value: Promise<void>) => { hold = value; }, setError: (value: any) => { error = value; }, loseResponse: () => { lostResponse = true; } };
}
test('authorization reviews canonical NFT price, exact integers and one parent grant then automatically requests continuation', async () => {
  const f = fixture(); await f.flow.load(f.task.digest);
  assert.equal(f.flow.snapshot().phase, 'review'); assert.deepEqual(f.flow.snapshot().selected.task, f.task);
  assert.equal(f.requests.some(r => r.path === 'tasks/authorize'), false);
  await f.flow.authorize('123456');
  assert.equal(f.flow.snapshot().phase, 'authorized-blocked');
  assert.deepEqual(f.requests.slice(-2).map(r => r.path), ['tasks/authorize', 'tasks/resume']);
  assert.equal(f.requests.at(-1).body.taskDigest, f.task.digest);
  assert.equal(f.requests.find(r => r.path === 'tasks/authorize').body.executorDigest, executor.digest);
  assert.equal(f.snapshots.some(s => JSON.stringify(s).includes('123456')), false);
  assert.equal(f.snapshots.some(s => 'code' in s || 'challengeId' in s), false);
  assert.equal(f.requests.some(r => /execute|reserve|personal_sign|sendTransaction/.test(r.path)), false);
});
test('repeated authorize is single flight and closing discards its late result without resuming a stale task', async () => {
  const f = fixture(); let release!: () => void; f.setHold(new Promise<void>(r => { release = r; }));
  await f.flow.load(f.task.digest); const pending = f.flow.authorize('123456'); await f.flow.authorize('123456');
  f.flow.suspend(); release(); await pending;
  assert.equal(f.flow.snapshot().phase, 'paused'); assert.equal(f.requests.filter((r: any) => r.path === 'tasks/authorize').length, 1);
  assert.equal(f.requests.some(r => r.path === 'tasks/resume'), false);
  await f.flow.open(f.task.digest); assert.equal(f.flow.snapshot().phase, 'authorized-blocked');
  assert.equal(f.requests.filter((r: any) => r.path === 'tasks/authorize').length, 1);
});
test('newer task selection and logout reject late authorization completion', async () => {
  for (const action of ['newer', 'logout']) {
    const f = fixture(), other = makeTask('sale-2'); f.tasks.set(other.digest, other);
    let release!: () => void; f.setHold(new Promise<void>(r => { release = r; }));
    await f.flow.load(f.task.digest); const pending = f.flow.authorize('123456');
    if (action === 'newer') await f.flow.open(other.digest); else f.flow.lock();
    release(); await pending;
    assert.equal(f.flow.snapshot().phase, action === 'newer' ? 'review' : 'locked');
    assert.equal(f.flow.snapshot().selected?.task.digest ?? null, action === 'newer' ? other.digest : null);
    assert.equal(f.requests.some(r => r.path === 'tasks/resume'), false);
  }
});
test('reload and lost authorization response recover server task without replaying OTP or child operation', async () => {
  const f = fixture(); await f.flow.load(f.task.digest); f.loseResponse(); await f.flow.authorize('123456');
  assert.equal(f.flow.snapshot().phase, 'uncertain');
  const restored = new TaskAuthorizationFlow({ client: f.client, now: () => now }); await restored.load(f.task.digest);
  assert.equal(restored.snapshot().phase, 'authorized-blocked');
  assert.equal(f.requests.filter((r: any) => r.path === 'tasks/authorize').length, 1);
  assert.equal(f.requests.filter((r: any) => r.path === 'tasks/prepare').length, 1);
});
test('expired challenge cannot authorize and credentials-changed status never silently resumes', async () => {
  const f = fixture(); let time = now;
  const flow = new TaskAuthorizationFlow({ client: f.client, now: () => time }); await flow.load(f.task.digest); time += 120000;
  await flow.authorize('123456'); assert.equal(flow.snapshot().error, 'TASK_CHALLENGE_EXPIRED');
  assert.equal(f.requests.some(r => r.path === 'tasks/authorize'), false);
  f.statuses.set(f.task.digest, 'suspended'); await flow.open(f.task.digest);
  assert.equal(flow.snapshot().phase, 'suspended'); assert.equal(f.requests.some(r => r.path === 'tasks/resume'), false);
});
test('service binding, digest tampering and fabricated execution success fail closed', () => {
  const f = fixture(), view = f.view(f.task.digest);
  const forged = JSON.parse(JSON.stringify(view)); forged.task.policy.intent.minimumProceeds.comparison = 'gte';
  assert.throws(() => f.client.view(forged), /TASK_DIGEST_MISMATCH/);
  for (const bad of [{ tenant: 'other' }, { origin: 'https://other.invalid' }, { account: `0x${'33'.repeat(20)}` }, { chainId: '8453' }]) {
    assert.throws(() => new TaskAuthorizationClient({ request() {}, context: { ...context, ...bad } }).view(view), /TASK_IDENTITY_REFUSED/);
  }
  assert.throws(() => f.client.view({ ...view, capabilities: { executable: true, missing: [] } }), /TASK_EXECUTION_CAPABILITY_REFUSED/);
  assert.throws(() => f.client.view({ ...view, effectiveStatus: 'verified' }), /TASK_RESPONSE_REFUSED/);
});
test('task list consumes all consistent-revision pages and refuses cursor loops or revision drift', async () => {
  const f = fixture(); let count = 0; const other = makeTask('sale-2'); f.tasks.set(other.digest, other);
  const client = new TaskAuthorizationClient({ context, request: async (_: string, body: any) => {
    count++; assert.deepEqual(body, count === 1 ? {} : { cursor: 'page2', revision: '7' });
    return { tasks: [f.view(count === 1 ? f.task.digest : other.digest)], nextCursor: count === 1 ? 'page2' : null, revision: '7' };
  } });
  assert.equal((await client.list()).length, 2); assert.equal(count, 2);
  for (const drift of [false, true]) {
    let n = 0; const bad = new TaskAuthorizationClient({ context, request: async () => ({ tasks: [], nextCursor: 'again', revision: drift ? String(n++) : '1' }) });
    await assert.rejects(bad.list(), /TASK_LIST_CHANGED/);
  }
});
test('task revoke uses server grant version, not a caller-approved flag', async () => {
  const f = fixture(); f.statuses.set(f.task.digest, 'authorized'); await f.flow.load(f.task.digest); await f.flow.revoke();
  assert.equal(f.flow.snapshot().phase, 'revoked'); assert.deepEqual(f.requests.at(-1).body, { taskDigest: f.task.digest, expectedGrantPolicyVersion: '1' });
});
test('all six locale catalogs contain every task label and preserve literal task facts', () => {
  const keys = Object.keys(CATALOGS.en!).filter(k => k.startsWith('task.') || k === 'design.tasks');
  assert.ok(keys.length > 50);
  for (const [locale, catalog] of Object.entries(CATALOGS)) {
    for (const key of keys) assert.equal(typeof catalog[key], 'string', `${locale}:${key}`);
  }
  const source = readFileSync(new URL('../web/task-authorization-ui.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /localStorage|sessionStorage|console\.|innerHTML|navigator\.clipboard|window\.open|otpauth:/);
  assert.match(source, /data\.textContent = String\(value\)/);
});
test('same-origin account client permits stable task errors only on task routes', async () => {
  const requestOptions: any[] = [];
  const client = new AccountAuthClient({ tenant: 'xiongan', origin, fetcher: async (url: URL, opts: any) => {
    requestOptions.push([url.href, opts]); return { ok: false, text: async () => JSON.stringify({ error: 'TASK_EXECUTION_ADAPTER_NOT_CONNECTED' }) };
  } });
  await assert.rejects(client.request('tasks/resume', { taskDigest: makeTask().digest }), /TASK_EXECUTION_ADAPTER_NOT_CONNECTED/);
  await assert.rejects(client.request('account'), /LOGIN_SERVICE_UNAVAILABLE/);
  assert.equal(requestOptions[0][1].credentials, 'same-origin'); assert.equal(requestOptions[0][1].cache, 'no-store');
});
class Node {
  hidden = false; disabled = false; checked = false; value = ''; textContent = ''; type = ''; className = ''; children: Node[] = [];
  handlers = new Map<string, Function[]>();
  append(...nodes: Node[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Node[]) { this.children = nodes; this.textContent = ''; }
  setAttribute() {} removeAttribute() {}
  addEventListener(name: string, fn: Function) { this.handlers.set(name, [...this.handlers.get(name) ?? [], fn]); }
  dispatchEvent(event: any) { for (const fn of this.handlers.get(event.type) ?? []) fn(event); }
  click() { if (!this.disabled) this.dispatchEvent({ type: 'click' }); }
}
const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r)); };
function fakeLocks() {
  let held = false;
  return { async request(_name: string, _options: any, callback: Function) {
    if (held) return callback(null);
    held = true; try { return await callback({ name: _name }); } finally { held = false; }
  } };
}
function uiFixture({ executable = false, fixtureOverride = null as any, nowFn = (): number => now, locks = fakeLocks() as any } = {}) {
  const f = fixtureOverride ?? fixture(), elements = new Map<string, Node>(), events = new Node(), windowEvents = new Node();
  const timers = new Map<number, Function>(), delays = new Map<number, number>(); let timerId = 0;
  const request = async (path: string, body: any) => { const raw: any = await f.request(path, body);
    if (executable && raw?.effectiveStatus === 'authorized') { raw.capabilities = { executable: false, adapterConfigured: true, receiptVerifierConfigured: false, missing: [] };
      if (path === 'tasks/resume') raw.continuation = { state: 'waiting-for-operation', code: 'TASK_NO_CANDIDATE' }; } return raw; };
  const el = (id: string) => { if (!elements.has(id)) elements.set(id, new Node()); return elements.get(id)!; };
  const document = { getElementById: el, createElement: () => new Node(), visibilityState: 'visible', addEventListener: events.addEventListener.bind(events) };
  const history = { state: { walletPage: 'tasks', walletTaskDigest: f.task.digest }, replaceState(value: any) { this.state = value; } };
  let subscriber: Function = () => {};
  const session = { ...context, id: 1, serverId: 's'.repeat(43) }, binding = {};
  const walletLogin = { async check() { return session; }, capture: () => binding, assert: () => session, subscribe(fn: Function) { subscriber = fn; } };
  class Flow extends TaskAuthorizationFlow { constructor(options: any) { super({ ...options, now: nowFn }); } }
  const result = mountTaskAuthorization({ document, window: { history, navigator: { locks }, setTimeout(fn: Function, delay: number) { timers.set(++timerId, fn); delays.set(timerId, delay); return timerId; }, clearTimeout(id: number) { timers.delete(id); }, addEventListener: windowEvents.addEventListener.bind(windowEvents) }, walletLogin, getClient: () => ({ request }), Flow });
  return { ...f, result, el, document, events, history, windowEvents, timers, delays, subscriber: (s: any) => subscriber(s) };
}
test('app switch clears OTP without losing task or regenerating its challenge; cancel and Back clear consent', async () => {
  const f = uiFixture(); f.events.dispatchEvent({ type: 'wallet:page', detail: 'tasks' }); await tick();
  assert.equal(f.result.snapshot().phase, 'review'); const before = f.requests.filter((r: any) => r.path === 'tasks/prepare').length;
  f.el('task-code').value = '123456'; f.el('task-ack').checked = true;
  f.document.visibilityState = 'hidden'; f.events.dispatchEvent({ type: 'visibilitychange' });
  assert.equal(f.el('task-code').value, ''); assert.equal(f.el('task-ack').checked, false);
  f.document.visibilityState = 'visible'; f.events.dispatchEvent({ type: 'visibilitychange' });
  assert.equal(f.result.snapshot().phase, 'review'); assert.equal(f.requests.filter((r: any) => r.path === 'tasks/prepare').length, before);
  f.el('task-code').value = '654321'; f.events.dispatchEvent({ type: 'wallet:page', detail: 'overview' });
  assert.equal(f.el('task-code').value, ''); assert.equal(f.result.snapshot().phase, 'paused');
  assert.equal(f.history.state.walletTaskDigest, f.task.digest);
  f.events.dispatchEvent({ type: 'wallet:page', detail: 'tasks' }); await tick(); f.el('task-cancel').click();
  assert.equal(f.result.snapshot().phase, 'paused'); assert.equal(f.el('task-authorize-fields').hidden, true);
});
test('DOM displays full immutable scope, clears code on submit and never renders granted as executed', async () => {
  const f = uiFixture(); f.events.dispatchEvent({ type: 'wallet:page', detail: 'tasks' }); await tick();
  const values = f.el('task-summary').children.flatMap((row: Node) => row.children.map(n => n.textContent));
  assert.ok(values.includes(executor.identity.agentId)); assert.ok(values.includes(executor.identity.agentVersion));
  assert.ok(values.includes(executor.identity.adapterId)); assert.ok(values.includes(executor.identity.adapterVersion));
  assert.ok(values.includes(executor.identity.implementationDigest)); assert.ok(values.includes(executor.digest));
  assert.ok(values.includes('> 1000.01 USD')); assert.ok(values.includes('9007199254740993123')); assert.ok(values.includes('net'));
  assert.ok(values.includes('1000000000000001 wei')); assert.ok(values.includes('2000000000000003 wei'));
  f.el('task-code').value = '123456'; f.el('task-ack').checked = true;
  f.el('task-authorize-form').dispatchEvent({ type: 'submit', preventDefault() {} }); assert.equal(f.el('task-code').value, ''); await tick();
  assert.equal(f.result.snapshot().phase, 'authorized-blocked'); assert.match(f.el('task-status').textContent, /continuation blocked/);
  assert.equal(f.el('task-blocked').hidden, false); assert.equal(f.el('task-authorize-fields').hidden, true);
  f.subscriber(null); assert.equal(f.el('task-summary').children.length, 0); assert.equal(f.el('task-canonical').textContent, '');
});
test('language changes do not reset review or issue requests', async () => {
  const f = uiFixture(); f.events.dispatchEvent({ type: 'wallet:page', detail: 'tasks' }); await tick();
  const before = f.requests.length, digest = f.result.snapshot().selected.task.digest;
  f.el('task-ack').checked = true;
  setLocale('ja', { document: null, persist: false });
  assert.equal(f.requests.length, before); assert.equal(f.result.snapshot().selected.task.digest, digest); assert.equal(f.el('task-ack').checked, true);
  setLocale('en', { document: null, persist: false });
});
test('unknown and submitted journal entries stay distinct from an authorization and never claim verified success', () => {
  const f = fixture(); f.statuses.set(f.task.digest, 'authorized');
  for (const status of ['reserved', 'outcome-unknown', 'submitted']) {
    const raw: any = f.view(f.task.digest); raw.budget = { schema: '8415-task-budget/1', taskDigest: f.task.digest, revision: '1',
      reservations: [{ operationId: 'op:one', childDigest: `0x${'a'.repeat(64)}`, feeWei: '1', units: '1', status,
        transactionHash: status === 'submitted' ? `0x${'b'.repeat(64)}` : null }] };
    raw.completion.state = status === 'outcome-unknown' ? 'outcome-unknown' : 'awaiting-evidence';
    const checked = f.client.view(raw);
    assert.equal(checked.executionState, status === 'outcome-unknown' ? 'unknown' : status);
    assert.equal(checked.effectiveStatus, 'authorized'); assert.equal(checked.capabilities.executable, false);
    assert.equal(checked.budget.reservations[0].transactionHash, raw.budget.reservations[0].transactionHash);
  }
});
test('actual service contract interoperates with browser client and same-task continuation without per-child TOTP', async () => {
  const { createTaskAuthorizationService } = await import('../server/task-authorization.mjs');
  const { MemoryCredentialStore } = await import('../server/store.mjs');
  const { base32, hotp, matchTotp } = await import('../server/crypto.mjs');
  for (const configured of [false, true]) {
    const secret = base32(Buffer.alloc(20, 0x31)); // Local synthetic credential only.
    const store = new MemoryCredentialStore({ 'xiongan:synthetic': { secret, lastStep: -1, revision: 0 } });
    const session = { ...context, username: 'synthetic', id: 'synthetic-session', revision: 0, issuedAt: now, expiresAt: now + 900000 };
    const task = freezeTaskPolicy({ ...makeTask(`native-${configured}`).policy, intent: { kind: 'exact-operation',
      operation: { kind: 'native-transfer', chainId: '1', actor: account, recipient: `0x${'33'.repeat(20)}`, valueWei: '10' } } });
    let sends = 0, consumes = 0, plans = 0, reads = 0, receiptState = 'pending', receiptFailure = false;
    const binding = (input: any) => ({ taskDigest: input.task.digest, childDigest: input.child.digest, chainId: input.child.child.operation.chainId,
      actor: input.child.child.operation.actor, nonce: input.child.child.nonce, executorDigest: input.executor.digest, grantPolicyVersion: input.grantPolicyVersion });
    const execution = configured ? {
      async plan(input: any) { plans++; return { schema: '8415-agent-child/1', operationId: 'synthetic-child', taskDigest: input.task.digest,
        operation: input.task.policy.intent.operation, nonce: '1', expiresAt: '1900000100', wire: { to: `0x${'33'.repeat(20)}`,
          calldataHash: '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470', valueWei: '10' },
        fees: { gasLimit: '21000', maxFeePerGasWei: '1' }, market: null }; },
      async verify(input: any) { return binding(input); },
      async send(input: any) { sends++; return { ...binding(input), transactionHash: `0x${'a'.repeat(64)}` }; },
      async recover(input: any) { return { ...binding(input), state: 'submitted', transactionHash: `0x${'a'.repeat(64)}` }; },
    } : null;
    const receipt = configured ? { identity: verifier, observationPolicy: receiptPolicy,
      async assessChild(input: any) { return { taskDigest: input.task.digest, childDigest: input.child.digest, executorDigest: input.executor.digest,
        observationPolicyDigest: receiptPolicy.digest, ...verifier, capability: 'exact-operation-observable' }; },
      async observe(input: any) {
      reads++; if (receiptFailure) throw Error('Synthetic read unavailable');
      return observationFor({ task: input.task, childDigest: input.child.digest, executorDigest: input.executor.digest,
        transactionHash: input.attempt.transactionHash, grantPolicyVersion: input.attempt.grantPolicyVersion, nonce: input.child.child.nonce }, receiptState);
    } } : null;
    const service = createTaskAuthorizationService({ ...context, store, now: () => now, execution, executorIdentity: configured ? executorIdentity : null, observationPolicy: configured ? receiptPolicy.policy : null, receipt,
      assertSession(s: any, credential?: any) { assert.equal(s, session); if (credential) assert.equal(credential.revision, session.revision); },
      credentialFor: () => store.read('xiongan:synthetic'), consumeTotp(_s: any, credential: any, code: string) {
        const step = matchTotp(credential.secret, code, now, credential.lastStep); assert.notEqual(step, null); consumes++; return { ...credential, lastStep: step };
      },
    });
    await service.handler('tasks/prepare', { policy: task.policy }, session);
    const client = new TaskAuthorizationClient({ context, request: (path: string, body: any) => service.handler(path, body, session) });
    const flow = new TaskAuthorizationFlow({ client, now: () => now }); await flow.load(task.digest);
    assert.equal(flow.snapshot().phase, 'review');
    await flow.authorize(hotp(secret, Math.floor(now / 30000)));
    assert.equal(flow.snapshot().phase, configured ? 'submitted' : 'authorized-blocked');
    assert.equal(consumes, 1); assert.equal(sends, configured ? 1 : 0);
    if (configured) {
      assert.equal(flow.snapshot().selected.executionState, 'submitted'); await flow.continue();
      assert.equal(flow.snapshot().phase, 'awaiting-evidence'); assert.equal(sends, 1); assert.equal(plans, 1); assert.equal(consumes, 1);
      assert.equal(flow.snapshot().selected.task.digest, task.digest);
      receiptState = 'confirmed-at-depth'; await flow.recover(); assert.equal(flow.snapshot().phase, 'completed-at-observation-depth');
      const before = reads, cached = await client.resume(task.digest, flow.snapshot().selected.executor.digest, flow.snapshot().selected);
      assert.equal(cached.completion.fresh, false); assert.equal(reads, before);
      receiptState = 'reorged'; await flow.recover(); assert.equal(flow.snapshot().phase, 'awaiting-evidence');
      receiptState = 'confirmed-at-depth'; await flow.recover(); receiptFailure = true; await flow.recover();
      assert.equal(flow.snapshot().selected.observations[0].available, false); assert.equal(flow.snapshot().selected.completion.fresh, false);
      assert.equal(flow.snapshot().phase, 'awaiting-evidence'); assert.equal(sends, 1); assert.equal(plans, 1); assert.equal(consumes, 1);
    }
    await flow.revoke(); assert.equal(flow.snapshot().phase, 'revoked');
  }
});
test('configured same-task continuation checks automatically without another OTP and stops on hidden page or navigation', async () => {
  const f = uiFixture({ executable: true }); f.events.dispatchEvent({ type: 'wallet:page', detail: 'tasks' }); await tick();
  f.el('task-code').value = '123456'; f.el('task-ack').checked = true; f.el('task-authorize-form').dispatchEvent({ type: 'submit', preventDefault() {} }); await tick();
  assert.equal(f.result.snapshot().phase, 'authorized-waiting'); assert.equal(f.timers.size, 1);
  const before = f.requests.filter((r: any) => r.path === 'tasks/resume').length;
  const [id, callback] = [...f.timers][0]!; f.timers.delete(id); callback(); await tick();
  assert.equal(f.requests.filter((r: any) => r.path === 'tasks/resume').length, before + 1);
  assert.equal(f.requests.filter((r: any) => r.path === 'tasks/authorize').length, 1);
  f.document.visibilityState = 'hidden'; f.events.dispatchEvent({ type: 'visibilitychange' }); assert.equal(f.timers.size, 0);
  f.document.visibilityState = 'visible'; f.events.dispatchEvent({ type: 'visibilitychange' }); assert.equal(f.timers.size, 1);
  f.events.dispatchEvent({ type: 'wallet:page', detail: 'overview' }); assert.equal(f.timers.size, 0);
});
test('inactive grant can request recovery of its saved unknown without planning, authorizing or sending new work', async () => {
  const f = fixture(); f.statuses.set(f.task.digest, 'revoked');
  const raw: any = f.view(f.task.digest); raw.budget = { schema: '8415-task-budget/1', taskDigest: f.task.digest, revision: '1', reservations: [
    { operationId: 'op:unknown', childDigest: `0x${'a'.repeat(64)}`, feeWei: '1', units: '1', status: 'outcome-unknown', transactionHash: null }] };
  raw.completion.state = 'outcome-unknown';
  const requests: string[] = [], client = new TaskAuthorizationClient({ context, request: async (path: string) => {
    requests.push(path);
    if (path === 'tasks/list') return { tasks: [raw], nextCursor: null, revision: '1' };
    if (path === 'tasks/status') return raw;
    assert.equal(path, 'tasks/resume');
    return { ...raw, completion: { state: 'awaiting-evidence', fresh: false }, budget: { ...raw.budget, revision: '2', reservations: [{ ...raw.budget.reservations[0], status: 'submitted', transactionHash: `0x${'b'.repeat(64)}` }] },
      continuation: { state: 'submitted', operationId: 'op:unknown' } };
  } });
  const flow = new TaskAuthorizationFlow({ client, now: () => now }); await flow.load(f.task.digest);
  assert.equal(flow.snapshot().phase, 'revoked'); assert.equal(requests.includes('tasks/resume'), false);
  await flow.recover(); assert.equal(flow.snapshot().phase, 'revoked'); assert.equal(flow.snapshot().selected.executionState, 'submitted');
  assert.deepEqual(requests, ['tasks/list', 'tasks/status', 'tasks/resume']);
});
test('real loopback HTTP account client preserves cookie/CSRF separation through pending task, OTP grant, resume and reload', async t => {
  const { createServer } = await import('node:http');
  const { createAuthService } = await import('../server/auth-service.mjs');
  const { MemoryCredentialStore } = await import('../server/store.mjs');
  const { base32, hashPassword, hotp } = await import('../server/crypto.mjs');
  const password = 'SYNTHETIC_PASSWORD_ONLY', secret = base32(Buffer.alloc(20, 0x39));
  const passwordHash = await hashPassword(password), store = new MemoryCredentialStore({ 'xiongan:synthetic': { secret, lastStep: -1, revision: 0 } });
  let handler: any; const server = createServer((req, res) => handler(req, res)); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`, sessionContext = { ...context, origin };
  handler = createAuthService({ origin, tenant: 'xiongan', store, now: () => now,
    accounts: [{ username: 'synthetic', passwordHash, wallets: [{ account, chainId: '1' }] }] });
  const jar = new Map<string, string>(), requests: string[] = [];
  const fetcher = async (url: URL, options: any) => {
    requests.push(url.pathname);
    const response = await fetch(url, { ...options, headers: { ...options.headers, Origin: origin,
      Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } });
    for (const cookie of response.headers.getSetCookie()) { const [k, v] = cookie.split(';')[0]!.split('='); if (v) jar.set(k!, v); else jar.delete(k!); }
    return response;
  };
  const auth = new AccountAuthClient({ tenant: 'xiongan', origin, fetcher });
  const task = freezeTaskPolicy({ ...makeTask('http-task').policy, origin });
  await assert.rejects(auth.request('tasks/list', {}), /AUTH_/);
  await auth.adapter('password', { username: 'synthetic', password }).authenticate({ account, chainId: '1' });
  const client = new TaskAuthorizationClient({ context: sessionContext, request: auth.request.bind(auth) });
  await client.prepare(task);
  const flow = new TaskAuthorizationFlow({ client, now: () => now }); await flow.load(task.digest);
  assert.equal(flow.snapshot().phase, 'review'); await flow.authorize(hotp(secret, Math.floor(now / 30000)));
  assert.equal(flow.snapshot().phase, 'authorized-blocked');
  const restored = new TaskAuthorizationFlow({ client, now: () => now }); await restored.load(task.digest);
  assert.equal(restored.snapshot().phase, 'authorized-blocked'); assert.equal(requests.filter(path => path === '/auth/tasks/authorize').length, 1);
  await auth.logout(); await assert.rejects(client.status(task.digest), /AUTH_/);
});
test('executor identity uses independent canonical SHA256 and rejects missing, extra or tampered identity fields', () => {
  assert.deepEqual(normalizeExecutor(executor), executor);
  const golden = { identity: { ...executorIdentity, agentId: 'synthetic:agent', adapterId: 'synthetic:adapter' }, digest: '0x71dbe852d9c0f53960e3afdc5bb3a761187b388e72c10c8ed6d86a19afe63091' };
  assert.equal(normalizeExecutor(golden).digest, golden.digest);
  const reordered = { ...executor, identity: Object.fromEntries(Object.entries(executor.identity).reverse()) };
  assert.deepEqual(normalizeExecutor(reordered), executor);
  for (const key of ['agentId', 'agentVersion', 'adapterId', 'adapterVersion', 'implementationDigest']) {
    const tampered = structuredClone(executor); (tampered.identity as any)[key] = key === 'implementationDigest' ? `0x${'a'.repeat(64)}` : 'replaced';
    assert.throws(() => normalizeExecutor(tampered), /TASK_EXECUTOR_DIGEST_MISMATCH/);
  }
  assert.throws(() => normalizeExecutor(null), /TASK_EXECUTOR_IDENTITY_REFUSED/);
  assert.throws(() => normalizeExecutor({ ...executor, approved: true }), /TASK_EXECUTOR_IDENTITY_REFUSED/);
});
test('executor substitution during preparation or authorization cannot inherit the displayed task approval', async () => {
  const replacementIdentity = { ...executor.identity, agentVersion: '2' };
  const replacement = { identity: replacementIdentity, digest: `0x${createHash('sha256').update(JSON.stringify(replacementIdentity)).digest('hex')}` };
  for (const phase of ['prepare', 'authorize', 'resume']) {
    const f = fixture(), client = new TaskAuthorizationClient({ context, request: async (path: string, body: any) => {
      const raw = await f.request(path, body); return path === `tasks/${phase}` ? { ...raw, executor: replacement } : raw;
    } });
    const flow = new TaskAuthorizationFlow({ client, now: () => now }); await flow.load(f.task.digest);
    if (phase === 'prepare') {
      assert.equal(flow.snapshot().phase, 'error'); assert.equal(flow.snapshot().error, 'TASK_EXECUTOR_CHANGED');
      assert.equal(f.requests.some(r => r.path === 'tasks/authorize'), false);
    } else {
      await flow.authorize('123456'); assert.equal(flow.snapshot().phase, 'uncertain'); assert.equal(flow.snapshot().error, 'TASK_EXECUTOR_CHANGED');
      assert.equal(f.requests.find(r => r.path === 'tasks/authorize').body.executorDigest, executor.digest);
      assert.equal(flow.snapshot().selected.executor.digest, executor.digest);
      if (phase === 'authorize') assert.equal(f.requests.some(r => r.path === 'tasks/resume'), false);
    }
    assert.equal(flow.snapshot().selected.task.digest, f.task.digest);
  }
});

function receiptFixture() {
  const f = fixture(), task = freezeTaskPolicy({ ...makeTask('receipt-task').policy, intent: { kind: 'exact-operation',
    operation: { kind: 'native-transfer', chainId: '1', actor: account, recipient: `0x${'33'.repeat(20)}`, valueWei: '10' } } });
  f.tasks.clear(); f.tasks.set(task.digest, task); f.statuses.set(task.digest, 'authorized');
  const operation = { operationId: 'op:receipt', childDigest: `0x${'a'.repeat(64)}`, feeWei: '1', units: '1', status: 'submitted', transactionHash: `0x${'b'.repeat(64)}` };
  let observation: any = null, available = false, state = 'confirmed-at-depth', failure = false, hold: Promise<void> | null = null;
  const view = (fresh = false): any => ({ ...f.view(task.digest), observationPolicy: receiptPolicy, receiptVerifier: verifier,
    observations: observation || available ? [{ operationId: operation.operationId, observation, available }] : [], observationRevision: '1',
    completion: { state: available && observation?.state === 'confirmed-at-depth' ? 'completed-at-observation-depth' :
      available && ['reverted-at-depth', 'superseded-at-depth'].includes(observation?.state) ? 'failed-at-observation-depth' : 'awaiting-evidence', fresh },
    budget: { schema: '8415-task-budget/1', taskDigest: task.digest, revision: '3', reservations: [operation] },
    capabilities: { executable: false, adapterConfigured: true, receiptVerifierConfigured: true, missing: [] } });
  const request = async (path: string, body: any) => {
    f.requests.push({ path, body });
    if (path === 'tasks/list') return { tasks: [view()], nextCursor: null, revision: '2' };
    if (path === 'tasks/status') return view();
    assert.equal(path, 'tasks/observe', 'receipt refresh must never send or resume');
    assert.deepEqual(body, { taskDigest: task.digest, operationId: operation.operationId, childDigest: operation.childDigest, expectedBudgetRevision: '3' });
    if (hold) await hold;
    if (failure) { available = false; throw Object.assign(Error('unavailable'), { code: 'TASK_OBSERVATION_UNAVAILABLE' }); }
    observation = observationFor({ task, childDigest: operation.childDigest, executorDigest: executor.digest, transactionHash: operation.transactionHash }, state);
    available = true; return { ...view(true), observation, outcome: state };
  };
  const client = new TaskAuthorizationClient({ context, request }), snapshots: any[] = [];
  const flow = new TaskAuthorizationFlow({ client, now: () => now, onChange: (s: any) => snapshots.push(s) });
  return { ...f, task, client, flow, request, view, snapshots, operation,
    state(value: string) { state = value; }, fail(value = true) { failure = value; }, setHold(value: Promise<void> | null) { hold = value; } };
}
test('observation policy has no implicit default and independently verifies canonical policy digest', async () => {
  assert.equal(receiptPolicy.digest, '0xe834daeddaea8e8bc8d1aad561998012fd6f5a1b5a0803492441c0a9061c6beb');
  assert.deepEqual(normalizeObservationContext({ observationPolicy: null, receiptVerifier: null }), { observationPolicy: null, receiptVerifier: null });
  assert.throws(() => normalizeObservationContext({ receiptVerifier: null }), /TASK_OBSERVATION_POLICY_REFUSED/);
  assert.throws(() => normalizeObservationContext({ observationPolicy: { ...receiptPolicy, digest: executor.digest }, receiptVerifier: verifier }), /TASK_OBSERVATION_POLICY_MISMATCH/);
  assert.throws(() => normalizeObservationContext({ observationPolicy: null, receiptVerifier: verifier }), /TASK_OBSERVATION_POLICY_REQUIRED/);
  const f = fixture(); await f.flow.load(f.task.digest); await f.flow.authorize('123456');
  assert.equal(f.requests.find(r => r.path === 'tasks/authorize').body.observationPolicyDigest, null);
});
test('approval pins explicit observation policy and verifier, refusing substitution across preparation, approval and continuation', async () => {
  for (const phase of ['prepare', 'authorize', 'resume']) for (const replaced of ['policy', 'verifier']) {
    const f = fixture(), client = new TaskAuthorizationClient({ context, request: async (path: string, body: any) => {
      const raw: any = await f.request(path, body); const wrap = (v: any) => ({ ...v, observationPolicy: receiptPolicy, receiptVerifier: verifier });
      if (path === 'tasks/list') return { ...raw, tasks: raw.tasks.map(wrap) };
      let result = wrap(raw);
      if (path === 'tasks/authorize') assert.equal(body.observationPolicyDigest, receiptPolicy.digest);
      if (path === `tasks/${phase}`) result = { ...result, ...(replaced === 'policy' ? { observationPolicy: freezeTaskObservationPolicy({ minimumConfirmations: '3' }) } : { receiptVerifier: { ...verifier, verifierVersion: '2' } }) };
      return result;
    } });
    const flow = new TaskAuthorizationFlow({ client, now: () => now }); await flow.load(f.task.digest);
    if (phase !== 'prepare') await flow.authorize('123456');
    assert.equal(flow.snapshot().error, replaced === 'policy' ? 'TASK_OBSERVATION_POLICY_CHANGED' : 'TASK_RECEIPT_VERIFIER_CHANGED');
    assert.equal(flow.snapshot().selected.observationPolicy.digest, receiptPolicy.digest);
    if (phase === 'prepare') assert.equal(f.requests.some(r => r.path === 'tasks/authorize'), false);
    if (phase === 'authorize') assert.equal(f.requests.some(r => r.path === 'tasks/resume'), false);
  }
});
test('explicit receipt refresh goes from submitted to observed depth then reorg and unavailable without send or fresh cached success', async () => {
  const f = receiptFixture(); await f.flow.load(f.task.digest);
  assert.equal(f.flow.snapshot().phase, 'completed-at-observation-depth'); assert.equal(f.flow.snapshot().selected.completion.fresh, true);
  assert.equal((await f.client.status(f.task.digest)).completion.fresh, false);
  f.state('reorged'); let release!: () => void; f.setHold(new Promise<void>(r => { release = r; }));
  const pending = f.flow.recover(); assert.equal(f.flow.snapshot().selected.completion.fresh, false); assert.equal(f.flow.snapshot().phase, 'recovering');
  release(); await pending; f.setHold(null);
  assert.equal(f.flow.snapshot().phase, 'awaiting-evidence'); assert.equal(f.flow.snapshot().selected.observations[0].observation.state, 'reorged');
  f.state('confirmed-at-depth'); await f.flow.recover(); f.fail(); await f.flow.recover();
  const last = f.flow.snapshot(); assert.equal(last.phase, 'awaiting-evidence'); assert.equal(last.error, 'TASK_OBSERVATION_UNAVAILABLE');
  assert.equal(last.selected.completion.fresh, false); assert.equal(last.selected.completion.state, 'awaiting-evidence');
  assert.equal(last.selected.observations[0].available, false); assert.equal(last.selected.observations[0].observation.state, 'confirmed-at-depth');
  assert.equal(f.requests.some(r => /resume|authorize|execute|reserve/.test(r.path)), false);
});
test('cached terminal evidence never claims freshness and observation bindings or fabricated finality fail closed', async () => {
  const f = receiptFixture(); await f.flow.load(f.task.digest); const raw = structuredClone(f.view());
  assert.equal(f.client.view(raw).completion.fresh, false);
  assert.throws(() => f.client.view({ ...raw, completion: { ...raw.completion, fresh: true } }), /TASK_OBSERVATION_FRESHNESS_REFUSED/);
  for (const key of ['taskDigest', 'childDigest', 'chainId', 'actor', 'attemptExecutorDigest', 'originalTransactionHash', 'verifierVersion', 'protocolFinality']) {
    const bad = structuredClone(raw); bad.observations[0].observation[key] = key === 'actor' ? `0x${'33'.repeat(20)}` : key === 'chainId' || key === 'verifierVersion' ? '2' : key === 'protocolFinality' ? 'final' : `0x${'f'.repeat(64)}`;
    assert.throws(() => f.client.view(bad), /TASK_OBSERVATION_/);
  }
  const bad = structuredClone(raw); bad.observations[0].observation.effect = 'atomic-sale-observed';
  assert.throws(() => f.client.view(bad), /TASK_OBSERVATION_EFFECT_REFUSED/);
});
test('late receipt refresh cannot restore current evidence after cancel or logout', async () => {
  for (const action of ['cancel', 'logout']) {
    const f = receiptFixture(); await f.flow.load(f.task.digest); let release!: () => void; f.setHold(new Promise<void>(r => { release = r; }));
    const pending = f.flow.recover(); if (action === 'cancel') f.flow.suspend(); else f.flow.lock(); release(); await pending;
    assert.equal(f.flow.snapshot().phase, action === 'cancel' ? 'paused' : 'locked');
    assert.equal(f.flow.snapshot().selected?.completion.fresh ?? false, false);
  }
});
test('receipt UI shows explicit depth, verifier, historical evidence and read-only refresh; terminal polling stops', async () => {
  const fixture = receiptFixture(), f = uiFixture({ fixtureOverride: fixture });
  f.events.dispatchEvent({ type: 'wallet:page', detail: 'tasks' }); await tick();
  assert.equal(f.result.snapshot().phase, 'completed-at-observation-depth'); assert.equal(f.timers.size, 0);
  const values = f.el('task-summary').children.flatMap((row: Node) => row.children.map(n => n.textContent));
  for (const value of ['2', receiptPolicy.digest, verifier.verifierId, verifier.verifierVersion, verifier.verifierImplementationDigest]) assert.ok(values.includes(value));
  assert.match(f.el('task-recover').textContent, /Refresh transaction observation/); assert.equal(f.el('task-recover').hidden, false);
  assert.match(f.el('task-observation-freshness').textContent, /Refreshed/);
  f.document.visibilityState = 'hidden'; f.events.dispatchEvent({ type: 'visibilitychange' });
  assert.equal(f.result.snapshot().selected.completion.fresh, false); assert.match(f.el('task-observation-freshness').textContent, /Saved evidence/);
  f.document.visibilityState = 'visible'; f.events.dispatchEvent({ type: 'visibilitychange' }); fixture.fail(); f.el('task-recover').click(); await tick();
  assert.match(f.el('task-observation-states').children[0]!.textContent, /unavailable/); assert.equal(f.result.snapshot().phase, 'awaiting-evidence');
  f.subscriber(null); assert.equal(f.el('task-observations').textContent, '');
});
test('observation arriving after app switch is immediately historical and never restarts hidden polling', async () => {
  const fixture = receiptFixture(), f = uiFixture({ fixtureOverride: fixture });
  f.events.dispatchEvent({ type: 'wallet:page', detail: 'tasks' }); await tick();
  let release!: () => void; fixture.setHold(new Promise<void>(r => { release = r; }));
  f.el('task-recover').click(); f.document.visibilityState = 'hidden'; f.events.dispatchEvent({ type: 'visibilitychange' });
  release(); await tick(); assert.equal(f.result.snapshot().selected.completion.fresh, false); assert.equal(f.timers.size, 0);
  assert.match(f.el('task-observation-freshness').textContent, /Saved evidence/);
});
test('revoked task may refresh its saved submission without new authorization or execution', async () => {
  const f = receiptFixture(); f.statuses.set(f.task.digest, 'revoked'); await f.flow.load(f.task.digest);
  assert.equal(f.flow.snapshot().phase, 'revoked'); assert.equal(f.flow.snapshot().selected.completion.fresh, true);
  f.state('reorged'); await f.flow.recover();
  assert.equal(f.flow.snapshot().phase, 'revoked'); assert.equal(f.flow.snapshot().selected.completion.state, 'awaiting-evidence');
  assert.equal(f.requests.some(r => /resume|authorize|execute|reserve/.test(r.path)), false);
});
test('task 429 exposes only bounded retry scheduling metadata and never treats it as success', async () => {
  for (const [path, status, header, seconds, expected] of [
    ['tasks/resume', 429, '90', 90, 90000], ['tasks/observe', 429, null, 900, 900000],
    ['tasks/resume', 429, null, 0, undefined], ['tasks/resume', 503, '90', 90, undefined], ['account', 429, '90', 90, undefined],
  ] as const) {
    const client = new AccountAuthClient({ tenant: 'xiongan', origin, fetcher: async () => ({ ok: false, status,
      headers: { get: () => header }, text: async () => JSON.stringify({ error: 'AUTH_RATE_LIMITED', retryAfterSeconds: seconds }) }) });
    await assert.rejects(client.request(path, {}), (error: any) => {
      assert.equal(error.code, 'AUTH_RATE_LIMITED'); assert.equal(error.retryAfterMs, expected); return true;
    });
  }
});
test('virtual long waiting backs off, honors 429 cooldown then continues the same grant without another OTP', async () => {
  const base = fixture(); base.statuses.set(base.task.digest, 'authorized'); let time = now, resumes = 0, rateUntil = 0;
  const request = async (path: string, body: any) => {
    const raw: any = await base.request(path, body);
    if (raw?.effectiveStatus === 'authorized') raw.capabilities = { ...raw.capabilities, adapterConfigured: true };
    if (path !== 'tasks/resume') return raw;
    resumes++;
    if (resumes === 9) rateUntil = time + 90000;
    if (rateUntil && time < rateUntil) throw Object.assign(Error('limited'), { code: 'AUTH_RATE_LIMITED', status: 429, retryAfterMs: rateUntil - time });
    if (rateUntil) return { ...raw, completion: { state: 'awaiting-evidence', fresh: false },
      budget: { schema: '8415-task-budget/1', taskDigest: base.task.digest, revision: '3', reservations: [
        { operationId: 'op:after-wait', childDigest: `0x${'a'.repeat(64)}`, feeWei: '1', units: '1', status: 'submitted', transactionHash: `0x${'b'.repeat(64)}` }] },
      continuation: { state: 'submitted', operationId: 'op:after-wait' } };
    return { ...raw, continuation: { state: 'waiting-for-operation', code: 'TASK_NO_CANDIDATE' } };
  };
  const f = uiFixture({ fixtureOverride: { ...base, request }, nowFn: () => time });
  f.events.dispatchEvent({ type: 'wallet:page', detail: 'tasks' }); await tick();
  const delays: number[] = [];
  while (f.result.snapshot().phase !== 'rate-limited') {
    const [id, callback] = [...f.timers][0]!; const delay = f.delays.get(id)!; delays.push(delay);
    assert.ok(delays.length < 12); f.timers.delete(id); time += delay; callback(); await tick();
  }
  assert.deepEqual(delays.slice(0, 4), [30000, 60000, 120000, 120000]); assert.ok(time - now > 600000);
  assert.equal(f.result.snapshot().selected.task.digest, base.task.digest); assert.equal(f.result.snapshot().selected.executor.digest, executor.digest);
  assert.equal(f.result.snapshot().selected.effectiveStatus, 'authorized'); assert.equal(f.result.snapshot().selected.executionState, 'not-started');
  assert.equal(f.el('task-recheck').disabled, true); assert.match(f.el('task-status').textContent, /rate-limited/);
  const before = base.requests.length, [id, callback] = [...f.timers][0]!, delay = f.delays.get(id)!;
  assert.ok(delay >= 90000); assert.equal(base.requests.at(-1).path, 'tasks/resume', 'No extra status request spends quota after429');
  f.timers.delete(id); time += delay; callback(); await tick();
  assert.equal(base.requests.length, before + 1); assert.equal(f.result.snapshot().phase, 'submitted');
  assert.equal(f.result.snapshot().selected.task.digest, base.task.digest); assert.equal(f.result.snapshot().selected.authorization.grantPolicyVersion, '1');
  assert.equal(base.requests.some(r => /authorize|reserve|execute/.test(r.path)), false);
  f.events.dispatchEvent({ type: 'wallet:page', detail: 'overview' });
});
test('429 after successful approval retries continuation only; a denied approval is never automatically replayed', async () => {
  for (const denied of ['authorize', 'resume']) {
    const base = fixture(); let time = now, limited = true;
    const client = new TaskAuthorizationClient({ context, request: async (path: string, body: any) => {
      if (limited && path === `tasks/${denied}`) {
        base.requests.push({ path, body }); throw Object.assign(Error('limited'), { code: 'AUTH_RATE_LIMITED', status: 429, retryAfterMs: 30000 });
      }
      const raw: any = await base.request(path, body);
      if (raw?.effectiveStatus === 'authorized') raw.capabilities.adapterConfigured = true;
      return raw;
    } });
    const flow = new TaskAuthorizationFlow({ client, now: () => time }); await flow.load(base.task.digest); await flow.authorize('123456');
    assert.equal(flow.snapshot().phase, denied === 'authorize' ? 'uncertain' : 'rate-limited');
    const before = base.requests.length; await flow.continue(); assert.equal(base.requests.length, before);
    time += 30000; limited = false; await flow.continue();
    assert.equal(base.requests.filter((r: any) => r.path === 'tasks/authorize').length, 1);
    assert.equal(flow.snapshot().phase, denied === 'authorize' ? 'uncertain' : 'authorized-blocked');
  }
});
test('two visible tabs share one automatic polling lease and hand it over when the leader hides', async () => {
  const locks = fakeLocks(), first = uiFixture({ executable: true, locks }), second = uiFixture({ executable: true, locks });
  for (const f of [first, second]) {
    f.statuses.set(f.task.digest, 'authorized'); f.events.dispatchEvent({ type: 'wallet:page', detail: 'tasks' }); await tick();
  }
  assert.match(second.el('task-auto-status').textContent, /Another visible wallet tab/);
  const before = second.requests.length, [id, callback] = [...second.timers][0]!;
  second.timers.delete(id); callback(); await tick(); assert.equal(second.requests.length, before, 'Follower only attempts a local lock');
  first.document.visibilityState = 'hidden'; first.events.dispatchEvent({ type: 'visibilitychange' }); await tick();
  const [nextId, nextCallback] = [...second.timers][0]!; second.timers.delete(nextId); nextCallback(); await tick();
  assert.equal(second.el('task-auto-status').textContent, '');
  const [pollId, poll] = [...second.timers][0]!; second.timers.delete(pollId); poll(); await tick(); assert.equal(second.requests.length, before + 1);
  assert.equal(first.timers.size, 0); second.events.dispatchEvent({ type: 'wallet:page', detail: 'overview' });
});
test('missing cross-tab locks clearly pauses page polling without persisting a fake coordination or grant flag', async () => {
  const f = uiFixture({ executable: true, locks: null }); f.statuses.set(f.task.digest, 'authorized');
  f.events.dispatchEvent({ type: 'wallet:page', detail: 'tasks' }); await tick();
  assert.equal(f.timers.size, 0); assert.match(f.el('task-auto-status').textContent, /coordination is unavailable/);
  assert.equal(f.result.snapshot().selected.effectiveStatus, 'authorized');
});
