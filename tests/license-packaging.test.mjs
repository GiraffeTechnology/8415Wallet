import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { LEGAL_FILES, PUBLIC_LEGAL_FILES, packagePathAllowed, readAuthArchive, runtimePackage, sha256, sourcePathAllowed } from '../scripts/package/verify-auth.mjs';
import { DELIVERY_FILES, isPublicFile, readDeliveryArchive } from '../scripts/package/verify-delivery.mjs';
import { V2_DOCUMENTS, V3_DOCUMENTS, verifyDocumentEntries, verifyV2DocumentEntries } from '../scripts/package/v3-document-contract.mjs';
const root = new URL('../', import.meta.url);
const bytes = path => readFileSync(new URL(path, root));
const text = path => bytes(path).toString('utf8');

// These pins bind the independently licensed copies and texts used by this build.
const preserved = {
  'LICENSES/CC0-1.0.txt': 'a2010f343487d3f7618affe54f789f5487602331c0a8d03f49e9a7c547cf0499',
  'web/qr-generator.mjs': '7be0e4bd505354ed948558e2cf1e4f9b6814233908f181aee49134f0345993d5',
  'web/assets/license-dm-sans.txt': '9af36190332437f5ecd09974de43c1f7c77a310a996cdd8ceb25628b458840e1',
  'tests/vendor/JSQR-LICENSE.txt': '28a773bfffa828ec38c030fc8ace5f3aeb90926ec1309bbd135441c4387ce3cd',
  'tests/vendor/jsqr.cjs': '3b16531e458e494c20bd00b8302ce282c479a4de31fd299e896569383e6e41a2',
};
for (const [path, hash] of Object.entries(preserved)) test(`preserve component and license bytes: ${path}`, () => {
  assert.equal(sha256(bytes(path)), hash);
});
test('the current policy requires permission and source attribution while retaining independent rights', () => {
  const license = text('LICENSE');
  assert.match(license, /does not grant a public license/);
  assert.match(license, /Failure to provide the required source attribution/);
  assert.match(license, /Attribution alone is not permission/);
  assert.match(license, /does not revoke, narrow, or add conditions to valid prior grants/);
  assert.match(license, /restrictions and attribution\nrequirements in this notice do not apply to independently licensed or\npublic-domain material/);
  assert.match(license, /Only new original additions are covered in a mixed file/);
  assert.doesNotMatch(license, /\[(?:PROJECT|VERIFIED|CONFIRMED|PRECISE)/);
});
test('all explicitly marked Solidity files retain their CC0 SPDX identifiers', () => {
  const files = readdirSync(new URL('contracts/', root), { recursive: true }).filter(path => path.endsWith('.sol'));
  assert.equal(files.length, 14);
  for (const path of files) assert.match(text(`contracts/${path}`), /^\/\/ SPDX-License-Identifier: CC0-1\.0\r?$/m, path);
});
test('current package metadata points to the complete policy and propagates to the auth runtime', () => {
  const pkg = JSON.parse(text('package.json')), lock = JSON.parse(text('package-lock.json'));
  assert.equal(pkg.private, true);
  assert.equal(pkg.license, 'SEE LICENSE IN LICENSE');
  assert.equal(lock.packages[''].license, pkg.license);
  const runtime = runtimePackage(pkg, lock);
  assert.equal(runtime.manifest.license, pkg.license);
  assert.equal(runtime.lock.packages[''].license, pkg.license);
});
test('SDKs, auth and delivery share a complete, exact legal file contract', () => {
  assert.deepEqual(LEGAL_FILES, ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'LICENSES/CC0-1.0.txt']);
  for (const path of LEGAL_FILES) {
    assert.ok(bytes(path).length);
    assert.ok(V2_DOCUMENTS.includes(path)); assert.ok(V3_DOCUMENTS.includes(path));
    assert.ok(DELIVERY_FILES.includes(path));
    assert.equal(sourcePathAllowed(path), true); assert.equal(packagePathAllowed(path), true);
    assert.throws(() => verifyV2DocumentEntries([...V2_DOCUMENTS, 'PACKAGE.md'].filter(file => file !== path)), /DOCUMENT_ENTRIES_REFUSED/);
    assert.throws(() => verifyDocumentEntries([...V3_DOCUMENTS, 'PACKAGE-V3.md'].filter(file => file !== path)), /DOCUMENT_ENTRIES_REFUSED/);
  }
});
test('public runtime admits only the exact legal files without broadening arbitrary text-file access', () => {
  for (const path of PUBLIC_LEGAL_FILES) assert.equal(isPublicFile(path), true);
  for (const path of ['web/legal/secret.txt', 'web/legal/README.md', 'web/legal/../LICENSE', 'web/legal/.env', 'LICENSE', 'web/config.txt', 'web/LICENSES/CC0-1.0.txt']) assert.equal(isPublicFile(path), false, path);
});
// Optional post-build assertions inspect real archives; the normal unit suite
// remains reproducible before packaging. The release check runs this mode too.
if (process.env.WALLET_LICENSE_ARTIFACT_CHECK === '1') {
  test('new SDK, DApp, auth and delivery archives contain byte-exact legal notices', () => {
    for (const stage of ['dist/package', 'dist/package-v3', 'dist/package-auth']) {
      for (const path of LEGAL_FILES) assert.deepEqual(bytes(`${stage}/${path}`), bytes(path), `${stage}/${path}`);
    }
    for (const [id, stage] of [['v2', 'package'], ['v3', 'package-v3']]) {
      const manifest = JSON.parse(text(`dist/${id}-package-manifest.json`));
      const archive = fileURLToPath(new URL(`dist/${stage}/${manifest.artifact}`, root));
      assert.equal(sha256(readFileSync(archive)), manifest.sha256);
      for (const path of LEGAL_FILES) assert.deepEqual(execFileSync('tar', ['-xOf', archive, `package/${path}`]), bytes(path));
    }
    const auth = JSON.parse(text('dist/auth-package-manifest.json'));
    const authEntries = new Map(readAuthArchive(bytes(`dist/${auth.artifact}`)).map(entry => [entry.path, entry.bytes]));
    for (const path of LEGAL_FILES) assert.deepEqual(authEntries.get(path), bytes(path));
    for (const id of ['v2', 'v3']) {
      const manifest = JSON.parse(text(`dist/dapp-${id}-package-manifest.json`));
      const entries = readDeliveryArchive(bytes(`dist/${manifest.artifact}`));
      for (const path of LEGAL_FILES) {
        assert.deepEqual(entries.get(path)?.bytes, bytes(path));
        assert.deepEqual(entries.get(`web/legal/${path}`)?.bytes, bytes(path));
        assert.equal(manifest.runtimeFiles[`web/legal/${path}`], sha256(bytes(path)));
      }
      for (const path of ['web/qr-generator.mjs', 'web/assets/license-dm-sans.txt']) assert.deepEqual(entries.get(path)?.bytes, bytes(path));
      assert.deepEqual(entries.get('dist/browser/vendor/ETHERS-LICENSE.md')?.bytes, bytes('node_modules/ethers/LICENSE.md'));
    }
    const delivery = JSON.parse(text('dist/delivery-package-manifest.json'));
    const entries = readDeliveryArchive(bytes(`dist/${delivery.artifact}`));
    for (const path of LEGAL_FILES) assert.deepEqual(entries.get(path)?.bytes, bytes(path));
    assert.deepEqual(bytes('dist/package-auth/node_modules/ethers/LICENSE.md'), bytes('node_modules/ethers/LICENSE.md'));
  });
}
