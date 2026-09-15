import type { Instant, TokenId } from './types.ts';

/**
 * A contract call reverted.
 *
 * The ERC does not standardize revert reasons, so a revert is not
 * self-describing. The wallet never guesses at a cause from reason text; where
 * a cause matters it establishes it from protocol data instead — see
 * `ProjectionDoesNotCoverInstant`.
 */
export class ContractRevertError extends Error {
  readonly call: string;
  readonly data: string | undefined;

  constructor(call: string, data?: string) {
    super(`call reverted: ${call}`);
    this.name = 'ContractRevertError';
    this.call = call;
    this.data = data;
  }
}

/**
 * The instant asked about precedes the token's first entry.
 *
 * `entryAsOf` and `holderAsOf` revert there by specification. This is not a
 * fault: it means the projection does not cover the instant. Established by
 * comparing the instant against `entryAt(tokenId, 1).effectiveAt`, never by
 * reading a revert string.
 */
export class ProjectionDoesNotCoverInstant extends Error {
  readonly tokenId: TokenId;
  readonly instant: Instant;
  readonly firstEffectiveAt: Instant;

  constructor(tokenId: TokenId, instant: Instant, firstEffectiveAt: Instant) {
    super(
      `the projection for token ${tokenId} begins at ${firstEffectiveAt} ` +
        `and does not cover instant ${instant}`,
    );
    this.name = 'ProjectionDoesNotCoverInstant';
    this.tokenId = tokenId;
    this.instant = instant;
    this.firstEffectiveAt = firstEffectiveAt;
  }
}

/** A token has no entries at all; the projection has not been initialized. */
export class ProjectionNotInitialized extends Error {
  readonly tokenId: TokenId;

  constructor(tokenId: TokenId) {
    super(`token ${tokenId} has no admitted entries`);
    this.name = 'ProjectionNotInitialized';
    this.tokenId = tokenId;
  }
}

/**
 * The contract does not advertise the interface being read.
 *
 * Raised before any projection value is read, so the wallet cannot present
 * projection data for a contract that never claimed to have a projection.
 */
export class NonConformantContractError extends Error {
  readonly address: string;
  readonly interfaceId: string;

  constructor(address: string, interfaceId: string, what: string) {
    super(`${address} does not advertise ${interfaceId}; refusing to read ${what}`);
    this.name = 'NonConformantContractError';
    this.address = address;
    this.interfaceId = interfaceId;
  }
}

/**
 * A contract's immutable identity changed between reads.
 *
 * `registerId` and `verificationProfile` are specified as unchanging. A change
 * means the wallet is not talking to the contract it believes it is.
 */
export class IdentityChangedError extends Error {
  constructor(field: string, pinned: string, observed: string) {
    super(`${field} changed from ${pinned} to ${observed}; this value is specified as immutable`);
    this.name = 'IdentityChangedError';
  }
}

/** A value did not fit the protocol type it is declared as. */
export class ValueOutOfRangeError extends Error {
  constructor(what: string, value: bigint) {
    super(`${what} out of range: ${value}`);
    this.name = 'ValueOutOfRangeError';
  }
}

/** An invariant of the projection was violated by data the wallet was handed. */
export class InvariantViolationError extends Error {
  readonly invariant: string;

  constructor(invariant: string, detail: string) {
    super(`projection invariant violated (${invariant}): ${detail}`);
    this.name = 'InvariantViolationError';
    this.invariant = invariant;
  }
}
