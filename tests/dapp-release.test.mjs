import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readDeliveryArchive } from '../scripts/package/verify-delivery.mjs';
import { RELEASE_PROFILES, loadReleaseProfile, resolveReleaseProfile, validateDeploymentConfig, verifyReleaseLocation } from '../web/release-profile.mjs';
import { captureSource, deterministicArchive, exportSource, sha256, stagePublicWeb, validateStaticTree } from '../scripts/package/dapp-release.mjs';

const fixture = id => JSON.parse(readFileSync(new URL(`../config/releases/${id}.json`, import.meta.url), 'utf8'));
function temporary(run) {
  const root = mkdtempSync(join(tmpdir(), 'wallet-dapp-test-'));
  try { return run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}
function git(root, ...args) { return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim(); }
function initialize(root) {
  git(root, 'init', '-q'); git(root, 'config', 'user.email', 'test@example.invalid'); git(root, 'config', 'user.name', 'Package Test');
  writeFileSync(join(root, '.gitignore'), 'dist/\n');
  writeFileSync(join(root, 'example.txt'), 'original\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'Initial fixture');
}
function staticFixture(root) {
  mkdirSync(join(root, 'web'), { recursive: true }); mkdirSync(join(root, 'dist/browser'), { recursive: true });
  writeFileSync(join(root, 'web/index.html'), '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'"><script type="module" src="app.mjs"></script>');
  writeFileSync(join(root, 'web/app.mjs'), "import '../dist/browser/browser.js';\n");
  writeFileSync(join(root, 'web/release-profile.mjs'), 'export const profile = {};\n');
  writeFileSync(join(root, 'web/release-config.json'), JSON.stringify(fixture('v3')));
  writeFileSync(join(root, 'dist/browser/browser.js'), 'export const value = 1;\n');
}

test('V2 and V3 have distinct PRD mapping, explicit features and Beta identity', () => {
  const v2 = resolveReleaseProfile(fixture('v2')), v3 = resolveReleaseProfile(fixture('v3'));
  assert.equal(v2.version, '2.2.0-beta'); assert.equal(v3.version, '3.0.0-beta');
  assert.equal(v2.features.controlledAccounts, true); assert.equal(v3.features.controlledAccounts, true);
  assert.deepEqual(v2.features.assetStandards, ['native-ETH', 'ERC-20', 'ERC-721', 'ERC-1155']);
  assert.deepEqual(v3.features.assetStandards, v2.features.assetStandards);
  assert.equal(v2.features.linkedResponsibilities, false); assert.equal(v3.features.linkedResponsibilities, true);
  assert.deepEqual(v2.prd.sections, ['1','2','3','4','5','6','7','8']);
  assert.equal(v3.prd.scenarios.length, 24); assert.equal(v3.prd.scenarios[23], 'W-24');
  assert.equal(v2.product, '8415wallet'); assert.equal(v3.platform, '8415wallet.com');
  assert.equal(v2.deployment.url, null); assert.match(v2.status, /BETA.*NOT_INDEPENDENTLY_AUDITED/);
  assert.throws(() => { RELEASE_PROFILES.v2.features.linkedResponsibilities = true; }, TypeError);
});
test('Xiongan is V2 and unknown or malformed profiles cannot silently become V3', () => {
  assert.equal(resolveReleaseProfile(fixture('xiongan-v2')).tenant.label, 'Xiongan');
  const invalid = fixture('xiongan-v2'); invalid.profile = 'v3';
  assert.throws(() => resolveReleaseProfile(invalid), /XIONGAN_V2/);
  for (const profile of ['v4', '__proto__', 'constructor', null]) {
    assert.throws(() => resolveReleaseProfile({ ...fixture('v2'), profile }), /PROFILE_REFUSED/);
  }
  assert.throws(() => resolveReleaseProfile({ ...fixture('v2'), extra: true }), /PROFILE_REFUSED/);
  assert.throws(() => resolveReleaseProfile({ ...fixture('v2'), product: 'Other' }), /PROFILE_REFUSED/);
});
test('configuration accepts standard HTTPS syntax and enforces deployment-selected ports', () => {
  const url = 'https://wallet.example.invalid:18443/tenant/v2/web/index.html';
  assert.equal(validateDeploymentConfig({ environment: 'ctyun', url }).url, url);
  for (const environment of ['ctyun', 'sin', 'other']) {
    assert.equal(validateDeploymentConfig({ environment, url: 'https://wallet.example.invalid:443/web/index.html' }).url, 'https://wallet.example.invalid:443/web/index.html');
    assert.throws(() => validateDeploymentConfig({ environment, reservedPorts: [443], url: 'https://wallet.example.invalid:443/web/index.html' }), /RESERVED_PORT/);
    const standard = 'https://wallet.example.invalid/web/index.html';
    assert.equal(validateDeploymentConfig({ environment, url: standard }).url, standard);
    assert.throws(() => validateDeploymentConfig({ environment, reservedPorts: [443], url: standard }), /RESERVED_PORT/);
  }
  for (const url of ['https://wallet.example.invalid:/web/index.html', 'https://wallet.example.invalid:0443/web/index.html', 'https://wallet.example.invalid:0/web/index.html', 'https://wallet.example.invalid:65536/web/index.html',
    'https://user:pass@wallet.example.invalid:18443/web/index.html', 'https://wallet.example.invalid:18443/web/index.html?secret=x',
    'https://wallet.example.invalid:18443/web/index.html#section', 'http://wallet.example.invalid:18080/web/index.html',
    'https://wallet.example.invalid:18443/', 'https://localhost:18443/web/index.html']) {
    assert.throws(() => validateDeploymentConfig({ environment: 'other', url }));
  }
  assert.throws(() => validateDeploymentConfig({ environment: 'ctyun', url: null }), /URL_REQUIRED/);
  assert.throws(() => validateDeploymentConfig({ environment: 'unconfigured', url }), /URL_REFUSED/);
});
test('local configuration is loopback-only and retains the selected arbitrary port', () => {
  assert.equal(validateDeploymentConfig({ environment: 'local', url: 'http://127.0.0.1:23456/web/index.html' }).url, 'http://127.0.0.1:23456/web/index.html');
  assert.equal(validateDeploymentConfig({ environment: 'local', url: 'http://[::1]:23456/web/index.html' }).environment, 'local');
  assert.throws(() => validateDeploymentConfig({ environment: 'local', url: 'http://example.invalid:23456/web/index.html' }), /SECURE_URL_REQUIRED/);
});
test('runtime loader is no-store, same-source and fail-closed', async () => {
  let request;
  const result = await loadReleaseProfile(async (url, options) => { request = { url, options }; return { ok: true, text: async () => JSON.stringify(fixture('v2')) }; });
  assert.equal(result.id, 'v2'); assert.match(request.url.pathname, /web\/release-config.json$/);
  assert.deepEqual(request.options, { cache: 'no-store', credentials: 'omit' });
  await assert.rejects(loadReleaseProfile(async () => ({ ok: false })), /CONFIG_UNAVAILABLE/);
  await assert.rejects(loadReleaseProfile(async () => ({ ok: true, text: async () => '{' })), /CONFIG_INVALID/);
  await assert.rejects(loadReleaseProfile(async () => ({ ok: true, text: async () => ' '.repeat(8193) })), /CONFIG_TOO_LARGE/);
});
test('source metadata identifies actual commit plus dirty content without altering the real index', () => temporary(root => {
  initialize(root); const baseline = captureSource(root);
  assert.equal(baseline.commit, git(root, 'rev-parse', 'HEAD')); assert.equal(baseline.tree, baseline.commitTree); assert.equal(baseline.dirty, false);
  const index = git(root, 'write-tree');
  writeFileSync(join(root, 'example.txt'), 'changed\n'); writeFileSync(join(root, 'new.txt'), 'new\n');
  mkdirSync(join(root, 'dist')); writeFileSync(join(root, 'dist/generated.json'), '{}');
  writeFileSync(join(root, '.env'), 'LOCAL_ONLY=value\n');
  const unstaged = captureSource(root);
  assert.equal(unstaged.files['new.txt'], undefined); assert.equal(unstaged.files['.env'], undefined);
  git(root, 'add', 'new.txt');
  const stagedIndex = git(root, 'write-tree');
  const changed = captureSource(root);
  assert.equal(changed.commit, baseline.commit); assert.notEqual(changed.tree, baseline.tree); assert.equal(changed.dirty, true);
  assert.equal(changed.files['example.txt'], sha256('changed\n')); assert.equal(changed.files['new.txt'], sha256('new\n'));
  assert.equal(changed.files['dist/generated.json'], undefined); assert.notEqual(stagedIndex, index); assert.equal(git(root, 'write-tree'), stagedIndex); assert.equal(changed.files['.env'], undefined);
}));
test('source capture requires its own Git root and refuses symlink exports', () => temporary(root => {
  assert.throws(() => captureSource(root)); initialize(root);
  const child = join(root, 'child'); mkdirSync(child);
  assert.throws(() => captureSource(child), /SOURCE_REPOSITORY_REQUIRED/);
  symlinkSync('example.txt', join(root, 'link')); git(root, 'add', 'link');
  assert.throws(() => captureSource(root), /SOURCE_PATH_REFUSED/);
}));
test('source archive rebuilds the recorded Git tree and is byte-reproducible', () => temporary(root => {
  initialize(root); chmodSync(join(root, 'example.txt'), 0o755);
  const source = captureSource(root); const archive = join(root, 'dist'); mkdirSync(archive);
  const a = join(archive, 'a.tar.gz'), b = join(archive, 'b.tar.gz');
  assert.equal(exportSource(root, source, a), exportSource(root, source, b)); assert.deepEqual(readFileSync(a), readFileSync(b));
  const extracted = join(archive, 'extracted'); mkdirSync(extracted);
  execFileSync('tar', ['-xzf', a, '-C', extracted]); git(extracted, 'init', '-q'); git(extracted, 'add', '.');
  assert.equal(git(extracted, 'write-tree'), source.tree);
}));
test('module validation checks side-effect imports, exports and literal dynamic imports', () => temporary(root => {
  staticFixture(root);
  writeFileSync(join(root, 'web/app.mjs'), "import '../dist/browser/browser.js';\nexport {value} from '../dist/browser/browser.js';\nawait import('../dist/browser/browser.js');\n// import 'unrelated-comment';\n");
  assert.equal(validateStaticTree(root).relativeImports, 3);
  writeFileSync(join(root, 'web/app.mjs'), "import 'missing-package';");
  assert.throws(() => validateStaticTree(root), /NONLOCAL_IMPORT/);
  writeFileSync(join(root, 'web/app.mjs'), "import './absent.mjs';");
  assert.throws(() => validateStaticTree(root), /UNRESOLVED_IMPORT/);
  writeFileSync(join(root, 'web/app.mjs'), 'await import(userInput);');
  assert.throws(() => validateStaticTree(root), /DYNAMIC_IMPORT_REFUSED/);
}));
test('static validation refuses missing/external page assets and false acceptance claims', () => temporary(root => {
  staticFixture(root); const page = readFileSync(join(root, 'web/index.html'), 'utf8');
  writeFileSync(join(root, 'web/index.html'), page + '<img src="https://example.invalid/image.png">');
  assert.throws(() => validateStaticTree(root), /EXTERNAL_ASSET_REFUSED/);
  writeFileSync(join(root, 'web/index.html'), page + '<link rel="stylesheet" href="missing.css">');
  assert.throws(() => validateStaticTree(root), /UNRESOLVED_IMPORT/);
  writeFileSync(join(root, 'web/index.html'), page + '<p>Not independently audited.</p>'); validateStaticTree(root);
  writeFileSync(join(root, 'web/index.html'), page + '<p>Production-ready.</p>');
  assert.throws(() => validateStaticTree(root), /FORBIDDEN_CLAIM/);
}));
test('archive output is deterministic across file mtimes and insertion order', () => temporary(root => {
  const a = join(root, 'a'), b = join(root, 'b'); mkdirSync(a); mkdirSync(b);
  writeFileSync(join(a, 'z'), 'z'); writeFileSync(join(a, 'a'), 'a');
  writeFileSync(join(b, 'a'), 'a'); writeFileSync(join(b, 'z'), 'z');
  assert.equal(deterministicArchive(a, join(root, 'a.tgz')), deterministicArchive(b, join(root, 'b.tgz')));
}));

test('configured origin and entry cannot silently move recovery journals', () => {
  const config = fixture('v2'); config.deployment = { environment: 'other', url: 'https://wallet.example.invalid:18443/v2/web/index.html' };
  const profile = resolveReleaseProfile(config);
  assert.equal(verifyReleaseLocation(profile, { href: config.deployment.url }), profile);
  for (const href of ['https://wallet.example.invalid:19443/v2/web/index.html', 'https://other.example.invalid:18443/v2/web/index.html',
    'https://wallet.example.invalid:18443/v3/web/index.html', config.deployment.url + '?preview=1', config.deployment.url + '#preview']) {
    assert.throws(() => verifyReleaseLocation(profile, { href }), /LOCATION_MISMATCH/);
  }
  assert.throws(() => verifyReleaseLocation(profile, undefined), /LOCATION_REQUIRED/);
  assert.equal(verifyReleaseLocation(resolveReleaseProfile(fixture('v2'))).id, 'v2');
});
test('standard HTTPS and explicit default-port URLs have the same configured origin', () => {
  const config = fixture('v2');
  config.deployment = { environment: 'sin', url: 'https://wallet.example.invalid/web/index.html' };
  const profile = resolveReleaseProfile(config);
  assert.equal(verifyReleaseLocation(profile, { href: 'https://wallet.example.invalid:443/web/index.html' }), profile);
  assert.throws(() => verifyReleaseLocation(profile, { href: 'https://wallet.example.invalid:9443/web/index.html' }), /LOCATION_MISMATCH/);
});

test('noncanonical and encoded endpoint paths are refused', () => {
  for (const path of ['/v2/../web/index.html', '/%76%32/web/index.html', '//web/index.html']) {
    assert.throws(() => validateDeploymentConfig({ environment: 'other', url: `https://wallet.example.invalid:18443${path}` }), /CANONICAL_PATH_REQUIRED/);
  }
});

test('hosted web staging refuses ignored secrets and stages exact captured public blobs', () => temporary(root => {
  initialize(root); mkdirSync(join(root, 'web')); writeFileSync(join(root, 'web/app.mjs'), 'export const a = 1;\n');
  writeFileSync(join(root, '.gitignore'), 'dist/\n*.log\nweb/.env.local\n'); git(root, 'add', 'web/app.mjs', '.gitignore');
  const source = captureSource(root); const stage = join(root, 'dist'); mkdirSync(stage);
  writeFileSync(join(root, 'web/.env.local'), 'FAKE_LOCAL_SECRET=not-real\n');
  assert.equal(source.files['web/.env.local'], undefined);
  assert.throws(() => stagePublicWeb(root, source, stage), /UNTRACKED_SOURCE_STAGE_REQUIRED/);
  rmSync(join(root, 'web/.env.local')); writeFileSync(join(root, 'web/operator.log'), 'private local diagnostic\n');
  assert.throws(() => stagePublicWeb(root, source, stage), /UNTRACKED_SOURCE_STAGE_REQUIRED/);
  rmSync(join(root, 'web/operator.log')); writeFileSync(join(root, 'web/app.mjs'), 'changed after capture\n');
  stagePublicWeb(root, source, stage);
  assert.equal(readFileSync(join(stage, 'web/app.mjs'), 'utf8'), 'export const a = 1;\n');
}));
test('staged hidden or nonpublic web files cannot become hosted assets', () => temporary(root => {
  initialize(root); mkdirSync(join(root, 'web')); writeFileSync(join(root, 'web/.env.local'), 'FAKE_LOCAL_SECRET=not-real\n');
  git(root, 'add', 'web/.env.local'); const stage = join(root, 'dist'); mkdirSync(stage);
  assert.throws(() => stagePublicWeb(root, captureSource(root), stage), /NONPUBLIC_WEB_FILE_REFUSED/);
  rmSync(join(root, 'web/.env.local')); git(root, 'add', '--update');
  writeFileSync(join(root, 'web/notes.txt'), 'private draft\n'); git(root, 'add', 'web/notes.txt');
  assert.throws(() => stagePublicWeb(root, captureSource(root), stage), /NONPUBLIC_WEB_FILE_REFUSED/);
}));

test('shared profile gate caches one frozen result or refusal for all UI surfaces', async () => {
  const priorFetch = globalThis.fetch;
  try {
    let requests = 0;
    globalThis.fetch = async () => { requests++; return { ok: true, text: async () => JSON.stringify(fixture('v2')) }; };
    const success = await import('../web/release-profile.mjs?test-cache-success');
    const first = success.getReleaseProfile(), second = success.getReleaseProfile();
    assert.equal(first, second); assert.equal((await first).id, 'v2'); assert.equal(requests, 1);
    assert.ok(Object.isFrozen(await second));
    globalThis.fetch = async () => { requests++; return { ok: false }; };
    const refusal = await import('../web/release-profile.mjs?test-cache-refusal');
    const refused = refusal.getReleaseProfile();
    await assert.rejects(refused, /CONFIG_UNAVAILABLE/);
    assert.equal(refusal.getReleaseProfile(), refused);
    await assert.rejects(refusal.getReleaseProfile(), /CONFIG_UNAVAILABLE/);
    assert.equal(requests, 2);
  } finally { globalThis.fetch = priorFetch; }
});


test('deployment reservations are explicit, validated and independent of environment names', () => {
  const url = 'https://wallet.example.invalid:443/web/index.html';
  for (const environment of ['other', 'ctyun', 'sin']) {
    assert.equal(validateDeploymentConfig({ environment, url }).url, url);
    assert.throws(() => validateDeploymentConfig({ environment, url, reservedPorts: [443] }), /RESERVED_PORT/);
    const result = validateDeploymentConfig({ environment, url, reservedPorts: [22, 18443] });
    assert.deepEqual(result.reservedPorts, [22, 18443]); assert.ok(Object.isFrozen(result.reservedPorts));
  }
  for (const reservedPorts of [[0], [65536], ['443'], [443, 443], '443', null]) {
    assert.throws(() => validateDeploymentConfig({ environment: 'other', url, reservedPorts }), /RESERVED_PORTS/);
  }
  assert.deepEqual(validateDeploymentConfig({ environment: 'unconfigured', url: null }), { environment: 'unconfigured', url: null });
});

test('source archives with published long archive names round-trip through the strict delivery reader', () => temporary(root => {
  initialize(root);
  const directory = 'releases/2026-10-05-delivery-archive';
  mkdirSync(join(root, directory), { recursive: true });
  const paths = [
    `${directory}/Xiongan-DApp-Branch-Sync-Recovery-8c786de7-20261003-github-safe.zip`,
    `${directory}/Xiongan-Wallet-Checksum-Repair-Recovery-93934f9-20261003-github-safe.zip`
  ];
  for (const path of paths) writeFileSync(join(root, path), 'synthetic archive bytes\n');
  git(root, 'add', directory);
  const source = captureSource(root), first = join(root, 'first.tar.gz'), second = join(root, 'second.tar.gz');
  assert.equal(exportSource(root, source, first), exportSource(root, source, second));
  const entries = readDeliveryArchive(readFileSync(first));
  assert.deepEqual([...entries.keys()].sort(), source.entries.map(entry => entry.path).sort());
  for (const path of paths) {
    assert.ok(path.length > 100);
    assert.equal(entries.get(path).bytes.toString(), 'synthetic archive bytes\n');
    assert.equal(entries.get(path).mode, 0o644);
  }
}));
