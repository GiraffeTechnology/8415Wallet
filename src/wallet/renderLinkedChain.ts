import type { LinkedChainView } from './linkedChainView.ts';

/** Text presentation only; no field is relabelled as execution or legal finality. */
export function renderLinkedChain(view: LinkedChainView): string {
  const lines = [
    'Linked responsibility — READ-ONLY SNAPSHOT',
    `Chain ${view.asset.chainId}, contract ${view.asset.contract}, token ${view.asset.tokenId}`,
    `Sequence ${view.sequenceId}, revision ${view.revision}`,
    `Observed block ${view.blockNumber} (${view.blockHash})`,
    `Evidence: ${view.evidenceStatus}`,
    `ERC temporal finality: ${view.protocolFinality === null ? 'unavailable' : view.protocolFinality ? 'final' : 'provisional'}`,
  ];
  for (const leg of view.legs) {
    lines.push(
      `Leg ${leg.id}: ${leg.seller} -> ${leg.buyer}`,
      `  Recorded outcome: ${leg.outcome}; completion predicate: ${leg.completionPredicate}`,
      `  Original payer: ${leg.originalPayer}; principal: ${leg.principal} base units; asset: ${leg.paymentAsset}`,
    );
  }
  lines.push(
    `Detached history: ${view.detachedLegIds.length}`,
    `Predicate-satisfying prefix (not executed): ${view.completionPrefix.length}`,
    `Return boundary: ${view.returnBoundary.account} (occurrence ${view.returnBoundary.occurrenceId})`,
    view.note,
  );
  return lines.join('\n');
}
