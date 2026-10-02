/** Additive browser entry, no filesystem store or automatically connecting transport. */
export * from './controls/index.ts';
export { WalletSession } from './wallet/session.ts';
export { RpcErc8415Reader } from './adapters/rpc/rpcReader.ts';
export { Eip1193ReadTransport } from './adapters/signing/eip1193ReadTransport.ts';
export { renderAssetView } from './wallet/renderAssetView.ts';
export { renderTemporalQuery, renderHistory } from './wallet/renderTemporalQuery.ts';
export { renderRiskSurfaces, renderSettlementLog } from './wallet/renderGapView.ts';
export { renderRegistration, renderAcquisitionDisclosure, renderOwnershipHistory, renderPosture } from './wallet/renderHolderViews.ts';
export { verifyControlDeployment, controlRpc } from './controls/authorization.ts';
export { renderCollisions } from './wallet/renderHolderViews.ts';
export { CollisionScanError } from './wallet/collisions.ts';
export { reviewAgentRequest, XIONGAN_PROFILE } from './xiongan/agentRequest.ts';
export { recoveryGuidance } from './xiongan/recoveryView.ts';
export { ExternalAssetSession, ASSET_CHAINS, parseAssetState } from './xiongan/externalAssets.ts';
