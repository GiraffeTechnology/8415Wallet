import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAuthService } from '../server/auth-service.mjs';
import { createTaskAuthorizationService, freezeTaskExecutorIdentity } from '../server/task-authorization.mjs';
import { MemoryCredentialStore, openEncryptedStore } from '../server/store.mjs';
import { base32, hashPassword, hotp, matchTotp } from '../server/crypto.mjs';
import { freezeChildOperation } from '../src/agent/taskContract.ts';
import { freezeTaskObservationPolicy } from '../src/agent/receiptObservation.ts';
import { createTaskReceiptAdapter } from '../server/task-receipt-adapter.mjs';
const actor = `0x${'1'.repeat(40)}`, recipient = `0x${'2'.repeat(40)}`;
const secret = base32(Buffer.alloc(20, 0x37)); // Synthetic local fixture only.
const executorIdentity = { schema: '8415-task-executor/1', agentId: 'synthetic:agent', agentVersion: '1', adapterId: 'synthetic:adapter', adapterVersion: '1', implementationDigest: `0x${'9'.repeat(64)}` };
const epoch = 1_800_000_000_000, txHash = `0x${'a'.repeat(64)}`;
const emptyCalldataHash = '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470';
function policy({ taskId = 'task:one', tenant = 'xiongan', origin = 'https://wallet.example.invalid', account = actor } = {}) {
  return { schema: '8415-agent-task/1', taskId, tenant, origin, chainId: '11155111', actor: account,
    expiresAt: String(epoch / 1000 + 7200), fees: { perOperationWei: '100000', totalWei: '200000' },
    intent: { kind: 'exact-operation', operation: { kind: 'native-transfer', chainId: '11155111', actor: account, recipient, valueWei: '10' } } };
}
function child(task: any, operationId = 'operation:one', nonce = '7') {
  return { schema: '8415-agent-child/1', operationId, taskDigest: task.digest, operation: task.policy.intent.operation,
    nonce, expiresAt: String(epoch / 1000 + 600), wire: { to: recipient, calldataHash: emptyCalldataHash, valueWei: '10' },
    fees: { gasLimit: '21000', maxFeePerGasWei: '2' }, market: null };
}
function fixture(options: any = {}) {
  const state = { now: epoch }, tenant = options.tenant ?? 'xiongan', origin = options.origin ?? 'https://wallet.example.invalid';
  const store = options.store ?? new MemoryCredentialStore({ [`${tenant}:tester`]: { secret, lastStep: -1, revision: 1, sentinel: 'old-factor' } });
  const sessions = new Set<any>(), session = { username: 'tester', account: actor, chainId: '11155111', id: 'session:1', revision: 1, issuedAt: epoch, expiresAt: epoch + 900000 };
  sessions.add(session);
  function assertSession(s: any, c?: any) { if (!sessions.has(s) || state.now < s.issuedAt || state.now >= s.expiresAt || c !== undefined && c?.revision !== s.revision) throw Error('AUTH_REFUSED'); }
  const service = createTaskAuthorizationService({ origin, tenant, store, now: () => state.now, execution: options.execution ?? null, executorIdentity: options.execution ? (options.executorIdentity ?? executorIdentity) : null,
    observationPolicy: options.execution ? (options.observationPolicy ?? { minimumConfirmations: '2' }) : null, receipt: options.receipt === null ? null : (options.receipt ?? (options.execution ? syntheticReceipt({ state: () => 'pending' }).receipt : null)), assertSession,
    async credentialFor(s: any) { const c = await store.read(`${tenant}:${s.username}`); assertSession(s, c); return c; },
    consumeTotp(s: any, c: any, code: string) { assertSession(s, c); const step = matchTotp(c.secret, code, state.now, c.lastStep);
      if (step === null) throw Error('AUTH_REFUSED'); return { ...c, lastStep: step }; },
  });
  const call = (path: string, body: any, who = session) => service.handler(`tasks/${path}`, body, who);
  const code = () => hotp(secret, Math.floor(state.now / 30000));
  const prepare = (input = policy({ tenant, origin })) => call('prepare', { policy: input });
  const authorize = (p: any) => call('authorize', { challengeId: p.challengeId, taskDigest: p.task.digest, executorDigest: p.executor.digest, observationPolicyDigest: p.observationPolicy?.digest ?? null, code: code() });
  const grant = async (input = policy({ tenant, origin })) => authorize(await prepare(input));
  const reserve = (g: any, c = child(g.task)) => call('reserve', { taskDigest: g.task.digest, child: c, expectedBudgetRevision: g.budget.revision });
  const operationBody = (g: any, c = child(g.task)) => ({ taskDigest: g.task.digest, operationId: c.operationId, childDigest: freezeChildOperation(c).digest, expectedBudgetRevision: g.budget.revision });
  return { service, session, sessions, state, store, code, call, prepare, authorize, grant, reserve, operationBody };
}
function binding(input: any) { return { taskDigest: input.task.digest, childDigest: input.child.digest, chainId: input.child.child.operation.chainId,
  actor: input.child.child.operation.actor, nonce: input.child.child.nonce, executorDigest: input.executor.digest, grantPolicyVersion: input.grantPolicyVersion }; }
function syntheticAdapter({ failSend = false, onVerify = async () => {} } = {}) {
  const calls = { verify: 0, send: 0, recover: 0 };
  const execution = {
    async verify(input: any) { calls.verify++; await onVerify(); return binding(input); },
    async send(input: any) { calls.send++; if (failSend) throw Error('Synthetic connection loss'); return { ...binding(input), transactionHash: txHash }; },
    async recover(input: any) { calls.recover++; return { ...binding(input), state: 'submitted', transactionHash: txHash }; },
  }; return { calls, execution };
}
test('pending task is durable and fresh challenge can be minted after restart without granting authority', async () => {
  const f = fixture(), p = await f.prepare(), list = await f.call('list', {});
  assert.equal(list.tasks.length, 1); assert.equal(list.tasks[0].effectiveStatus, 'pending'); assert.equal(list.tasks[0].authorization, null); assert.equal(list.tasks[0].budget, null);
  const restarted = fixture({ store: f.store }); await assert.rejects(restarted.authorize(p), /TASK_APPROVAL_CHALLENGE_REFUSED/);
  const p2 = await restarted.prepare(); assert.equal(p.task.digest, p2.task.digest); assert.notEqual(p.challengeId, p2.challengeId);
  assert.equal((await restarted.authorize(p2)).effectiveStatus, 'authorized');
});
test('authorization atomically consumes TOTP only for the exact task, independently of login', async () => {
  const f = fixture(), p = await f.prepare();
  await assert.rejects(f.call('authorize', { challengeId: p.challengeId, taskDigest: p.task.digest, approved: true }), /TASK_REQUEST_REFUSED/);
  await assert.rejects(f.call('authorize', { challengeId: p.challengeId, taskDigest: `0x${'3'.repeat(64)}`, executorDigest: p.executor.digest, observationPolicyDigest: p.observationPolicy?.digest ?? null, code: f.code() }), /TASK_APPROVAL_CHALLENGE_REFUSED/);
  const g = await f.authorize(p); assert.equal(g.authorization.credentialRevisionAtApproval, '1'); assert.equal(g.authorization.grantPolicyVersion, '1'); assert.equal(g.capabilities.executable, false);
  const c = await f.store.read('xiongan:tester'); assert.equal(c.lastStep, epoch / 30000); assert.equal(c.secret, secret); assert.equal(c.sentinel, 'old-factor');
  await assert.rejects(f.authorize(p), /TASK_APPROVAL_CHALLENGE_REFUSED/);
  await assert.rejects(f.authorize(await f.prepare(policy({ taskId: 'task:other' }))), /AUTH_REFUSED/);
});
test('concurrent grants cannot reuse an OTP and a task ID cannot bind new contents', async () => {
  const f = fixture(), a = await f.prepare(), b = await f.prepare(policy({ taskId: 'task:second' }));
  assert.equal((await Promise.allSettled([f.authorize(a), f.authorize(b)])).filter(r => r.status === 'fulfilled').length, 1);
  const changed = policy(); changed.intent.operation.valueWei = '11'; await assert.rejects(f.prepare(changed), /TASK_ID_ALREADY_BOUND/);
});
test('approval rejects origin, tenant, account, session substitution, expiry and cancellation', async () => {
  const f = fixture();
  for (const bad of [{ tenant: 'other' }, { origin: 'https://other.invalid' }, { account: `0x${'3'.repeat(40)}` }]) await assert.rejects(f.prepare(policy(bad)), /TASK_PRINCIPAL_BINDING_REFUSED/);
  const p = await f.prepare(), impostor = { ...f.session, id: 'second' }; f.sessions.add(impostor);
  await assert.rejects(f.call('authorize', { challengeId: p.challengeId, taskDigest: p.task.digest, executorDigest: p.executor.digest, observationPolicyDigest: p.observationPolicy?.digest ?? null, code: f.code() }, impostor), /TASK_APPROVAL_CHALLENGE_REFUSED/);
  f.state.now += 120000; await assert.rejects(f.authorize(p), /TASK_APPROVAL_CHALLENGE_REFUSED/);
  const p2 = await f.prepare(); f.service.cancel(f.session); await assert.rejects(f.authorize(p2), /TASK_APPROVAL_CHALLENGE_REFUSED/);
});
test('CAS reserves only once; cancellation preserves operation ID but releases unattempted nonce', async () => {
  const f = fixture(), g = await f.grant(), outcomes = await Promise.allSettled([f.reserve(g), f.reserve(g, child(g.task, 'operation:second', '8'))]);
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
  const r = (outcomes.find(r => r.status === 'fulfilled') as PromiseFulfilledResult<any>).value, op = r.budget.reservations[0];
  const c = child(g.task, op.operationId, op.operationId === 'operation:one' ? '7' : '8'), cancelled = await f.call('cancel-reservation', f.operationBody(r, c));
  assert.equal(cancelled.budget.reservations[0].status, 'cancelled'); await assert.rejects(f.reserve(cancelled, c), /TASK_DUPLICATE_OPERATION_REFUSED/);
  assert.equal((await f.reserve(cancelled, child(g.task, 'operation:replacement', c.nonce))).budget.reservations.length, 2);
});
test('nonce exclusion spans tasks and tenants sharing the single-writer store', async () => {
  const store = new MemoryCredentialStore({ 'xiongan:tester': { secret, lastStep: -1, revision: 1 }, 'giraffe:tester': { secret, lastStep: -1, revision: 1 } });
  const a = fixture({ store }), b = fixture({ store, tenant: 'giraffe' }), ga = await a.grant(), gb = await b.grant(); await a.reserve(ga);
  await assert.rejects(b.reserve(gb, child(gb.task, 'operation:tenant-two')), /TASK_NONCE_OCCUPIED/);
});
test('factor change pauses only affected grants and logout is distinct from grant revocation', async () => {
  const f = fixture(), g = await f.grant(); f.sessions.delete(f.session); await assert.rejects(f.call('status', { taskDigest: g.task.digest }), /AUTH_REFUSED/);
  f.sessions.add(f.session); assert.equal((await f.call('status', { taskDigest: g.task.digest })).effectiveStatus, 'authorized');
  await f.store.transaction('xiongan:tester', (c: any) => ({ ...c, revision: 2 })); f.session.revision = 2;
  const p = await f.call('status', { taskDigest: g.task.digest }); assert.equal(p.authorization.status, 'suspended');
  assert.equal(p.authorization.grantPolicyVersion, '1'); assert.equal(p.authorization.credentialRevisionAtApproval, '1');
  await assert.rejects(f.reserve(p), /TASK_FACTOR_REVALIDATION_REQUIRED/);
  assert.equal((await f.call('revoke', { taskDigest: g.task.digest, expectedGrantPolicyVersion: '1' })).effectiveStatus, 'revoked');
});
test('missing signer and forged receipts cannot execute; resume reports a blocker', async () => {
  const f = fixture(), g = await f.reserve(await f.grant()), body = f.operationBody(g);
  await assert.rejects(f.call('execute', body), /TASK_EXECUTION_ADAPTER_NOT_CONNECTED/); await assert.rejects(f.call('recover', body), /TASK_RECEIPT_VERIFIER_NOT_CONNECTED/);
  await assert.rejects(f.call('recover', { ...body, transactionHash: txHash, verified: true }), /TASK_REQUEST_REFUSED/);
  const status = await f.call('resume', { taskDigest: g.task.digest }); assert.equal(status.continuation.state, 'blocked'); assert.equal(status.budget.reservations[0].status, 'reserved');
});
test('durable unknown boundary permits at most one synthetic send and cannot be released or retried', async () => {
  const a = syntheticAdapter({ failSend: true }), f = fixture(a), g = await f.reserve(await f.grant()), body = f.operationBody(g);
  const outcomes = await Promise.allSettled([f.call('execute', body), f.call('execute', body)]); assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1); assert.equal(a.calls.send, 1);
  const current = await f.call('status', { taskDigest: g.task.digest }); assert.equal(current.budget.reservations[0].status, 'outcome-unknown');
  await assert.rejects(f.call('execute', f.operationBody(current)), /TASK_SEND_ATTEMPT_REFUSED/);
  await assert.rejects(f.call('cancel-reservation', f.operationBody(current)), /TASK_UNCERTAIN_RESERVATION_CANNOT_RELEASE/); assert.equal(a.calls.send, 1);
});
test('trusted exact-bound recovery after revocation preserves full quota and permanent nonce', async () => {
  const a = syntheticAdapter({ failSend: true }), f = fixture(a), g = await f.reserve(await f.grant()), unknown = await f.call('execute', f.operationBody(g));
  const revoked = await f.call('revoke', { taskDigest: g.task.digest, expectedGrantPolicyVersion: '1' }), recovered = await f.call('resume', { taskDigest: revoked.task.digest });
  assert.equal(recovered.effectiveStatus, 'revoked'); assert.equal(recovered.budget.reservations[0].status, 'submitted');
  assert.equal(recovered.budget.reservations[0].feeWei, unknown.budget.reservations[0].feeWei); assert.equal(a.calls.send, 1);
  await assert.rejects(f.call('cancel-reservation', f.operationBody(recovered)), /TASK_UNCERTAIN_RESERVATION_CANNOT_RELEASE/);
});
test('revocation, factor rotation and expiry during verifier await win before send', async () => {
  for (const change of ['revoke', 'factor', 'expiry']) {
    let f: any, g: any; const a = syntheticAdapter({ onVerify: async () => {
      if (change === 'revoke') await f.call('revoke', { taskDigest: g.task.digest, expectedGrantPolicyVersion: '1' });
      if (change === 'factor') await f.store.transaction('xiongan:tester', (c: any) => ({ ...c, revision: 2 }));
      if (change === 'expiry') f.state.now += 601000;
    } }); f = fixture(a); g = await f.reserve(await f.grant()); await assert.rejects(f.call('execute', f.operationBody(g))); assert.equal(a.calls.send, 0, change);
  }
});
test('trusted adapter must return the exact operation binding', async () => {
  const a = syntheticAdapter(); a.execution.verify = async (input: any) => ({ ...binding(input), nonce: '999' });
  const f = fixture(a), g = await f.reserve(await f.grant()); await assert.rejects(f.call('execute', f.operationBody(g)), /TASK_EXECUTION_VERIFICATION_REFUSED/); assert.equal(a.calls.send, 0);
});
test('failed durable approval preserves OTP and pending grant; uncertain store fails closed', async () => {
  class FailingStore extends MemoryCredentialStore { fail = false; snapshots: any[] = []; constructor(data: any) { super(data); }
    async persist(value: any) { if (this.fail) throw Error('Synthetic disk failure'); this.snapshots.push(structuredClone(value)); } }
  const store = new FailingStore({ 'xiongan:tester': { secret, lastStep: -1, revision: 1 } }), f = fixture({ store }), p = await f.prepare(); store.fail = true;
  await assert.rejects(f.authorize(p), /Synthetic disk failure/); await assert.rejects(f.call('status', { taskDigest: p.task.digest }), /AUTH_STORE_UNHEALTHY/);
  const durable = store.snapshots.at(-1); assert.equal(durable['xiongan:tester'].lastStep, -1);
  const restarted = fixture({ store: new MemoryCredentialStore(durable) }); assert.equal((await restarted.call('status', { taskDigest: p.task.digest })).effectiveStatus, 'pending');
  assert.equal((await restarted.authorize(await restarted.prepare())).effectiveStatus, 'authorized');
});
test('capacity refusal is explicit and does not consume an OTP or evict the journal', async () => {
  class CapacityStore extends MemoryCredentialStore { full = false; constructor(data: any) { super(data); }
    async transactionMany(keys: any, update: any) { if (!this.full) return super.transactionMany(keys, update);
      return super.transactionMany(keys, async (values: any) => { await update(values); throw Error('AUTH_STORE_CAPACITY'); }); } }
  const store = new CapacityStore({ 'xiongan:tester': { secret, lastStep: -1, revision: 1 } }), f = fixture({ store }), p = await f.prepare(); store.full = true;
  await assert.rejects(f.authorize(p), (e: any) => e.message === 'TASK_STORE_CAPACITY' && e.status === 507); assert.equal((await store.read('xiongan:tester')).lastStep, -1);
});
test('queued approval rechecks logout at the serialized boundary', async () => {
  const f = fixture(), p = await f.prepare(); let release!: () => void;
  const held = f.store.transaction('other:key', async () => { await new Promise<void>(resolve => { release = resolve; }); return {}; });
  await new Promise(resolve => setImmediate(resolve)); const approval = f.authorize(p); f.sessions.delete(f.session); release(); await held;
  await assert.rejects(approval, /AUTH_REFUSED/); assert.equal((await f.store.read('xiongan:tester')).lastStep, -1);
});
test('encrypted restart preserves prior credentials, OTP use, grant, unknown outcome and nonce', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wallet-task-synthetic-')); let cleanupStore: any; t.after(async () => { await cleanupStore?.close(); await rm(directory, { recursive: true, force: true }); });
  const path = join(directory, 'credentials.enc'), encryptionKey = Buffer.alloc(32, 0x42), store = await openEncryptedStore(path, encryptionKey);
  await store.transaction('xiongan:tester', () => ({ secret, lastStep: -1, revision: 1, sentinel: 'old-user' }));
  const before = await readFile(path), a = syntheticAdapter({ failSend: true }), f = fixture({ store, ...a }), g = await f.reserve(await f.grant());
  await f.call('execute', f.operationBody(g)); await store.close(); const ciphertext = await readFile(path, 'utf8'); assert.ok(!ciphertext.includes(secret)); assert.ok(!ciphertext.includes(g.task.digest));
  const restartStore = await openEncryptedStore(path, encryptionKey); cleanupStore = restartStore; const restarted = fixture({ store: restartStore, ...a });
  const persisted = await restarted.call('status', { taskDigest: g.task.digest }); assert.equal(persisted.budget.reservations[0].status, 'outcome-unknown');
  assert.equal((await restartStore.read('xiongan:tester')).sentinel, 'old-user'); await assert.rejects(restarted.call('execute', restarted.operationBody(persisted)), /TASK_SEND_ATTEMPT_REFUSED/);
  assert.notDeepEqual(await readFile(path), before); assert.equal(a.calls.send, 1);
});
test('pending list uses fixed-revision pages without silently dropping tasks', async () => {
  const f = fixture(); for (let i = 0; i < 51; i++) await f.prepare(policy({ taskId: `task:${i}` }));
  const first = await f.call('list', {}); assert.equal(first.tasks.length, 50); assert.equal(first.nextCursor, '50');
  assert.equal((await f.call('list', { cursor: first.nextCursor, revision: first.revision })).tasks.length, 1);
  await f.prepare(policy({ taskId: 'task:extra' })); await assert.rejects(f.call('list', { cursor: first.nextCursor, revision: first.revision }), /TASK_LIST_REVISION_CONFLICT/);
});
test('HTTP tasks preserve origin, tenant, CSRF and session binding without disclosing credentials', async t => {
  const password = 'synthetic-task-password', passwordHash = await hashPassword(password), store = new MemoryCredentialStore({ 'xiongan:tester': { secret, lastStep: -1, revision: 1 } });
  let handler: any; const server = createServer((req, res) => handler(req, res)); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve()))); const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  handler = createAuthService({ origin, tenant: 'xiongan', store, now: () => epoch, accounts: [{ username: 'tester', passwordHash, wallets: [{ account: actor, chainId: '11155111' }] }] });
  let csrf = ''; const jar = new Map<string, string>();
  async function call(path: string, body?: any, extra: any = {}) {
    const response = await fetch(`${origin}/auth/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: origin, 'X-Wallet-Tenant': 'xiongan', 'X-Wallet-CSRF': csrf,
      Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    for (const cookie of response.headers.getSetCookie()) { const [k, v] = cookie.split(';')[0]!.split('='); if (v) jar.set(k!, v); else jar.delete(k!); }
    const data = await response.json() as any; if (data.csrf) csrf = data.csrf; return { status: response.status, data, headers: response.headers };
  }
  assert.equal((await call('tasks/list', {})).status, 401); await call('bootstrap');
  assert.equal((await call('password', { username: 'tester', password, account: actor, chainId: '11155111' })).status, 200);
  for (const headers of [{ Origin: 'https://evil.invalid' }, { 'X-Wallet-Tenant': 'other' }, { 'X-Wallet-CSRF': 'forged' }]) assert.ok((await call('tasks/list', {}, headers)).status >= 400);
  const prepared = await call('tasks/prepare', { policy: policy({ origin }) }); assert.equal(prepared.status, 200);
  const g = await call('tasks/authorize', { challengeId: prepared.data.challengeId, taskDigest: prepared.data.task.digest, executorDigest: prepared.data.executor.digest, observationPolicyDigest: prepared.data.observationPolicy?.digest ?? null, code: hotp(secret, epoch / 30000) });
  assert.equal(g.status, 200); assert.equal(g.data.effectiveStatus, 'authorized'); const output = JSON.stringify(g.data); assert.ok(!output.includes(secret)); assert.ok(!output.includes(passwordHash)); assert.ok(!output.includes('lastStep'));
  let throttled: any;
  for (let i = 0; i < 121; i++) { const response = await call('tasks/status', { taskDigest: prepared.data.task.digest });
    if (response.status === 429) { throttled = response; break; } assert.equal(response.status, 200); }
  assert.equal(throttled?.data.error, 'AUTH_RATE_LIMITED'); assert.equal(throttled.data.retryAfterSeconds, 900);
  assert.equal(throttled.headers.get('retry-after'), '900'); assert.deepEqual(Object.keys(throttled.data).sort(), ['error', 'retryAfterSeconds']);
  await call('logout', {}); assert.equal((await call('tasks/status', { taskDigest: prepared.data.task.digest })).status, 401);
});

test('one resume plans one immutable candidate and later calls neither replan nor resend submitted work', async () => {
  const a = syntheticAdapter(); let plans = 0;
  const execution = { ...a.execution, async plan(input: any) { plans++; assert.ok(Object.isFrozen(input.task.policy)); return child(input.task); } };
  const f = fixture({ execution }), g = await f.grant();
  const first = await f.call('resume', { taskDigest: g.task.digest }); assert.equal(first.continuation.state, 'submitted'); assert.equal(plans, 1); assert.equal(a.calls.send, 1);
  const second = await f.call('resume', { taskDigest: g.task.digest }); assert.equal(second.continuation.state, 'awaiting-evidence'); assert.equal(plans, 1); assert.equal(a.calls.send, 1);
});
test('resume prioritizes unknown recovery without retrying the planner or signer', async () => {
  const a = syntheticAdapter({ failSend: true }); let plans = 0;
  const f = fixture({ execution: { ...a.execution, async plan(input: any) { plans++; return child(input.task); } } }), g = await f.grant();
  assert.equal((await f.call('resume', { taskDigest: g.task.digest })).continuation.state, 'outcome-unknown');
  assert.equal((await f.call('resume', { taskDigest: g.task.digest })).continuation.state, 'submitted');
  assert.equal(plans, 1); assert.equal(a.calls.send, 1); assert.equal(a.calls.recover, 1);
});
test('budget CAS and nonce claim races during verification prevent signing', async () => {
  for (const change of ['budget', 'nonce']) {
    let f: any, g: any;
    const a = syntheticAdapter({ onVerify: async () => {
      if (change === 'budget') await f.call('cancel-reservation', f.operationBody(g));
      else {
        const keys = f.store.observedKeys.filter((k: string) => k.startsWith('task-nonce:'));
        await f.store.transaction(keys.at(-1), (v: any) => ({ ...v, childDigest: `0x${'b'.repeat(64)}` }));
      }
    } });
    class ObservedStore extends MemoryCredentialStore {
      observedKeys: string[] = []; constructor(data: any) { super(data); }
      async transactionMany(keys: string[], update: any) { this.observedKeys.push(...keys); return super.transactionMany(keys, update); }
    }
    f = fixture({ ...a, store: new ObservedStore({ 'xiongan:tester': { secret, lastStep: -1, revision: 1 } }) }); g = await f.reserve(await f.grant());
    await assert.rejects(f.call('execute', f.operationBody(g))); assert.equal(a.calls.send, 0, change);
  }
});
test('cancelled history beyond 128 preserves every tombstone without limiting a new authorized candidate', async () => {
  const f = fixture(); let g = await f.grant();
  for (let i = 0; i < 130; i++) { const c = child(g.task, `operation:${i}`); g = await f.reserve(g, c); g = await f.call('cancel-reservation', f.operationBody(g, c)); }
  assert.equal(g.budget.reservations.length, 130); const next = await f.reserve(g, child(g.task, 'operation:next'));
  assert.equal(next.budget.reservations.length, 131); await assert.rejects(f.reserve(next, child(g.task, 'operation:0', '999')), /TASK_DUPLICATE_OPERATION_REFUSED/);
});

test('real 4 MiB store capacity refuses approval atomically without trimming any persisted proposal', async () => {
  class CapturedStore extends MemoryCredentialStore { snapshot: any; constructor(data: any) { super(data); }
    async persist(data: any) { this.snapshot = structuredClone(data); } }
  const store = new CapturedStore({ 'xiongan:tester': { secret, lastStep: -1, revision: 1 } }), f = fixture({ store }), p = await f.prepare();
  const overhead = Buffer.byteLength(JSON.stringify({ version: 1, iv: 'A'.repeat(16), tag: 'A'.repeat(24), data: '' }));
  const limit = 3 * Math.floor((4 * 1024 * 1024 - overhead) / 4);
  const free = limit - Buffer.byteLength(JSON.stringify(store.snapshot));
  await store.transaction('padding', () => 'x'.repeat(free - 30));
  const before = structuredClone(store.snapshot);
  await assert.rejects(f.authorize(p), (e: any) => e.message === 'TASK_STORE_CAPACITY' && e.status === 507);
  assert.deepEqual(store.snapshot, before); assert.equal((await store.read('xiongan:tester')).lastStep, -1);
  assert.equal((await f.call('status', { taskDigest: p.task.digest })).effectiveStatus, 'pending');
});
test('market quote claims can reserve scope but cannot bypass trusted encoding, price and atomic-settlement adapters', async () => {
  const f = fixture(), p: any = policy();
  p.intent = { kind: 'nft-sale', direction: 'sell', standard: 'ERC-721', contract: `0x${'3'.repeat(40)}`, tokenId: '9', quantity: '1',
    minimumProceeds: { currency: 'USD', amountMinor: '1000', minorUnit: 2, comparison: 'gte', basis: 'net' }, marketAdapters: ['market:reviewed'] };
  const g = await f.grant(p), c: any = child(g.task);
  c.operation = { kind: 'erc721-transfer', chainId: '11155111', actor, contract: p.intent.contract, recipient, tokenId: '9' };
  c.wire = { to: p.intent.contract, calldataHash: `0x${'4'.repeat(64)}`, valueWei: '0' };
  c.market = { adapterId: 'market:reviewed', quoteId: 'quote:claimed', buyer: recipient, proceedsMinor: '50000', currency: 'USD', minorUnit: 2,
    basis: 'net', expiresAt: c.expiresAt, priceEvidenceRef: 'price:claimed', settlementEvidenceRef: 'settlement:claimed' };
  const reserved = await f.reserve(g, c); assert.ok(reserved.capabilities.missing.includes('MARKET_PRICE_VERIFIER_NOT_CONNECTED'));
  await assert.rejects(f.call('execute', f.operationBody(reserved, c)), /TASK_EXECUTION_ADAPTER_NOT_CONNECTED/);
  assert.equal((await f.call('status', { taskDigest: g.task.digest })).budget.reservations[0].status, 'reserved');
});

test('executor identity canonical digest is stable and approval jointly binds it with the parent digest', async () => {
  const ref = freezeTaskExecutorIdentity(executorIdentity);
  assert.equal(ref.digest, '0x71dbe852d9c0f53960e3afdc5bb3a761187b388e72c10c8ed6d86a19afe63091'); assert.ok(Object.isFrozen(ref.identity));
  const reordered = { implementationDigest: executorIdentity.implementationDigest, adapterVersion: '1', adapterId: 'synthetic:adapter', agentVersion: '1', agentId: 'synthetic:agent', schema: '8415-task-executor/1' };
  assert.equal(freezeTaskExecutorIdentity(reordered).digest, ref.digest);
  const f = fixture(), p = await f.prepare();
  await assert.rejects(f.call('authorize', { challengeId: p.challengeId, taskDigest: p.task.digest, code: f.code() }), /TASK_REQUEST_REFUSED/);
  await assert.rejects(f.call('authorize', { challengeId: p.challengeId, taskDigest: p.task.digest, executorDigest: ref.digest, observationPolicyDigest: p.observationPolicy?.digest ?? null, code: f.code() }), /TASK_APPROVAL_CHALLENGE_REFUSED/);
  const granted = await f.authorize(p); assert.equal(granted.executor.digest, p.executor.digest);
  assert.equal(granted.executor.identity.adapterId, 'unconfigured-signer');
});
test('installing an adapter cannot inherit grants approved with no signer and identity changes pause prior grants', async () => {
  const f = fixture(), g = await f.grant(), a = syntheticAdapter();
  const configured = fixture({ store: f.store, ...a });
  const resumed = await configured.call('resume', { taskDigest: g.task.digest });
  assert.equal(resumed.effectiveStatus, 'suspended'); assert.equal(resumed.executor.digest, g.executor.digest);
  assert.equal(resumed.continuation.code, 'TASK_EXECUTOR_REVALIDATION_REQUIRED'); assert.equal(a.calls.send, 0);
  const a2 = syntheticAdapter(), first = fixture(a2), original = await first.grant();
  const changed = fixture({ store: first.store, ...syntheticAdapter(), executorIdentity: { ...executorIdentity, implementationDigest: `0x${'8'.repeat(64)}` } });
  const status = await changed.call('status', { taskDigest: original.task.digest });
  assert.equal(status.effectiveStatus, 'suspended'); assert.equal(status.authorization.grantPolicyVersion, '1'); assert.equal(status.executor.digest, original.executor.digest);
  await assert.rejects(changed.reserve(status), /TASK_EXECUTOR_REVALIDATION_REQUIRED/);
});
test('adapter methods are captured and an unknown operation can only recover under its recorded executor identity', async () => {
  const a = syntheticAdapter({ failSend: true }), f = fixture(a), g = await f.reserve(await f.grant());
  (a.execution as any).send = async () => { assert.fail('Mutated method must not be used'); };
  const unknown = await f.call('execute', f.operationBody(g)); assert.equal(unknown.outcome, 'outcome-unknown'); assert.equal(a.calls.send, 1);
  const changed = fixture({ store: f.store, ...syntheticAdapter(), executorIdentity: { ...executorIdentity, agentVersion: '2' } });
  await assert.rejects(changed.call('resume', { taskDigest: g.task.digest }), /TASK_RECOVERY_EXECUTOR_BINDING_REQUIRED/);
  assert.equal((await f.call('resume', { taskDigest: g.task.digest })).continuation.state, 'submitted');
});
test('configured adapter presence never advertises verified child executability', async () => {
  const f = fixture(syntheticAdapter()), g = await f.grant();
  assert.equal(g.capabilities.adapterConfigured, true); assert.equal(g.capabilities.executable, false);
  assert.ok(g.capabilities.missing.includes('TASK_CHILD_VERIFICATION_REQUIRED'));
});

function syntheticReceipt(options: any = {}) {
  const identity = { verifierId: 'synthetic:receipt', verifierVersion: '1', verifierImplementationDigest: `0x${'7'.repeat(64)}` };
  const observationPolicy = freezeTaskObservationPolicy({ minimumConfirmations: '2' });
  const calls = { observe: 0 };
  const receipt = { identity, observationPolicy, async assessChild(input: any) { await options.onAssess?.();
    return { taskDigest: input.task.digest, childDigest: input.child.digest, executorDigest: input.executor.digest,
      observationPolicyDigest: freezeTaskObservationPolicy(input.observationPolicy).digest, ...identity, capability: 'exact-operation-observable', ...options.mutateAssessment?.(input) };
  }, async observe(input: any) {
    calls.observe++; assert.ok(Object.isFrozen(input.child.child)); await options.onObserve?.();
    const state = options.state?.() ?? 'confirmed-at-depth';
    return { schema: '8415-task-observation/1', taskDigest: input.task.digest, childDigest: input.child.digest,
      chainId: input.child.child.operation.chainId, actor: input.child.child.operation.actor, nonce: input.child.child.nonce,
      attemptExecutorDigest: input.attempt.executorDigest, attemptGrantPolicyVersion: input.attempt.grantPolicyVersion,
      originalTransactionHash: input.attempt.transactionHash, observationPolicy: input.observationPolicy,
      observationPolicyDigest: freezeTaskObservationPolicy(input.observationPolicy).digest, state,
      blockNumber: state === 'pending' ? null : '42', blockHash: state === 'pending' ? null : `0x${'6'.repeat(64)}`,
      confirmations: ['pending', 'reorged'].includes(state) ? '0' : state === 'confirming' ? '1' : '2',
      replacementHash: state === 'superseded-at-depth' ? `0x${'5'.repeat(64)}` : null,
      observedAt: String(Math.floor((options.now?.() ?? epoch) / 1000)),
      effect: state === 'confirmed-at-depth' ? 'exact-operation-observed' : 'not-established',
      protocolFinality: 'not-evaluated', economicFinality: 'not-evaluated', ...identity, ...options.mutate?.(input) };
  } };
  return { receipt, receiptCalls: calls };
}
test('observation policy is explicit and bound to the same approval without consuming a mismatched OTP', async () => {
  const f = fixture(syntheticAdapter()), p = await f.prepare();
  assert.equal(p.observationPolicy.digest, '0xe834daeddaea8e8bc8d1aad561998012fd6f5a1b5a0803492441c0a9061c6beb');
  await assert.rejects(f.call('authorize', { challengeId: p.challengeId, taskDigest: p.task.digest, executorDigest: p.executor.digest,
    observationPolicyDigest: freezeTaskObservationPolicy({ minimumConfirmations: '3' }).digest, code: f.code() }), /TASK_APPROVAL_CHALLENGE_REFUSED/);
  assert.equal((await f.store.read('xiongan:tester')).lastStep, -1);
  const g = await f.authorize(p), replacement = syntheticReceipt(); replacement.receipt.observationPolicy = freezeTaskObservationPolicy({ minimumConfirmations: '3' });
  const changed = fixture({ store: f.store, ...syntheticAdapter(), ...replacement, observationPolicy: { minimumConfirmations: '3' } });
  assert.equal((await changed.call('status', { taskDigest: g.task.digest })).effectiveStatus, 'suspended');
  await assert.rejects(changed.reserve(g), /TASK_OBSERVATION_POLICY_REVALIDATION_REQUIRED/);
});
test('trusted observations track confirmation and reorgs without releasing budget or claiming economic finality', async () => {
  let state = 'pending'; const a = syntheticAdapter(), r = syntheticReceipt({ state: () => state }), f = fixture({ ...a, ...r });
  const g = await f.reserve(await f.grant()), submitted = await f.call('execute', f.operationBody(g));
  for (const next of ['pending', 'confirming', 'confirmed-at-depth', 'reorged', 'reverted-at-depth']) {
    state = next; const progress = await f.call('observe', f.operationBody(submitted));
    assert.equal(progress.observation.state, next); assert.deepEqual(progress.budget, submitted.budget);
    assert.equal(progress.observation.protocolFinality, 'not-evaluated'); assert.equal(progress.observation.economicFinality, 'not-evaluated');
    assert.equal(progress.completion.state, next === 'confirmed-at-depth' ? 'completed-at-observation-depth' : next === 'reverted-at-depth' ? 'failed-at-observation-depth' : 'awaiting-evidence');
    assert.equal(progress.completion.fresh, true);
    assert.equal((await f.call('status', { taskDigest: g.task.digest })).completion.fresh, false);
  }
  assert.equal(a.calls.send, 1); assert.equal(r.receiptCalls.observe, 5);
  await assert.rejects(f.call('cancel-reservation', f.operationBody(submitted)), /TASK_UNCERTAIN_RESERVATION_CANNOT_RELEASE/);
});
test('observation rejects caller results, mismatched tuple, verifier identity and future evidence', async () => {
  for (const mutation of [() => ({ nonce: '999' }), () => ({ verifierVersion: '2' }), () => ({ observedAt: String(epoch / 1000 + 1) })]) {
    const a = syntheticAdapter(), r = syntheticReceipt({ mutate: mutation }), f = fixture({ ...a, ...r });
    const g = await f.reserve(await f.grant()), submitted = await f.call('execute', f.operationBody(g));
    await assert.rejects(f.call('observe', { ...f.operationBody(submitted), approved: true }), /TASK_REQUEST_REFUSED/);
    await assert.rejects(f.call('observe', f.operationBody(submitted)));
    const status = await f.call('status', { taskDigest: g.task.digest }); assert.equal(status.observationRevision, '1'); assert.equal(status.observations[0].available, false); assert.deepEqual(status.budget, submitted.budget);
  }
});
test('read-only observation works after revocation and factor revalidation using recorded attempt version', async () => {
  const a = syntheticAdapter(), r = syntheticReceipt(), f = fixture({ ...a, ...r }), g = await f.reserve(await f.grant());
  const submitted = await f.call('execute', f.operationBody(g));
  await f.call('revoke', { taskDigest: g.task.digest, expectedGrantPolicyVersion: '1' });
  await f.store.transaction('xiongan:tester', (c: any) => ({ ...c, revision: 2 })); f.session.revision = 2;
  const progress = await f.call('resume', { taskDigest: g.task.digest });
  assert.equal(progress.effectiveStatus, 'revoked'); assert.equal(progress.observation.attemptGrantPolicyVersion, '1');
  assert.equal(progress.authorization.grantPolicyVersion, '2'); assert.deepEqual(progress.budget, submitted.budget); assert.equal(a.calls.send, 1);
});
test('receipt identity changes cannot reinterpret prior grants or attempts', async () => {
  const a = syntheticAdapter(), r = syntheticReceipt(), f = fixture({ ...a, ...r }), g = await f.reserve(await f.grant());
  await f.call('execute', f.operationBody(g));
  const replacement = syntheticReceipt(); replacement.receipt.identity.verifierVersion = '2';
  const changed = fixture({ store: f.store, ...syntheticAdapter(), ...replacement });
  assert.equal((await changed.call('status', { taskDigest: g.task.digest })).effectiveStatus, 'suspended');
  await assert.rejects(changed.call('resume', { taskDigest: g.task.digest }), /TASK_RECEIPT_EXECUTOR_BINDING_REQUIRED/);
  assert.equal(replacement.receiptCalls.observe, 0);
});
test('concurrent observations use a separate CAS and never modify the spending ledger', async () => {
  let arrivals = 0, release!: () => void; const both = new Promise<void>(resolve => { release = resolve; });
  const a = syntheticAdapter(), r = syntheticReceipt({ onObserve: async () => { if (++arrivals === 2) release(); await both; } });
  const f = fixture({ ...a, ...r }), g = await f.reserve(await f.grant()), submitted = await f.call('execute', f.operationBody(g));
  const results = await Promise.allSettled([f.call('observe', f.operationBody(submitted)), f.call('observe', f.operationBody(submitted))]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const status = await f.call('status', { taskDigest: g.task.digest }); assert.equal(status.observationRevision, '1'); assert.deepEqual(status.budget, submitted.budget);
});
test('missing bound receipt verifier blocks before planning, verification or any send', async () => {
  const a = syntheticAdapter(), f = fixture({ ...a, receipt: null }), g = await f.reserve(await f.grant());
  await assert.rejects(f.call('execute', f.operationBody(g)), /TASK_RECEIPT_VERIFIER_NOT_CONNECTED/);
  const result = await f.call('resume', { taskDigest: g.task.digest }); assert.equal(result.continuation.code, 'TASK_RECEIPT_VERIFIER_NOT_CONNECTED');
  assert.equal(a.calls.verify, 0); assert.equal(a.calls.send, 0); assert.equal(result.budget.reservations[0].status, 'reserved');
});

test('known-hash replacement evidence is read-only and reorgs or failures invalidate cached terminal status', async () => {
  let state = 'superseded-at-depth', fail = false;
  const a = syntheticAdapter(), r = syntheticReceipt({ state: () => state }), replacementHash = `0x${'5'.repeat(64)}`;
  (r.receipt as any).observeReplacement = async (input: any, value: string) => {
    assert.equal(value, replacementHash); if (fail) throw Error('Synthetic RPC failure'); return r.receipt.observe(input);
  };
  const f = fixture({ ...a, ...r }), g = await f.reserve(await f.grant()), submitted = await f.call('execute', f.operationBody(g));
  const replaced = await f.call('observe-replacement', { ...f.operationBody(submitted), replacementHash });
  assert.equal(replaced.completion.state, 'failed-at-observation-depth'); assert.deepEqual(replaced.budget, submitted.budget);
  fail = true; await assert.rejects(f.call('observe', f.operationBody(submitted)), /TASK_OBSERVATION_UNAVAILABLE/);
  const unavailable = await f.call('status', { taskDigest: g.task.digest });
  assert.equal(unavailable.completion.state, 'awaiting-evidence'); assert.equal(unavailable.observations[0].available, false);
  assert.equal(unavailable.observations[0].observation.state, 'superseded-at-depth');
  fail = false; state = 'reorged'; const reorged = await f.call('resume', { taskDigest: g.task.digest });
  assert.equal(reorged.observation.state, 'reorged'); assert.equal(reorged.completion.state, 'awaiting-evidence'); assert.deepEqual(reorged.budget, submitted.budget);
  assert.equal(a.calls.send, 1);
});

test('service composes the real read-only receipt adapter with bounded synthetic chain responses', async () => {
  const blockHash = `0x${'b'.repeat(64)}`, requests: string[] = []; let canonical = blockHash;
  const provider = { async request({ method }: any) {
    requests.push(method);
    if (method === 'eth_chainId') return '0xaa36a7';
    if (method === 'eth_getCode') return '0x';
    if (method === 'eth_getBlockByNumber') return { number: '0x64', hash: canonical };
    if (method === 'eth_blockNumber') return '0x65';
    if (method === 'eth_getTransactionReceipt') return { transactionHash: txHash, from: actor, to: recipient,
      blockHash, blockNumber: '0x64', transactionIndex: '0x0', status: '0x1', logs: [] };
    if (method === 'eth_getTransactionByHash') return { hash: txHash, from: actor, to: recipient, value: '0xa', input: '0x', nonce: '0x7',
      chainId: '0xaa36a7', blockHash, blockNumber: '0x64', transactionIndex: '0x0', gas: '0x5208', maxFeePerGas: '0x2' };
    throw Error('Unexpected synthetic read-only method');
  } };
  const receipt = createTaskReceiptAdapter({ provider, observationPolicy: { minimumConfirmations: '2' }, now: () => epoch });
  const a = syntheticAdapter(), f = fixture({ ...a, receipt }), g = await f.reserve(await f.grant()), submitted = await f.call('execute', f.operationBody(g));
  const observed = await f.call('resume', { taskDigest: g.task.digest });
  assert.equal(observed.completion.state, 'completed-at-observation-depth'); assert.equal(observed.observation.verifierImplementationDigest, receipt.identity.verifierImplementationDigest);
  canonical = `0x${'c'.repeat(64)}`; const reorged = await f.call('observe', f.operationBody(submitted));
  assert.equal(reorged.observation.state, 'reorged'); assert.deepEqual(reorged.budget, submitted.budget);
  assert.ok(requests.length < 40); assert.ok(requests.every(method => !/send|sign|accounts/i.test(method))); assert.equal(a.calls.send, 1);
});

test('one-whole-operation scope keeps spent quota and terminal resume never replans or polls', async () => {
  let plans = 0; const a = syntheticAdapter(), r = syntheticReceipt();
  const execution = { ...a.execution, async plan(input: any) { plans++; return child(input.task); } };
  const f = fixture({ execution, ...r }), g = await f.grant(), submitted = await f.call('resume', { taskDigest: g.task.digest });
  const completed = await f.call('resume', { taskDigest: g.task.digest });
  assert.equal(completed.completion.state, 'completed-at-observation-depth');
  const cached = await f.call('resume', { taskDigest: g.task.digest });
  assert.equal(cached.continuation.state, 'completed-at-observation-depth'); assert.equal(cached.completion.fresh, false);
  assert.equal(plans, 1); assert.equal(a.calls.send, 1); assert.equal(r.receiptCalls.observe, 1); assert.deepEqual(cached.budget, submitted.budget);
  await assert.rejects(f.reserve(cached, child(g.task, 'operation:next', '8')), /TASK_TOTAL_ASSET_LIMIT/);
  await f.call('observe', f.operationBody(cached)); assert.equal(r.receiptCalls.observe, 2);
});

test('receipt child capability is exact-bound and gates execution verification and the send boundary', async () => {
  for (const mutation of [() => ({ childDigest: `0x${'f'.repeat(64)}` }), () => ({ verifierVersion: '2' }), () => ({ capability: 'supported' })]) {
    const a = syntheticAdapter(), r = syntheticReceipt({ mutateAssessment: mutation }), f = fixture({ ...a, ...r });
    const g = await f.reserve(await f.grant()); await assert.rejects(f.call('execute', f.operationBody(g)), /TASK_RECEIPT_CAPABILITY_REFUSED/);
    assert.equal(a.calls.verify, 0); assert.equal(a.calls.send, 0);
    assert.equal((await f.call('status', { taskDigest: g.task.digest })).budget.reservations[0].status, 'reserved');
  }
});

test('default receipt capability rejects contract-coded native participants before execution verification or send', async () => {
  for (const contractAccount of [actor, recipient]) {
    const blockHash = `0x${'b'.repeat(64)}`;
    const provider = { async request({ method, params }: any) {
      if (method === 'eth_chainId') return '0xaa36a7';
      if (method === 'eth_getBlockByNumber') return { number: '0x64', hash: blockHash };
      if (method === 'eth_getCode') return params[0] === contractAccount ? '0x6000' : '0x';
      throw Error('Unexpected pre-send fixture read');
    } };
    const receipt = createTaskReceiptAdapter({ provider, observationPolicy: { minimumConfirmations: '2' }, now: () => epoch });
    const a = syntheticAdapter(), f = fixture({ ...a, receipt }), g = await f.reserve(await f.grant());
    await assert.rejects(f.call('execute', f.operationBody(g)), /TASK_RECEIPT_NATIVE_EOA_REQUIRED/);
    assert.equal(a.calls.verify, 0); assert.equal(a.calls.send, 0); assert.equal((await f.call('status', { taskDigest: g.task.digest })).budget.reservations[0].status, 'reserved');
  }
});
