// Adapted educational fixture, prepared for 8415Wallet on 2026-10-11.
// Models a bounded local dataset; no RPC, identity check or atomic snapshot.
// Reports cross-token reuse only. It never labels registryReference reuse illegal.
// Source attribution and applicable notices: README.md and notices/.
import test from 'node:test';
import assert from 'node:assert/strict';

function scanFixture(tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0 || tokens.length > 32) {
    throw new RangeError('token budget');
  }
  const ids = tokens.map(({ tokenId }) => tokenId);
  if (new Set(ids).size !== ids.length) throw new RangeError('duplicate token');
  const entriesExamined = tokens.reduce((sum, token) => sum + token.entries.length, 0);
  if (entriesExamined > 2048) throw new RangeError('entry budget');

  const findings = [];
  for (const kind of ['recordCommitment', 'registryReference']) {
    const occurrences = new Map();
    for (const { tokenId, entries } of tokens) {
      for (const [index, entry] of entries.entries()) {
        const found = occurrences.get(entry[kind]) ?? [];
        found.push({ tokenId, version: index + 1 });
        occurrences.set(entry[kind], found);
      }
    }
    for (const [value, seen] of occurrences) {
      if (new Set(seen.map(({ tokenId }) => tokenId)).size > 1) {
        findings.push({ kind, value, occurrences: seen });
      }
    }
  }
  return { tokensExamined: ids, entriesExamined, findings };
}

// Human-readable fixture labels are not encoded on-chain bytes32 values.
const tokenA = { tokenId: 1, entries: [{ recordCommitment: 'c1', registryReference: 'r1' }] };
const tokenB = { tokenId: 2, entries: [{ recordCommitment: 'c1', registryReference: 'r1' }] };

test('reuse is observable only when both tokens are in the chosen dataset', () => {
  assert.deepEqual(scanFixture([tokenA]).findings, []);
  const result = scanFixture([tokenA, tokenB]);
  assert.deepEqual(result.tokensExamined, [1, 2]);
  assert.equal(result.entriesExamined, 2);
  assert.deepEqual(result.findings.map(({ kind }) => kind), ['recordCommitment', 'registryReference']);
});

test('a repeated registry reference is a fact without a protocol-violation verdict', () => {
  const differentCommitment = { tokenId: 2, entries: [{ recordCommitment: 'c2', registryReference: 'r1' }] };
  assert.deepEqual(scanFixture([tokenA, differentCommitment]).findings, [{
    kind: 'registryReference', value: 'r1',
    occurrences: [{ tokenId: 1, version: 1 }, { tokenId: 2, version: 1 }],
  }]);
  assert.deepEqual(scanFixture([{
    tokenId: 1, entries: [...tokenA.entries, ...differentCommitment.entries],
  }]).findings, []);
});

test('fixture token scope and work budgets are explicit and bounded', () => {
  const tokens = Array.from({ length: 32 }, (_, tokenId) => ({ tokenId, entries: tokenA.entries }));
  assert.equal(scanFixture(tokens).tokensExamined.length, 32);
  assert.throws(() => scanFixture([...tokens, { tokenId: 32, entries: [] }]), /token budget/);
  assert.throws(() => scanFixture([tokenA, tokenA]), /duplicate token/);
  const entries = Array.from({ length: 2048 }, (_, index) => ({
    recordCommitment: `c${index}`, registryReference: `r${index}`,
  }));
  assert.equal(scanFixture([{ tokenId: 1, entries }]).entriesExamined, 2048);
  assert.throws(() => scanFixture([{ tokenId: 1, entries: [...entries, entries[0]] }]), /entry budget/);
});
