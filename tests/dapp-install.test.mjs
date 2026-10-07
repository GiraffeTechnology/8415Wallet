import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import { captureAuthSource, deterministicAuthArchive } from '../scripts/package/build-auth.mjs';
import { AUTH_SCHEMA, AUTH_STATUS, jsonBytes, runtimePackage, sha256, sourcePathAllowed, walkAuth } from '../scripts/package/verify-auth.mjs';
import { captureSource, deterministicArchive, exportSource, walk } from '../scripts/package/dapp-release.mjs';
import { DELIVERY_FILES, DELIVERY_SCHEMA, extractDelivery, readDeliveryArchive, verifyDeliveryArchive } from '../scripts/package/verify-delivery.mjs';
import { createDappConfig, installDapp, nginxStaticAllowlist, planDapp, rollbackDapp, verifyInstalledRelease } from '../deploy/dapp/install.mjs';
import { resolveReleaseProfile } from '../web/release-profile.mjs';
const put = (root, path, bytes) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), bytes); chmodSync(join(root, path), 0o644); };
const hashFiles = root => Object.fromEntries(walk(root).map(path => [path, sha256(readFileSync(join(root, path)))]));
const sums = root => put(root, 'SHA256SUMS', walk(root).filter(path => path !== 'SHA256SUMS').sort().map(path => `${sha256(readFileSync(join(root, path)))}  ${path}`).join('\n') + '\n');
const template = id => ({ schema: '8415wallet-release/1', product: '8415wallet', platform: '8415wallet.com', profile: id, tenant: { id: 'default', label: '8415wallet' }, deployment: { environment: 'unconfigured', url: null } });
const config = () => ({ ...template('v2'), tenant: { id: 'example', label: 'Synthetic Example' }, deployment: { environment: 'local', url: 'http://127.0.0.1:23456/wallet/web/index.html' } });
const passwordRoutingPaths = ['web/tenant-password-routing.mjs', 'web/tenant-password-ui.mjs', 'web/tenant-password-routing.json'];
function fixture(t, revision = 'first', routingMutation = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wallet-kit-test-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceRoot = join(root, 'source'), runtime = join(root, 'runtime'), kit = join(root, 'kit'); mkdirSync(sourceRoot); mkdirSync(runtime); mkdirSync(kit);
  const authPaths = ['server/main.mjs', 'server/service-entry.mjs', 'server/runtime-entry.mjs', 'server/auth-service.mjs', 'server/crypto.mjs', 'server/config-validation.mjs', 'server/ca-verifier.mjs', 'server/store.mjs', 'server/operator-init.mjs', 'server/operator-activate.mjs', 'web/login-core.mjs', 'deploy/auth-xiongan/install.mjs', 'deploy/auth-xiongan/8415wallet-auth-xiongan.service', 'deploy/auth-xiongan/auth-location.nginx.conf', 'docs/AUTH-INSTALL.md', 'scripts/package/verify-auth.mjs', 'LICENSE'];
  for (const path of new Set([...authPaths, ...DELIVERY_FILES, 'docs/ERC-8415-Wallet-PRD.md'])) put(sourceRoot, path, `Synthetic fixture ${revision}: ${path}\n`);
  for (const path of passwordRoutingPaths) put(sourceRoot, path, readFileSync(new URL(`../${path}`, import.meta.url)));
  const pkg = { name: '8415wallet', version: '0.1.0', license: 'CC0-1.0', dependencies: { ethers: '^6.17.0' } };
  const lock = { name: '8415wallet', lockfileVersion: 3, packages: { '': { dependencies: pkg.dependencies }, 'node_modules/ethers': { version: '6.17.0', resolved: 'https://registry.npmjs.org/ethers/-/ethers-6.17.0.tgz', integrity: 'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==' } } };
  put(sourceRoot, 'package.json', jsonBytes(pkg)); put(sourceRoot, 'package-lock.json', jsonBytes(lock));
  for (const id of ['v2', 'v3']) put(sourceRoot, `config/releases/${id}.json`, jsonBytes(template(id)));
  const git = args => execFileSync('git', args, { cwd: sourceRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '-q']); git(['add', '--all']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Synthetic fixture']);
  const authSource = captureAuthSource(sourceRoot), source = captureSource(sourceRoot);
  const artifacts = {}, manifests = {};
  for (const path of authPaths) put(runtime, path, readFileSync(join(sourceRoot, path)));
  put(runtime, 'provenance/package.source.json', jsonBytes(pkg)); put(runtime, 'provenance/package-lock.source.json', jsonBytes(lock));
  const production = runtimePackage(pkg, lock); put(runtime, 'package.json', jsonBytes(production.manifest)); put(runtime, 'package-lock.json', jsonBytes(production.lock));
  put(runtime, 'node_modules/ethers/package.json', jsonBytes({ name: 'ethers', version: '6.17.0' })); put(runtime, 'node_modules/ethers/index.js', 'export const syntheticFixture = true;\n');
  const auth = { schema: AUTH_SCHEMA, status: AUTH_STATUS, source: authSource, runtime: { node: '>=22.18.0', bundledNode: false, bundledProductionDependencies: true, entry: 'server/runtime-entry.mjs', tenantArgumentRequired: true, credentialStoreFormat: 1 }, files: hashFiles(runtime) };
  put(runtime, 'AUTH-RELEASE.json', jsonBytes(auth)); sums(runtime);
  const authBytes = deterministicAuthArchive(runtime); artifacts.auth = { artifact: `8415wallet-auth-runtime-${source.tree}.tar.gz`, sha256: sha256(authBytes) }; manifests.auth = { ...artifacts.auth, ...auth };
  put(kit, `artifacts/${artifacts.auth.artifact}`, authBytes);
  const sourceArchive = `8415wallet-source-${source.tree}.tar.gz`; mkdirSync(join(kit, 'artifacts'), { recursive: true });
  artifacts.source = { artifact: sourceArchive, sha256: exportSource(sourceRoot, source, join(kit, 'artifacts', sourceArchive)) };
  for (const id of ['v2', 'v3']) {
    const ui = join(root, id); mkdirSync(ui); const cfg = template(id), profile = resolveReleaseProfile(cfg);
    put(ui, 'web/index.html', '<meta http-equiv="Content-Security-Policy" content="default-src self">');
    put(ui, 'web/release-config.json', jsonBytes(cfg)); put(ui, 'web/release-profile.mjs', 'export {};\n'); put(ui, 'dist/browser/browser.js', `export const fixture = '${revision}';\n`);
    for (const path of passwordRoutingPaths) {
      if (path !== routingMutation.omit) put(ui, path, readFileSync(join(sourceRoot, path)));
    }
    if (routingMutation.config) put(ui, 'web/tenant-password-routing.json', jsonBytes(routingMutation.config));
    const runtimeFiles = hashFiles(ui); put(ui, 'docs/ERC-8415-Wallet-PRD.md', readFileSync(join(sourceRoot, 'docs/ERC-8415-Wallet-PRD.md')));
    const { entries, ...identity } = source;
    const release = { schema: '8415wallet-dapp-release/2', profile: id, version: profile.version, status: profile.status, source: identity, sourceArchive: artifacts.source,
      tenant: profile.tenant, deployment: profile.deployment, features: profile.features, build: { configSha256: runtimeFiles['web/release-config.json'] }, prd: { file: 'docs/ERC-8415-Wallet-PRD.md', sha256: source.files['docs/ERC-8415-Wallet-PRD.md'] }, runtimeFiles };
    put(ui, 'RELEASE.json', jsonBytes(release)); sums(ui);
    artifacts[id] = { artifact: `8415wallet-dapp-${id}-${profile.version}.tar.gz`, sha256: deterministicArchive(ui, join(kit, 'artifacts', `8415wallet-dapp-${id}-${profile.version}.tar.gz`)) };
    manifests[id] = { ...artifacts[id], ...release };
  }
  for (const path of DELIVERY_FILES) put(kit, path, readFileSync(join(sourceRoot, path)));
  for (const id of ['v2', 'v3', 'auth']) put(kit, `artifacts/${id === 'auth' ? 'auth' : `dapp-${id}`}-package-manifest.json`, jsonBytes(manifests[id]));
  const release = { schema: DELIVERY_SCHEMA, status: 'BETA_FUNCTIONAL_TESTING_NOT_INDEPENDENTLY_AUDITED', source: { commit: source.commit, tree: source.tree, dirty: false }, artifacts, files: hashFiles(kit) };
  put(kit, 'DELIVERY.json', jsonBytes(release)); sums(kit);
  const archive = join(root, 'kit.tar.gz');
  const pins = { expectedSha256: deterministicArchive(kit, archive), expectedTree: source.tree };
  return { root, kit, sourceRoot, archive, pins, release, input: { archive, ...pins, tenant: 'example', profile: 'v2', config: config(), target: join(root, 'site') } };
}
function mutateArchive(bytes, action) { const tar = gunzipSync(bytes); action(tar); tar.fill(32, 148, 156); const sum = [...tar.subarray(0, 512)].reduce((a, b) => a + b, 0); tar.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8); return gzipSync(tar); }

test('complete synthetic kit verifies V2/V3, exact source, auth dependencies and safe extraction offline', t => {
  const f = fixture(t); const verified = verifyDeliveryArchive(f.archive, f.pins);
  assert.equal(verified.dapps.v2.release.version, '2.2.0-beta'); assert.equal(verified.auth.source.tree, f.pins.expectedTree);
  const extracted = join(f.root, 'extracted'); extractDelivery(verified, extracted);
  assert.equal(readFileSync(join(extracted, 'DELIVERY.json'), 'utf8'), readFileSync(join(f.kit, 'DELIVERY.json'), 'utf8'));
  assert.equal(JSON.parse(readFileSync(join(extracted, 'runtime/auth/AUTH-RELEASE.json'))).source.tree, f.pins.expectedTree);
  assert.throws(() => extractDelivery(verified, extracted), /EEXIST/);
});
test('external digest and tree pins are mandatory; self-consistent altered source/tool payload is refused', t => {
  const f = fixture(t); assert.throws(() => verifyDeliveryArchive(f.archive), /EXTERNAL_PINS_REQUIRED/);
  assert.throws(() => verifyDeliveryArchive(f.archive, { ...f.pins, expectedSha256: '0'.repeat(64) }), /ARCHIVE_DIGEST_MISMATCH/);
  assert.throws(() => verifyDeliveryArchive(f.archive, { ...f.pins, expectedTree: '0'.repeat(40) }), /IDENTITY_REFUSED/);
  put(f.kit, 'deploy/dapp/install.mjs', 'modified installer'); f.release.files['deploy/dapp/install.mjs'] = sha256(Buffer.from('modified installer'));
  put(f.kit, 'DELIVERY.json', jsonBytes(f.release)); sums(f.kit);
  const pin = deterministicArchive(f.kit, f.archive);
  assert.throws(() => verifyDeliveryArchive(f.archive, { ...f.pins, expectedSha256: pin }), /TOOL_SOURCE_MISMATCH/);
});
test('strict tar reader rejects traversal, absolute paths, links, devices, PAX, checksum errors and trailing payload before extraction', t => {
  const f = fixture(t), bytes = readFileSync(f.archive);
  for (const type of [49, 50, 51, 52, 54, 76, 120]) assert.throws(() => readDeliveryArchive(mutateArchive(bytes, tar => { tar[156] = type; })), /LINK_OR_TYPE/);
  for (const path of ['../escape/', '/absolute/', './a/../escape/']) assert.throws(() => readDeliveryArchive(mutateArchive(bytes, tar => { tar.fill(0, 0, 100); tar.write(path); })), /PATH_REFUSED/);
  const corrupt = gunzipSync(bytes); corrupt[0] ^= 1; assert.throws(() => readDeliveryArchive(gzipSync(corrupt)), /CHECKSUM/);
  assert.throws(() => readDeliveryArchive(mutateArchive(bytes, tar => { tar[tar.length - 1] = 1; })), /TRAILING_DATA/);
  const tar = gunzipSync(bytes); assert.throws(() => readDeliveryArchive(gzipSync(Buffer.concat([tar.subarray(0, 512), tar]))), /DUPLICATE/);
});
test('install, upgrade and pinned rollback preserve origin, profile, tenant and separate credential state', t => {
  const f = fixture(t), next = fixture(t, 'second');
  const credentials = join(f.root, 'credential-state'); writeFileSync(credentials, 'synthetic-consumed-counter=9');
  const first = installDapp(f.input); assert.equal(readlinkSync(join(f.input.target, 'current')), `releases/${first.release}`);
  assert.equal(JSON.parse(readFileSync(join(f.input.target, 'current/public/web/release-config.json'))).tenant.id, 'example');
  assert.throws(() => installDapp(f.input), /EXPLICIT_UPGRADE/);
  const second = installDapp({ ...next.input, target: f.input.target, upgrade: true }); assert.notEqual(second.release, first.release);
  const rolled = rollbackDapp({ target: f.input.target, tenant: 'example', profile: 'v2', release: first.release, expectedReceiptSha256: first.receiptSha256, expectedTree: f.pins.expectedTree });
  assert.equal(rolled.previous, second.release); assert.equal(readlinkSync(join(f.input.target, 'current')), `releases/${first.release}`);
  assert.equal(readFileSync(credentials, 'utf8'), 'synthetic-consumed-counter=9');
  assert.ok(!readFileSync(first.nginxPlan, 'utf8').includes('listen '));
  assert.ok(!readFileSync(first.nginxPlan, 'utf8').includes('/auth/'));
});
test('origin, endpoint, tenant and profile drift refuse upgrade without changing current', t => {
  const f = fixture(t); const first = installDapp(f.input), link = readlinkSync(join(f.input.target, 'current'));
  for (const url of ['http://127.0.0.1:23457/wallet/web/index.html', 'http://127.0.0.1:23456/moved/web/index.html']) {
    const changed = config(); changed.deployment.url = url;
    assert.throws(() => installDapp({ ...f.input, config: changed, upgrade: true }), /BOUNDARY_CHANGE/);
  }
  assert.throws(() => installDapp({ ...f.input, tenant: 'other', upgrade: true }), /CONFIG_BOUNDARY/);
  assert.throws(() => installDapp({ ...f.input, profile: 'v3', upgrade: true }), /CONFIG_BOUNDARY/);
  assert.equal(readlinkSync(join(f.input.target, 'current')), link);
  assert.throws(() => rollbackDapp({ target: f.input.target, tenant: 'example', profile: 'v2', release: first.release }), /EXTERNAL_PINS/);
});
test('static-only nginx file emits exact prefixed aliases with no general root or server changes', t => {
  const f = fixture(t), first = installDapp(f.input), plan = readFileSync(first.nginxPlan, 'utf8');
  assert.match(plan, /location = \/wallet\/web\/index.html/); assert.match(plan, /default_type application\/javascript/);
  for (const forbidden of ['server {', 'listen ', 'proxy_pass', 'ssl_certificate', 'location /', 'root ']) assert.ok(!plan.includes(forbidden));
  const identity = verifyInstalledRelease(f.input.target, first.release).receipt.identity;
  assert.throws(() => nginxStaticAllowlist(f.input.target, identity, ['server/main.mjs']), /PUBLIC_PATH/);
});
test('tampered or additional public files refuse rollback; source and receipt pins are checked', t => {
  const f = fixture(t), first = installDapp(f.input);
  const args = { target: f.input.target, tenant: 'example', profile: 'v2', release: first.release, expectedReceiptSha256: first.receiptSha256, expectedTree: f.pins.expectedTree };
  assert.throws(() => rollbackDapp({ ...args, expectedReceiptSha256: '0'.repeat(64) }), /RECEIPT_DIGEST/);
  assert.throws(() => rollbackDapp({ ...args, expectedTree: '0'.repeat(40) }), /SOURCE_TREE/);
  put(join(f.input.target, 'releases', first.release), 'public/web/unlisted.json', '{}');
  assert.throws(() => rollbackDapp(args), /COMPLETE_INVENTORY/);
  rmSync(join(f.input.target, 'releases', first.release, 'public/web/unlisted.json'));
  writeFileSync(join(f.input.target, 'releases', first.release, 'public/web/index.html'), 'tampered');
  assert.throws(() => rollbackDapp(args), /PUBLIC_DIGEST/);
});
test('symlink targets, unmanaged directories, writable directories and concurrent install locks fail closed', t => {
  const f = fixture(t); mkdirSync(f.input.target); put(f.input.target, 'unrelated-service.conf', 'keep');
  assert.throws(() => installDapp(f.input), /UNMANAGED_TARGET/); assert.equal(readFileSync(join(f.input.target, 'unrelated-service.conf'), 'utf8'), 'keep');
  rmSync(f.input.target, { recursive: true }); symlinkSync(f.root, f.input.target);
  assert.throws(() => installDapp(f.input), /UNSAFE_PATH/); rmSync(f.input.target);
  mkdirSync(f.input.target); chmodSync(f.input.target, 0o777); assert.throws(() => installDapp(f.input), /UNSAFE_PATH/); chmodSync(f.input.target, 0o755);
  put(f.input.target, '.install.lock', 'busy'); assert.throws(() => installDapp(f.input), /EEXIST/);
});
test('null deployment, injected config properties and nginx-unsafe URL syntax are refused', t => {
  const f = fixture(t);
  assert.throws(() => installDapp({ ...f.input, config: template('v2'), tenant: 'default' }), /CONFIG_BOUNDARY/);
  assert.throws(() => installDapp({ ...f.input, config: { ...config(), credential: 'never-public' } }), /PROFILE_REFUSED/);
  const changed = config(); changed.deployment.url = 'http://127.0.0.1:23456/$bad/web/index.html';
  assert.throws(() => installDapp({ ...f.input, config: changed }), /URL_PATH/);
});


test('config tooling writes only validated public config and never overwrites a file', t => {
  const f = fixture(t), output = join(f.root, 'public-config.json');
  const input = { tenant: 'example', label: 'Synthetic Example', profile: 'v2', environment: 'local', url: config().deployment.url, output };
  const result = createDappConfig(input); assert.equal(result.sha256, sha256(readFileSync(output)));
  assert.deepEqual(JSON.parse(readFileSync(output)), config());
  assert.throws(() => createDappConfig(input), /EEXIST/);
  assert.throws(() => createDappConfig({ ...input, tenant: 'xiongan', profile: 'v3' }), /XIONGAN_V2/);
});
test('kit extraction refuses a symlinked ancestor before writing', t => {
  const f = fixture(t), verified = verifyDeliveryArchive(f.archive, f.pins), link = join(f.root, 'linked');
  symlinkSync(f.root, link); assert.throws(() => extractDelivery(verified, join(link, 'bad')), /EXTRACT_PARENT/);
});


test('reviewable static route plan can be prepared before install without changing target', t => {
  const f = fixture(t), output = join(f.root, 'static-plan.conf');
  const plan = planDapp({ ...f.input, output }); assert.equal(plan.changesApplied, false);
  assert.match(readFileSync(output, 'utf8'), /location = \/wallet\/web\/index.html/);
  const installed = installDapp(f.input); assert.equal(readFileSync(output, 'utf8'), readFileSync(installed.nginxPlan, 'utf8'));
});


test('public CLI config, plan, install and rollback complete without dependency installation', t => {
  const f = fixture(t), tool = new URL('../deploy/dapp/install.mjs', import.meta.url).pathname;
  const run = args => JSON.parse(execFileSync(process.execPath, [tool, ...args], { encoding: 'utf8' }));
  const output = join(f.root, 'cli-config.json'), plan = join(f.root, 'cli-nginx.conf');
  run(['config', '--tenant', 'example', '--label', 'Synthetic Example', '--profile', 'v2', '--environment', 'local', '--url', config().deployment.url, '--output', output]);
  const flags = ['--archive', f.archive, '--sha256', f.pins.expectedSha256, '--tree', f.pins.expectedTree, '--tenant', 'example', '--profile', 'v2', '--config', output, '--target', f.input.target];
  assert.equal(run(['plan', ...flags, '--output', plan]).changesApplied, false);
  const installed = run(['install', ...flags]);
  const rollback = run(['rollback', '--target', f.input.target, '--tenant', 'example', '--profile', 'v2', '--tree', f.pins.expectedTree, '--release', installed.release, '--receipt-sha256', installed.receiptSha256]);
  assert.equal(rollback.release, installed.release);
});


test('generic installer accepts 443 when unreserved and refuses explicitly reserved deployment ports', t => {
  const f = fixture(t), publicConfig = config();
  publicConfig.deployment = { environment: 'ctyun', url: 'https://wallet.example.invalid/web/index.html', reservedPorts: [22, 18443] };
  const installed = installDapp({ ...f.input, config: publicConfig }); assert.equal(installed.entryUrl, publicConfig.deployment.url);
  publicConfig.deployment.reservedPorts = [443];
  assert.throws(() => installDapp({ ...f.input, config: publicConfig, target: join(f.root, 'other') }), /RESERVED_PORT/);
  assert.throws(() => createDappConfig({ tenant: 'example', label: 'Example', profile: 'v2', environment: 'ctyun', url: publicConfig.deployment.url, reservedPorts: [443], output: join(f.root, 'reserved.json') }), /RESERVED_PORT/);
});

for (const missing of passwordRoutingPaths) {
  test(`self-consistent synthetic kit refuses missing password routing asset: ${missing}`, t => {
    const f = fixture(t, 'missing-routing', { omit: missing });
    assert.throws(() => verifyDeliveryArchive(f.archive, f.pins), /PASSWORD_ROUTING_RUNTIME_MISSING/);
  });
}
test('self-consistent synthetic kit refuses enabled packaged password readiness', t => {
  const routes = JSON.parse(readFileSync(new URL('../web/tenant-password-routing.json', import.meta.url), 'utf8'));
  routes.entries[0].passwordManagementReady = true;
  const f = fixture(t, 'ready-routing', { config: routes });
  assert.throws(() => verifyDeliveryArchive(f.archive, f.pins), /PASSWORD_ROUTING_DEFAULT_NOT_READY_REQUIRED/);
});
test('self-consistent synthetic kit refuses malformed packaged password routing schema', t => {
  const routes = JSON.parse(readFileSync(new URL('../web/tenant-password-routing.json', import.meta.url), 'utf8'));
  routes.schema = 'unsupported-routing-schema';
  const f = fixture(t, 'malformed-routing', { config: routes });
  assert.throws(() => verifyDeliveryArchive(f.archive, f.pins), /PASSWORD_ROUTING_SCHEMA_REFUSED/);
});
