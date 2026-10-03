/** Text presentation only; no field is relabelled as execution or legal finality. */
export function renderLinkedChain(view) {
    const lines = [
        'Linked responsibility — READ-ONLY SNAPSHOT',
        `Chain ${view.asset.chainId}, contract ${view.asset.contract}, token ${view.asset.tokenId}`,
        `Sequence ${view.sequenceId}, revision ${view.revision}`,
        `Observed block ${view.blockNumber} (${view.blockHash})`,
        `Evidence: ${view.evidenceStatus}`,
        `ERC temporal finality: ${view.protocolFinality === null ? 'unavailable' : view.protocolFinality ? 'final' : 'provisional'}`,
    ];
    for (const leg of view.legs) {
        lines.push(`Leg ${leg.id}: ${leg.seller} -> ${leg.buyer}`, `  Recorded outcome: ${leg.outcome}; completion predicate: ${leg.completionPredicate}`, `  Control: ${leg.control.controlId}; acceptance: ${leg.control.acceptanceHash}`);
    }
    lines.push(
    // Detached legs are counted in two places on purpose: the ones this snapshot
    // carries, and the ones it does not because they left the chain. Reporting
    // only the first would say "0 detached" about a chain that has detached
    // hundreds, which is the opposite of true.
    `Detached history in this snapshot: ${view.detachedLegIds.length}`, ...(view.offChainDetached > 0n
        ? [`Detached and held off chain: ${view.offChainDetached}` +
                ` (records at the register; commitment ${view.detachedCommitment})`]
        : []), `Predicate-satisfying prefix (not executed): ${view.completionPrefix.length}`, `Return boundary: ${view.returnBoundary.account} (occurrence ${view.returnBoundary.occurrenceId})`, view.note);
    return lines.join('\n');
}
