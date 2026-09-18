import { SELECTOR, decodeEntry, encodeCall, toAddress, toBigInt, toBool, toBytes32, words } from './abi.ts';
import type { JsonRpcTransport } from './transport.ts';
import type { Address, Bytes32, Instant, ProjectionEntry, TokenId } from '../../engine/projection/types.ts';

export class ConformanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConformanceError';
  }
}

export interface ReaderOptions {
  readonly transport: JsonRpcTransport;
  readonly contract: Address;
  /** Block tag reads are pinned to. Defaults to the finalized head. */
  readonly block?: string;
}

/**
 * Reads a conforming contract through the frozen interfaces.
 *
 * Conformance is discovered, never assumed: `supportsInterface` is asked
 * before any projection data is claimed for a contract, and a contract that
 * advertises the projection identifier but not the settlement one simply has
 * no gaps — that is a property of the contract, not an error.
 *
 * Reads are pinned to a block tag. A read-then-act consumer should be calling
 * the contract inside its own transaction instead; this reader exists for
 * display and indexing, where the standard's own guidance is not to cache an
 * answer across transactions.
 */
export class EthereumProjectionReader {
  readonly #transport: JsonRpcTransport;
  readonly #contract: Address;
  readonly #block: string;

  constructor(options: ReaderOptions) {
    this.#transport = options.transport;
    this.#contract = options.contract;
    this.#block = options.block ?? 'finalized';
  }

  async supportsProjection(): Promise<boolean> {
    return this.#supports('0x6309e170');
  }

  async supportsSettlement(): Promise<boolean> {
    return this.#supports('0xf4a7d71b');
  }

  async registerId(): Promise<Bytes32> {
    return toBytes32(await this.#slot(SELECTOR.registerId, []));
  }

  async verificationProfile(): Promise<Bytes32> {
    return toBytes32(await this.#slot(SELECTOR.verificationProfile, []));
  }

  async entryCount(tokenId: TokenId): Promise<bigint> {
    return toBigInt(await this.#slot(SELECTOR.entryCount, [tokenId]));
  }

  async currentEntry(tokenId: TokenId): Promise<ProjectionEntry> {
    return decodeEntry(await this.#call(SELECTOR.currentEntry, [tokenId]));
  }

  async entryAt(tokenId: TokenId, version: bigint): Promise<ProjectionEntry> {
    return decodeEntry(await this.#call(SELECTOR.entryAt, [tokenId, version]));
  }

  async entryAsOf(tokenId: TokenId, instant: Instant): Promise<ProjectionEntry> {
    return decodeEntry(await this.#call(SELECTOR.entryAsOf, [tokenId, instant]));
  }

  async holderAsOf(tokenId: TokenId, instant: Instant): Promise<Address> {
    return toAddress(await this.#slot(SELECTOR.holderAsOf, [tokenId, instant]));
  }

  async isFinalAsOf(tokenId: TokenId, instant: Instant): Promise<boolean> {
    return toBool(await this.#slot(SELECTOR.isFinalAsOf, [tokenId, instant]));
  }

  async openGapOf(tokenId: TokenId): Promise<Bytes32> {
    return toBytes32(await this.#slot(SELECTOR.openGapOf, [tokenId]));
  }

  async isSettlementAuthority(tokenId: TokenId, account: Address): Promise<boolean> {
    return toBool(await this.#slot(SELECTOR.isSettlementAuthority, [tokenId, account]));
  }

  async #supports(interfaceId: string): Promise<boolean> {
    const padded = `${interfaceId}${'0'.repeat(56)}`;
    return toBool(await this.#slot(SELECTOR.supportsInterface, [padded]));
  }

  async #slot(selector: string, args: readonly (bigint | string)[]): Promise<string> {
    const slots = words(await this.#call(selector, args));
    const first = slots[0];
    if (first === undefined) throw new ConformanceError(`${selector} returned no data`);
    return first;
  }

  async #call(selector: string, args: readonly (bigint | string)[]): Promise<string> {
    const result = await this.#transport.send({
      method: 'eth_call',
      params: [{ to: this.#contract, data: encodeCall(selector, args) }, this.#block],
    });
    if (typeof result !== 'string') throw new ConformanceError(`eth_call returned ${typeof result}`);
    return result;
  }
}
