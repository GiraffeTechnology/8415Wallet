import { decodeResult, encodeCall, REGISTER_ENTRY_TYPES, SETTLEMENT_TYPES } from '../../codec/abi.ts';
import type { AbiValue, StaticType } from '../../codec/abi.ts';
import {
  NoContractAtAddressError,
  TransportError,
  ValueOutOfRangeError,
} from '../../sdk/errors.ts';
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
import type { LogFilter, RawLog } from '../../sdk/events.ts';
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
export type RpcReaderOptions = {
  /**
   * How many blocks one `eth_getLogs` request may span.
   *
   * Providers cap this and the caps differ, so a projection's history cannot
   * be asked for in one request. 10,000 is below every cap this has been run
   * against; raise it for a node that allows more.
   */
  readonly logWindow?: bigint;
  /**
   * Where the scan starts.
   *
   * Omitted, the reader finds the contract's deployment block by bisecting
   * `eth_getCode`, which costs about two dozen requests once and then nothing.
   * Supply it to skip that.
   */
  readonly fromBlock?: bigint;
};

const DEFAULT_LOG_WINDOW = 10_000n;

export class RpcErc8415Reader implements Erc8415Reader {
  readonly source: { readonly chainId: bigint; readonly address: Address };
  readonly #transport: CallTransport;
  readonly #logWindow: bigint;
  readonly #configuredFromBlock: bigint | undefined;
  #deploymentBlock: bigint | undefined;

  constructor(
    transport: CallTransport,
    chainId: bigint,
    address: Address,
    options: RpcReaderOptions = {},
  ) {
    this.#transport = transport;
    this.source = { chainId, address };
    this.#logWindow = options.logWindow ?? DEFAULT_LOG_WINDOW;
    this.#configuredFromBlock = options.fromBlock;
  }

  async #read(
    signature: string,
    argumentTypes: readonly StaticType[],
    args: readonly AbiValue[],
    returnTypes: readonly StaticType[],
  ): Promise<AbiValue[]> {
    const data = encodeCall(signature, argumentTypes, args);
    const result = await this.#transport.call(this.source.address, data);
    // An address with no code answers every call successfully and with
    // nothing. Saying so here is the difference between "you have the wrong
    // address" and a decoder complaining about a short payload.
    if (returnTypes.length > 0 && stripsToNothing(result)) {
      throw new NoContractAtAddressError(this.source.address, signature);
    }
    return decodeResult(returnTypes, result);
  }

  async chainInstant(): Promise<Instant> {
    return this.#transport.blockTimestamp();
  }

  async chainInstantAt(blockNumber: bigint): Promise<Instant> {
    return this.#transport.blockTimestampAt(blockNumber);
  }

  /**
   * Read logs over the contract's whole life, in windows.
   *
   * A projection's history is the whole point — an entry admitted years ago
   * still decides who was confirmed then — so this must not return a recent
   * slice and call it the history. It used to ask for `fromBlock: 'earliest'`
   * in one request, which real providers refuse: run against a public Sepolia
   * endpoint it came back "exceed maximum block range: 50000".
   *
   * So the range is walked in windows instead, from the block the contract was
   * deployed in to the latest. Nothing is truncated, and nothing is silently
   * partial: a window the node refuses raises rather than returning the logs
   * gathered so far, because a short history is indistinguishable from a
   * quiet one.
   */
  async getLogs(filter: LogFilter): Promise<readonly RawLog[]> {
    const latest = await this.#transport.blockNumber();
    const start = await this.#startBlock();
    const collected: RawLog[] = [];

    for (let from = start; from <= latest; from += this.#logWindow) {
      const to = from + this.#logWindow - 1n > latest ? latest : from + this.#logWindow - 1n;
      const raw = await this.#transport.getLogs({
        address: filter.address,
        topics: filter.topics,
        fromBlock: `0x${from.toString(16)}`,
        toBlock: `0x${to.toString(16)}`,
      });
      for (const entry of raw) collected.push(toRawLog(entry));
    }
    return collected;
  }

  /** Where to start the scan, resolved once. */
  async #startBlock(): Promise<bigint> {
    if (this.#configuredFromBlock !== undefined) return this.#configuredFromBlock;
    if (this.#deploymentBlock !== undefined) return this.#deploymentBlock;
    this.#deploymentBlock = await this.#findDeploymentBlock();
    return this.#deploymentBlock;
  }

  /**
   * The block this contract was deployed in, by bisecting `eth_getCode`.
   *
   * Code is absent before deployment and present from it onwards, so the
   * boundary is findable in about two dozen requests rather than by scanning
   * eleven million blocks.
   *
   * It only works against an archive node. Asking for code at a historical
   * block is a state query, and most public endpoints prune state — Sepolia's
   * PublicNode answers `state at block #5869973 is pruned` partway through the
   * bisection. When that happens this refuses rather than guessing a start
   * block, because every guess is either a scan of the whole chain or a
   * history quietly cut off at the wrong end, and the second is the one that
   * looks like a projection that never moved.
   *
   * The remedy is a `fromBlock`, which an operator deploying the contract
   * always has.
   */
  async #findDeploymentBlock(): Promise<bigint> {
    const head = await this.#transport.blockNumber();
    if ((await this.#transport.codeAt(this.source.address, head)) === '0x') {
      throw new TransportError(
        'eth_getCode',
        `${this.source.address} has no code at block ${head}; there is no deployment to scan`,
      );
    }

    let low = 0n;
    let high = head;
    while (low < high) {
      const middle = low + (high - low) / 2n;
      let code: string;
      try {
        code = await this.#transport.codeAt(this.source.address, middle);
      } catch (error) {
        throw new TransportError(
          'eth_getCode',
          `this node cannot answer for block ${middle}, so the deployment block ` +
            'cannot be found by bisection — supply fromBlock, or use an archive node ' +
            `(${error instanceof Error ? error.message : String(error)})`,
        );
      }
      if (code === '0x') low = middle + 1n;
      else high = middle;
    }
    return low;
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

/** Whether returndata carries no bytes at all. */
function stripsToNothing(result: string): boolean {
  return result === '0x' || result === '0X' || result === '';
}

function toRawLog(value: unknown): RawLog {
  const log = value as {
    address?: string;
    topics?: string[];
    data?: string;
    blockNumber?: string;
    logIndex?: string;
  };
  if (typeof log.address !== 'string' || !Array.isArray(log.topics)) {
    throw new ValueOutOfRangeError('log payload', 0n);
  }
  return {
    address: log.address,
    topics: log.topics,
    data: log.data ?? '0x',
    blockNumber: BigInt(log.blockNumber ?? '0x0'),
    logIndex: BigInt(log.logIndex ?? '0x0'),
  };
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
