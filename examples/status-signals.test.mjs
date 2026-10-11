// Adapted educational fixture, prepared for 8415Wallet on 2026-10-11.
// This tests the model below, not the source wallet or an RPC provider.
// Source attribution and applicable notices: README.md and notices/.
import test from 'node:test';
import assert from 'node:assert/strict';

const freshnessLabels = {
  UNKNOWN: 'unknown', STALE: 'stale',
  FRESH_PENDING: 'fresh-reorg-exposed', FRESH_FINAL: 'reorg-safe',
};

function showSignals({ owner, holder, isFinalAsOf, gapOpenedAt, instant, freshness }) {
  // isFinalAsOf is a supplied contract answer, never derived from the other fields.
  return {
    positionOwner: owner,
    confirmedHolder: holder,
    finality: isFinalAsOf ? 'final' : 'provisional',
    contested: gapOpenedAt !== null && gapOpenedAt <= instant,
    freshness: freshnessLabels[freshness],
    registration: gapOpenedAt === null ? 'no-open-gap' : 'registration-pending',
  };
}

const observation = {
  owner: 'holder-C', holder: 'holder-A', instant: 200n,
  isFinalAsOf: false, gapOpenedAt: 180n, freshness: 'FRESH_FINAL',
};

test('reorg-safe attestation leaves a provisional projection provisional', () => {
  const shown = showSignals(observation);
  assert.equal(shown.freshness, 'reorg-safe');
  assert.equal(shown.finality, 'provisional');
  assert.equal(shown.registration, 'registration-pending');
  assert.notEqual(shown.positionOwner, shown.confirmedHolder);
});

test('stale attestation does not revoke a final historical answer', () => {
  const shown = showSignals({ ...observation, isFinalAsOf: true, freshness: 'STALE' });
  assert.equal(shown.freshness, 'stale');
  assert.equal(shown.finality, 'final');
});

test('a gap affects contest from openedAt without setting temporal finality', () => {
  for (const isFinalAsOf of [false, true]) {
    for (const [gapOpenedAt, contested] of [[null, false], [201n, false], [200n, true]]) {
      const shown = showSignals({ ...observation, isFinalAsOf, gapOpenedAt });
      assert.equal(shown.contested, contested);
      assert.equal(shown.finality, isFinalAsOf ? 'final' : 'provisional');
    }
  }
});

test('owner agreement or gap closure does not manufacture a final answer', () => {
  const shown = showSignals({ ...observation, owner: 'holder-A', gapOpenedAt: null });
  assert.equal(shown.positionOwner, shown.confirmedHolder);
  assert.equal(shown.finality, 'provisional');
  assert.equal(shown.registration, 'no-open-gap');
});
