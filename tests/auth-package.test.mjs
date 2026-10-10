import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { gzipSync, gunzipSync } from 'node:zlib';
import { captureAuthSource, deterministicAuthArchive } from '../scripts/package/build-auth.mjs';
import { LEGAL_FILES, AUTH_SCHEMA, AUTH_STATUS, AUTH_STATE_SEMANTICS, PASSWORD_AUTH_STATE_SEMANTICS, TASK_RUNTIME_SOURCE_PATHS, REGISTRATION_AUTH_STATE_SEMANTICS, LEGACY_AUTH_STATE_SEMANTICS, authStateSemantics, validateAuthStateTransition, jsonBytes, packagePathAllowed, readAuthArchive, runtimePackage, sha256, sourcePathAllowed, sourceTree, unpackAuthArchive, verifyAuthArchive, verifyAuthDirectory, walkAuth } from '../scripts/package/verify-auth.mjs';
import { paths, nginxLocation, upgrade, rollbackCode } from '../deploy/auth-xiongan/install.mjs';

function temporary(t) { const path = mkdtempSync(join(tmpdir(), 'wallet-auth-package-test-')); t.after(() => rmSync(path, { recursive: true, force: true })); return path; }
function put(root, path, value) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), value); chmodSync(join(root, path), 0o644); }
const sourcePackage = { name: '8415wallet', version: '0.1.0', license: 'SEE LICENSE IN LICENSE', dependencies: { ethers: '^6.17.0' }, devDependencies: { typescript: '^5.9.0' } };
const sourceLock = { name: '8415wallet', lockfileVersion: 3, packages: {
  '': { dependencies: sourcePackage.dependencies },
  'node_modules/ethers': { version: '6.17.0', resolved: 'https://registry.npmjs.org/ethers/-/ethers-6.17.0.tgz', integrity: 'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==' },
  'node_modules/typescript': { version: '5.9.3', dev: true },
} };
const sourcePaths = ['server/task-background-runner.mjs', 'server/task-authorization.mjs', 'server/task-receipt-adapter.mjs', 'server/method-change-service.mjs', ...TASK_RUNTIME_SOURCE_PATHS, 'server/main.mjs', 'server/service-entry.mjs', 'server/runtime-entry.mjs', 'server/auth-service.mjs', 'server/crypto.mjs', 'server/config-validation.mjs', 'server/ca-verifier.mjs', 'server/store.mjs', 'server/operator-init.mjs', 'server/operator-activate.mjs', 'web/login-core.mjs', 'deploy/auth-xiongan/install.mjs', 'deploy/auth-xiongan/8415wallet-auth-xiongan.service', 'deploy/auth-xiongan/auth-location.nginx.conf', 'docs/AUTH-INSTALL.md', 'scripts/package/verify-auth.mjs', ...LEGAL_FILES];
function git(root, args) { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function fixture(t, { semantics, label = '' } = {}) {
  const root = temporary(t); const sourceRoot = join(root, 'source'); const runtimeRoot = join(root, 'runtime'); mkdirSync(sourceRoot); mkdirSync(runtimeRoot);
  for (const path of sourcePaths) put(sourceRoot, path, path.endsWith('.mjs') ? 'export {};\n' : `Synthetic package fixture: ${path}\n`);
  if (label) put(sourceRoot, 'docs/AUTH-INSTALL.md', `Synthetic package fixture: ${label}\n`);
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
    runtime: { node: '>=22.18.0', bundledNode: false, bundledProductionDependencies: true, credentialStoreFormat: 1,
      ...(semantics === undefined ? {} : { authStateSemantics: semantics }) },
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
test('auth state semantics allow only the reviewed forward edge and same-generation rollback', () => {
  const legacy = { runtime: { credentialStoreFormat: 1 } };
  const explicitLegacy = { runtime: { credentialStoreFormat: 1, authStateSemantics: LEGACY_AUTH_STATE_SEMANTICS } };
  const registration = { runtime: { credentialStoreFormat: 1, authStateSemantics: REGISTRATION_AUTH_STATE_SEMANTICS } };
  const current = { runtime: { credentialStoreFormat: 1, authStateSemantics: AUTH_STATE_SEMANTICS } };
  assert.doesNotThrow(() => validateAuthStateTransition(legacy, registration));
  assert.doesNotThrow(() => validateAuthStateTransition(registration, current));
  assert.throws(() => validateAuthStateTransition(registration, legacy), /STATE_SEMANTICS_DOWNGRADE_REFUSED/);
  assert.equal(authStateSemantics(legacy), LEGACY_AUTH_STATE_SEMANTICS);
  assert.doesNotThrow(() => validateAuthStateTransition(legacy, explicitLegacy, { rollback: true }));
  assert.doesNotThrow(() => validateAuthStateTransition(legacy, current));
  assert.doesNotThrow(() => validateAuthStateTransition(current, structuredClone(current), { rollback: true }));
  for (const old of [legacy, explicitLegacy, registration]) {
    assert.throws(() => validateAuthStateTransition(current, old), /STATE_SEMANTICS_DOWNGRADE_REFUSED/);
    assert.throws(() => validateAuthStateTransition(current, old, { rollback: true }), /STATE_SEMANTICS_DOWNGRADE_REFUSED/);
  }
  assert.throws(() => validateAuthStateTransition(legacy, current, { rollback: true }), /STATE_SEMANTICS_TRANSITION_REFUSED/);
  for (const value of [null, 2, '', '8415wallet-auth-state/5', '1', {}]) {
    assert.throws(() => authStateSemantics({ runtime: { authStateSemantics: value } }), /STATE_SEMANTICS_REFUSED/);
    assert.throws(() => validateAuthStateTransition(current, { runtime: { authStateSemantics: value } }), /STATE_SEMANTICS_REFUSED/);
  }
});
test('directory verification preserves legacy readability and validates the independent state declaration', t => {
  const f = fixture(t);
  assert.equal(authStateSemantics(verifyAuthDirectory(f.runtimeRoot)), LEGACY_AUTH_STATE_SEMANTICS);
  f.release.runtime.authStateSemantics = AUTH_STATE_SEMANTICS; f.update();
  assert.equal(verifyAuthDirectory(f.runtimeRoot).runtime.credentialStoreFormat, 1);
  assert.equal(authStateSemantics(verifyAuthDirectory(f.runtimeRoot)), AUTH_STATE_SEMANTICS);
  f.release.runtime.authStateSemantics = '8415wallet-auth-state/5'; f.update();
  assert.throws(() => verifyAuthDirectory(f.runtimeRoot), /STATE_SEMANTICS_REFUSED/);
});

// Build only an isolated receipt/configuration fixture. No prepare, listener,
// credential decryption or subprocess is needed to exercise code transitions.
function installedFixture(f, { prior, status = 'prepared-not-activated' } = {}) {
  const tenant = 'state-test', target = paths(join(f.root, 'host'), tenant);
  for (const directory of [target.root, target.config, target.state, dirname(target.unit)]) mkdirSync(directory, { recursive: true, mode: 0o755 });
  chmodSync(target.config, 0o700); chmodSync(target.state, 0o700);
  const install = item => {
    const runtime = join(target.root, 'releases', item.release.source.tree);
    mkdirSync(dirname(runtime), { recursive: true }); cpSync(item.runtimeRoot, runtime, { recursive: true });
    return { runtime, sourceTree: item.release.source.tree, releaseManifestSha256: sha256(readFileSync(join(runtime, 'AUTH-RELEASE.json'))) };
  };
  const current = install(f), previousReleases = prior ? [install(prior)] : [];
  const config = { origin: 'https://wallet.example.invalid:9447', tenant,
    socketPath: join(target.socketDirectory, 'auth.sock'), reservedPorts: [], statePath: join(target.state, 'credentials.enc'),
    accounts: [{ username: 'fixture-user', wallets: [{ account: `0x${'1'.repeat(40)}`, chainId: '8453' }] }] };
  const node = join(f.root, 'synthetic-node-never-executed'); put(f.root, 'synthetic-node-never-executed', 'Synthetic identity bytes; never executed.\n');
  const unit = '# Synthetic unit; never installed or started.\n'; put(dirname(target.unit), target.unit.split('/').at(-1), unit);
  const privatePut = (path, value) => { writeFileSync(path, value, { mode: 0o600 }); chmodSync(path, 0o600); };
  privatePut(join(target.config, 'auth.json'), jsonBytes(config));
  privatePut(join(target.config, 'auth-location.nginx.conf'), nginxLocation(config.socketPath));
  const receipt = { schema: '8415wallet-auth-install/1', ...current, node, nodeUid: process.getuid(), nodeSha256: sha256(readFileSync(node)),
    origin: config.origin, tenant, socketPath: config.socketPath, reservedPorts: [], unitSha256: sha256(unit), status, previousReleases };
  privatePut(join(target.root, 'installation.json'), jsonBytes(receipt)); symlinkSync(current.runtime, join(target.root, 'current'));
  return { target, receipt, config, privatePut, options: { target, uid: process.getuid(), run: () => assert.fail('inactive transition must not run a service command') } };
}
test('legacy inactive installation can upgrade to new semantics without creating credential state', async t => {
  const legacy = fixture(t, { label: 'legacy-forward' }), next = fixture(t, { semantics: AUTH_STATE_SEMANTICS, label: 'new-forward' });
  const f = installedFixture(legacy);
  assert.equal((await upgrade({ ...f.options, packageDirectory: next.runtimeRoot })).status, 'code-upgraded');
  assert.equal(readlinkSync(join(f.target.root, 'current')), join(f.target.root, 'releases', next.release.source.tree));
  assert.equal(existsSync(join(f.target.config, 'store-key')), false);
  assert.equal(existsSync(f.config.statePath), false);
  await assert.rejects(rollbackCode(f.options), /STATE_SEMANTICS_DOWNGRADE_REFUSED/);
  assert.equal(existsSync(join(f.target.root, 'operation.lock')), false);
});
for (const semantics of [undefined, REGISTRATION_AUTH_STATE_SEMANTICS, PASSWORD_AUTH_STATE_SEMANTICS]) for (const state of ['never-activated', 'registered', 'reserved-reset']) {
  test(`code transitions preserve ${state} state and refuse downgrade to ${semantics ?? 'legacy'} before any switch`, async t => {
    const legacy = fixture(t, { semantics, label: `old-${state}` });
    const current = fixture(t, { semantics: AUTH_STATE_SEMANTICS, label: `current-${state}` });
    const next = fixture(t, { semantics: AUTH_STATE_SEMANTICS, label: `next-${state}` });
    const f = installedFixture(current, { prior: legacy }), keyPath = join(f.target.config, 'store-key');
    // Deliberately opaque synthetic bytes: transitions must not inspect, decode,
    // replace or infer permission to downgrade from credential contents.
    const bytes = Buffer.from(jsonBytes({ fixtureOnly: true, registration: { email: 'fixture@example.invalid' },
      passwordHash: 'SYNTHETIC-HASH', enabledMethods: { password: false },
      ...(state === 'reserved-reset' ? { recoveryProfile: { answerHash: 'SYNTHETIC-ANSWER-HASH' }, recoveryHashes: ['SYNTHETIC-UNUSED-CODE'], revision: 9 } : {}) }));
    if (state !== 'never-activated') { f.privatePut(keyPath, 'SYNTHETIC-NON-CREDENTIAL'); f.privatePut(f.config.statePath, bytes); }
    const originalReceipt = readFileSync(join(f.target.root, 'installation.json')), originalConfig = readFileSync(join(f.target.config, 'auth.json'));
    await assert.rejects(upgrade({ ...f.options, packageDirectory: legacy.runtimeRoot }), /STATE_SEMANTICS_DOWNGRADE_REFUSED/);
    await assert.rejects(rollbackCode(f.options), /STATE_SEMANTICS_DOWNGRADE_REFUSED/);
    assert.deepEqual(readFileSync(join(f.target.root, 'installation.json')), originalReceipt);
    assert.equal(readlinkSync(join(f.target.root, 'current')), f.receipt.runtime);
    assert.equal((await upgrade({ ...f.options, packageDirectory: next.runtimeRoot })).status, 'code-upgraded');
    assert.equal((await rollbackCode(f.options)).sourceTree, current.release.source.tree);
    assert.deepEqual(readFileSync(join(f.target.config, 'auth.json')), originalConfig);
    assert.equal(existsSync(join(f.target.root, 'operation.lock')), false);
    if (state === 'never-activated') { assert.equal(existsSync(keyPath), false); assert.equal(existsSync(f.config.statePath), false); }
    else { assert.equal(readFileSync(keyPath, 'utf8'), 'SYNTHETIC-NON-CREDENTIAL'); assert.deepEqual(readFileSync(f.config.statePath), bytes); }
  });
}
for (const semantics of [undefined, REGISTRATION_AUTH_STATE_SEMANTICS, PASSWORD_AUTH_STATE_SEMANTICS]) test(`uncertain cross-generation start never falls back to ${semantics ?? 'legacy'} code`, async t => {
  const legacy = fixture(t, { semantics, label: 'legacy-running' }), next = fixture(t, { semantics: AUTH_STATE_SEMANTICS, label: 'new-uncertain-start' });
  const f = installedFixture(legacy, { status: 'proxy-enabled' }), calls = [];
  const state = Buffer.from('SYNTHETIC-STATE-MUST-STAY-UNCHANGED'); f.privatePut(f.config.statePath, state);
  const run = async (file, args) => { calls.push([file, args]); if (args[0] === 'start') throw Error('Synthetic uncertain start; no process was launched.'); };
  await assert.rejects(upgrade({ ...f.options, packageDirectory: next.runtimeRoot, run }), /AUTH_UPGRADE_STATE_SEMANTICS_RECOVERY_REQUIRED/);
  assert.deepEqual(calls.map(([, args]) => args[0]), ['stop', 'start', 'stop']);
  assert.equal(readlinkSync(join(f.target.root, 'current')), join(f.target.root, 'releases', next.release.source.tree));
  assert.equal(existsSync(join(f.target.root, 'operation.lock')), true);
  assert.deepEqual(readFileSync(f.config.statePath), state);
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

for (const path of LEGAL_FILES) test(`current auth policy refuses an omitted legal file even with rewritten inventories: ${path}`, t => {
  const f = fixture(t);
  git(f.sourceRoot, ['rm', path]); rmSync(join(f.runtimeRoot, path));
  f.release.source = captureAuthSource(f.sourceRoot); f.update();
  assert.throws(() => verifyAuthDirectory(f.runtimeRoot), /REQUIRED_(?:LEGAL_)?FILE_MISSING/);
});
test('independently licensed existing auth packages remain verifiable with their original notice inventory', t => {
  const f = fixture(t), legacyPackage = { ...sourcePackage, license: 'CC0-1.0' };
  put(f.sourceRoot, 'package.json', jsonBytes(legacyPackage));
  put(f.runtimeRoot, 'provenance/package.source.json', jsonBytes(legacyPackage));
  const runtime = runtimePackage(legacyPackage, sourceLock);
  put(f.runtimeRoot, 'package.json', jsonBytes(runtime.manifest)); put(f.runtimeRoot, 'package-lock.json', jsonBytes(runtime.lock));
  for (const path of LEGAL_FILES.filter(path => path !== 'LICENSE')) {
    git(f.sourceRoot, ['rm', path]); rmSync(join(f.runtimeRoot, path));
  }
  f.release.source = captureAuthSource(f.sourceRoot); f.update();
  assert.doesNotThrow(() => verifyAuthDirectory(f.runtimeRoot));
});



test('task runtime source closure has the exact contract and receipt TypeScript module set', t => {
  const f = fixture(t, { semantics: AUTH_STATE_SEMANTICS });
  assert.deepEqual(TASK_RUNTIME_SOURCE_PATHS, ['src/agent/receiptObservation.ts', 'src/agent/taskContract.ts', 'src/codec/abi.ts', 'src/codec/keccak.ts',
    'src/controls/accounts.ts', 'src/controls/authorization.ts', 'src/controls/client.ts', 'src/controls/execution.ts',
    'src/sdk/errors.ts', 'src/sdk/interfaceIds.ts', 'src/xiongan/address.ts', 'src/xiongan/externalAssets.ts']);
  assert.doesNotThrow(() => verifyAuthDirectory(f.runtimeRoot));
  assert.equal(packagePathAllowed('src/agent/unauthorized.ts'), false);
  put(f.runtimeRoot, 'src/agent/unauthorized.ts', 'export {};\n'); f.update();
  assert.throws(() => verifyAuthDirectory(f.runtimeRoot), /PAYLOAD_ALLOWLIST_REFUSED/);
});
for (const path of TASK_RUNTIME_SOURCE_PATHS) test(`task runtime refuses missing or altered canonical source: ${path}`, t => {
  const f = fixture(t, { semantics: AUTH_STATE_SEMANTICS });
  const original = readFileSync(join(f.runtimeRoot, path));
  put(f.runtimeRoot, path, 'changed source\n');
  assert.throws(() => verifyAuthDirectory(f.runtimeRoot), /FILE_DIGEST_MISMATCH/);
  f.update(); assert.throws(() => verifyAuthDirectory(f.runtimeRoot), /SOURCE_BLOB_MISMATCH/);
  put(f.runtimeRoot, path, original); f.update(); rmSync(join(f.runtimeRoot, path)); f.update();
  assert.throws(() => verifyAuthDirectory(f.runtimeRoot), /SOURCE_PAYLOAD_COMPLETENESS/);
});
test('password generation /3 can upgrade to /4 without changing user, key or credential bytes', async t => {
  const old = fixture(t, { semantics: PASSWORD_AUTH_STATE_SEMANTICS, label: 'password-generation' });
  const next = fixture(t, { semantics: AUTH_STATE_SEMANTICS, label: 'task-generation' }), f = installedFixture(old);
  const keyPath = join(f.target.config, 'store-key'), keyBytes = Buffer.alloc(32, 0x45), stateBytes = Buffer.from('Synthetic encrypted credential bytes preserved unchanged');
  f.privatePut(keyPath, keyBytes); f.privatePut(f.config.statePath, stateBytes);
  const configBytes = readFileSync(join(f.target.config, 'auth.json'));
  assert.equal((await upgrade({ ...f.options, packageDirectory: next.runtimeRoot })).status, 'code-upgraded');
  assert.deepEqual(readFileSync(keyPath), keyBytes); assert.deepEqual(readFileSync(f.config.statePath), stateBytes);
  assert.deepEqual(readFileSync(join(f.target.config, 'auth.json')), configBytes);
});
