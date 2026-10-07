/** Dependency-free, externally pinned verification of the complete reusable DApp kit. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { safePath, sha256, sourceTree, unpackAuthArchive, verifyAuthDirectory, walkAuth } from './verify-auth.mjs';
import { resolveReleaseProfile } from '../../web/release-profile.mjs';
import { validatePasswordRoutes } from '../../web/tenant-password-routing.mjs';
export { sha256 };
export const DELIVERY_SCHEMA = '8415wallet-dapp-delivery/1';
export const DELIVERY_FILES = ['deploy/dapp/install.mjs', 'scripts/package/verify-delivery.mjs', 'scripts/package/verify-auth.mjs',
  'web/release-profile.mjs', 'web/tenant-password-routing.mjs', 'config/releases/v2.json', 'config/releases/v3.json', 'config/releases/xiongan-v2.json',
  'docs/DAPP-INSTALL.md', 'docs/AUTH-INSTALL.md', 'LICENSE'];
const fail = (condition, code) => { if (!condition) throw Error(`DAPP_DELIVERY_${code}`); };
const digestPattern = /^[0-9a-f]{64}$/;
const treePattern = /^[0-9a-f]{40}$/;
const blobHash = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const parsed = bytes => JSON.parse(bytes.toString('utf8'));

/** Read the exact regular-file/directory GNU or USTAR subset emitted by our packers.
 * No extraction subprocess, PAX overrides, links, devices, duplicates or traversal.
 * Reject unsupported long-name records rather than silently interpreting them. */
export function readDeliveryArchive(bytes) {
  fail(Buffer.isBuffer(bytes) && bytes.length <= 128 * 1024 * 1024, 'ARCHIVE_SIZE_REFUSED');
  const tar = gunzipSync(bytes, { maxOutputLength: 256 * 1024 * 1024 });
  fail(tar.length % 512 === 0, 'TAR_LENGTH_REFUSED');
  const entries = new Map(), seen = new Map(); let offset = 0, terminated = false;
  const string = buffer => {
    const end = buffer.indexOf(0); const value = end < 0 ? buffer : buffer.subarray(0, end);
    fail([...value].every(byte => byte >= 32 && byte <= 126), 'TAR_STRING_REFUSED');
    fail(end < 0 || buffer.subarray(end).every(byte => byte === 0), 'TAR_STRING_PADDING_REFUSED');
    return value.toString('ascii');
  };
  const octal = buffer => { const value = buffer.toString('ascii').replace(/[\0 ]+$/, '').trim(); fail(/^[0-7]+$/.test(value), 'TAR_NUMBER_REFUSED'); const n = parseInt(value, 8); fail(Number.isSafeInteger(n), 'TAR_NUMBER_REFUSED'); return n; };
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512); offset += 512;
    if (header.every(byte => byte === 0)) { fail(offset + 512 <= tar.length && tar.subarray(offset).every(byte => byte === 0), 'TAR_TRAILING_DATA_REFUSED'); terminated = true; break; }
    fail(octal(header.subarray(148, 156)) === [...header].reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0), 'TAR_CHECKSUM_MISMATCH');
    const gnu = header.subarray(257, 265).equals(Buffer.from('ustar  \0'));
    const ustar = header.subarray(257, 265).equals(Buffer.from('ustar\0' + '00'));
    fail(gnu || ustar, 'TAR_FORMAT_REFUSED');
    fail([0, 48, 53].includes(header[156]) && header.subarray(157, 257).every(byte => byte === 0), 'TAR_LINK_OR_TYPE_REFUSED');
    const directory = header[156] === 53;
    const mode = octal(header.subarray(100, 108));
    fail((directory ? mode === 0o755 : [0o644, 0o755].includes(mode)) && octal(header.subarray(108, 116)) === 0 && octal(header.subarray(116, 124)) === 0 && octal(header.subarray(136, 148)) === 0, 'TAR_METADATA_REFUSED');
    const name = string(header.subarray(0, 100));
    const prefix = ustar ? string(header.subarray(345, 500)) : '';
    if (gnu) fail(header.subarray(345).every(byte => byte === 0), 'TAR_EXTENSION_REFUSED');
    let path = prefix ? `${prefix}/${name}` : name;
    if (path.startsWith('./')) path = path.slice(2);
    if (directory && path.endsWith('/')) path = path.slice(0, -1);
    fail((directory && path === '') || safePath(path), 'TAR_PATH_REFUSED');
    fail(!seen.has(path), 'TAR_DUPLICATE_REFUSED'); seen.set(path, directory);
    const size = octal(header.subarray(124, 136)), padded = Math.ceil(size / 512) * 512;
    fail(size <= 96 * 1024 * 1024 && (!directory || size === 0) && offset + padded <= tar.length, 'TAR_ENTRY_SIZE_REFUSED');
    if (!directory) entries.set(path, { bytes: tar.subarray(offset, offset + size), mode });
    fail(tar.subarray(offset + size, offset + padded).every(byte => byte === 0), 'TAR_PADDING_REFUSED'); offset += padded;
    fail(seen.size <= 25000, 'TAR_ENTRY_COUNT_REFUSED');
  }
  fail(terminated && entries.size > 0, 'TAR_TERMINATOR_REQUIRED');
  for (const path of seen.keys()) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) fail(seen.get(parts.slice(0, i).join('/')) !== false, 'TAR_PATH_COLLISION_REFUSED');
  }
  return entries;
}
const hashes = entries => Object.fromEntries([...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, entry]) => [path, sha256(entry.bytes)]));
const get = (entries, path) => { fail(entries.has(path), `FILE_MISSING: ${path}`); return entries.get(path).bytes; };
const sums = entries => [...entries].filter(([path]) => path !== 'SHA256SUMS').sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, entry]) => `${sha256(entry.bytes)}  ${path}`).join('\n') + '\n';
export function isPublicFile(path) {
  return safePath(path) && /^(web\/|dist\/browser\/)/.test(path) && !path.split('/').some(part => part.startsWith('.'))
    && (/\.(?:html|mjs|js|css|json|svg|png|jpg|jpeg|webp|ico|woff|woff2|ttf)$/.test(path) || ['web/assets/license-dm-sans.txt', 'dist/browser/vendor/ETHERS-LICENSE.md'].includes(path));
}
export function verifyDappEntries(entries, manifest, source, profileId) {
  const release = parsed(get(entries, 'RELEASE.json'));
  const { artifact, sha256: digest, ...expected } = manifest;
  assert.deepEqual(release, expected, 'DAPP_DELIVERY_UI_MANIFEST_MISMATCH');
  fail(release.schema === '8415wallet-dapp-release/2' && release.profile === profileId && release.source?.tree === source.tree, 'UI_IDENTITY_REFUSED');
  const config = parsed(get(entries, 'web/release-config.json')), profile = resolveReleaseProfile(config);
  fail(profile.id === profileId && profile.version === release.version && profile.status === release.status, 'UI_PROFILE_MISMATCH');
  assert.deepEqual(profile.tenant, release.tenant); assert.deepEqual(profile.deployment, release.deployment); assert.deepEqual(profile.features, release.features);
  fail(release.build.configSha256 === sha256(get(entries, 'web/release-config.json')), 'UI_CONFIG_MISMATCH');
  fail(release.prd?.sha256 === sha256(get(entries, release.prd.file)), 'UI_PRD_MISMATCH');
  fail(get(entries, 'SHA256SUMS').toString() === sums(entries), 'UI_INVENTORY_MISMATCH');
  const runtime = new Map([...entries].filter(([path]) => /^(web\/|dist\/browser\/)/.test(path)));
  fail(runtime.size > 0 && [...runtime.keys()].every(isPublicFile) && runtime.has('web/index.html'), 'UI_PUBLIC_FILES_REFUSED');
  assert.deepEqual(hashes(runtime), release.runtimeFiles, 'DAPP_DELIVERY_UI_RUNTIME_MISMATCH');
  for (const path of ['web/tenant-password-routing.mjs', 'web/tenant-password-ui.mjs', 'web/tenant-password-routing.json'])
    fail(runtime.has(path), 'PASSWORD_ROUTING_RUNTIME_MISSING');
  const passwordRoutes = validatePasswordRoutes(parsed(get(entries, 'web/tenant-password-routing.json')));
  fail(passwordRoutes.every(entry => entry.passwordManagementReady === false), 'PASSWORD_ROUTING_DEFAULT_NOT_READY_REQUIRED');
  assert.deepEqual(release.source.files, source.files, 'DAPP_DELIVERY_SOURCE_INVENTORY_MISMATCH');
  return { release, runtime };
}
export function verifyDeliveryArchive(archive, { expectedSha256, expectedTree } = {}) {
  fail(digestPattern.test(expectedSha256 ?? '') && treePattern.test(expectedTree ?? ''), 'EXTERNAL_PINS_REQUIRED');
  const bytes = Buffer.isBuffer(archive) ? archive : readFileSync(archive);
  fail(sha256(bytes) === expectedSha256, 'ARCHIVE_DIGEST_MISMATCH');
  const entries = readDeliveryArchive(bytes), release = parsed(get(entries, 'DELIVERY.json'));
  fail(release.schema === DELIVERY_SCHEMA && release.source?.tree === expectedTree && release.status === 'BETA_FUNCTIONAL_TESTING_NOT_INDEPENDENTLY_AUDITED', 'IDENTITY_REFUSED');
  fail(get(entries, 'SHA256SUMS').toString() === sums(entries), 'CHECKSUM_INVENTORY_MISMATCH');
  assert.deepEqual(hashes(new Map([...entries].filter(([path]) => !['SHA256SUMS', 'DELIVERY.json'].includes(path)))), release.files, 'DAPP_DELIVERY_COMPLETE_INVENTORY_MISMATCH');
  const allowed = new Set([...DELIVERY_FILES, 'DELIVERY.json', 'SHA256SUMS', 'artifacts/dapp-v2-package-manifest.json', 'artifacts/dapp-v3-package-manifest.json', 'artifacts/auth-package-manifest.json']);
  fail(release.artifacts && Object.keys(release.artifacts).sort().join() === 'auth,source,v2,v3', 'ARTIFACTS_REFUSED');
  for (const item of Object.values(release.artifacts)) {
    fail(item && safePath(item.artifact) && !item.artifact.includes('/') && item.artifact.endsWith('.tar.gz') && digestPattern.test(item.sha256), 'ARTIFACT_REFUSED');
    const path = `artifacts/${item.artifact}`; allowed.add(path); fail(sha256(get(entries, path)) === item.sha256, 'NESTED_ARCHIVE_DIGEST_MISMATCH');
  }
  assert.deepEqual([...entries.keys()].sort(), [...allowed].sort(), 'DAPP_DELIVERY_PAYLOAD_ALLOWLIST_MISMATCH');
  const authManifest = parsed(get(entries, 'artifacts/auth-package-manifest.json'));
  fail(authManifest.artifact === release.artifacts.auth.artifact && authManifest.sha256 === release.artifacts.auth.sha256, 'AUTH_REFERENCE_MISMATCH');
  // Auth package validation deliberately remains owned by its existing strict verifier.
  const temporary = mkdtempSync(join(tmpdir(), 'wallet-delivery-verify-')); let authDirectory;
  try {
    const authPath = join(temporary, 'auth.tar.gz'); writeFileSync(authPath, get(entries, `artifacts/${authManifest.artifact}`));
    authDirectory = unpackAuthArchive(authPath);
    const auth = verifyAuthDirectory(authDirectory, { expectedTree });
    assert.deepEqual(release.source, { commit: auth.source.commit, tree: auth.source.tree, dirty: auth.source.dirty }, 'DAPP_DELIVERY_SOURCE_IDENTITY_MISMATCH');
    const { artifact: _artifact, sha256: _sha, ...authExpected } = authManifest; assert.deepEqual(auth, authExpected);
    fail(sourceTree(auth.source.entries) === expectedTree, 'SOURCE_TREE_MISMATCH');
    const sourceEntries = readDeliveryArchive(get(entries, `artifacts/${release.artifacts.source.artifact}`));
    assert.deepEqual([...sourceEntries.keys()].sort(), auth.source.entries.map(entry => entry.path).sort(), 'DAPP_DELIVERY_SOURCE_COMPLETENESS');
    for (const entry of auth.source.entries) {
      const file = sourceEntries.get(entry.path);
      fail(blobHash(file.bytes) === entry.object && file.mode === (entry.mode === '100755' ? 0o755 : 0o644), 'SOURCE_BLOB_MISMATCH');
    }
    for (const path of DELIVERY_FILES) fail(get(entries, path).equals(get(sourceEntries, path)), 'TOOL_SOURCE_MISMATCH');
    const source = { tree: expectedTree, files: hashes(sourceEntries) }, dapps = {};
    for (const id of ['v2', 'v3']) {
      const manifest = parsed(get(entries, `artifacts/dapp-${id}-package-manifest.json`));
      for (const key of ['commit', 'commitTree', 'indexTree', 'tree', 'dirty']) assert.deepEqual(manifest.source?.[key], auth.source[key], 'DAPP_DELIVERY_UI_SOURCE_IDENTITY_MISMATCH');
      fail(manifest.artifact === release.artifacts[id].artifact && manifest.sha256 === release.artifacts[id].sha256, 'UI_REFERENCE_MISMATCH');
      assert.deepEqual(manifest.sourceArchive, release.artifacts.source, 'DAPP_DELIVERY_SOURCE_REFERENCE_MISMATCH');
      dapps[id] = verifyDappEntries(readDeliveryArchive(get(entries, `artifacts/${manifest.artifact}`)), manifest, source, id);
    }
    const authRuntime = new Map(walkAuth(authDirectory).map(path => [path, { bytes: readFileSync(join(authDirectory, path)), mode: 0o644 }]));
    return { release, entries, dapps, auth: authManifest, authRuntime, sha256: expectedSha256 };
  } finally { if (authDirectory) rmSync(authDirectory, { recursive: true, force: true }); rmSync(temporary, { recursive: true, force: true }); }
}
export function extractDelivery(result, destination) {
  destination = resolve(destination);
  let parent = dirname(destination);
  while (true) {
    const stat = lstatSync(parent), uid = process.getuid?.();
    fail(stat.isDirectory() && !stat.isSymbolicLink() && realpathSync(parent) === parent
      && (uid === undefined || stat.uid === uid || stat.uid === 0)
      && (!(stat.mode & 0o022) || (stat.uid === 0 && (stat.mode & 0o1000))), 'EXTRACT_PARENT_REFUSED');
    if (dirname(parent) === parent) break; parent = dirname(parent);
  }
  mkdirSync(destination, { mode: 0o700 }); // An existing target is deliberately refused.
  try {
    for (const [path, entry] of [...result.entries, ...[...result.authRuntime].map(([path, entry]) => [`runtime/auth/${path}`, entry])]) {
      mkdirSync(dirname(join(destination, path)), { recursive: true, mode: 0o755 });
      writeFileSync(join(destination, path), entry.bytes, { flag: 'wx', mode: 0o644 });
    }
  } catch (error) { rmSync(destination, { recursive: true, force: true }); throw error; }
  return destination;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {};
  for (let i = 2; i < process.argv.length; i += 2) { const key = process.argv[i]; fail(['--archive', '--sha256', '--tree', '--extract', '--manifest'].includes(key) && process.argv[i + 1] && !options[key], 'ARGUMENT_REFUSED'); options[key] = process.argv[i + 1]; }
  if (options['--manifest']) {
    fail(Object.keys(options).length === 1, 'MANIFEST_ARGUMENT_SCOPE_REFUSED');
    const manifestPath = resolve(options['--manifest']); const manifest = parsed(readFileSync(manifestPath));
    fail(/^8415wallet-dapp-delivery-[0-9a-f]{40}\.tar\.gz$/.test(manifest.artifact ?? ''), 'MANIFEST_ARTIFACT_REFUSED');
    options['--archive'] = join(dirname(manifestPath), manifest.artifact); options['--sha256'] = manifest.sha256; options['--tree'] = manifest.source?.tree;
  }
  fail(options['--archive'], 'ARCHIVE_REQUIRED');
  const result = verifyDeliveryArchive(resolve(options['--archive']), { expectedSha256: options['--sha256'], expectedTree: options['--tree'] });
  if (options['--extract']) extractDelivery(result, options['--extract']);
  console.log(`Complete DApp kit verified: ${result.release.source.tree}. V2, V3, dependency-complete auth and exact source checked. External pins must come from a trusted channel; this is not deployment or audit acceptance.`);
}
