import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewAgentRequest } from '../src/xiongan/agentRequest.ts';
import { recoveryGuidance } from '../src/xiongan/recoveryView.ts';
import type { OperationState } from '../src/controls/operationJournal.ts';
const actor = `0x${'1'.repeat(40)}`, controller = { chainId: 11155111n, controller: `0x${'2'.repeat(40)}`, runtimeCodeHash: `0x${'3'.repeat(64)}` };
const context = { actor, controller, token: { ...controller, controller: `0x${'4'.repeat(40)}` }, now: 1000n };
const request = { schema: 'xiongan-agent-request/1', requestId: 'agent-1', agent: 'Xiongan', chainId: '11155111', actor,
  controller: controller.controller, expiresAt: '1500', operation: { kind: 'create-account' } };
test('agent request is immutable, exact-context bound and has no execution capability', () => {
  const r = reviewAgentRequest(JSON.stringify(request), context);
  assert.equal(r.authorization, 'owner-review-required'); assert.equal(r.claimedAgent, 'Xiongan'); assert.ok(Object.isFrozen(r.operation));
  assert.throws(() => reviewAgentRequest(JSON.stringify(request), { ...context, actor: context.token.controller }));
  assert.throws(() => reviewAgentRequest(JSON.stringify(request), { ...context, now: 1500n }));
});
test('agent request refuses mainnet, hidden fields, signatures and unbounded calls', () => {
  for (const r of [{ ...request, chainId: '1' }, { ...request, secret: 'no' }, { ...request, expiresAt: '1901' },
    { ...request, operation: { kind: 'forward', recipientSignature: 'no' } }, { ...request, operation: { kind: 'create-account', data: '0x1234' } }])
    assert.throws(() => reviewAgentRequest(JSON.stringify(r), context));
});
test('agent deposit and withdrawal bind the loaded token pin and exact destination', () => {
  const r = reviewAgentRequest(JSON.stringify({ ...request, operation: { kind: 'standalone-withdraw', tokenId: '7', destination: actor } }), context);
  assert.equal(r.operation.kind, 'standalone-withdraw'); assert.equal('token' in r.operation && r.operation.token.controller, context.token.controller);
});
test('unknown-outcome guidance never treats missing hash or unchanged nonce as cancellation', () => {
  const state = { status: 'outcome-unknown', submission: {} } as OperationState;
  assert.match(recoveryGuidance(state), /unchanged nonce or a missing hash does not prove cancellation/);
  assert.match(recoveryGuidance({ status: 'outcome-unknown', submission: null } as OperationState), /unprepared intent/);
  assert.match(recoveryGuidance({ status: 'submitted' } as OperationState), /hash alone is not success/);
});

test('agent withdrawal validates ERC-55 destinations before lowercasing', () => {
  const valid = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
  const review = (destination: unknown) => reviewAgentRequest(JSON.stringify({ ...request,
    operation: { kind: 'standalone-withdraw', tokenId: '7', destination } }), context);
  for (const destination of [valid, valid.toLowerCase(), `0x${valid.slice(2).toUpperCase()}`]) {
    const result = review(destination);
    assert.equal(result.operation.kind === 'standalone-withdraw' && result.operation.destination, valid.toLowerCase());
  }
  for (const invalid of [valid.slice(0, -1) + 'c', valid.replace('aA', 'AA'), `0x${'0'.repeat(40)}`, '0x1234', null])
    assert.throws(() => review(invalid), /AGENT_REQUEST_ADDRESS_REFUSED/);
});
test('agent JSON actor/controller checksums are checked, while provider context stays byte-oriented', () => {
  const valid = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', bad = valid.replace('aA', 'AA');
  const bound = { ...context, actor: bad, controller: { ...controller, controller: bad } };
  const payload = { ...request, actor: valid, controller: valid };
  assert.equal(reviewAgentRequest(JSON.stringify(payload), bound).actor, valid.toLowerCase());
  for (const field of ['actor', 'controller'])
    assert.throws(() => reviewAgentRequest(JSON.stringify({ ...payload, [field]: bad }), bound), /AGENT_REQUEST_ADDRESS_REFUSED/);
});
