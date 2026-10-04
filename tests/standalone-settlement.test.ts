import test from 'node:test';
import assert from 'node:assert/strict';
import { StandaloneSettlementSession, parseSettlementState, serializeSettlementState, type SettlementState } from '../src/wallet/standaloneSettlement.ts';
import { hashControlBytes } from '../src/controls/authorization.ts';
import { WalletSession } from '../src/wallet/session.ts';
import { divergentToken, REGISTRAR, STRANGER, DAVE, TOKEN, T, OPEN_GAP_ID, commitment, settlementId } from '../src/adapters/memory/scenarios.ts';
import type { TransactionIntent } from '../src/sdk/transactions.ts';
import { keccak256Utf8 } from '../src/codec/keccak.ts';
import { encodeWords } from '../src/codec/abi.ts';

// Deterministic SDK/signer/provider boundaries. No real wallet or public-chain acceptance.
const CODE = '0x6000', HASH = commitment('a'), BLOCK = commitment('b');
class Store {
  state: SettlementState | null = null; failRevision: bigint | null = null;
  async read() { return structuredClone(this.state); }
  async compareAndSwap(expected: bigint | null, next: SettlementState) {
    if ((this.state?.revision ?? null) !== expected || next.revision === this.failRevision) return false;
    this.state = parseSettlementState(serializeSettlementState(next)); return true;
  }
}
function fixture() {
  const { contract, reader } = divergentToken(), store = new Store();
  let actor = REGISTRAR, chain = reader.source.chainId, nonce = 7n, sends = 0, active = true;
  let sendError: unknown, sendGate: Promise<unknown> | undefined, lastWire: any;
  let receipt: any = null, transaction: any = null, blockHash = BLOCK, hook: ((method: string) => void) | undefined;
  const provider = { async request({ method, params = [] }: { method: string; params?: readonly unknown[] }): Promise<unknown> {
    hook?.(method);
    if (method === 'eth_chainId') return `0x${chain.toString(16)}`;
    if (method === 'eth_accounts') return [actor];
    if (method === 'eth_getCode') return CODE;
    if (method === 'eth_getTransactionCount') return `0x${nonce.toString(16)}`;
    if (method === 'eth_call') return '0x';
    if (method === 'eth_sendTransaction') { sends++; lastWire = params[0]; if (sendGate) return sendGate; if (sendError !== undefined) throw sendError; return HASH; }
    if (method === 'eth_getTransactionReceipt') return receipt;
    if (method === 'eth_getTransactionByHash') return transaction;
    if (method === 'eth_getBlockByNumber') return { number: '0x64', hash: blockHash };
    if (method === 'eth_blockNumber') return '0x65';
    throw new Error(`Unexpected test RPC ${method}`);
  } };
  const pin = { chainId: chain, controller: reader.source.address, runtimeCodeHash: hashControlBytes(CODE) };
  const create = () => new StandaloneSettlementSession(provider, pin, REGISTRAR, store,
    () => { if (!active) throw new Error('changed connection'); }, new WalletSession(reader, { account: REGISTRAR }));
  const session = create();
  const begin: TransactionIntent = { kind: 'beginSettlement', params: { tokenId: TOKEN, settlementId: settlementId('8'), expectedHolder: DAVE,
    snapshotHash: commitment('d'), deadline: contract.now + 600n } };
  const finalize: TransactionIntent = { kind: 'finalizeSettlement', params: { settlementId: OPEN_GAP_ID,
    recordCommitment: commitment('d'), registryReference: commitment('e'), effectiveAt: T.v3 + 10n, proofData: '0x12345678' } };
  const cancel: TransactionIntent = { kind: 'cancelSettlement', params: { settlementId: OPEN_GAP_ID, reasonHash: commitment('f') } };
  const mine = () => {
    const s = store.state!.submission!;
    const signature = { beginSettlement: 'SettlementStarted(bytes32,uint256,address,address,bytes32,uint64)',
      finalizeSettlement: 'SettlementFinalized(bytes32,uint256,bytes32,uint64,uint64)', cancelSettlement: 'SettlementCancelled(bytes32,uint256,bytes32)' }[s.kind];
    let data: string;
    if (s.kind === 'beginSettlement') {
      assert.equal(begin.kind, 'beginSettlement');
      data = encodeWords(['address', 'bytes32', 'uint64'], [begin.params.expectedHolder, begin.params.snapshotHash, begin.params.deadline]);
    } else data = s.kind === 'cancelSettlement' ? '0x' : encodeWords(['uint64', 'uint64'], [4n, s.effectiveAt!]);
    const common = { blockHash: BLOCK, blockNumber: '0x64', transactionHash: HASH, transactionIndex: '0x0' };
    receipt = { ...common, from: REGISTRAR, to: pin.controller, status: '0x1', logs: [{ ...common, address: pin.controller,
      topics: [keccak256Utf8(signature), ...s.indexed], data, removed: false }] };
    transaction = { ...common, hash: HASH, from: REGISTRAR, to: pin.controller, chainId: `0x${chain.toString(16)}`,
      nonce: lastWire.nonce, value: '0x0', input: lastWire.data };
  };
  return { session, create, store, contract, begin, finalize, cancel, mine, sends: () => sends, wire: () => lastWire,
    receipt: () => receipt, transaction: () => transaction, setError: (e: unknown) => { sendError = e; },
    setGate: (gate: Promise<unknown>) => { sendGate = gate; }, setNonce: (n: bigint) => { nonce = n; },
    setActor: (a: string) => { actor = a; }, setChain: (n: bigint) => { chain = n; },
    setAuthority: (allowed: boolean) => { reader.isSettlementAuthority = async () => allowed; }, disconnect: () => { active = false; }, reorg: () => { blockHash = commitment('c'); }, setHook: (fn: (method: string) => void) => { hook = fn; } };
}
for (const kind of ['begin', 'finalize', 'cancel'] as const) test(`${kind}: SDK preflight, explicit signer send, public journal and canonical receipt`, async () => {
  const f = fixture(); if (kind === 'cancel') f.contract.advanceTo(T.openGapDeadline + 1n);
  const review = await f.session.prepare(f[kind]);
  assert.equal(f.sends(), 0); assert.equal((await f.session.status()).status, 'idle');
  assert.ok(review.preflight.checks.length > 0); assert.ok(review.identity.registerId);
  if (kind === 'cancel') assert.match(review.preflight.consequences.join(' '), /settles nothing/);
  if (kind === 'finalize') { assert.equal(review.parameters.proofBytes, 4); assert.equal('proofData' in review.parameters, false); }
  await f.session.submit(review, review.digest); assert.equal(f.sends(), 1);
  assert.equal(f.wire().nonce, '0x7'); assert.equal(f.wire().chainId, `0x${review.chainId.toString(16)}`);
  const stored = serializeSettlementState(await f.session.status()); assert.ok(!stored.includes('12345678')); assert.ok(!stored.includes('proofData'));
  const restarted = f.create(); assert.equal((await restarted.reconcile()).state, 'pending'); assert.equal(f.sends(), 1);
  await assert.rejects(restarted.prepare(f[kind]), /SETTLEMENT_RECONCILIATION_REQUIRED/);
  f.mine(); const receipt = await restarted.reconcile(); assert.equal(receipt.state, 'confirmed');
  assert.equal(receipt.executionEventObserved, true); assert.equal(receipt.protocolFinality, 'not-evaluated');
  await restarted.acknowledge(); assert.equal((await restarted.status()).status, 'idle'); assert.equal(f.sends(), 1);
});
test('invalid checksum, uint64 overflow and oversized proof are refused before prompting', async () => {
  const f = fixture(); assert.equal(f.begin.kind, 'beginSettlement'); assert.equal(f.finalize.kind, 'finalizeSettlement');
  await assert.rejects(f.session.prepare({ ...f.begin, params: { ...f.begin.params, expectedHolder: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAec' } }), /SETTLEMENT_ADDRESS_REFUSED/);
  await assert.rejects(f.session.prepare({ ...f.begin, params: { ...f.begin.params, deadline: 1n << 64n } }), /SETTLEMENT_INTEGER_REFUSED/);
  await assert.rejects(f.session.prepare({ ...f.finalize, params: { ...f.finalize.params, proofData: `0x${'ff'.repeat(65537)}` } }), /SETTLEMENT_PROOF_REFUSED/);
  assert.equal(f.sends(), 0);
});
test('no review, a copied review, wrong digest and already-consumed review never send', async () => {
  const f = fixture(), review = await f.session.prepare(f.begin);
  await assert.rejects(f.session.submit({ ...review }, review.digest), /SETTLEMENT_REVIEW_REQUIRED/);
  await assert.rejects(f.session.submit(review, HASH), /SETTLEMENT_REVIEW_REQUIRED/);
  await assert.rejects(f.session.submit(review, review.digest), /SETTLEMENT_REVIEW_REQUIRED/); assert.equal(f.sends(), 0);
});
test('changed nonce, authority, selected account and network refuse a stale review', async () => {
  for (const change of ['nonce', 'authority', 'account', 'chain']) {
    const f = fixture(), review = await f.session.prepare(f.begin);
    if (change === 'nonce') f.setNonce(8n);
    if (change === 'authority') f.setAuthority(false);
    if (change === 'account') f.setActor(STRANGER);
    if (change === 'chain') f.setChain(review.chainId + 1n);
    await assert.rejects(f.session.submit(review, review.digest)); assert.equal(f.sends(), 0); assert.equal((await f.session.status()).status, 'idle');
  }
});
test('failed pre-send storage, revoked connection and repeated concurrent submit never send twice', async () => {
  const f = fixture(), review = await f.session.prepare(f.begin); f.store.failRevision = 1n;
  await assert.rejects(f.session.submit(review, review.digest), /SETTLEMENT_OPERATION_CONCURRENT/); assert.equal(f.sends(), 0);
  f.store.failRevision = null; const next = await f.session.prepare(f.begin); f.disconnect();
  await assert.rejects(f.session.submit(next, next.digest)); assert.equal(f.sends(), 0);
  const other = fixture(), r = await other.session.prepare(other.begin); let resolve!: (value: string) => void;
  other.setGate(new Promise(done => { resolve = done; })); const pending = other.session.submit(r, r.digest);
  await assert.rejects(other.session.submit(r, r.digest), /SETTLEMENT_OPERATION_BUSY/);
  while (other.sends() === 0) await new Promise(done => setImmediate(done)); resolve(HASH); await pending; assert.equal(other.sends(), 1);
});
test('two sessions sharing a durable CAS cannot both submit the same nonce', async () => {
  const f = fixture(), second = f.create(), a = await f.session.prepare(f.begin), b = await second.prepare(f.begin);
  const results = await Promise.allSettled([f.session.submit(a, a.digest), second.submit(b, b.digest)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(f.sends(), 1);
});
test('explicit direct numeric 4001 returns idle only after durable cleanup and requires a new review', async () => {
  const f = fixture(), review = await f.session.prepare(f.begin); f.setError({ code: 4001, message: 'PRIVATE_PAYLOAD' });
  await assert.rejects(f.session.submit(review, review.digest), /CONTROL_PROVIDER_REQUEST_REJECTED/);
  assert.equal((await f.session.status()).status, 'idle'); assert.equal(f.sends(), 1);
  await assert.rejects(f.session.submit(review, review.digest), /SETTLEMENT_REVIEW_REQUIRED/); assert.equal(f.sends(), 1);
  const second = fixture(), r = await second.session.prepare(second.begin); second.store.failRevision = 2n; second.setError({ code: 4001 });
  await assert.rejects(second.session.submit(r, r.digest), /SETTLEMENT_PERSISTENCE_UNCERTAIN/);
  assert.equal((await second.create().status()).status, 'outcome-unknown');
});
for (const error of [{ code: '4001' }, { data: { code: 4001 } }, { code: -32000 }, new Error('Rejected PRIVATE_DIAGNOSTIC')]) {
  test('ambiguous provider failure stays locked across reload and recovery never resends', async () => {
    const f = fixture(), review = await f.session.prepare(f.begin); f.setError(error);
    await assert.rejects(f.session.submit(review, review.digest), /CONTROL_PROVIDER_OUTCOME_UNCERTAIN/);
    const restarted = f.create(); assert.equal((await restarted.status()).status, 'outcome-unknown');
    await assert.rejects(restarted.prepare(f.begin), /SETTLEMENT_RECONCILIATION_REQUIRED/);
    await assert.rejects(restarted.recover(HASH), /SETTLEMENT_RECOVERY_BINDING_UNOBSERVED/);
    f.mine(); await restarted.recover(HASH); await restarted.acknowledge(); assert.equal(f.sends(), 1);
  });
}
test('successful send with failed journal update remains recoverable uncertainty', async () => {
  const f = fixture(), review = await f.session.prepare(f.begin); f.store.failRevision = 2n;
  await assert.rejects(f.session.submit(review, review.digest), /SETTLEMENT_PERSISTENCE_UNCERTAIN/);
  assert.equal((await f.create().status()).status, 'outcome-unknown'); f.store.failRevision = null; f.mine();
  await f.create().recover(HASH); assert.equal((await f.session.status()).status, 'submitted'); assert.equal(f.sends(), 1);
});
for (const field of ['nonce', 'input', 'transactionIndex', 'chainId']) test(`receipt mismatch ${field} blocks acknowledgement`, async () => {
  const f = fixture(), review = await f.session.prepare(f.begin); await f.session.submit(review, review.digest); f.mine();
  f.transaction()[field] = field === 'input' ? '0x' : '0x999';
  await assert.rejects(f.session.acknowledge(), /SETTLEMENT_RECEIPT_BINDING_REFUSED/); assert.equal((await f.session.status()).status, 'submitted');
});
test('missing, changed or removed protocol event is not execution evidence', async () => {
  for (const change of ['missing', 'removed', 'data', 'index']) {
    const f = fixture(), r = await f.session.prepare(f.begin); await f.session.submit(r, r.digest); f.mine();
    if (change === 'missing') f.receipt().logs = [];
    if (change === 'removed') f.receipt().logs[0].removed = true;
    if (change === 'data') f.receipt().logs[0].data = '0x';
    if (change === 'index') f.receipt().logs[0].transactionIndex = '0x1';
    await assert.rejects(f.session.acknowledge(), /SETTLEMENT_EVENT/); assert.equal((await f.session.status()).status, 'submitted');
  }
});
test('reorg blocks terminal acknowledgement and a reverted canonical receipt can be explicitly acknowledged', async () => {
  const f = fixture(), r = await f.session.prepare(f.begin); await f.session.submit(r, r.digest); f.mine(); f.reorg();
  assert.equal((await f.session.reconcile()).state, 'reorged'); await assert.rejects(f.session.acknowledge(), /SETTLEMENT_TERMINAL_RECEIPT_REQUIRED/);
  const second = fixture(), review = await second.session.prepare(second.begin); await second.session.submit(review, review.digest); second.mine(); second.receipt().status = '0x0'; second.receipt().logs = [];
  assert.equal((await second.session.reconcile()).state, 'reverted'); await second.session.acknowledge(); assert.equal((await second.session.status()).status, 'idle');
});
test('journal rejects extra secret-bearing fields, invalid event shape and binding changes', async () => {
  const f = fixture(), r = await f.session.prepare(f.begin); await f.session.submit(r, r.digest);
  const raw = JSON.parse(serializeSettlementState(await f.session.status()));
  assert.throws(() => parseSettlementState(JSON.stringify({ ...raw, proofData: 'secret' })), /SETTLEMENT_JOURNAL_REFUSED/);
  assert.throws(() => parseSettlementState(JSON.stringify({ ...raw, submission: { ...raw.submission, kind: 'arbitraryCall' } })), /SETTLEMENT_JOURNAL_REFUSED/);
  f.store.state = { ...f.store.state!, actor: STRANGER };
  await assert.rejects(f.create().status(), /SETTLEMENT_JOURNAL_BINDING_REFUSED/);
});
test('different canonical same-nonce transaction can resolve uncertainty without claiming success', async () => {
  const f = fixture(), review = await f.session.prepare(f.begin); f.setError(new Error('lost response'));
  await assert.rejects(f.session.submit(review, review.digest)); f.mine();
  const replacement = commitment('9'); f.transaction().hash = replacement; f.transaction().value = '0x1';
  f.receipt().transactionHash = replacement; f.setNonce(8n);
  const proof = await f.session.acknowledgeReplacement(replacement);
  assert.equal(proof.originalExecutionConfirmed, false); assert.equal((await f.session.status()).status, 'idle'); assert.equal(f.sends(), 1);
});
test('replacement proof with original intent or insufficient nonce proof keeps the journal locked', async () => {
  const f = fixture(), review = await f.session.prepare(f.begin); f.setError(new Error('lost response'));
  await assert.rejects(f.session.submit(review, review.digest)); f.mine();
  const replacement = commitment('9'); f.transaction().hash = replacement; f.receipt().transactionHash = replacement;
  await assert.rejects(f.session.acknowledgeReplacement(replacement), /CONTROL_REPLACEMENT_IS_ORIGINAL_INTENT/);
  f.transaction().value = '0x1';
  await assert.rejects(f.session.acknowledgeReplacement(replacement), /CONTROL_REPLACEMENT_NONCE_NOT_CONSUMED/);
  assert.equal((await f.session.status()).status, 'outcome-unknown'); assert.equal(f.sends(), 1);
});
