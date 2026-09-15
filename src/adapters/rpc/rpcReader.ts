import { decodeResult, encodeCall, REGISTER_ENTRY_TYPES, SETTLEMENT_TYPES } from '../../codec/abi.ts';
import type { AbiValue, StaticType } from '../../codec/abi.ts';
import { ValueOutOfRangeError } from '../../sdk/errors.ts';
import type { Erc8415Reader } from '../../sdk/port.ts';
import {
  GAP_STATUS_BY_INDEX,
  type Address,
  type Bytes32,
  type Bytes4,
  type GapStatus,
  type Instant,
  type RegisterEntry,
  type Settlement,
  type TokenId,
  type Version,
} from '../../sdk/types.ts';
import type { CallTransport } from './transport.ts';

/**
 * Reads an ERC-8415 contract over `eth_call`.
 *
 * Reverts propagate as `ContractRevertError` from the transport, unchanged:
 * `entryAsOf` reverting for an instant before the first entry is specified
 * behaviour, and it is the wallet layer above, not this adapter, that
 * establishes which cause applies.
 *
 * This adapter computes nothing. Every value it returns came off the wire.
 */
export class RpcErc8415Reader implements Erc8415Reader {
  readonly source: { readonly chainId: bigint; readonly address: Address };
  readonly #transport: CallTransport;

  constructor(transport: CallTransport, chainId: bigint, address: Address) {
    this.#transport = transport;
    this.source = { chainId, address };
  }

  async #read(
    signature: string,
    argumentTypes: readonly StaticType[],
    args: readonly AbiValue[],
    returnTypes: readonly StaticType[],
  ): Promise<AbiValue[]> {
    const data = encodeCall(signature, argumentTypes, args);
    const result = await this.#transport.call(this.source.address, data);
    return decodeResult(returnTypes, result);
  }

  async chainInstant(): Promise<Instant> {
    return this.#transport.blockTimestamp();
  }

  async supportsInterface(interfaceId: Bytes4): Promise<boolean> {
    const [supported] = await this.#read(
      'supportsInterface(bytes4)',
      ['bytes4'],
      [interfaceId],
      ['bool'],
    );
    return supported as boolean;
  }

  async ownerOf(tokenId: TokenId): Promise<Address> {
    const [owner] = await this.#read('ownerOf(uint256)', ['uint256'], [tokenId], ['address']);
    return owner as Address;
  }

  async currentEntry(tokenId: TokenId): Promise<RegisterEntry> {
    return toEntry(
      await this.#read('currentEntry(uint256)', ['uint256'], [tokenId], REGISTER_ENTRY_TYPES),
    );
  }

  async entryAt(tokenId: TokenId, version: Version): Promise<RegisterEntry> {
    return toEntry(
      await this.#read(
        'entryAt(uint256,uint64)',
        ['uint256', 'uint64'],
        [tokenId, version],
        REGISTER_ENTRY_TYPES,
      ),
    );
  }

  async entryAsOf(tokenId: TokenId, instant: Instant): Promise<RegisterEntry> {
    return toEntry(
      await this.#read(
        'entryAsOf(uint256,uint64)',
        ['uint256', 'uint64'],
        [tokenId, instant],
        REGISTER_ENTRY_TYPES,
      ),
    );
  }

  async holderAsOf(tokenId: TokenId, instant: Instant): Promise<Address> {
    const [holder] = await this.#read(
      'holderAsOf(uint256,uint64)',
      ['uint256', 'uint64'],
      [tokenId, instant],
      ['address'],
    );
    return holder as Address;
  }

  async isFinalAsOf(tokenId: TokenId, instant: Instant): Promise<boolean> {
    const [settled] = await this.#read(
      'isFinalAsOf(uint256,uint64)',
      ['uint256', 'uint64'],
      [tokenId, instant],
      ['bool'],
    );
    return settled as boolean;
  }

  async entryCount(tokenId: TokenId): Promise<bigint> {
    const [count] = await this.#read('entryCount(uint256)', ['uint256'], [tokenId], ['uint64']);
    return count as bigint;
  }

  async registerId(): Promise<Bytes32> {
    const [identifier] = await this.#read('registerId()', [], [], ['bytes32']);
    return identifier as Bytes32;
  }

  async settlement(settlementId: Bytes32): Promise<Settlement> {
    const fields = await this.#read(
      'settlement(bytes32)',
      ['bytes32'],
      [settlementId],
      SETTLEMENT_TYPES,
    );
    return {
      tokenId: fields[0] as bigint,
      initiator: fields[1] as Address,
      expectedHolder: fields[2] as Address,
      snapshotHash: fields[3] as Bytes32,
      openedAt: fields[4] as bigint,
      deadline: fields[5] as bigint,
      status: toGapStatus(fields[6] as bigint),
    };
  }

  async openGapOf(tokenId: TokenId): Promise<Bytes32> {
    const [settlementId] = await this.#read(
      'openGapOf(uint256)',
      ['uint256'],
      [tokenId],
      ['bytes32'],
    );
    return settlementId as Bytes32;
  }

  async settlementPeriod(): Promise<bigint> {
    const [period] = await this.#read('settlementPeriod()', [], [], ['uint64']);
    return period as bigint;
  }

  async verificationProfile(): Promise<Bytes32> {
    const [identifier] = await this.#read('verificationProfile()', [], [], ['bytes32']);
    return identifier as Bytes32;
  }

  async isSettlementAuthority(tokenId: TokenId, account: Address): Promise<boolean> {
    const [authorized] = await this.#read(
      'isSettlementAuthority(uint256,address)',
      ['uint256', 'address'],
      [tokenId, account],
      ['bool'],
    );
    return authorized as boolean;
  }
}

function toEntry(fields: readonly AbiValue[]): RegisterEntry {
  return {
    recordCommitment: fields[0] as Bytes32,
    previousCommitment: fields[1] as Bytes32,
    registryReference: fields[2] as Bytes32,
    holder: fields[3] as Address,
    version: fields[4] as bigint,
    effectiveAt: fields[5] as bigint,
    supersededAt: fields[6] as bigint,
  };
}

/**
 * Map the on-chain enum ordinal.
 *
 * An unmapped ordinal throws rather than falling back to a neighbouring state:
 * a status the wallet does not understand must not be rendered as one it does.
 */
function toGapStatus(ordinal: bigint): GapStatus {
  const status = GAP_STATUS_BY_INDEX[Number(ordinal)];
  if (status === undefined) {
    throw new ValueOutOfRangeError('settlement status ordinal', ordinal);
  }
  return status;
}
