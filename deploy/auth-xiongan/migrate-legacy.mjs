/** Bounded PR58 import. Run only by an authorized host operator; never initializes/rekeys an account. */
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { open, readFile, lstat, realpath, readlink, readdir, mkdir, cp, unlink, symlink, rename } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { createHash, createDecipheriv, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { paths, protect, protectedAncestors, protectedPackage, protectedNode, runtimeVersion, ensureDirectory, exclusive, replace, nginxLocation, nginxTokens, selectedNginxServer, includePaths, authRouteExists, inspectNginxIncludes, waitForProbe, inspect, switchRelease } from './install.mjs';
import { validateAuthConfig } from '../../server/config-validation.mjs';
import { MemoryCredentialStore } from '../../server/store.mjs';
import { createAccountDirectory } from '../../server/account-directory.mjs';
import { smtpReviewOverride } from '../../server/mail-config.mjs';
import { verifyAuthDirectory, AUTH_STATE_SEMANTICS, authStateSemantics } from '../../scripts/package/verify-auth.mjs';
const hash = b => createHash('sha256').update(b).digest('hex');
const blob = b => createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');
const fail = code => { throw Error(code); };
const exists = async p => { try { return await lstat(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const runHost = (file, args) => execFileSync(file, args, { encoding: 'utf8', env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' }, stdio: ['ignore', 'pipe', 'pipe'] });
export const LEGACY_COMMIT = 'a942495d6b6913a0026a6c2a8ce27eed9e9098f2';
// Exact public source objects, obtained from the reviewed PR58 merge. No private configuration is embedded.
export const LEGACY_FILES = Object.freeze({
  'server/main.mjs': '46d79aa1bf2b7580de26050a7650ded1913ae1bb',
  'server/auth-service.mjs': 'b90d72f8e1fc4aaae97c5c3692e83944cd3a2e1c',
  'server/crypto.mjs': 'ffb086e38b6b4c081dff02759356a94e96405772',
  'server/config-validation.mjs': 'e1a84a91480b7befbb279e37dcf56f88949f8b6a',
  'server/store.mjs': '2b51f24f4c5ad733f1457ff7790c85ac7270f84a',
  'server/ca-verifier.mjs': '96ea8e1ed84ab1ba3adaaeb7fa8894495d832132',
  'server/service-entry.mjs': '0613c0601f141d955ae2b1f52b45c2ecf57d5643',
  'web/login-core.mjs': '3a81c7708f3ee4f256fae2c4e6c505f271c9cc8e',
  'package.json': 'f261a1f283a495d9821216c4dd36a060668c7dda',
  'package-lock.json': '656b4961df27b215d209f16a4bf78023e0492104',
  'deploy/auth-xiongan/8415wallet-auth-xiongan.service': '7c90aae57f8b14aa364b4969b0e65000a9eecddd',
  'deploy/auth-xiongan/auth-location.nginx.conf': 'c01d1eb3461c0e3a2145728435c4a903f47e0c79'
});
const unitLines = text => text.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#')).join('\n');
const normalized = text => text.replace(/#[^\n]*/g, '').replace(/\s+/g, ' ').trim();
const safePath = p => typeof p === 'string' && /^\/[A-Za-z0-9_./-]+$/.test(p) && resolve(p) === p;
async function privateBytes(path, uid, limit) {
  await protectedAncestors(path, uid); await protect(path, { uid, privateMode: true });
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await file.stat();
    if (!s.isFile() || s.nlink !== 1 || s.uid !== uid || s.gid !== uid || (s.mode & 0o7077) || s.size > limit) fail('AUTH_LEGACY_PRIVATE_FILE_REFUSED');
    return await file.readFile();
  } finally { await file.close(); }
}
async function publicBytes(path, uid) {
  await protectedAncestors(path, uid); await protect(path, { uid });
  return readFile(path);
}
function configFor(config, target) {
  const { port, ...rest } = config;
  return { ...rest, socketPath: join(target.socketDirectory, 'auth.sock'), mail: { transport: 'disabled' } };
}
async function serviceProperties(run, target) {
  const text = String(await run('systemctl', ['show', target.unitName, '--property=FragmentPath,DropInPaths,ActiveState,SubState,MainPID,UnitFileState']));
  const p = Object.fromEntries(text.trim().split('\n').map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
  if (p.FragmentPath !== target.unit || p.DropInPaths !== '' || !['enabled', 'disabled'].includes(p.UnitFileState) || !['active', 'inactive'].includes(p.ActiveState) || !/^\d+$/.test(p.MainPID ?? '')) fail('AUTH_LEGACY_SERVICE_OVERRIDE_OR_STATE_REFUSED');
  return p;
}
async function stopped(run, target) {
  const p = await serviceProperties(run, target);
  if (p.ActiveState !== 'inactive' || p.SubState !== 'dead' || p.MainPID !== '0') fail('AUTH_LEGACY_STOP_NOT_CONFIRMED');
}
async function assertSnapshot(path, expected, uid, secret = false) {
  const bytes = secret ? await privateBytes(path, uid, 5_000_000) : await publicBytes(path, uid);
  try { if (hash(bytes) !== expected) fail('AUTH_LEGACY_SNAPSHOT_CHANGED'); } finally { if (secret) bytes.fill(0); }
}
async function credentials(target, uid, allowEmptyState, config) {
  const keyPath = join(target.config, 'store-key'), statePath = join(target.state, 'credentials.enc');
  const key = await privateBytes(keyPath, uid, 66); let state;
  try {
    if (!/^[a-fA-F0-9]{64}\n?$/.test(key.toString('utf8'))) fail('AUTH_LEGACY_KEY_FORMAT_REFUSED');
    if (await exists(statePath)) {
      state = await privateBytes(statePath, uid, 4 * 1024 * 1024);
      let envelope; try { envelope = JSON.parse(state); } catch { fail('AUTH_LEGACY_STATE_FORMAT_REFUSED'); }
      if (!envelope || Object.keys(envelope).sort().join(',') !== 'data,iv,tag,version' || envelope.version !== 1 ||
        ![envelope.iv, envelope.tag, envelope.data].every(v => typeof v === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(v)) ||
        Buffer.from(envelope.iv, 'base64').length !== 12 || Buffer.from(envelope.tag, 'base64').length !== 16) fail('AUTH_LEGACY_STATE_FORMAT_REFUSED');
      let plain, keyBuffer;
      try {
        keyBuffer = Buffer.from(key.toString('utf8').trim(), 'hex');
        const decipher = createDecipheriv('aes-256-gcm', keyBuffer, Buffer.from(envelope.iv, 'base64'));
        decipher.setAAD(Buffer.from('8415wallet-auth-store/1')); decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
        plain = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
        const value = JSON.parse(plain);
        if (!value || typeof value !== 'object' || Array.isArray(value)) fail('AUTH_LEGACY_STATE_AUTHENTICATION_REFUSED');
        const directoryKey = `@registration:${config.tenant}`;
        const names = new Set(config.accounts.map(a => a.username));
        for (const row of value[directoryKey]?.records ?? []) if (row?.ordinaryAccount) names.add(row.username);
        if (Object.keys(value).some(k => k !== directoryKey && ![...names].some(name => k === `${config.tenant}:${name}`))) fail('AUTH_LEGACY_STATE_TENANT_REFUSED');
        // Validate existing registration/email indexes without changing a single credential byte.
        const directory = createAccountDirectory({ tenant: config.tenant, accounts: config.accounts, store: new MemoryCredentialStore(value), users: new Map() });
        await directory.ready;
      } catch (error) { if (error.message === 'AUTH_LEGACY_STATE_TENANT_REFUSED') throw error; fail('AUTH_LEGACY_STATE_AUTHENTICATION_REFUSED'); }
      finally { plain?.fill(0); keyBuffer?.fill(0); }

    } else if (!allowEmptyState) fail('AUTH_LEGACY_EMPTY_STATE_REQUIRES_CONFIRMATION');
    return { keySha256: hash(key), stateSha256: state ? hash(state) : null };
  } finally { key.fill(0); state?.fill(0); }
}
/** Count executed include edges, not nginx's deduplicated file dump. */
export async function inspectLegacyNginx({ run, uid, nginxSite, legacyProxy, origin }) {
  const text = String(await run('nginx', ['-T']));
  if (Buffer.byteLength(text) > 4_000_000) fail('AUTH_LEGACY_NGINX_GRAPH_LIMIT');
  const sections = [...text.matchAll(/^# configuration file (\/[^\n]+):\r?$/gm)];
  if (!sections.length || sections.length > 128) fail('AUTH_LEGACY_NGINX_DUMP_REQUIRED');
  const files = new Map(), aliases = new Map();
  async function canonical(path) {
    if (!safePath(path)) fail('AUTH_LEGACY_NGINX_INCLUDE_REFUSED');
    await protectedAncestors(path, uid);
    const leaf = await lstat(path);
    if (leaf.uid !== uid || leaf.gid !== uid) fail('AUTH_LEGACY_NGINX_ALIAS_REFUSED');
    const actual = await realpath(path); await protectedAncestors(actual, uid); await protect(actual, { uid });
    return actual;
  }
  for (let i = 0; i < sections.length; i++) {
    const path = sections[i][1], actual = await canonical(path);
    const body = text.slice(sections[i].index + sections[i][0].length + 1, sections[i + 1]?.index ?? text.length).trimEnd();
    const disk = (await readFile(actual, 'utf8')).trimEnd();
    if (disk !== body || aliases.has(path) || files.has(actual) && files.get(actual) !== body) fail('AUTH_LEGACY_NGINX_DUMP_CHANGED');
    aliases.set(path, actual); files.set(actual, body);
  }
  const references = [], edges = []; let visits = 0;
  async function visit(path, stack = []) {
    if (++visits > 512 || stack.length > 16 || stack.includes(path)) fail('AUTH_LEGACY_NGINX_GRAPH_LIMIT');
    const body = files.get(path); if (body === undefined) fail('AUTH_LEGACY_NGINX_UNLOADED_INCLUDE');
    const tokens = nginxTokens(body);
    for (let i = 0; i < tokens.length; i++) if (tokens[i].value === 'include') {
      if (!tokens[i + 1] || tokens[i + 2]?.value !== ';') fail('AUTH_LEGACY_NGINX_INCLUDE_REFUSED');
      const pattern = tokens[i + 1].value;
      if (!/^\/[A-Za-z0-9_./*?-]+$/.test(pattern) || pattern.includes('**') || /[*?]/.test(dirname(pattern)) || resolve(dirname(pattern)) !== dirname(pattern)) fail('AUTH_LEGACY_NGINX_INCLUDE_REFUSED');
      await protectedAncestors(pattern, uid); await protect(dirname(pattern), { uid, directory: true });
      const base = pattern.slice(pattern.lastIndexOf('/') + 1);
      const regex = new RegExp('^' + [...base].map(c => c === '*' ? '.*' : c === '?' ? '.' : /[A-Za-z0-9_-]/.test(c) ? c : `\\${c}`).join('') + '$');
      const matches = /[*?]/.test(base) ? (await readdir(dirname(pattern))).filter(n => regex.test(n)).sort().map(n => join(dirname(pattern), n)) : [pattern];
      for (const match of matches) {
        const child = await canonical(match);
        if (!files.has(child)) fail('AUTH_LEGACY_NGINX_UNLOADED_INCLUDE');
        edges.push([path, pattern, match, child]);
        if (child === legacyProxy) references.push({ from: path, offset: tokens[i].index, end: tokens[i + 2].index + 1 });
        await visit(child, [...stack, path]);
      }
      i += 2;
    }
  }
  await visit(aliases.get(sections[0][1]));
  if (references.length !== 1 || references[0].from !== nginxSite) fail('AUTH_LEGACY_SHARED_PROXY_REFUSED');
  const site = files.get(nginxSite), block = selectedNginxServer(site, origin);
  if (references[0].offset <= block.start || references[0].offset >= block.end || authRouteExists(site.slice(block.start, block.end))) fail('AUTH_LEGACY_EXACT_PROXY_INCLUDE_REQUIRED');
  await inspectNginxIncludes(site.slice(0, references[0].offset) + site.slice(references[0].end), origin, uid);
  return { files: Object.fromEntries([...files].filter(([path]) => path !== legacyProxy).sort(([a], [b]) => a.localeCompare(b)).map(([path, body]) => [path, hash(body)])), edges };
}
function bindOptions(o) {
  const target = o.target ?? paths('', o.tenant);
  // PR58 entry has fixed paths and tenant. This is not a tenant cloning tool.
  if (o.tenant !== 'xiongan' || target.tenant !== 'xiongan' || o.legacyService !== target.unitName ||
      o.legacyConfig !== join(target.config, 'auth.json') || o.legacyKey !== join(target.config, 'store-key') || o.legacyState !== join(target.state, 'credentials.enc') ||
      ![o.legacySource, o.legacyProxy, o.nginxSite, o.node, o.packageDirectory].every(safePath) || o.legacyProxy === o.nginxSite || o.sourceCommit !== LEGACY_COMMIT) fail('AUTH_LEGACY_EXPLICIT_BINDING_REQUIRED');
  return target;
}
/** Nonmutating inspection; summaries never contain paths, keys, ciphertext, account identities or their hashes. */
export async function inspectLegacy(o) {
  const target = bindOptions(o), uid = o.uid ?? 0, run = o.run ?? runHost;
  for (const dir of [target.root, target.config, target.state]) { await protectedAncestors(dir, uid); await protect(dir, { uid, directory: true, privateMode: dir !== target.root }); }
  if (await exists(join(target.root, 'installation.json')) || await exists(join(target.root, 'operation.lock'))) fail('AUTH_LEGACY_EXISTING_RECEIPT_OR_TRANSITION_REFUSED');
  if (await exists(join(target.root, 'legacy-migration.json'))) {
    const previous = JSON.parse(await privateBytes(join(target.root, 'legacy-migration.json'), uid, 1_000_000));
    if (previous.schema !== '8415wallet-legacy-migration/1' || previous.phase !== 'restored-before-start' || previous.candidateStartAttempted) fail('AUTH_LEGACY_EXISTING_RECEIPT_OR_TRANSITION_REFUSED');
  }
  await protectedPackage(o.legacySource, uid);
  for (const [path, expected] of Object.entries(LEGACY_FILES)) if (blob(await readFile(join(o.legacySource, path))) !== expected) fail('AUTH_LEGACY_UNSUPPORTED_SOURCE');
  const current = await lstat(join(target.root, 'current'));
  if (!current.isSymbolicLink() || current.uid !== uid || current.gid !== uid || await realpath(join(target.root, 'current')) !== o.legacySource) fail('AUTH_LEGACY_CURRENT_SOURCE_REFUSED');
  const nodeIdentity = await protectedNode(o.node, uid, o.nodeUid ?? 0), nodeVersion = runtimeVersion(o.node);
  if (JSON.stringify(await protectedNode(o.node, uid, o.nodeUid ?? 0)) !== JSON.stringify(nodeIdentity)) fail('AUTH_NODE_CHANGED');
  const unit = await publicBytes(target.unit, uid);
  let expectedUnit = await readFile(join(o.legacySource, 'deploy/auth-xiongan/8415wallet-auth-xiongan.service'), 'utf8');
  expectedUnit = expectedUnit.replace('ExecStart=/usr/bin/node', `ExecStart=${o.node}`).replace('WorkingDirectory=/opt/8415wallet-auth-xiongan/current', `WorkingDirectory=${join(target.root, 'current')}`);
  if (unitLines(unit.toString()) !== unitLines(expectedUnit)) fail('AUTH_LEGACY_UNIT_UNSUPPORTED');
  const service = await serviceProperties(run, target);
  const configBytes = await privateBytes(o.legacyConfig, uid, 1_000_000);
  const config = JSON.parse(configBytes); validateAuthConfig(config);
  if (config.tenant !== o.tenant || config.origin !== o.origin || !o.origin.startsWith('https://') || config.statePath !== o.legacyState ||
      !Number.isInteger(config.port) || config.port === 443 || Object.keys(config).some(k => !['origin', 'tenant', 'port', 'statePath', 'accounts'].includes(k))) fail('AUTH_LEGACY_CONFIG_UNSUPPORTED');
  const proxy = await publicBytes(o.legacyProxy, uid), site = await publicBytes(o.nginxSite, uid);
  const expectedProxy = (await readFile(join(o.legacySource, 'deploy/auth-xiongan/auth-location.nginx.conf'), 'utf8')).replace('127.0.0.1:18417', `127.0.0.1:${config.port}`);
  if (normalized(proxy.toString()) !== normalized(expectedProxy)) fail('AUTH_LEGACY_PROXY_UNSUPPORTED');
  const nginxGraph = await inspectLegacyNginx({ run, uid, nginxSite: o.nginxSite, legacyProxy: o.legacyProxy, origin: config.origin });
  await protectedPackage(o.packageDirectory, uid); const release = await verifyAuthDirectory(o.packageDirectory);
  if (release.runtime.legacyImportProtocol !== 1 || release.runtime.credentialStoreFormat !== 1 || authStateSemantics(release) !== AUTH_STATE_SEMANTICS) fail('AUTH_LEGACY_FORWARD_PACKAGE_REQUIRED');
  for (const path of ['auth-location.nginx.conf', 'smtp-override.review.conf', 'mail-config.lock', 'migration-config.lock']) if (await exists(join(target.config, path))) fail('AUTH_LEGACY_TARGET_CONFLICT');
  const credentialHashes = await credentials(target, uid, o.allowEmptyState === true, config);
  return { target, config, configBytes, unit, proxy, site, nginxGraph, service, release, nodeIdentity, nodeVersion, credentialHashes,
    summary: { status: 'supported-legacy-awaiting-operator-confirmation', sourceCommit: LEGACY_COMMIT, tenant: o.tenant, emptyState: credentialHashes.stateSha256 === null, forwardOnlyAfterCandidateStart: true, accountCount: config.accounts.length } };
}
async function writeJournal(path, j) { await replace(path, JSON.stringify(j, null, 2) + '\n'); }
async function backupFile(source, dest, uid, secret = false) {
  const bytes = secret ? await privateBytes(source, uid, 5_000_000) : await publicBytes(source, uid);
  try { await exclusive(dest, bytes); await assertSnapshot(dest, hash(bytes), uid, true); return hash(bytes); }
  finally { if (secret) bytes.fill(0); }
}
async function durableDirectory(path) { const f = await open(path, constants.O_RDONLY | constants.O_DIRECTORY); try { await f.sync(); } finally { await f.close(); } }
async function durableTree(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await durableTree(child);
    else { const f = await open(child, constants.O_RDONLY | constants.O_NOFOLLOW); try { await f.sync(); } finally { await f.close(); } }
  }
  await durableDirectory(path);
}
async function stateUnchanged(j, target, uid) {
  await assertSnapshot(join(target.config, 'store-key'), j.credentials.keySha256, uid, true);
  const state = join(target.state, 'credentials.enc');
  if (j.credentials.stateSha256 === null) { if (await exists(state)) fail('AUTH_LEGACY_STATE_CHANGED'); }
  else await assertSnapshot(state, j.credentials.stateSha256, uid, true);
}
async function installCandidate(o, before, journal) {
  const { target, config, release, nodeIdentity, nodeVersion } = before, uid = o.uid ?? 0;
  await exclusive(join(target.config, 'migration-config.lock'), 'Migration configuration is incomplete. Resume through the reviewed importer.\n'); await durableDirectory(target.config); await o.checkpoint?.('fence-written');
  const destination = join(target.root, 'releases', release.source.tree);
  await ensureDirectory(join(target.root, 'releases'), 0o755, uid);
  if (await exists(destination)) { await protectedPackage(destination, uid); assert.deepEqual(await verifyAuthDirectory(destination), release, 'AUTH_LEGACY_RELEASE_CONFLICT'); }
  else await cp(o.packageDirectory, destination, { recursive: true, force: false, errorOnExist: true, dereference: false });
  await protectedPackage(destination, uid);
  assert.deepEqual(await verifyAuthDirectory(destination), release, 'AUTH_LEGACY_PACKAGE_CHANGED');
  await durableTree(destination); await durableDirectory(dirname(destination)); await o.checkpoint?.('release-copied');
  let unit = await readFile(join(destination, 'deploy/auth-xiongan/8415wallet-auth-xiongan.service'), 'utf8');
  unit = unit.replace('ExecStart=/usr/bin/node', `ExecStart=${o.node}`).replace('server/service-entry.mjs', 'server/runtime-entry.mjs --tenant xiongan')
    .replace('# PREPARATION ONLY / NOT INSTALLED / NOT ACTIVATED.', '# Imported from verified PR58; existing credentials preserved.')
    .replace('StateDirectoryMode=0700', 'StateDirectoryMode=0700\nRuntimeDirectory=8415wallet-auth-xiongan\nRuntimeDirectoryMode=0755')
    .replace('RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX', 'RestrictAddressFamilies=AF_UNIX')
    .replace('ReadWritePaths=/var/lib/8415wallet-auth-xiongan', 'ReadWritePaths=/var/lib/8415wallet-auth-xiongan /run/8415wallet-auth-xiongan');
  const nextConfig = configFor(config, target), location = nginxLocation(nextConfig.socketPath), review = smtpReviewOverride('xiongan', { transport: 'disabled' });
  const receipt = { schema: '8415wallet-auth-install/1', sourceTree: release.source.tree, runtime: destination, node: o.node, nodeVersion, nodeSha256: nodeIdentity.sha256, nodeUid: o.nodeUid ?? 0,
    releaseManifestSha256: hash(await readFile(join(destination, 'AUTH-RELEASE.json'))), origin: config.origin, tenant: config.tenant, socketPath: nextConfig.socketPath, reservedPorts: [], unitSha256: hash(unit), status: 'legacy-migration-in-progress',
    mail: { transport: 'disabled' }, mailReviewSha256: hash(review), legacyImport: { schema: '8415wallet-legacy-import/1', sourceCommit: LEGACY_COMMIT, forwardOnly: true } };
  journal.candidate = { configSha256: hash(JSON.stringify(nextConfig, null, 2) + '\n'), unitSha256: hash(unit), runtime: destination, proxySha256: hash(location), receipt };
  await writeJournal(join(target.root, 'legacy-migration.json'), journal);
  await exclusive(join(target.config, 'auth-location.nginx.conf'), location); await o.checkpoint?.('snippet-written');
  await exclusive(join(target.config, 'smtp-override.review.conf'), review);
  await replace(join(target.config, 'auth.json'), JSON.stringify(nextConfig, null, 2) + '\n'); await o.checkpoint?.('config-written');
  await replace(target.unit, unit); await durableDirectory(dirname(target.unit)); await durableDirectory(target.config); await o.checkpoint?.('unit-written');
  await switchRelease(target, destination); await o.checkpoint?.('current-switched');
  await exclusive(join(target.root, 'installation.json'), JSON.stringify(receipt, null, 2) + '\n'); await o.checkpoint?.('receipt-written');
  return nextConfig;
}
async function restoreBeforeStart(j, target, uid, run) {
  if (j.candidateStartAttempted) fail('AUTH_LEGACY_DOWNGRADE_REFUSED');
  await stopped(run, target); await stateUnchanged(j, target, uid);
  for (const [name, path] of [['config', join(target.config, 'auth.json')], ['unit', target.unit], ['proxy', j.legacyProxy]]) {
    await assertSnapshot(join(j.backup, name), j.before[name], uid, true);
    const current = hash(await readFile(path));
    const expectedCandidate = name === 'config' ? j.candidate?.configSha256 : name === 'unit' ? j.candidate?.unitSha256 : j.candidate?.proxySha256;
    if (![j.before[name], expectedCandidate].includes(current)) fail('AUTH_LEGACY_CHANGED_RECOVERY_REQUIRED');
    await replace(path, await readFile(join(j.backup, name)));
  }
  const current = await readlink(join(target.root, 'current'));
  if (![j.legacyLink, j.candidate?.runtime].includes(current)) fail('AUTH_LEGACY_CHANGED_RECOVERY_REQUIRED');
  await switchRelease(target, j.legacyLink);
  for (const path of [join(target.root, 'installation.json'), join(target.config, 'auth-location.nginx.conf'), join(target.config, 'smtp-override.review.conf')]) if (await exists(path)) await unlink(path);
  for (const dir of [target.root, target.config, dirname(target.unit), dirname(j.legacyProxy)]) await durableDirectory(dir);
  const fence = join(target.config, 'migration-config.lock'); if (await exists(fence)) { await unlink(fence); await durableDirectory(target.config); }
  await run('systemctl', ['daemon-reload']); await run('nginx', ['-t']); await run('systemctl', ['reload', 'nginx']);
  if (j.wasActive) await run('systemctl', ['start', target.unitName]);
}
async function finishForward(j, target, uid, run, probe) {
  const journalPath = join(target.root, 'legacy-migration.json');
  await assertSnapshot(j.nginxSite, j.before.site, uid);
  await assertSnapshot(join(target.config, 'store-key'), j.credentials.keySha256, uid, true);
  const managed = await inspect({ target, uid });
  if (managed.receipt.sourceTree !== j.candidate.receipt.sourceTree || !['legacy-migration-in-progress', 'proxy-enabled'].includes(managed.receipt.status)) fail('AUTH_LEGACY_CANDIDATE_CHANGED');
  await assertSnapshot(join(target.config, 'auth.json'), j.candidate.configSha256, uid, true);
  const currentProxy = hash(await publicBytes(j.legacyProxy, uid));
  if (![j.before.proxy, j.candidate.proxySha256].includes(currentProxy)) fail('AUTH_LEGACY_PROXY_CHANGED');
  assert.deepEqual(await inspectLegacyNginx({ run, uid, nginxSite: j.nginxSite, legacyProxy: j.legacyProxy, origin: j.origin }), j.nginxGraph, 'AUTH_LEGACY_NGINX_GRAPH_CHANGED');
  await credentials(target, uid, j.credentials.stateSha256 === null, managed.config);
  for (const dir of [target.root, target.config, target.state, dirname(target.unit)]) await durableDirectory(dir);
  await run('systemctl', ['daemon-reload']);
  // Durable before invoking start: a failed or interrupted start can have advanced counters.
  j.candidateStartAttempted = true; j.phase = 'candidate-start-attempted'; await writeJournal(journalPath, j); await durableDirectory(target.root);
  const fence = join(target.config, 'migration-config.lock');
  if (await exists(fence)) { await protect(fence, { uid, privateMode: true }); await unlink(fence); await durableDirectory(target.config); }
  await run('systemctl', ['start', target.unitName]); await probe(managed.config);
  await replace(j.legacyProxy, nginxLocation(managed.config.socketPath)); await durableDirectory(dirname(j.legacyProxy));
  await run('nginx', ['-t']); await run('systemctl', ['reload', 'nginx']);
  j.phase = 'complete';
  await replace(join(target.root, 'installation.json'), JSON.stringify({ ...managed.receipt, status: 'proxy-enabled' }, null, 2) + '\n');
  await writeJournal(journalPath, j); await durableDirectory(target.root);
  await unlink(join(target.root, 'operation.lock')); await durableDirectory(target.root);
  return { status: 'legacy-imported-proxy-enabled', tenant: target.tenant, sourceTree: managed.receipt.sourceTree, credentialsPreserved: true, backupVerified: true, forwardOnly: true, mailTransport: 'disabled' };
}
export async function migrateLegacy(o) {
  if (o.confirm !== 'MIGRATE-PR58-FORWARD-ONLY') fail('AUTH_LEGACY_CONFIRMATION_REQUIRED');
  const before = await inspectLegacy(o), { target } = before, uid = o.uid ?? 0, run = o.run ?? runHost;
  const lock = join(target.root, 'operation.lock'), journalPath = join(target.root, 'legacy-migration.json');
  const backup = join(target.root, await exists(join(target.root, 'legacy-backup')) ? `legacy-backup-${randomBytes(8).toString('hex')}` : 'legacy-backup');
  await exclusive(lock, 'Legacy migration in progress. Use migrate-legacy.mjs resume; never remove this lock or restore ciphertext.\n');
  let j, stateLock;
  try {
    await run('systemctl', ['stop', target.unitName]); await stopped(run, target);
    // A leftover/live writer lock is never inferred stale, even after systemctl says inactive.
    stateLock = await open(`${o.legacyState}.lock`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const second = await credentials(target, uid, o.allowEmptyState === true, before.config);
    // State can legitimately advance before stop, so the stopped snapshot is authoritative.
    await assertSnapshot(o.legacyConfig, hash(before.configBytes), uid, true);
    await assertSnapshot(target.unit, hash(before.unit), uid); await assertSnapshot(o.nginxSite, hash(before.site), uid); await assertSnapshot(o.legacyProxy, hash(before.proxy), uid);
    const pendingBackup = join(target.root, `legacy-backup.pending-${randomBytes(8).toString('hex')}`);
    await mkdir(pendingBackup, { mode: 0o700 });
    const saved = {};
    for (const [name, path, secret] of [['config', o.legacyConfig, true], ['unit', target.unit, false], ['proxy', o.legacyProxy, false], ['site', o.nginxSite, false], ['key', o.legacyKey, true], ...(second.stateSha256 ? [['state', o.legacyState, true]] : [])]) saved[name] = await backupFile(path, join(pendingBackup, name), uid, secret);
    await o.checkpoint?.('snapshot-copied');
    if (saved.key !== second.keySha256 || (saved.state ?? null) !== second.stateSha256) fail('AUTH_LEGACY_BACKUP_MISMATCH');
    j = { schema: '8415wallet-legacy-migration/1', tenant: target.tenant, phase: 'snapshot-verified', candidateStartAttempted: false, backup,
      legacySource: o.legacySource, legacyLink: await readlink(join(target.root, 'current')), legacyProxy: o.legacyProxy, nginxSite: o.nginxSite,
      wasActive: before.service.ActiveState === 'active', nginxGraph: before.nginxGraph, origin: before.config.origin, credentials: second, before: saved };
    await durableDirectory(pendingBackup);
    const publish = { ...j, phase: 'snapshot-publish-pending', pendingBackup };
    if (await exists(journalPath)) await writeJournal(journalPath, publish);
    else await exclusive(journalPath, JSON.stringify(publish, null, 2) + '\n');
    await durableDirectory(target.root);
    await rename(pendingBackup, backup); await durableDirectory(target.root);
    await writeJournal(journalPath, j); await durableDirectory(target.root);
    await installCandidate(o, before, j);
    await stateUnchanged(j, target, uid);
    await stateLock.close(); stateLock = null; await unlink(`${o.legacyState}.lock`);
    return await finishForward(j, target, uid, run, o.probe ?? waitForProbe);
  } catch (error) {
    if (stateLock) { await stateLock.close(); stateLock = null; await unlink(`${o.legacyState}.lock`); }
    if (j?.candidateStartAttempted) {
      try { await run('systemctl', ['stop', target.unitName]); } catch { /* Retain the durable forward-only marker. */ }
      fail('AUTH_LEGACY_FORWARD_RECOVERY_REQUIRED');
    }
    if (j) {
      try { await restoreBeforeStart(j, target, uid, run); j.phase = 'restored-before-start'; await writeJournal(journalPath, j); await unlink(lock); }
      catch { fail('AUTH_LEGACY_PRESTART_RECOVERY_REQUIRED'); }
    } else {
      // No candidate code/config was installed. Do not remove another process's state lock.
      await unlink(lock); // Original unit remains stopped if the writer state is uncertain.
    }
    throw error;
  }
}
/** Retry only the verified generation-2 candidate. No old state/code restore, key entry, or account creation. */
export async function resumeLegacy({ tenant, confirm, target = paths('', tenant), uid = 0, run = runHost, probe = waitForProbe }) {
  if (tenant !== 'xiongan' || target.tenant !== tenant || confirm !== 'MIGRATE-PR58-FORWARD-ONLY') fail('AUTH_LEGACY_CONFIRMATION_REQUIRED');
  for (const path of [target.root, target.config, target.state]) { await protectedAncestors(path, uid); await protect(path, { uid, directory: true, privateMode: path !== target.root }); }
  const journalPath = join(target.root, 'legacy-migration.json');
  const j = JSON.parse(await privateBytes(journalPath, uid, 1_000_000));
  if (j.schema !== '8415wallet-legacy-migration/1' || j.tenant !== tenant || dirname(j.backup ?? '') !== target.root || !/^legacy-backup(?:-[a-f0-9]{16})?$/.test(basename(j.backup ?? '')) || ![j.legacyProxy, j.nginxSite].every(safePath)) fail('AUTH_LEGACY_JOURNAL_REFUSED');
  const resumeLock = join(target.root, 'legacy-resume.lock');
  await exclusive(resumeLock, 'A migration recovery command is running. Never infer a stale lock.\n');
  try {
  if (j.phase === 'restored-before-start' && !await exists(join(target.root, 'operation.lock'))) return { status: 'legacy-restored-before-candidate-start', credentialsPreserved: true, retryMigration: true };
  if (j.phase === 'snapshot-publish-pending' && !j.candidateStartAttempted) {
    if (!safePath(j.pendingBackup) || dirname(j.pendingBackup) !== target.root || !/^legacy-backup\.pending-[a-f0-9]{16}$/.test(basename(j.pendingBackup))) fail('AUTH_LEGACY_JOURNAL_REFUSED');
    const pending = await exists(j.backup) ? j.backup : j.pendingBackup;
    for (const [name, expected] of Object.entries(j.before)) await assertSnapshot(join(pending, name), expected, uid, true);
    if (pending !== j.backup) await rename(pending, j.backup);
    j.phase = 'snapshot-verified'; delete j.pendingBackup; await writeJournal(journalPath, j); await durableDirectory(target.root);
  }
  if (j.phase === 'complete') {
    const result = await inspect({ target, uid });
    if (result.receipt.status !== 'proxy-enabled') fail('AUTH_LEGACY_RECEIPT_CHANGED');
    if (await exists(join(target.root, 'operation.lock'))) await unlink(join(target.root, 'operation.lock'));
    return { status: 'already-imported', credentialsPreserved: true };
  }
  await protect(join(target.root, 'operation.lock'), { uid, privateMode: true });
  if (!j.candidateStartAttempted) {
    if (!['snapshot-verified', 'restored-before-start'].includes(j.phase)) fail('AUTH_LEGACY_PRESTART_REVIEW_REQUIRED');
    await run('systemctl', ['stop', target.unitName]); await stopped(run, target);
    if (await exists(join(target.state, 'credentials.enc.lock'))) fail('AUTH_LEGACY_WRITER_LOCK_REVIEW_REQUIRED');
    await restoreBeforeStart(j, target, uid, run);
    j.phase = 'restored-before-start'; await writeJournal(journalPath, j);
    await unlink(join(target.root, 'operation.lock'));
    return { status: 'legacy-restored-before-candidate-start', credentialsPreserved: true, backupVerified: true };
  }
  if (!j.candidate || j.phase !== 'candidate-start-attempted') fail('AUTH_LEGACY_PRESTART_REVIEW_REQUIRED');
  // Backups are validated but never restored. Current state may contain consumed values/new account fields.
  for (const [name, expected] of Object.entries(j.before)) await assertSnapshot(join(j.backup, name), expected, uid, true);
  await run('systemctl', ['stop', target.unitName]); await stopped(run, target);
  if (await exists(join(target.state, 'credentials.enc.lock'))) fail('AUTH_LEGACY_WRITER_LOCK_REVIEW_REQUIRED');
  try { return await finishForward(j, target, uid, run, probe); }
  catch { try { await run('systemctl', ['stop', target.unitName]); } catch {} fail('AUTH_LEGACY_FORWARD_RECOVERY_REQUIRED'); }
  } finally { await unlink(resumeLock); }
}
export async function cli(args, input = process.stdin, output = process.stdout) {
  const [command, ...rest] = args;
  if (command === '--help') { output.write('check|migrate --package DIR --node ABSOLUTE_NODE --tenant xiongan --origin EXACT_HTTPS_ORIGIN --source-commit PR58_MERGE --legacy-source EXACT_DIRECTORY --legacy-service EXACT_UNIT --legacy-config EXACT_FILE --legacy-key EXACT_FILE --legacy-state EXACT_FILE --legacy-proxy EXACT_INCLUDED_FILE --nginx-site EXACT_SITE [--allow-empty-state yes]\nresume --tenant xiongan\nMigration/resume require a trusted terminal and explicit forward-only approval. No secret arguments. Never run initialization for existing accounts.\n'); return; }
  if (process.platform !== 'linux' || process.getuid?.() !== 0 || process.geteuid?.() !== 0) fail('AUTH_INSTALL_LINUX_ROOT_REQUIRED');
  if (process.env.NODE_OPTIONS || process.env.NODE_PATH || process.env.CREDENTIALS_DIRECTORY || Object.keys(process.env).some(k => k.startsWith('WALLET_AUTH_'))) fail('AUTH_AMBIENT_CREDENTIAL_REFUSED');
  const options = {};
  for (let i = 0; i < rest.length; i += 2) { if (!/^--[a-z-]+$/.test(rest[i] ?? '') || !rest[i + 1] || Object.hasOwn(options, rest[i])) fail('AUTH_INSTALL_ARGUMENT_REFUSED'); options[rest[i]] = rest[i + 1]; }
  const required = ['package', 'node', 'tenant', 'origin', 'source-commit', 'legacy-source', 'legacy-service', 'legacy-config', 'legacy-key', 'legacy-state', 'legacy-proxy', 'nginx-site'];
  const allowed = command === 'resume' ? ['tenant'] : [...required, 'allow-empty-state'];
  if (!['check', 'migrate', 'resume'].includes(command) || Object.keys(options).some(k => !allowed.includes(k.slice(2))) || (command !== 'resume' && required.some(k => !options[`--${k}`])) || options['--allow-empty-state'] && options['--allow-empty-state'] !== 'yes') fail('AUTH_INSTALL_ARGUMENT_REFUSED');
  const o = Object.fromEntries(Object.entries(options).map(([k, v]) => [k.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase()), v]));
  o.packageDirectory = o.package; delete o.package; o.allowEmptyState = o.allowEmptyState === 'yes';
  if (command === 'check') { output.write(JSON.stringify((await inspectLegacy(o)).summary) + '\n'); return; }
  if (!input.isTTY || !output.isTTY) fail('AUTH_TRUSTED_TERMINAL_REQUIRED');
  const prompt = createInterface({ input, output });
  try {
    o.confirm = await prompt.question('This stops only the specified service, privately backs up existing credentials, and changes its systemd/proxy transport. After the new runtime starts, recovery is forward-only; old code/ciphertext will NEVER be restored. Approved to proceed? Type MIGRATE-PR58-FORWARD-ONLY: ');
    output.write(JSON.stringify(command === 'resume' ? await resumeLegacy(o) : await migrateLegacy(o)) + '\n');
  } finally { prompt.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) cli(process.argv.slice(2)).catch(error => { console.error(/^[A-Z0-9_]+$/.test(error.message) ? error.message : 'AUTH_LEGACY_MIGRATION_FAILED'); process.exitCode = 1; });
