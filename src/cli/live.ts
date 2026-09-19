import { KitProjectionApi } from '../adapters/kit/kitApi.ts';
import { KitErc8415Reader } from '../adapters/kit/kitReader.ts';
import { RpcErc8415Reader } from '../adapters/rpc/rpcReader.ts';
import { HttpCallTransport } from '../adapters/rpc/transport.ts';
import { RpcWatchtowerReader } from '../adapters/rpc/watchtowerRpcReader.ts';
import { ProjectionNotInitialized } from '../sdk/errors.ts';
import type { WatchtowerBinding } from '../sdk/watchtower.ts';
import { discoverHeldTokens } from '../wallet/discovery.ts';
import { renderAssetView } from '../wallet/renderAssetView.ts';
import { renderFreshness } from '../wallet/renderFreshness.ts';
import { renderRiskSurfaces, renderSettlementLog } from '../wallet/renderGapView.ts';
import { renderOwnershipHistory, renderRegistration } from '../wallet/renderHolderViews.ts';
import { renderHistory, renderTemporalQuery } from '../wallet/renderTemporalQuery.ts';
import { WalletSession } from '../wallet/session.ts';
import type { CliOptions } from './args.ts';

/** Read a live deployment through the same views the scenarios use. */
export async function runLive(options: CliOptions, banner: (title: string) => void): Promise<void> {
  const transport = new HttpCallTransport(options.rpc!);
  const chain = new RpcErc8415Reader(transport, options.chainId ?? 1n, options.contract!, {
    ...(options.fromBlock === undefined ? {} : { fromBlock: options.fromBlock }),
  });

  /**
   * With `--kit`, the projection is read through the index and everything else
   * stays on chain. Both paths satisfy `Erc8415Reader`, so nothing below this
   * line can tell which one it was handed — which is the property that makes
   * the choice a deployment decision rather than a different wallet.
   */
  const reader =
    options.kit === undefined
      ? chain
      : new KitErc8415Reader(
          new KitProjectionApi({
            baseUrl: options.kit,
            ...(options.kitKey === undefined ? {} : { apiKey: options.kitKey }),
          }),
          chain,
          chain.source,
          { chainIdentity: chain },
        );

  const watchtower: WatchtowerBinding | undefined =
    options.watchtower === undefined || options.assetId === undefined
      ? undefined
      : {
          reader: new RpcWatchtowerReader(transport, options.chainId ?? 1n, options.watchtower),
          assetId: options.assetId,
          provenance: 'configured',
          claimedRegisterId: await reader.registerId(),
        };

  const session = new WalletSession(reader, {
    ...(options.account === undefined ? {} : { account: options.account }),
    ...(watchtower === undefined ? {} : { watchtower }),
  });

  let tokenId = options.token;

  if (tokenId === undefined && options.account !== undefined) {
    banner(`Tokens held by ${options.account}`);
    const found = await discoverHeldTokens(reader, options.account);
    if (!found.available) {
      console.log(`  ${found.note}`);
      return;
    }
    if (found.held.length === 0) {
      console.log('  None found.\n');
      console.log(`  ${found.note}`);
      return;
    }
    for (const token of found.held) {
      console.log(
        `  token ${token.tokenId}` +
          (token.hasProjection ? '' : '   (no projection entries on this contract)'),
      );
    }
    console.log(`\n  ${found.note}`);
    // Inspect the first one that actually has a projection to show.
    tokenId = found.held.find((token) => token.hasProjection)?.tokenId;
    if (tokenId === undefined) return;
  }

  if (tokenId === undefined) return;

  banner(`Asset view — token ${tokenId}`);
  console.log(renderAssetView(await session.assetView(tokenId)));

  banner('What this means for the holder');
  console.log(renderRegistration(await session.registration(tokenId)));

  const instant = options.instant ?? (await reader.chainInstant());
  banner(`Temporal query — as of ${instant}`);
  console.log(renderTemporalQuery(await session.temporalQuery(tokenId, instant)));

  banner('Projection history');
  console.log(renderHistory(await session.history(tokenId)));

  banner('Both sequences on one timeline');
  console.log(renderOwnershipHistory(await session.ownershipHistory(tokenId)));

  banner('Settlement history');
  console.log(renderSettlementLog(await session.settlementLog(tokenId)));

  if (watchtower !== undefined) {
    banner('Watchtower freshness');
    console.log(renderFreshness(await session.freshness()));
  }

  banner('Risk surfaces');
  console.log(renderRiskSurfaces(await session.riskSurfaces(tokenId)));
}

/** Turn the errors a live read actually produces into something readable. */
export function explainFailure(error: unknown): string {
  if (error instanceof ProjectionNotInitialized) {
    return `${error.message}. The contract advertises a projection but this token has no admitted entries yet.`;
  }
  if (error instanceof Error && /fetch failed|ECONNREFUSED|ENOTFOUND/i.test(error.message)) {
    return `Could not reach the JSON-RPC endpoint: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
