const LABELS = {
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
export function describeContest(input) {
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
            explanation: 'This contract offers no settlement interface, so it has no gaps and no ' +
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
            explanation: 'No gap is open, so no instant on this token is contested. That is not ' +
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
