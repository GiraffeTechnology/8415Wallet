import {
  cancelledGapToken,
  divergentToken,
  projectionOnlyToken,
  REGISTRAR,
  T,
} from '../adapters/memory/scenarios.ts';
import { buildAssetView } from '../wallet/assetView.ts';
import { buildHistoryView } from '../wallet/history.ts';
import { buildTemporalView } from '../wallet/temporalQuery.ts';
import { renderAssetView } from '../wallet/renderAssetView.ts';
import { renderHistory, renderTemporalQuery } from '../wallet/renderTemporalQuery.ts';
import { renderRiskSurfaces, renderSettlementLog } from '../wallet/renderGapView.ts';
import { buildRiskSurfaces } from '../wallet/riskSurfaces.ts';
import { buildSettlementLog } from '../wallet/settlementLog.ts';

/**
 * Reference client, Stages 2 through 4.
 *
 * Runs against the in-memory scenarios, because the Native Infrastructure Kit
 * exposes no Register API yet and there is no deployment to point at. Swapping
 * in `RpcErc8415Reader` is the only change needed to read a live contract;
 * nothing below the port would move.
 */

function banner(title: string): void {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}\n`);
}

async function main(): Promise<void> {
  const divergent = divergentToken();

  banner('Asset view — divergent position, open gap');
  console.log(
    renderAssetView(await buildAssetView(divergent.reader, divergent.tokenId, { account: REGISTRAR })),
  );

  banner('Asset view — projection without a settlement interface');
  const projectionOnly = projectionOnlyToken();
  console.log(renderAssetView(await buildAssetView(projectionOnly.reader, projectionOnly.tokenId)));

  // The three instants that exercise every branch of the finality rule, on one
  // token: provisional after the latest entry, final strictly before it, and
  // uncovered before the first.
  const probes: readonly [string, bigint][] = [
    ['Temporal query — 2026-01-01, after the latest entry', T.asOf],
    ['Temporal query — 2025-11-30, strictly before the latest entry', T.finalInstant],
    ['Temporal query — 2025-06-01, before the first entry', T.beforeFirstEntry],
  ];
  for (const [title, instant] of probes) {
    banner(title);
    console.log(renderTemporalQuery(await buildTemporalView(divergent.reader, divergent.tokenId, instant)));
  }

  banner('Projection history');
  console.log(renderHistory(await buildHistoryView(divergent.reader, divergent.tokenId)));

  banner('Settlement history — a gap that closed without admitting anything');
  const cancelled = cancelledGapToken();
  console.log(renderSettlementLog(await buildSettlementLog(cancelled.reader, cancelled.tokenId)));

  banner('Risk surfaces');
  console.log(
    renderRiskSurfaces(
      await buildRiskSurfaces(divergent.reader, divergent.tokenId, { account: REGISTRAR }),
    ),
  );
  console.log();
}

await main();
