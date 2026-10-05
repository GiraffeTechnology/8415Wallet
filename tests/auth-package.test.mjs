import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { gzipSync, gunzipSync } from 'node:zlib';
import { captureAuthSource, deterministicAuthArchive } from '../scripts/package/build-auth.mjs';
import { AUTH_SCHEMA, AUTH_STATUS, jsonBytes, packagePathAllowed, readAuthArchive, runtimePackage, sha256, sourcePathAllowed, sourceTree, unpackAuthArchive, verifyAuthArchive, verifyAuthDirectory, walkAuth } from '../scripts/package/verify-auth.mjs';

function temporary(t) { const path = mkdtempSync(join(tmpdir(), 'wallet-auth-package-test-')); t.after(() => rmSync(path, { recursive: true, force: true })); return path; }
function put(root, path, value) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), value); chmodSync(join(root, path), 0o644); }
const sourcePackage = { name: '8415wallet', version: '0.1.0', license: 'CC0-1.0', dependencies: { ethers: '^6.17.0' }, devDependencies: { typescript: '^5.9.0' } };
const sourceLock = { name: '8415wallet', lockfileVersion: 3, packages: {
  '': { dependencies: sourcePackage.dependencies },
  'node_modules/ethers': { version: '6.17.0', resolved: 'https://registry.npmjs.org/ethers/-/ethers-6.17.0.tgz', integrity: 'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==' },
  'node_modules/typescript': { version: '5.9.3', dev: true },
} };
const sourcePaths = ['server/main.mjs', 'server/service-entry.mjs', 'server/runtime-entry.mjs', 'server/auth-service.mjs', 'server/crypto.mjs', 'server/config-validation.mjs', 'server/ca-verifier.mjs', 'server/store.mjs', 'server/operator-init.mjs', 'server/operator-activate.mjs', 'web/login-core.mjs', 'deploy/auth-xiongan/install.mjs', 'deploy/auth-xiongan/8415wallet-auth-xiongan.service', 'deploy/auth-xiongan/auth-location.nginx.conf', 'docs/AUTH-INSTALL.md', 'scripts/package/verify-auth.mjs', 'LICENSE'];
function git(root, args) { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function fixture(t) {
  const root = temporary(t); const sourceRoot = join(root, 'source'); const runtimeRoot = join(root, 'runtime'); mkdirSync(sourceRoot); mkdirSync(runtimeRoot);
  for (const path of sourcePaths) put(sourceRoot, path, path.endsWith('.mjs') ? 'export {};\n' : `Synthetic package fixture: ${path}\n`);
  put(sourceRoot, 'package.json', jsonBytes(sourcePackage)); put(sourceRoot, 'package-lock.json', jsonBytes(sourceLock));
  put(sourceRoot, 'scripts/package/build-auth.mjs', '// Synthetic package fixture, never a real build.\n');
  git(sourceRoot, ['init', '-q']); git(sourceRoot, ['add', '--all']);
  git(sourceRoot, ['-c', 'user.name=Package Test', '-c', 'user.email=package-test@example.invalid', 'commit', '-qm', 'Synthetic package fixture']);
  const source = captureAuthSource(sourceRoot);
  for (const path of sourcePaths) put(runtimeRoot, path, readFileSync(join(sourceRoot, path)));
  put(runtimeRoot, 'provenance/package.source.json', readFileSync(join(sourceRoot, 'package.json')));
  put(runtimeRoot, 'provenance/package-lock.source.json', readFileSync(join(sourceRoot, 'package-lock.json')));
  const runtime = runtimePackage(sourcePackage, sourceLock);
  put(runtimeRoot, 'package.json', jsonBytes(runtime.manifest)); put(runtimeRoot, 'package-lock.json', jsonBytes(runtime.lock));
  put(runtimeRoot, 'node_modules/ethers/package.json', jsonBytes({ name: 'ethers', version: '6.17.0' }));
  put(runtimeRoot, 'node_modules/ethers/index.js', 'export const synthetic = true;\n');
  const release = { schema: AUTH_SCHEMA, status: AUTH_STATUS, source,
    runtime: { node: '>=22.18.0', bundledNode: false, bundledProductionDependencies: true },
    files: Object.fromEntries(walkAuth(runtimeRoot).map(path => [path, sha256(readFileSync(join(runtimeRoot, path)))])) };
  const update = () => {
    release.files = Object.fromEntries(walkAuth(runtimeRoot).filter(path => !['AUTH-RELEASE.json', 'SHA256SUMS'].includes(path)).map(path => [path, sha256(readFileSync(join(runtimeRoot, path)))]));
    put(runtimeRoot, 'AUTH-RELEASE.json', jsonBytes(release));
    put(runtimeRoot, 'SHA256SUMS', walkAuth(runtimeRoot).filter(path => path !== 'SHA256SUMS').map(path => `${sha256(readFileSync(join(runtimeRoot, path)))}  ${path}`).join('\n') + '\n');
  };
  update(); return { root, sourceRoot, runtimeRoot, release, update };
}

test('production manifest pins ethers and retains only production lock entries', () => {
  const runtime = runtimePackage(sourcePackage, sourceLock);
  assert.equal(runtime.manifest.dependencies.ethers, '6.17.0');
  assert.equal(runtime.manifest.devDependencies, undefined);
  assert.deepEqual(Object.keys(runtime.lock.packages), ['', 'node_modules/ethers']);
  assert.equal(runtime.lock.packages['node_modules/ethers'].integrity, sourceLock.packages['node_modules/ethers'].integrity);
});
test('production graph refuses lifecycle install markers, foreign URLs, linked/optional packages and extra dependencies', () => {
  for (const replacement of [{ hasInstallScript: true }, { resolved: 'file:../private' }, { resolved: 'https://registry.npmjs.org.evil.invalid/pkg' }, { link: true }, { optional: true }, { integrity: '' }]) {
    const lock = structuredClone(sourceLock); Object.assign(lock.packages['node_modules/ethers'], replacement);
    assert.throws(() => runtimePackage(sourcePackage, lock), /DEPENDENCY_METADATA_REFUSED/);
  }
  assert.throws(() => runtimePackage({ ...sourcePackage, dependencies: { ...sourcePackage.dependencies, another: '1' } }, sourceLock), /DEPENDENCY_ALLOWLIST_REFUSED/);
});
test('source snapshot includes tracked edits/staged additions, excludes untracked private inputs and does not alter the index', t => {
  const { sourceRoot } = fixture(t); const originalIndex = git(sourceRoot, ['write-tree']);
  put(sourceRoot, 'server/main.mjs', 'export const changed = true;\n');
  put(sourceRoot, 'server/new-helper.mjs', 'export const staged = true;\n'); git(sourceRoot, ['add', 'server/new-helper.mjs']);
  const stagedIndex = git(sourceRoot, ['write-tree']); put(sourceRoot, 'private-config.json', '{"private":"fixture-only"}');
  const captured = captureAuthSource(sourceRoot);
  assert.equal(captured.dirty, true); assert.notEqual(captured.tree, originalIndex); assert.notEqual(captured.tree, stagedIndex);
  assert.equal(sourceTree(captured.entries), captured.tree); assert.equal(git(sourceRoot, ['write-tree']), stagedIndex);
  assert.ok(captured.entries.some(entry => entry.path === 'server/new-helper.mjs'));
  assert.ok(!captured.entries.some(entry => entry.path === 'private-config.json'));
});
test('complete independent runtime directory verifies exact provenance and checksums', t => {
  const { runtimeRoot, release } = fixture(t); assert.deepEqual(verifyAuthDirectory(runtimeRoot), release);
  assert.throws(() => verifyAuthDirectory(runtimeRoot, { expectedTree: '0'.repeat(40) }), /EXPECTED_SOURCE_TREE_MISMATCH/);
});
test('archive output is byte-identical despite source timestamps and preserves source provenance', t => {
  const { runtimeRoot, release, root } = fixture(t); const first = deterministicAuthArchive(runtimeRoot);
  for (const path of walkAuth(runtimeRoot)) utimesSync(join(runtimeRoot, path), new Date(), new Date());
  assert.deepEqual(deterministicAuthArchive(runtimeRoot), first);
  const archivePath = join(root, `8415wallet-auth-runtime-${release.source.tree}.tar.gz`); writeFileSync(archivePath, first);
  const extracted = unpackAuthArchive(archivePath); t.after(() => rmSync(extracted, { recursive: true, force: true }));
  assert.deepEqual(verifyAuthDirectory(extracted), release);
  const manifest = { artifact: archivePath.split('/').at(-1), sha256: sha256(first), ...release };
  put(root, 'auth-package-manifest.json', jsonBytes(manifest)); assert.deepEqual(verifyAuthArchive(join(root, 'auth-package-manifest.json')), release);
  manifest.sha256 = '0'.repeat(64); put(root, 'auth-package-manifest.json', jsonBytes(manifest));
  assert.throws(() => verifyAuthArchive(join(root, 'auth-package-manifest.json')), /ARCHIVE_DIGEST_MISMATCH/);
});
test('tampering, omitted inventory, extra files and altered source provenance fail closed', t => {
  const { runtimeRoot, release, update } = fixture(t);
  put(runtimeRoot, 'server/main.mjs', 'export const tampered = true;\n');
  assert.throws(() => verifyAuthDirectory(runtimeRoot), /FILE_DIGEST_MISMATCH/);
  update(); assert.throws(() => verifyAuthDirectory(runtimeRoot), /SOURCE_BLOB_MISMATCH/);
  put(runtimeRoot, 'server/main.mjs', 'export {};\n'); update();
  delete release.files['server/main.mjs']; put(runtimeRoot, 'AUTH-RELEASE.json', jsonBytes(release));
  assert.throws(() => verifyAuthDirectory(runtimeRoot), /COMPLETE_FILE_INVENTORY/); update();
  put(runtimeRoot, 'private-config.json', '{}'); assert.throws(() => verifyAuthDirectory(runtimeRoot), /PAYLOAD_ALLOWLIST_REFUSED/); rmSync(join(runtimeRoot, 'private-config.json'));
  release.source.tree = '0'.repeat(40); update(); assert.throws(() => verifyAuthDirectory(runtimeRoot), /SOURCE_TREE_MISMATCH/);
});
test('omitting a tracked auth helper cannot be hidden by rewriting the file inventory', t => {
  const { sourceRoot, runtimeRoot, release, update } = fixture(t);
  put(sourceRoot, 'server/helper.mjs', 'export {};\n'); git(sourceRoot, ['add', 'server/helper.mjs']);
  release.source = captureAuthSource(sourceRoot); update();
  assert.throws(() => verifyAuthDirectory(runtimeRoot), /SOURCE_PAYLOAD_COMPLETENESS/);
});
test('dependency version swaps, lifecycle scripts and undeclared nested dependency roots are refused', t => {
  const { runtimeRoot, update } = fixture(t);
  put(runtimeRoot, 'node_modules/ethers/package.json', jsonBytes({ name: 'ethers', version: '6.16.0' })); update();
  assert.throws(() => verifyAuthDirectory(runtimeRoot), /DEPENDENCY_VERSION_MISMATCH/);
  put(runtimeRoot, 'node_modules/ethers/package.json', jsonBytes({ name: 'ethers', version: '6.17.0', scripts: { postinstall: 'unwanted' } })); update();
  assert.throws(() => verifyAuthDirectory(runtimeRoot), /DEPENDENCY_INSTALL_SCRIPT_REFUSED/);
  put(runtimeRoot, 'node_modules/ethers/package.json', jsonBytes({ name: 'ethers', version: '6.17.0' }));
  put(runtimeRoot, 'node_modules/ethers/node_modules/unlisted/package.json', '{}'); update();
  assert.throws(() => verifyAuthDirectory(runtimeRoot), /UNLOCKED_DEPENDENCY_REFUSED/);
});
test('package allowlist rejects secrets, source tests, public static assets, traversal and hidden dependency files', () => {
  for (const path of ['../outside', '/absolute', 'server/../config.json', 'server//main.mjs', 'config/auth.json', 'tests/auth-service.test.ts', 'web/index.html', 'web/qr-generator.mjs', 'store-key', '.env', 'node_modules/ethers/.env', 'node_modules/.bin/tool']) assert.equal(packagePathAllowed(path), false, path);
  assert.equal(sourcePathAllowed('server/operator-activate.mjs'), true);
});
test('filesystem symlinks, hardlinks, special mode bits and executable payloads are refused', t => {
  const { runtimeRoot } = fixture(t); const file = join(runtimeRoot, 'server/main.mjs');
  chmodSync(file, 0o755); assert.throws(() => verifyAuthDirectory(runtimeRoot), /EXECUTABLE_OR_HARDLINK_REFUSED/); chmodSync(file, 0o644);
  chmodSync(file, 0o666); assert.throws(() => verifyAuthDirectory(runtimeRoot), /WRITABLE_OR_SPECIAL_MODE_REFUSED/); chmodSync(file, 0o644);
  linkSync(file, join(runtimeRoot, 'server/hardlink.mjs')); assert.throws(() => verifyAuthDirectory(runtimeRoot), /EXECUTABLE_OR_HARDLINK_REFUSED/); rmSync(join(runtimeRoot, 'server/hardlink.mjs'));
  symlinkSync('main.mjs', join(runtimeRoot, 'server/symlink.mjs')); assert.throws(() => verifyAuthDirectory(runtimeRoot), /LINK_OR_SPECIAL_FILE_REFUSED/);
});
function mutateArchive(bytes, change) {
  const tar = Buffer.from(gunzipSync(bytes)); change(tar);
  tar.fill(32, 148, 156); const sum = [...tar.subarray(0, 512)].reduce((total, byte) => total + byte, 0);
  tar.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8); return gzipSync(tar);
}
test('archive reader rejects traversal, links, devices, executable mode, corrupt headers and nonzero trailer', t => {
  const { runtimeRoot } = fixture(t); const bytes = deterministicAuthArchive(runtimeRoot);
  for (const path of ['../outside', '/absolute', 'server/../outside']) {
    assert.throws(() => readAuthArchive(mutateArchive(bytes, tar => { tar.fill(0, 0, 100); tar.write(path); })), /TAR_PATH_OR_DUPLICATE_REFUSED/);
  }
  for (const type of ['1', '2', '3', '5', 'x', 'L']) assert.throws(() => readAuthArchive(mutateArchive(bytes, tar => { tar[156] = type.charCodeAt(0); })), /TAR_LINK_OR_TYPE_REFUSED/);
  assert.throws(() => readAuthArchive(mutateArchive(bytes, tar => tar.write('0000755\0', 100, 8))), /TAR_METADATA_REFUSED/);
  const corrupt = gunzipSync(bytes); corrupt[0] ^= 1; assert.throws(() => readAuthArchive(gzipSync(corrupt)), /TAR_CHECKSUM_MISMATCH/);
  assert.throws(() => readAuthArchive(mutateArchive(bytes, tar => { tar[tar.length - 1] = 1; })), /TAR_TRAILING_DATA_REFUSED/);
});
test('archive reader rejects duplicate file entries before any extraction', t => {
  const { runtimeRoot } = fixture(t); const bytes = deterministicAuthArchive(runtimeRoot); const tar = gunzipSync(bytes);
  const firstSize = parseInt(tar.subarray(124, 136).toString().replace(/\0/g, ''), 8); const firstLength = 512 + Math.ceil(firstSize / 512) * 512;
  const duplicate = Buffer.concat([tar.subarray(0, firstLength), tar]);
  assert.throws(() => readAuthArchive(gzipSync(duplicate)), /TAR_PATH_OR_DUPLICATE_REFUSED/);
});
test('source Git tree reconstruction rejects links, collisions, duplicates and unsafe paths', t => {
  const { release } = fixture(t); const entries = release.source.entries;
  assert.throws(() => sourceTree([...entries, entries[0]]), /SOURCE_DUPLICATE_REFUSED/);
  assert.throws(() => sourceTree([{ ...entries[0], path: '../private' }]), /SOURCE_ENTRY_REFUSED/);
  assert.throws(() => sourceTree([{ ...entries[0], mode: '120000' }]), /SOURCE_ENTRY_REFUSED/);
  assert.throws(() => sourceTree([{ ...entries[0], path: 'a' }, { ...entries[1], path: 'a/b' }]), /SOURCE_COLLISION_REFUSED/);
});
