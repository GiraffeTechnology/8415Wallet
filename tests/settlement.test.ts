import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { MemoryRegisterContract } from '../src/adapters/memory/register.ts';
import {
  ALICE,
  CANCELLED_GAP_ID,
  CAROL,
  DAVE,
  OPEN_GAP_ID,
  REGISTRAR,
  STRANGER,
  T,
  TOKEN,
  cancelledGapToken,
  commitment,
  divergentToken,
  settlementId,
} from '../src/adapters/memory/scenarios.ts';
import { ContractRevertError } from '../src/sdk/errors.ts';
import { ZERO_BYTES32 } from '../src/sdk/types.ts';

describe('trading is not blocked', () => {
  test('an ordinary transfer succeeds while a gap is open', async () => {
    const { contract, reader } = divergentToken();
    assert.notEqual(await reader.openGapOf(TOKEN), ZERO_BYTES32);

    contract.transfer(TOKEN, STRANGER);
    assert.equal(await reader.ownerOf(TOKEN), STRANGER);
  });

  test('a transfer does not change the projection', async () => {
    const { contract, reader } = divergentToken();
    const before = await reader.currentEntry(TOKEN);
    const holderBefore = await reader.holderAsOf(TOKEN, T.asOf);

    contract.transfer(TOKEN, STRANGER);

    assert.deepEqual(await reader.currentEntry(TOKEN), before);
    assert.equal(await reader.holderAsOf(TOKEN, T.asOf), holderBefore);
    assert.equal(await reader.entryCount(TOKEN), 3n);
  });
});

describe('settlement authority', () => {
  test('is not satisfied by ownerOf', async () => {
    const { contract, reader } = divergentToken();
    const owner = await reader.ownerOf(TOKEN);
    assert.equal(await reader.isSettlementAuthority(TOKEN, owner), false);
    assert.equal(await reader.isSettlementAuthority(TOKEN, REGISTRAR), true);

    assert.throws(
      () =>
        contract.beginSettlement(
          owner,
          TOKEN,
          settlementId('z'),
          owner,
          commitment('5'),
          contract.now + 60n,
        ),
      ContractRevertError,
    );
  });

  test('transferring the token does not confer the authority', async () => {
    const { contract, reader } = divergentToken();
    contract.transfer(TOKEN, STRANGER);
    assert.equal(await reader.isSettlementAuthority(TOKEN, STRANGER), false);
  });

  test('reverts for a nonexistent token', async () => {
    const { reader } = divergentToken();
    await assert.rejects(() => reader.isSettlementAuthority(9999n, REGISTRAR), ContractRevertError);
  });
});

describe('gap lifecycle', () => {
  test('openGapOf returns zero when no gap is open', async () => {
    const { reader } = cancelledGapToken();
    assert.equal(await reader.openGapOf(TOKEN), ZERO_BYTES32);
  });

  test('settlement reverts for an unknown identifier', async () => {
    const { reader } = divergentToken();
    await assert.rejects(() => reader.settlement(settlementId('unknown')), ContractRevertError);
  });

  test('beginning a settlement while one is open supersedes it', async () => {
    const { contract, reader } = divergentToken();
    const before = await reader.currentEntry(TOKEN);

    contract.beginSettlement(
      REGISTRAR,
      TOKEN,
      settlementId('9'),
      DAVE,
      commitment('5'),
      contract.now + 60n,
    );

    assert.equal((await reader.settlement(OPEN_GAP_ID)).status, 'SUPERSEDED');
    assert.equal(await reader.openGapOf(TOKEN), settlementId('9'));
    // Supersession leaves the projection unchanged.
    assert.deepEqual(await reader.currentEntry(TOKEN), before);
  });

  test('a superseded settlement can no longer be finalized', async () => {
    const { contract } = divergentToken();
    contract.beginSettlement(
      REGISTRAR,
      TOKEN,
      settlementId('9'),
      DAVE,
      commitment('5'),
      contract.now + 60n,
    );

    // The proof already produced for the superseded settlement is now unusable.
    assert.throws(
      () =>
        contract.finalizeSettlement(OPEN_GAP_ID, {
          recordCommitment: commitment('d'),
          registryReference: `0x${'fd'.repeat(32)}`,
          effectiveAt: T.asOf + 1n,
          proofData: '0x',
        }),
      ContractRevertError,
    );
  });

  test('no entry can be admitted while no gap is open', () => {
    const { contract } = cancelledGapToken();
    for (const id of [CANCELLED_GAP_ID, settlementId('absent')]) {
      assert.throws(
        () =>
          contract.finalizeSettlement(id, {
            recordCommitment: commitment('d'),
            registryReference: `0x${'fd'.repeat(32)}`,
            effectiveAt: T.later,
            proofData: '0x',
          }),
        ContractRevertError,
      );
    }
  });

  test('an admission is atomic: a rejected proof changes nothing', async () => {
    const contract = new MemoryRegisterContract({
      now: T.beforeFirstEntry,
      verifyProof: () => false,
    });
    contract.mint(TOKEN, ALICE);
    contract.grantSettlementAuthority(TOKEN, REGISTRAR);
    contract.seedEntries(TOKEN, [{ holder: ALICE, effectiveAt: T.v1, seed: 'a' }]);

    contract.advanceTo(T.v2);
    contract.beginSettlement(
      REGISTRAR,
      TOKEN,
      settlementId('1'),
      CAROL,
      commitment('5'),
      contract.now + 60n,
    );

    assert.throws(
      () =>
        contract.finalizeSettlement(settlementId('1'), {
          recordCommitment: commitment('b'),
          registryReference: `0x${'fb'.repeat(32)}`,
          effectiveAt: T.v3,
          proofData: '0x',
        }),
      ContractRevertError,
    );

    assert.equal(contract.entryCount(TOKEN), 1n);
    assert.equal(contract.entryAt(TOKEN, 1n).supersededAt, 0n);
    assert.equal(contract.openGapOf(TOKEN), settlementId('1'), 'the gap stays open');
    assert.equal(contract.settlement(settlementId('1')).status, 'OPEN');
  });

  test('an admission that violates an invariant leaves the gap open', () => {
    const { contract } = divergentToken();
    assert.throws(() =>
      contract.finalizeSettlement(OPEN_GAP_ID, {
        // Reuses entry v1's commitment.
        recordCommitment: commitment('a'),
        registryReference: `0x${'fd'.repeat(32)}`,
        effectiveAt: T.asOf + 1n,
        proofData: '0x',
      }),
    );
    assert.equal(contract.entryCount(TOKEN), 3n);
    assert.equal(contract.openGapOf(TOKEN), OPEN_GAP_ID);
  });
});

describe('cancellation', () => {
  test('is rejected before the deadline', () => {
    const { contract } = divergentToken();
    assert.ok(contract.now < contract.settlement(OPEN_GAP_ID).deadline);
    assert.throws(
      () => contract.cancelSettlement(REGISTRAR, OPEN_GAP_ID, commitment('9')),
      ContractRevertError,
      'a record already finalized remotely must not be strandable',
    );
  });

  test('succeeds after the deadline and leaves the projection unchanged', async () => {
    const { contract, reader } = divergentToken();
    const before = await reader.currentEntry(TOKEN);
    const count = await reader.entryCount(TOKEN);

    contract.advanceTo(contract.settlement(OPEN_GAP_ID).deadline + 1n);
    contract.cancelSettlement(REGISTRAR, OPEN_GAP_ID, commitment('9'));

    assert.equal((await reader.settlement(OPEN_GAP_ID)).status, 'CANCELLED');
    assert.equal(await reader.openGapOf(TOKEN), ZERO_BYTES32);
    assert.deepEqual(await reader.currentEntry(TOKEN), before);
    assert.equal(await reader.entryCount(TOKEN), count);
  });

  test('a proof still succeeds after a rejected cancellation attempt', () => {
    const { contract } = divergentToken();
    assert.throws(() => contract.cancelSettlement(REGISTRAR, OPEN_GAP_ID, commitment('9')));

    contract.finalizeSettlement(OPEN_GAP_ID, {
      recordCommitment: commitment('d'),
      registryReference: `0x${'fd'.repeat(32)}`,
      effectiveAt: T.asOf + 1n,
      proofData: '0x',
    });
    assert.equal(contract.entryCount(TOKEN), 4n);
    assert.equal(contract.currentEntry(TOKEN).holder, DAVE);
  });

  test('is rejected from an account that is not the recorded initiator', () => {
    const { contract } = divergentToken();
    contract.advanceTo(contract.settlement(OPEN_GAP_ID).deadline + 1n);
    assert.throws(
      () => contract.cancelSettlement(STRANGER, OPEN_GAP_ID, commitment('9')),
      ContractRevertError,
    );
  });
});
