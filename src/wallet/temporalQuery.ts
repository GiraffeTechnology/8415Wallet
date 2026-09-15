import { detectConformance, requireProjectionConformance } from '../sdk/conformance.ts';
import { ContractRevertError, ProjectionNotInitialized } from '../sdk/errors.ts';
import { ContractIdentityPin, type ContractIdentity } from '../sdk/identity.ts';
import type { Erc8415Reader } from '../sdk/port.ts';
import type { Address, Conformance, Instant, RegisterEntry, TokenId } from '../sdk/types.ts';
import { describeFinality, type FinalityView } from './finality.ts';

/**
 * The temporal query: who did the register confirm at instant t, and can that
 * answer still change.
 *
 * Resolution and finality are asked separately because they are different
 * questions, and only one of them is answered by reading an entry. An instant
 * always resolves if the projection covers it; whether the answer can still
 * change is what `isFinalAsOf` says, and `entryAsOf` returns an answer either
 * way. Treating the second as implied by the first is the integration error
 * the ERC names as most likely.
 */

/** The interval an entry is in force for. `until` is absent while it is the latest. */
export type EffectiveInterval = {
  readonly from: Instant;
  readonly until: Instant | undefined;
};

export type TemporalResolution =
  | {
      readonly kind: 'resolved';
      readonly holder: Address;
      readonly entry: RegisterEntry;
      readonly interval: EffectiveInterval;
      /**
       * The ERC requires `holderAsOf` to agree with `entryAsOf`. A
       * disagreement is a contract fault, and is surfaced rather than
       * resolved in favour of either.
       */
      readonly holderAgreesWithEntry: boolean;
    }
  | {
      readonly kind: 'not-covered';
      readonly firstEffectiveAt: Instant;
      readonly note: string;
    }
  | {
      readonly kind: 'unavailable';
      readonly reason: string;
      readonly note: string;
    };

export type TemporalView = {
  readonly identity: ContractIdentity;
  readonly conformance: Conformance;
  readonly tokenId: TokenId;
  /** The instant asked about. */
  readonly instant: Instant;
  /** The chain clock when the query ran. */
  readonly observedAt: Instant;
  readonly entryCount: bigint;
  readonly resolution: TemporalResolution;
  readonly finality: FinalityView;
  /** Shown for contrast, never as the answer. */
  readonly tradeablePosition: { readonly owner: Address; readonly disclosure: string };
};

export type TemporalQueryOptions = {
  readonly identityPin?: ContractIdentityPin;
};

const NOTE_NOT_COVERED =
  'The projection does not cover this instant: it precedes the first admitted ' +
  'entry. `entryAsOf` and `holderAsOf` revert here by specification. This is ' +
  'not a fault, and it is not an answer of "no holder" either — the register ' +
  'simply says nothing about this instant.';

const NOTE_UNAVAILABLE =
  'The projection could not be read for this instant. No neighbouring ' +
  'instant, cached answer, or `ownerOf` has been substituted.';

const DISCLOSURE_POSITION =
  'The ERC-721 position as of now. A claim made against a past instant does ' +
  'not care who holds the token now.';

/**
 * Resolve a token at an instant.
 *
 * The contract is asked first and its revert is classified afterwards, rather
 * than the wallet deciding in advance which question the contract would
 * decline. The classification uses entry v1's effective time, never a revert
 * reason — the ERC does not standardize those.
 */
export async function buildTemporalView(
  reader: Erc8415Reader,
  tokenId: TokenId,
  instant: Instant,
  options: TemporalQueryOptions = {},
): Promise<TemporalView> {
  const conformance = await detectConformance(reader);
  requireProjectionConformance(reader, conformance);

  const pin = options.identityPin ?? new ContractIdentityPin(reader);
  const identity = await pin.read(conformance);

  const observedAt = await reader.chainInstant();
  const entryCount = await reader.entryCount(tokenId);
  if (entryCount === 0n) {
    throw new ProjectionNotInitialized(tokenId);
  }

  const first = await reader.entryAt(tokenId, 1n);
  const latest = await reader.currentEntry(tokenId);

  let reportedFinal: boolean | undefined;
  let finalityFailure: string | undefined;
  try {
    reportedFinal = await reader.isFinalAsOf(tokenId, instant);
  } catch (error) {
    // isFinalAsOf is specified never to revert, so a failure here is a
    // transport or contract fault, not a property of the instant.
    finalityFailure = error instanceof Error ? error.message : String(error);
  }

  return {
    identity,
    conformance,
    tokenId,
    instant,
    observedAt,
    entryCount,
    resolution: await resolve(reader, tokenId, instant, first.effectiveAt),
    finality: describeFinality({
      tokenId,
      instant,
      reported: reportedFinal,
      firstEffectiveAt: first.effectiveAt,
      latestEffectiveAt: latest.effectiveAt,
      ...(finalityFailure === undefined ? {} : { unavailableReason: finalityFailure }),
    }),
    tradeablePosition: {
      owner: await reader.ownerOf(tokenId),
      disclosure: DISCLOSURE_POSITION,
    },
  };
}

async function resolve(
  reader: Erc8415Reader,
  tokenId: TokenId,
  instant: Instant,
  firstEffectiveAt: Instant,
): Promise<TemporalResolution> {
  let entry: RegisterEntry;
  try {
    entry = await reader.entryAsOf(tokenId, instant);
  } catch (error) {
    if (!(error instanceof ContractRevertError)) throw error;
    // Classify the revert from protocol data. Anything else stays unattributed
    // rather than being reported as a cause the wallet cannot establish.
    if (instant < firstEffectiveAt) {
      return { kind: 'not-covered', firstEffectiveAt, note: NOTE_NOT_COVERED };
    }
    return { kind: 'unavailable', reason: error.message, note: NOTE_UNAVAILABLE };
  }

  let holder: Address;
  try {
    holder = await reader.holderAsOf(tokenId, instant);
  } catch (error) {
    if (!(error instanceof ContractRevertError)) throw error;
    return { kind: 'unavailable', reason: error.message, note: NOTE_UNAVAILABLE };
  }

  return {
    kind: 'resolved',
    holder,
    entry,
    interval: {
      from: entry.effectiveAt,
      until: entry.supersededAt === 0n ? undefined : entry.supersededAt,
    },
    holderAgreesWithEntry: holder === entry.holder,
  };
}
