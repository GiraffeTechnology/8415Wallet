/** Read-only, externally pinned origin and public-product boundary verification. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const TOOLING_VERSION = '8415wallet-public-product-tooling/2';
export const TOOLING_FILES = Object.freeze([
  'scripts/package/build-public-product.mjs', 'scripts/package/verify-product-origin.mjs',
  'tests/product-source.test.mjs', 'docs/PUBLIC-PRODUCT-KIT.md',
]);
export const POLICY_SCHEMA = '8415wallet-product-source-policy/2';
export const ORIGIN_FILE = 'PRODUCT-ORIGIN.json';
export const LEGAL_FILES = Object.freeze(['LICENSE', 'THIRD_PARTY_NOTICES.md', 'LICENSES/CC0-1.0.txt']);
export const DAPP_DOCUMENTS = Object.freeze([
  'docs/ERC-8415-Wallet-PRD.md', 'docs/BETA-DAPP-DELIVERY.md', 'docs/BETA-PRD-COVERAGE.md',
  'docs/STANDARDS-COMPATIBILITY.md', 'docs/WALLET-LOGIN.md', 'docs/ACCOUNT-AUTHENTICATION.md',
  'docs/APPROVED-UI-IMPLEMENTATION.md', 'docs/TENANT-AVATAR.md', 'docs/stages/LEGACY-CLEARING-BETA-DAPP.md',
]);
export const MANDATORY_PATHS = Object.freeze([
  ...LEGAL_FILES, ...DAPP_DOCUMENTS, 'docs/AUTH-INSTALL.md', 'docs/DAPP-INSTALL.md',
  'docs/INTEGRATION.md', 'docs/INTEGRATION-BOUNDARIES.md', 'docs/V2-CLOSEOUT.md',
  'docs/RESPONSIBILITY-CONTROLS-SECURITY.md', 'docs/V3-REVIEW-AND-VALIDATION.md',
  'docs/stages/STAGE-5J-PUBLIC-PATH-AND-UI.md', 'docs/V3-DEVELOPMENT-CLOSURE.md', 'docs/XIONGAN-WALLET.md',
  'PACKAGE.md', 'PACKAGE-V3.md', 'README.md', 'README-package.md', 'package.json', 'package-lock.json',
  'tsconfig.json', 'tsconfig.browser.json', 'tsconfig.package.json', 'tsconfig.package-v3.json',
  'config/releases/v2.json', 'config/releases/v3.json', 'config/releases/xiongan-v2.json',
  'deploy/dapp/install.mjs', 'deploy/auth-xiongan/install.mjs', 'deploy/auth-xiongan/migrate-legacy.mjs',
  'deploy/auth-xiongan/8415wallet-auth-xiongan.service', 'deploy/auth-xiongan/auth-location.nginx.conf',
  'server/main.mjs', 'server/runtime-entry.mjs', 'server/service-entry.mjs',
  'src/index.ts', 'src/v2.ts', 'src/browser.ts', 'src/cli/main.ts', 'src/controls/index.ts',
  'src/controls/fileOperationStore.ts', 'web/index.html', 'web/release-profile.mjs', 'web/release-config.json',
  'web/tenant-password-routing.json', 'web/tenant-password-routing.mjs', 'web/tenant-password-ui.mjs',
  ...['build-auth', 'build-dapp', 'build-delivery', 'build-login-vendor', 'build-v2', 'build-v3',
    'dapp-release', 'release-contract', 'shared', 'v3-document-contract', 'verify-auth', 'verify-dapp',
    'verify-delivery', 'verify-install', 'verify-install-v3'].map(name => `scripts/package/${name}.mjs`),
]);
export const NONPRODUCT_GENERATED_CACHE = Object.freeze([
  'src/kit/sdk/python/erc8415/__pycache__/__init__.cpython-311.pyc',
  'src/kit/sdk/python/erc8415/__pycache__/client.cpython-311.pyc',
]);
export const NONPRODUCT_SOURCE_FAMILY_EXCLUSIONS = Object.freeze([
  ...NONPRODUCT_GENERATED_CACHE, ...TOOLING_FILES.filter(path => path.startsWith('scripts/package/')),
]);
const FAMILIES = ['src/', 'server/', 'web/', 'contracts/', 'conformance/', 'deploy/', 'scripts/package/'];
const CATEGORIES = ['legal', 'documentation', 'package_and_compiler', 'profiles', 'packaging',
  'runtime_and_installers', 'application', 'contracts_and_conformance'];
const HEX40 = /^[a-f0-9]{40}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const fail = (condition, code) => { if (!condition) throw Error(`PRODUCT_${code}`); };
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const gitHash = (type, bytes) => createHash('sha1').update(`${type} ${bytes.length}\0`).update(bytes).digest('hex');
export const jsonBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const equalKeys = (object, keys, label) => assert.deepEqual(Object.keys(object ?? {}).sort(), [...keys].sort(), `PRODUCT_${label}_KEYS`);

export function safePath(path) {
  return typeof path === 'string' && path.length <= 240 && /^[A-Za-z0-9_./-]+$/.test(path)
    && path.split('/').every(part => part && part !== '.' && part !== '..' && !part.startsWith('.'));
}
export function permittedSourcePath(path) {
  return safePath(path) && path !== ORIGIN_FILE && !/\.(?:zip|tar|tgz|gz|bz2|xz|7z|rar|pem|key|p12|pfx|sqlite|db)$/i.test(path)
    && !/^(?:releases|tests|node_modules|dist|provenance|docs\/deployment)(?:\/|$)/i.test(path)
    && !/(?:^|\/)(?:AGENTS\.md|CONTROL-DEVELOPMENT-STATUS\.md|DEPLOY\.md|DOMAIN\.md|SIN-DEPLOYMENT-HANDOFF\.md)$/i.test(path)
    && !/^(?:config\/)/.test(path) && !/\.pyc$/i.test(path) && !path.split('/').includes('__pycache__');
}
// Configuration has a deliberately separate exact public-profile exception.
const sourcePathAllowed = path => (permittedSourcePath(path) || /^config\/releases\/(?:v2|v3|xiongan-v2)\.json$/.test(path))
  && !['docs/AUTH-PROVISIONING-PREPARATION.md', 'docs/AUTH-RECOVERY.md', ...TOOLING_FILES].includes(path);

export function cleanEnvironment() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_|^NODE_OPTIONS$|^NODE_PATH$/.test(key)));
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', TZ: 'UTC' };
}
export function git(root, args, options = {}) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args],
    { cwd: root, env: cleanEnvironment(), stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 128 * 1024 * 1024, ...options });
}
export function safeDirectory(root) {
  root = resolve(root);
  fail(realpathSync(root) === root, 'DIRECTORY_SYMLINK_REFUSED');
  for (let path = root; ; path = dirname(path)) {
    const stat = lstatSync(path); fail(stat.isDirectory() && !stat.isSymbolicLink(), 'DIRECTORY_REFUSED');
    if (path === dirname(path)) break;
  }
  return root;
}
export function regularFile(root, path, { tracked = false } = {}) {
  // Full-repository cleanliness includes hidden tracked files; public inputs do not.
  const trackedPath = typeof path === 'string' && path.length <= 4096 && /^[A-Za-z0-9_./-]+$/.test(path)
    && path.split('/').every(part => part && part !== '.' && part !== '..' && part !== '.git');
  fail(tracked ? trackedPath : safePath(path), 'UNSAFE_PATH');
  let target = safeDirectory(root);
  for (const component of path.split('/').slice(0, -1)) {
    target = join(target, component); const stat = lstatSync(target);
    fail(stat.isDirectory() && !stat.isSymbolicLink(), `PATH_DIRECTORY_REFUSED: ${path}`);
  }
  const file = join(root, path), stat = lstatSync(file);
  fail(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && !(stat.mode & 0o7022), `FILE_TYPE_OR_MODE_REFUSED: ${path}`);
  fail([0o644, 0o755].includes(stat.mode & 0o777), `FILE_MODE_REFUSED: ${path}`);
  return { bytes: readFileSync(file), mode: (stat.mode & 0o111) ? '100755' : '100644' };
}
export function walkFiles(root, ignoredRoots = []) {
  safeDirectory(root); const files = [];
  const walk = prefix => {
    for (const name of readdirSync(join(root, prefix)).sort()) {
      if (!prefix && ignoredRoots.includes(name)) {
        const stat = lstatSync(join(root, name)); fail(stat.isDirectory() && !stat.isSymbolicLink(), `IGNORED_DIRECTORY_REFUSED: ${name}`); continue;
      }
      const path = prefix ? `${prefix}/${name}` : name;
      fail(safePath(path), `UNSAFE_PATH: ${path}`);
      const stat = lstatSync(join(root, path)); fail(!stat.isSymbolicLink(), `SYMLINK_REFUSED: ${path}`);
      if (stat.isDirectory()) walk(path); else { regularFile(root, path); files.push(path); }
    }
  };
  walk(''); return files.sort();
}
export function loadPolicy(path, expectedSha256) {
  fail(HEX64.test(expectedSha256 ?? ''), 'EXTERNAL_ALLOWLIST_PIN_REQUIRED');
  path = resolve(path); const bytes = regularFile(dirname(path), path.split('/').at(-1)).bytes;
  fail(sha256(bytes) === expectedSha256, 'ALLOWLIST_DIGEST_MISMATCH');
  const policy = JSON.parse(bytes);
  equalKeys(policy, ['schema', 'version', 'product', 'review', 'mandatory', 'entries'], 'POLICY');
  fail(policy.schema === POLICY_SCHEMA && policy.version === 2 && policy.product === '8415wallet', 'POLICY_IDENTITY_REFUSED');
  equalKeys(policy.review, ['status', 'blockers', 'holds'], 'REVIEW');
  fail(['blocked', 'pending', 'approved-for-local-build'].includes(policy.review.status)
    && Array.isArray(policy.review.blockers) && Array.isArray(policy.review.holds), 'REVIEW_REFUSED');
  if (policy.review.status === 'approved-for-local-build') fail(!policy.review.blockers.length && !policy.review.holds.length, 'UNRESOLVED_REVIEW');
  fail(Array.isArray(policy.entries) && policy.entries.length > 0 && policy.entries.length <= 20000, 'ENTRIES_REFUSED');
  let previous = ''; const paths = new Set();
  for (const entry of policy.entries) {
    equalKeys(entry, ['path', 'mode', 'git_blob_sha1', 'sha256'], 'ENTRY');
    fail(sourcePathAllowed(entry.path) && previous < entry.path && !paths.has(entry.path), `PATH_ALLOWLIST_REFUSED: ${entry.path}`);
    fail(['100644', '100755'].includes(entry.mode) && HEX40.test(entry.git_blob_sha1) && HEX64.test(entry.sha256), 'ENTRY_IDENTITY_REFUSED');
    previous = entry.path; paths.add(entry.path);
  }
  equalKeys(policy.mandatory, CATEGORIES, 'MANDATORY');
  const mandatory = Object.values(policy.mandatory).flat();
  fail(Object.values(policy.mandatory).every(group => Array.isArray(group) && group.every(path => typeof path === 'string')),
    'MANDATORY_CATEGORY_REFUSED');
  fail(new Set(mandatory).size === mandatory.length, 'MANDATORY_DUPLICATE');
  assert.deepEqual(mandatory.sort(), [...paths].sort(), 'PRODUCT_MANDATORY_INVENTORY_MISMATCH');
  fail(MANDATORY_PATHS.every(path => paths.has(path)), 'MANDATORY_INPUT_MISSING');
  return { policy, policySha256: expectedSha256 };
}
export function toolingIdentity(toolingRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), expectedSha256) {
  const files = TOOLING_FILES.map(path => ({ path, sha256: sha256(regularFile(toolingRoot, path).bytes) }));
  const identity = { version: TOOLING_VERSION, sha256: sha256(jsonBytes(files)), files };
  fail(HEX64.test(expectedSha256 ?? ''), 'EXTERNAL_TOOLING_PIN_REQUIRED');
  fail(identity.sha256 === expectedSha256, 'TOOLING_DIGEST_MISMATCH');
  return identity;
}
export function computeToolingPin(toolingRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')) {
  return sha256(jsonBytes(TOOLING_FILES.map(path => ({ path, sha256: sha256(regularFile(toolingRoot, path).bytes) }))));
}
function treeListing(bytes, index = false) {
  const entries = bytes.toString('utf8').split('\0').filter(Boolean).map(line => {
    const match = line.match(index ? /^(\d{6}) ([a-f0-9]{40}) 0\t(.+)$/ : /^(\d{6}) (blob|commit) ([a-f0-9]{40})\t(.+)$/);
    fail(match, 'UPSTREAM_LISTING_REFUSED');
    return index ? { mode: match[1], object: match[2], path: match[3] } : { mode: match[1], object: match[3], path: match[4] };
  });
  return entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
/** The source tree function has no Git write operations and includes modes. */
export function contentTree(entries) {
  const root = new Map();
  for (const entry of entries) {
    fail(safePath(entry.path) && ['100644', '100755'].includes(entry.mode) && HEX40.test(entry.object), 'TREE_ENTRY_REFUSED');
    const parts = entry.path.split('/'); let directory = root;
    for (const part of parts.slice(0, -1)) {
      if (!directory.has(part)) directory.set(part, new Map());
      fail(directory.get(part) instanceof Map, 'TREE_COLLISION'); directory = directory.get(part);
    }
    fail(!directory.has(parts.at(-1)), 'TREE_DUPLICATE'); directory.set(parts.at(-1), entry);
  }
  const hash = directory => {
    const records = [...directory].map(([name, value]) => ({ name, value, dir: value instanceof Map }));
    records.sort((a, b) => Buffer.compare(Buffer.from(a.name + (a.dir ? '/' : '')), Buffer.from(b.name + (b.dir ? '/' : ''))));
    return gitHash('tree', Buffer.concat(records.map(({ name, value, dir }) => Buffer.concat([
      Buffer.from(`${dir ? '40000' : value.mode} ${name}\0`), Buffer.from(dir ? hash(value) : value.object, 'hex'),
    ]))));
  };
  return hash(root);
}
export function localCommitBytes(tree) {
  fail(HEX40.test(tree), 'PRODUCT_TREE_REQUIRED');
  return Buffer.from(`tree ${tree}\nauthor 8415wallet Product Export <product-export@invalid.example> 0 +0000\ncommitter 8415wallet Product Export <product-export@invalid.example> 0 +0000\n\nDeterministic local curated product export. No upstream history or CI attestation.\n`);
}
function importsOf(path, bytes) {
  const text = bytes.toString('utf8'); const imports = [];
  // Restricted source-contract scanner: pinned current source uses literal static
  // import/export declarations and literal dynamic imports. New syntax needs review.
  for (const match of text.matchAll(/^\s*(?:import|export)\s+(?:[^'";]*?\s+from\s*)?(['"])([^'"\n]+)\1/gm)) imports.push(match[2]);
  for (const match of text.matchAll(/\bimport\s*\(([^)]*)\)/g)) {
    const literal = match[1].trim().match(/^(['"])([^'"\n]+)\1$/);
    fail(literal, `NONLITERAL_IMPORT_REFUSED: ${path}`); imports.push(literal[2]);
  }
  return imports;
}
function resolveImport(path, specifier, selected) {
  const target = posix.normalize(posix.join(posix.dirname(path), specifier));
  fail(safePath(target), `IMPORT_ESCAPE: ${path}`);
  if (selected.has(target)) return target;
  if (target.startsWith('dist/browser/') && target.endsWith('.js')) {
    if (target === 'dist/browser/vendor/ethers.js') return null;
    const source = `src/${target.slice('dist/browser/'.length, -3)}.ts`;
    fail(selected.has(source), `GENERATED_IMPORT_SOURCE_MISSING: ${path} -> ${target}`); return source;
  }
  // NodeNext sources may spell the emitted extension in an import.
  if (target.endsWith('.js') && selected.has(`${target.slice(0, -3)}.ts`)) return `${target.slice(0, -3)}.ts`;
  throw Error(`PRODUCT_IMPORT_MISSING: ${path} -> ${target}`);
}
export function isArchiveBytes(bytes) {
  return ['504b0304', '504b0506', '504b0708', '1f8b08', '425a68', 'fd377a585a00', '377abcaf271c', '526172211a07'].some(hex => bytes.subarray(0, hex.length / 2).equals(Buffer.from(hex, 'hex')))
    || bytes.subarray(257, 262).toString() === 'ustar';
}
function contractArray(blobs, path, name, spreads = {}) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = blobs.get(path).toString().match(new RegExp(`export const ${escaped} = (?:Object\\.freeze\\()?\\[([\\s\\S]*?)\\]`));
  fail(match, `CONTRACT_ARRAY_MISSING: ${path}:${name}`);
  const paths = [];
  for (const token of match[1].split(',').map(value => value.trim()).filter(Boolean)) {
    const literal = token.match(/^(['"])([A-Za-z0-9_./-]+)\1$/);
    if (literal) paths.push(literal[2]);
    else { const spread = token.match(/^\.\.\.([A-Z_]+)$/); fail(spread && spreads[spread[1]], `CONTRACT_SYNTAX_REFUSED: ${path}:${name}`); paths.push(...spreads[spread[1]]); }
  }
  fail(new Set(paths).size === paths.length, `CONTRACT_DUPLICATE: ${path}:${name}`); return paths;
}
export function verifyClosure(policy, blobs) {
  const selected = new Set(policy.entries.map(entry => entry.path));
  const legal = contractArray(blobs, 'scripts/package/verify-auth.mjs', 'LEGAL_FILES');
  assert.deepEqual(legal, [...LEGAL_FILES], 'PRODUCT_LEGAL_CONTRACT_CHANGED');
  for (const [path, name] of [['scripts/package/verify-delivery.mjs', 'DELIVERY_FILES'], ['scripts/package/v3-document-contract.mjs', 'V2_DOCUMENTS'], ['scripts/package/v3-document-contract.mjs', 'V3_DOCUMENTS']])
    for (const required of contractArray(blobs, path, name, { LEGAL_FILES: legal })) fail(selected.has(required), `MANDATORY_CONTRACT_INPUT_MISSING: ${required}`);
  const packageJson = JSON.parse(blobs.get('package.json'));
  const lock = JSON.parse(blobs.get('package-lock.json'));
  fail(packageJson.name === '8415wallet' && lock.lockfileVersion === 3, 'PACKAGE_INPUT_REFUSED');
  assert.deepEqual(lock.packages?.['']?.dependencies ?? {}, packageJson.dependencies ?? {}, 'PRODUCT_PACKAGE_LOCK_DEPENDENCIES');
  const dependencies = new Set([...Object.keys(packageJson.dependencies ?? {}), ...Object.keys(packageJson.devDependencies ?? {})]);
  const builtins = new Set(builtinModules.map(name => name.replace(/^node:/, '')));
  const graph = new Map();
  for (const [path, bytes] of blobs) {
    if (/\.(?:ts|mjs|js|sol)$/.test(path)) {
      const resolved = [];
      for (const specifier of importsOf(path, bytes)) {
        if (specifier.startsWith('.')) { const target = resolveImport(path, specifier, selected); if (target) resolved.push(target); }
        else {
          const packageName = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
          fail(builtins.has(specifier.replace(/^node:/, '')) || dependencies.has(packageName) || packageName === packageJson.name, `UNDECLARED_IMPORT: ${path} -> ${specifier}`);
        }
      }
      graph.set(path, resolved);
      if (path.startsWith('scripts/package/')) for (const match of bytes.toString().matchAll(/['"](docs\/[A-Za-z0-9_./-]+\.md)['"]/g))
        fail(selected.has(match[1]), `MANDATORY_DOCUMENT_MISSING: ${match[1]}`);
    }
    if (/^tsconfig.*\.json$/.test(path)) {
      const config = JSON.parse(bytes); if (config.extends) resolveImport(path, config.extends, selected);
      for (const input of config.include ?? []) if (!input.includes('*')) fail(selected.has(input), `COMPILER_INPUT_MISSING: ${input}`);
    }
    if (path.endsWith('.html')) for (const match of bytes.toString().matchAll(/<(?:script|link|img|source|video|audio|iframe)\b[^>]*\b(?:src|href)=["']([^"']+)["']/g)) {
      const ref = match[1]; fail(!/^(?:[a-z]+:|\/)/i.test(ref), `EXTERNAL_ASSET_REFUSED: ${path}`);
      resolveImport(path, `./${ref}`, selected);
    }
    if (path.endsWith('.css')) for (const match of bytes.toString().matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) resolveImport(path, `./${match[1]}`, selected);
  }
  const browserSources = new Set();
  const visit = path => { if (browserSources.has(path)) return; browserSources.add(path); for (const dependency of graph.get(path) ?? []) visit(dependency); };
  visit('src/browser.ts');
  return { browserOutputs: [...browserSources].filter(path => /^src\/.*\.ts$/.test(path)).map(path => `dist/browser/${path.slice(4, -3)}.js`).sort(), importEdges: [...graph.values()].reduce((n, paths) => n + paths.length, 0) };
}
export function inspectSource({ sourceRoot, allowlistPath, expectedAllowlistSha256, expectedUpstreamCommit,
  expectedUpstreamTree, expectedToolingSha256, toolingRoot, requireClean = true } = {}) {
  fail(HEX40.test(expectedUpstreamCommit ?? ''), 'EXTERNAL_UPSTREAM_COMMIT_REQUIRED');
  fail(HEX40.test(expectedUpstreamTree ?? ''), 'EXTERNAL_UPSTREAM_TREE_REQUIRED');
  fail(typeof requireClean === 'boolean', 'REQUIRE_CLEAN_FLAG_REFUSED');
  sourceRoot = safeDirectory(sourceRoot);
  const { policy, policySha256 } = loadPolicy(allowlistPath, expectedAllowlistSha256);
  const tooling = toolingIdentity(toolingRoot, expectedToolingSha256);
  fail(git(sourceRoot, ['rev-parse', '--show-toplevel']).toString().trim() === sourceRoot, 'UPSTREAM_ROOT_MISMATCH');
  fail(git(sourceRoot, ['rev-parse', 'HEAD']).toString().trim() === expectedUpstreamCommit, 'UPSTREAM_HEAD_MISMATCH');
  const upstreamCommitBytes = git(sourceRoot, ['cat-file', 'commit', expectedUpstreamCommit]);
  fail(gitHash('commit', upstreamCommitBytes) === expectedUpstreamCommit, 'UPSTREAM_COMMIT_OBJECT_MISMATCH');
  const commitTree = upstreamCommitBytes.toString('utf8').match(/^tree ([a-f0-9]{40})\n/)?.[1];
  fail(HEX40.test(commitTree ?? '') && git(sourceRoot, ['rev-parse', `${expectedUpstreamCommit}^{tree}`]).toString().trim() === commitTree,
    'UPSTREAM_COMMIT_TREE_MISMATCH');
  for (const tree of new Set([commitTree, expectedUpstreamTree])) {
    fail(git(sourceRoot, ['cat-file', '-t', tree]).toString().trim() === 'tree', 'UPSTREAM_SNAPSHOT_NOT_TREE');
    fail(gitHash('tree', git(sourceRoot, ['cat-file', 'tree', tree])) === tree, 'UPSTREAM_TREE_OBJECT_MISMATCH');
  }
  const upstreamEntries = treeListing(git(sourceRoot, ['ls-tree', '-rz', expectedUpstreamTree]));
  assert.deepEqual(treeListing(git(sourceRoot, ['ls-files', '--stage', '-z']), true), upstreamEntries, 'PRODUCT_UPSTREAM_INDEX_SNAPSHOT_MISMATCH');
  // Read all tracked bytes directly, not git diff: index flags must not conceal changes.
  // Never include excluded/private path names or contents in provenance or reports.
  let trackedWorktreeMatchesSnapshot = true;
  for (const entry of upstreamEntries) {
    try {
      const file = regularFile(sourceRoot, entry.path, { tracked: true });
      if (file.mode !== entry.mode || gitHash('blob', file.bytes) !== entry.object) trackedWorktreeMatchesSnapshot = false;
    } catch { trackedWorktreeMatchesSnapshot = false; }
  }
  const hasUntrackedFiles = git(sourceRoot, ['ls-files', '--others', '--exclude-standard', '-z']).length > 0;
  const stagedChanges = expectedUpstreamTree !== commitTree;
  const upstreamIdentity = { commit: expectedUpstreamCommit, commitTree, snapshotTree: expectedUpstreamTree,
    snapshotRelation: stagedChanges ? 'staged-snapshot-without-new-upstream-commit' : 'upstream-commit-tree',
    stagedChanges, trackedWorktreeMatchesSnapshot, hasUntrackedFiles,
    dirty: stagedChanges || !trackedWorktreeMatchesSnapshot || hasUntrackedFiles };
  const upstream = new Map(upstreamEntries.map(entry => [entry.path, entry]));
  const selected = new Set(policy.entries.map(entry => entry.path));
  for (const entry of upstreamEntries) if (FAMILIES.some(prefix => entry.path.startsWith(prefix)) && !NONPRODUCT_SOURCE_FAMILY_EXCLUSIONS.includes(entry.path))
    fail(selected.has(entry.path), `REQUIRED_SOURCE_FAMILY_INPUT_MISSING: ${entry.path}`);
  for (const prefix of FAMILIES) {
    const directory = prefix.slice(0, -1);
    const expected = [...selected].filter(path => path.startsWith(prefix)).sort();
    if (!expected.length) continue;
    assert.deepEqual(walkFiles(join(sourceRoot, directory)).map(path => `${prefix}${path}`).filter(path => !NONPRODUCT_SOURCE_FAMILY_EXCLUSIONS.includes(path)).sort(), expected, `PRODUCT_EXTRA_OR_MISSING_INPUT: ${directory}`);
  }
  const blobs = new Map();
  for (const entry of policy.entries) {
    const actual = upstream.get(entry.path);
    fail(actual && actual.mode === entry.mode && actual.object === entry.git_blob_sha1, `UPSTREAM_ENTRY_MISMATCH: ${entry.path}`);
    const bytes = git(sourceRoot, ['cat-file', 'blob', actual.object]);
    fail(!isArchiveBytes(bytes), `NESTED_ARCHIVE_SOURCE_REFUSED: ${entry.path}`);
    fail(gitHash('blob', bytes) === entry.git_blob_sha1 && sha256(bytes) === entry.sha256, `UPSTREAM_BLOB_MISMATCH: ${entry.path}`);
    const local = regularFile(sourceRoot, entry.path);
    fail(local.mode === entry.mode && local.bytes.equals(bytes), `SOURCE_WORKTREE_MISMATCH: ${entry.path}`);
    blobs.set(entry.path, bytes);
  }
  const closure = verifyClosure(policy, blobs);
  fail(!requireClean || !upstreamIdentity.dirty, 'CLEAN_UPSTREAM_REQUIRED');
  const origin = { schema: '8415wallet-product-origin/2', product: '8415wallet',
    identity: 'local curated product export; not an upstream commit, author signature, GitHub CI result, deployment or independent audit',
    upstream: upstreamIdentity,
    selection: { schema: POLICY_SCHEMA, version: policy.version, sha256: policySha256, entryCount: policy.entries.length },
    tooling,
    generated: [{ path: ORIGIN_FILE, mode: '100644', generator: 'scripts/package/build-public-product.mjs',
      hashPolicy: 'This record has no self hash or product tree. Its bytes are bound by the independent product Git tree and external archive pin.' }],
    entries: policy.entries,
  };
  const originBytes = jsonBytes(origin);
  const productEntries = [...policy.entries.map(entry => ({ path: entry.path, mode: entry.mode, object: entry.git_blob_sha1 })),
    { path: ORIGIN_FILE, mode: '100644', object: gitHash('blob', originBytes) }].sort((a, b) => a.path < b.path ? -1 : 1);
  const productTree = contentTree(productEntries), commitBytes = localCommitBytes(productTree), productCommit = gitHash('commit', commitBytes);
  return { sourceRoot, policy, policySha256, tooling, upstreamIdentity, blobs, closure, origin, originBytes, productEntries, productTree, productCommit, commitBytes };
}
export function planSummary(plan) {
  return { mode: 'inspect', writes: false, review: plan.policy.review, upstream: plan.upstreamIdentity,
    allowlistSha256: plan.policySha256, toolingSha256: plan.tooling.sha256,
    sourceEntryCount: plan.policy.entries.length, generated: [ORIGIN_FILE],
    predictedProductTree: plan.productTree, predictedLocalProductCommit: plan.productCommit,
    closure: plan.closure, evidence: 'Read-only local source/policy verification. No product materialized, archive built, publication, CI or deployment acceptance.' };
}
export function verifyProductEntries(plan, entries, expectedProductTree) {
  fail(HEX40.test(expectedProductTree ?? '') && expectedProductTree === plan.productTree, 'EXTERNAL_PRODUCT_TREE_MISMATCH');
  assert.deepEqual([...entries.keys()].sort(), plan.productEntries.map(entry => entry.path).sort(), 'PRODUCT_EXACT_SOURCE_INVENTORY');
  const actual = [];
  for (const entry of plan.productEntries) {
    const file = entries.get(entry.path), mode = typeof file.mode === 'number' ? (file.mode === 0o755 ? '100755' : file.mode === 0o644 ? '100644' : '') : file.mode;
    fail(mode === entry.mode && gitHash('blob', file.bytes) === entry.object, `SOURCE_ENTRY_MISMATCH: ${entry.path}`);
    const expected = entry.path === ORIGIN_FILE ? plan.originBytes : plan.blobs.get(entry.path);
    fail(file.bytes.equals(expected), `SOURCE_BYTES_MISMATCH: ${entry.path}`);
    actual.push({ ...entry, mode, object: gitHash('blob', file.bytes) });
  }
  fail(contentTree(actual) === expectedProductTree, 'SOURCE_TREE_MISMATCH');
  return { productTree: expectedProductTree, productCommit: plan.productCommit, entries: actual.length };
}
export function verifyProductDirectory(plan, productRoot, expectedProductTree, { buildOutputs = false } = {}) {
  productRoot = safeDirectory(productRoot);
  const entries = new Map(walkFiles(productRoot, ['.git', ...(buildOutputs ? ['node_modules', 'dist'] : [])]).map(path => [path, regularFile(productRoot, path)]));
  const result = verifyProductEntries(plan, entries, expectedProductTree);
  fail(git(productRoot, ['rev-parse', '--show-toplevel']).toString().trim() === productRoot, 'PRODUCT_REPOSITORY_ROOT_MISMATCH');
  fail(git(productRoot, ['rev-parse', 'HEAD']).toString().trim() === plan.productCommit, 'LOCAL_COMMIT_MISMATCH');
  fail(git(productRoot, ['cat-file', 'commit', plan.productCommit]).equals(plan.commitBytes), 'LOCAL_COMMIT_OBJECT_MISMATCH');
  assert.deepEqual(treeListing(git(productRoot, ['ls-files', '--stage', '-z']), true), plan.productEntries, 'PRODUCT_INDEX_MISMATCH');
  fail(git(productRoot, ['rev-list', '--count', 'HEAD']).toString().trim() === '1', 'UPSTREAM_HISTORY_REFUSED');
  fail(git(productRoot, ['remote']).toString().trim() === '', 'PRODUCT_REMOTE_REFUSED');
  return result;
}
/** Additional source-bound UI inventory; original strict validators stay intact. */
export function verifyDappBoundary(plan, entries, profile) {
  fail(['v2', 'v3'].includes(profile), 'DAPP_PROFILE_REFUSED');
  const sourceWeb = plan.policy.entries.map(entry => entry.path).filter(path => path.startsWith('web/'));
  const expected = [...sourceWeb, ...plan.closure.browserOutputs, 'dist/browser/vendor/ethers.js', 'dist/browser/vendor/ETHERS-LICENSE.md',
    ...DAPP_DOCUMENTS, ...LEGAL_FILES, ...LEGAL_FILES.map(path => `web/legal/${path}`), 'RELEASE.json', 'SHA256SUMS'];
  assert.deepEqual([...entries.keys()].sort(), [...new Set(expected)].sort(), 'PRODUCT_DAPP_EXACT_INVENTORY');
  for (const path of [...sourceWeb, ...DAPP_DOCUMENTS, ...LEGAL_FILES]) {
    const expectedBytes = path === 'web/release-config.json' ? jsonBytes(JSON.parse(plan.blobs.get(`config/releases/${profile}.json`))) : plan.blobs.get(path);
    fail(entries.get(path).bytes.equals(expectedBytes), `DAPP_SOURCE_COPY_MISMATCH: ${path}`);
  }
  for (const path of LEGAL_FILES) fail(entries.get(`web/legal/${path}`).bytes.equals(plan.blobs.get(path)), `DAPP_LEGAL_COPY_MISMATCH: ${path}`);
}
export async function verifyProductArchive(options) {
  const plan = inspectSource(options);
  fail(HEX64.test(options.expectedArchiveSha256 ?? ''), 'EXTERNAL_ARCHIVE_PIN_REQUIRED');
  fail(options.expectedProductTree === plan.productTree, 'EXTERNAL_PRODUCT_TREE_MISMATCH');
  // Import only the trusted, pinned upstream verifier. Never execute archive code.
  const strict = await import(pathToFileURL(join(plan.sourceRoot, 'scripts/package/verify-delivery.mjs')).href);
  const result = strict.verifyDeliveryArchive(options.archive, { expectedSha256: options.expectedArchiveSha256, expectedTree: options.expectedProductTree });
  const source = strict.readDeliveryArchive(result.entries.get(`artifacts/${result.release.artifacts.source.artifact}`).bytes);
  verifyProductEntries(plan, source, options.expectedProductTree);
  fail(result.release.source.commit === plan.productCommit && result.release.source.dirty === false, 'ARTIFACT_LOCAL_IDENTITY_MISMATCH');
  const authSource = result.auth.source;
  fail(authSource.commitObject === plan.commitBytes.toString('base64') && authSource.commitTree === plan.productTree && authSource.indexTree === plan.productTree, 'ARTIFACT_COMMIT_OBJECT_MISMATCH');
  for (const id of ['v2', 'v3']) {
    const nested = strict.readDeliveryArchive(result.entries.get(`artifacts/${result.release.artifacts[id].artifact}`).bytes);
    verifyDappBoundary(plan, nested, id);
  }
  return { productTree: plan.productTree, localProductCommit: plan.productCommit, archiveSha256: result.sha256,
    sourceEntries: source.size, verified: 'Existing strict delivery/auth checks plus exact origin/source and source-bound DApp inventory',
    evidence: 'Local integrity verification; external pins authenticate only when received through a separately trusted channel. No remote CI, upstream authorship, deployment, device or audit acceptance.' };
}
export function parseArguments(argv, allowed) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]; fail(allowed.includes(key) && !Object.hasOwn(options, key) && argv[i + 1] && !argv[i + 1].startsWith('--'), 'ARGUMENT_REFUSED');
    options[key] = argv[i + 1];
  }
  return options;
}
export function commonOptions(args) {
  for (const key of ['--source', '--allowlist', '--allowlist-sha256', '--upstream-commit', '--upstream-tree', '--tooling-sha256']) fail(args[key], `ARGUMENT_REQUIRED: ${key}`);
  fail(!args['--require-clean'] || ['true', 'false'].includes(args['--require-clean']), 'REQUIRE_CLEAN_FLAG_REFUSED');
  return { sourceRoot: args['--source'], allowlistPath: args['--allowlist'], expectedAllowlistSha256: args['--allowlist-sha256'],
    expectedUpstreamCommit: args['--upstream-commit'], expectedUpstreamTree: args['--upstream-tree'],
    expectedToolingSha256: args['--tooling-sha256'], requireClean: args['--require-clean'] !== 'false' };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArguments(process.argv.slice(2), ['--source', '--allowlist', '--allowlist-sha256', '--upstream-commit', '--upstream-tree', '--tooling-sha256', '--require-clean', '--archive', '--archive-sha256', '--product-tree']);
    const result = await verifyProductArchive({ ...commonOptions(args), archive: args['--archive'], expectedArchiveSha256: args['--archive-sha256'], expectedProductTree: args['--product-tree'] });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
