import type { Erc8415Reader } from '../../sdk/port.ts';
import type {
  Address,
  Bytes32,
  Bytes4,
  Instant,
  RegisterEntry,
  Settlement,
  TokenId,
  Version,
} from '../../sdk/types.ts';
import type { MemoryRegisterContract } from './register.ts';

/**
 * Binds the modelled contract to the SDK port.
 *
 * Deliberately a thin pass-through with no logic of its own: an adapter that
 * smoothed over a revert or filled in a missing value would be answering
 * questions the contract did not answer, which is the failure mode the port
 * exists to prevent. It sits exactly where the rpc adapter sits, so nothing
 * above can tell which one it is talking to.
 */
export class MemoryErc8415Reader implements Erc8415Reader {
  readonly source: { readonly chainId: bigint; readonly address: Address };
  readonly #contract: MemoryRegisterContract;

  constructor(contract: MemoryRegisterContract) {
    this.#contract = contract;
    this.source = { chainId: contract.chainId, address: contract.address };
  }

  async chainInstant(): Promise<Instant> {
    return this.#contract.now;
  }

  async supportsInterface(interfaceId: Bytes4): Promise<boolean> {
    return this.#contract.supportsInterface(interfaceId);
  }

  async ownerOf(tokenId: TokenId): Promise<Address> {
    return this.#contract.ownerOf(tokenId);
  }

  async currentEntry(tokenId: TokenId): Promise<RegisterEntry> {
    return this.#contract.currentEntry(tokenId);
  }

  async entryAt(tokenId: TokenId, version: Version): Promise<RegisterEntry> {
    return this.#contract.entryAt(tokenId, version);
  }

  async entryAsOf(tokenId: TokenId, instant: Instant): Promise<RegisterEntry> {
    return this.#contract.entryAsOf(tokenId, instant);
  }

  async holderAsOf(tokenId: TokenId, instant: Instant): Promise<Address> {
    return this.#contract.holderAsOf(tokenId, instant);
  }

  async isFinalAsOf(tokenId: TokenId, instant: Instant): Promise<boolean> {
    return this.#contract.isFinalAsOf(tokenId, instant);
  }

  async entryCount(tokenId: TokenId): Promise<bigint> {
    return this.#contract.entryCount(tokenId);
  }

  async registerId(): Promise<Bytes32> {
    return this.#contract.registerId();
  }

  async settlement(settlementId: Bytes32): Promise<Settlement> {
    return this.#contract.settlement(settlementId);
  }

  async openGapOf(tokenId: TokenId): Promise<Bytes32> {
    return this.#contract.openGapOf(tokenId);
  }

  async settlementPeriod(): Promise<bigint> {
    return this.#contract.settlementPeriod();
  }

  async verificationProfile(): Promise<Bytes32> {
    return this.#contract.verificationProfile();
  }

  async isSettlementAuthority(tokenId: TokenId, account: Address): Promise<boolean> {
    return this.#contract.isSettlementAuthority(tokenId, account);
  }
}
