/**
 * UNVALIDATED development entry point. Separate from the stable wallet surface.
 * Importing does not read a key, request a signature, send a transaction or start a process.
 * Do not release until the deferred unified validation and independent audit are complete.
 */
export { ControlAdapterError, forwardConsentDigest, forwardTypedData, signForwardConsent } from './authorization.ts';
export type { ControlDeploymentPin, ForwardConsent } from './authorization.ts';
export { ResponsibilityControlClient, serializeControlSubmission, parseControlSubmission } from './client.ts';
export type { ControlAction, ControlSnapshot, ControlSubmission, ControlReceipt, OnchainControlLeg, OnchainControlSequence } from './client.ts';
export { RpcResponsibilityControlReader, CONTROL_AUTHORITY_DISCLOSURE } from './view.ts';
