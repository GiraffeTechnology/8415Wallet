import test from 'node:test';
import assert from 'node:assert/strict';
import { FORWARD_FIELDS, forwardConsentDigest, forwardTypedData, validateForwardConsent,
  type ForwardConsent } from '../src/controls/authorization.ts';
import { parseFixedSubmission, serializeFixedSubmission, type FixedSubmission } from '../src/controls/execution.ts';
const a = (n: string) => `0x${n.repeat(40)}`;
const h = (n: string) => `0x${n.repeat(64)}`;
const pin = { chainId: 560048n, controller: a('1'), runtimeCodeHash: h('2') };
const consent: ForwardConsent = { sequenceId: h('1'), expectedRevision: 0n, legId: h('2'), token: a('3'), tokenId: 1n,
  fromAccount: a('4'), toAccount: a('5'), termsHash: h('3'), inheritedHash: h('4'), returnAuthority: a('6'),
  returnConditionHash: h('5'), evidenceAuthority: a('7'), deadline: 999999n, recipientNonce: 0n,
  paymentAdapter: a('0'), paymentAmount: 0n };
test('consent requires explicit zero/zero or nonzero/positive payment profile', () => {
  validateForwardConsent(consent);
  validateForwardConsent({ ...consent, paymentAdapter: a('8'), paymentAmount: 1000n });
  for (const c of [{ ...consent, paymentAmount: 1n }, { ...consent, paymentAdapter: a('8') },
    { ...consent, paymentAmount: -1n }, { ...consent, paymentAdapter: 'invalid' }]) assert.throws(() => validateForwardConsent(c));
});
test('old consent cannot silently opt out; every new payment field is EIP712-bound', () => {
  const { paymentAdapter, paymentAmount, ...old } = consent;
  assert.throws(() => validateForwardConsent(old as ForwardConsent), /CONTROL_CONSENT_SCHEMA_REFUSED/);
  assert.equal(FORWARD_FIELDS.length, 16);
  const paid = { ...consent, paymentAdapter: a('8'), paymentAmount: 1000n };
  const variants = [consent, paid, { ...paid, paymentAdapter: a('9') }, { ...paid, paymentAmount: 1001n }];
  assert.equal(new Set(variants.map(c => forwardConsentDigest(pin, c))).size, variants.length);
  assert.equal(forwardTypedData(pin, paid).message.paymentAmount, '1000');
});
test('reservation receipt journals retain only public binding and restore both new fixed event types', () => {
  for (const signature of ['Reserved(bytes32,bytes32,address,address,uint256)', 'ReservationCancelled(bytes32,bytes32,address,uint256)']) {
    const r: FixedSubmission = { schema: '8415-fixed-submission/1', pin, guards: [pin], actor: a('5'), value: 1000n,
      nonce: 2n, transactionHash: h('8'), calldataHash: h('9'), event: { address: a('8'), signature,
        indexed: [h('1'), h('2'), h('5')], dataHash: h('6') } };
    const serialized = serializeFixedSubmission({ ...r, consent } as FixedSubmission);
    assert.equal(serialized.includes('paymentAmount'), false);
    assert.deepEqual(parseFixedSubmission(serialized), r);
  }
});
