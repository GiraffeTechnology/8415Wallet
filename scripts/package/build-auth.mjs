/** Build an independent, dependency-complete auth runtime, never a public UI deployment. */
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { AUTH_SCHEMA, AUTH_STATUS, AUTH_STATE_SEMANTICS, jsonBytes, packagePathAllowed, runtimePackage, safePath, sha256, sourcePathAllowed, sourceTree, verifyAuthDirectory, walkAuth } from './verify-auth.mjs';

export function captureAuthSource(root) {
  const git = (args, options = {}) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
  if (resolve(git(['rev-parse', '--show-toplevel']).trim()) !== resolve(root)) throw new Error('AUTH_PACKAGE_SOURCE_REPOSITORY_REQUIRED');
  const commit = git(['rev-parse', 'HEAD']).trim(); const commitTree = git(['rev-parse', 'HEAD^{tree}']).trim(); const indexTree = git(['write-tree']).trim();
  const temporary = mkdtempSync(join(tmpdir(), 'wallet-auth-source-'));
  const env = { ...process.env, GIT_INDEX_FILE: join(temporary, 'index') };
  try {
    git(['read-tree', indexTree], { env });
    git(['add', '--update', '--', '.'], { env });
    const tree = git(['write-tree'], { env }).trim();
    const entries = git(['ls-tree', '-rz', tree]).split('\0').filter(Boolean).map(line => {
      const match = line.match(/^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/);
      if (!match || !safePath(match[3])) throw new Error('AUTH_PACKAGE_SOURCE_PATH_REFUSED');
      return { path: match[3], mode: match[1], object: match[2] };
    });
    if (sourceTree(entries) !== tree) throw new Error('AUTH_PACKAGE_SOURCE_TREE_MISMATCH');
    return { commit, commitTree, indexTree, tree, dirty: tree !== commitTree,
      identityVerification: 'local Git commit object and tracked/staged content snapshot; not a remote signature or CI attestation',
      commitObject: execFileSync('git', ['cat-file', 'commit', commit], { cwd: root }).toString('base64'), entries };
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

/** Fixed USTAR subset with only regular, non-executable files; no host metadata. */
export function deterministicAuthArchive(root) {
  const chunks = [];
  for (const path of walkAuth(root)) {
    if (!packagePathAllowed(path)) throw new Error(`AUTH_PACKAGE_PAYLOAD_ALLOWLIST_REFUSED: ${path}`);
    const bytes = readFileSync(join(root, path)); const header = Buffer.alloc(512);
    let name = path; let prefix = '';
    if (Buffer.byteLength(name) > 100) {
      const boundary = [...path.matchAll(/\//g)].map(match => match.index).find(index => Buffer.byteLength(path.slice(0, index)) <= 155 && Buffer.byteLength(path.slice(index + 1)) <= 100);
      if (boundary === undefined) throw new Error('AUTH_PACKAGE_TAR_PATH_TOO_LONG');
      prefix = path.slice(0, boundary); name = path.slice(boundary + 1);
    }
    const octal = (value, offset, length) => { const text = value.toString(8).padStart(length - 1, '0'); if (text.length >= length) throw new Error('AUTH_PACKAGE_TAR_NUMBER_REFUSED'); header.write(`${text}\0`, offset, length, 'ascii'); };
    header.write(name, 0, 100); octal(0o644, 100, 8); octal(0, 108, 8); octal(0, 116, 8); octal(bytes.length, 124, 12); octal(0, 136, 12);
    header.fill(32, 148, 156); header[156] = 48; header.write('ustar\0', 257, 6); header.write('00', 263, 2); header.write(prefix, 345, 155);
    const sum = [...header].reduce((total, byte) => total + byte, 0); header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
    chunks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks), { level: 9 });
}

function normalizeTree(root) {
  for (const name of readdirSync(root)) {
    const file = join(root, name); const stat = lstatSync(file);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || stat.isFile() && stat.nlink !== 1) throw new Error('AUTH_PACKAGE_UNSAFE_INSTALLED_FILE');
    chmodSync(file, stat.isDirectory() ? 0o755 : 0o644);
    if (stat.isDirectory()) normalizeTree(file);
  }
}

export function buildAuthPackage({ root = process.cwd(), offline = false, output = join(root, 'dist') } = {}) {
  root = resolve(root); output = resolve(output);
  const source = captureAuthSource(root); const staged = new Map(source.entries.map(entry => [entry.path, entry]));
  for (const folder of ['server', 'deploy/auth-xiongan']) {
    for (const name of readdirSync(join(root, folder))) {
      const path = `${folder}/${name}`;
      if (sourcePathAllowed(path) && !staged.has(path)) throw new Error(`AUTH_PACKAGE_UNTRACKED_SOURCE_STAGE_REQUIRED: ${path}`);
    }
  }
  const sourceBytes = path => {
    const entry = staged.get(path); if (!entry) throw new Error(`AUTH_PACKAGE_TRACKED_SOURCE_REQUIRED: ${path}`);
    return execFileSync('git', ['cat-file', 'blob', entry.object], { cwd: root, maxBuffer: 32 * 1024 * 1024 });
  };
  // Ensure the executing build/verification code is the recorded input, not an untracked local substitute.
  for (const path of ['scripts/package/build-auth.mjs', 'scripts/package/verify-auth.mjs']) {
    if (!sourceBytes(path).equals(readFileSync(join(root, path)))) throw new Error('AUTH_PACKAGE_BUILD_INPUT_MISMATCH');
  }
  const sourcePackageBytes = sourceBytes('package.json'); const sourceLockBytes = sourceBytes('package-lock.json');
  const runtime = runtimePackage(JSON.parse(sourcePackageBytes), JSON.parse(sourceLockBytes));
  const temporary = mkdtempSync(join(tmpdir(), 'wallet-auth-package-'));
  try {
    const stage = join(temporary, 'runtime'); mkdirSync(stage, { mode: 0o755 });
    for (const entry of source.entries.filter(entry => sourcePathAllowed(entry.path))) {
      mkdirSync(dirname(join(stage, entry.path)), { recursive: true, mode: 0o755 }); writeFileSync(join(stage, entry.path), sourceBytes(entry.path), { mode: 0o644 });
    }
    mkdirSync(join(stage, 'provenance'));
    writeFileSync(join(stage, 'provenance/package.source.json'), sourcePackageBytes);
    writeFileSync(join(stage, 'provenance/package-lock.source.json'), sourceLockBytes);
    writeFileSync(join(stage, 'package.json'), jsonBytes(runtime.manifest)); writeFileSync(join(stage, 'package-lock.json'), jsonBytes(runtime.lock));
    const npmArgs = ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--bin-links=false', ...(offline ? ['--offline'] : [])];
    // npm owns lockfile integrity verification. Never copy a developer node_modules tree.
    execFileSync('npm', npmArgs, { cwd: stage, stdio: 'inherit', timeout: 180000 });
    rmSync(join(stage, 'node_modules/.package-lock.json'), { force: true });
    normalizeTree(stage);
    // Check syntax without executing service entry points, reading secrets, or opening listeners.
    for (const file of walkAuth(stage).filter(file => sourcePathAllowed(file) && file.endsWith('.mjs'))) execFileSync(process.execPath, ['--check', join(stage, file)], { stdio: 'pipe' });
    const files = Object.fromEntries(walkAuth(stage).map(file => [file, sha256(readFileSync(join(stage, file)))]));
    const release = { schema: AUTH_SCHEMA, name: '8415wallet-auth-runtime', version: runtime.manifest.version, status: AUTH_STATUS,
      source, runtime: { node: '>=22.18.0', bundledNode: false, bundledProductionDependencies: true, entry: 'server/runtime-entry.mjs', tenantArgumentRequired: true, credentialStoreFormat: 1, legacyImportProtocol: 1, authStateSemantics: AUTH_STATE_SEMANTICS, openssl: 'External OpenSSL 3 required only for configured hardware CA verification' },
      build: { node: process.version, npm: execFileSync('npm', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(),
        command: 'node scripts/package/build-auth.mjs', dependencyCommand: ['npm', ...npmArgs].join(' '), sourceLockSha256: sha256(sourceLockBytes),
        installScripts: 'Disabled; package verification rejects any production install/prepare lifecycle script and lockfile hasInstallScript marker',
        archiveFormat: 'Sorted regular-file-only USTAR, epoch mtime, uid/gid 0, mode 0644; gzip level 9 with zero timestamp' },
      evidence: { integrity: 'Exact payload inventory, source blob/tree identities, lockfile-pinned production dependency installation; not publisher authentication',
        deployment: 'Not installed or activated; no credential, binding, listener, proxy or account created',
        acceptance: 'No production, genuine-wallet, hardware-device, independent audit or external CI acceptance inferred' }, files };
    writeFileSync(join(stage, 'AUTH-RELEASE.json'), jsonBytes(release));
    writeFileSync(join(stage, 'SHA256SUMS'), walkAuth(stage).map(file => `${sha256(readFileSync(join(stage, file)))}  ${file}`).join('\n') + '\n');
    verifyAuthDirectory(stage);
    if (captureAuthSource(root).tree !== source.tree) throw new Error('AUTH_PACKAGE_SOURCE_CHANGED_DURING_BUILD');
    const artifact = `8415wallet-auth-runtime-${source.tree}.tar.gz`; const archive = deterministicAuthArchive(stage);
    mkdirSync(output, { recursive: true });
    const temporaryArchive = join(output, `${artifact}.tmp-${process.pid}`); writeFileSync(temporaryArchive, archive); renameSync(temporaryArchive, join(output, artifact));
    const manifest = { artifact, sha256: sha256(archive), ...release };
    writeFileSync(join(output, 'auth-package-manifest.json'), jsonBytes(manifest));
    const extracted = join(output, 'package-auth'); rmSync(extracted, { recursive: true, force: true }); cpSync(stage, extracted, { recursive: true });
    return manifest;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 1 || args[0] !== '--offline')) throw new Error('AUTH_PACKAGE_ARGUMENT_REFUSED');
  const result = buildAuthPackage({ offline: args[0] === '--offline' });
  console.log(`${result.artifact}\nsha256 ${result.sha256}\nsource tree ${result.source.tree}${result.source.dirty ? ' (uncommitted tracked/staged changes included)' : ''}\n${result.status}`);
}
