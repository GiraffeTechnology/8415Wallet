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

// Read-only linked responsibility preview. Separate from ERC state and signing.
export type * from './sdk/linked.ts';
export { buildLinkedChainView, readLinkedChainView, LinkedChainInputError } from './wallet/linkedChainView.ts';
export type { LinkedChainView } from './wallet/linkedChainView.ts';
export { renderLinkedChain } from './wallet/renderLinkedChain.ts';

// Views.
export { buildAssetView } from './wallet/assetView.ts';
export type * from './wallet/assetView.ts';
export { buildTemporalView } from './wallet/temporalQuery.ts';
export type * from './wallet/temporalQuery.ts';
export { buildHistoryView } from './wallet/history.ts';
export { buildOwnershipHistory } from './wallet/ownershipHistory.ts';
export type * from './wallet/ownershipHistory.ts';
export type * from './wallet/history.ts';
export { buildSettlementLog } from './wallet/settlementLog.ts';
export type * from './wallet/settlementLog.ts';
export { buildRiskSurfaces } from './wallet/riskSurfaces.ts';
export type * from './wallet/riskSurfaces.ts';
export { buildFreshnessView, noWatchtower } from './wallet/freshness.ts';
export type * from './wallet/freshness.ts';
export { buildEscrowView } from './wallet/escrowView.ts';
export type * from './wallet/escrowView.ts';
export { renderEscrow } from './wallet/renderEscrow.ts';
export { describeRegistration } from './wallet/registration.ts';
export type * from './wallet/registration.ts';
export { describeAcquisition } from './wallet/acquisition.ts';
export type * from './wallet/acquisition.ts';
export { describePosture } from './wallet/posture.ts';
export type * from './wallet/posture.ts';
export { detectCollisions } from './wallet/collisions.ts';
export { discoverHeldTokens } from './wallet/discovery.ts';
export type * from './wallet/discovery.ts';
export type * from './wallet/collisions.ts';
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
export {
  renderAcquisitionDisclosure,
  renderCollisions,
  renderOwnershipHistory,
  renderPosture,
  renderRegistration,
} from './wallet/renderHolderViews.ts';

// The backend seam, and the protocol types every view is expressed in.
export * from './sdk/index.ts';
export {
  buildBeginSettlement,
  buildCancelSettlement,
  buildFinalizeSettlement,
  revalidate,
  TransactionWouldRevertError,
} from './sdk/transactions.ts';
export type * from './sdk/transactions.ts';
export { bindByRegistrar, FRESHNESS_BY_INDEX } from './sdk/watchtower.ts';
export type * from './sdk/watchtower.ts';
export { checkReaderConformance } from './sdk/readerConformance.ts';
export type * from './sdk/readerConformance.ts';
export { decodeLog, EVENT_DEFINITIONS, tokenFilter, topicOf } from './sdk/events.ts';
export type * from './sdk/events.ts';

// Adapters. Two paths to the same register, behind one port: the chain
// directly, or the Native Infrastructure Kit's index for the projection reads
// with the chain still answering for the position, the clock and conformance.
export { AsynchronousRegistrar } from './adapters/memory/registrar.ts';
export type { PendingChange, RegistrarOptions } from './adapters/memory/registrar.ts';
export { RpcErc8415Reader } from './adapters/rpc/rpcReader.ts';
export { KitErc8415Reader, KitCapabilityError } from './adapters/kit/kitReader.ts';
export type { ChainCompanion, KitReaderOptions } from './adapters/kit/kitReader.ts';
export { KitProjectionApi, KitTransportError } from './adapters/kit/kitApi.ts';
export type { KitApiOptions, KitFetch, KitProjectionSummary, KitSettlement } from './adapters/kit/kitApi.ts';
export { RpcWatchtowerReader } from './adapters/rpc/watchtowerRpcReader.ts';
export { RpcEscrowReader } from './adapters/rpc/escrowRpcReader.ts';

// Signing. The one shipped signer keeps the key on the provider's side of the
// call; a raw-key signer is a script's business and satisfies the same type.
export {
  AccountMismatchError,
  ChainMismatchError,
  Eip1193Signer,
  RefusedFailingPreflightError,
} from './adapters/signing/eip1193Signer.ts';
export type { Eip1193Provider } from './adapters/signing/eip1193Signer.ts';
export { HttpCallTransport } from './adapters/rpc/transport.ts';
export type { CallTransport } from './adapters/rpc/transport.ts';
