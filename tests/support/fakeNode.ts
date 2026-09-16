import { encodeLog, matchesFilter } from '../../src/adapters/memory/encodeEvents.ts';
import type { MemoryRegisterContract } from '../../src/adapters/memory/register.ts';
import type { CallTransport } from '../../src/adapters/rpc/transport.ts';
import {
  decodeResult,
  encodeWords,
  REGISTER_ENTRY_TYPES,
  SETTLEMENT_TYPES,
  type StaticType,
} from '../../src/codec/abi.ts';
import { ContractRevertError } from '../../src/sdk/errors.ts';
import { selectorOf } from '../../src/sdk/interfaceIds.ts';
import {
  GAP_STATUS_BY_INDEX,
  type Address,
  type RegisterEntry,
} from '../../src/sdk/types.ts';

/**
 * Serves the modelled contract over the real calldata encoding.
 *
 * Standing this between the rpc reader and the contract exercises the codec in
 * both directions against a caller that did not write it, which is what a real
 * node would be. Reverts propagate as reverts.
 */
export class FakeEvmNode implements CallTransport {
  readonly #contract: MemoryRegisterContract;

  constructor(contract: MemoryRegisterContract) {
    this.#contract = contract;
  }

  async blockTimestamp(): Promise<bigint> {
    return this.#contract.now;
  }

  async blockTimestampAt(blockNumber: bigint): Promise<bigint> {
    return this.#contract.instantAt(blockNumber);
  }

  async getLogs(filter: Record<string, unknown>): Promise<unknown[]> {
    const topics = (filter['topics'] ?? []) as (string | null)[];
    return encodeLog(this.#contract.log, this.#contract.address)
      .filter((log) => matchesFilter(log, { address: this.#contract.address, topics }))
      .map((log) => ({
        address: log.address,
        topics: log.topics,
        data: log.data,
        blockNumber: `0x${log.blockNumber.toString(16)}`,
        logIndex: `0x${log.logIndex.toString(16)}`,
      }));
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
