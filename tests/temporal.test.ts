import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  ALICE,
  CAROL,
  T,
  TOKEN,
  confirmingEntryToken,
  divergentToken,
} from '../src/adapters/memory/scenarios.ts';
import { ContractRevertError } from '../src/sdk/errors.ts';

/**
 * Resolution and finality are different questions. An instant always resolves;
 * whether the answer can still change is what `isFinalAsOf` answers, and
 * `entryAsOf` returns an answer either way.
 */

describe('entryAsOf resolves every covered instant', () => {
  test('returns the covering entry inside an interval', async () => {
    const { reader } = divergentToken();
    const entry = await reader.entryAsOf(TOKEN, T.finalInstant);
    assert.equal(entry.version, 2n);
    assert.equal(entry.holder, CAROL);
  });

  test('returns the entry at the exact start of its interval', async () => {
    const { reader } = divergentToken();
    assert.equal((await reader.entryAsOf(TOKEN, T.v2)).version, 2n);
    assert.equal((await reader.entryAsOf(TOKEN, T.v3)).version, 3n);
  });

  test('returns the latest entry for instants after it', async () => {
    const { reader } = divergentToken();
    const entry = await reader.entryAsOf(TOKEN, T.later);
    assert.equal(entry.version, 3n);
    assert.equal(entry.supersededAt, 0n);
  });

  test('holderAsOf agrees with entryAsOf for the same instant', async () => {
    const { reader } = divergentToken();
    for (const instant of [T.v1, T.earlyOctober, T.v2, T.finalInstant, T.asOf, T.later]) {
      assert.equal(
        await reader.holderAsOf(TOKEN, instant),
        (await reader.entryAsOf(TOKEN, instant)).holder,
        `holderAsOf and entryAsOf disagree at ${instant}`,
      );
    }
  });
});

describe('an instant before the first entry', () => {
  test('makes entryAsOf and holderAsOf revert', async () => {
    const { reader } = divergentToken();
    await assert.rejects(
      () => reader.entryAsOf(TOKEN, T.beforeFirstEntry),
      ContractRevertError,
    );
    await assert.rejects(
      () => reader.holderAsOf(TOKEN, T.beforeFirstEntry),
      ContractRevertError,
    );
  });

  test('does not make isFinalAsOf revert; it answers false', async () => {
    const { reader } = divergentToken();
    assert.equal(await reader.isFinalAsOf(TOKEN, T.beforeFirstEntry), false);
  });
});

describe('the finality rule', () => {
  test('is true strictly before the latest entry and at or after the first', async () => {
    const { reader } = divergentToken();
    assert.equal(await reader.isFinalAsOf(TOKEN, T.v1), true);
    assert.equal(await reader.isFinalAsOf(TOKEN, T.finalInstant), true);
    assert.equal(await reader.isFinalAsOf(TOKEN, T.v3 - 1n), true);
  });

  test('is false at and after the latest entry', async () => {
    const { reader } = divergentToken();
    assert.equal(await reader.isFinalAsOf(TOKEN, T.v3), false);
    assert.equal(await reader.isFinalAsOf(TOKEN, T.asOf), false);
    assert.equal(await reader.isFinalAsOf(TOKEN, T.later), false);
  });

  test('a final instant keeps its holder across a further admission', async () => {
    const { contract, reader } = divergentToken();
    const before = await reader.holderAsOf(TOKEN, T.finalInstant);
    assert.equal(await reader.isFinalAsOf(TOKEN, T.finalInstant), true);

    contract.finalizeSettlement(await reader.openGapOf(TOKEN), {
      recordCommitment: `0x${'d'.repeat(64)}`,
      registryReference: `0x${'fd'.repeat(32)}`,
      effectiveAt: T.asOf + 1n,
      proofData: '0x',
    });

    assert.equal(await reader.holderAsOf(TOKEN, T.finalInstant), before);
    assert.equal(await reader.isFinalAsOf(TOKEN, T.finalInstant), true);
  });

  test('nothing is final while a token has only one entry', async () => {
    const { contract, reader } = confirmingEntryToken();
    assert.equal(await reader.entryCount(TOKEN), 2n);

    // With one entry the first and the latest coincide, so the interval the
    // rule describes is empty until a later entry closes it.
    const single = contract.entryAt(TOKEN, 1n);
    assert.equal(single.effectiveAt, T.v1);
    assert.equal(await reader.isFinalAsOf(TOKEN, T.v1 - 1n), false);
  });

  test('a confirming entry makes the preceding instants final', async () => {
    const { reader } = confirmingEntryToken();
    // Both entries name the same holder; the later one is not a no-op, it is
    // the register saying "still this holder, as of here".
    assert.equal(await reader.holderAsOf(TOKEN, T.finalInstant), ALICE);
    assert.equal((await reader.entryAt(TOKEN, 2n)).holder, ALICE);
    assert.equal(await reader.isFinalAsOf(TOKEN, T.finalInstant), true);
    assert.equal(await reader.isFinalAsOf(TOKEN, T.v3), false);
  });

  test('the present is never final', async () => {
    const { contract, reader } = divergentToken();
    assert.equal(await reader.isFinalAsOf(TOKEN, contract.now), false);
  });
});
