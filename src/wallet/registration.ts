import type { Address, Bytes32, Instant } from '../sdk/types.ts';
import type { AssetView } from './assetView.ts';

/**
 * What a pending registration means to the person holding the token.
 *
 * Everything else in this wallet answers the protocol's questions. This
 * answers the holder's: what is happening, is it broken, do I do anything, how
 * far behind is it, and what if it drags. Those are different questions, and a
 * protocol-accurate panel that never addresses them has not done the job.
 *
 * Derived entirely from an `AssetView` — no extra reads, and no claim the two
 * sequences cannot already support.
 */

export type RegistrationState =
  /** The register has caught up with the position. */
  | 'level'
  /** A change is in flight, and it will bring the register level. */
  | 'registering'
  /** A change is in flight, and further transfers sit behind it. */
  | 'registering-with-more-behind'
  /** The position has moved and nothing is in flight to record it. */
  | 'behind-with-nothing-in-flight'
  /** The contract has no settlement interface, so nothing is ever in flight. */
  | 'no-gap-interface';

export type CommitmentWindow = {
  readonly deadline: Instant;
  readonly passed: boolean;
  /** Seconds remaining; negative once the deadline has passed. */
  readonly remaining: bigint;
  readonly note: string;
};

export type RegistrationView = {
  readonly state: RegistrationState;
  readonly headline: string;
  /** What this means, in a holder's terms. */
  readonly meaning: string;
  /** What, if anything, the holder does. */
  readonly action: string;
  /** Present only while a change is in flight. */
  readonly commitmentWindow: CommitmentWindow | undefined;
  /** The holder the in-flight change will record, when one is in flight. */
  readonly registering: Address | undefined;
  /**
   * Whether further transfers are known to sit behind the one in flight.
   *
   * Not a count. Counting hops would need the ERC-721 transfer history, which
   * the wallet does not read; what it can establish is that the position has
   * moved past what the in-flight change will record, so at least one more
   * registration must follow this one.
   */
  readonly furtherHopsBehind: boolean;
  /** Who to ask, and the limit of what the wallet can resolve. */
  readonly whoToAsk: string;
  readonly registerId: Bytes32;
};

const NEVER_BLOCKS =
  'Your token is not blocked and never will be by this. It can be transferred ' +
  'at any time; only the register is behind.';

const SERIAL =
  'Registration is sequential and physical: the token can change hands on ' +
  'chain every few minutes, while the register records each transfer one at a ' +
  'time — first one hop, then the next. No wallet or standard removes that lag.';

export function describeRegistration(view: AssetView): RegistrationView {
  const position = view.tradeablePosition.owner;
  const confirmed = view.confirmedHolder.holder;
  const gap = view.gap;

  const inFlight = gap.kind === 'open' ? gap.expectedHolder : undefined;
  const furtherHopsBehind = inFlight !== undefined && inFlight !== position;

  const state: RegistrationState =
    gap.kind === 'unsupported'
      ? 'no-gap-interface'
      : gap.kind === 'open'
        ? furtherHopsBehind
          ? 'registering-with-more-behind'
          : 'registering'
        : confirmed === position
          ? 'level'
          : 'behind-with-nothing-in-flight';

  return {
    state,
    headline: HEADLINES[state],
    meaning: meaningFor(state, { position, confirmed, inFlight }),
    action: ACTIONS[state],
    commitmentWindow:
      gap.kind === 'open'
        ? {
            deadline: gap.deadline,
            passed: gap.cancellable,
            remaining: gap.timeRemaining,
            note: gap.cancellable
              ? 'The window the register was given has passed. That is a signal the ' +
                'transfer being recorded may itself have an issue. What follows — ' +
                'whether a trade can be unwound, by whom, on what terms — is governed by ' +
                'the terms you agreed with your counterparty. It is not decided by this ' +
                'protocol and not by this wallet.'
              : 'The register has until this time under the agreed window. Nothing is ' +
                'wrong while it has not passed.',
          }
        : undefined,
    registering: inFlight,
    furtherHopsBehind,
    whoToAsk: whoToAsk(view),
    registerId: view.identity.registerId,
  };
}

const HEADLINES: Record<RegistrationState, string> = {
  level: 'The register is up to date',
  registering: 'A transfer is being registered',
  'registering-with-more-behind': 'A transfer is being registered, and more are behind it',
  'behind-with-nothing-in-flight': 'The register is behind, and nothing is being recorded',
  'no-gap-interface': 'This contract records no registrations in flight',
};

const ACTIONS: Record<RegistrationState, string> = {
  level: 'Nothing. The register and the position agree.',
  registering: 'Wait. There is nothing for you to do and nothing to fix.',
  'registering-with-more-behind':
    'Wait. There is nothing for you to do. Each transfer is recorded in turn, so ' +
    'yours follows the one in flight.',
  'behind-with-nothing-in-flight':
    'Wait, and watch the register. No change is currently in flight, so nothing ' +
    'will move until the registrar opens one.',
  'no-gap-interface':
    'Nothing here. This contract keeps a projection by other means, so it never ' +
    'reports a change in flight.',
};

function meaningFor(
  state: RegistrationState,
  parties: { position: Address; confirmed: Address; inFlight: Address | undefined },
): string {
  switch (state) {
    case 'level':
      return (
        `The register confirms ${parties.confirmed}, which is also the current ` +
        `position. Nothing is pending. ${NEVER_BLOCKS}`
      );
    case 'registering':
      return (
        `A previous transfer has not yet been recorded by the register. This is not a ` +
        `failure and not an error — it is the register catching up. The change in ` +
        `flight will record ${parties.inFlight}, bringing the register level with the ` +
        `position. ${SERIAL} ${NEVER_BLOCKS}`
      );
    case 'registering-with-more-behind':
      return (
        `A previous transfer has not yet been recorded. This is not a failure — it is ` +
        `the register catching up. The change in flight records ${parties.inFlight}, but ` +
        `the position has already moved on to ${parties.position}, so at least one more ` +
        `registration must follow this one before the register is level. ${SERIAL} ` +
        `${NEVER_BLOCKS}`
      );
    case 'behind-with-nothing-in-flight':
      return (
        `The register confirms ${parties.confirmed} while the position is ` +
        `${parties.position}, and no change is currently in flight to record the ` +
        `difference. This is not a failure; it means the registrar has not yet opened ` +
        `one. ${SERIAL} ${NEVER_BLOCKS}`
      );
    case 'no-gap-interface':
      return (
        'This contract offers no settlement interface, so it never reports a change ' +
        `in flight. The register confirms ${parties.confirmed}. ${NEVER_BLOCKS}`
      );
  }
}

/**
 * Who to ask, and what the wallet cannot tell you.
 *
 * `registerId` and the settlement authority are on-chain identifiers.
 * Resolving either to a party a person can contact is defined by the
 * verification profile and lives off chain. Saying so is better than leaving a
 * holder to conclude there is nobody to ask.
 */
function whoToAsk(view: AssetView): string {
  const authority =
    view.authority.account !== undefined && view.authority.authorized === true
      ? `Your own account may open a gap on this token, so you are one of the parties ` +
        `who can move the answer. `
      : '';
  return (
    `${authority}The register is identified on chain as ${view.identity.registerId}, and ` +
    `who may move the answer is answered by the contract for any account you name. ` +
    `Neither resolves to a name, an address or a contact from on-chain data alone — ` +
    `that mapping is defined by the verification profile and kept off chain. The wallet ` +
    `cannot look it up for you; your counterparty or the issuer can.`
  );
}
