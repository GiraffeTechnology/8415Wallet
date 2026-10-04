import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Eip1193Provider } from '../src/adapters/signing/eip1193Signer.ts';
import { encodeCall, encodeWords } from '../src/codec/abi.ts';
import { ControlAdapterError, controlRpc, hashControlBytes, isControlProviderRejection, signForwardConsent,
  type ForwardConsent } from '../src/controls/authorization.ts';
import { FilePublicOperationStore } from '../src/controls/fileOperationStore.ts';
import { parseOperation, serializeOperation, type OperationState, type PublicOperationStore } from '../src/controls/operationJournal.ts';
import { ResponsibilityWalletSession, type WalletOperation } from '../src/controls/session.ts';
import { recoveryGuidance } from '../src/xiongan/recoveryView.ts';

const a = (n: string) => `0x${n.repeat(40)}`, h = (n: string) => `0x${n.repeat(64)}`;
const actor = a('2'), account = a('3'), token = a('4'), payment = a('5');
const pin = { chainId: 1n, controller: a('1'), runtimeCodeHash: hashControlBytes('0x6000') };
const paymentPin = { ...pin, controller: payment };
const rejection = () => Object.assign(new Error('private wallet details must not escape'), { code: 4001, data: 'private data' });
const create: WalletOperation = { kind: 'control', action: { kind: 'create-account' } };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
class MemoryStore implements PublicOperationStore {
  state: OperationState | null = null;
  async read() { return this.state === null ? null : parseOperation(serializeOperation(this.state)); }
  async compareAndSwap(expected: bigint | null, next: OperationState) {
    if ((this.state?.revision ?? null) !== expected) return false;
    this.state = parseOperation(serializeOperation(next)); return true;
  }
}
function fixture(store: PublicOperationStore = new MemoryStore()) {
  let sends = 0, response: () => Promise<unknown> = async () => { throw rejection(); };
  const provider: Eip1193Provider = { async request({ method, params = [] }) {
    if (method === 'eth_chainId') return '0x1';
    if (method === 'eth_getCode') return '0x6000';
    if (method === 'eth_accounts') return [actor];
    if (method === 'eth_getTransactionCount') return '0x0';
    if (method === 'eth_call') {
      const { data } = params[0] as { data: string };
      const calls: Record<string, string> = {
        [encodeCall('accountOf(address)', ['address'], [actor])]: encodeWords(['address'], [account]),
        [encodeCall('registeredAccount(address)', ['address'], [account])]: encodeWords(['bool'], [true]),
        [encodeCall('owner()', [], [])]: encodeWords(['address'], [actor]),
        [encodeCall('controller()', [], [])]: encodeWords(['address'], [pin.controller]),
        [encodeCall('ownerOf(uint256)', ['uint256'], [7n])]: encodeWords(['address'], [actor]),
        [encodeCall('supportsInterface(bytes4)', ['bytes4'], ['0x01ffc9a7'])]: encodeWords(['bool'], [true]),
        [encodeCall('supportsInterface(bytes4)', ['bytes4'], ['0x80ac58cd'])]: encodeWords(['bool'], [true]),
        [encodeCall('supportsInterface(bytes4)', ['bytes4'], ['0xffffffff'])]: encodeWords(['bool'], [false]),
        [encodeCall('nativePayments()', [], [])]: encodeWords(['address'], [payment]),
        [encodeCall('payment(bytes32,bytes32)', ['bytes32', 'bytes32'], [h('6'), h('7')])]:
          encodeWords(['address', 'address', 'uint256', 'uint8'], [a('8'), actor, 100n, 2n]),
      };
      return calls[data] ?? '0x';
    }
    if (method === 'eth_sendTransaction') {
      sends++;
      const state = await store.read();
      assert.equal(state?.status, 'outcome-unknown');
      assert.equal(state?.submission?.transactionHash, h('0'));
      return response();
    }
    throw new Error(`Unexpected fixture method ${method}`);
  } };
  return { store, provider, session: () => new ResponsibilityWalletSession(provider, pin, actor, store, paymentPin),
    sends: () => sends, respond: (next: typeof response) => { response = next; } };
}

for (const method of ['eth_requestAccounts', 'eth_signTypedData_v4', 'eth_sendTransaction']) {
  test(`${method}: numeric 4001 is a sanitized, method-bound user refusal`, async () => {
    for (const raw of [rejection(), { code: 4001 }]) {
      await assert.rejects(controlRpc({ request: async () => { throw raw; } }, method, []), error => {
        assert.ok(error instanceof ControlAdapterError);
        assert.equal(error.code, 'CONTROL_PROVIDER_REQUEST_REJECTED');
        assert.equal(error.message, error.code);
        assert.deepEqual(Object.keys(error).sort(), ['code', 'name']);
        assert.ok(isControlProviderRejection(error, method));
        assert.equal(isControlProviderRejection(error, 'eth_call'), false);
        return true;
      });
    }
  });
}
test('only the provider boundary can issue rejection evidence, never a matching error string', () => {
  for (const error of [null, 'CONTROL_PROVIDER_REQUEST_REJECTED', { code: 'CONTROL_PROVIDER_REQUEST_REJECTED' },
    new ControlAdapterError('CONTROL_PROVIDER_REQUEST_REJECTED'), rejection()]) {
    assert.equal(isControlProviderRejection(error, 'eth_sendTransaction'), false);
  }
});
const ambiguous = [new Error('user rejected with code 4001'), { code: '4001' }, { code: -32000, data: { code: 4001 } },
  { error: { code: 4001 } }, { cause: rejection() }, { code: 4100 }, { code: 4900 }, { code: 4901 },
  Object.defineProperty({}, 'code', { get() { throw new Error('private getter'); } })];
for (const [index, raw] of ambiguous.entries()) test(`ambiguous provider failure ${index} never becomes cancellation evidence`, async () => {
  const f = fixture(); f.respond(async () => { throw raw; });
  await assert.rejects(f.session().execute(create), /CONTROL_PROVIDER_OUTCOME_UNCERTAIN/);
  const state = await f.session().status();
  assert.equal(state.status, 'outcome-unknown');
  await assert.rejects(f.session().execute(create), /CONTROL_RECONCILIATION_REQUIRED/);
  assert.equal(f.sends(), 1);
});
test('4001 on a noninteractive read remains an RPC refusal', async () => {
  await assert.rejects(controlRpc({ request: async () => { throw rejection(); } }, 'eth_call', []), error => {
    assert.ok(error instanceof ControlAdapterError); assert.equal(error.code, 'CONTROL_RPC_REFUSED');
    assert.equal(isControlProviderRejection(error, 'eth_call'), false); return true;
  });
});

for (const operation of [create, { kind: 'deposit', token: { ...pin, controller: token }, tokenId: 7n },
  { kind: 'payout', sequenceId: h('6'), legId: h('7') }] satisfies WalletOperation[]) {
  test(`${operation.kind}: rejected send durably ends its claim; restart needs a new explicit attempt`, async () => {
    const f = fixture(), first = f.session();
    await assert.rejects(first.execute(operation), /CONTROL_PROVIDER_REQUEST_REJECTED/);
    assert.deepEqual(await first.status(), { schema: '8415-operation/1', revision: 3n, status: 'idle',
      deployment: pin, actor, requestDigest: null, submission: null });
    assert.match(recoveryGuidance(await first.status()), /Each new transaction still needs your wallet confirmation/);
    const restarted = f.session(); assert.equal((await restarted.status()).status, 'idle'); assert.equal(f.sends(), 1);
    await assert.rejects(restarted.execute(operation), /CONTROL_PROVIDER_REQUEST_REJECTED/);
    assert.equal(f.sends(), 2); assert.equal((await restarted.status()).revision, 6n);
    f.respond(async () => h('a'));
    const submitted = await restarted.execute(operation);
    assert.equal(submitted.transactionHash, h('a')); assert.equal((await restarted.status()).status, 'submitted');
    await assert.rejects(restarted.execute(operation), /CONTROL_RECONCILIATION_REQUIRED/); assert.equal(f.sends(), 3);
  });
}
for (const failure of ['false', 'throw'] as const) test(`rejection cleanup ${failure} fails closed without replay or raw error text`, async () => {
  const store = new MemoryStore(), f = fixture(store), cas = store.compareAndSwap.bind(store);
  store.compareAndSwap = async (revision, next) => {
    if (revision === 2n && next.status === 'idle') {
      if (failure === 'throw') throw new Error('private storage path');
      return false;
    }
    return cas(revision, next);
  };
  await assert.rejects(f.session().execute(create), error => {
    assert.ok(error instanceof ControlAdapterError); assert.equal(error.code, 'CONTROL_REJECTION_PERSISTENCE_UNCERTAIN'); return true;
  });
  assert.equal((await f.session().status()).status, 'outcome-unknown');
  await assert.rejects(f.session().execute(create), /CONTROL_RECONCILIATION_REQUIRED/); assert.equal(f.sends(), 1);
});
test('a late rejection cannot overwrite a newer durable claim', async () => {
  const store = new MemoryStore(), f = fixture(store), gate = deferred<unknown>(), entered = deferred<void>();
  f.respond(() => { entered.resolve(); return gate.promise; });
  const result = assert.rejects(f.session().execute(create), /CONTROL_REJECTION_PERSISTENCE_UNCERTAIN/);
  await entered.promise;
  const current = (await store.read())!;
  const newer: OperationState = { ...current, revision: current.revision + 1n, status: 'submitted',
    submission: { ...current.submission!, transactionHash: h('a') } };
  assert.equal(await store.compareAndSwap(current.revision, newer), true);
  gate.reject(rejection()); await result;
  assert.deepEqual(await store.read(), newer); assert.equal(f.sends(), 1);
});
test('same-session and second-session attempts stay blocked while the first rejection is pending', async () => {
  const f = fixture(), session = f.session(), gate = deferred<unknown>(), entered = deferred<void>();
  f.respond(() => { entered.resolve(); return gate.promise; });
  const result = assert.rejects(session.execute(create), /CONTROL_PROVIDER_REQUEST_REJECTED/); await entered.promise;
  await assert.rejects(session.execute(create), /CONTROL_OPERATION_BUSY/);
  await assert.rejects(f.session().execute(create), /CONTROL_RECONCILIATION_REQUIRED/);
  gate.reject(rejection()); await result;
  assert.equal((await f.session().status()).status, 'idle'); assert.equal(f.sends(), 1);
});
test('a timeout stays unknown even when 4001 arrives later', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(), gate = deferred<unknown>(), entered = deferred<void>();
  f.respond(() => { entered.resolve(); return gate.promise; });
  const result = assert.rejects(f.session().execute(create), /CONTROL_PROVIDER_OUTCOME_UNCERTAIN/); await entered.promise;
  t.mock.timers.tick(180_000); await result;
  gate.reject(rejection()); await Promise.resolve(); await Promise.resolve();
  assert.equal((await f.session().status()).status, 'outcome-unknown');
  await assert.rejects(f.session().execute(create), /CONTROL_RECONCILIATION_REQUIRED/); assert.equal(f.sends(), 1);
});
test('file journal cancellation survives reload; a competing lock is never stolen', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wallet-rejection-'));
  try {
    const f = fixture(new FilePublicOperationStore(root));
    await assert.rejects(f.session().execute(create), /CONTROL_PROVIDER_REQUEST_REJECTED/);
    assert.equal((await new FilePublicOperationStore(root).read())?.status, 'idle');
    f.respond(async () => { writeFileSync(join(root, 'operation.lock'), ''); throw rejection(); });
    await assert.rejects(f.session().execute(create), /CONTROL_REJECTION_PERSISTENCE_UNCERTAIN/);
    assert.equal((await new FilePublicOperationStore(root).read())?.status, 'outcome-unknown');
    unlinkSync(join(root, 'operation.lock'));
    await assert.rejects(f.session().execute(create), /CONTROL_RECONCILIATION_REQUIRED/); assert.equal(f.sends(), 2);
  } finally { rmSync(root, { recursive: true }); }
});
test('typed consent refusal returns no signature and permits a separately initiated fresh request', async () => {
  const consent: ForwardConsent = { sequenceId: h('1'), expectedRevision: 0n, legId: h('2'), token, tokenId: 7n,
    fromAccount: a('6'), toAccount: account, termsHash: h('3'), inheritedHash: h('4'), returnAuthority: a('7'),
    returnConditionHash: h('5'), evidenceAuthority: a('8'), deadline: 2000n, recipientNonce: 0n,
    paymentAdapter: a('0'), paymentAmount: 0n };
  const f = fixture(); let prompts = 0;
  const provider: Eip1193Provider = { async request(args) {
    if (args.method === 'eth_getBlockByNumber') return { timestamp: '0x3e8' };
    if (args.method === 'eth_call' && (args.params?.[0] as { data: string }).data ===
      encodeCall('recipientNonces(address)', ['address'], [actor])) return encodeWords(['uint256'], [0n]);
    if (args.method === 'eth_signTypedData_v4') { prompts++; throw rejection(); }
    return f.provider.request(args);
  } };
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(signForwardConsent(provider, pin, consent, actor), /CONTROL_PROVIDER_REQUEST_REJECTED/);
    assert.equal(prompts, attempt + 1); assert.equal(f.sends(), 0);
  }
});

test('a resolved error-shaped object is not evidence of a refused send', async () => {
  const f = fixture(); f.respond(async () => ({ code: 4001 }));
  await assert.rejects(f.session().execute(create), /CONTROL_TRANSACTION_HASH_REFUSED/);
  assert.equal((await f.session().status()).status, 'outcome-unknown');
  await assert.rejects(f.session().execute(create), /CONTROL_RECONCILIATION_REQUIRED/); assert.equal(f.sends(), 1);
});
test('control cancellation stays locked until the durable CAS completes', async () => {
  const store = new MemoryStore(), f = fixture(store), cas = store.compareAndSwap.bind(store);
  const gate = deferred<void>(), entered = deferred<void>();
  store.compareAndSwap = async (revision, next) => {
    if (revision === 2n && next.status === 'idle') { entered.resolve(); await gate.promise; }
    return cas(revision, next);
  };
  const session = f.session(), result = assert.rejects(session.execute(create), /CONTROL_PROVIDER_REQUEST_REJECTED/); await entered.promise;
  await assert.rejects(session.execute(create), /CONTROL_OPERATION_BUSY/);
  await assert.rejects(f.session().execute(create), /CONTROL_RECONCILIATION_REQUIRED/);
  gate.resolve(); await result; assert.equal((await f.session().status()).status, 'idle'); assert.equal(f.sends(), 1);
});
