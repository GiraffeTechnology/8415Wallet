import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createAuthService } from '../server/auth-service.mjs';
import { createTaskAuthorizationService } from '../server/task-authorization.mjs';
import { createTaskBackgroundRunner } from '../server/task-background-runner.mjs';
import { MemoryCredentialStore, openEncryptedStore } from '../server/store.mjs';
import { base32, hotp, matchTotp, hashPassword } from '../server/crypto.mjs';
import { freezeTaskObservationPolicy } from '../src/agent/receiptObservation.ts';

// Synthetic keys, actors, receipts and time only. No provider/network/signing.
const actor = `0x${'1'.repeat(40)}`, recipient = `0x${'2'.repeat(40)}`, txHash = `0x${'a'.repeat(64)}`;
const epoch = 1_800_000_000_000, secret = base32(Buffer.alloc(20, 0x37));
const executorIdentity = { schema: '8415-task-executor/1', agentId: 'synthetic:background', agentVersion: '1',
  adapterId: 'synthetic:only', adapterVersion: '1', implementationDigest: `0x${'9'.repeat(64)}` };
const observationPolicy = { minimumConfirmations: '2' };
const receiptIdentity = { verifierId: 'synthetic:receipt', verifierVersion: '1', verifierImplementationDigest: `0x${'7'.repeat(64)}` };
function policy(taskId = 'task:background') {
  return { schema: '8415-agent-task/1', taskId, tenant: 'xiongan', origin: 'https://wallet.example.invalid', chainId: '11155111', actor,
    expiresAt: String(epoch / 1000 + 7200), fees: { perOperationWei: '100000', totalWei: '200000' },
    intent: { kind: 'exact-operation', operation: { kind: 'native-transfer', chainId: '11155111', actor, recipient, valueWei: '10' } } };
}
function binding(input: any) {
  return { taskDigest: input.task.digest, childDigest: input.child.digest, chainId: input.child.child.operation.chainId,
    actor: input.child.child.operation.actor, nonce: input.child.child.nonce, executorDigest: input.executor.digest, grantPolicyVersion: input.grantPolicyVersion };
}
function fixture(options: any = {}) {
  const state = options.state ?? { now: epoch };
  const store = options.store ?? new MemoryCredentialStore({ 'xiongan:tester': { secret, lastStep: -1, revision: 1 } });
  const session = { username: 'tester', account: actor, chainId: '11155111', id: 'session:synthetic', revision: 1, issuedAt: epoch, expiresAt: epoch + 900000 };
  const sessions = new Set([session]), calls = { plan: 0, verify: 0, send: 0, recover: 0, observe: 0 };
  const assertSession = (s: any, c?: any) => { if (!sessions.has(s) || state.now >= s.expiresAt || c !== undefined && c?.revision !== s.revision) throw Error('AUTH_REFUSED'); };
  const execution = options.noAdapter ? null : {
    async plan(input: any) { calls.plan++; await options.onPlan?.(input);
      return { schema: '8415-agent-child/1', operationId: 'operation:background', taskDigest: input.task.digest, operation: input.task.policy.intent.operation,
        nonce: '7', expiresAt: String(Math.floor(state.now / 1000) + 600),
        wire: { to: recipient, calldataHash: '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470', valueWei: '10' },
        fees: { gasLimit: '21000', maxFeePerGasWei: options.excessFees ? '100000' : '2' }, market: null };
    },
    async verify(input: any) { calls.verify++; await options.onVerify?.(input); return binding(input); },
    async send(input: any) { calls.send++; if (options.failSend) throw Error('Synthetic lost response'); return { ...binding(input), transactionHash: txHash }; },
    async recover(input: any) { calls.recover++; if (options.failRecover) throw Error('Synthetic unavailable evidence'); return { ...binding(input), state: 'submitted', transactionHash: txHash }; },
  };
  const receipt = execution ? { identity: options.receiptIdentity ?? receiptIdentity, observationPolicy: freezeTaskObservationPolicy(observationPolicy),
    async assessChild(input: any) { return { taskDigest: input.task.digest, childDigest: input.child.digest, executorDigest: input.executor.digest,
      observationPolicyDigest: freezeTaskObservationPolicy(input.observationPolicy).digest, ...receiptIdentity, capability: 'exact-operation-observable' }; },
    async observe(input: any) { calls.observe++; return {
      schema: '8415-task-observation/1', taskDigest: input.task.digest, childDigest: input.child.digest,
      chainId: input.child.child.operation.chainId, actor: input.child.child.operation.actor, nonce: input.child.child.nonce,
      attemptExecutorDigest: input.attempt.executorDigest, attemptGrantPolicyVersion: input.attempt.grantPolicyVersion,
      originalTransactionHash: input.attempt.transactionHash, observationPolicy: input.observationPolicy,
      observationPolicyDigest: freezeTaskObservationPolicy(input.observationPolicy).digest, state: 'confirmed-at-depth',
      blockNumber: '42', blockHash: `0x${'6'.repeat(64)}`, confirmations: '2', replacementHash: null,
      observedAt: String(Math.floor(state.now / 1000)), effect: 'exact-operation-observed',
      protocolFinality: 'not-evaluated', economicFinality: 'not-evaluated', ...receiptIdentity };
    } } : null;
  const service = createTaskAuthorizationService({ origin: policy().origin, tenant: 'xiongan', store, now: () => state.now,
    assertSession, async credentialFor(s: any) { const c = await store.read('xiongan:tester'); assertSession(s, c); return c; },
    assertPrincipal(p: any, c: any) { if (p.username !== 'tester' || p.account !== actor || p.chainId !== '11155111' || c !== undefined && !c?.secret) throw Error('AUTH_PRINCIPAL_REFUSED'); },
    consumeTotp(s: any, c: any, code: string) { assertSession(s, c); const step = matchTotp(c.secret, code, state.now, c.lastStep);
      if (step === null) throw Error('AUTH_REFUSED'); return { ...c, lastStep: step }; },
    execution, executorIdentity: execution ? options.executorIdentity ?? executorIdentity : null,
    observationPolicy: execution ? observationPolicy : null, receipt,
  });
  const call = (path: string, body: any) => service.handler(`tasks/${path}`, body, session);
  const prepare = (p = policy()) => call('prepare', { policy: p });
  const authorize = (p: any) => call('authorize', { challengeId: p.challengeId, taskDigest: p.task.digest, executorDigest: p.executor.digest,
    observationPolicyDigest: p.observationPolicy?.digest ?? null, code: hotp(secret, Math.floor(state.now / 30000)) });
  const grant = async (p = policy()) => authorize(await prepare(p));
  const runner = (config: any = {}) => createTaskBackgroundRunner({ store, continuation: service.background, now: () => state.now, ...config });
  return { service, store, state, session, sessions, calls, call, prepare, authorize, grant, runner, execution, receipt };
}

test('only completed durable human approval enters the background queue', async () => {
  const f = fixture(), p = await f.prepare();
  assert.deepEqual((await f.service.background.list({ cursor: '0', limit: 10 })).entries, []);
  await assert.rejects(f.call('authorize', { challengeId: p.challengeId, taskDigest: p.task.digest, executorDigest: p.executor.digest,
    observationPolicyDigest: p.observationPolicy.digest, code: 'invalid' }));
  assert.deepEqual((await f.service.background.list({ cursor: '0', limit: 10 })).entries, []);
  await f.authorize(p); assert.equal((await f.service.background.list({ cursor: '0', limit: 10 })).entries.length, 1);
  await assert.rejects(f.service.background.resume('arbitrary-json-grant'));
});

test('closing the page and losing all ordinary sessions still permits bounded internal continuation', async () => {
  const f = fixture(), g = await f.grant(), runner = f.runner(); f.sessions.clear(); f.service.cancel(f.session);
  await assert.rejects(f.call('resume', { taskDigest: g.task.digest }), /AUTH_REFUSED/);
  const first = await runner.tick(); assert.equal(first.results[0].state, 'submitted'); assert.equal(f.calls.send, 1);
  f.state.now += 5000; const observed = await runner.tick(); assert.equal(observed.results[0].state, 'completed-at-observation-depth');
  f.state.now += 600000; assert.equal((await runner.tick()).results.length, 0); assert.equal(f.calls.send, 1); assert.equal(f.calls.observe, 1);
  // The service context cannot be manufactured by posting the principal as JSON.
  await assert.rejects(f.service.handler('tasks/resume', { taskDigest: g.task.digest }, { username: 'tester', account: actor, chainId: '11155111' }), /AUTH_REFUSED/);
});

test('ordinary session expiry never extends the session and does not expire its independent approved grant', async () => {
  const f = fixture(), g = await f.grant(); f.state.now = f.session.expiresAt + 1;
  await assert.rejects(f.call('resume', { taskDigest: g.task.digest }), /AUTH_REFUSED/);
  assert.equal((await f.runner().tick()).results[0].state, 'submitted'); assert.equal(f.calls.send, 1);
  assert.equal(f.session.expiresAt, epoch + 900000);
});

test('revocation, factor rotation, task expiry and child expiry during verification stop new sends', async () => {
  for (const change of ['revoke', 'factor', 'expiry', 'child-expiry']) {
    let f: any, g: any;
    f = fixture({ onVerify: async () => {
      if (change === 'revoke') await f.call('revoke', { taskDigest: g.task.digest, expectedGrantPolicyVersion: '1' });
      if (change === 'factor') await f.store.transaction('xiongan:tester', (c: any) => ({ ...c, revision: 2 }));
      if (change === 'expiry') f.state.now += 7200000;
      if (change === 'child-expiry') f.state.now += 601000;
    } });
    g = await f.grant(); const result = await f.runner().tick();
    assert.equal(result.results[0].state, 'blocked', change); assert.equal(f.calls.send, 0, change);
  }
});

test('default unconfigured signer stays blocked and backs off without adding credentials', async () => {
  const f = fixture({ noAdapter: true }), g = await f.grant(), runner = f.runner(); f.sessions.clear();
  const first = await runner.tick(); assert.equal(first.results[0].state, 'blocked'); assert.equal(first.results[0].code, 'TASK_EXECUTION_ADAPTER_NOT_CONNECTED');
  f.state.now += 5000; assert.equal((await runner.tick()).results.length, 0);
  f.state.now += 25000; assert.equal((await runner.tick()).results.length, 1);
  f.state.now += 30000; assert.equal((await runner.tick()).results.length, 0);
  assert.equal(f.calls.send, 0); assert.equal(g.executor.identity.adapterId, 'unconfigured-signer');
  assert.deepEqual(Object.keys(await f.store.read('xiongan:tester')).sort(), ['lastStep', 'revision', 'secret']);
});

test('budget excess and executor or receipt-identity drift remain blocked in background', async () => {
  const expensive = fixture({ excessFees: true }); await expensive.grant();
  assert.equal((await expensive.runner().tick()).results[0].state, 'blocked'); assert.equal(expensive.calls.send, 0);
  const original = fixture(); await original.grant();
  for (const changed of [{ executorIdentity: { ...executorIdentity, adapterVersion: '2' } }, { receiptIdentity: { ...receiptIdentity, verifierVersion: '2' } }]) {
    const f = fixture({ store: original.store, ...changed }); f.sessions.clear();
    assert.equal((await f.runner().tick()).results[0].state, 'blocked'); assert.equal(f.calls.plan, 0); assert.equal(f.calls.send, 0);
  }
});

test('encrypted restart resumes an unknown attempt read-only after factor change without a second send', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wallet-background-')), path = join(directory, 'state.enc'), key = Buffer.alloc(32, 0x45);
  let store: any;
  try {
    store = await openEncryptedStore(path, key);
    await store.transaction('xiongan:tester', () => ({ secret, lastStep: -1, revision: 1 }));
    const f = fixture({ store, failSend: true, failRecover: true }), g = await f.grant(), runner = f.runner(); f.sessions.clear();
    assert.equal((await runner.tick()).results[0].state, 'outcome-unknown');
    f.state.now += 5000; assert.equal((await runner.tick()).results[0].state, 'blocked'); assert.equal(f.calls.send, 1);
    await store.transaction('xiongan:tester', (c: any) => ({ ...c, revision: 2 }));
    await runner.stop(); await store.close(); store = await openEncryptedStore(path, key);
    const restored = fixture({ store, state: f.state }), resumed = restored.runner(); restored.sessions.clear();
    const progress = await resumed.tick(); assert.equal(progress.results[0].state, 'submitted');
    assert.equal(restored.calls.plan, 0); assert.equal(restored.calls.send, 0); assert.equal(restored.calls.recover, 1);
    restored.state.now += 5000; assert.equal((await resumed.tick()).results[0].state, 'completed-at-observation-depth');
    restored.session.revision = 2; restored.sessions.add(restored.session);
    const status = await restored.call('status', { taskDigest: g.task.digest });
    assert.equal(status.effectiveStatus, 'suspended'); assert.equal(status.budget.reservations.length, 1); assert.equal(status.budget.reservations[0].feeWei, '42000');
    await resumed.stop();
  } finally { if (store) await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('multiple workers sharing the exact single-writer store cannot overlap continuation or replace a hung attempt', async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), arrival = new Promise<void>(resolve => { entered = resolve; });
  const f = fixture({ onVerify: async () => { entered(); await gate; } }); await f.grant(); f.sessions.clear();
  const first = f.runner(), second = f.runner(), pending = first.tick(); await arrival;
  assert.equal((await second.tick()).state, 'busy');
  f.state.now += 300000; assert.equal((await second.tick()).state, 'busy'); assert.equal(f.calls.send, 0);
  let stopped = false; const stop = first.stop().then(() => { stopped = true; }); await Promise.resolve(); assert.equal(stopped, false);
  release(); assert.equal((await pending).results[0].state, 'submitted'); await stop;
  assert.equal((await second.tick()).results[0].state, 'completed-at-observation-depth'); assert.equal(f.calls.send, 1);
});

test('bounded append-only cursor remains fair while earlier tasks are blocked and new tasks are appended', async () => {
  const store = new MemoryCredentialStore(), entries = ['one', 'two', 'three'], visited: string[] = [];
  let now = 0;
  const continuation = { async list({ cursor, limit }: any) { const start = Number(cursor), page = entries.slice(start, start + limit);
    return { entries: page, nextCursor: start + page.length < entries.length ? String(start + page.length) : null }; },
    async resume(entry: string) { visited.push(entry); return { continuation: { state: entry === 'one' ? 'blocked' : 'waiting-for-operation' } }; } };
  const runner = createTaskBackgroundRunner({ store, continuation, now: () => now, maxPerTick: 1 });
  for (let i = 0; i < 3; i++) { assert.equal((await runner.tick()).visited, 1); entries.push(`new:${i}`); now += 5000; }
  assert.deepEqual(visited, ['one', 'two', 'three']);
  assert.equal((await runner.tick()).visited, 1); assert.equal(visited[3], 'new:0');
});

test('runner captures its internal port and always releases its mutex after index failures', async () => {
  const store = new MemoryCredentialStore(); let fail = true, resumed = 0;
  const continuation = { async list() { if (fail) throw Error('AUTH_STORE_UNHEALTHY'); return { entries: ['existing-grant'], nextCursor: null }; },
    async resume() { resumed++; return { continuation: { state: 'blocked' } }; } };
  const first = createTaskBackgroundRunner({ store, continuation });
  continuation.resume = async () => { throw Error('Mutated adapter must not be captured'); };
  await assert.rejects(first.tick(), /AUTH_STORE_UNHEALTHY/); fail = false;
  assert.equal((await first.tick()).results[0].state, 'blocked'); assert.equal(resumed, 1);
  const bad = createTaskBackgroundRunner({ store, continuation: { async list() { return { entries: [], nextCursor: '0' }; }, async resume() {} } });
  await assert.rejects(bad.tick(), /TASK_BACKGROUND_INDEX_REFUSED/);
  assert.equal((await first.tick()).state, 'idle');
});

test('real HTTP approval then logout or session expiry continues only via the internal service port', async t => {
  for (const end of ['logout', 'expiry']) {
    const f = fixture(), password = 'synthetic-background-password', passwordHash = await hashPassword(password);
    let handler: any; const server = createServer((req, res) => handler(req, res)); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
    const origin = `http://127.0.0.1:${(server.address() as any).port}`;
    handler = createAuthService({ origin, tenant: 'xiongan', store: f.store, now: () => f.state.now,
      accounts: [{ username: 'tester', passwordHash, wallets: [{ account: actor, chainId: '11155111' }] }],
      taskExecution: f.execution, taskExecutorIdentity: executorIdentity, taskObservationPolicy: observationPolicy, taskReceipt: f.receipt });
    let csrf = ''; const jar = new Map<string, string>();
    async function call(path: string, body?: any) {
      const response = await fetch(`${origin}/auth/${path}`, { method: body === undefined ? 'GET' : 'POST',
        headers: { Origin: origin, 'X-Wallet-Tenant': 'xiongan', 'X-Wallet-CSRF': csrf,
          Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      for (const cookie of response.headers.getSetCookie()) { const [k, v] = cookie.split(';')[0]!.split('='); if (v) jar.set(k!, v); else jar.delete(k!); }
      const data = await response.json() as any; if (data.csrf) csrf = data.csrf; return { status: response.status, data };
    }
    await call('bootstrap');
    assert.equal((await call('password', { username: 'tester', password, account: actor, chainId: '11155111' })).status, 200);
    const prepared = await call('tasks/prepare', { policy: { ...policy(), origin } }); assert.equal(prepared.status, 200);
    const p = prepared.data;
    const approved = await call('tasks/authorize', { challengeId: p.challengeId, taskDigest: p.task.digest, executorDigest: p.executor.digest,
      observationPolicyDigest: p.observationPolicy.digest, code: hotp(secret, Math.floor(f.state.now / 30000)) });
    assert.equal(approved.status, 200);
    assert.equal(Object.keys(handler).includes('taskBackground'), false);
    if (end === 'logout') assert.equal((await call('logout', {})).status, 200);
    else f.state.now += 900001;
    assert.equal((await call('tasks/resume', { taskDigest: p.task.digest })).status, 401);
    assert.ok((await call('tasks/background/resume', { entry: 'guessed' })).status >= 400);
    const runner = createTaskBackgroundRunner({ store: f.store, continuation: handler.taskBackground, now: () => f.state.now });
    assert.equal((await runner.tick()).results[0].state, 'submitted', end);
    f.state.now += 5000; assert.equal((await runner.tick()).results[0].state, 'completed-at-observation-depth', end);
    assert.equal(f.calls.send, 1); assert.equal(f.calls.plan, 1); await runner.stop();
  }
});

test('approval storage failure does not consume the OTP or register a background job', async () => {
  class RejectingStore extends MemoryCredentialStore {
    constructor(data: any) { super(data); }
    fail = false;
    async persist(data: any) {
      if (this.fail) throw Error('Synthetic durable write failure');
      return super.persist(data);
    }
  }
  // Capacity rejection is determinate and must leave every old field unchanged.
  class CapacityStore extends MemoryCredentialStore {
    constructor(data: any) { super(data); }
    fail = false;
    async transactionMany(keys: string[], update: any) {
      if (this.fail && keys.some(key => key.startsWith('task-queue:'))) throw Error('AUTH_STORE_CAPACITY');
      return super.transactionMany(keys, update);
    }
  }
  const store = new CapacityStore({ 'xiongan:tester': { secret, lastStep: -1, revision: 1 } }), f = fixture({ store });
  const p = await f.prepare(); store.fail = true; await assert.rejects(f.authorize(p), /TASK_STORE_CAPACITY/); store.fail = false;
  assert.equal((await f.service.background.list({})).entries.length, 0); assert.equal((await store.read('xiongan:tester')).lastStep, -1);
  assert.equal((await f.authorize(p)).effectiveStatus, 'authorized');
  // An uncertain persist failure poisons the store; no worker can infer approval.
  const uncertain = new RejectingStore({ 'xiongan:tester': { secret, lastStep: -1, revision: 1 } }), u = fixture({ store: uncertain });
  const pending = await u.prepare(); uncertain.fail = true; await assert.rejects(u.authorize(pending), /Synthetic durable write failure/);
  await assert.rejects(u.runner().tick(), /AUTH_STORE_UNHEALTHY/); assert.equal(u.calls.send, 0);
});

test('encrypted restart recovers approved unattempted work while the file lock excludes another writer', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wallet-approved-')), path = join(directory, 'state.enc'), key = Buffer.alloc(32, 0x46);
  let store: any;
  try {
    store = await openEncryptedStore(path, key);
    await store.transaction('xiongan:tester', () => ({ secret, lastStep: -1, revision: 1 }));
    const f = fixture({ store }); await f.grant(); f.sessions.clear();
    await assert.rejects(openEncryptedStore(path, key), (error: any) => error.code === 'EEXIST');
    await store.close(); store = await openEncryptedStore(path, key);
    const restored = fixture({ store }); restored.sessions.clear();
    assert.equal((await restored.runner().tick()).results[0].state, 'submitted'); assert.equal(restored.calls.send, 1);
  } finally { if (store) await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('timer lifecycle starts without a browser, coalesces repeated starts and stops before store closure', async () => {
  const store = new MemoryCredentialStore(); let resolveRun!: () => void, release!: () => void, calls = 0;
  const began = new Promise<void>(resolve => { resolveRun = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const continuation = { async list() { return { entries: ['approved'], nextCursor: null }; }, async resume() {
    calls++; resolveRun(); await gate; return { continuation: { state: 'completed-at-observation-depth' } };
  } };
  const runner = createTaskBackgroundRunner({ store, continuation, intervalMs: 10, idleBackoffMs: 30, maxBackoffMs: 100 });
  runner.start(); runner.start(); await began; assert.equal(calls, 1);
  let stopped = false; const stopping = runner.stop().then(() => { stopped = true; });
  await Promise.resolve(); assert.equal(stopped, false); release(); await stopping;
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(calls, 1);
  await store.close();
});
