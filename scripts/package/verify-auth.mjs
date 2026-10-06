/** Offline auth-package integrity checks. Uses only the externally supplied Node runtime. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

export const AUTH_SCHEMA = '8415wallet-auth-runtime/1';
export const AUTH_STATUS = 'NONPRODUCTION_PACKAGE_NOT_ACTIVATED';
// State meaning is versioned independently of the unchanged AES envelope format.
// Legacy code may discard registration/recovery fields even though it decrypts v1.
export const AUTH_STATE_SEMANTICS = '8415wallet-auth-state/2';
export const LEGACY_AUTH_STATE_SEMANTICS = '8415wallet-auth-state/1';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const jsonBytes = object => `${JSON.stringify(object, null, 2)}\n`;
const objectHash = (type, bytes) => createHash('sha1').update(`${type} ${bytes.length}\0`).update(bytes).digest('hex');
const fail = (condition, code) => { if (!condition) throw new Error(`AUTH_PACKAGE_${code}`); };
const hashPattern = /^[0-9a-f]{64}$/;
const gitPattern = /^[0-9a-f]{40}$/;
export function authStateSemantics(release) {
  const value = release?.runtime?.authStateSemantics;
  // An absent declaration is the pre-registration/recovery generation only.
  fail(value === undefined || value === LEGACY_AUTH_STATE_SEMANTICS || value === AUTH_STATE_SEMANTICS, 'STATE_SEMANTICS_REFUSED');
  return value ?? LEGACY_AUTH_STATE_SEMANTICS;
}
export function validateAuthStateTransition(current, candidate, { rollback = false } = {}) {
  const from = authStateSemantics(current), to = authStateSemantics(candidate);
  if (from === to) return;
  fail(!(from === AUTH_STATE_SEMANTICS && to === LEGACY_AUTH_STATE_SEMANTICS), 'STATE_SEMANTICS_DOWNGRADE_REFUSED');
  // This is the one reviewed forward edge. Unknown future generations fail closed.
  fail(!rollback && from === LEGACY_AUTH_STATE_SEMANTICS && to === AUTH_STATE_SEMANTICS, 'STATE_SEMANTICS_TRANSITION_REFUSED');
}
export const sourcePathAllowed = path => /^(?:server\/[a-z][a-z0-9-]*\.mjs|web\/login-core\.mjs|deploy\/auth-xiongan\/(?:install\.mjs|8415wallet-auth-xiongan\.service|auth-location\.nginx\.conf)|docs\/AUTH-INSTALL\.md|scripts\/package\/verify-auth\.mjs|LICENSE)$/.test(path);
export function safePath(path) {
  return typeof path === 'string' && path.length > 0 && path.length <= 240 && /^[A-Za-z0-9_@.+/=-]+$/.test(path)
    && path.split('/').every(part => part && part !== '.' && part !== '..');
}
export function packagePathAllowed(path) {
  return safePath(path) && (sourcePathAllowed(path)
    || ['package.json', 'package-lock.json', 'AUTH-RELEASE.json', 'SHA256SUMS', 'provenance/package.source.json', 'provenance/package-lock.source.json'].includes(path)
    || (path.startsWith('node_modules/') && !path.split('/').some(part => part.startsWith('.') || /^(?:config|credentials|store-key)$/i.test(part))));
}
export function walkAuth(root, prefix = '') {
  const rootStat = lstatSync(join(root, prefix));
  fail(rootStat.isDirectory() && !rootStat.isSymbolicLink(), 'DIRECTORY_REFUSED');
  return readdirSync(join(root, prefix)).sort().flatMap(name => {
    const path = prefix ? `${prefix}/${name}` : name;
    fail(safePath(path), 'PATH_REFUSED');
    const stat = lstatSync(join(root, path));
    fail(!stat.isSymbolicLink() && (stat.isFile() || stat.isDirectory()), 'LINK_OR_SPECIAL_FILE_REFUSED');
    fail(!(stat.mode & 0o7022), 'WRITABLE_OR_SPECIAL_MODE_REFUSED');
    if (stat.isDirectory()) return walkAuth(root, path);
    fail(!(stat.mode & 0o111) && stat.nlink === 1, 'EXECUTABLE_OR_HARDLINK_REFUSED');
    return [path];
  });
}

/** Reconstruct the recorded Git tree from blob identities, without requiring Git. */
export function sourceTree(entries) {
  fail(Array.isArray(entries) && entries.length > 0 && entries.length <= 20000, 'SOURCE_ENTRIES_REFUSED');
  const root = new Map();
  const seen = new Set();
  for (const entry of entries) {
    fail(entry && safePath(entry.path) && /^(100644|100755)$/.test(entry.mode) && gitPattern.test(entry.object), 'SOURCE_ENTRY_REFUSED');
    fail(!seen.has(entry.path), 'SOURCE_DUPLICATE_REFUSED'); seen.add(entry.path);
    const parts = entry.path.split('/'); let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!node.has(part)) node.set(part, new Map());
      fail(node.get(part) instanceof Map, 'SOURCE_COLLISION_REFUSED'); node = node.get(part);
    }
    fail(!node.has(parts.at(-1)), 'SOURCE_COLLISION_REFUSED'); node.set(parts.at(-1), entry);
  }
  const tree = node => {
    const entries = [...node].map(([name, value]) => ({ name, directory: value instanceof Map, value }));
    entries.sort((a, b) => Buffer.compare(Buffer.from(a.name + (a.directory ? '/' : '')), Buffer.from(b.name + (b.directory ? '/' : ''))));
    return objectHash('tree', Buffer.concat(entries.map(({ name, directory, value }) => Buffer.concat([
      Buffer.from(`${directory ? '40000' : value.mode} ${name}\0`), Buffer.from(directory ? tree(value) : value.object, 'hex'),
    ]))));
  };
  return tree(root);
}

/** Derive only the exact, lockfile-pinned production graph; npm still validates its closure. */
export function runtimePackage(sourcePackage, sourceLock) {
  fail(sourcePackage?.name === '8415wallet' && sourceLock?.lockfileVersion === 3, 'SOURCE_PACKAGE_REFUSED');
  fail(Object.keys(sourcePackage.dependencies ?? {}).join() === 'ethers', 'DEPENDENCY_ALLOWLIST_REFUSED');
  assert.deepEqual(sourceLock.packages?.['']?.dependencies, sourcePackage.dependencies, 'AUTH_PACKAGE_SOURCE_LOCK_ROOT_MISMATCH');
  const entries = Object.entries(sourceLock.packages ?? {}).filter(([path, info]) => path && !info.dev);
  fail(entries.length > 0 && entries.length < 100, 'DEPENDENCY_GRAPH_REFUSED');
  for (const [path, info] of entries) {
    fail(safePath(path) && /^(?:node_modules\/(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+)(?:\/node_modules\/(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+)*$/.test(path), 'DEPENDENCY_PATH_REFUSED');
    fail(!info.link && !info.hasInstallScript && !info.optional && typeof info.version === 'string'
      && /^https:\/\/registry\.npmjs\.org\//.test(info.resolved ?? '') && /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(info.integrity ?? ''), 'DEPENDENCY_METADATA_REFUSED');
  }
  const ethers = sourceLock.packages['node_modules/ethers'];
  fail(ethers && /^\d+\.\d+\.\d+$/.test(ethers.version), 'ETHERS_PIN_REQUIRED');
  const manifest = { name: '8415wallet-auth-runtime', version: sourcePackage.version, private: true, type: 'module',
    license: sourcePackage.license, engines: { node: '>=22.18.0' },
    scripts: { start: 'node server/runtime-entry.mjs', 'operator:initialize': 'node server/operator-init.mjs', 'operator:activate': 'node server/operator-activate.mjs' },
    dependencies: { ethers: ethers.version } };
  const lock = { name: manifest.name, version: manifest.version, lockfileVersion: 3, requires: true,
    packages: { '': { name: manifest.name, version: manifest.version, license: manifest.license, dependencies: manifest.dependencies, engines: manifest.engines },
      ...Object.fromEntries(entries) } };
  return { manifest, lock };
}

export function verifyAuthDirectory(directory, { expectedTree } = {}) {
  const files = walkAuth(directory);
  fail(files.every(packagePathAllowed), 'PAYLOAD_ALLOWLIST_REFUSED');
  const release = JSON.parse(readFileSync(join(directory, 'AUTH-RELEASE.json'), 'utf8'));
  fail(release.schema === AUTH_SCHEMA && release.status === AUTH_STATUS, 'SCHEMA_OR_STATUS_REFUSED');
  fail(release.runtime?.node === '>=22.18.0' && release.runtime?.bundledNode === false && release.runtime?.bundledProductionDependencies === true, 'RUNTIME_DECLARATION_REFUSED');
  authStateSemantics(release);
  const source = release.source;
  fail(source && gitPattern.test(source.commit) && gitPattern.test(source.commitTree) && gitPattern.test(source.indexTree) && gitPattern.test(source.tree), 'SOURCE_IDENTITY_REFUSED');
  const commitBytes = Buffer.from(source.commitObject, 'base64');
  fail(objectHash('commit', commitBytes) === source.commit && commitBytes.toString().startsWith(`tree ${source.commitTree}\n`), 'COMMIT_IDENTITY_MISMATCH');
  fail(sourceTree(source.entries) === source.tree && source.dirty === (source.tree !== source.commitTree), 'SOURCE_TREE_MISMATCH');
  if (expectedTree) fail(source.tree === expectedTree, 'EXPECTED_SOURCE_TREE_MISMATCH');
  const sourceEntries = new Map(source.entries.map(entry => [entry.path, entry]));
  const expectedFiles = files.filter(file => !['AUTH-RELEASE.json', 'SHA256SUMS'].includes(file));
  assert.deepEqual(expectedFiles.filter(sourcePathAllowed), source.entries.map(entry => entry.path).filter(sourcePathAllowed).sort(), 'AUTH_PACKAGE_SOURCE_PAYLOAD_COMPLETENESS');
  fail(release.files && typeof release.files === 'object' && !Array.isArray(release.files), 'INVENTORY_REQUIRED');
  assert.deepEqual(Object.keys(release.files).sort(), [...expectedFiles].sort(), 'AUTH_PACKAGE_COMPLETE_FILE_INVENTORY');
  for (const file of expectedFiles) {
    fail(hashPattern.test(release.files[file]) && sha256(readFileSync(join(directory, file))) === release.files[file], `FILE_DIGEST_MISMATCH: ${file}`);
    if (sourcePathAllowed(file)) fail(sourceEntries.has(file) && objectHash('blob', readFileSync(join(directory, file))) === sourceEntries.get(file).object, `SOURCE_BLOB_MISMATCH: ${file}`);
  }
  for (const [original, packaged] of [['package.json', 'provenance/package.source.json'], ['package-lock.json', 'provenance/package-lock.source.json']]) {
    fail(sourceEntries.has(original) && objectHash('blob', readFileSync(join(directory, packaged))) === sourceEntries.get(original).object, 'SOURCE_PACKAGE_BLOB_MISMATCH');
  }
  const required = ['server/main.mjs', 'server/service-entry.mjs', 'server/runtime-entry.mjs', 'server/auth-service.mjs', 'server/crypto.mjs', 'server/config-validation.mjs', 'server/ca-verifier.mjs', 'server/store.mjs', 'server/operator-init.mjs', 'server/operator-activate.mjs', 'web/login-core.mjs', 'deploy/auth-xiongan/install.mjs', 'deploy/auth-xiongan/8415wallet-auth-xiongan.service', 'deploy/auth-xiongan/auth-location.nginx.conf', 'docs/AUTH-INSTALL.md', 'scripts/package/verify-auth.mjs', 'LICENSE'];
  fail(required.every(file => expectedFiles.includes(file)), 'REQUIRED_FILE_MISSING');
  const sourcePackage = JSON.parse(readFileSync(join(directory, 'provenance/package.source.json'), 'utf8'));
  const sourceLock = JSON.parse(readFileSync(join(directory, 'provenance/package-lock.source.json'), 'utf8'));
  const runtime = runtimePackage(sourcePackage, sourceLock);
  assert.deepEqual(JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')), runtime.manifest, 'AUTH_PACKAGE_RUNTIME_PACKAGE_MISMATCH');
  assert.deepEqual(JSON.parse(readFileSync(join(directory, 'package-lock.json'), 'utf8')), runtime.lock, 'AUTH_PACKAGE_RUNTIME_LOCK_MISMATCH');
  const dependencyRoots = Object.keys(runtime.lock.packages).filter(Boolean).sort((a, b) => b.length - a.length);
  for (const path of dependencyRoots) {
    const installed = JSON.parse(readFileSync(join(directory, path, 'package.json'), 'utf8'));
    fail(installed.name === path.split('node_modules/').at(-1) && installed.version === runtime.lock.packages[path].version, 'DEPENDENCY_VERSION_MISMATCH');
    fail(!['preinstall', 'install', 'postinstall', 'prepare'].some(script => Object.hasOwn(installed.scripts ?? {}, script)), 'DEPENDENCY_INSTALL_SCRIPT_REFUSED');
  }
  for (const file of expectedFiles.filter(file => file.startsWith('node_modules/'))) {
    const owner = dependencyRoots.find(path => file.startsWith(`${path}/`));
    fail(owner && !file.slice(owner.length + 1).split('/').includes('node_modules'), 'UNLOCKED_DEPENDENCY_REFUSED');
  }
  const sums = files.filter(file => file !== 'SHA256SUMS').map(file => `${sha256(readFileSync(join(directory, file)))}  ${file}`).join('\n') + '\n';
  fail(readFileSync(join(directory, 'SHA256SUMS'), 'utf8') === sums, 'CHECKSUM_INVENTORY_MISMATCH');
  return release;
}

/** Strict bounded USTAR reader: validate every header before writing any file. */
export function readAuthArchive(bytes) {
  fail(bytes.length <= 128 * 1024 * 1024, 'ARCHIVE_TOO_LARGE');
  const tar = gunzipSync(bytes, { maxOutputLength: 256 * 1024 * 1024 });
  fail(tar.length % 512 === 0, 'TAR_LENGTH_REFUSED');
  const entries = []; const seen = new Set(); let offset = 0; let terminated = false;
  const string = buffer => buffer.subarray(0, buffer.indexOf(0) < 0 ? buffer.length : buffer.indexOf(0)).toString('utf8');
  const octal = buffer => { const value = string(buffer).trim(); fail(/^[0-7]+$/.test(value), 'TAR_NUMBER_REFUSED'); return parseInt(value, 8); };
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512); offset += 512;
    if (header.every(byte => byte === 0)) { fail(offset + 512 <= tar.length && tar.subarray(offset).every(byte => byte === 0), 'TAR_TRAILING_DATA_REFUSED'); terminated = true; break; }
    const checksum = octal(header.subarray(148, 156));
    fail(checksum === [...header].reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0), 'TAR_CHECKSUM_MISMATCH');
    fail(string(header.subarray(257, 263)) === 'ustar' && header.subarray(263, 265).toString() === '00', 'TAR_FORMAT_REFUSED');
    fail(header[156] === 48 && header.subarray(157, 257).every(byte => byte === 0), 'TAR_LINK_OR_TYPE_REFUSED');
    fail(octal(header.subarray(100, 108)) === 0o644 && octal(header.subarray(108, 116)) === 0 && octal(header.subarray(116, 124)) === 0 && octal(header.subarray(136, 148)) === 0, 'TAR_METADATA_REFUSED');
    const name = string(header.subarray(0, 100)); const prefix = string(header.subarray(345, 500));
    const path = prefix ? `${prefix}/${name}` : name;
    fail(packagePathAllowed(path) && !seen.has(path), 'TAR_PATH_OR_DUPLICATE_REFUSED'); seen.add(path);
    const size = octal(header.subarray(124, 136)); fail(size <= 32 * 1024 * 1024 && offset + size <= tar.length, 'TAR_ENTRY_SIZE_REFUSED');
    entries.push({ path, bytes: tar.subarray(offset, offset + size) });
    fail(entries.length <= 20000, 'TAR_ENTRY_COUNT_REFUSED');
    const padded = Math.ceil(size / 512) * 512;
    fail(tar.subarray(offset + size, offset + padded).every(byte => byte === 0), 'TAR_PADDING_REFUSED'); offset += padded;
  }
  fail(terminated && entries.length > 0, 'TAR_TERMINATOR_REQUIRED');
  return entries;
}
export function unpackAuthArchive(archive) {
  const entries = readAuthArchive(readFileSync(archive));
  const directory = mkdtempSync(join(tmpdir(), 'wallet-auth-verify-'));
  try {
    for (const { path, bytes } of entries) { mkdirSync(dirname(join(directory, path)), { recursive: true, mode: 0o755 }); writeFileSync(join(directory, path), bytes, { flag: 'wx', mode: 0o644 }); }
    return directory;
  } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; }
}

export function verifyAuthArchive(manifestPath) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  fail(/^8415wallet-auth-runtime-[0-9a-f]{40}\.tar\.gz$/.test(manifest.artifact) && hashPattern.test(manifest.sha256), 'MANIFEST_ARTIFACT_REFUSED');
  const archive = join(dirname(resolve(manifestPath)), manifest.artifact);
  fail(sha256(readFileSync(archive)) === manifest.sha256, 'ARCHIVE_DIGEST_MISMATCH');
  const directory = unpackAuthArchive(archive);
  try {
    const release = verifyAuthDirectory(directory);
    const { artifact: _artifact, sha256: _sha256, ...expectedRelease } = manifest;
    assert.deepEqual(release, expectedRelease, 'AUTH_PACKAGE_MANIFEST_RELEASE_MISMATCH');
    return release;
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || !['--directory', '--manifest'].includes(args[0]))) throw new Error('AUTH_PACKAGE_ARGUMENT_REFUSED');
  const release = args[0] === '--directory' ? verifyAuthDirectory(resolve(args[1])) : verifyAuthArchive(resolve(args[1] ?? 'dist/auth-package-manifest.json'));
  console.log(`Auth package integrity verified; source ${release.source.tree}; ${release.status}. Checksums establish integrity, not publisher authenticity or deployment acceptance.`);
}
