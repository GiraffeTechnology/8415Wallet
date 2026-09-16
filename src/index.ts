/**
 * The wallet's public surface.
 *
 * Two seams, deliberately separate. `Erc8415Reader` is where a backend plugs
 * in — an RPC node, the Native Infrastructure Kit, anything that can relay a
 * contract's answers faithfully. `WalletSession` is where an application plugs
 * in, and is what an integrator should reach for.
 *
 * Nothing here can move a projection except through the three settlement
 * operations the ERC defines, and nothing here ever holds key material.
 */

// The application seam.
export { WalletSession } from './wallet/session.ts';

// Views.
export { buildAssetView } from './wallet/assetView.ts';
export type * from './wallet/assetView.ts';
export { buildTemporalView } from './wallet/temporalQuery.ts';
export type * from './wallet/temporalQuery.ts';
export { buildHistoryView } from './wallet/history.ts';
export type * from './wallet/history.ts';
export { buildSettlementLog } from './wallet/settlementLog.ts';
export type * from './wallet/settlementLog.ts';
export { buildRiskSurfaces } from './wallet/riskSurfaces.ts';
export type * from './wallet/riskSurfaces.ts';
export { buildFreshnessView, noWatchtower } from './wallet/freshness.ts';
export type * from './wallet/freshness.ts';
export { describeContest } from './wallet/contested.ts';
export type * from './wallet/contested.ts';
export { describeFinality } from './wallet/finality.ts';
export type * from './wallet/finality.ts';
export { AUDIT_SCHEMA, exportAuditTrail, serialiseAuditTrail } from './wallet/auditTrail.ts';
export type { AuditTrail } from './wallet/auditTrail.ts';

// Presentation. Optional: a caller may render the view models itself.
export { formatAddress, formatDuration, formatInstant, shortHex } from './wallet/format.ts';
export { renderAssetView } from './wallet/renderAssetView.ts';
export { renderHistory, renderTemporalQuery } from './wallet/renderTemporalQuery.ts';
export { renderRiskSurfaces, renderSettlementLog } from './wallet/renderGapView.ts';
export { renderFreshness } from './wallet/renderFreshness.ts';

// The backend seam, and the protocol types every view is expressed in.
export * from './sdk/index.ts';
export {
  buildBeginSettlement,
  buildCancelSettlement,
  buildFinalizeSettlement,
  TransactionWouldRevertError,
} from './sdk/transactions.ts';
export type * from './sdk/transactions.ts';
export { bindByRegistrar, FRESHNESS_BY_INDEX } from './sdk/watchtower.ts';
export type * from './sdk/watchtower.ts';
export { checkReaderConformance } from './sdk/readerConformance.ts';
export type * from './sdk/readerConformance.ts';
export { decodeLog, EVENT_DEFINITIONS, tokenFilter, topicOf } from './sdk/events.ts';
export type * from './sdk/events.ts';

// Adapters.
export { RpcErc8415Reader } from './adapters/rpc/rpcReader.ts';
export { RpcWatchtowerReader } from './adapters/rpc/watchtowerRpcReader.ts';
export { HttpCallTransport } from './adapters/rpc/transport.ts';
export type { CallTransport } from './adapters/rpc/transport.ts';
