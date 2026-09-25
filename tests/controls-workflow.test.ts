import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashControlBytes } from '../src/controls/authorization.ts';
import { parseFixedSubmission, serializeFixedSubmission, type FixedSubmission } from '../src/controls/execution.ts';
import { parseOperation, serializeOperation, type OperationState, type PublicOperationStore } from '../src/controls/operationJournal.ts';
import { FilePublicOperationStore } from '../src/controls/fileOperationStore.ts';
import { ResponsibilityWalletSession } from '../src/controls/session.ts';
import type { Eip1193Provider } from '../src/adapters/signing/eip1193Signer.ts';

// Prepared during implementation. Run only in the user-directed unified validation batch.
const a = (n: string) => `0x${n.repeat(40)}`;
const h = (n: string) => `0x${n.repeat(64)}`;
const pin = { chainId: 560048n, controller: a('1'), runtimeCodeHash: hashControlBytes('0x6000') };
const fixed: FixedSubmission = { schema: '8415-fixed-submission/1', pin, guards: [], actor: a('2'), value: 0n,
  transactionHash: h('3'), calldataHash: h('4'), event: { address: a('5'), signature: 'Transfer(address,address,uint256)',
    indexed: [h('6'), h('7'), h('8')], dataHash: hashControlBytes('0x') } };
const idle: OperationState = { schema: '8415-operation/1', revision: 0n, status: 'idle', deployment: pin, actor: a('2'), requestDigest: null, submission: null };
class MemoryStore implements PublicOperationStore {
  state: OperationState | null = null;
  async read() { return this.state === null ? null : parseOperation(serializeOperation(this.state)); }
  async compareAndSwap(expected: bigint | null, next: OperationState) {
    if ((this.state?.revision ?? null) !== expected) return false;
    this.state = parseOperation(serializeOperation(next)); return true;
  }
}
test('fixed public journal roundtrip carries no arbitrary caller data', () => {
  const withExtra = { ...fixed, rawSignature: 'MUST_NOT_PERSIST' };
  const text = serializeFixedSubmission(withExtra);
  assert.ok(!text.includes('MUST_NOT_PERSIST'));
  assert.deepEqual(parseFixedSubmission(text), fixed);
});
test('fixed journal refuses extra keys, wildcard events and mismatched guard chain', () => {
  for (const mutate of [
    (r: any) => { r.privateKey = 'forbidden'; },
    (r: any) => { r.event.indexed[0] = null; },
    (r: any) => { r.event.dataHash = null; },
    (r: any) => { r.guards = [{ ...r.pin, chainId: '1' }]; },
    (r: any) => { r.event.signature = 'Arbitrary(address)'; },
  ]) {
    const r = JSON.parse(serializeFixedSubmission(fixed)); mutate(r);
    assert.throws(() => parseFixedSubmission(JSON.stringify(r)));
  }
});
test('unknown transaction template is distinct from a submitted transaction', () => {
  const unknown: OperationState = { ...idle, revision: 1n, status: 'outcome-unknown', requestDigest: h('9'),
    submission: { ...fixed, transactionHash: h('0') } };
  assert.equal(parseOperation(serializeOperation(unknown)).status, 'outcome-unknown');
  assert.throws(() => parseOperation(serializeOperation({ ...unknown, status: 'submitted' })));
  assert.throws(() => parseOperation(serializeOperation({ ...unknown, submission: fixed })));
});
test('journal refuses wrong actor or deployment even with a valid-looking transaction hash', () => {
  const s: OperationState = { ...idle, status: 'submitted', requestDigest: h('9'), submission: fixed };
  assert.equal(parseOperation(serializeOperation(s)).submission?.transactionHash, fixed.transactionHash);
  assert.throws(() => parseOperation(serializeOperation({ ...s, actor: a('9') })));
  assert.throws(() => parseOperation(serializeOperation({ ...s, deployment: { ...pin, controller: a('9') } })));
});
test('public file store uses revision CAS and survives constructing a new instance', async () => {
  const root = mkdtempSync(join(tmpdir(), '8415-public-journal-'));
  try {
    const first = new FilePublicOperationStore(root);
    assert.equal(await first.compareAndSwap(null, idle), true);
    const second = new FilePublicOperationStore(root);
    assert.deepEqual(await second.read(), idle);
    assert.equal(await second.compareAndSwap(null, idle), false);
    assert.equal(await first.compareAndSwap(0n, { ...idle, revision: 1n }), true);
    assert.equal(await second.compareAndSwap(0n, { ...idle, revision: 1n }), false);
  } finally { rmSync(root, { recursive: true }); }
});
function provider(options: { simulationFails?: boolean; sendFails?: boolean }, sent: string[]): Eip1193Provider {
  return { async request({ method }) {
    if (method === 'eth_chainId') return '0x88bb0';
    if (method === 'eth_getCode') return '0x6000';
    if (method === 'eth_accounts') return [a('2')];
    if (method === 'eth_call') { if (options.simulationFails) throw new Error('fixture'); return '0x'; }
    if (method === 'eth_sendTransaction') { sent.push(method); if (options.sendFails) throw new Error('fixture'); return h('a'); }
    if (method === 'eth_getTransactionReceipt') return null;
    throw new Error('unexpected fixture call');
  } };
}
test('provider rejection after a prompt preserves template and blocks replay after restart', async () => {
  const store = new MemoryStore(), sent: string[] = [], p = provider({ sendFails: true }, sent);
  const first = new ResponsibilityWalletSession(p, pin, a('2'), store);
  await assert.rejects(first.execute({ kind: 'control', action: { kind: 'create-account' } }));
  assert.equal(store.state?.status, 'outcome-unknown');
  assert.equal(store.state?.submission?.transactionHash, h('0'));
  const restarted = new ResponsibilityWalletSession(p, pin, a('2'), store);
  await assert.rejects(restarted.execute({ kind: 'control', action: { kind: 'create-account' } }), /CONTROL_RECONCILIATION_REQUIRED/);
  await assert.rejects(restarted.recoverTransactionHash(h('b')), /CONTROL_RECOVERY_BINDING_NOT_OBSERVED/);
  assert.equal(sent.length, 1);
});
test('failure before the send hook restores idle and never invokes the wallet send', async () => {
  const store = new MemoryStore(), sent: string[] = [];
  const session = new ResponsibilityWalletSession(provider({ simulationFails: true }, sent), pin, a('2'), store);
  await assert.rejects(session.execute({ kind: 'control', action: { kind: 'create-account' } }));
  assert.equal(store.state?.status, 'idle'); assert.equal(sent.length, 0);
});
test('submission hash remains pending and does not allow automatic next operation', async () => {
  const store = new MemoryStore(), sent: string[] = [];
  const session = new ResponsibilityWalletSession(provider({}, sent), pin, a('2'), store);
  await session.execute({ kind: 'control', action: { kind: 'create-account' } });
  assert.equal(store.state?.status, 'submitted');
  assert.equal((await session.reconcile()).state, 'pending');
  await assert.rejects(session.acknowledgeTerminal(h('a')), /CONTROL_TERMINAL_RECEIPT_REQUIRED/);
  assert.equal(sent.length, 1);
});
