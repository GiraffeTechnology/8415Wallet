// Synthetic installation roots and public identities only. No production unit or credential is touched.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, chmod, symlink, link } from 'node:fs/promises';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { paths, prepare, inspect, rollback, enableProxy, insertProxy, nginxLocation, selectPort, protect, probe, cli, upgrade, rollbackCode, inspectNginxIncludes, configureMail } from '../deploy/auth-xiongan/install.mjs';
import { validateAuthConfig } from '../server/config-validation.mjs';
import { createAuthService } from '../server/auth-service.mjs';
import { MemoryCredentialStore } from '../server/store.mjs';
import { captureAuthSource } from '../scripts/package/build-auth.mjs';
import { AUTH_SCHEMA, AUTH_STATUS, runtimePackage, sha256, walkAuth } from '../scripts/package/verify-auth.mjs';
import { independentNode } from './helpers/independent-node.mjs';
const fixtureNode = await independentNode();
after(() => fixtureNode.cleanup());
const uid = process.getuid(), nodeUid = fixtureNode.uid;
const tenant = 'fixture-tenant', origin = 'https://wallet.example.invalid:9447';
const accounts = [{ username: 'fixture-user', wallets: [{ account: `0x${'1'.repeat(40)}`, chainId: '8453' }] }];
const sourceFiles = ['server/main.mjs', 'server/service-entry.mjs', 'server/runtime-entry.mjs', 'server/socket-path.mjs', 'server/mail-config.mjs', 'server/mail-otp.mjs', 'server/account-directory.mjs', 'server/recovery-service.mjs', 'server/registration-service.mjs', 'server/auth-service.mjs', 'server/crypto.mjs', 'server/config-validation.mjs', 'server/ca-verifier.mjs', 'server/store.mjs', 'server/operator-init.mjs', 'server/operator-activate.mjs', 'web/login-core.mjs', 'deploy/auth-xiongan/install.mjs', 'deploy/auth-xiongan/8415wallet-auth-xiongan.service', 'deploy/auth-xiongan/auth-location.nginx.conf', 'docs/AUTH-INSTALL.md', 'scripts/package/verify-auth.mjs', 'LICENSE'];
function put(root, path, data) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), data, { mode: 0o644 }); }
function syntheticPackage(root, label = '', { mailSupported = true } = {}) {
  const source = join(root, 'source'), runtime = join(root, 'runtime'); mkdirSync(source); mkdirSync(runtime);
  const files = sourceFiles.filter(path => mailSupported || path !== 'server/mail-config.mjs');
  for (const path of files) put(source, path, readFileSync(new URL(`../${path}`, import.meta.url)));
  if (label) put(source, 'docs/AUTH-INSTALL.md', readFileSync(join(source, 'docs/AUTH-INSTALL.md'), 'utf8') + `\nSynthetic upgrade marker: ${label}\n`);
  const pkg = { name: '8415wallet', version: '0.1.0', license: 'CC0-1.0', dependencies: { ethers: '^6.17.0' } };
  const lock = { name: pkg.name, lockfileVersion: 3, packages: { '': { dependencies: pkg.dependencies }, 'node_modules/ethers': { version: '6.17.0', resolved: 'https://registry.npmjs.org/ethers/-/ethers-6.17.0.tgz', integrity: 'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==' } } };
  put(source, 'package.json', JSON.stringify(pkg)); put(source, 'package-lock.json', JSON.stringify(lock));
  const git = args => execFileSync('git', args, { cwd: source, stdio: 'pipe' });
  git(['init', '-q']); git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Synthetic installation package']);
  const identity = captureAuthSource(source);
  for (const path of files) put(runtime, path, readFileSync(join(source, path)));
  const generated = runtimePackage(pkg, lock);
  put(runtime, 'package.json', JSON.stringify(generated.manifest)); put(runtime, 'package-lock.json', JSON.stringify(generated.lock));
  put(runtime, 'provenance/package.source.json', JSON.stringify(pkg)); put(runtime, 'provenance/package-lock.source.json', JSON.stringify(lock));
  put(runtime, 'node_modules/ethers/package.json', JSON.stringify({ name: 'ethers', version: '6.17.0' }));
  const release = { schema: AUTH_SCHEMA, status: AUTH_STATUS, source: identity, runtime: { node: '>=22.18.0', bundledNode: false, bundledProductionDependencies: true, credentialStoreFormat: 1 }, files: Object.fromEntries(walkAuth(runtime).map(path => [path, sha256(readFileSync(join(runtime, path)))])) };
  put(runtime, 'AUTH-RELEASE.json', JSON.stringify(release));
  put(runtime, 'SHA256SUMS', walkAuth(runtime).map(path => `${sha256(readFileSync(join(runtime, path)))}  ${path}`).join('\n') + '\n');
  return runtime;
}
async function fixture(t, packageOptions) {
  const root = await mkdtemp(join(tmpdir(), 'wallet-auth-install-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  const target = paths(join(root, 'host'), tenant);
  for (const directory of [dirname(target.root), dirname(target.config), dirname(target.state), dirname(target.unit)]) await mkdir(directory, { recursive: true, mode: 0o755 });
  const packageDirectory = syntheticPackage(root, '', packageOptions), calls = [];
  const options = { packageDirectory, node: fixtureNode.node, nodeUid, origin, tenant, accounts: structuredClone(accounts), reservedPorts: [], target, uid, reload: () => calls.push(['daemon-reload']) };
  return { root, target, packageDirectory, options, calls };
}
const vhost = `# Keep other servers and locations intact.\nserver { listen 9448 ssl; server_name other.example.invalid; }\nserver {\n listen 9447 ssl;\n server_name wallet.example.invalid;\n location /web/ { root /srv/wallet; }\n}\n`;

test('tenant paths are separate and reject traversal or interpolation', () => {
  assert.equal(paths('', 'other-tenant').config, '/etc/8415wallet-auth-other-tenant');
  for (const value of ['../tenant', '', 'UPPER', 'bad;directive', 'x'.repeat(49)]) assert.throws(() => paths('', value), /TENANT_REFUSED/);
});
test('OS-selected loopback ports honor explicit reservations', async () => {
  const port = await selectPort([]); assert.ok(port > 0 && port <= 65535);
  const next = await selectPort([port]); assert.notEqual(next, port);
  const occupied = createServer(); occupied.listen(0, '127.0.0.1'); await once(occupied, 'listening');
  try { assert.notEqual(await selectPort([]), occupied.address().port); }
  finally { await new Promise(resolve => occupied.close(resolve)); }
  await assert.rejects(selectPort([0]), /RESERVED_PORTS_REFUSED/);
});
test('reserved ports are host configuration rather than a product-wide fixed list', () => {
  const value = { origin, tenant, port: 443, statePath: '/var/lib/fixture/credentials.enc', accounts };
  assert.doesNotThrow(() => validateAuthConfig(value));
  assert.throws(() => validateAuthConfig({ ...value, reservedPorts: [443] }), /RESERVED_PORT_REFUSED/);
  assert.throws(() => validateAuthConfig({ ...value, reservedPorts: ['443'] }), /RESERVED_PORT_REFUSED/);
});
test('nginx insertion changes only the exact origin server and refuses ambiguity/existing auth', () => {
  const snippet = '/etc/8415wallet-auth-fixture-tenant/auth-location.nginx.conf';
  const modified = insertProxy(vhost, origin, snippet);
  assert.ok(modified.startsWith(vhost.slice(0, vhost.lastIndexOf('}'))));
  assert.equal(modified.split('include ').length, 2); assert.ok(modified.includes(snippet));
  assert.throws(() => insertProxy(vhost + vhost, origin, snippet), /EXACT_TLS_VHOST_REQUIRED/);
  assert.throws(() => insertProxy(vhost, 'https://missing.example.invalid:9447', snippet), /EXACT_TLS_VHOST_REQUIRED/);
  assert.throws(() => insertProxy(modified, origin, snippet), /ROUTE_ALREADY_PRESENT/);
  assert.throws(() => insertProxy(vhost.replace('location /web/', 'location ^~ /auth/'), origin, snippet), /ROUTE_ALREADY_PRESENT/);
  assert.throws(() => insertProxy(vhost, origin, '/etc/inject; bad'), /PROXY_INPUT_REFUSED/);
});
test('nginx parser ignores comments and braces in quoted directive strings', () => {
  const value = 'server { listen 9447 ssl; server_name wallet.example.invalid; add_header X-Test "} {"; # }\n }';
  assert.match(insertProxy(value, origin, '/etc/fixture/location.conf'), /8415wallet-auth-installed/);
});
test('proxy carries a protected local socket and required headers without client identity trust', () => {
  const text = nginxLocation('/run/8415wallet-auth-fixture-tenant/auth.sock'); assert.match(text, /http:\/\/unix:\/run\/8415wallet-auth-fixture-tenant\/auth.sock:/); assert.match(text, /X-Wallet-Tenant \$http_x_wallet_tenant/); assert.match(text, /X-Verified-Wallet ""/); assert.match(text, /access_log off/);
  assert.throws(() => nginxLocation(0), /SOCKET_PATH_REFUSED/);
});
test('prepare is a complete inactive immutable installation without creating credentials', async t => {
  const f = await fixture(t); const result = await prepare(f.options);
  assert.equal(result.status, 'prepared-not-activated'); assert.equal(result.secretCreated, false); assert.equal(result.serviceStarted, false);
  assert.deepEqual(f.calls, [['daemon-reload']]);
  for (const name of ['store-key', 'credentials.enc']) await assert.rejects(stat(join(name === 'store-key' ? f.target.config : f.target.state, name)), { code: 'ENOENT' });
  assert.equal((await stat(f.target.config)).mode & 0o777, 0o700);
  assert.equal((await stat(join(f.target.config, 'auth.json'))).mode & 0o777, 0o600);
  const config = JSON.parse(await readFile(join(f.target.config, 'auth.json'))); assert.equal(config.socketPath, result.socketPath); assert.equal(config.port, undefined); assert.deepEqual(config.accounts, accounts);
  const unit = await readFile(f.target.unit, 'utf8'); assert.match(unit, /server\/runtime-entry\.mjs --tenant fixture-tenant/); assert.match(unit, /LoadCredential=store-key:\/etc\/8415wallet-auth-fixture-tenant\/store-key/);
  assert.equal((await inspect({ target: f.target, uid })).summary.storeKeyPresent, false);
  await assert.rejects(prepare(f.options), /EXISTING_INSTALLATION_REFUSED/);
});
test('prepare refuses package tampering and private credential fields', async t => {
  const f = await fixture(t); f.options.accounts[0].passwordHash = 'untrusted';
  await assert.rejects(prepare(f.options), /PUBLIC_BINDINGS_ONLY/);
  await writeFile(join(f.packageDirectory, 'server/main.mjs'), '// altered');
  await assert.rejects(prepare({ ...f.options, accounts }), /FILE_DIGEST_MISMATCH/);
});
test('prepare refusal preserves a pre-existing protected file and never reloads services', async t => {
  const f = await fixture(t); await writeFile(f.target.unit, 'existing unrelated unit', { mode: 0o644 });
  await assert.rejects(prepare(f.options), /EXISTING_INSTALLATION_REFUSED/);
  assert.equal(await readFile(f.target.unit, 'utf8'), 'existing unrelated unit'); assert.deepEqual(f.calls, []);
});
test('prepare failure cleans only new non-secret configuration and keeps immutable release for inspection', async t => {
  const f = await fixture(t); await assert.rejects(prepare({ ...f.options, reload: () => { throw Error('synthetic daemon reload failure'); } }), /synthetic/);
  for (const file of [f.target.unit, join(f.target.config, 'auth.json'), join(f.target.root, 'current'), join(f.target.root, 'installation.json')]) await assert.rejects(stat(file), { code: 'ENOENT' });
});
test('check refuses altered unit/snippet and unsafe file permissions', async t => {
  const f = await fixture(t); await prepare(f.options);
  await chmod(join(f.target.config, 'auth.json'), 0o644); await assert.rejects(inspect({ target: f.target, uid }), /UNSAFE_PATH/); await chmod(join(f.target.config, 'auth.json'), 0o600);
  await writeFile(join(f.target.config, 'auth-location.nginx.conf'), 'changed'); await assert.rejects(inspect({ target: f.target, uid }), /PROXY_SNIPPET_CHANGED/);
});
test('protected path refuses symlinks and broad write access', async t => {
  const root = await mkdtemp(join(tmpdir(), 'auth-path-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'file'); await writeFile(file, 'fixture', { mode: 0o600 }); await symlink(file, join(root, 'link'));
  await assert.rejects(protect(join(root, 'link'), { uid }), /UNSAFE_PATH/); await chmod(file, 0o666); await assert.rejects(protect(file, { uid }), /UNSAFE_PATH/);
});
test('activation is refused before human credential initialization', async t => {
  const f = await fixture(t); await prepare(f.options); const site = join(f.root, 'site.conf'); await writeFile(site, vhost);
  await assert.rejects(enableProxy({ target: f.target, uid, nginxSite: site, run: () => assert.fail('must not execute a command') }), /USER_INITIALIZATION_REQUIRED/);
  assert.equal(await readFile(site, 'utf8'), vhost);
});
test('capabilities probe validates tenant and origin, not just a 200 response', async t => {
  const server = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ schema: '8415wallet-auth/1', tenant: 'wrong', origin })); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close());
  await assert.rejects(probe({ port: server.address().port, tenant, origin }), /CAPABILITIES_MISMATCH/);
});
test('enable and rollback operate on exact original site and preserve synthetic credential/state bytes', async t => {
  const f = await fixture(t); await prepare(f.options);
  const { config } = await inspect({ target: f.target, uid });
  const keyPath = join(f.target.config, 'store-key'), statePath = join(f.target.state, 'credentials.enc');
  await writeFile(keyPath, 'SYNTHETIC-NON-CREDENTIAL-FIXTURE', { mode: 0o600 }); await writeFile(statePath, 'SYNTHETIC-STATE', { mode: 0o600 });
  const server = createServer(createAuthService({ ...config, store: new MemoryCredentialStore() })); await mkdir(f.target.socketDirectory, { recursive: true, mode: 0o755 }); server.listen(config.socketPath); await once(server, 'listening'); await chmod(config.socketPath, 0o666); t.after(() => server.close());
  const site = join(f.root, 'site.conf'); await writeFile(site, vhost, { mode: 0o644 }); const calls = [];
  const enabled = await enableProxy({ target: f.target, uid, nginxSite: site, run: (file, args) => calls.push([file, args]) });
  assert.equal(enabled.capabilitiesVerified, true); assert.equal(enabled.accountEnrollmentVerified, false); assert.match(await readFile(site, 'utf8'), /8415wallet-auth-installed/);
  assert.deepEqual(calls.at(-1), ['systemctl', ['enable', f.target.unitName]]);
  const result = await rollback({ target: f.target, uid, run: (file, args) => calls.push([file, args]) });
  assert.equal(result.credentialStatePreserved, true); assert.equal(await readFile(site, 'utf8'), vhost);
  assert.equal(await readFile(keyPath, 'utf8'), 'SYNTHETIC-NON-CREDENTIAL-FIXTURE'); assert.equal(await readFile(statePath, 'utf8'), 'SYNTHETIC-STATE');
  assert.deepEqual(calls.at(-1), ['systemctl', ['disable', '--now', f.target.unitName]]);
});
test('CLI cannot bypass root requirement or accept secret-bearing positional arguments', async () => {
  if (uid !== 0) await assert.rejects(cli(['prepare', '--secret', 'synthetic']), /LINUX_ROOT_REQUIRED/);
});

test('code upgrade and rollback switch immutable releases without changing config or state', async t => {
  const f = await fixture(t); const prepared = await prepare(f.options);
  const configPath = join(f.target.config, 'auth.json'), keyPath = join(f.target.config, 'store-key'), statePath = join(f.target.state, 'credentials.enc');
  const originalConfig = await readFile(configPath);
  await writeFile(keyPath, 'SYNTHETIC-NON-CREDENTIAL', { mode: 0o600 }); await writeFile(statePath, 'SYNTHETIC-STATE', { mode: 0o600 });
  const nextRoot = join(f.root, 'next'); await mkdir(nextRoot); const nextPackage = syntheticPackage(nextRoot, 'next-reviewed-code');
  const noServices = () => assert.fail('inactive upgrade must not touch services');
  const upgraded = await upgrade({ packageDirectory: nextPackage, target: f.target, uid, run: noServices });
  assert.equal(upgraded.status, 'code-upgraded'); assert.notEqual(upgraded.sourceTree, prepared.sourceTree);
  assert.equal((await inspect({ target: f.target, uid })).summary.sourceTree, upgraded.sourceTree);
  assert.equal((await upgrade({ packageDirectory: nextPackage, target: f.target, uid, run: noServices })).status, 'already-current');
  const rolled = await rollbackCode({ target: f.target, uid, run: noServices }); assert.equal(rolled.sourceTree, prepared.sourceTree);
  assert.deepEqual(await readFile(configPath), originalConfig); assert.equal(await readFile(keyPath, 'utf8'), 'SYNTHETIC-NON-CREDENTIAL'); assert.equal(await readFile(statePath, 'utf8'), 'SYNTHETIC-STATE');
  await assert.rejects(rollbackCode({ target: f.target, uid, run: noServices }), /NO_CODE_ROLLBACK/);
});
test('interrupted operation lock prevents concurrent code upgrade without changing current', async t => {
  const f = await fixture(t); const prepared = await prepare(f.options);
  const nextRoot = join(f.root, 'next'); await mkdir(nextRoot); const nextPackage = syntheticPackage(nextRoot, 'next-reviewed-code');
  await writeFile(join(f.target.root, 'operation.lock'), 'synthetic interrupted operation', { mode: 0o600 });
  await assert.rejects(upgrade({ packageDirectory: nextPackage, target: f.target, uid, run: () => assert.fail('no services') }), { code: 'EEXIST' });
  assert.equal((await inspect({ target: f.target, uid })).summary.sourceTree, prepared.sourceTree);
});

test('unsafe candidate Node is refused before it can execute even the version check', async t => {
  const f = await fixture(t), fakeNode = join(f.root, 'node'), marker = join(f.root, 'executed');
  await writeFile(fakeNode, `#!/bin/sh\nprintf executed > '${marker}'\nprintf 'v24.19.0\\n'\n`, { mode: 0o777 }); await chmod(fakeNode, 0o777);
  await assert.rejects(prepare({ ...f.options, node: fakeNode, nodeUid: uid }), /UNSAFE_PATH/);
  await assert.rejects(stat(marker), { code: 'ENOENT' }); assert.deepEqual(f.calls, []);
});
test('auth route failure restores the original site, stops its unit and permits safe retry', async t => {
  const f = await fixture(t); await prepare(f.options); const { config } = await inspect({ target: f.target, uid });
  await writeFile(join(f.target.config, 'store-key'), 'SYNTHETIC-NON-CREDENTIAL', { mode: 0o600 });
  const server = createServer(createAuthService({ ...config, store: new MemoryCredentialStore() })); await mkdir(f.target.socketDirectory, { recursive: true, mode: 0o755 }); server.listen(config.socketPath); await once(server, 'listening'); await chmod(config.socketPath, 0o666); t.after(() => server.close());
  const site = join(f.root, 'site.conf'); await writeFile(site, vhost, { mode: 0o644 }); const calls = []; let firstValidation = true;
  await assert.rejects(enableProxy({ target: f.target, uid, nginxSite: site, run(file, args) { calls.push([file, args]); if (file === 'nginx' && firstValidation) { firstValidation = false; throw Error('SYNTHETIC_NGINX_REJECTED'); } } }), /SYNTHETIC_NGINX_REJECTED/);
  assert.equal(await readFile(site, 'utf8'), vhost); assert.equal((await stat(site)).mode & 0o777, 0o644);
  assert.deepEqual(calls.at(-1), ['systemctl', ['disable', '--now', f.target.unitName]]);
  assert.equal((await inspect({ target: f.target, uid })).summary.status, 'prepared-not-activated');
  await assert.rejects(stat(join(f.target.root, 'operation.lock')), { code: 'ENOENT' });
});

test('another tenant auth route in the same file does not block the exact target vhost', () => {
  const first = 'server { listen 9448 ssl; server_name other.example.invalid; location ^~ /auth/ { proxy_pass http://unix:/run/other/auth.sock:; } }\n';
  const target = vhost.slice(vhost.indexOf('server {\n'));
  assert.match(insertProxy(first + target, origin, '/etc/fixture/auth.conf'), /include \/etc\/fixture\/auth.conf/);
});
test('a safe-mode nginx leaf beneath an unsafe parent is refused before touching service or file', async t => {
  const f = await fixture(t); await prepare(f.options); await writeFile(join(f.target.config, 'store-key'), 'SYNTHETIC-NON-CREDENTIAL', { mode: 0o600 });
  const directory = join(f.root, 'unsafe'); await mkdir(directory); await chmod(directory, 0o777);
  const site = join(directory, 'site.conf'); await writeFile(site, vhost, { mode: 0o644 });
  await assert.rejects(enableProxy({ target: f.target, uid, nginxSite: site, run: () => assert.fail('must not start') }), /UNSAFE_ANCESTOR/);
  assert.equal(await readFile(site, 'utf8'), vhost);
});
test('selected nginx includes must be reviewed and existing included auth endpoints are refused', async t => {
  const f = await fixture(t), include = join(f.root, 'existing.conf');
  const text = vhost.replace(' location /web/', ` include ${include};\n location /web/`);
  await writeFile(include, 'add_header X-Test safe;\n', { mode: 0o644 });
  assert.throws(() => insertProxy(text, origin, '/etc/fixture/auth.conf'), /INCLUDES_REQUIRE_REVIEW/);
  const reviewed = await inspectNginxIncludes(text, origin, uid);
  assert.match(insertProxy(text, origin, '/etc/fixture/auth.conf', reviewed), /8415wallet-auth-installed/);
  await writeFile(include, 'location = /auth/password { return 403; }\n');
  await assert.rejects(inspectNginxIncludes(text, origin, uid), /INCLUDED_AUTH_ROUTE_PRESENT/);
});
test('nginx include traversal, relative paths, variables and cycles fail closed', async t => {
  const f = await fixture(t), include = join(f.root, 'nested.conf');
  for (const path of ['relative.conf', '$variable', '/etc/../tmp/file.conf']) {
    const text = vhost.replace(' location /web/', ` include ${path};\n location /web/`);
    await assert.rejects(inspectNginxIncludes(text, origin, uid), /INCLUDE_REVIEW_REQUIRED/);
  }
  await writeFile(include, `include ${include};\n`, { mode: 0o644 });
  const text = vhost.replace(' location /web/', ` include ${include};\n location /web/`);
  await assert.rejects(inspectNginxIncludes(text, origin, uid), /INCLUDE_CYCLE_OR_DUPLICATE/);
});
test('installed dependency inventory cannot be re-signed locally under the same source tree', async t => {
  const f = await fixture(t); await prepare(f.options); const { receipt } = await inspect({ target: f.target, uid });
  const installed = receipt.runtime, extra = 'node_modules/ethers/changed-fixture.js';
  await writeFile(join(installed, extra), 'export const synthetic = true;\n', { mode: 0o644 });
  const releasePath = join(installed, 'AUTH-RELEASE.json'), release = JSON.parse(await readFile(releasePath));
  release.files[extra] = sha256(await readFile(join(installed, extra)));
  await writeFile(releasePath, JSON.stringify(release));
  await writeFile(join(installed, 'SHA256SUMS'), walkAuth(installed).filter(path => path !== 'SHA256SUMS').map(path => `${sha256(readFileSync(join(installed, path)))}  ${path}`).join('\n') + '\n');
  await assert.rejects(inspect({ target: f.target, uid }), /RELEASE_MANIFEST_CHANGED/);
});

test('linked candidate Node paths remain refused before execution', async t => {
  const f = await fixture(t), candidate = join(f.root, 'node'), marker = join(f.root, 'executed');
  await writeFile(candidate, `#!/bin/sh\nprintf executed > '${marker}'\nprintf 'v24.19.0\\n'\n`, { mode: 0o755 });
  const alias = join(f.root, 'node-symlink'); await symlink(candidate, alias);
  await assert.rejects(prepare({ ...f.options, node: alias, nodeUid: uid }), /UNSAFE_PATH/);
  await link(candidate, join(f.root, 'node-hardlink'));
  await assert.rejects(prepare({ ...f.options, node: candidate, nodeUid: uid }), /UNSAFE_PATH/);
  await assert.rejects(stat(marker), { code: 'ENOENT' }); assert.deepEqual(f.calls, []);
});

test('mail preparation and stopped-unit updates emit only inert reviewed settings and preserve credentials', async t => {
  const f = await fixture(t); await prepare(f.options);
  const baseUnit = await readFile(f.target.unit), statePath = join(f.target.state, 'credentials.enc');
  await writeFile(statePath, 'SYNTHETIC-REGISTERED-STATE', { mode: 0o600 });
  const mail = { transport: 'smtp', port: 465, addresses: ['192.0.2.40'] };
  const before = await readFile(join(f.target.config, 'auth.json'));
  for (const active of ['active', 'activating', 'deactivating', 'failed', 'unknown']) {
    await assert.rejects(configureMail({ target: f.target, uid, mail, serviceState: () => active }), /AUTH_MAIL_STOP_UNIT_REQUIRED/);
    assert.deepEqual(await readFile(join(f.target.config, 'auth.json')), before);
  }
  const result = await configureMail({ target: f.target, uid, mail, serviceState: async () => {
    assert.ok((await stat(join(f.target.config, 'mail-config.lock'))).isFile()); return 'inactive';
  } });
  assert.equal(result.serviceStarted, false); assert.equal(result.networkPermissionsChanged, false); assert.equal(result.credentialsRead, false);
  assert.deepEqual((await inspect({ target: f.target, uid })).config.mail, mail);
  const review = await readFile(result.reviewFile, 'utf8'); assert.match(review, /INERT REVIEW ONLY/); assert.match(review, /IPAddressAllow=192\.0\.2\.40\/32/);
  assert.deepEqual(await readFile(f.target.unit), baseUnit); assert.equal(await readFile(statePath, 'utf8'), 'SYNTHETIC-REGISTERED-STATE');
  assert.deepEqual(f.calls, [['daemon-reload']]);
  await assert.rejects(stat(join(f.target.config, 'mail-config.lock')), { code: 'ENOENT' });
  for (const name of ['smtp-username', 'smtp-password']) await assert.rejects(stat(join(f.target.config, name)), { code: 'ENOENT' });
  const changed = { ...mail, addresses: ['192.0.2.41'] };
  await configureMail({ target: f.target, uid, mail: changed, serviceState: () => 'inactive' });
  assert.match(await readFile(result.reviewFile, 'utf8'), /192\.0\.2\.41\/32/); assert.doesNotMatch(await readFile(result.reviewFile, 'utf8'), /192\.0\.2\.40/);
  await configureMail({ target: f.target, uid, mail: { transport: 'disabled' }, serviceState: () => 'inactive' });
  assert.deepEqual((await inspect({ target: f.target, uid })).config.mail, { transport: 'disabled' });
  assert.doesNotMatch(await readFile(result.reviewFile, 'utf8'), /smtp-username|AF_INET/);
});

test('mail config and inert review tampering refuse inspection without any system change', async t => {
  const f = await fixture(t); await prepare({ ...f.options, mail: { transport: 'smtp', port: 465, addresses: ['192.0.2.40'] } });
  const review = join(f.target.config, 'smtp-override.review.conf');
  await writeFile(review, 'IPAddressAllow=any\n', { mode: 0o600 });
  await assert.rejects(inspect({ target: f.target, uid }), /AUTH_MAIL_REVIEW_CHANGED/);
  assert.deepEqual(f.calls, [['daemon-reload']]);
});

test('legacy package preparation omits unknown mail config and refuses SMTP before installation', async t => {
  const f = await fixture(t, { mailSupported: false });
  await assert.rejects(prepare({ ...f.options, mail: { transport: 'smtp', port: 465, addresses: ['192.0.2.40'] } }), /AUTH_MAIL_RUNTIME_UPGRADE_REQUIRED/);
  assert.deepEqual(f.calls, []); await assert.rejects(stat(join(f.target.config, 'auth.json')), { code: 'ENOENT' });
  await prepare(f.options);
  const config = JSON.parse(await readFile(join(f.target.config, 'auth.json')));
  assert.equal(Object.hasOwn(config, 'mail'), false);
  await assert.rejects(configureMail({ target: f.target, uid, mail: { transport: 'disabled' }, serviceState: () => 'inactive' }), /AUTH_MAIL_RUNTIME_UPGRADE_REQUIRED/);
  assert.equal(Object.hasOwn((await inspect({ target: f.target, uid })).config, 'mail'), false);
});
