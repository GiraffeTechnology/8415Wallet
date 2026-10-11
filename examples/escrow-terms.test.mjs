// Independently written educational decision model, 8415Wallet, 2026-10-11.
// This is not an extraction, port or test of a wallet or Solidity contract.
// It accepts synthetic policy facts; it verifies no record and moves no assets.
// Applicable example-code permission: ../LICENSE, Section 4.
import test from 'node:test';
import assert from 'node:assert/strict';

function decideCustodyOutcome({ phase, at, cutoff, observationAvailable, acceptedConditions }) {
  if (phase !== 'held') return 'closed';
  if (!observationAvailable) return 'wait';
  const termsMet = ['recipientMatches', 'newRecordObserved', 'dateWithinTerms']
    .every((condition) => acceptedConditions?.[condition] === true);
  if (termsMet) return 'release';
  return at > cutoff ? 'return' : 'wait';
}

// Only these three already-agreed conditions are evaluated by this fixture.
// A production adapter would have to establish the facts and enforce custody.
const agreed = {
  recipientMatches: true, newRecordObserved: true, dateWithinTerms: true,
};
const observation = {
  phase: 'held', at: 95n, cutoff: 100n, observationAvailable: true,
  acceptedConditions: agreed,
};

test('an accepted admission policy can release without requiring temporal finality', () => {
  assert.equal(decideCustodyOutcome({ ...observation, historyFinal: false }), 'release');
});

test('a recipient, new-record or effective-date condition must not be skipped', () => {
  for (const condition of Object.keys(agreed)) {
    assert.equal(decideCustodyOutcome({
      ...observation, acceptedConditions: { ...agreed, [condition]: false },
    }), 'wait');
    const incomplete = { ...agreed };
    delete incomplete[condition];
    assert.equal(decideCustodyOutcome({ ...observation, acceptedConditions: incomplete }), 'wait');
  }
});

test('return waits until strictly after the agreed deadline', () => {
  const unmet = { ...observation, acceptedConditions: { ...agreed, recipientMatches: false } };
  for (const at of [99n, 100n]) assert.equal(decideCustodyOutcome({ ...unmet, at }), 'wait');
  assert.equal(decideCustodyOutcome({ ...unmet, at: 101n }), 'return');
});

test('terms satisfied when evaluated take precedence over the elapsed deadline', () => {
  assert.equal(decideCustodyOutcome({ ...observation, at: 101n }), 'release');
});

test('a cancelled, open or absent gap alone does not decide the outcome', () => {
  for (const gap of ['cancelled', 'open', 'absent']) {
    assert.equal(decideCustodyOutcome({ ...observation, gap }), 'release');
  }
});

test('this illustrative policy waits when the required observation is unavailable', () => {
  assert.equal(decideCustodyOutcome({
    ...observation, at: 101n, observationAvailable: false,
  }), 'wait');
});

test('a closed custody arrangement cannot act again', () => {
  for (const phase of ['paid-out', 'returned']) {
    assert.equal(decideCustodyOutcome({ ...observation, phase }), 'closed');
  }
});
