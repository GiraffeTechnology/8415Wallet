import type { Address, Instant } from '../sdk/types.ts';
import type { AssetView } from './assetView.ts';
import { describeRegistration, type RegistrationView } from './registration.ts';

/**
 * What someone about to acquire this token should know first.
 *
 * The same facts a current holder sees, framed for a decision not yet made.
 * Deliberately not a score, not a recommendation, and not a gate: whether the
 * risk is acceptable is the acquirer's decision, reflected in the terms they
 * agree, exactly as with any other settlement risk.
 */

export type AcquisitionDisclosure = {
  readonly tokenId: bigint;
  readonly position: Address;
  readonly confirmedHolder: Address;
  readonly registration: RegistrationView;
  /** Facts, each stated plainly. No ranking, no weighting. */
  readonly points: readonly string[];
  readonly boundary: string;
};

const BOUNDARY =
  'These are facts, not advice. This wallet does not score the token, does not ' +
  'say whether acquiring is wise, and does not prevent you from doing so. ' +
  'Whether this risk is acceptable is your decision, and what happens if it ' +
  'goes wrong is governed by the terms you agree with your counterparty.';

export function describeAcquisition(view: AssetView, at: Instant): AcquisitionDisclosure {
  const registration = describeRegistration(view);
  const points: string[] = [];

  points.push(
    `Acquiring the token moves the tradeable position to you immediately. It does ` +
      `not move the register: the register confirms ${view.confirmedHolder.holder}, ` +
      `and it will not confirm you until a transfer to you is recorded in turn.`,
  );

  points.push(
    `The instant you acquire at (${at}) will not be final at the moment it happens. ` +
      `The present instant never is — it is at or after the latest entry's effective ` +
      `time, so a later admission can still change what the register says about it.`,
  );

  if (registration.state === 'registering-with-more-behind') {
    points.push(
      `A registration is already in flight for a transfer that is not the current ` +
        `position, so at least one registration must complete before yours can even ` +
        `begin. You are joining a queue, not the front of one.`,
    );
  } else if (registration.state === 'registering') {
    points.push(
      `A registration is in flight for the current position. Yours would follow it.`,
    );
  } else if (registration.state === 'behind-with-nothing-in-flight') {
    points.push(
      `The register is behind the position and nothing is in flight to record it. ` +
        `Nothing will move until the registrar opens a change.`,
    );
  }

  if (view.gap.kind === 'open') {
    points.push(
      `The open gap runs to ${view.gap.deadline}` +
        (view.gap.cancellable
          ? `, and that time has already passed. Under the terms in force, a window ` +
            `that has passed may itself be a signal worth asking about.`
          : `. Nothing is wrong while that has not passed.`),
    );
  }

  if (view.gap.kind === 'unsupported') {
    points.push(
      'This contract offers no settlement interface, so it never reports a change in ' +
        'flight. That is a property of the contract, not evidence that the register is ' +
        'current.',
    );
  }

  points.push(
    `What this projects, and under whose rules, is identified on chain as register ` +
      `${view.identity.registerId}` +
      (view.identity.verificationProfile === undefined
        ? `, with no verification profile named — what it accepts as proof cannot be ` +
          `identified from here.`
        : ` under profile ${view.identity.verificationProfile}. Whether you accept that ` +
          `register and those proof rules is your decision to make before relying on any ` +
          `of this.`),
  );

  return {
    tokenId: view.tokenId,
    position: view.tradeablePosition.owner,
    confirmedHolder: view.confirmedHolder.holder,
    registration,
    points,
    boundary: BOUNDARY,
  };
}
