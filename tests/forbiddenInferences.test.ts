import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  ALICE,
  CANCELLED_GAP_ID,
  DAVE,
  ERIN,
  FRANK,
  OPEN_GAP_ID,
  REGISTRAR,
  T,
  TOKEN,
  cancelledGapToken,
  commitment,
  divergentToken,
  projectionOnlyToken,
} from '../src/adapters/memory/scenarios.ts';
import { detectConformance, requireSettlementConformance } from '../src/sdk/conformance.ts';
import { ContractRevertError, NonConformantContractError } from '../src/sdk/errors.ts';
import { ZERO_BYTES32 } from '../src/sdk/types.ts';

/**
 * The negative cases AGENTS.md requires.
 *
 * Each one asserts that a forbidden inference is actually false in a situation
 * a user will meet, so a future change that starts making the inference fails
 * here rather than in front of someone deciding what they hold.
 */

describe('current owner is not the historical holder', () => {
  test('ownerOf and the confirmed holder diverge, and both are readable', async () => {
    const { reader } = divergentToken();

    // The position has moved to Dave; the register still confirms Alice.
    assert.equal(await reader.ownerOf(TOKEN), DAVE);
    assert.equal((await reader.currentEntry(TOKEN)).holder, ALICE);
    assert.equal(await reader.holderAsOf(TOKEN, T.asOf), ALICE);
    assert.notEqual(await reader.ownerOf(TOKEN), await reader.holderAsOf(TOKEN, T.asOf));
  });

  test('the owner is not the confirmed holder at any instant of this projection', async () => {
    const { reader } = divergentToken();
    const owner = await reader.ownerOf(TOKEN);
    for (const instant of [T.v1, T.v2, T.finalInstant, T.v3, T.asOf]) {
      assert.notEqual(
        await reader.holderAsOf(TOKEN, instant),
        owner,
        `ownerOf leaked into the projection at ${instant}`,
      );
    }
  });

  test('divergence does not make the projection unreadable', async () => {
    // Divergence is the design, not a fault: the token trades while the
    // register catches up, and both answers stay available throughout.
    const { reader } = divergentToken();
    assert.equal(await reader.entryCount(TOKEN), 3n);
    assert.equal(await reader.isFinalAsOf(TOKEN, T.finalInstant), true);
  });
});

describe('gap closure is not finality', () => {
  test('a cancelled gap leaves later instants non-final', async () => {
    const { reader } = cancelledGapToken();

    assert.equal((await reader.settlement(CANCELLED_GAP_ID)).status, 'CANCELLED');
    assert.equal(await reader.openGapOf(TOKEN), ZERO_BYTES32, 'the gap is closed');

    // Closed gap, and yet: instants at or after the latest entry are still
    // provisional. Nothing settled.
    assert.equal(await reader.isFinalAsOf(TOKEN, T.v2), false);
    assert.equal(await reader.isFinalAsOf(TOKEN, T.asOf), false);
  });

  test('cancellation leaves the holder confirmed before the gap opened', async () => {
    const { reader } = cancelledGapToken();
    assert.equal(await reader.holderAsOf(TOKEN, T.asOf), FRANK);
    assert.equal((await reader.currentEntry(TOKEN)).version, 2n);
    assert.equal(await reader.holderAsOf(TOKEN, T.v1), ERIN);
  });

  test('cancellation is not a rejection event', async () => {
    // The protocol defines no rejection. A cancelled settlement is a gap
    // transition that admitted nothing; the entry it would have superseded
    // remains in force and is not marked in any way.
    const { reader } = cancelledGapToken();
    const latest = await reader.currentEntry(TOKEN);
    assert.equal(latest.supersededAt, 0n);
    assert.equal(latest.holder, FRANK);

    const statuses = new Set(['NONE', 'OPEN', 'ADMITTED', 'CANCELLED', 'SUPERSEDED']);
    assert.ok(statuses.has((await reader.settlement(CANCELLED_GAP_ID)).status));
  });

  test('an open gap does not make an instant final either', async () => {
    const { reader } = divergentToken();
    assert.notEqual(await reader.openGapOf(TOKEN), ZERO_BYTES32);
    assert.equal(await reader.isFinalAsOf(TOKEN, T.asOf), false);

    // And finality does not depend on the gap: an earlier instant is final
    // while the very same gap is open.
    assert.equal(await reader.isFinalAsOf(TOKEN, T.finalInstant), true);
  });

  test('closing a gap by admission settles only what the rule says', async () => {
    const { contract, reader } = divergentToken();
    contract.finalizeSettlement(OPEN_GAP_ID, {
      recordCommitment: commitment('d'),
      registryReference: `0x${'fd'.repeat(32)}`,
      effectiveAt: T.asOf + 1n,
      proofData: '0x',
    });

    // The admission made instants before the new entry final — and not one
    // instant more.
    assert.equal(await reader.isFinalAsOf(TOKEN, T.asOf), true);
    assert.equal(await reader.isFinalAsOf(TOKEN, T.asOf + 1n), false);
    assert.equal(await reader.isFinalAsOf(TOKEN, T.later), false);
  });
});

describe('confirmation depth is not finality', () => {
  test('a long-settled chain state says nothing about a provisional instant', async () => {
    const { contract, reader } = divergentToken();

    // Advance the chain a long way past everything. Nothing about the
    // projection's finality moves, because finality is a property of the
    // entry ordering, not of block age.
    contract.advanceTo(T.later + 10n * 365n * 24n * 60n * 60n);
    assert.equal(await reader.isFinalAsOf(TOKEN, T.asOf), false);
    assert.equal(await reader.isFinalAsOf(TOKEN, contract.now), false);
  });
});

describe('an instant before the first entry', () => {
  test('is not final, and is not an error', async () => {
    const { reader } = divergentToken();
    assert.equal(await reader.isFinalAsOf(TOKEN, T.beforeFirstEntry), false);
    await assert.rejects(() => reader.holderAsOf(TOKEN, T.beforeFirstEntry), ContractRevertError);
  });

  test('the cause is established from entry v1, not from a revert string', async () => {
    const { reader } = divergentToken();
    const first = await reader.entryAt(TOKEN, 1n);
    assert.ok(T.beforeFirstEntry < first.effectiveAt);
    assert.ok(T.v1 >= first.effectiveAt);
  });
});

describe('a contract without the settlement interface', () => {
  test('has no gaps, as a property of the contract', async () => {
    const { reader } = projectionOnlyToken();
    const conformance = await detectConformance(reader);

    assert.equal(conformance.projection, true);
    assert.equal(conformance.settlement, false);

    // Not "no gap is open" — there is no gap interface to ask.
    assert.throws(
      () => requireSettlementConformance(reader, conformance),
      NonConformantContractError,
    );
    await assert.rejects(() => reader.openGapOf(TOKEN), ContractRevertError);
  });

  test('still answers the projection and the finality rule', async () => {
    const { reader } = projectionOnlyToken();
    assert.equal(await reader.holderAsOf(TOKEN, T.finalInstant), ALICE);
    assert.equal(await reader.isFinalAsOf(TOKEN, T.finalInstant), true);
    assert.equal(await reader.isFinalAsOf(TOKEN, T.asOf), false);
  });
});

describe('the authority that can move the answer', () => {
  test('can hold a gap open indefinitely by superseding', async () => {
    const { contract, reader } = divergentToken();

    // Nothing is misreported while this happens — the projection states
    // exactly that the answer is unsettled — but it stops tracking.
    for (let round = 0; round < 3; round += 1) {
      contract.advanceTo(contract.now + 60n);
      contract.beginSettlement(
        REGISTRAR,
        TOKEN,
        commitment(`${round + 1}`),
        DAVE,
        commitment('5'),
        contract.now + 600n,
      );
    }

    assert.equal(await reader.entryCount(TOKEN), 3n, 'the projection never moved');
    assert.equal(await reader.isFinalAsOf(TOKEN, T.asOf), false);
    assert.notEqual(await reader.openGapOf(TOKEN), ZERO_BYTES32);
  });
});
