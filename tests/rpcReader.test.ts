import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { MemoryErc8415Reader } from '../src/adapters/memory/memoryReader.ts';
import {
  DAVE,
  OPEN_GAP_ID,
  REGISTRAR,
  T,
  TOKEN,
  divergentToken,
} from '../src/adapters/memory/scenarios.ts';
import { RpcErc8415Reader } from '../src/adapters/rpc/rpcReader.ts';
import { ContractRevertError } from '../src/sdk/errors.ts';
import { ZERO_BYTES32 } from '../src/sdk/types.ts';
import { FakeEvmNode } from './support/fakeNode.ts';

function readers() {
  const { contract } = divergentToken();
  return {
    contract,
    memory: new MemoryErc8415Reader(contract),
    rpc: new RpcErc8415Reader(new FakeEvmNode(contract), contract.chainId, contract.address),
  };
}

describe('the rpc reader agrees with the memory reader', () => {
  test('on contract identity and conformance', async () => {
    const { memory, rpc } = readers();
    assert.equal(await rpc.registerId(), await memory.registerId());
    assert.equal(await rpc.verificationProfile(), await memory.verificationProfile());
    assert.equal(await rpc.settlementPeriod(), await memory.settlementPeriod());
    assert.equal(await rpc.supportsInterface('0x6309e170'), true);
    assert.equal(await rpc.supportsInterface('0xf4a7d71b'), true);
    assert.equal(await rpc.supportsInterface('0xdeadbeef'), false);
  });

  test('on both ownership notions', async () => {
    const { memory, rpc } = readers();
    assert.equal(await rpc.ownerOf(TOKEN), DAVE);
    assert.equal(await rpc.ownerOf(TOKEN), await memory.ownerOf(TOKEN));
    assert.notEqual(await rpc.ownerOf(TOKEN), await rpc.holderAsOf(TOKEN, T.asOf));
  });

  test('on every entry, field for field', async () => {
    const { memory, rpc } = readers();
    assert.equal(await rpc.entryCount(TOKEN), 3n);
    for (let version = 1n; version <= 3n; version += 1n) {
      assert.deepEqual(await rpc.entryAt(TOKEN, version), await memory.entryAt(TOKEN, version));
    }
    assert.deepEqual(await rpc.currentEntry(TOKEN), await memory.currentEntry(TOKEN));
  });

  test('on holder and finality across a spread of instants', async () => {
    const { memory, rpc } = readers();
    for (const instant of [T.v1, T.v2, T.finalInstant, T.v3, T.asOf, T.later]) {
      assert.equal(await rpc.holderAsOf(TOKEN, instant), await memory.holderAsOf(TOKEN, instant));
      assert.equal(
        await rpc.isFinalAsOf(TOKEN, instant),
        await memory.isFinalAsOf(TOKEN, instant),
        `finality disagrees at ${instant}`,
      );
    }
  });

  test('on the open gap, including the status enum', async () => {
    const { memory, rpc } = readers();
    assert.equal(await rpc.openGapOf(TOKEN), OPEN_GAP_ID);
    const record = await rpc.settlement(OPEN_GAP_ID);
    assert.equal(record.status, 'OPEN');
    assert.equal(record.openedAt, T.openGapOpened);
    assert.equal(record.deadline, T.openGapDeadline);
    assert.equal(record.expectedHolder, DAVE);
    assert.deepEqual(record, await memory.settlement(OPEN_GAP_ID));
  });

  test('on settlement authority', async () => {
    const { rpc } = readers();
    assert.equal(await rpc.isSettlementAuthority(TOKEN, REGISTRAR), true);
    assert.equal(await rpc.isSettlementAuthority(TOKEN, DAVE), false);
  });

  test('on a closed gap reading as zero', async () => {
    const { contract, rpc } = readers();
    contract.advanceTo(T.openGapDeadline + 1n);
    contract.cancelSettlement(REGISTRAR, OPEN_GAP_ID, `0x${'9'.repeat(64)}`);
    assert.equal(await rpc.openGapOf(TOKEN), ZERO_BYTES32);
    assert.equal((await rpc.settlement(OPEN_GAP_ID)).status, 'CANCELLED');
  });

  test('propagates a revert instead of inventing an answer', async () => {
    const { rpc } = readers();
    await assert.rejects(() => rpc.entryAsOf(TOKEN, T.beforeFirstEntry), ContractRevertError);
    await assert.rejects(() => rpc.holderAsOf(TOKEN, T.beforeFirstEntry), ContractRevertError);
    // And the one call that must not revert there still answers.
    assert.equal(await rpc.isFinalAsOf(TOKEN, T.beforeFirstEntry), false);
  });
});
