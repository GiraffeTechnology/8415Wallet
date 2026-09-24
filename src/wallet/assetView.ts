import { detectConformance, requireProjectionConformance } from '../sdk/conformance.ts';
import { ProjectionNotInitialized } from '../sdk/errors.ts';
import { ContractIdentityPin, type ContractIdentity } from '../sdk/identity.ts';
import type { Erc8415Reader } from '../sdk/port.ts';
import {
  ZERO_BYTES32,
  type Address,
  type Bytes32,
  type Conformance,
  type Instant,
  type TokenId,
  type Version,
} from '../sdk/types.ts';

/**
 * The asset view.
 *
 * Its whole job is to keep two facts adjacent and separate: the tradeable
 * position, and the holder the register has confirmed. Every field below
 * belongs to exactly one of them, and nothing derives one from the other.
 */

/** `ownerOf`. The ERC-721 position, which moves when the market moves. */
export type TradeablePositionView = {
  readonly owner: Address;
  readonly disclosure: string;
};

/** The latest admitted entry. The register's record, which moves only on admission. */
export type ConfirmedHolderView = {
  readonly holder: Address;
  readonly version: Version;
  readonly effectiveAt: Instant;
  readonly recordCommitment: Bytes32;
  readonly previousCommitment: Bytes32;
  /** An opaque locator. Never resolved, never rendered as content. */
  readonly registryReference: Bytes32;
  readonly entryCount: bigint;
  readonly disclosure: string;
};

/**
 * Whether the two currently agree.
 *
 * Divergence is reported as a fact, never as an error or a warning: the token
 * trades while the register catches up, and that is the design the ERC exists
 * to make visible.
 */
export type AlignmentView = {
  readonly aligned: boolean;
  readonly note: string;
};

/**
 * Finality of the present instant.
 *
 * Read from `isFinalAsOf`, not assumed. The rule guarantees the present is
 * never final — it is at or after the latest entry's effective time — but the
 * wallet is forbidden from recomputing finality, so it asks and reports what
 * it was told. A `true` here would mean the contract contradicts the rule, and
 * that is worth seeing rather than asserting away.
 */
export type PresentFinalityView = {
  readonly instant: Instant;
  readonly final: boolean;
  readonly latestEffectiveAt: Instant;
  readonly explanation: string;
};

/**
 * Gap state.
 *
 * `unsupported` and `none` are different answers and are kept apart: a
 * contract offering no settlement interface has no gaps at all, which is a
 * property of the contract, not an observation that none happens to be open.
 */
export type GapView =
  | { readonly kind: 'unsupported'; readonly note: string }
  | { readonly kind: 'none'; readonly note: string }
  | {
      readonly kind: 'open';
      readonly settlementId: Bytes32;
      readonly initiator: Address;
      readonly expectedHolder: Address;
      readonly snapshotHash: Bytes32;
      readonly openedAt: Instant;
      readonly deadline: Instant;
      readonly settlementPeriod: bigint;
      /** Deadline minus now. Negative once the deadline has passed. */
      readonly timeRemaining: bigint;
      /** Cancellation becomes possible only after the deadline. */
      readonly cancellable: boolean;
      /**
       * The instant from which this gap makes the token contested.
       *
       * Contested is a signal separate from finality; combining it with a
       * queried instant is the temporal view's job, not this one's.
       */
      readonly contestedFrom: Instant;
      readonly note: string;
    };

/** Who may move the answer. */
export type AuthorityView = {
  /** The account asked about, when the wallet has one. */
  readonly account: Address | undefined;
  /** Undefined when no account was supplied, or the contract cannot be asked. */
  readonly authorized: boolean | undefined;
  readonly note: string;
};

export type AssetView = {
  readonly identity: ContractIdentity;
  readonly conformance: Conformance;
  readonly tokenId: TokenId;
  /** The chain clock at the moment this view was built. */
  readonly observedAt: Instant;
  readonly tradeablePosition: TradeablePositionView;
  readonly confirmedHolder: ConfirmedHolderView;
  readonly alignment: AlignmentView;
  readonly presentFinality: PresentFinalityView;
  readonly gap: GapView;
  readonly authority: AuthorityView;
  /**
   * The maximum a gap may run for, from `settlementPeriod`.
   *
   * Part of contract identity, not of any particular gap: it bounds how long a
   * future gap could hold instants contested, which is worth seeing while none
   * is open. `undefined` when the contract offers no settlement interface.
   */
  readonly settlementPeriod: bigint | undefined;
  readonly identityNote: string;
};

export type AssetViewOptions = {
  /** The account to report settlement authority for. */
  readonly account?: Address;
  /** Reuse a pin across views so identity drift is caught between reads. */
  readonly identityPin?: ContractIdentityPin;
};

const DISCLOSURE_POSITION =
  'The ERC-721 position. It moves the moment the market moves, and it is not ' +
  'the confirmed holder at any instant.';

const DISCLOSURE_HOLDER =
  'The holder the register has confirmed, from the latest admitted entry. It ' +
  'moves only through proof-verified admission.';

const NOTE_ALIGNED =
  'The position and the confirmed holder currently agree. They are still two ' +
  'separate facts, and they may diverge again at any time. Agreement is not ' +
  'verified identity: the protocol does not, and cannot, check that these two ' +
  'records refer to the same underlying right. It reports what each side says.';

const NOTE_DIVERGED =
  'The position and the confirmed holder currently differ. This is the design, ' +
  'not a fault: the token keeps trading while the register catches up. Neither ' +
  'agreement nor divergence is verified identity — the protocol does not, and ' +
  'cannot, check that these two records refer to the same underlying right.';

const NOTE_IDENTITY_WITH_PROFILE =
  'This projection is attributable to the register and profile above. Whether ' +
  'to accept them is your decision; reading them is not approving them.';

const NOTE_IDENTITY_WITHOUT_PROFILE =
  'This projection is attributable to the register above. The contract names ' +
  'no verification profile, so what it accepts as proof cannot be checked ' +
  'from here. Whether to accept the register is your decision.';

const NOTE_NO_SETTLEMENT_INTERFACE =
  'This contract offers no settlement interface, so it has no gaps and no ' +
  'contested instants at all. That is a property of the contract, not an ' +
  'observation that no gap is open.';

const NOTE_NO_OPEN_GAP =
  'No gap is open. An interval in which none is open and none is begun is an ' +
  'interval the projection cannot move in.';

const NOTE_OPEN_GAP =
  'A change is in flight. An open gap says what is expected, not what has ' +
  'settled, and closing it does not by itself make any instant final.';

/**
 * Build the asset view for a token.
 *
 * Conformance is checked before anything from the projection is read, so a
 * contract that never claimed a projection cannot have one displayed for it.
 */
export async function buildAssetView(
  reader: Erc8415Reader,
  tokenId: TokenId,
  options: AssetViewOptions = {},
): Promise<AssetView> {
  const conformance = await detectConformance(reader);
  requireProjectionConformance(reader, conformance);

  const pin = options.identityPin ?? new ContractIdentityPin(reader);
  const identity = await pin.read(conformance);

  const observedAt = await reader.chainInstant();
  const owner = await reader.ownerOf(tokenId);

  const entryCount = await reader.entryCount(tokenId);
  if (entryCount === 0n) {
    // No entries means the projection has not been initialized. The wallet
    // says so rather than presenting the position as if it were the record.
    throw new ProjectionNotInitialized(tokenId);
  }
  const latest = await reader.currentEntry(tokenId);

  const presentFinal = await reader.isFinalAsOf(tokenId, observedAt);

  return {
    identity,
    conformance,
    tokenId,
    observedAt,
    tradeablePosition: { owner, disclosure: DISCLOSURE_POSITION },
    confirmedHolder: {
      holder: latest.holder,
      version: latest.version,
      effectiveAt: latest.effectiveAt,
      recordCommitment: latest.recordCommitment,
      previousCommitment: latest.previousCommitment,
      registryReference: latest.registryReference,
      entryCount,
      disclosure: DISCLOSURE_HOLDER,
    },
    alignment: {
      aligned: owner === latest.holder,
      note: owner === latest.holder ? NOTE_ALIGNED : NOTE_DIVERGED,
    },
    presentFinality: {
      instant: observedAt,
      final: presentFinal,
      latestEffectiveAt: latest.effectiveAt,
      explanation: explainPresentFinality(presentFinal, observedAt, latest.effectiveAt),
    },
    gap: await buildGapView(reader, tokenId, conformance, observedAt),
    settlementPeriod:
      conformance.settlement && reader.settlementPeriod !== undefined
        ? await reader.settlementPeriod()
        : undefined,
    authority: await buildAuthorityView(reader, tokenId, conformance, options.account),
    identityNote:
      identity.verificationProfile === undefined
        ? NOTE_IDENTITY_WITHOUT_PROFILE
        : NOTE_IDENTITY_WITH_PROFILE,
  };
}

function explainPresentFinality(
  final: boolean,
  observedAt: Instant,
  latestEffectiveAt: Instant,
): string {
  if (final) {
    return (
      `The contract reports the present instant (${observedAt}) as final, which ` +
      `the finality rule does not allow: it is at or after the latest entry's ` +
      `effective time (${latestEffectiveAt}). Treat this contract's answers with suspicion.`
    );
  }
  return (
    `The present instant is at or after the latest entry's effective time ` +
    `(${latestEffectiveAt}), so it is provisional, as every present instant is. ` +
    `It becomes final once an entry with a later effective time is admitted — ` +
    `including a confirming entry naming the same holder.`
  );
}

async function buildGapView(
  reader: Erc8415Reader,
  tokenId: TokenId,
  conformance: Conformance,
  observedAt: Instant,
): Promise<GapView> {
  if (!conformance.settlement || reader.openGapOf === undefined) {
    return { kind: 'unsupported', note: NOTE_NO_SETTLEMENT_INTERFACE };
  }

  const settlementId = await reader.openGapOf(tokenId);
  if (settlementId === ZERO_BYTES32) {
    return { kind: 'none', note: NOTE_NO_OPEN_GAP };
  }

  const record = await reader.settlement!(settlementId);
  const settlementPeriod = await reader.settlementPeriod!();
  const timeRemaining = record.deadline - observedAt;

  return {
    kind: 'open',
    settlementId,
    initiator: record.initiator,
    expectedHolder: record.expectedHolder,
    snapshotHash: record.snapshotHash,
    openedAt: record.openedAt,
    deadline: record.deadline,
    settlementPeriod,
    timeRemaining,
    cancellable: observedAt > record.deadline,
    contestedFrom: record.openedAt,
    note: NOTE_OPEN_GAP,
  };
}

async function buildAuthorityView(
  reader: Erc8415Reader,
  tokenId: TokenId,
  conformance: Conformance,
  account: Address | undefined,
): Promise<AuthorityView> {
  if (!conformance.settlement || reader.isSettlementAuthority === undefined) {
    return {
      account,
      authorized: undefined,
      note:
        'This contract offers no settlement interface, so there is no authority ' +
        'to report. The projection is maintained by other means.',
    };
  }
  if (account === undefined) {
    return {
      account: undefined,
      authorized: undefined,
      note:
        'No account supplied, so no authority is reported. Who may open a gap ' +
        'is a separate question from who owns the token.',
    };
  }

  const authorized = await reader.isSettlementAuthority(tokenId, account);
  return {
    account,
    authorized,
    note: authorized
      ? 'This account may open a gap on this token, and can therefore advance ' +
        'the projection — or hold a gap open by superseding.'
      : 'This account may not open a gap on this token. Owning the token does ' +
        'not confer the authority.',
  };
}
