import type {
  Address,
  Bytes32,
  Bytes4,
  Instant,
  RegisterEntry,
  Settlement,
  TokenId,
  Version,
} from './types.ts';

/**
 * ERC-165 discovery, the entry point to every other read.
 */
export type Erc165Reader = {
  supportsInterface(interfaceId: Bytes4): Promise<boolean>;
};

/** The ERC-721 facts the wallet reads, alongside but never merged with the projection. */
export type Erc721Reader = {
  /** The tradeable position. Never the confirmed holder. */
  ownerOf(tokenId: TokenId): Promise<Address>;
};

/**
 * `IRegisterProjection`, ERC-165 `0x6309e170`.
 *
 * Reverting behaviour is part of the contract and is preserved here:
 * `entryAsOf` and `holderAsOf` reject an instant preceding the first entry,
 * while `isFinalAsOf` answers `false` for it without reverting.
 */
export type RegisterProjectionReader = {
  currentEntry(tokenId: TokenId): Promise<RegisterEntry>;
  entryAt(tokenId: TokenId, version: Version): Promise<RegisterEntry>;
  entryAsOf(tokenId: TokenId, instant: Instant): Promise<RegisterEntry>;
  holderAsOf(tokenId: TokenId, instant: Instant): Promise<Address>;
  isFinalAsOf(tokenId: TokenId, instant: Instant): Promise<boolean>;
  entryCount(tokenId: TokenId): Promise<bigint>;
  registerId(): Promise<Bytes32>;
};

/**
 * `IProjectionSettlement`, ERC-165 `0xf4a7d71b`.
 *
 * Only the read surface. The wallet holds no write path into the projection:
 * `beginSettlement`, `finalizeSettlement` and `cancelSettlement` are
 * transactions a user's own key sends, built in the transaction layer with the
 * authority check shown first, and deliberately absent from the read port.
 */
export type ProjectionSettlementReader = {
  settlement(settlementId: Bytes32): Promise<Settlement>;
  /** Zero when no gap is open. */
  openGapOf(tokenId: TokenId): Promise<Bytes32>;
  settlementPeriod(): Promise<bigint>;
  verificationProfile(): Promise<Bytes32>;
  isSettlementAuthority(tokenId: TokenId, account: Address): Promise<boolean>;
};

/**
 * The wallet's single window onto an ERC-8415 contract.
 *
 * The settlement half is optional: projection conformance and settlement
 * conformance are advertised separately, and a contract offering no settlement
 * interface has no gaps and no contested instants.
 */
export type Erc8415Reader = Erc165Reader &
  Erc721Reader &
  RegisterProjectionReader &
  Partial<ProjectionSettlementReader> & {
    /** Chain and contract this reader is bound to, for provenance labelling. */
    readonly source: { readonly chainId: bigint; readonly address: Address };
  };
