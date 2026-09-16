import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { MemoryRegisterContract } from '../src/adapters/memory/register.ts';
import { ALICE, CAROL, REGISTRAR, T, TOKEN, commitment } from '../src/adapters/memory/scenarios.ts';
import { ContractRevertError, InvariantViolationError } from '../src/sdk/errors.ts';
import { ZERO_BYTES32 } from '../src/sdk/types.ts';

/**
 * The four projection invariants, which are what make an instant resolve to
 * exactly one holder. An implementation that relaxes any of them does not
 * conform, so the wallet's model is held to them too.
 */

function contractWithOneEntry(): MemoryRegisterContract {
  const contract = new MemoryRegisterContract({ now: T.beforeFirstEntry });
  contract.mint(TOKEN, ALICE);
  contract.grantSettlementAuthority(TOKEN, REGISTRAR);
  contract.seedEntries(TOKEN, [{ holder: ALICE, effectiveAt: T.v1, seed: 'a' }]);
  return contract;
}

describe('invariant 1 — the first entry', () => {
  test('is version 1 with a zero previous commitment', () => {
    const contract = contractWithOneEntry();
    const first = contract.entryAt(TOKEN, 1n);
    assert.equal(first.version, 1n);
    assert.equal(first.previousCommitment, ZERO_BYTES32);
  });
});

describe('invariant 2 — append and link', () => {
  test('each entry appends version n+1 and links the prior commitment', () => {
    const contract = contractWithOneEntry();
    contract.seedEntries(TOKEN, [{ holder: CAROL, effectiveAt: T.v2, seed: 'b' }]);

    const second = contract.entryAt(TOKEN, 2n);
    assert.equal(second.version, 2n);
    assert.equal(second.previousCommitment, commitment('a'));
    assert.equal(second.supersededAt, 0n);
  });

  test("closes the prior entry's interval at the new entry's effectiveAt", () => {
    const contract = contractWithOneEntry();
    contract.seedEntries(TOKEN, [{ holder: CAROL, effectiveAt: T.v2, seed: 'b' }]);

    // Closed by the register's effective time, not by when the chain learned
    // of it: the contract's clock is far from T.v2 here.
    assert.equal(contract.entryAt(TOKEN, 1n).supersededAt, T.v2);
    assert.notEqual(contract.now, T.v2);
  });
});

describe('invariant 3 — strictly increasing effective times', () => {
  test('rejects an entry whose effectiveAt equals the preceding one', () => {
    const contract = contractWithOneEntry();
    assert.throws(
      () => contract.seedEntries(TOKEN, [{ holder: CAROL, effectiveAt: T.v1, seed: 'b' }]),
      InvariantViolationError,
      'an instant shared by two entries would have two answers',
    );
  });

  test('rejects an entry whose effectiveAt precedes the latest', () => {
    const contract = contractWithOneEntry();
    contract.seedEntries(TOKEN, [{ holder: CAROL, effectiveAt: T.v3, seed: 'b' }]);
    assert.throws(
      () => contract.seedEntries(TOKEN, [{ holder: ALICE, effectiveAt: T.v2, seed: 'c' }]),
      InvariantViolationError,
    );
  });

  test('leaves the projection untouched when it rejects', () => {
    const contract = contractWithOneEntry();
    assert.throws(() =>
      contract.seedEntries(TOKEN, [{ holder: CAROL, effectiveAt: T.v1, seed: 'b' }]),
    );
    assert.equal(contract.entryCount(TOKEN), 1n);
    assert.equal(contract.entryAt(TOKEN, 1n).supersededAt, 0n);
  });
});

describe('invariant 4 — commitment uniqueness within a token', () => {
  test('rejects a repeated record commitment', () => {
    const contract = contractWithOneEntry();
    assert.throws(
      () => contract.seedEntries(TOKEN, [{ holder: CAROL, effectiveAt: T.v2, seed: 'a' }]),
      InvariantViolationError,
      'two entries that cannot be told apart cannot be resolved',
    );
  });

  test('rejects a zero commitment', () => {
    const contract = new MemoryRegisterContract({ now: T.beforeFirstEntry });
    contract.mint(TOKEN, ALICE);
    assert.throws(
      () => contract.seedEntries(TOKEN, [{ holder: ALICE, effectiveAt: T.v1, seed: '0' }]),
      InvariantViolationError,
    );
  });

  test('allows the same commitment on a different token', () => {
    const contract = contractWithOneEntry();
    contract.mint(5678n, CAROL);
    contract.seedEntries(5678n, [{ holder: CAROL, effectiveAt: T.v1, seed: 'a' }]);
    assert.equal(contract.entryAt(5678n, 1n).recordCommitment, commitment('a'));
  });
});

describe('entries are never overwritten, deleted, reordered or skipped', () => {
  test('queries for a nonexistent token or version revert', () => {
    const contract = contractWithOneEntry();
    assert.throws(() => contract.entryAt(TOKEN, 2n), ContractRevertError);
    assert.throws(() => contract.entryAt(TOKEN, 0n), ContractRevertError);
    assert.throws(() => contract.currentEntry(9999n), ContractRevertError);
  });

  test('a profile bound rejects an effectiveAt too far ahead of the clock', () => {
    // Unbounded, an admitted far-future effective time permanently ends the
    // projection for that token: no later entry could ever exceed it.
    const bounded = new MemoryRegisterContract({
      now: T.v1,
      maxEffectiveAtDrift: 24n * 60n * 60n,
    });
    bounded.mint(TOKEN, ALICE);
    assert.throws(
      () => bounded.seedEntries(TOKEN, [{ holder: ALICE, effectiveAt: T.later, seed: 'a' }]),
      InvariantViolationError,
    );
  });
});
