/** Installed-package smoke: synthetic in-memory factors and loopback HTTP only. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
assert.equal(args.length, 2, 'Usage: --runtime PATH'); assert.equal(args[0], '--runtime');
const root = resolve(args[1]);
const load = path => import(pathToFileURL(`${root}/${path}`).href);
const { verifyAuthDirectory, TASK_RUNTIME_SOURCE_PATHS, AUTH_STATE_SEMANTICS } = await load('scripts/package/verify-auth.mjs');
const release = verifyAuthDirectory(root);
assert.equal(release.runtime.authStateSemantics, AUTH_STATE_SEMANTICS);
assert.deepEqual(TASK_RUNTIME_SOURCE_PATHS, ['src/agent/receiptObservation.ts', 'src/agent/taskContract.ts', 'src/codec/abi.ts', 'src/codec/keccak.ts',
  'src/controls/accounts.ts', 'src/controls/authorization.ts', 'src/controls/client.ts', 'src/controls/execution.ts',
  'src/sdk/errors.ts', 'src/sdk/interfaceIds.ts', 'src/xiongan/address.ts', 'src/xiongan/externalAssets.ts']);
const { createTaskReceiptAdapter } = await load('server/task-receipt-adapter.mjs');
assert.equal(typeof createTaskReceiptAdapter, 'function');
await load('server/method-change-service.mjs');
const { createTaskBackgroundRunner } = await load('server/task-background-runner.mjs');
assert.equal(typeof createTaskBackgroundRunner, 'function');
const { freezeTaskPolicy } = await load('src/agent/taskContract.ts');
const { createAuthService } = await load('server/auth-service.mjs');
const { MemoryCredentialStore } = await load('server/store.mjs');
const { base32, hashPassword, hotp } = await load('server/crypto.mjs');

const now = 1_800_000_000_000, actor = `0x${'1'.repeat(40)}`, recipient = `0x${'2'.repeat(40)}`;
const password = 'synthetic-runtime-smoke-password', secret = base32(Buffer.alloc(20, 0x37));
const store = new MemoryCredentialStore({ 'runtime-test:tester': { secret, lastStep: -1, revision: 1 } });
const passwordHash = await hashPassword(password); let handler;
const server = createServer((request, response) => handler(request, response));
server.listen(0, '127.0.0.1'); await once(server, 'listening');
try {
  const origin = `http://127.0.0.1:${server.address().port}`;
  handler = createAuthService({ origin, tenant: 'runtime-test', store, now: () => now,
    accounts: [{ username: 'tester', passwordHash, wallets: [{ account: actor, chainId: '11155111' }] }] });
  let csrf = ''; const cookies = new Map();
  const call = async (path, body) => {
    const response = await fetch(`${origin}/auth/${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { Origin: origin, 'X-Wallet-Tenant': 'runtime-test', 'X-Wallet-CSRF': csrf,
        Cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    for (const cookie of response.headers.getSetCookie()) {
      const [name, value] = cookie.split(';')[0].split('='); if (value) cookies.set(name, value); else cookies.delete(name);
    }
    const data = await response.json(); if (data.csrf) csrf = data.csrf; return { status: response.status, data };
  };
  assert.equal((await call('tasks/list', {})).status, 401);
  assert.equal((await call('bootstrap')).status, 200);
  assert.equal((await call('password', { username: 'tester', password, account: actor, chainId: '11155111' })).status, 200);
  const policy = { schema: '8415-agent-task/1', taskId: 'runtime:synthetic', tenant: 'runtime-test', origin, chainId: '11155111', actor,
    expiresAt: String(now / 1000 + 600), fees: { perOperationWei: '100000', totalWei: '100000' },
    intent: { kind: 'exact-operation', operation: { kind: 'native-transfer', chainId: '11155111', actor, recipient, valueWei: '1' } } };
  const prepared = await call('tasks/prepare', { policy }); assert.equal(prepared.status, 200);
  assert.equal(prepared.data.task.digest, freezeTaskPolicy(policy).digest);
  const granted = await call('tasks/authorize', { challengeId: prepared.data.challengeId, taskDigest: prepared.data.task.digest, executorDigest: prepared.data.executor.digest, observationPolicyDigest: prepared.data.observationPolicy?.digest ?? null, code: hotp(secret, now / 30000) });
  assert.equal(granted.status, 200); assert.equal(granted.data.effectiveStatus, 'authorized');
  assert.equal(granted.data.capabilities.executable, false);
  const continuation = await call('tasks/resume', { taskDigest: prepared.data.task.digest }); assert.equal(continuation.status, 200);
  assert.equal(continuation.data.continuation.code, 'TASK_EXECUTION_ADAPTER_NOT_CONNECTED');
  assert.deepEqual(continuation.data.budget.reservations, []);
  assert.equal(typeof handler.taskBackground.resume, 'function');
  assert.equal((await handler.taskBackground.list({ cursor: '0', limit: 10 })).entries.length, 1);
  assert.equal((await call('tasks/list', {})).data.tasks.length, 1);
  const exposed = JSON.stringify([granted.data, continuation.data]); assert.ok(!exposed.includes(secret)); assert.ok(!exposed.includes(passwordHash));
  assert.equal((await call('logout', {})).status, 200);
  assert.equal((await call('tasks/status', { taskDigest: prepared.data.task.digest })).status, 401);
  const saved = await handler.taskBackground.list({ cursor: '0', limit: 10 });
  const internal = await handler.taskBackground.resume(saved.entries[0]);
  assert.equal(internal.continuation.code, 'TASK_EXECUTION_ADAPTER_NOT_CONNECTED');
  console.log(`Task auth package import and synthetic HTTP smoke passed on ${process.version}. No external signer or transaction used.`);
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await store.close();
}
