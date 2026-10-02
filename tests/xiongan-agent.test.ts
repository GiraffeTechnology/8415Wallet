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
