/** Synthetic fixtures only. Never materialize or invoke the real Wallet packers. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import {
  DAPP_DOCUMENTS, LEGAL_FILES, MANDATORY_PATHS, NONPRODUCT_GENERATED_CACHE, NONPRODUCT_SOURCE_FAMILY_EXCLUSIONS, ORIGIN_FILE, POLICY_SCHEMA, TOOLING_FILES,
  cleanEnvironment, computeToolingPin, contentTree, git, gitHash, inspectSource,
  jsonBytes, loadPolicy, planSummary, sha256, verifyDappBoundary, verifyProductDirectory,
  verifyProductEntries,
} from '../scripts/package/verify-product-origin.mjs';
import { buildProduct, emitGithubOutputs, materializeProduct, preparePublicFiles, verifyPublicFiles } from '../scripts/package/build-public-product.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const currentPolicy = JSON.parse(readFileSync(join(root, 'config/product-source-allowlist.json')));
const fixtureBytes = path => {
  if (path === 'scripts/package/verify-auth.mjs') return Buffer.from(`export const LEGAL_FILES = Object.freeze(${JSON.stringify(LEGAL_FILES)});\n`);
  if (path === 'scripts/package/verify-delivery.mjs') return Buffer.from(`export const DELIVERY_FILES = ['deploy/dapp/install.mjs', ...LEGAL_FILES];\n`);
  if (path === 'scripts/package/v3-document-contract.mjs') return Buffer.from(`export const V2_DOCUMENTS = Object.freeze(['docs/INTEGRATION.md', ...LEGAL_FILES]);\nexport const V3_DOCUMENTS = Object.freeze(['docs/V3-REVIEW-AND-VALIDATION.md', ...LEGAL_FILES]);\n`);
  if (path === 'package.json') return jsonBytes({ name: '8415wallet', type: 'module', dependencies: {} });
  if (path === 'package-lock.json') return jsonBytes({ name: '8415wallet', lockfileVersion: 3, packages: { '': { dependencies: {} } } });
  if (path.startsWith('tsconfig')) return jsonBytes(path === 'tsconfig.json' ? {} : { extends: './tsconfig.json', include: ['src/browser.ts'] });
  if (path === 'src/browser.ts') return Buffer.from("export { sample } from './index.ts';\n");
  if (path === 'src/index.ts') return Buffer.from('export const sample = 1;\n');
  if (path.endsWith('.json')) return jsonBytes({ synthetic: true });
  if (/\.(?:mjs|ts|sol)$/.test(path)) return Buffer.from('// Synthetic input, no application behavior.\n');
  if (path === 'web/index.html') return Buffer.from('<!doctype html><p>Synthetic product fixture</p>\n');
  if (path.endsWith('.css')) return Buffer.from('p { color: black; }\n');
  return Buffer.from(`Synthetic public test input: ${path}\n`);
};
function fixture(t, { approved = true, extras = {}, extraEntries = {} } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'product-source-synthetic-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, 'upstream'); mkdirSync(source);
  const data = new Map(currentPolicy.entries.map(entry => [entry.path, fixtureBytes(entry.path)]));
  for (const [path, bytes] of Object.entries(extraEntries)) data.set(path, Buffer.from(bytes));
  const all = new Map([...data, ...Object.entries(extras).map(([path, bytes]) => [path, Buffer.from(bytes)])]);
  for (const [path, bytes] of all) { mkdirSync(dirname(join(source, path)), { recursive: true }); writeFileSync(join(source, path), bytes); }
  git(source, ['init', '-q', '--object-format=sha1', '--initial-branch=fixture', '--template=']);
  git(source, ['add', '--all']);
  const tree = git(source, ['write-tree']).toString().trim();
  const commitBytes = Buffer.from(`tree ${tree}\nauthor Synthetic Fixture <fixture@invalid.example> 1 +0000\ncommitter Synthetic Fixture <fixture@invalid.example> 1 +0000\n\nSynthetic upstream fixture.\n`);
  const commit = git(source, ['hash-object', '-t', 'commit', '-w', '--stdin'], { input: commitBytes }).toString().trim();
  git(source, ['update-ref', 'refs/heads/fixture', commit]);
  const policy = structuredClone(currentPolicy);
  policy.review = { status: approved ? 'approved-for-local-build' : 'pending', blockers: [], holds: approved ? [] : ['Synthetic pending review'] };
  policy.entries = [...data].sort(([a], [b]) => a < b ? -1 : 1).map(([path, bytes]) => ({ path, mode: '100644', git_blob_sha1: gitHash('blob', bytes), sha256: sha256(bytes) }));
  for (const path of Object.keys(extraEntries)) policy.mandatory.application.push(path);
  const policyPath = join(directory, 'policy.json'); writeFileSync(policyPath, jsonBytes(policy));
  const options = { sourceRoot: source, allowlistPath: policyPath, expectedAllowlistSha256: sha256(readFileSync(policyPath)),
    expectedUpstreamCommit: commit, expectedUpstreamTree: tree, expectedToolingSha256: computeToolingPin(root), toolingRoot: root };
  return { directory, source, data, policy, policyPath, options };
}
function writePolicy(f) { writeFileSync(f.policyPath, jsonBytes(f.policy)); f.options.expectedAllowlistSha256 = sha256(readFileSync(f.policyPath)); }
function materialize(f, name = 'output') {
  const plan = inspectSource(f.options);
  return materializeProduct({ ...f.options, outputRoot: join(f.directory, name), expectedProductTree: plan.productTree });
}
function entryMap(plan) { return new Map(plan.productEntries.map(entry => [entry.path, { bytes: entry.path === ORIGIN_FILE ? Buffer.from(plan.originBytes) : Buffer.from(plan.blobs.get(entry.path)), mode: entry.mode }])); }
function dappMap(plan, profile = 'v2') {
  const map = new Map();
  for (const [path, bytes] of plan.blobs) if (path.startsWith('web/') || DAPP_DOCUMENTS.includes(path) || LEGAL_FILES.includes(path)) map.set(path, { bytes, mode: 0o644 });
  map.set('web/release-config.json', { bytes: jsonBytes(JSON.parse(plan.blobs.get(`config/releases/${profile}.json`))), mode: 0o644 });
  for (const path of LEGAL_FILES) map.set(`web/legal/${path}`, { bytes: plan.blobs.get(path), mode: 0o644 });
  for (const path of [...plan.closure.browserOutputs, 'dist/browser/vendor/ethers.js', 'dist/browser/vendor/ETHERS-LICENSE.md', 'RELEASE.json', 'SHA256SUMS']) map.set(path, { bytes: Buffer.from('synthetic'), mode: 0o644 });
  return map;
}

test('checked-in reviewed Wallet boundary has all exact entries mandatory', () => {
  assert.equal(currentPolicy.review.status, 'approved-for-local-build');
  assert.equal(currentPolicy.entries.length, 278);
  const loaded = loadPolicy(join(root, 'config/product-source-allowlist.json'), sha256(readFileSync(join(root, 'config/product-source-allowlist.json'))));
  assert.deepEqual(loaded.policy.entries, currentPolicy.entries);
  assert.equal(currentPolicy.schema, POLICY_SCHEMA); assert.equal(currentPolicy.version, 2);
  assert.equal(Object.hasOwn(currentPolicy, 'upstream'), false);
});

test('reviewed policy legal notice and companion guide preserve distribution boundaries', () => {
  const notice = currentPolicy.entries.find(entry => entry.path === 'THIRD_PARTY_NOTICES.md');
  assert.equal(notice.git_blob_sha1, '5e1aa6fb3fb450da4c957a9398ebb9f962cd9625');
  assert.equal(notice.sha256, '8e1b73b0d38271d6d65caf6a3be29fef7b206776e0df1bb924599d194d5461d2');
  const guide = readFileSync(join(root, 'docs/PUBLIC-PRODUCT-KIT.md'), 'utf8');
  assert.ok(guide.includes('--upstream-commit REVIEWED_UPSTREAM_COMMIT'));
  assert.ok(guide.includes('self-referential'));
  assert.ok(guide.includes('distribution-specific component inclusion'));
  assert.ok(guide.includes('No source-availability promise is made for components absent from this curated kit.'));
  assert.ok(guide.includes('export-tooling workspace'));
  for (const operation of ['prepare', 'check', 'enable-proxy'])
    assert.ok(guide.includes(`node "$PACKAGE_DIRECTORY/deploy/auth-xiongan/install.mjs" ${operation}`));
  if (process.env.PRODUCT_POLICY_ASSERTION_SOURCE) {
    const bytes = readFileSync(join(process.env.PRODUCT_POLICY_ASSERTION_SOURCE, notice.path));
    assert.equal(gitHash('blob', bytes), notice.git_blob_sha1); assert.equal(sha256(bytes), notice.sha256);
    assert.ok(bytes.toString().includes('Component inclusion varies by distribution; any included separately licensed\nmaterial remains subject to its applicable notices and terms.'));
  }
});

test('inspection writes nothing and reports predicted source identity', t => {
  const f = fixture(t); const indexBefore = readFileSync(join(f.source, '.git/index'));
  const plan = inspectSource(f.options), summary = planSummary(plan);
  assert.equal(summary.writes, false); assert.equal(summary.sourceEntryCount, 278);
  assert.equal(summary.closure.browserOutputs.length, 2);
  assert.deepEqual(readFileSync(join(f.source, '.git/index')), indexBefore);
  assert.equal(existsSync(join(f.directory, 'output')), false);
  assert.equal(plan.origin.generated.length, 1);
  assert.equal(JSON.stringify(plan.origin).includes(plan.productTree), false);
  assert.equal(JSON.stringify(plan.origin).includes(plan.productCommit), false);
  assert.equal(plan.origin.entries.some(entry => entry.path === ORIGIN_FILE), false);
});

test('deterministic fresh exports have one truthful root commit and identical origin bytes', t => {
  const f = fixture(t), a = materialize(f, 'a'), b = materialize(f, 'b');
  assert.equal(a.plan.productTree, b.plan.productTree); assert.equal(a.plan.productCommit, b.plan.productCommit);
  assert.deepEqual(readFileSync(join(a.productRoot, ORIGIN_FILE)), readFileSync(join(b.productRoot, ORIGIN_FILE)));
  assert.equal(git(a.productRoot, ['rev-list', '--count', 'HEAD']).toString().trim(), '1');
  assert.equal(git(a.productRoot, ['remote']).toString().trim(), '');
  assert.equal(git(a.productRoot, ['cat-file', 'commit', 'HEAD']).toString().includes('\nparent '), false);
  assert.equal(a.report.status, 'SOURCE_ONLY_PACKERS_NOT_RUN');
  assert.equal(a.report.archives.length, 0);
  assert.equal(existsSync(join(a.productRoot, 'node_modules')), false);
  assert.equal(existsSync(join(a.productRoot, 'dist')), false);
});

test('excluded tracked private configuration and historical archive are never selected', t => {
  const f = fixture(t, { extras: { 'docs/deployment/PRIVATE.md': 'SYNTHETIC_PRIVATE_ONLY', 'releases/old.zip': 'SYNTHETIC_HISTORY_ONLY', 'config/auth.xiongan.preparation.json': '{}' } });
  const result = materialize(f);
  for (const path of ['docs/deployment/PRIVATE.md', 'releases/old.zip', 'config/auth.xiongan.preparation.json']) assert.equal(existsSync(join(result.productRoot, path)), false);
  assert.equal(JSON.stringify(result.plan.origin).includes('SYNTHETIC_PRIVATE_ONLY'), false);
});

test('exact excluded generated Python caches stay outside the product', t => {
  const f = fixture(t, { extras: Object.fromEntries(NONPRODUCT_GENERATED_CACHE.map(path => [path, 'synthetic cache'])) });
  const result = materialize(f);
  for (const path of NONPRODUCT_GENERATED_CACHE) assert.equal(existsSync(join(result.productRoot, path)), false);
  const other = join(f.source, 'src/kit/sdk/python/erc8415/__pycache__/unreviewed.pyc'); writeFileSync(other, 'extra');
  assert.throws(() => inspectSource(f.options), /EXTRA_OR_MISSING_INPUT/);
});

test('nested archive magic disguised as an approved source extension refuses', t => {
  const f = fixture(t, { extraEntries: { 'src/disguised.ts': Buffer.from('504b030400000000', 'hex') } });
  assert.throws(() => inspectSource(f.options), /NESTED_ARCHIVE_SOURCE_REFUSED/);
});

test('untracked unrelated private config is not selected', t => {
  const f = fixture(t); writeFileSync(join(f.source, 'config/private-local.json'), 'SYNTHETIC_ONLY');
  assert.throws(() => inspectSource(f.options), /CLEAN_UPSTREAM_REQUIRED/);
  f.options.requireClean = false;
  const result = materialize(f); assert.equal(existsSync(join(result.productRoot, 'config/private-local.json')), false);
  assert.equal(result.plan.origin.upstream.hasUntrackedFiles, true); assert.equal(result.plan.origin.upstream.dirty, true);
});

test('pending and blocked reviews refuse before creating output', t => {
  const f = fixture(t, { approved: false }); const output = join(f.directory, 'output');
  assert.throws(() => materialize(f), /ALLOWLIST_NOT_APPROVED/); assert.equal(existsSync(output), false);
  f.policy.review.status = 'blocked'; writePolicy(f);
  assert.throws(() => materialize(f), /ALLOWLIST_NOT_APPROVED/); assert.equal(existsSync(output), false);
});

test('policy and tooling pins are required and substitution is refused', t => {
  const f = fixture(t);
  for (const field of ['expectedAllowlistSha256', 'expectedToolingSha256', 'expectedUpstreamCommit', 'expectedUpstreamTree']) {
    const options = { ...f.options }; delete options[field]; assert.throws(() => inspectSource(options), /EXTERNAL_/);
  }
  writeFileSync(f.policyPath, Buffer.concat([readFileSync(f.policyPath), Buffer.from(' ')]));
  assert.throws(() => inspectSource(f.options), /ALLOWLIST_DIGEST_MISMATCH/);
  f.options.expectedAllowlistSha256 = sha256(readFileSync(f.policyPath));
  assert.throws(() => inspectSource({ ...f.options, expectedToolingSha256: '0'.repeat(64) }), /TOOLING_DIGEST_MISMATCH/);
});

test('even a freshly rehashed policy cannot omit mandatory input contracts', t => {
  for (const missing of ['package-lock.json', 'docs/DAPP-INSTALL.md', 'deploy/auth-xiongan/install.mjs', 'LICENSE']) {
    const f = fixture(t); f.policy.entries = f.policy.entries.filter(entry => entry.path !== missing);
    for (const key of Object.keys(f.policy.mandatory)) f.policy.mandatory[key] = f.policy.mandatory[key].filter(path => path !== missing);
    writePolicy(f); assert.throws(() => inspectSource(f.options), /MANDATORY_INPUT_MISSING/);
  }
});

test('duplicate, traversal, hidden, forbidden archive/config and generated source entries refuse', t => {
  for (const path of ['../outside', '.env', 'src/.secrets.json', 'src/history.tar.gz', 'docs/deployment/private.md', 'config/live.json', ORIGIN_FILE]) {
    const f = fixture(t); const entry = { ...f.policy.entries[0], path };
    f.policy.entries.push(entry); f.policy.entries.sort((a, b) => a.path < b.path ? -1 : 1); f.policy.mandatory.application.push(path); writePolicy(f);
    assert.throws(() => inspectSource(f.options), /PATH_ALLOWLIST_REFUSED/);
  }
  const f = fixture(t); f.policy.entries.splice(1, 0, f.policy.entries[0]); writePolicy(f);
  assert.throws(() => inspectSource(f.options), /PATH_ALLOWLIST_REFUSED/);
});

test('selected working-tree bytes, mode and symlink substitutions refuse', t => {
  for (const mutate of [
    f => writeFileSync(join(f.source, 'src/index.ts'), 'export const sample = 2;\n'),
    f => chmodSync(join(f.source, 'src/index.ts'), 0o755),
    f => { rmSync(join(f.source, 'src/index.ts')); symlinkSync('browser.ts', join(f.source, 'src/index.ts')); },
  ]) { const f = fixture(t); mutate(f); assert.throws(() => inspectSource(f.options), /MISMATCH|REFUSED/); }
});

test('missing file and unknown public-family input refuse', t => {
  const a = fixture(t); rmSync(join(a.source, 'src/index.ts')); assert.throws(() => inspectSource(a.options), /EXTRA_OR_MISSING_INPUT/);
  const b = fixture(t); writeFileSync(join(b.source, 'src/unreviewed.ts'), '// extra\n'); assert.throws(() => inspectSource(b.options), /EXTRA_OR_MISSING_INPUT/);
});

test('source HEAD, staged snapshot, Git blob and mode identities cannot be substituted', t => {
  const a = fixture(t); a.options.expectedUpstreamCommit = '0'.repeat(40); assert.throws(() => inspectSource(a.options), /HEAD_MISMATCH/);
  const b = fixture(t); writeFileSync(join(b.source, 'README.md'), 'new staged source'); git(b.source, ['add', 'README.md']); assert.throws(() => inspectSource(b.options), /INDEX_SNAPSHOT_MISMATCH/);
  const c = fixture(t); c.policy.entries.find(entry => entry.path === 'src/index.ts').git_blob_sha1 = '0'.repeat(40); writePolicy(c); assert.throws(() => inspectSource(c.options), /UPSTREAM_ENTRY_MISMATCH/);
  const d = fixture(t); d.policy.entries.find(entry => entry.path === 'src/index.ts').mode = '100755'; writePolicy(d); assert.throws(() => inspectSource(d.options), /UPSTREAM_ENTRY_MISMATCH/);
  const e = fixture(t); assert.throws(() => inspectSource({ ...e.options, expectedUpstreamTree: '0'.repeat(40) }), /Command failed|UPSTREAM_/);
});

test('missing relative import and fixed document closure refuse in newly pinned synthetic source', t => {
  const a = fixture(t, { extraEntries: { 'src/broken.ts': "import './absent.ts';\n" } }); assert.throws(() => inspectSource(a.options), /IMPORT_MISSING/);
  const b = fixture(t, { extraEntries: { 'scripts/package/check-docs.mjs': "const doc = 'docs/ABSENT.md';\n" } }); assert.throws(() => inspectSource(b.options), /MANDATORY_DOCUMENT_MISSING/);
  const c = fixture(t, { extraEntries: { 'src/dynamic.ts': 'export async function load(path) { return import(path); }\n' } }); assert.throws(() => inspectSource(c.options), /NONLITERAL_IMPORT_REFUSED/);
});

test('omitting an existing source-family member fails despite changing policy digest', t => {
  const f = fixture(t); const omitted = 'src/sdk/types.ts';
  f.policy.entries = f.policy.entries.filter(entry => entry.path !== omitted);
  f.policy.mandatory.application = f.policy.mandatory.application.filter(path => path !== omitted); writePolicy(f);
  assert.throws(() => inspectSource(f.options), /REQUIRED_SOURCE_FAMILY_INPUT_MISSING/);
});

test('stale output, symlink output and source-contained output refuse without mutation', t => {
  const f = fixture(t), plan = inspectSource(f.options);
  const output = join(f.directory, 'stale'); mkdirSync(output); writeFileSync(join(output, 'keep'), 'unchanged');
  assert.throws(() => materializeProduct({ ...f.options, expectedProductTree: plan.productTree, outputRoot: output }), /STALE_OUTPUT_REFUSED/);
  assert.equal(readFileSync(join(output, 'keep'), 'utf8'), 'unchanged');
  const linked = join(f.directory, 'linked'); symlinkSync(output, linked);
  assert.throws(() => materializeProduct({ ...f.options, expectedProductTree: plan.productTree, outputRoot: linked }), /STALE_OUTPUT_REFUSED/);
  assert.throws(() => materializeProduct({ ...f.options, expectedProductTree: plan.productTree, outputRoot: join(f.source, 'new') }), /OUTPUT_MUST_BE_SEPARATE/);
});

test('product tree approval is required before any export', t => {
  const f = fixture(t);
  assert.throws(() => materializeProduct({ ...f.options, outputRoot: join(f.directory, 'no-pin') }), /REVIEWED_PRODUCT_TREE_REQUIRED/);
  assert.equal(existsSync(join(f.directory, 'no-pin')), false);
});

test('extra generated file and origin identity substitutions refuse', t => {
  const f = fixture(t), result = materialize(f);
  writeFileSync(join(result.productRoot, 'EXTRA-GENERATED.json'), '{}');
  assert.throws(() => verifyProductDirectory(result.plan, result.productRoot, result.plan.productTree), /EXACT_SOURCE_INVENTORY/);
  rmSync(join(result.productRoot, 'EXTRA-GENERATED.json'));
  const forged = JSON.parse(readFileSync(join(result.productRoot, ORIGIN_FILE))); forged.upstream.commit = '0'.repeat(40);
  writeFileSync(join(result.productRoot, ORIGIN_FILE), jsonBytes(forged));
  assert.throws(() => verifyProductDirectory(result.plan, result.productRoot, result.plan.productTree), /SOURCE_ENTRY_MISMATCH/);
});

test('recomputed source checksums and a forged self-consistent tree do not replace independent pins', t => {
  const f = fixture(t), plan = inspectSource(f.options), map = entryMap(plan);
  map.get('src/index.ts').bytes = Buffer.from('export const stolen = 2;\n');
  const forgedOrigin = structuredClone(plan.origin), entry = forgedOrigin.entries.find(item => item.path === 'src/index.ts');
  entry.sha256 = sha256(map.get(entry.path).bytes); entry.git_blob_sha1 = gitHash('blob', map.get(entry.path).bytes);
  map.get(ORIGIN_FILE).bytes = jsonBytes(forgedOrigin);
  const forgedTree = contentTree([...map].map(([path, item]) => ({ path, mode: item.mode, object: gitHash('blob', item.bytes) })));
  assert.notEqual(forgedTree, plan.productTree);
  assert.throws(() => verifyProductEntries(plan, map, plan.productTree), /SOURCE_ENTRY_MISMATCH/);
  assert.throws(() => verifyProductEntries(plan, map, forgedTree), /EXTERNAL_PRODUCT_TREE_MISMATCH/);
});

test('DApp nested inventory rejects extra payload and mismatched legal/document copies', t => {
  const f = fixture(t), plan = inspectSource(f.options), map = dappMap(plan);
  verifyDappBoundary(plan, map, 'v2');
  map.set('docs/unapproved.md', { bytes: Buffer.from('extra'), mode: 0o644 });
  assert.throws(() => verifyDappBoundary(plan, map, 'v2'), /DAPP_EXACT_INVENTORY/); map.delete('docs/unapproved.md');
  map.get('LICENSE').bytes = Buffer.from('forged legal bytes'); assert.throws(() => verifyDappBoundary(plan, map, 'v2'), /DAPP_SOURCE_COPY_MISMATCH/);
});

test('CLI defaults to inspect and refuses implicit output/build arguments', t => {
  const f = fixture(t), script = join(root, 'scripts/package/build-public-product.mjs');
  const args = ['--source', f.source, '--allowlist', f.policyPath, '--allowlist-sha256', f.options.expectedAllowlistSha256,
    '--upstream-commit', f.options.expectedUpstreamCommit, '--upstream-tree', f.options.expectedUpstreamTree, '--tooling-sha256', f.options.expectedToolingSha256];
  const output = execFileSync(process.execPath, [script, ...args], { env: cleanEnvironment(), encoding: 'utf8' }); assert.equal(JSON.parse(output).writes, false);
  assert.throws(() => execFileSync(process.execPath, [script, ...args, '--output', join(f.directory, 'no')], { env: cleanEnvironment(), stdio: 'pipe' }), /INSPECT_ARGUMENT_SCOPE_REFUSED/);
  assert.equal(existsSync(join(f.directory, 'no')), false);
});

// Safe USTAR fixtures for smoke-testing existing parser checks without real builds.
function syntheticTar(entries) {
  const blocks = [];
  for (const [path, bytes] of entries) {
    const header = Buffer.alloc(512); header.write(path, 0, 100);
    const oct = (n, offset, size) => header.write(`${n.toString(8).padStart(size - 1, '0')}\0`, offset, size);
    oct(0o644, 100, 8); oct(0, 108, 8); oct(0, 116, 8); oct(bytes.length, 124, 12); oct(0, 136, 12);
    header.fill(32, 148, 156); header[156] = 48; header.write('ustar\0' + '00', 257, 8);
    header.write(`${[...header].reduce((n, v) => n + v, 0).toString(8).padStart(6, '0')}\0 `, 148, 8);
    blocks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
const strictRoot = process.env.PRODUCT_STRICT_SMOKE_SOURCE;
test('optional unchanged strict validator smoke uses synthetic archives only', { skip: !strictRoot }, async () => {
  const { readDeliveryArchive, verifyDeliveryArchive } = await import(pathToFileURL(join(resolve(strictRoot), 'scripts/package/verify-delivery.mjs')).href);
  const { sourceTree, verifyAuthDirectory } = await import(pathToFileURL(join(resolve(strictRoot), 'scripts/package/verify-auth.mjs')).href);
  const entries = [['public.txt', Buffer.from('synthetic public fixture')]], archive = syntheticTar(entries);
  const parsed = readDeliveryArchive(archive); assert.deepEqual(parsed.get('public.txt').bytes, entries[0][1]);
  const source = [{ path: 'public.txt', mode: '100644', object: gitHash('blob', entries[0][1]) }]; assert.equal(sourceTree(source), contentTree(source));
  assert.throws(() => readDeliveryArchive(syntheticTar([...entries, ...entries])), /DUPLICATE_REFUSED/);
  assert.throws(() => readDeliveryArchive(syntheticTar([['../escape', Buffer.from('x')]])), /PATH_REFUSED/);
  assert.throws(() => verifyDeliveryArchive(archive, { expectedSha256: '0'.repeat(64), expectedTree: '0'.repeat(40) }), /ARCHIVE_DIGEST_MISMATCH/);
  assert.throws(() => verifyDeliveryArchive(archive, { expectedSha256: sha256(archive), expectedTree: '0'.repeat(40) }), /FILE_MISSING/);
  assert.equal(typeof verifyAuthDirectory, 'function');
});

function stageSnapshot(f) {
  git(f.source, ['add', '--all']);
  f.options.expectedUpstreamTree = git(f.source, ['write-tree']).toString().trim();
}
function commitSnapshot(f) {
  stageSnapshot(f);
  const bytes = Buffer.from(`tree ${f.options.expectedUpstreamTree}\nauthor Synthetic Fixture <fixture@invalid.example> 2 +0000\ncommitter Synthetic Fixture <fixture@invalid.example> 2 +0000\n\nSynthetic integrated source.\n`);
  const commit = git(f.source, ['hash-object', '-t', 'commit', '-w', '--stdin'], { input: bytes }).toString().trim();
  git(f.source, ['update-ref', 'refs/heads/fixture', commit]); f.options.expectedUpstreamCommit = commit;
}
function githubFile(t, f, name = 'github-output') {
  const path = join(f.directory, name); writeFileSync(path, 'existing_output=preserved\n');
  const before = process.env.GITHUB_OUTPUT;
  t.after(() => { if (before === undefined) delete process.env.GITHUB_OUTPUT; else process.env.GITHUB_OUTPUT = before; });
  process.env.GITHUB_OUTPUT = path; return path;
}
function publicFixture(t) {
  const f = fixture(t, { extras: { 'docs/deployment/PRIVATE.md': 'SYNTHETIC_PRIVATE_CANARY' } });
  const result = materialize(f);
  mkdirSync(join(result.productRoot, 'dist'));
  const archive = syntheticTar([['synthetic-public.txt', Buffer.from('Harmless publication-path fixture; not a Wallet build.')]]);
  const artifact = `8415wallet-dapp-delivery-${result.plan.productTree}.tar.gz`;
  writeFileSync(join(result.productRoot, 'dist', artifact), archive);
  writeFileSync(join(result.productRoot, 'dist', 'old-full-repository.tar.gz'), 'SYNTHETIC_PRIVATE_CANARY');
  writeFileSync(join(result.outputRoot, 'PACKAGING-PRIVATE-DIAGNOSTIC.txt'), 'SYNTHETIC_PRIVATE_CANARY');
  // Unit-test receipt only. No real packer runs or strict-build success is claimed.
  const verification = { productTree: result.plan.productTree, localProductCommit: result.plan.productCommit,
    sourceEntries: result.plan.productEntries.length, archiveSha256: sha256(archive) };
  return { ...f, ...result, verification, artifact };
}

test('v2 policy rejects embedded upstream identity even with a recomputed external policy pin', t => {
  const f = fixture(t); f.policy.upstream = { commit: f.options.expectedUpstreamCommit, tree: f.options.expectedUpstreamTree }; writePolicy(f);
  assert.throws(() => inspectSource(f.options), /POLICY_KEYS/);
});

test('committed in-repository policy and tooling need no self-referential source pin', t => {
  const f = fixture(t), policyBefore = readFileSync(f.policyPath);
  for (const path of TOOLING_FILES) {
    mkdirSync(dirname(join(f.source, path)), { recursive: true });
    writeFileSync(join(f.source, path), readFileSync(join(root, path)));
  }
  const inRepoPolicy = join(f.source, 'config/product-source-allowlist.json'); writeFileSync(inRepoPolicy, policyBefore);
  commitSnapshot(f); f.options.allowlistPath = inRepoPolicy; f.options.toolingRoot = f.source;
  const indexBefore = readFileSync(join(f.source, '.git/index'));
  const plan = inspectSource(f.options);
  assert.deepEqual(readFileSync(inRepoPolicy), policyBefore);
  assert.equal(policyBefore.includes(Buffer.from(f.options.expectedUpstreamCommit)), false);
  assert.equal(policyBefore.includes(Buffer.from(f.options.expectedUpstreamTree)), false);
  assert.equal(plan.origin.upstream.commit, f.options.expectedUpstreamCommit);
  assert.equal(plan.origin.upstream.commitTree, f.options.expectedUpstreamTree);
  assert.equal(plan.origin.upstream.snapshotTree, f.options.expectedUpstreamTree);
  assert.equal(plan.origin.upstream.snapshotRelation, 'upstream-commit-tree');
  assert.equal(plan.origin.upstream.dirty, false);
  assert.deepEqual(readFileSync(join(f.source, '.git/index')), indexBefore);
  assert.deepEqual(NONPRODUCT_SOURCE_FAMILY_EXCLUSIONS.slice(2), TOOLING_FILES.filter(path => path.startsWith('scripts/package/')));
  for (const path of TOOLING_FILES) assert.equal(plan.productEntries.some(entry => entry.path === path), false);
  assert.equal(plan.policy.entries.length, 278);
});

test('staged local snapshot retains genuine HEAD and dirty relation while clean CI refuses', t => {
  const f = fixture(t, { extras: { 'config/private-local.json': 'SYNTHETIC_OLD_PRIVATE' } });
  const originalCommit = f.options.expectedUpstreamCommit, commitTree = f.options.expectedUpstreamTree;
  writeFileSync(join(f.source, 'config/private-local.json'), 'SYNTHETIC_NEW_PRIVATE'); stageSnapshot(f);
  assert.notEqual(f.options.expectedUpstreamTree, commitTree);
  assert.throws(() => inspectSource(f.options), /CLEAN_UPSTREAM_REQUIRED/);
  const plan = inspectSource({ ...f.options, requireClean: false });
  assert.equal(plan.origin.upstream.commit, originalCommit); assert.equal(plan.origin.upstream.commitTree, commitTree);
  assert.equal(plan.origin.upstream.snapshotTree, f.options.expectedUpstreamTree);
  assert.equal(plan.origin.upstream.snapshotRelation, 'staged-snapshot-without-new-upstream-commit');
  assert.equal(plan.origin.upstream.stagedChanges, true); assert.equal(plan.origin.upstream.dirty, true);
  assert.equal(plan.origin.upstream.trackedWorktreeMatchesSnapshot, true);
  assert.equal(JSON.stringify(plan.origin).includes('SYNTHETIC_NEW_PRIVATE'), false);
  assert.equal(JSON.stringify(plan.origin).includes('config/private-local.json'), false);
  assert.notEqual(plan.productCommit, originalCommit);
});

test('clean CI directly checks hidden tracked bytes and cannot be fooled by index flags', t => {
  for (const flag of ['--assume-unchanged', '--skip-worktree']) {
    const f = fixture(t, { extras: { '.github/workflows/ci.yml': 'synthetic original CI' } });
    git(f.source, ['update-index', flag, '.github/workflows/ci.yml']);
    writeFileSync(join(f.source, '.github/workflows/ci.yml'), 'SYNTHETIC_PRIVATE_CHANGED_CI');
    assert.throws(() => inspectSource(f.options), /CLEAN_UPSTREAM_REQUIRED/);
    const plan = inspectSource({ ...f.options, requireClean: false });
    assert.equal(plan.origin.upstream.trackedWorktreeMatchesSnapshot, false);
    assert.equal(plan.origin.upstream.stagedChanges, false); assert.equal(plan.origin.upstream.dirty, true);
    assert.equal(JSON.stringify(plan.origin).includes('SYNTHETIC_PRIVATE_CHANGED_CI'), false);
    assert.equal(JSON.stringify(plan.origin).includes('.github/workflows/ci.yml'), false);
  }
});

test('the exact tooling exclusions cannot be turned into approved product inputs', t => {
  for (const path of NONPRODUCT_SOURCE_FAMILY_EXCLUSIONS) {
    const f = fixture(t); f.policy.entries.push({ path, mode: '100644', git_blob_sha1: '1'.repeat(40), sha256: '2'.repeat(64) });
    f.policy.entries.sort((a, b) => a.path < b.path ? -1 : 1); f.policy.mandatory.packaging.push(path); writePolicy(f);
    assert.throws(() => inspectSource(f.options), /PATH_ALLOWLIST_REFUSED/);
  }
});

test('public publication has exactly four paths, sanitized report and three checksum-covered files', t => {
  const f = publicFixture(t);
  const publication = preparePublicFiles(f);
  assert.deepEqual(Object.keys(publication.paths), ['archive_path', 'guide_path', 'checksums_path', 'report_path']);
  for (const path of Object.values(publication.paths)) {
    assert.equal(dirname(path), join(f.outputRoot, 'publication'));
    assert.equal(lstatSync(path).isFile(), true);
    assert.equal(readFileSync(path).includes(Buffer.from('SYNTHETIC_PRIVATE_CANARY')), false);
  }
  const report = JSON.parse(readFileSync(publication.paths.report_path));
  assert.equal(report.upstream.commit, f.options.expectedUpstreamCommit);
  assert.equal(report.localProduct.commit, f.plan.productCommit); assert.notEqual(report.localProduct.commit, report.upstream.commit);
  assert.equal(report.archive.artifact, f.artifact);
  assert.equal(JSON.stringify(report).includes(f.directory), false);
  assert.equal(JSON.stringify(report).includes('docs/deployment'), false);
  assert.equal(JSON.stringify(report).includes('product/dist'), false);
  const lines = readFileSync(publication.paths.checksums_path, 'utf8').trim().split('\n');
  assert.equal(lines.length, 3);
  for (const line of lines) {
    const [digest, path] = line.split('  '); assert.equal(sha256(readFileSync(join(f.outputRoot, 'publication', path))), digest);
  }
  assert.ok(lines.some(line => line.endsWith('  PRODUCT-BUILD-REPORT.json')));
  assert.equal(lines.some(line => line.endsWith('  SHA256SUMS')), false);
  const output = githubFile(t, f); emitGithubOutputs({ ...f, githubOutput: output });
  const text = readFileSync(output, 'utf8'); assert.ok(text.startsWith('existing_output=preserved\n'));
  for (const [key, path] of Object.entries(publication.paths)) assert.ok(text.includes(`${key}=${path}\n`));
  assert.equal(text.includes('old-full-repository'), false); assert.equal(text.includes('PRIVATE'), false);
});

test('public publication requires verified identity, original archive bytes and reviewed companion', t => {
  const f = publicFixture(t);
  for (const verification of [null, { ...f.verification, productTree: '0'.repeat(40) }, { ...f.verification, sourceEntries: 0 }])
    assert.throws(() => preparePublicFiles({ ...f, verification }), /PUBLICATION_REQUIRES_VERIFIED_BUILD/);
  assert.equal(existsSync(join(f.outputRoot, 'publication')), false);
  assert.throws(() => preparePublicFiles({ ...f, verification: { ...f.verification, archiveSha256: '0'.repeat(64) } }), /PUBLIC_ARCHIVE_DIGEST_MISMATCH/);
  writeFileSync(join(f.outputRoot, 'PUBLIC-PRODUCT-KIT.md'), 'SYNTHETIC_PRIVATE_GUIDE_SUBSTITUTION');
  assert.throws(() => preparePublicFiles(f), /PUBLIC_GUIDE_DIGEST_MISMATCH/);
  assert.equal(existsSync(join(f.outputRoot, 'publication')), false);
});

test('missing, extra and old full-repository publication paths refuse without Github outputs', t => {
  const f = publicFixture(t), publication = preparePublicFiles(f), output = githubFile(t, f);
  const before = readFileSync(output), guide = readFileSync(publication.paths.guide_path);
  rmSync(publication.paths.guide_path);
  assert.throws(() => emitGithubOutputs({ ...f, githubOutput: output }), /PUBLICATION_EXACT_FOUR_FILES_REQUIRED/);
  assert.deepEqual(readFileSync(output), before); writeFileSync(publication.paths.guide_path, guide);
  for (const name of ['docs-private.json', 'delivery-package-manifest.json', '8415wallet-dapp-delivery-' + '0'.repeat(40) + '.tar.gz']) {
    const extra = join(f.outputRoot, 'publication', name); writeFileSync(extra, 'SYNTHETIC_PRIVATE_CANARY');
    assert.throws(() => emitGithubOutputs({ ...f, githubOutput: output }), /PUBLICATION_EXACT_FOUR_FILES_REQUIRED/);
    assert.deepEqual(readFileSync(output), before); rmSync(extra);
  }
});

test('public checksum, report, guide and archive substitutions fail closed', t => {
  const f = publicFixture(t), publication = preparePublicFiles(f), output = githubFile(t, f), before = readFileSync(output);
  for (const key of ['archive_path', 'guide_path', 'checksums_path', 'report_path']) {
    const path = publication.paths[key], original = readFileSync(path); writeFileSync(path, Buffer.concat([original, Buffer.from('SYNTHETIC_TAMPER')]));
    assert.throws(() => emitGithubOutputs({ ...f, githubOutput: output })); assert.deepEqual(readFileSync(output), before);
    writeFileSync(path, original);
  }
  assert.equal(verifyPublicFiles(f).status, 'LOCAL_PRODUCT_PACKAGING_VERIFIED');
  // Reforging every co-located checksum/report cannot replace the verified digest in memory.
  const forgedArchive = Buffer.from('SYNTHETIC_REFORGED_ARCHIVE'); writeFileSync(publication.paths.archive_path, forgedArchive);
  const forgedReport = JSON.parse(readFileSync(publication.paths.report_path)); forgedReport.archive.sha256 = sha256(forgedArchive);
  writeFileSync(publication.paths.report_path, jsonBytes(forgedReport));
  const names = [f.artifact, 'PUBLIC-PRODUCT-KIT.md', 'PRODUCT-BUILD-REPORT.json'].sort();
  writeFileSync(publication.paths.checksums_path, names.map(name => `${sha256(readFileSync(join(f.outputRoot, 'publication', name)))}  ${name}\n`).join(''));
  assert.throws(() => emitGithubOutputs({ ...f, githubOutput: output }), /PUBLIC_VERIFIED_ARCHIVE_PIN_MISMATCH/);
  assert.deepEqual(readFileSync(output), before);
});

test('Github output requires exact existing environment target and refuses links or protected paths', t => {
  const f = publicFixture(t); preparePublicFiles(f);
  const output = githubFile(t, f), before = readFileSync(output);
  assert.throws(() => emitGithubOutputs({ ...f }), /EXPLICIT_GITHUB_OUTPUT_REQUIRED/);
  assert.throws(() => emitGithubOutputs({ ...f, githubOutput: join(f.directory, 'different') }), /GITHUB_OUTPUT_TARGET_MISMATCH/);
  const absent = join(f.directory, 'absent'); process.env.GITHUB_OUTPUT = absent;
  assert.throws(() => emitGithubOutputs({ ...f, githubOutput: absent }), /ENOENT/); assert.equal(existsSync(absent), false);
  const link = join(f.directory, 'linked-output'); symlinkSync(output, link); process.env.GITHUB_OUTPUT = link;
  assert.throws(() => emitGithubOutputs({ ...f, githubOutput: link }), /GITHUB_OUTPUT_FILE_REQUIRED/);
  const protectedPath = join(f.source, 'README.md'); process.env.GITHUB_OUTPUT = protectedPath;
  assert.throws(() => emitGithubOutputs({ ...f, githubOutput: protectedPath }), /GITHUB_OUTPUT_MUST_BE_SEPARATE/);
  assert.deepEqual(readFileSync(output), before);
});

test('source-only or failed builds produce no publication paths or Github outputs', async t => {
  const f = fixture(t), output = githubFile(t, f), before = readFileSync(output);
  const plan = inspectSource(f.options), outputRoot = join(f.directory, 'blocked-build');
  await assert.rejects(buildProduct({ ...f.options, expectedProductTree: '0'.repeat(40), outputRoot, githubOutput: output }), /REVIEWED_PRODUCT_TREE_REQUIRED/);
  assert.equal(existsSync(outputRoot), false); assert.deepEqual(readFileSync(output), before);
  const result = materialize(f);
  assert.equal(existsSync(join(result.outputRoot, 'publication')), false);
  assert.throws(() => emitGithubOutputs({ ...result, githubOutput: output }), /PUBLICATION_REQUIRES_VERIFIED_BUILD/);
  assert.deepEqual(readFileSync(output), before); assert.equal(plan.productEntries.length, 279);
});

test('CLI identity and clean flags are explicit and inspect cannot emit Github outputs', t => {
  const f = fixture(t), script = join(root, 'scripts/package/build-public-product.mjs');
  const output = githubFile(t, f), before = readFileSync(output);
  const args = ['--source', f.source, '--allowlist', f.policyPath, '--allowlist-sha256', f.options.expectedAllowlistSha256,
    '--upstream-commit', f.options.expectedUpstreamCommit, '--upstream-tree', f.options.expectedUpstreamTree,
    '--tooling-sha256', f.options.expectedToolingSha256];
  for (const flags of [['--github-output', output], ['--require-clean', 'yes']])
    assert.throws(() => execFileSync(process.execPath, [script, ...args, ...flags], { env: cleanEnvironment(), stdio: 'pipe' }), /INSPECT_ARGUMENT_SCOPE_REFUSED|REQUIRE_CLEAN_FLAG_REFUSED/);
  const withoutCommit = args.filter((_, index) => index !== 6 && index !== 7);
  assert.throws(() => execFileSync(process.execPath, [script, ...withoutCommit], { env: cleanEnvironment(), stdio: 'pipe' }), /ARGUMENT_REQUIRED: --upstream-commit/);
  assert.deepEqual(readFileSync(output), before);
});

const retainedCiCommands = new Map([
  ['Setup Node', 'uses: actions/setup-node@v4'], ['Install', 'run: npm ci'], ['Typecheck', 'run: npm run typecheck'],
  ['Test', 'run: npm test'], ['Browser entry', 'npm run wallet:browser:build'],
  ['Verified wallet login browser privacy', 'node scripts/controls/login-ui-smoke.cjs'],
  ['Account authentication browser journeys', 'node scripts/controls/login-methods-ui-smoke.cjs'],
  ['Multilingual wallet browser privacy and review invariants', 'node scripts/controls/i18n-ui-smoke.cjs'],
  ['Approved wallet UI browser journeys', 'node scripts/controls/approved-ui-smoke.cjs'],
  ['Xiongan synthetic browser recovery', 'npm run wallet:xiongan:smoke'], ['ERC20 browser recovery', 'node scripts/controls/erc20-ui-smoke.cjs'],
  ['Contracts', 'run: npm run test:evm'], ['Reference client', 'run: npm run wallet > /dev/null'],
  ['V2 package', 'run: npm run pack:v2'], ['V2 external install', 'run: npm run pack:v2:verify'],
  ['V3 package', 'run: npm run pack:v3'], ['V3 external install', 'run: npm run pack:v3:verify'],
  ['DApp release contract', 'run: npm run test:package:dapp'], ['V2 and V3 DApp Beta artifacts', 'run: npm run pack:dapp:all'],
  ['DApp artifact integrity', 'run: npm run pack:dapp:verify'], ['Reproducible DApp and source archives', 'sha256sum --check /tmp/dapp-archive-sha256'],
  ['Standalone settlement browser recovery', 'HARDHAT_CONFIG=hardhat.rehearsal.config.cjs node scripts/controls/settlement-ui-smoke.cjs'],
  ['Authentication runtime package', 'run: npm run pack:auth'], ['Authentication runtime integrity', 'run: npm run pack:auth:verify'],
  ['Isolated installed authentication journey', 'run: npm run test:auth:installed'], ['Reproducible authentication runtime', 'sha256sum --check /tmp/auth-archive-sha256'],
  ['Reusable DApp delivery kit', 'run: npm run pack:delivery'], ['Reusable DApp delivery integrity', 'run: npm run pack:delivery:verify'],
]);
const retainedCiEvidence = [
  'Verified wallet login browser evidence', 'Account authentication browser evidence', 'Multilingual wallet browser evidence',
  'Approved wallet UI browser evidence', 'Xiongan synthetic browser evidence', 'ERC20 browser evidence', 'Standalone settlement browser evidence',
];
function assertCiContract(text) {
  const jobs = new Map([...text.split(/^jobs:\n/m)[1].matchAll(/^  ([a-z][a-z-]*):\n([\s\S]*?)(?=^  [a-z][a-z-]*:\n|$(?![\s\S]))/gm)].map(match => [match[1], match[2]]));
  assert.deepEqual([...jobs.keys()].sort(), ['task-runtime-minimum', 'verify'], 'CI_EXACT_JOBS_REQUIRED');
  for (const [name, job] of jobs) {
    const checkouts = job.split(/^      - /m).slice(1).filter(part => part.startsWith('uses: actions/checkout@v4'));
    assert.equal(checkouts.length, 1, `CI_CHECKOUT_REQUIRED: ${name}`);
    assert.ok(checkouts[0].includes('ref: ${{ github.event.pull_request.head.sha || github.sha }}'), `CI_EXACT_HEAD_REQUIRED: ${name}`);
  }
  const minimum = jobs.get('task-runtime-minimum');
  for (const command of ['uses: actions/setup-node@v4', "node-version: '22.18.0'", 'run: npm ci', 'npm run pack:auth', 'npm run pack:auth:verify', 'node scripts/controls/task-auth-runtime-smoke.mjs --runtime dist/package-auth'])
    assert.ok(minimum.includes(command), `CI_EXACT_MINIMUM_RUNTIME_REQUIRED: ${command}`);
  assert.equal(minimum.includes('if: always()'), false, 'CI_MINIMUM_FAILURE_BYPASS_REFUSED');
  const parts = jobs.get('verify').split(/^      - /m).slice(1);
  const steps = new Map(parts.filter(part => part.startsWith('name: ')).map(part => [part.match(/^name: ([^\n]+)/)[1], part]));
  assert.equal(parts.filter(part => part.startsWith('uses: actions/checkout@v4')).length, 1, 'CI_CHECKOUT_REQUIRED');
  assert.ok(parts.find(part => part.startsWith('uses: actions/checkout@v4')).includes('ref: ${{ github.event.pull_request.head.sha || github.sha }}'), 'CI_EXACT_HEAD_REQUIRED');
  assert.ok(jobs.get('verify').includes('node-version: [22, 24]'), 'CI_MATRIX_REQUIRED');
  assert.equal(/(?:playwright\s+install|apt(?:-get)?\s+install|continue-on-error:)/.test(text), false, 'CI_INSTALL_OR_FAILURE_BYPASS_REFUSED');
  for (const [name, command] of retainedCiCommands) assert.ok(steps.get(name)?.includes(command), `CI_ORIGINAL_COMMAND_REQUIRED: ${name}`);
  for (const command of ['node scripts/controls/tenant-password-ui-smoke.cjs', 'node scripts/controls/method-change-ui-smoke.cjs', 'node --test tests/task-authorization-browser.test.mjs'])
    assert.ok(steps.get('Account authentication browser journeys').includes(command), `CI_AUTH_JOURNEY_REQUIRED: ${command}`);
  assert.ok(steps.get('Browser entry').includes('node --test tests/task-static-module-closure.test.mjs'), 'CI_STATIC_GRAPH_REQUIRED');
  assert.ok(steps.get('Authentication task runtime package smoke')?.includes('node scripts/controls/task-auth-runtime-smoke.mjs --runtime dist/package-auth'), 'CI_MATRIX_AUTH_RUNTIME_REQUIRED');
  for (const name of retainedCiEvidence) assert.ok(steps.get(name)?.includes('uses: actions/upload-artifact@v4'), `CI_EVIDENCE_REQUIRED: ${name}`);
  assert.ok(steps.get('Test').includes('PRODUCT_STRICT_SMOKE_SOURCE: ${{ github.workspace }}'), 'CI_STRICT_SMOKE_REQUIRED');
  const producer = steps.get('Build and verify public product kit');
  assert.ok(producer?.includes('id: public_product'), 'CI_PUBLIC_OUTPUT_STEP_REQUIRED');
  for (const command of ['--upstream-commit "$EXPECTED_UPSTREAM_COMMIT"', '--upstream-tree "$upstream_tree"', '--require-clean true',
    '--mode plan', '--mode build', '--product-tree "$product_tree"', '--github-output "$GITHUB_OUTPUT"',
    '--output "$RUNNER_TEMP/8415wallet-public-product-node-${{ matrix.node-version }}"'])
    assert.ok(producer.includes(command), 'CI_PUBLIC_BUILD_CONTRACT_REQUIRED');
  assert.equal(producer.includes('if: always()'), false, 'CI_PUBLIC_BUILD_ALWAYS_REFUSED');
  const upload = steps.get('Verified public product artifacts');
  assert.ok(upload?.includes('if: success()') && upload.includes('uses: actions/upload-artifact@v4') && upload.includes('if-no-files-found: error'), 'CI_PUBLIC_UPLOAD_SUCCESS_REQUIRED');
  assert.equal(upload.includes('if: always()'), false, 'CI_PUBLIC_UPLOAD_ALWAYS_REFUSED');
  const paths = upload.match(/^          path: \|\n((?: {12}[^\n]+\n)+)/m)?.[1].trim().split('\n').map(line => line.trim());
  assert.deepEqual(paths, ['archive_path', 'guide_path', 'checksums_path', 'report_path'].map(name => '${{ steps.public_product.outputs.' + name + ' }}'), 'CI_EXACT_PUBLIC_OUTPUTS_REQUIRED');
  assert.equal(steps.has('Reusable DApp artifacts'), false, 'CI_OLD_FULL_REPOSITORY_UPLOAD_REFUSED');
}

test('CI retains the complete validation pipeline and publishes only success-gated exact public outputs', () => {
  assertCiContract(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8'));
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json')));
  const testFiles = packageJson.scripts.test.split(' ');
  for (const path of ['tests/license-packaging.test.mjs', 'tests/product-source.test.mjs', 'tests/task-receipt-observation.test.mjs', 'tests/task-receipt-package-closure.test.mjs'])
    assert.equal(testFiles.filter(value => value === path).length, 1, `CI_TEST_ENUMERATION_REQUIRED: ${path}`);
});

test('CI contract rejects always-upload, missing output, private dist fallback and absent producer', () => {
  const text = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
  const mutations = [
    text.replace("node-version: '22.18.0'", "node-version: '22'"),
    text.replace('      - name: Build and verify standalone authentication package', '      - name: Missing minimum package build').replace('          npm run pack:auth:verify\n', ''),
    text.replace('run: node scripts/controls/task-auth-runtime-smoke.mjs --runtime dist/package-auth', 'run: echo skipped'),
    text.replace('node scripts/controls/method-change-ui-smoke.cjs', 'echo skipped'),
    text.replace('node --test tests/task-static-module-closure.test.mjs', 'echo skipped'),
    text.replace('      - name: Verified public product artifacts\n        if: success()', '      - name: Verified public product artifacts\n        if: always()'),
    text.replace('            ${{ steps.public_product.outputs.report_path }}\n', ''),
    text.replace('            ${{ steps.public_product.outputs.report_path }}\n', '            ${{ steps.public_product.outputs.report_path }}\n            dist/8415wallet-dapp-delivery-*.tar.gz\n'),
    text.replace('            ${{ steps.public_product.outputs.report_path }}\n', '            dist/delivery-package-manifest.json\n'),
    text.replace('        id: public_product\n', ''),
    text.replace('      - name: Build and verify public product kit', '      - name: Missing public product producer'),
    text.replace('        run: npm run test:evm', '        run: echo skipped'),
    text.replace('          PRODUCT_STRICT_SMOKE_SOURCE: ${{ github.workspace }}\n', ''),
    text.replace('          ref: ${{ github.event.pull_request.head.sha || github.sha }}', '          ref: main'),
  ];
  for (const mutated of mutations) { assert.notEqual(mutated, text); assert.throws(() => assertCiContract(mutated), /CI_/); }
});
