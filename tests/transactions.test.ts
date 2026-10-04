import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  ALICE,
  DAVE,
  OPEN_GAP_ID,
  REGISTRAR,
  STRANGER,
  T,
  TOKEN,
  cancelledGapToken,
  commitment,
  divergentToken,
  projectionOnlyToken,
  settlementId,
} from '../src/adapters/memory/scenarios.ts';
import {
  TransactionWouldRevertError,
  buildBeginSettlement,
  buildCancelSettlement,
  buildFinalizeSettlement,
} from '../src/sdk/transactions.ts';
import { ZERO_BYTES32 } from '../src/sdk/types.ts';
import { TransportError } from '../src/sdk/errors.ts';
import { executeTransaction } from './support/executeTransaction.ts';

const SNAPSHOT = commitment('5');

describe('the write path is exactly three operations', () => {
  test('a built request is unsigned, non-payable, and bound to one chain', async () => {
    const { contract, reader } = divergentToken();
    const request = await buildCancelSettlement(reader, REGISTRAR, {
      settlementId: OPEN_GAP_ID,
      reasonHash: commitment('9'),
    }).catch(() => undefined);

    // Before the deadline this one is refused; use a valid build instead.
    assert.equal(request, undefined);

    contract.advanceTo(T.openGapDeadline + 1n);
    const valid = await buildCancelSettlement(reader, REGISTRAR, {
      settlementId: OPEN_GAP_ID,
      reasonHash: commitment('9'),
    });

    assert.equal(valid.value, '0x0');
    assert.equal(valid.to, contract.address);
    assert.equal(valid.chainId, contract.chainId);
    assert.equal(valid.from, REGISTRAR);
    assert.ok(valid.data.startsWith('0x'));
    // No signature, no key material, anywhere on the request.
    assert.ok(!('signature' in valid));
    assert.ok(!('privateKey' in valid));
  });
});

describe('beginSettlement', () => {
  test('builds and, when executed, opens a gap without moving the projection', async () => {
    const { contract, reader } = cancelledGapToken();
    const before = await reader.currentEntry(TOKEN);

    const request = await buildBeginSettlement(reader, REGISTRAR, {
      tokenId: TOKEN,
      settlementId: settlementId('4'),
      expectedHolder: DAVE,
      snapshotHash: SNAPSHOT,
      deadline: contract.now + 600n,
    });
    executeTransaction(contract, request);

    assert.equal(await reader.openGapOf(TOKEN), settlementId('4'));
    assert.deepEqual(await reader.currentEntry(TOKEN), before, 'the projection did not move');
  });

  test('refuses when the sender is not the settlement authority', async () => {
    const { contract, reader } = cancelledGapToken();
    await assert.rejects(
      () =>
        buildBeginSettlement(reader, STRANGER, {
          tokenId: TOKEN,
          settlementId: settlementId('4'),
          expectedHolder: DAVE,
          snapshotHash: SNAPSHOT,
          deadline: contract.now + 600n,
        }),
      (error: unknown) => {
        assert.ok(error instanceof TransactionWouldRevertError);
        assert.ok(
          error.checks.some((check) => check.name === 'settlement authority'),
          'the authority check is the blocker',
        );
        assert.match(error.message, /owning it does not confer the authority/);
        return true;
      },
    );
  });

  test('refuses a deadline beyond the settlement period, naming both numbers', async () => {
    const { contract, reader } = cancelledGapToken();
    const period = await reader.settlementPeriod();

    await assert.rejects(
      () =>
        buildBeginSettlement(reader, REGISTRAR, {
          tokenId: TOKEN,
          settlementId: settlementId('4'),
          expectedHolder: DAVE,
          snapshotHash: SNAPSHOT,
          deadline: contract.now + period + 1n,
        }),
      (error: unknown) => {
        assert.ok(error instanceof TransactionWouldRevertError);
        assert.match(error.message, new RegExp(`${period}s maximum`));
        return true;
      },
    );
  });

  test('refuses a zero settlement id, a zero snapshot, and a reused id', async () => {
    const { contract, reader } = divergentToken();
    const base = {
      tokenId: TOKEN,
      expectedHolder: DAVE,
      snapshotHash: SNAPSHOT,
      deadline: contract.now + 600n,
    };

    await assert.rejects(
      () => buildBeginSettlement(reader, REGISTRAR, { ...base, settlementId: ZERO_BYTES32 }),
      TransactionWouldRevertError,
    );
    await assert.rejects(
      () =>
        buildBeginSettlement(reader, REGISTRAR, {
          ...base,
          settlementId: settlementId('4'),
          snapshotHash: ZERO_BYTES32,
        }),
      TransactionWouldRevertError,
    );
    await assert.rejects(
      () => buildBeginSettlement(reader, REGISTRAR, { ...base, settlementId: OPEN_GAP_ID }),
      TransactionWouldRevertError,
    );
  });

  test('warns that an open gap will be superseded, without blocking', async () => {
    const { contract, reader } = divergentToken();
    const request = await buildBeginSettlement(reader, REGISTRAR, {
      tokenId: TOKEN,
      settlementId: settlementId('4'),
      expectedHolder: DAVE,
      snapshotHash: SNAPSHOT,
      deadline: contract.now + 600n,
    });

    assert.deepEqual(request.preflight.blocking, []);
    assert.ok(
      request.preflight.consequences.some((note) => /supersedes it/.test(note)),
      'supersession is reported as a consequence',
    );
    assert.ok(
      request.preflight.consequences.some((note) => /proof already produced/.test(note)),
    );
  });

  test('permits a confirming entry naming the current holder', async () => {
    const { contract, reader } = cancelledGapToken();
    const holder = (await reader.currentEntry(TOKEN)).holder;

    const request = await buildBeginSettlement(reader, REGISTRAR, {
      tokenId: TOKEN,
      settlementId: settlementId('4'),
      expectedHolder: holder,
      snapshotHash: SNAPSHOT,
      deadline: contract.now + 600n,
    });
    assert.deepEqual(request.preflight.blocking, []);
  });
});

describe('finalizeSettlement', () => {
  test('builds, executes, and moves the projection', async () => {
    const { contract, reader } = divergentToken();
    const request = await buildFinalizeSettlement(reader, STRANGER, {
      settlementId: OPEN_GAP_ID,
      recordCommitment: commitment('d'),
      registryReference: `0x${'fd'.repeat(32)}`,
      effectiveAt: T.asOf + 1n,
      proofData: '0xdeadbeef',
    });
    executeTransaction(contract, request);

    assert.equal(await reader.entryCount(TOKEN), 4n);
    assert.equal((await reader.currentEntry(TOKEN)).holder, DAVE);
    assert.equal(await reader.openGapOf(TOKEN), ZERO_BYTES32);
  });

  test('is permissionless: any sender may relay, and it grants no rights', async () => {
    const { reader } = divergentToken();
    const request = await buildFinalizeSettlement(reader, STRANGER, {
      settlementId: OPEN_GAP_ID,
      recordCommitment: commitment('d'),
      registryReference: `0x${'fd'.repeat(32)}`,
      effectiveAt: T.asOf + 1n,
      proofData: '0x',
    });

    assert.deepEqual(request.preflight.blocking, []);
    assert.ok(request.preflight.consequences.some((note) => /grants no rights/.test(note)));
    assert.ok(
      !request.preflight.checks.some((check) => check.name === 'settlement authority'),
      'no authority check is applied to a permissionless call',
    );
  });

  test('says plainly that it cannot verify the proof', async () => {
    const { reader } = divergentToken();
    const request = await buildFinalizeSettlement(reader, STRANGER, {
      settlementId: OPEN_GAP_ID,
      recordCommitment: commitment('d'),
      registryReference: `0x${'fd'.repeat(32)}`,
      effectiveAt: T.asOf + 1n,
      proofData: '0x00',
    });

    const proof = request.preflight.unverifiable.find((check) => check.name === 'proof validity');
    assert.notEqual(proof, undefined);
    assert.match(proof?.detail ?? '', /cannot verify the proof/);
    assert.match(proof?.detail ?? '', /not that an asset exists/);
  });

  test('refuses an effectiveAt that does not strictly increase', async () => {
    const { reader } = divergentToken();
    for (const effectiveAt of [T.v3, T.v3 - 1n]) {
      await assert.rejects(
        () =>
          buildFinalizeSettlement(reader, STRANGER, {
            settlementId: OPEN_GAP_ID,
            recordCommitment: commitment('d'),
            registryReference: `0x${'fd'.repeat(32)}`,
            effectiveAt,
            proofData: '0x',
          }),
        (error: unknown) => {
          assert.ok(error instanceof TransactionWouldRevertError);
          assert.match(error.message, /two answers/);
          return true;
        },
      );
    }
  });

  test('refuses a commitment already used on the token', async () => {
    const { reader } = divergentToken();
    await assert.rejects(
      () =>
        buildFinalizeSettlement(reader, STRANGER, {
          settlementId: OPEN_GAP_ID,
          recordCommitment: commitment('a'),
          registryReference: `0x${'fd'.repeat(32)}`,
          effectiveAt: T.asOf + 1n,
          proofData: '0x',
        }),
      (error: unknown) => {
        assert.ok(error instanceof TransactionWouldRevertError);
        assert.match(error.message, /cannot be told apart/);
        return true;
      },
    );
  });

  test('refuses a settlement that is not open', async () => {
    const { reader } = cancelledGapToken();
    await assert.rejects(
      () =>
        buildFinalizeSettlement(reader, STRANGER, {
          settlementId: `0x${'e8'.repeat(32)}`,
          recordCommitment: commitment('d'),
          registryReference: `0x${'fd'.repeat(32)}`,
          effectiveAt: T.later,
          proofData: '0x',
        }),
      (error: unknown) => {
        assert.ok(error instanceof TransactionWouldRevertError);
        assert.match(error.message, /CANCELLED/);
        return true;
      },
    );
  });

  test('carries the proof bytes through the encoding intact', async () => {
    const { contract, reader } = divergentToken();
    const proofData = `0x${'ab'.repeat(97)}`; // not a whole number of words
    const request = await buildFinalizeSettlement(reader, STRANGER, {
      settlementId: OPEN_GAP_ID,
      recordCommitment: commitment('d'),
      registryReference: `0x${'fd'.repeat(32)}`,
      effectiveAt: T.asOf + 1n,
      proofData,
    });

    let seen: string | undefined;
    const observing = Object.create(contract) as typeof contract;
    Object.defineProperty(observing, 'finalizeSettlement', {
      value: (id: string, candidate: { proofData: string }) => {
        seen = candidate.proofData;
        contract.finalizeSettlement(id, candidate as never);
      },
    });
    executeTransaction(observing, request);
    assert.equal(seen, proofData);
  });
});

describe('cancelSettlement', () => {
  test('refuses before the deadline, naming what remains', async () => {
    const { reader } = divergentToken();
    await assert.rejects(
      () =>
        buildCancelSettlement(reader, REGISTRAR, {
          settlementId: OPEN_GAP_ID,
          reasonHash: commitment('9'),
        }),
      (error: unknown) => {
        assert.ok(error instanceof TransactionWouldRevertError);
        assert.match(error.message, /s remain/);
        assert.match(error.message, /stranded by unilateral abandonment/);
        return true;
      },
    );
  });

  test('refuses a sender that is not the recorded initiator', async () => {
    const { contract, reader } = divergentToken();
    contract.advanceTo(T.openGapDeadline + 1n);

    await assert.rejects(
      () =>
        buildCancelSettlement(reader, STRANGER, {
          settlementId: OPEN_GAP_ID,
          reasonHash: commitment('9'),
        }),
      TransactionWouldRevertError,
    );
  });

  test('builds after the deadline and warns that it settles nothing', async () => {
    const { contract, reader } = divergentToken();
    contract.advanceTo(T.openGapDeadline + 1n);

    const request = await buildCancelSettlement(reader, REGISTRAR, {
      settlementId: OPEN_GAP_ID,
      reasonHash: commitment('9'),
    });
    assert.ok(request.preflight.consequences.some((note) => /settles nothing/.test(note)));
    assert.ok(request.preflight.consequences.some((note) => /not a rejection/.test(note)));

    const before = await reader.currentEntry(TOKEN);
    executeTransaction(contract, request);

    assert.equal(await reader.openGapOf(TOKEN), ZERO_BYTES32);
    assert.deepEqual(await reader.currentEntry(TOKEN), before, 'the projection did not move');
    assert.equal(await reader.isFinalAsOf(TOKEN, T.asOf), false, 'nothing became final');
  });
});

describe('a contract without the settlement interface', () => {
  test('has no write path at all', async () => {
    const { contract, reader } = projectionOnlyToken();
    await assert.rejects(
      () =>
        buildBeginSettlement(reader, REGISTRAR, {
          tokenId: TOKEN,
          settlementId: settlementId('4'),
          expectedHolder: ALICE,
          snapshotHash: SNAPSHOT,
          deadline: contract.now + 600n,
        }),
      (error: unknown) => {
        assert.ok(error instanceof TransactionWouldRevertError);
        assert.match(error.message, /does not advertise 0xf4a7d71b/);
        return true;
      },
    );
  });
});


describe('preflight unavailable evidence remains unavailable', () => {
  for (const operation of ['begin', 'finalize', 'cancel'] as const) {
    test(`${operation}: a settlement transport failure is never missing/unused evidence`, async () => {
      const { reader, contract } = divergentToken();
      const failure = new TransportError('eth_call', 'provider refused');
      reader.settlement = async () => { throw failure; };
      const prepared = operation === 'begin' ? buildBeginSettlement(reader, REGISTRAR, {
        tokenId: TOKEN, settlementId: settlementId('e'), expectedHolder: DAVE, snapshotHash: commitment('d'), deadline: contract.now + 600n,
      }) : operation === 'finalize' ? buildFinalizeSettlement(reader, REGISTRAR, {
        settlementId: OPEN_GAP_ID, recordCommitment: commitment('d'), registryReference: commitment('e'), effectiveAt: T.v3 + 10n, proofData: '0x',
      }) : buildCancelSettlement(reader, REGISTRAR, { settlementId: OPEN_GAP_ID, reasonHash: commitment('f') });
      await assert.rejects(prepared, error => error === failure);
    });
  }
  for (const field of ['ownerOf', 'isSettlementAuthority'] as const) {
    test(`${field}: a transport failure cannot become a token or authority fact`, async () => {
      const { reader, contract } = divergentToken();
      const failure = new TransportError('eth_call', 'provider refused');
      reader[field] = async () => { throw failure; };
      await assert.rejects(buildBeginSettlement(reader, REGISTRAR, {
        tokenId: TOKEN, settlementId: settlementId('e'), expectedHolder: DAVE, snapshotHash: commitment('d'), deadline: contract.now + 600n,
      }), error => error === failure);
    });
  }
});
