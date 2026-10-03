const LABELS = {
    final: 'Final',
    provisional: 'Provisional',
    'not-covered': 'Not final — the projection does not cover this instant',
    unavailable: 'Unavailable — no answer was obtained',
};
/**
 * Describe a finality answer.
 *
 * `reported` is taken from `isFinalAsOf` and is never second-guessed: this
 * function chooses wording and explains the boundary, it does not decide.
 * Where the reported answer contradicts the rule the ERC states, that is said
 * plainly rather than smoothed over — a contract that contradicts the rule is
 * worth seeing.
 */
export function describeFinality(input) {
    const { tokenId, instant, reported, firstEffectiveAt, latestEffectiveAt } = input;
    const base = { tokenId, instant, reported, firstEffectiveAt, latestEffectiveAt };
    if (reported === undefined) {
        return {
            ...base,
            display: 'unavailable',
            label: LABELS.unavailable,
            explanation: `No finality answer was obtained${input.unavailableReason === undefined ? '' : `: ${input.unavailableReason}`}. ` +
                'The wallet does not guess, and does not fall back to either answer.',
        };
    }
    const uncovered = firstEffectiveAt !== undefined && instant < firstEffectiveAt;
    if (reported) {
        const explanation = uncovered
            ? `The contract reports this instant as final although it precedes the first ` +
                `entry's effective time (${firstEffectiveAt}), which the finality rule does ` +
                `not allow. Treat this contract's answers with suspicion.`
            : `No entry admitted in the future can change the holder at this instant: it ` +
                `is at or after the first entry's effective time (${firstEffectiveAt ?? 'unknown'}) ` +
                `and strictly before the latest entry's (${latestEffectiveAt ?? 'unknown'}). ` +
                `This is finality of the projection's answer, not legal finality.`;
        return { ...base, display: 'final', label: LABELS.final, explanation };
    }
    if (uncovered) {
        return {
            ...base,
            display: 'not-covered',
            label: LABELS['not-covered'],
            explanation: `This instant precedes the first entry's effective time (${firstEffectiveAt}), so ` +
                `the projection resolves no holder for it. \`isFinalAsOf\` answers false here ` +
                `without reverting, which is what it is specified to do — it is not an error.`,
        };
    }
    return {
        ...base,
        display: 'provisional',
        label: LABELS.provisional,
        explanation: `This instant is at or after the latest entry's effective time ` +
            `(${latestEffectiveAt ?? 'unknown'}), so a later admission may carry an earlier ` +
            `effective time and supersede this answer. It becomes final once an entry with a ` +
            `later effective time is admitted — including a confirming entry naming the same ` +
            `holder. This is not a statement of legal finality either way.`,
    };
}
