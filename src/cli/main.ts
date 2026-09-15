import { divergentToken, projectionOnlyToken, REGISTRAR } from '../adapters/memory/scenarios.ts';
import { buildAssetView } from '../wallet/assetView.ts';
import { renderAssetView } from '../wallet/renderAssetView.ts';

/**
 * Reference client, Stage 2.
 *
 * Runs the asset view against the in-memory scenarios, because the Native
 * Infrastructure Kit exposes no Register API yet and there is no deployment to
 * point at. Swapping in `RpcErc8415Reader` is the only change needed to read a
 * live contract; nothing below the port would move.
 */
async function main(): Promise<void> {
  const scenarios = [
    { title: 'Divergent position, open gap', scenario: divergentToken() },
    { title: 'Projection without a settlement interface', scenario: projectionOnlyToken() },
  ];

  for (const { title, scenario } of scenarios) {
    const view = await buildAssetView(scenario.reader, scenario.tokenId, { account: REGISTRAR });
    console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}\n`);
    console.log(renderAssetView(view));
  }
  console.log();
}

await main();
