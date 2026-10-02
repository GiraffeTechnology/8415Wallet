/** Consumer-facing documents; development instructions are not package input. */
export const V3_DOCUMENTS = Object.freeze([
  'LICENSE', 'docs/INTEGRATION.md', 'docs/INTEGRATION-BOUNDARIES.md',
  'docs/ERC-8415-Wallet-PRD.md', 'docs/RESPONSIBILITY-CONTROLS-SECURITY.md',
  'docs/V3-REVIEW-AND-VALIDATION.md', 'docs/stages/STAGE-5J-PUBLIC-PATH-AND-UI.md',
  'docs/V3-DEVELOPMENT-CLOSURE.md', 'docs/XIONGAN-WALLET.md',
]);
export const BOUNDARY_SECTIONS = Object.freeze([
  '## Protocol observations', '## Forbidden inferences',
  '## Responsibility and optional payment', '## Execution and recovery',
  '## Deployment and acceptance',
]);
export function verifyBoundaryDocument(text) {
  if (typeof text !== 'string' || !text.includes('8415Wallet integration boundaries v1') ||
      !BOUNDARY_SECTIONS.every(section => text.split(/\r?\n/).includes(section)) ||
      !text.includes('NOT_INDEPENDENTLY_AUDITED')) {
    throw new Error('PACKAGE_V3_BOUNDARY_DOCUMENT_REFUSED');
  }
}
/** Consumer-facing documents for the V2 product package. */
export const V2_DOCUMENTS = Object.freeze([
  'LICENSE', 'README.md', 'docs/INTEGRATION.md', 'docs/INTEGRATION-BOUNDARIES.md',
  'docs/ERC-8415-Wallet-PRD.md', 'docs/V2-CLOSEOUT.md',
]);
/** How this repository instructs itself. None of it belongs in a package. */
const DEVELOPMENT_ONLY = Object.freeze(['agents.md', 'control-development-status.md', '.codex', '.agents']);

/** Shared by both packages: nothing that instructs development may ship. */
export function verifyNoDevelopmentInstructions(paths, code) {
  if (!Array.isArray(paths) || !paths.every(p => typeof p === 'string') ||
      new Set(paths).size !== paths.length ||
      paths.some(p => p.split(/[\\/]/).some(part => DEVELOPMENT_ONLY.includes(part.toLowerCase())))) {
    throw new Error(code);
  }
}
export function verifyDocumentEntries(paths) {
  verifyNoDevelopmentInstructions(paths, 'PACKAGE_V3_DOCUMENT_ENTRIES_REFUSED');
  if (![...V3_DOCUMENTS, 'PACKAGE-V3.md'].every(p => paths.includes(p))) {
    throw new Error('PACKAGE_V3_DOCUMENT_ENTRIES_REFUSED');
  }
}
export function verifyV2DocumentEntries(paths) {
  verifyNoDevelopmentInstructions(paths, 'PACKAGE_V2_DOCUMENT_ENTRIES_REFUSED');
  if (![...V2_DOCUMENTS, 'PACKAGE.md'].every(p => paths.includes(p))) {
    throw new Error('PACKAGE_V2_DOCUMENT_ENTRIES_REFUSED');
  }
}
