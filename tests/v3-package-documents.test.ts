import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// JavaScript build helpers are exercised without invoking a package build.
// @ts-expect-error Package build helpers deliberately have no TypeScript declarations.
import { V3_DOCUMENTS, BOUNDARY_SECTIONS, verifyBoundaryDocument, verifyDocumentEntries } from '../scripts/package/v3-document-contract.mjs';

const document = readFileSync(new URL('../docs/INTEGRATION-BOUNDARIES.md', import.meta.url), 'utf8');
const entries = [...V3_DOCUMENTS, 'PACKAGE-V3.md', 'index.js', 'controls/index.js'];
test('consumer contract and required product documents are present', () => {
  assert.doesNotThrow(() => verifyBoundaryDocument(document));
  assert.doesNotThrow(() => verifyDocumentEntries(entries));
});
test('each missing integration boundary is refused', () => {
  for (const heading of BOUNDARY_SECTIONS) assert.throws(() => verifyBoundaryDocument(document.replace(heading, '')), /BOUNDARY_DOCUMENT_REFUSED/);
  assert.throws(() => verifyBoundaryDocument(document.replace('NOT_INDEPENDENTLY_AUDITED', '')), /BOUNDARY_DOCUMENT_REFUSED/);
});
test('each missing required consumer document is refused', () => {
  for (const path of [...V3_DOCUMENTS, 'PACKAGE-V3.md']) {
    assert.throws(() => verifyDocumentEntries(entries.filter(p => p !== path)), /DOCUMENT_ENTRIES_REFUSED/);
  }
});
test('development instructions are excluded at any depth and case', () => {
  for (const path of ['AGENTS.md', 'docs/agents.MD', 'CONTROL-DEVELOPMENT-STATUS.md', '.codex/state.json', 'docs\\.agents\\record']) {
    assert.throws(() => verifyDocumentEntries([...entries, path]), /DOCUMENT_ENTRIES_REFUSED/);
  }
});
test('malformed or duplicate file inventories cannot pass', () => {
  for (const invalid of [null, {}, [...entries, entries[0]], [...entries, 4]]) {
    assert.throws(() => verifyDocumentEntries(invalid), /DOCUMENT_ENTRIES_REFUSED/);
  }
});
