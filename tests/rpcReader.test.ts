import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { MemoryErc8415Reader } from '../src/adapters/memory/memoryReader.ts';
import { DAVE, OPEN_GAP_ID, REGISTRAR, T, TOKEN, divergentToken } from '../src/adapters/memory/scenarios.ts';
import type { MemoryRegisterContract } from '../src/adapters/memory/register.ts';
import { RpcErc8415Reader } from '../src/adapters/rpc/rpcReader.ts';
import type { CallTransport } from '../src/adapters/rpc/transport.ts';
import {
  decodeResult,
  encodeWords,
  REGISTER_ENTRY_TYPES,
  SETTLEMENT_TYPES,
  type StaticType,
} from '../src/codec/abi.ts';
import { ContractRevertError } from '../src/sdk/errors.ts';
import { GAP_STATUS_BY_INDEX, ZERO_BYTES32, type Address, type RegisterEntry } from '../src/sdk/types.ts';
import { selectorOf } from '../src/sdk/interfaceIds.ts';

/**
 * Serves the modelled contract over the real calldata encoding.
 *
 * Standing this between the rpc reader and the contract exercises the codec in
 * both directions against a caller that did not write it, which is what a real
 * node would be. Reverts propagate as reverts.
 */
class FakeEvmNode implements CallTransport {
  readonly #contract: MemoryRegisterContract;

  constructor(contract: MemoryRegisterContract) {
    this.#contract = contract;
  }

  async call(_to: Address, data: string): Promise<string> {
    const selector = data.slice(0, 10);
    const args = `0x${data.slice(10)}`;
    const read = (types: readonly StaticType[]) => decodeResult(types, args);
    const entry = (value: RegisterEntry) =>
      encodeWords(REGISTER_ENTRY_TYPES, [
        value.recordCommitment,
        value.previousCommitment,
        value.registryReference,
        value.holder,
        value.version,
        value.effectiveAt,
        value.supersededAt,
      ]);

    switch (selector) {
      case selectorOf('supportsInterface(bytes4)'): {
        const [id] = read(['bytes4']);
        return encodeWords(['bool'], [this.#contract.supportsInterface(id as string)]);
      }
      case selectorOf('ownerOf(uint256)'): {
        const [tokenId] = read(['uint256']);
        return encodeWords(['address'], [this.#contract.ownerOf(tokenId as bigint)]);
      }
      case selectorOf('currentEntry(uint256)'): {
        const [tokenId] = read(['uint256']);
        return entry(this.#contract.currentEntry(tokenId as bigint));
      }
      case selectorOf('entryAt(uint256,uint64)'): {
        const [tokenId, version] = read(['uint256', 'uint64']);
        return entry(this.#contract.entryAt(tokenId as bigint, version as bigint));
      }
      case selectorOf('entryAsOf(uint256,uint64)'): {
        const [tokenId, instant] = read(['uint256', 'uint64']);
        return entry(this.#contract.entryAsOf(tokenId as bigint, instant as bigint));
      }
      case selectorOf('holderAsOf(uint256,uint64)'): {
        const [tokenId, instant] = read(['uint256', 'uint64']);
        return encodeWords(
          ['address'],
          [this.#contract.holderAsOf(tokenId as bigint, instant as bigint)],
        );
      }
      case selectorOf('isFinalAsOf(uint256,uint64)'): {
        const [tokenId, instant] = read(['uint256', 'uint64']);
        return encodeWords(
          ['bool'],
          [this.#contract.isFinalAsOf(tokenId as bigint, instant as bigint)],
        );
      }
      case selectorOf('entryCount(uint256)'): {
        const [tokenId] = read(['uint256']);
        return encodeWords(['uint64'], [this.#contract.entryCount(tokenId as bigint)]);
      }
      case selectorOf('registerId()'):
        return encodeWords(['bytes32'], [this.#contract.registerId()]);
      case selectorOf('verificationProfile()'):
        return encodeWords(['bytes32'], [this.#contract.verificationProfile()]);
      case selectorOf('settlementPeriod()'):
        return encodeWords(['uint64'], [this.#contract.settlementPeriod()]);
      case selectorOf('openGapOf(uint256)'): {
        const [tokenId] = read(['uint256']);
        return encodeWords(['bytes32'], [this.#contract.openGapOf(tokenId as bigint)]);
      }
      case selectorOf('isSettlementAuthority(uint256,address)'): {
        const [tokenId, account] = read(['uint256', 'address']);
        return encodeWords(
          ['bool'],
          [this.#contract.isSettlementAuthority(tokenId as bigint, account as Address)],
        );
      }
      case selectorOf('settlement(bytes32)'): {
        const [id] = read(['bytes32']);
        const record = this.#contract.settlement(id as string);
        return encodeWords(SETTLEMENT_TYPES, [
          record.tokenId,
          record.initiator,
          record.expectedHolder,
          record.snapshotHash,
          record.openedAt,
          record.deadline,
          BigInt(GAP_STATUS_BY_INDEX.indexOf(record.status)),
        ]);
      }
      default:
        throw new ContractRevertError(`unknown selector ${selector}`);
    }
  }
}

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
