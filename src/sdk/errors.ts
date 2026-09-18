import type { TokenId } from './types.ts';

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

/**
 * Two backends answering for the same contract disagree about its identity.
 *
 * `registerId` and `verificationProfile` are specified as immutable, so two
 * faithful readers of one deployment must report the same pair. A mismatch
 * means at least one of them is answering for something else — an indexer
 * pointed at the wrong register, a tenant misrouted, a stale mirror — and the
 * wallet has no basis for choosing which. It reports the disagreement instead
 * of picking a side.
 */
export class BackendDisagreementError extends Error {
  readonly field: string;

  constructor(field: string, fromBackend: string, fromChain: string) {
    super(
      `${field} differs between backends: the indexer reports ${fromBackend}, the chain reports ${fromChain}`,
    );
    this.name = 'BackendDisagreementError';
    this.field = field;
  }
}
