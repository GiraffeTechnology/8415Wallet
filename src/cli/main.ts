import {
  cancelledGapToken,
  divergentToken,
  projectionOnlyToken,
  OPEN_GAP_ID,
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
import { serialiseAuditTrail } from '../wallet/auditTrail.ts';
import { WalletSession } from '../wallet/session.ts';
import { buildFreshnessView } from '../wallet/freshness.ts';
import { renderFreshness } from '../wallet/renderFreshness.ts';
import {
  MemoryWatchtowerContract,
  MemoryWatchtowerReader,
} from '../adapters/memory/watchtower.ts';

/**
 * Reference client.
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

  banner('Watchtower freshness — a separate signal, on a separate contract');
  const tower = new MemoryWatchtowerContract({ blockNumber: 1_000n });
  const assetId = `0x${'a5'.repeat(32)}`;
  tower.registerAsset(assetId, {
    steward: REGISTRAR,
    finalityDepth: 32n,
    maxFreshnessThreshold: 1_000n,
  });
  tower.submit(assetId, {
    signedAtBlock: 1_000n,
    sequenceNumber: 1n,
    freshnessThreshold: 500n,
    key: '0x9e900000000000000000000000000000000000aa',
  });
  tower.advanceBlocks(40n);
  const towerReader = new MemoryWatchtowerReader(tower);
  console.log(
    renderFreshness(
      await buildFreshnessView({
        reader: towerReader,
        assetId,
        provenance: 'configured',
        claimedRegisterId: await divergent.reader.registerId(),
      }),
    ),
  );

  banner('Risk surfaces');
  console.log(
    renderRiskSurfaces(
      await buildRiskSurfaces(divergent.reader, divergent.tokenId, { account: REGISTRAR }),
    ),
  );
  banner('Acting on it — building a transaction, with preflight');
  const session = new WalletSession(divergent.reader, { account: REGISTRAR });
  divergent.contract.advanceTo(T.openGapDeadline + 1n);
  const cancel = await session.transactions.cancelSettlement({
    settlementId: OPEN_GAP_ID,
    reasonHash: `0x${'99'.repeat(32)}`,
  });
  console.log(`  ${cancel.kind}  ->  ${cancel.to}  (chain ${cancel.chainId}, value ${cancel.value})`);
  console.log(`  from ${cancel.from}`);
  console.log(`  data ${cancel.data.slice(0, 26)}…  ${(cancel.data.length - 2) / 2} bytes\n`);
  console.log(`  ${cancel.summary}\n`);
  for (const check of cancel.preflight.checks) {
    console.log(`  [${check.outcome.padEnd(12)}] ${check.name}`);
  }
  console.log();
  for (const note of cancel.preflight.consequences) {
    console.log(`  ! ${note}`);
  }
  console.log('\n  The wallet holds no key. Signing and sending is the signer\u2019s.');

  banner('Audit trail (excerpt)');
  const trail = await session.auditTrail(divergent.tokenId);
  console.log(
    serialiseAuditTrail({ ...trail, notes: [trail.notes[0]!], entries: trail.entries.slice(-1) }),
  );
}

await main();
