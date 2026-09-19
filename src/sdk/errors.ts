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

/**
 * The node did not answer.
 *
 * Unreachable, rate limited, refusing a query it considers too broad, or
 * returning something that is not a reply. None of these is a statement about
 * the contract, and none may be rendered as one: a wallet that reports an
 * absent backend as a fact about who holds an asset is worse than one that
 * reports nothing.
 *
 * Kept apart from `ContractRevertError` because that distinction has already
 * failed once here. An unreachable endpoint was reported as "the contract does
 * not advertise `0x6309e170`", and a provider refusing an over-wide log range
 * was reported as `call reverted`. Both were transport conditions wearing a
 * contract's clothes.
 */
export class TransportError extends Error {
  readonly method: string;
  readonly code: number | undefined;

  constructor(method: string, detail: string, code?: number) {
    super(`${method}: ${detail}`);
    this.name = 'TransportError';
    this.method = method;
    this.code = code;
  }
}

/**
 * There is no contract at the address being read.
 *
 * `eth_call` against an address with no code does not revert and does not
 * fail: it succeeds and returns nothing. Left to the ABI decoder that surfaces
 * as a complaint about a truncated payload — "return payload for 1 word(s)
 * (got 0 bytes)" — which reads like a fault in the wallet rather than a
 * mistyped address or the wrong chain.
 *
 * Named separately from non-conformance on purpose. "This address does not
 * advertise `0x6309e170`" sends someone looking for a conformance problem in a
 * contract that is not there at all.
 */
export class NoContractAtAddressError extends Error {
  readonly address: string;
  readonly call: string;

  constructor(address: string, call: string) {
    super(`no contract at ${address}: ${call} returned no data`);
    this.name = 'NoContractAtAddressError';
    this.address = address;
    this.call = call;
  }
}
