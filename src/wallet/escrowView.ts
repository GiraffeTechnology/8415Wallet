import type { Trade, TradeObservation } from '../sdk/escrow.ts';
import type { Address, Instant, Version } from '../sdk/types.ts';

/**
 * What a trade held in escrow means to the person in it.
 *
 * The contract answers whether release would succeed. This answers the two
 * questions a party actually has — what is happening, and what do I do — and
 * one the contract cannot ask on its own behalf: how much of this is settled.
 *
 * The answer to the last one is "less than it looks", and saying so is the
 * whole job. Release happens on a record the register has admitted but not
 * closed, because an instant is final only once a later entry exists and the
 * admitting entry's own effective time therefore never is. A panel that
 * reported a released trade as final would be describing a guarantee the
 * standard does not offer. This one reports the release, and separately
 * reports that the instant it rests on can still be overtaken.
 */

export type EscrowState =
  /** The asset is locked and the buyer has not paid. */
  | 'awaiting-payment'
  /** Both sides are in, and the register has not confirmed the buyer yet. */
  | 'waiting-for-the-register'
  /** The register has confirmed the buyer. Release is available to anyone. */
  | 'confirmed'
  /** The deadline passed without a confirmation. Return is available to anyone. */
  | 'deadline-passed'
  | 'released'
  | 'returned'
  | 'taken-back'
  | 'no-such-trade';

export type DeadlineWindow = {
  readonly deadline: Instant;
  readonly passed: boolean;
  /** Seconds remaining; negative once the deadline has passed. */
  readonly remaining: bigint;
};

export type EscrowView = {
  readonly state: EscrowState;
  readonly headline: string;
  /** What this means, in a party's terms. */
  readonly meaning: string;
  /** What, if anything, anyone does next. */
  readonly action: string;
  /**
   * The two sequences, kept apart.
   *
   * While a trade is live the position sits with the escrow contract and the
   * confirmed holder is whoever the register last admitted — usually still the
   * seller. They are supposed to differ here; that divergence is the thing
   * being escrowed against, not a fault.
   */
  readonly positionHolder: Address;
  readonly confirmedHolder: Address;
  readonly buyer: Address;
  readonly seller: Address;
  readonly price: bigint;
  /** The entry that confirmed the buyer, once one exists. */
  readonly confirmingVersion: Version | undefined;
  readonly confirmingEffectiveAt: Instant | undefined;
  /** Absent before the trade is funded, when no clock is running. */
  readonly window: DeadlineWindow | undefined;
  /**
   * Stated whenever the trade rests on a confirmation.
   *
   * Not a warning to dismiss: it is the accurate description of what the
   * register has said, and the reason release did not wait for more.
   */
  readonly provisionalNote: string | undefined;
};

export function buildEscrowView(
  trade: Trade,
  observation: TradeObservation,
  now: Instant,
): EscrowView {
  const state = classify(trade, observation, now);
  const window =
    trade.state === 'FUNDED'
      ? {
          deadline: trade.admissionDeadline,
          passed: now > trade.admissionDeadline,
          remaining: trade.admissionDeadline - now,
        }
      : undefined;

  const confirming = observation.version === 0n ? undefined : observation.version;

  return {
    state,
    headline: HEADLINE[state],
    meaning: MEANING[state],
    action: ACTION[state],
    positionHolder: observation.positionHolder,
    confirmedHolder: observation.confirmedHolder,
    buyer: trade.buyer,
    seller: trade.seller,
    price: trade.price,
    confirmingVersion: confirming,
    confirmingEffectiveAt: confirming === undefined ? undefined : observation.effectiveAt,
    window,
    provisionalNote:
      state === 'confirmed' || state === 'released' ? PROVISIONAL : undefined,
  };
}

function classify(trade: Trade, observation: TradeObservation, now: Instant): EscrowState {
  switch (trade.state) {
    case 'NONE':
      return 'no-such-trade';
    case 'AWAITING_PAYMENT':
      return 'awaiting-payment';
    case 'RELEASED':
      return 'released';
    case 'REFUNDED':
      return 'returned';
    case 'ABANDONED':
      return 'taken-back';
    case 'FUNDED':
      // A confirmation outranks the clock: `refund` refuses once the register
      // has confirmed the buyer, however late that was, so a trade past its
      // deadline with a confirmation in hand is still a released trade waiting
      // to happen rather than a returned one.
      if (observation.confirmed) return 'confirmed';
      return now > trade.admissionDeadline ? 'deadline-passed' : 'waiting-for-the-register';
  }
}

const PROVISIONAL =
  'The register has admitted this confirmation; it has not closed it. An instant ' +
  'becomes final only once a later entry exists, so the entry that names the buyer ' +
  'is not final at the moment it lands, and a further admission could still be ' +
  'made for an earlier effective time. Release does not wait for that, because ' +
  'waiting would mean waiting on an unrelated future change that may never come.';

const HEADLINE: Record<EscrowState, string> = {
  'awaiting-payment': 'the asset is locked, the payment is not in',
  'waiting-for-the-register': 'both sides are in, the register has not confirmed the buyer',
  confirmed: 'the register has confirmed the buyer; release is available',
  'deadline-passed': 'the deadline passed without a confirmation; return is available',
  released: 'released to the buyer',
  returned: 'returned to both parties',
  'taken-back': 'the seller withdrew the asset before payment',
  'no-such-trade': 'no trade under this identifier',
};

const MEANING: Record<EscrowState, string> = {
  'awaiting-payment':
    'The seller has handed the token to the escrow. Nothing is committed until the ' +
    'buyer pays in full, and the seller can withdraw it until then.',
  'waiting-for-the-register':
    'The token and the payment are both held. The register still names someone other ' +
    'than the buyer, which is the ordinary state of a trade in flight rather than a ' +
    'sign of trouble: a confirmation arrives when a proof is admitted, which happens ' +
    'after the trade, not with it.',
  confirmed:
    'A new entry names the buyer as the confirmed holder, its version is later than ' +
    'the one recorded when this trade was funded, and its effective time is inside ' +
    'the bound the parties agreed. Those three together are what this escrow was ' +
    'waiting for.',
  'deadline-passed':
    'The register did not confirm the buyer within the agreed window. This is not a ' +
    'finding that anyone was refused — the protocol has no rejection, and a ' +
    'cancelled settlement ends a contest without deciding anything. It is only that ' +
    'the time the parties allowed has run out.',
  released:
    'The token went to the buyer and the payment went to the seller, against a ' +
    'confirmation the register had admitted.',
  returned:
    'The token went back to the seller and the payment back to the buyer. Nothing ' +
    'about the register changed, and nothing here records a fault by either party.',
  'taken-back':
    'The seller withdrew the token before the buyer paid. No payment was ever held.',
  'no-such-trade': 'The escrow has no record under this identifier.',
};

const ACTION: Record<EscrowState, string> = {
  'awaiting-payment':
    'The buyer pays the exact price to commit. The seller may withdraw the token ' +
    'until they do.',
  'waiting-for-the-register':
    'Nothing, and nothing either party does here speeds it up: admitting an entry is ' +
    "the register's to do, through a settlement, and this escrow has no authority " +
    'over it. Watch the deadline.',
  confirmed:
    'Anyone may call release — the condition is public, so neither party can hold ' +
    'the trade up by declining to.',
  'deadline-passed':
    'Anyone may call return. It will refuse if a confirmation lands first, so a ' +
    'late admission still settles the trade rather than losing to the clock.',
  released: 'Nothing. The trade is done.',
  returned: 'Nothing. The trade is done.',
  'taken-back': 'Nothing. The trade never began.',
  'no-such-trade': 'Check the identifier.',
};
