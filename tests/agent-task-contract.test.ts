import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  freezeTaskPolicy, parseTaskPolicy, normalizeExistingOperation, freezeChildOperation, parseChildOperation,
  assessChildScope, executionAvailability, normalizeAuthorizationReference, emptyTaskBudget, normalizeTaskBudget,
  reserveTaskBudget, markTaskSendAttempt, noteTaskSubmission, cancelUnattemptedReservation, reconcileTaskBudget,
  normalizeTaskBudgetPage, parseTaskBudgetPage, assembleTaskBudgetPages,
  type FrozenTask, type FrozenChild, type TaskBudgetPage,
} from '../src/agent/taskContract.ts';

const a = (n: string) => `0x${n.repeat(40)}`;
const h = (n: string) => `0x${n.repeat(64)}`;
const actor = a('1'), buyer = a('2'), contract = a('3');
const now = 1_000n;
const operation = { kind: 'erc721-transfer', chainId: '11155111', actor, contract, recipient: buyer, tokenId: '7' };
const policyInput = () => ({ schema: '8415-agent-task/1', taskId: 'sell-token-7', tenant: 'xiongan',
  origin: 'https://xiongan.8415wallet.com:9446', chainId: '11155111', actor, expiresAt: '10000',
  fees: { perOperationWei: '100000', totalWei: '200000' }, intent: { kind: 'exact-operation', operation } });
const saleInput = () => ({ ...policyInput(), intent: { kind: 'nft-sale', direction: 'sell', standard: 'ERC-721',
  contract, tokenId: '7', quantity: '1', minimumProceeds: { currency: 'USD', amountMinor: '50000', minorUnit: 2,
    comparison: 'gt', basis: 'net' }, marketAdapters: ['existing-market'] } });
function childInput(task: FrozenTask, override: Record<string, unknown> = {}) {
  return { schema: '8415-agent-child/1', operationId: 'operation-1', taskDigest: task.digest, operation,
    nonce: '5', expiresAt: '1500', wire: { to: contract, calldataHash: h('4'), valueWei: '0' },
    fees: { gasLimit: '21000', maxFeePerGasWei: '2' }, market: null, ...override };
}
const quote = (override: Record<string, unknown> = {}) => ({ adapterId: 'existing-market', quoteId: 'quote-1', buyer,
  proceedsMinor: '50100', currency: 'USD', minorUnit: 2, basis: 'net', expiresAt: '1700',
  priceEvidenceRef: 'price-1', settlementEvidenceRef: 'settlement-1', ...override });
function exact() { const task = freezeTaskPolicy(policyInput()); return { task, child: freezeChildOperation(childInput(task)) }; }
function sale() { const task = freezeTaskPolicy(saleInput()); return { task, child: freezeChildOperation(childInput(task, { market: quote() })) }; }
const ref = (task: FrozenTask) => ({ schema: '8415-task-authorization-reference/1', taskDigest: task.digest,
  reference: 'authorization-1', status: 'authorized', grantPolicyVersion: '3', credentialRevisionAtApproval: '8' });
const outside = (task: FrozenTask, child: FrozenChild, code: string) => {
  const r = assessChildScope(task, child, now); assert.equal(r.state, 'outside-declared-scope'); assert.ok(r.reasons.includes(code));
};

test('canonical task serialization ignores input key order and returns detached deeply frozen values', () => {
  const input = saleInput(), before = JSON.stringify(input), t = freezeTaskPolicy(input);
  assert.equal(freezeTaskPolicy(Object.fromEntries(Object.entries(input).reverse())).digest, t.digest);
  input.intent.minimumProceeds.amountMinor = '1';
  assert.equal(t.policy.intent.kind === 'nft-sale' && t.policy.intent.minimumProceeds.amountMinor, '50000');
  assert.ok(Object.isFrozen(t) && Object.isFrozen(t.policy.intent));
  if (t.policy.intent.kind === 'nft-sale') assert.ok(Object.isFrozen(t.policy.intent.marketAdapters));
  assert.deepEqual(parseTaskPolicy(before), t);
});
test('parent task is independent of child quote and nonce; changed child has a distinct digest', () => {
  const { task, child } = sale();
  const later = freezeChildOperation(childInput(task, { operationId: 'operation-2', nonce: '6', market: quote({ quoteId: 'quote-2', proceedsMinor: '51000' }) }));
  assert.notEqual(later.digest, child.digest); assert.equal(later.child.taskDigest, child.child.taskDigest);
  assert.equal(assessChildScope(task, later, now).state, 'requires-trusted-verification');
  assert.equal(task.digest, freezeTaskPolicy(saleInput()).digest);
});
test('all material parent scope changes change its digest', () => {
  const base = saleInput(), original = freezeTaskPolicy(base).digest;
  for (const changed of [ { ...base, actor: a('4') }, { ...base, expiresAt: '10001' },
    { ...base, fees: { ...base.fees, totalWei: '200001' } },
    { ...base, intent: { ...base.intent, tokenId: '8' } },
    { ...base, intent: { ...base.intent, minimumProceeds: { ...base.intent.minimumProceeds, basis: 'gross' } } },
    { ...base, intent: { ...base.intent, marketAdapters: ['other-market'] } } ]) assert.notEqual(freezeTaskPolicy(changed).digest, original);
});
test('strict schemas reject hidden signatures, calldata, approval flags and executable getters', () => {
  const p = policyInput();
  for (const key of ['privateKey', 'signature', 'approved', 'execute']) assert.throws(() => freezeTaskPolicy({ ...p, [key]: true }), /TASK_SCHEMA_REFUSED/);
  let called = false;
  const malicious = { ...operation, get amount() { called = true; throw Error('side effect'); } };
  assert.throws(() => normalizeExistingOperation(malicious), /TASK_SCHEMA_REFUSED/); assert.equal(called, false);
  assert.throws(() => normalizeExistingOperation({ ...operation, data: '0x1234' }), /TASK_SCHEMA_REFUSED/);
  for (const kind of ['approve', 'setApprovalForAll', 'swap', 'sell', 'arbitrary-call']) assert.throws(() => normalizeExistingOperation({ ...operation, kind }), /TASK_OPERATION_REFUSED/);
});
test('bounded JSON and exact integer/address/origin formats fail closed', () => {
  assert.throws(() => parseTaskPolicy('x'), /TASK_JSON_REFUSED/);
  assert.throws(() => parseTaskPolicy(' '.repeat(32769)), /TASK_SIZE_REFUSED/);
  for (const value of ['01', '-1', '1.0', 1, (1n << 256n).toString()]) assert.throws(() => normalizeExistingOperation({ ...operation, tokenId: value }), /TASK_INTEGER_REFUSED/);
  for (const origin of ['https://example.com/', 'https://example.com/path', 'http://example.com', 'https://user:pass@example.com', 'https://example.com?secret=x']) assert.throws(() => freezeTaskPolicy({ ...policyInput(), origin }), /TASK_ORIGIN_REFUSED/);
  const valid = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
  assert.equal(normalizeExistingOperation({ ...operation, recipient: valid }).kind, operation.kind);
  assert.throws(() => normalizeExistingOperation({ ...operation, recipient: valid.replace('aA', 'AA') }), /TASK_ADDRESS_REFUSED/);
  assert.throws(() => normalizeExistingOperation({ ...operation, recipient: a('0') }), /TASK_ADDRESS_REFUSED/);
});
test('the existing asset and controlled-account chain policies remain separate', () => {
  for (const chainId of ['1', '8453', '11155111', '84532']) assert.equal(normalizeExistingOperation({ ...operation, chainId }).chainId, chainId);
  const controller = { contract: a('4'), runtimeCodeHash: h('5') };
  for (const chainId of ['11155111', '560048']) assert.equal(normalizeExistingOperation({ kind: 'create-account', chainId, actor, controller }).chainId, chainId);
  assert.throws(() => normalizeExistingOperation({ kind: 'create-account', chainId: '1', actor, controller }), /TASK_CHAIN_REFUSED/);
  assert.throws(() => normalizeExistingOperation({ ...operation, chainId: '560048' }), /TASK_CHAIN_REFUSED/);
});
test('all nine existing bounded operation kinds have canonical representations', () => {
  const identity = { chainId: '11155111', actor }, controller = { contract: a('4'), runtimeCodeHash: h('5') }, token = { contract, runtimeCodeHash: h('6') };
  const ops = [operation, { ...identity, kind: 'native-transfer', recipient: buyer, valueWei: '1' },
    { ...identity, kind: 'erc20-transfer', contract, recipient: buyer, amount: '1' },
    { ...operation, kind: 'erc1155-transfer', amount: '1' }, { ...identity, kind: 'create-account', controller },
    { ...identity, kind: 'deposit', controller, token, tokenId: '7' },
    { ...identity, kind: 'standalone-withdraw', controller, token, tokenId: '7', destination: buyer },
    ...['complete', 'return-hop'].map(kind => ({ ...identity, kind, controller, token, sequenceId: h('7'), legId: h('8'), expectedRevision: '9' })) ];
  for (const op of ops) assert.equal(normalizeExistingOperation(op).kind, op.kind);
});
test('a bare NFT transfer is not evidence that a sale occurred', () => {
  const task = freezeTaskPolicy(saleInput());
  outside(task, freezeChildOperation(childInput(task)), 'TASK_MARKET_EVIDENCE_REQUIRED');
});
test('a claimed price above $500 remains unexecutable without verified market settlement and signing', () => {
  const { task, child } = sale(); const r = assessChildScope(task, child, now);
  assert.equal(r.state, 'requires-trusted-verification'); assert.equal(r.executable, false);
  assert.ok(r.requiredCapabilities.includes('ATOMIC_SALE_SETTLEMENT_VERIFIER'));
  const availability = executionAvailability(task, child, ref(task), now);
  assert.equal(availability.executable, false);
  for (const capability of r.requiredCapabilities) assert.ok(availability.reasons.includes(`${capability}_NOT_CONNECTED`));
});
test('strictly above $500 differs from at least $500 and gross is not silently net', () => {
  const { task } = sale();
  for (const proceedsMinor of ['49999', '50000']) outside(task, freezeChildOperation(childInput(task, { market: quote({ proceedsMinor }) })), 'TASK_PRICE_BELOW_REQUIRED_BOUND');
  outside(task, freezeChildOperation(childInput(task, { market: quote({ basis: 'gross' }) })), 'TASK_MARKET_CLAIM_OUTSIDE_SCOPE');
  const p = saleInput(); p.intent.minimumProceeds.comparison = 'gte'; const atLeast = freezeTaskPolicy(p);
  assert.equal(assessChildScope(atLeast, freezeChildOperation(childInput(atLeast, { market: quote({ proceedsMinor: '50000' }) })), now).state, 'requires-trusted-verification');
});
test('sale bounds bind NFT identity, recipient to quote, adapter, quantity and quote expiry', () => {
  const { task } = sale();
  outside(task, freezeChildOperation(childInput(task, { operation: { ...operation, tokenId: '8' }, market: quote() })), 'TASK_NFT_OUTSIDE_SCOPE');
  for (const market of [quote({ buyer: a('5') }), quote({ adapterId: 'self-claimed' }), quote({ expiresAt: '1499' })]) outside(task, freezeChildOperation(childInput(task, { market })), 'TASK_MARKET_CLAIM_OUTSIDE_SCOPE');
  assert.throws(() => freezeTaskPolicy({ ...saleInput(), intent: { ...saleInput().intent, quantity: '2' } }), /TASK_NFT_QUANTITY_REFUSED/);
  assert.throws(() => freezeTaskPolicy({ ...saleInput(), intent: { ...saleInput().intent, marketAdapters: [] } }), /TASK_MARKET_SCOPE_REQUIRED/);
});
test('ERC1155 sale binds the full task quantity instead of inventing split-sale pricing', () => {
  const p = saleInput(); p.intent.standard = 'ERC-1155'; p.intent.quantity = '2'; const task = freezeTaskPolicy(p);
  for (const amount of ['1', '3']) outside(task, freezeChildOperation(childInput(task, { operation: { ...operation, kind: 'erc1155-transfer', amount }, market: quote() })), 'TASK_NFT_OUTSIDE_SCOPE');
  assert.equal(assessChildScope(task, freezeChildOperation(childInput(task, { operation: { ...operation, kind: 'erc1155-transfer', amount: '2' }, market: quote() })), now).state, 'requires-trusted-verification');
});
test('changing a child cannot silently change its parent, identity, wire value or target', () => {
  const { task } = exact();
  outside(task, freezeChildOperation(childInput(task, { taskDigest: h('9') })), 'TASK_BINDING_MISMATCH');
  outside(task, freezeChildOperation(childInput(task, { operation: { ...operation, recipient: a('6') } })), 'TASK_OPERATION_OUTSIDE_SCOPE');
  outside(task, freezeChildOperation(childInput(task, { wire: { to: a('6'), calldataHash: h('4'), valueWei: '0' } })), 'TASK_WIRE_TARGET_OUTSIDE_SCOPE');
  outside(task, freezeChildOperation(childInput(task, { wire: { to: contract, calldataHash: h('4'), valueWei: '1' } })), 'TASK_WIRE_VALUE_OUTSIDE_SCOPE');
});
test('native transfers bind recipient, value and the hash of empty calldata', () => {
  const native = { kind: 'native-transfer', chainId: '11155111', actor, recipient: buyer, valueWei: '7' };
  const task = freezeTaskPolicy({ ...policyInput(), intent: { kind: 'exact-operation', operation: native } });
  const wire = { to: buyer, valueWei: '7', calldataHash: '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470' };
  const child = freezeChildOperation(childInput(task, { operation: native, wire }));
  assert.equal(assessChildScope(task, child, now).state, 'requires-trusted-verification');
  for (const changed of [{ ...wire, calldataHash: h('4') }, { ...wire, to: contract }, { ...wire, valueWei: '8' }]) {
    assert.equal(assessChildScope(task, freezeChildOperation(childInput(task, { operation: native, wire: changed })), now).state, 'outside-declared-scope');
  }
});
test('control targets follow the existing adapter and dynamic withdrawal accounts still require independent proof', () => {
  const identity = { chainId: '11155111', actor }, controller = { contract: a('4'), runtimeCodeHash: h('5') }, token = { contract, runtimeCodeHash: h('6') };
  const ops = [ { ...identity, kind: 'create-account', controller },
    { ...identity, kind: 'deposit', controller, token, tokenId: '7' },
    ...['complete', 'return-hop'].map(kind => ({ ...identity, kind, controller, token, sequenceId: h('7'), legId: h('8'), expectedRevision: '9' })) ];
  for (const op of ops) {
    const task = freezeTaskPolicy({ ...policyInput(), intent: { kind: 'exact-operation', operation: op } });
    const to = op.kind === 'deposit' ? token.contract : controller.contract;
    const wire = { to, calldataHash: h('4'), valueWei: '0' };
    assert.equal(assessChildScope(task, freezeChildOperation(childInput(task, { operation: op, wire })), now).state, 'requires-trusted-verification');
    outside(task, freezeChildOperation(childInput(task, { operation: op, wire: { ...wire, to: buyer } })), 'TASK_WIRE_TARGET_OUTSIDE_SCOPE');
    outside(task, freezeChildOperation(childInput(task, { operation: op, wire: { ...wire, valueWei: '1' } })), 'TASK_WIRE_VALUE_OUTSIDE_SCOPE');
  }
  const op = { ...identity, kind: 'standalone-withdraw', controller, token, tokenId: '7', destination: buyer };
  const task = freezeTaskPolicy({ ...policyInput(), intent: { kind: 'exact-operation', operation: op } });
  const child = freezeChildOperation(childInput(task, { operation: op, wire: { to: a('7'), calldataHash: h('4'), valueWei: '0' } }));
  assert.ok(executionAvailability(task, child, ref(task), now).reasons.includes('CONTROL_ACCOUNT_BINDING_VERIFIER_NOT_CONNECTED'));
});
test('child validity is short-lived even for a longer authorized parent task', () => {
  const { task, child } = exact();
  for (const expiresAt of ['1000', '1901', '10001']) outside(task, freezeChildOperation(childInput(task, { expiresAt })), 'TASK_EXPIRED_OR_CHILD_WINDOW_REFUSED');
  assert.ok(assessChildScope(task, child, 10000n).reasons.includes('TASK_EXPIRED_OR_CHILD_WINDOW_REFUSED'));
  assert.throws(() => assessChildScope(task, child, -1n), /TASK_CLOCK_REFUSED/);
});
test('wire, nonce and fee changes alter only the child digest and remain capped', () => {
  const { task, child } = exact();
  const changed = freezeChildOperation(childInput(task, { nonce: '6', wire: { ...child.child.wire, calldataHash: h('8') } }));
  assert.notEqual(changed.digest, child.digest); assert.equal(changed.child.taskDigest, task.digest);
  outside(task, freezeChildOperation(childInput(task, { fees: { gasLimit: '21000', maxFeePerGasWei: '5' } })), 'TASK_CHILD_FEE_LIMIT');
  assert.throws(() => freezeChildOperation(childInput(task, { fees: { gasLimit: (1n << 255n).toString(), maxFeePerGasWei: '2' } })), /TASK_FEE_OVERFLOW_REFUSED/);
  assert.deepEqual(parseChildOperation(JSON.stringify(child.child)), child);
});
test('tampered task or child digest is rejected before scope evaluation', () => {
  const { task, child } = exact();
  assert.throws(() => assessChildScope({ ...task, digest: h('1') }, child, now), /TASK_DIGEST_MISMATCH/);
  assert.throws(() => assessChildScope(task, { ...child, digest: h('1') }, now), /TASK_CHILD_DIGEST_MISMATCH/);
});
test('authorization status/reference is never accepted as proof and revisions remain distinct', () => {
  const { task, child } = exact(), r = normalizeAuthorizationReference(ref(task));
  assert.equal(r.grantPolicyVersion, '3'); assert.equal(r.credentialRevisionAtApproval, '8');
  assert.equal(executionAvailability(task, child, r, now).executable, false);
  for (const status of ['pending', 'suspended', 'revoked', 'expired']) assert.ok(executionAvailability(task, child, { ...r, status }, now).reasons.includes('TASK_AUTHORIZATION_NOT_AVAILABLE'));
  assert.throws(() => normalizeAuthorizationReference({ ...r, approved: true }), /TASK_SCHEMA_REFUSED/);
  assert.ok(executionAvailability(task, child, null, now).reasons.includes('TASK_AUTHORIZATION_NOT_AVAILABLE'));
});
test('fee/asset reservations are frozen proposals and revision conflicts/duplicates fail', () => {
  const { task, child } = exact(), initial = emptyTaskBudget(task), reserved = reserveTaskBudget(task, child, initial, '0', now);
  assert.equal(initial.reservations.length, 0); assert.equal(reserved.reservations[0]?.feeWei, '42000');
  assert.ok(Object.isFrozen(reserved.reservations));
  assert.throws(() => reserveTaskBudget(task, child, reserved, '0', now), /TASK_BUDGET_REVISION_CONFLICT/);
  assert.throws(() => reserveTaskBudget(task, child, reserved, '1', now), /TASK_DUPLICATE_OPERATION_REFUSED/);
  const second = freezeChildOperation(childInput(task, { operationId: 'operation-2', nonce: '6' }));
  assert.throws(() => reserveTaskBudget(task, second, reserved, '1', now), /TASK_TOTAL_ASSET_LIMIT/);
});
test('total fee cap is checked against all reservations, not only this child', () => {
  const p = policyInput(); p.fees = { perOperationWei: '50000', totalWei: '70000' }; const task = freezeTaskPolicy(p);
  const child = freezeChildOperation(childInput(task)), first = reserveTaskBudget(task, child, emptyTaskBudget(task), '0', now);
  const second = freezeChildOperation(childInput(task, { operationId: 'operation-2' }));
  assert.throws(() => reserveTaskBudget(task, second, first, '1', now), /TASK_TOTAL_FEE_LIMIT/);
});
test('send uncertainty survives roundtrip and cannot release or resend the reservation', () => {
  const { task, child } = sale(), reserved = reserveTaskBudget(task, child, emptyTaskBudget(task), '0', now);
  const unknown = markTaskSendAttempt(reserved, child.child.operationId, child.digest, '1');
  const reopened = normalizeTaskBudget(JSON.parse(JSON.stringify(unknown)));
  assert.equal(reopened.reservations[0]?.status, 'outcome-unknown'); assert.equal(reopened.reservations[0]?.feeWei, '42000');
  assert.throws(() => markTaskSendAttempt(reopened, child.child.operationId, child.digest, '2'), /TASK_SEND_ATTEMPT_REFUSED/);
  assert.throws(() => cancelUnattemptedReservation(reopened, child.child.operationId, child.digest, '2'), /TASK_UNCERTAIN_RESERVATION_CANNOT_RELEASE/);
  for (const fake of [null, { verified: true }, { cancelled: true }, { transactionHash: h('7'), status: 'confirmed' }]) assert.throws(() => reconcileTaskBudget(reopened, fake), /TASK_RECEIPT_VERIFIER_NOT_CONNECTED/);
});
test('a returned hash only records submitted, retaining all budget until trusted reconciliation', () => {
  const { task, child } = exact(), reserved = reserveTaskBudget(task, child, emptyTaskBudget(task), '0', now);
  assert.throws(() => noteTaskSubmission(reserved, child.child.operationId, child.digest, h('7'), '1'), /TASK_SUBMISSION_STATE_REFUSED/);
  const unknown = markTaskSendAttempt(reserved, child.child.operationId, child.digest, '1');
  const submitted = noteTaskSubmission(unknown, child.child.operationId, child.digest, h('7'), '2');
  assert.equal(submitted.reservations[0]?.status, 'submitted'); assert.equal(submitted.reservations[0]?.feeWei, '42000');
  assert.throws(() => cancelUnattemptedReservation(submitted, child.child.operationId, child.digest, '3'), /TASK_UNCERTAIN_RESERVATION_CANNOT_RELEASE/);
});
test('only a never-attempted proposal can cancel; a tombstone prevents operation ID reuse', () => {
  const { task, child } = exact(), reserved = reserveTaskBudget(task, child, emptyTaskBudget(task), '0', now);
  const cancelled = cancelUnattemptedReservation(reserved, child.child.operationId, child.digest, '1');
  assert.equal(cancelled.reservations[0]?.status, 'cancelled');
  assert.throws(() => reserveTaskBudget(task, child, cancelled, '2', now), /TASK_DUPLICATE_OPERATION_REFUSED/);
  const fresh = freezeChildOperation(childInput(task, { operationId: 'operation-2', nonce: '6' }));
  assert.equal(reserveTaskBudget(task, fresh, cancelled, '2', now).reservations.length, 2);
});
test('journal binding, malformed states, injected fields and revision overflow fail closed', () => {
  const { task, child } = exact(), reserved = reserveTaskBudget(task, child, emptyTaskBudget(task), '0', now);
  assert.throws(() => reserveTaskBudget(task, child, { ...emptyTaskBudget(task), taskDigest: h('8') }, '0', now), /TASK_BUDGET_BINDING_REFUSED/);
  assert.throws(() => normalizeTaskBudget({ ...reserved, approved: true }), /TASK_SCHEMA_REFUSED/);
  assert.throws(() => normalizeTaskBudget({ ...reserved, reservations: [{ ...reserved.reservations[0], status: 'submitted' }] }), /TASK_BUDGET_STATE_REFUSED/);
  const revision = ((1n << 256n) - 1n).toString();
  assert.throws(() => markTaskSendAttempt({ ...reserved, revision }, child.child.operationId, child.digest, revision), /TASK_BUDGET_REVISION_EXHAUSTED/);
});
test('more than 128 cancelled attempts do not permanently block a task and archived IDs still cannot be reused', () => {
  const { task, child } = exact(); let budget = emptyTaskBudget(task);
  for (let i = 0; i < 130; i++) {
    const attempt = freezeChildOperation(childInput(task, { operationId: `cancelled-${i}` }));
    budget = reserveTaskBudget(task, attempt, budget, budget.revision, now);
    budget = cancelUnattemptedReservation(budget, attempt.child.operationId, attempt.digest, budget.revision);
  }
  const page = (start: number, end: number, cursor: string | null, nextCursor: string | null): TaskBudgetPage => ({
    schema: '8415-task-budget-page/1', taskDigest: task.digest, revision: budget.revision, cursor, nextCursor,
    reservations: budget.reservations.slice(start, end),
  });
  const restored = assembleTaskBudgetPages([page(0, 64, null, 'page-2'), page(64, 128, 'page-2', 'page-3'), page(128, 130, 'page-3', null)]);
  assert.deepEqual(restored, budget);
  assert.equal(reserveTaskBudget(task, child, restored, restored.revision, now).reservations.length, 131);
  const duplicate = freezeChildOperation(childInput(task, { operationId: 'cancelled-0' }));
  assert.throws(() => reserveTaskBudget(task, duplicate, restored, restored.revision, now), /TASK_DUPLICATE_OPERATION_REFUSED/);
});
test('budget transport pages reject oversized, incomplete, mixed-revision and duplicate history', () => {
  const { task, child } = exact(), reserved = reserveTaskBudget(task, child, emptyTaskBudget(task), '0', now);
  const base: TaskBudgetPage = { schema: '8415-task-budget-page/1', taskDigest: task.digest, revision: '1', cursor: null, nextCursor: null, reservations: reserved.reservations };
  assert.deepEqual(parseTaskBudgetPage(JSON.stringify(base)), base);
  assert.throws(() => parseTaskBudgetPage(' '.repeat(32769)), /TASK_SIZE_REFUSED/);
  assert.throws(() => normalizeTaskBudgetPage({ ...base, reservations: Array(129).fill(reserved.reservations[0]) }), /TASK_ARRAY_REFUSED/);
  assert.throws(() => assembleTaskBudgetPages([{ ...base, nextCursor: 'page-2' }]), /TASK_BUDGET_PAGE_CHAIN_REFUSED/);
  assert.throws(() => assembleTaskBudgetPages([{ ...base, cursor: 'page-2' }]), /TASK_BUDGET_PAGE_CHAIN_REFUSED/);
  assert.throws(() => assembleTaskBudgetPages([{ ...base, nextCursor: 'page-2' }, { ...base, cursor: 'page-2', revision: '2' }]), /TASK_BUDGET_PAGE_CHAIN_REFUSED/);
  assert.throws(() => assembleTaskBudgetPages([{ ...base, nextCursor: 'page-2' }, { ...base, cursor: 'page-2' }]), /TASK_DUPLICATE_OPERATION_REFUSED/);
});
test('the pure contract exports no signer, transaction sender, key constructor or authority issuer', async () => {
  const module = await import('../src/agent/taskContract.ts');
  for (const name of Object.keys(module)) assert.doesNotMatch(name, /^(sendTransaction|sign|execute|issueAuthorization|createKey)$/);
  const { task, child } = exact(); assert.equal(executionAvailability(task, child, ref(task), now).executable, false);
});
test('shared server/browser vectors fix the v1 normalized digests', () => {
  const vectors = JSON.parse(readFileSync(new URL('./fixtures/agent-task-contract-v1.json', import.meta.url), 'utf8'));
  assert.equal(vectors.schema, '8415-task-contract-vectors/1');
  for (const v of vectors.vectors) {
    assert.equal(freezeTaskPolicy(v.policy).digest, v.taskDigest);
    assert.equal(freezeChildOperation(v.child).digest, v.childDigest);
    assert.equal(v.child.taskDigest, v.taskDigest);
  }
});
test('custom collection iterators and sparse/getter collections cannot execute through normalization', () => {
  let called = false;
  const adapters = ['existing-market'];
  Object.defineProperty(adapters, Symbol.iterator, { value() { called = true; throw Error('side effect'); } });
  assert.throws(() => freezeTaskPolicy({ ...saleInput(), intent: { ...saleInput().intent, marketAdapters: adapters } }), /TASK_ARRAY_REFUSED/);
  assert.equal(called, false);
  assert.throws(() => freezeTaskPolicy({ ...saleInput(), intent: { ...saleInput().intent, marketAdapters: Array(1) } }), /TASK_ARRAY_REFUSED/);
  assert.throws(() => freezeTaskPolicy({ ...saleInput(), tenant: 'Xiongan:admin' }), /TASK_TENANT_REFUSED/);
});
