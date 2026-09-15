import type { Bytes32, Instant, Settlement, TokenId } from '../sdk/types.ts';

/**
 * Whether an instant is contested.
 *
 * An instant is contested when a gap is open on the token and that gap opened
 * at or before the instant. It is a signal about what is expected, and it is
 * not finality: finality does not depend on whether a gap is open, and closing
 * one does not by itself make any instant final. The ERC requires the two to
 * be distinguishable, so they are computed apart and displayed apart.
 *
 * It is present tense. Once a gap closes — by admission or by cancellation —
 * no instant is contested any more, even though instants at or after the
 * latest entry remain non-final. A contract with no settlement interface has
 * no gaps and therefore no contested instants at all.
 */

export type ContestDisplay = 'contested' | 'not-contested' | 'no-gap-interface';

export type ContestView = {
  readonly tokenId: TokenId;
  readonly instant: Instant;
  readonly display: ContestDisplay;
  readonly label: string;
  /** The open gap making it contested, when one does. */
  readonly settlementId: Bytes32 | undefined;
  readonly openedAt: Instant | undefined;
  readonly deadline: Instant | undefined;
  readonly explanation: string;
};

const LABELS: Record<ContestDisplay, string> = {
  contested: 'Contested',
  'not-contested': 'Not contested',
  'no-gap-interface': 'No gap interface on this contract',
};

/**
 * Decide contest for an instant.
 *
 * `gap` is the open settlement, or `undefined` when none is open. Pass
 * `hasSettlementInterface: false` for a contract that offers none — that is a
 * different answer from "none is open", and is kept as one.
 */
export function describeContest(input: {
  tokenId: TokenId;
  instant: Instant;
  hasSettlementInterface: boolean;
  gap: { settlementId: Bytes32; record: Settlement } | undefined;
}): ContestView {
  const { tokenId, instant, hasSettlementInterface, gap } = input;
  const base = { tokenId, instant };

  if (!hasSettlementInterface) {
    return {
      ...base,
      display: 'no-gap-interface',
      label: LABELS['no-gap-interface'],
      settlementId: undefined,
      openedAt: undefined,
      deadline: undefined,
      explanation:
        'This contract offers no settlement interface, so it has no gaps and no ' +
        'contested instants. Nothing here says anything about finality.',
    };
  }

  if (gap === undefined) {
    return {
      ...base,
      display: 'not-contested',
      label: LABELS['not-contested'],
      settlementId: undefined,
      openedAt: undefined,
      deadline: undefined,
      explanation:
        'No gap is open, so no instant on this token is contested. That is not ' +
        'a statement about finality: instants at or after the latest entry are ' +
        'still provisional, and closing a gap did not change that.',
    };
  }

  const contested = gap.record.openedAt <= instant;
  return {
    ...base,
    display: contested ? 'contested' : 'not-contested',
    label: contested ? LABELS.contested : LABELS['not-contested'],
    settlementId: gap.settlementId,
    openedAt: gap.record.openedAt,
    deadline: gap.record.deadline,
    explanation: contested
      ? `A gap opened at ${gap.record.openedAt}, at or before this instant, so a ` +
        `change covering it is in flight. This says what is expected, not what ` +
        `has settled — and closing this gap will not by itself make this instant final.`
      : `A gap is open, but it opened at ${gap.record.openedAt}, after this instant, ` +
        `so it does not contest it. Contest is bounded by the gap's opening time.`,
  };
}
