/** Consumer-facing documents; development instructions are not package input. */
export const V3_DOCUMENTS = Object.freeze([
  'LICENSE', 'docs/INTEGRATION.md', 'docs/INTEGRATION-BOUNDARIES.md',
  'docs/ERC-8415-Wallet-PRD.md', 'docs/RESPONSIBILITY-CONTROLS-SECURITY.md',
  'docs/V3-REVIEW-AND-VALIDATION.md', 'docs/stages/STAGE-5J-PUBLIC-PATH-AND-UI.md',
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
export function verifyDocumentEntries(paths) {
  if (!Array.isArray(paths) || !paths.every(p => typeof p === 'string') ||
      new Set(paths).size !== paths.length ||
      paths.some(p => p.split(/[\\/]/).some(part =>
        ['agents.md', 'control-development-status.md', '.codex', '.agents'].includes(part.toLowerCase()))) ||
      ![...V3_DOCUMENTS, 'PACKAGE-V3.md'].every(p => paths.includes(p))) {
    throw new Error('PACKAGE_V3_DOCUMENT_ENTRIES_REFUSED');
  }
}
