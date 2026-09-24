import { BackendDisagreementError, InvariantViolationError } from '../../sdk/errors.ts';
import type { LogFilter, RawLog } from '../../sdk/events.ts';
import type {
  ChainClockReader,
  Erc165Reader,
  Erc721Reader,
  Erc8415Reader,
  LogReader,
  ProjectionSettlementReader,
} from '../../sdk/port.ts';
import {
  ZERO_BYTES32,
  type Address,
  type Bytes32,
  type Bytes4,
  type Instant,
  type RegisterEntry,
  type Settlement,
  type TokenId,
  type Version,
} from '../../sdk/types.ts';
import { KitProjectionApi, type KitSettlement } from './kitApi.ts';

/**
 * The facts the Kit's projection API does not serve, and a chain reader does.
 *
 * This is not a shortfall to be worked around. The Kit projects a register; it
 * is not a node, and three of the things a wallet has to show are properties
 * of the chain rather than of the register:
 *
 *  - `ownerOf`, the tradeable position. The whole point of ERC-8415 is that
 *    the position and the confirmed holder are different facts, so an indexer
 *    that served both from one store would be asserting exactly the identity
 *    the standard exists to deny.
 *  - `supportsInterface`, which is how a deployment advertises conformance.
 *    An indexer vouching for a contract it indexes is circular.
 *  - `block.timestamp`, which dates a gap's deadline and decides that the
 *    present instant is never final.
 *
 * So a Kit-backed reader is a chain reader with its projection reads
 * accelerated, never a replacement for one. `RpcErc8415Reader` satisfies this
 * shape as it stands.
 */
export type ChainCompanion = Erc165Reader &
  ChainClockReader &
  Erc721Reader &
  Partial<Pick<ProjectionSettlementReader, 'settlement' | 'settlementPeriod' | 'isSettlementAuthority'>> &
  Partial<LogReader>;

export type KitReaderOptions = {
  /**
   * Cross-check the Kit's `registerId` and `verificationProfile` against the
   * chain's on the first read that needs them.
   *
   * On by default. Reading the register record from an indexer is only as
   * sound as the claim that the indexer is indexing this deployment, and that
   * claim is cheap to check exactly once: both values are specified immutable.
   */
  readonly crossCheckIdentity?: boolean;
  /** The chain's own `registerId()`/`verificationProfile()`, for that check. */
  readonly chainIdentity?: {
    registerId(): Promise<Bytes32>;
    verificationProfile?(): Promise<Bytes32>;
  };
};

/**
 * Reads an ERC-8415 projection through the Native Infrastructure Kit.
 *
 * Same port, same guarantees, different path to the same register: the entry
 * walk, temporal resolution and finality come from the Kit's index in one
 * round trip apiece instead of one `eth_call` apiece, while the position, the
 * clock, conformance and the settlement surface stay on chain.
 *
 * This adapter computes one thing and says so: `currentEntry`, which the API
 * has no route for, is read as `entryAt(entryCount)` and then checked against
 * what the latest entry must satisfy. Everything else came off the wire.
 */
export class KitErc8415Reader implements Erc8415Reader {
  readonly source: { readonly chainId: bigint; readonly address: Address };
  readonly #api: KitProjectionApi;
  readonly #chain: ChainCompanion;
  readonly #options: KitReaderOptions;
  #identityChecked = false;

  constructor(
    api: KitProjectionApi,
    chain: ChainCompanion,
    source: { chainId: bigint; address: Address },
    options: KitReaderOptions = {},
  ) {
    this.#api = api;
    this.#chain = chain;
    this.#options = options;
    this.source = { chainId: source.chainId, address: source.address };
  }

  // ---- Chain facts. Delegated, never synthesised. --------------------------

  async supportsInterface(interfaceId: Bytes4): Promise<boolean> {
    return this.#chain.supportsInterface(interfaceId);
  }

  async ownerOf(tokenId: TokenId): Promise<Address> {
    return this.#chain.ownerOf(tokenId);
  }

  async chainInstant(): Promise<Instant> {
    return this.#chain.chainInstant();
  }

  async chainInstantAt(blockNumber: bigint): Promise<Instant> {
    const at = this.#chain.chainInstantAt;
    if (at === undefined) {
      throw new KitCapabilityError('chainInstantAt', 'the chain companion does not date blocks');
    }
    return at.call(this.#chain, blockNumber);
  }

  async getLogs(filter: LogFilter): Promise<readonly RawLog[]> {
    const getLogs = this.#chain.getLogs;
    if (getLogs === undefined) {
      throw new KitCapabilityError('getLogs', 'the chain companion does not read logs');
    }
    return getLogs.call(this.#chain, filter);
  }

  async settlementPeriod(): Promise<bigint> {
    const read = this.#chain.settlementPeriod;
    if (read === undefined) {
      throw new KitCapabilityError('settlementPeriod', 'the Kit API does not serve it');
    }
    return read.call(this.#chain);
  }

  async isSettlementAuthority(tokenId: TokenId, account: Address): Promise<boolean> {
    const read = this.#chain.isSettlementAuthority;
    if (read === undefined) {
      throw new KitCapabilityError('isSettlementAuthority', 'the Kit API does not serve it');
    }
    return read.call(this.#chain, tokenId, account);
  }

  /**
   * Settlement records, including closed ones.
   *
   * The Kit API exposes only the gap currently open, so a closed settlement —
   * which is most of the settlement history a wallet shows — is read from the
   * chain. When the chain companion offers no settlement surface, the open gap
   * can still be answered from the Kit; anything else is refused rather than
   * returned as a zeroed record, because a zeroed record reads as `NONE` and
   * `NONE` is a claim that nothing was ever attempted.
   */
  async settlement(settlementId: Bytes32): Promise<Settlement> {
    const read = this.#chain.settlement;
    if (read !== undefined) return read.call(this.#chain, settlementId);

    throw new KitCapabilityError(
      'settlement',
      'the Kit API serves only the open gap and the chain companion has no settlement surface',
    );
  }

  // ---- Projection facts. From the Kit. ------------------------------------

  /**
   * Register identity, which the API carries on every token summary.
   *
   * Asked against token 0 because the value belongs to the register, not the
   * token: the route answers it for a token with no entries just as readily,
   * so this needs no token to be chosen or guessed.
   */
  async registerId(): Promise<Bytes32> {
    return (await this.#summary(0n)).registerId;
  }

  async verificationProfile(): Promise<Bytes32> {
    return (await this.#summary(0n)).verificationProfile;
  }

  async entryCount(tokenId: TokenId): Promise<bigint> {
    return (await this.#summary(tokenId)).entryCount;
  }

  async openGapOf(tokenId: TokenId): Promise<Bytes32> {
    const gap = (await this.#summary(tokenId)).openGap;
    return gap === undefined ? ZERO_BYTES32 : gap.settlementId;
  }

  async entryAt(tokenId: TokenId, version: Version): Promise<RegisterEntry> {
    return this.#api.entryAt(tokenId, version);
  }

  async entryAsOf(tokenId: TokenId, instant: Instant): Promise<RegisterEntry> {
    return this.#api.entryAsOf(tokenId, instant);
  }

  async holderAsOf(tokenId: TokenId, instant: Instant): Promise<Address> {
    return this.#api.holderAsOf(tokenId, instant);
  }

  async isFinalAsOf(tokenId: TokenId, instant: Instant): Promise<boolean> {
    return this.#api.isFinalAsOf(tokenId, instant);
  }

  /**
   * The latest entry.
   *
   * The API has no `currentEntry` route, so this is two reads: the count, then
   * that version. It leans on the projection's second invariant — versions run
   * consecutively from 1 — and then refuses to pass the result through unless
   * it actually is the latest entry. A count and a version that disagree mean
   * the two reads straddled an admission or the index is inconsistent; either
   * way the entry in hand is not the current one and must not be labelled as
   * such.
   */
  async currentEntry(tokenId: TokenId): Promise<RegisterEntry> {
    const count = (await this.#summary(tokenId)).entryCount;
    const entry = await this.#api.entryAt(tokenId, count);
    if (entry.version !== count) {
      throw new InvariantViolationError(
        'consecutive versions',
        `entryAt(${count}) reports version ${entry.version}`,
      );
    }
    if (entry.supersededAt !== 0n) {
      throw new InvariantViolationError(
        'open latest interval',
        `the entry at version ${count} was superseded at ${entry.supersededAt}, so it is not the latest`,
      );
    }
    return entry;
  }

  /** The open gap in full, without a second round trip for its record. */
  async openGap(tokenId: TokenId): Promise<KitSettlement | undefined> {
    return (await this.#summary(tokenId)).openGap;
  }

  async #summary(tokenId: TokenId) {
    const summary = await this.#api.summary(tokenId);
    await this.#assertSameRegister(summary.registerId, summary.verificationProfile);
    return summary;
  }

  /**
   * Check once that the indexer and the chain are talking about one register.
   *
   * Only once: both values are specified immutable, so a per-read check would
   * cost a chain call for a fact that cannot change. What it catches is a
   * misconfiguration at the seam — a Kit base URL or API key pointing at
   * another deployment — which is the failure mode a second backend
   * introduces and the one a wallet cannot afford to absorb silently.
   */
  async #assertSameRegister(registerId: Bytes32, verificationProfile: Bytes32): Promise<void> {
    if (this.#identityChecked) return;
    if (this.#options.crossCheckIdentity === false) return;
    const identity = this.#options.chainIdentity;
    if (identity === undefined) return;

    // Set before awaiting, so concurrent first reads do not each spend a call.
    this.#identityChecked = true;

    const onChainRegisterId = await identity.registerId();
    if (onChainRegisterId !== registerId) {
      throw new BackendDisagreementError('registerId', registerId, onChainRegisterId);
    }
    if (identity.verificationProfile !== undefined) {
      const onChainProfile = await identity.verificationProfile();
      if (onChainProfile !== verificationProfile) {
        throw new BackendDisagreementError(
          'verificationProfile',
          verificationProfile,
          onChainProfile,
        );
      }
    }
  }
}

/**
 * A read this reader cannot serve from either half.
 *
 * Distinct from a revert and from a backend fault: the projection was not
 * asked and did not answer. Raised rather than defaulted, so a view cannot
 * render an absent capability as a negative fact.
 */
export class KitCapabilityError extends Error {
  readonly call: string;

  constructor(call: string, why: string) {
    super(`${call} is not available through this reader: ${why}`);
    this.name = 'KitCapabilityError';
    this.call = call;
  }
}
