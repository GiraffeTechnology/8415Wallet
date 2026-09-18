import type { Address, Bytes32, Instant, TokenId, Version } from './types.ts';

/**
 * The read surface of a `ProjectionEscrow` deployment.
 *
 * The escrow is an application built on the projection, not part of the
 * standard, so it sits in its own port rather than being folded into
 * `Erc8415Reader`. Nothing in the projection knows the escrow exists, and
 * nothing here may be mistaken for a protocol fact.
 *
 * As with the projection, the wallet holds no write path: `open`, `fund`,
 * `release`, `refund` and `abandon` are transactions a user's own key sends.
 */

/** Lifecycle of one trade. Mirrors the contract's enum ordering. */
export type TradeState =
  | 'NONE'
  | 'AWAITING_PAYMENT'
  | 'FUNDED'
  | 'RELEASED'
  | 'REFUNDED'
  | 'ABANDONED';

export const TRADE_STATE_BY_INDEX: readonly TradeState[] = [
  'NONE',
  'AWAITING_PAYMENT',
  'FUNDED',
  'RELEASED',
  'REFUNDED',
  'ABANDONED',
];

/** The terms of a trade, as recorded when it was opened and funded. */
export type Trade = {
  readonly projection: Address;
  readonly tokenId: TokenId;
  readonly seller: Address;
  readonly buyer: Address;
  /** In wei. */
  readonly price: bigint;
  /** `entryCount` at the moment the trade was funded; zero before that. */
  readonly entryCountAtFunding: Version;
  readonly admissionDeadline: Instant;
  readonly maxEffectiveAt: Instant;
  readonly state: TradeState;
};

/**
 * One atomic reading of a trade against its register.
 *
 * Every field arrives from a single `observe` call, so the facts cannot be
 * taken from different states. They stay separate values on purpose:
 * `confirmed` is whether the escrow's release condition holds, `confirmedHolder`
 * is who the register records, and `positionHolder` is `ownerOf` — which is the
 * escrow itself while a trade is live, and is never the same fact as the
 * confirmed holder.
 */
export type TradeObservation = {
  readonly state: TradeState;
  /** Whether release would succeed if called now. Not a claim of finality. */
  readonly confirmed: boolean;
  /** Version and effective time of the confirming entry; zero when there is none. */
  readonly version: Version;
  readonly effectiveAt: Instant;
  /** The register's latest holder. Zero when the projection has no entries. */
  readonly confirmedHolder: Address;
  /** `ownerOf`. Zero when the token does not exist. */
  readonly positionHolder: Address;
  readonly entryCount: Version;
};

export type EscrowReader = {
  tradeOf(tradeId: Bytes32): Promise<Trade>;
  observe(tradeId: Bytes32): Promise<TradeObservation>;
  readonly source: { readonly chainId: bigint; readonly address: Address };
};
