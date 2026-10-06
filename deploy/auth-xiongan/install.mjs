/** Bounded auth-runtime installation. No credential generation or service activation in prepare. */
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { open, lstat, realpath, mkdir, readFile, readdir, writeFile, cp, symlink, readlink, rename, unlink } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { protectSocket } from '../../server/socket-path.mjs';
import { validateAuthConfig } from '../../server/config-validation.mjs';
import { validateMailConfig, smtpReviewOverride } from '../../server/mail-config.mjs';
import { verifyAuthDirectory } from '../../scripts/package/verify-auth.mjs';
import { authStateSemantics, validateAuthStateTransition } from '../../scripts/package/verify-auth.mjs';
export const ROOT = '/opt/8415wallet-auth-xiongan';
export const CONFIG = '/etc/8415wallet-auth-xiongan';
export const STATE = '/var/lib/8415wallet-auth-xiongan';
export const UNIT = '8415wallet-auth-xiongan.service';
const digest = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw Error(code); };
const exists = async path => { try { return await lstat(path); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
export function paths(prefix = '', tenant = 'xiongan') {
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(tenant)) fail('AUTH_TENANT_REFUSED');
  const name = `8415wallet-auth-${tenant}`;
  return { root: join(prefix, '/opt', name), config: join(prefix, '/etc', name), state: join(prefix, '/var/lib', name), unit: join(prefix, '/etc/systemd/system', `${name}.service`), unitName: `${name}.service`, socketDirectory: join(prefix, '/run', name), tenant };
}
export async function protect(path, { uid = 0, gid = uid, directory = false, privateMode = false } = {}) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || stat.uid !== uid || stat.gid !== gid || (stat.mode & (privateMode ? 0o7077 : 0o7022)) ||
      (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) || await realpath(path) !== resolve(path)) fail('AUTH_INSTALL_UNSAFE_PATH');
  return stat;
}
async function protectedAncestors(path, uid = 0) {
  for (let directory = dirname(path); ; directory = dirname(directory)) {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || ![0, uid].includes(stat.uid) || stat.gid !== stat.uid || (stat.mode & 0o6000) ||
        ((stat.mode & 0o022) && !((stat.mode & 0o1000) && [0, uid].includes(stat.uid))) || await realpath(directory) !== directory) fail('AUTH_INSTALL_UNSAFE_ANCESTOR');
    if (directory === dirname(directory)) break;
  }
}
async function protectedPackage(path, uid) {
  await protect(path, { uid, directory: true }); await protectedAncestors(path, uid);
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await protectedPackage(child, uid);
    else await protect(child, { uid });
  }
}
async function ensureDirectory(path, mode, uid) {
  await protectedAncestors(path, uid);
  const found = await exists(path);
  if (!found) { await protect(dirname(path), { uid, directory: true }); await mkdir(path, { mode }); }
  await protect(path, { uid, directory: true, privateMode: mode === 0o700 });
}
async function exclusive(path, content, mode = 0o600) {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
}
async function replace(path, content) {
  const pending = `${path}.pending`;
  const existing = await lstat(path);
  if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1) fail('AUTH_REPLACE_PATH_REFUSED');
  await exclusive(pending, content, existing.mode & 0o777);
  try { await rename(pending, path); } catch (e) { await unlink(pending).catch(() => {}); throw e; }
}
function ports(value) {
  if (!Array.isArray(value) || value.some(p => !Number.isInteger(p) || p < 1 || p > 65535) || new Set(value).size !== value.length) fail('AUTH_RESERVED_PORTS_REFUSED');
  return value;
}
export async function selectPort(reservedPorts) {
  ports(reservedPorts);
  for (let attempt = 0; attempt < 32; attempt++) {
    const server = createServer();
    await new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
    const port = server.address().port;
    await new Promise((yes, no) => server.close(error => error ? no(error) : yes()));
    if (!reservedPorts.includes(port)) return port;
  }
  fail('AUTH_FREE_PORT_UNAVAILABLE');
}
export function nginxLocation(socketPath) {
  if (typeof socketPath !== 'string' || !/^\/[A-Za-z0-9_./-]+\.sock$/.test(socketPath) || resolve(socketPath) !== socketPath) fail('AUTH_SOCKET_PATH_REFUSED');
  return `# Generated for the existing matching TLS server. No new listener.\nlocation ^~ /auth/ {\n    proxy_pass http://unix:${socketPath}:;\n    proxy_set_header Host $http_host;\n    proxy_set_header X-Wallet-Tenant $http_x_wallet_tenant;\n    proxy_set_header Origin $http_origin;\n    proxy_set_header X-Wallet-CSRF $http_x_wallet_csrf;\n    proxy_set_header X-Authenticated-User "";\n    proxy_set_header X-Verified-Wallet "";\n    proxy_connect_timeout 3s;\n    proxy_read_timeout 15s;\n    proxy_send_timeout 15s;\n    client_max_body_size 100k;\n    proxy_buffering off;\n    proxy_cache off;\n    access_log off;\n}\n`;
}
function nginxTokens(text) {
  const re = /#[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[{};]|[^\s{};#"']+/g;
  return [...text.matchAll(re)].filter(token => !token[0].startsWith('#')).map(token => ({ value: token[0].replace(/^(["'])(.*)\1$/, '$2'), index: token.index }));
}
function selectedNginxServer(text, origin) {
  const url = new URL(origin), port = url.port || '443';
  if (url.protocol !== 'https:') fail('AUTH_PROXY_INPUT_REFUSED');
  const stack = [], blocks = []; let pending = [];
  for (const token of nginxTokens(text)) {
    const value = token.value;
    if (value === '{') { stack.push({ header: pending, start: token.index, statements: [] }); pending = []; }
    else if (value === ';') { if (stack.length) stack.at(-1).statements.push(pending); pending = []; }
    else if (value === '}') { const block = stack.pop(); if (!block) fail('AUTH_NGINX_SYNTAX_REFUSED'); block.end = token.index; blocks.push(block); pending = []; }
    else pending.push(value);
  }
  if (stack.length) fail('AUTH_NGINX_SYNTAX_REFUSED');
  const matches = blocks.filter(block => block.header.length === 1 && block.header[0] === 'server' &&
    block.statements.some(statement => statement[0] === 'server_name' && statement.slice(1).includes(url.hostname)) &&
    block.statements.some(statement => statement[0] === 'listen' && statement.includes('ssl') && statement.slice(1).some(value => value === port || value.endsWith(`:${port}`))));
  if (matches.length !== 1) fail('AUTH_EXACT_TLS_VHOST_REQUIRED');
  return matches[0];
}
function authRouteExists(text) { return /8415wallet-auth-installed|location\s+(?:[^\n{]*\s)?[^\n{]*\/auth(?:[\s/"'{]|$)/.test(text); }
function includePaths(text) {
  const tokens = nginxTokens(text), found = [];
  for (let i = 0; i < tokens.length; i++) if (tokens[i].value === 'include') {
    if (!tokens[i + 1] || tokens[i + 2]?.value !== ';') fail('AUTH_NGINX_INCLUDE_REVIEW_REQUIRED');
    found.push(tokens[i + 1].value); i += 2;
  }
  return found;
}
export async function inspectNginxIncludes(text, origin, uid = 0) {
  const block = selectedNginxServer(text, origin), scope = text.slice(block.start, block.end);
  const fingerprints = new Map(); let size = Buffer.byteLength(scope);
  async function visit(pattern, depth = 0) {
    if (depth > 8 || !/^\/[A-Za-z0-9_./*?-]+$/.test(pattern) || pattern.includes('**') || resolve(dirname(pattern)) !== dirname(pattern) || /[*?]/.test(dirname(pattern))) fail('AUTH_NGINX_INCLUDE_REVIEW_REQUIRED');
    await protectedAncestors(pattern, uid); await protect(dirname(pattern), { uid, directory: true });
    const basename = pattern.slice(pattern.lastIndexOf('/') + 1);
    const regex = new RegExp('^' + [...basename].map(char => char === '*' ? '.*' : char === '?' ? '.' : /[A-Za-z0-9_-]/.test(char) ? char : `\\${char}`).join('') + '$');
    const matches = /[*?]/.test(basename) ? (await readdir(dirname(pattern))).filter(name => regex.test(name)).map(name => join(dirname(pattern), name)) : [pattern];
    for (const path of matches) {
      if (fingerprints.has(path)) fail('AUTH_NGINX_INCLUDE_CYCLE_OR_DUPLICATE');
      await protect(path, { uid }); const stat = await lstat(path); size += stat.size;
      if (size > 1_000_000 || fingerprints.size >= 64) fail('AUTH_NGINX_INCLUDE_LIMIT');
      const content = await readFile(path, 'utf8'); fingerprints.set(path, digest(content));
      if (authRouteExists(content)) fail('AUTH_PROXY_INCLUDED_AUTH_ROUTE_PRESENT');
      for (const child of includePaths(content)) await visit(child, depth + 1);
    }
  }
  for (const path of includePaths(scope)) await visit(path);
  return { scopeSha256: digest(scope), files: Object.fromEntries(fingerprints) };
}
export function insertProxy(text, origin, includePath, reviewedIncludes) {
  if (!/^\/[A-Za-z0-9_./-]+$/.test(includePath)) fail('AUTH_PROXY_INPUT_REFUSED');
  const block = selectedNginxServer(text, origin), scope = text.slice(block.start, block.end);
  if (authRouteExists(scope)) fail('AUTH_PROXY_ROUTE_ALREADY_PRESENT');
  if (includePaths(scope).length && reviewedIncludes?.scopeSha256 !== digest(scope)) fail('AUTH_NGINX_INCLUDES_REQUIRE_REVIEW');
  return text.slice(0, block.end) + `    # 8415wallet-auth-installed\n    include ${includePath};\n` + text.slice(block.end);
}
function runtimeVersion(node) {
  if (!/^\/[A-Za-z0-9_./-]+$/.test(node)) fail('AUTH_NODE_PATH_REFUSED');
  const version = execFileSync(node, ['--version'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LANG: 'C' } }).trim();
  const m = /^v(22|24)\.(\d+)\.(\d+)$/.exec(version);
  if (!m || (m[1] === '22' && Number(m[2]) < 18)) fail('AUTH_NODE_22_18_OR_24_REQUIRED');
  return version;
}
async function protectedNode(node, uid, nodeUid = uid) {
  const binary = await protect(node, { uid: nodeUid });
  for (let path = dirname(node); ; path = dirname(path)) {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || ![0, uid, nodeUid].includes(stat.uid) || stat.gid !== stat.uid || (stat.mode & 0o6000) || ((stat.mode & 0o022) && !((stat.mode & 0o1000) && [0, uid].includes(stat.uid))) || await realpath(path) !== path) fail('AUTH_NODE_ANCESTOR_REFUSED');
    if (path === dirname(path)) break;
  }
  return { dev: binary.dev, ino: binary.ino, sha256: digest(await readFile(node)) };
}
export async function prepare({ packageDirectory, node, origin, tenant, accounts, reservedPorts, mail: requestedMail, target, uid = 0, nodeUid = 0, reload = () => execFileSync('systemctl', ['daemon-reload']) }) {
  target ??= paths('', tenant);
  if (target.tenant !== tenant) fail('AUTH_TARGET_TENANT_MISMATCH');
  ports(reservedPorts);
  const mail = validateMailConfig(requestedMail);
  await protectedPackage(packageDirectory, uid);
  const release = await verifyAuthDirectory(packageDirectory);
  const mailSupported = Object.hasOwn(release.files, 'server/mail-config.mjs');
  if (!mailSupported && mail.transport !== 'disabled') fail('AUTH_MAIL_RUNTIME_UPGRADE_REQUIRED');
  const binary = await protectedNode(node, uid, nodeUid);
  const version = runtimeVersion(node);
  const after = await protectedNode(node, uid, nodeUid);
  if (JSON.stringify(after) !== JSON.stringify(binary)) fail('AUTH_NODE_CHANGED');
  for (const [path, mode] of [[target.root, 0o755], [target.config, 0o700], [target.state, 0o700]]) await ensureDirectory(path, mode, uid);
  await protectedAncestors(target.unit, uid);
  const receiptPath = join(target.root, 'installation.json');
  for (const path of [receiptPath, target.unit, join(target.root, 'current'), join(target.config, 'auth.json'), join(target.config, 'store-key'), join(target.state, 'credentials.enc'), join(target.state, 'credentials.enc.lock')]) {
    if (await exists(path)) fail('AUTH_EXISTING_INSTALLATION_REFUSED');
  }
  if (accounts.some(a => Object.keys(a).some(k => !['username', 'wallets'].includes(k)))) fail('AUTH_PUBLIC_BINDINGS_ONLY');
  const socketPath = join(target.socketDirectory, 'auth.sock');
  const config = { origin, tenant, socketPath, reservedPorts, statePath: join(target.state, 'credentials.enc'), accounts, ...(mailSupported ? { mail } : {}) };
  const counts = validateAuthConfig(config);
  const tree = release.source.tree;
  if (!/^[a-f0-9]{40}$/.test(tree)) fail('AUTH_SOURCE_TREE_REFUSED');
  await ensureDirectory(join(target.root, 'releases'), 0o755, uid);
  const destination = join(target.root, 'releases', tree);
  if (await exists(destination)) fail('AUTH_RELEASE_ALREADY_PRESENT');
  // Copy only an already verified package. Reverify the destination before making it current.
  await cp(packageDirectory, destination, { recursive: true, errorOnExist: true, force: false, dereference: false });
  assert.deepEqual(await verifyAuthDirectory(destination, { expectedTree: tree }), release, 'AUTH_PACKAGE_CHANGED_DURING_INSTALL');
  let unit = await readFile(join(destination, 'deploy/auth-xiongan/8415wallet-auth-xiongan.service'), 'utf8');
  unit = unit.replaceAll('8415wallet-auth-xiongan', `8415wallet-auth-${tenant}`).replace('server/service-entry.mjs', `server/runtime-entry.mjs --tenant ${tenant}`);
  unit = unit.replace('# PREPARATION ONLY / NOT INSTALLED / NOT ACTIVATED.', '# Installed inactive. User must provision credentials before start.').replace('ExecStart=/usr/bin/node', `ExecStart=${node}`);
  unit = unit.replace('StateDirectoryMode=0700', `StateDirectoryMode=0700\nRuntimeDirectory=8415wallet-auth-${tenant}\nRuntimeDirectoryMode=0755`).replace('RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX', 'RestrictAddressFamilies=AF_UNIX').replace(`ReadWritePaths=/var/lib/8415wallet-auth-${tenant}`, `ReadWritePaths=/var/lib/8415wallet-auth-${tenant} /run/8415wallet-auth-${tenant}`);
  // Production paths remain fixed. Fixture preparation does not run this unit.
  const created = [];
  try {
    await exclusive(join(target.config, 'auth.json'), JSON.stringify(config, null, 2) + '\n'); created.push(join(target.config, 'auth.json'));
    await exclusive(join(target.config, 'auth-location.nginx.conf'), nginxLocation(socketPath)); created.push(join(target.config, 'auth-location.nginx.conf'));
    const mailReview = smtpReviewOverride(tenant, mail);
    await exclusive(join(target.config, 'smtp-override.review.conf'), mailReview); created.push(join(target.config, 'smtp-override.review.conf'));
    await symlink(destination, join(target.root, 'current')); created.push(join(target.root, 'current'));
    await exclusive(target.unit, unit, 0o644); created.push(target.unit);
    const receipt = { schema: '8415wallet-auth-install/1', sourceTree: tree, runtime: destination, node, nodeVersion: version, nodeSha256: binary.sha256, nodeUid, releaseManifestSha256: digest(await readFile(join(destination, 'AUTH-RELEASE.json'))), origin, tenant, socketPath, reservedPorts, unitSha256: digest(unit), status: 'prepared-not-activated' };
    Object.assign(receipt, { mail, mailReviewSha256: digest(mailReview) });
    await exclusive(receiptPath, JSON.stringify(receipt, null, 2) + '\n'); created.push(receiptPath);
    await reload();
    return { status: receipt.status, sourceTree: tree, socketPath, ...counts, secretCreated: false, serviceStarted: false };
  } catch (error) {
    for (const path of created.reverse()) await unlink(path).catch(() => {});
    // Keep the verified immutable release for inspection. Never remove a credential/state file.
    throw error;
  }
}
export async function inspect({ target = paths(), uid = 0 } = {}) {
  for (const dir of [target.root, target.config, target.state]) { await protectedAncestors(dir, uid); await protect(dir, { uid, directory: true, privateMode: dir !== target.root }); }
  await protectedAncestors(target.unit, uid);
  const receiptPath = join(target.root, 'installation.json'); await protect(receiptPath, { uid, privateMode: true });
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  if (receipt.schema !== '8415wallet-auth-install/1' || receipt.runtime !== join(target.root, 'releases', receipt.sourceTree)) fail('AUTH_RECEIPT_REFUSED');
  if ((await protectedNode(receipt.node, uid, uid === 0 ? 0 : receipt.nodeUid)).sha256 !== receipt.nodeSha256) fail('AUTH_NODE_CHANGED');
  if (await readlink(join(target.root, 'current')) !== receipt.runtime) fail('AUTH_CURRENT_RELEASE_CHANGED');
  await verifyAuthDirectory(receipt.runtime, { expectedTree: receipt.sourceTree });
  if (digest(await readFile(join(receipt.runtime, 'AUTH-RELEASE.json'))) !== receipt.releaseManifestSha256) fail('AUTH_RELEASE_MANIFEST_CHANGED');
  const location = join(target.config, 'auth-location.nginx.conf'); await protect(location, { uid, privateMode: true });
  if (await readFile(location, 'utf8') !== nginxLocation(receipt.socketPath)) fail('AUTH_PROXY_SNIPPET_CHANGED');
  await protect(target.unit, { uid }); if (digest(await readFile(target.unit)) !== receipt.unitSha256) fail('AUTH_UNIT_CHANGED');
  const configPath = join(target.config, 'auth.json'); await protect(configPath, { uid, privateMode: true });
  const config = JSON.parse(await readFile(configPath, 'utf8')); const counts = validateAuthConfig(config);
  assert.deepEqual(validateMailConfig(config.mail), validateMailConfig(receipt.mail), 'AUTH_MAIL_CONFIG_RECEIPT_MISMATCH');
  if (receipt.mailReviewSha256 !== undefined) {
    const reviewPath = join(target.config, 'smtp-override.review.conf'); await protect(reviewPath, { uid, privateMode: true });
    const review = await readFile(reviewPath, 'utf8');
    if (digest(review) !== receipt.mailReviewSha256 || review !== smtpReviewOverride(receipt.tenant, receipt.mail)) fail('AUTH_MAIL_REVIEW_CHANGED');
  }
  if (config.origin !== receipt.origin || config.tenant !== receipt.tenant || config.socketPath !== receipt.socketPath || config.port !== undefined || config.socketPath !== join(target.socketDirectory, 'auth.sock') || config.statePath !== join(target.state, 'credentials.enc')) fail('AUTH_CONFIG_RECEIPT_MISMATCH');
  // Presence and protection only: never read credential bytes in installer/preflight output.
  const key = await exists(join(target.config, 'store-key'));
  if (key) await protect(join(target.config, 'store-key'), { uid, privateMode: true });
  return { receipt, config, summary: { status: receipt.status, sourceTree: receipt.sourceTree, socketPath: config.socketPath, ...counts, storeKeyPresent: Boolean(key), storeKeyContentsChecked: false } };
}
export async function probe(config) {
  if (config.socketPath) await protectSocket(config.socketPath);
  return new Promise((yes, no) => {
    const req = request({ ...(config.socketPath ? { socketPath: config.socketPath } : { host: '127.0.0.1', port: config.port }), path: '/auth/capabilities', headers: { Host: new URL(config.origin).host, 'X-Wallet-Tenant': config.tenant }, timeout: 5000 }, response => {
      let body = ''; response.on('data', chunk => { body += chunk; if (body.length > 10000) req.destroy(Error('AUTH_PROBE_RESPONSE_TOO_LARGE')); });
      response.on('end', () => { try { const value = JSON.parse(body); if (response.statusCode !== 200 || value.schema !== '8415wallet-auth/1' || value.tenant !== config.tenant || value.origin !== config.origin) fail('AUTH_CAPABILITIES_MISMATCH'); yes({ capabilitiesVerified: true }); } catch (e) { no(e); } });
    });
    req.on('timeout', () => req.destroy(Error('AUTH_PROBE_TIMEOUT'))); req.on('error', no); req.end();
  });
}
async function waitForProbe(config) {
  const deadline = Date.now() + 10000; let last;
  do { try { return await probe(config); } catch (error) { last = error; await new Promise(resolve => setTimeout(resolve, 200)); } } while (Date.now() < deadline);
  throw last;
}
async function withOperationLock(target, uid, action) {
  await protectedAncestors(target.root, uid); await protect(target.root, { uid, directory: true });
  const lock = join(target.root, 'operation.lock');
  await exclusive(lock, 'Installation transition in progress. Inspect any interrupted operation before removing.\n');
  let retain = false;
  try { return await action(); }
  catch (error) { retain = /RECOVERY_REQUIRED/.test(error.message); throw error; }
  finally { if (!retain) await unlink(lock); }
}
export async function enableProxy(options) {
  const target = options.target ?? paths();
  return withOperationLock(target, options.uid ?? 0, () => enableProxyLocked({ ...options, target }));
}
async function enableProxyLocked({ nginxSite, target, uid = 0, run = (file, args) => execFileSync(file, args, { stdio: 'pipe' }) }) {
  const { receipt, config, summary } = await inspect({ target, uid });
  if (!summary.storeKeyPresent || receipt.status !== 'prepared-not-activated') fail('AUTH_USER_INITIALIZATION_REQUIRED');
  await protectedAncestors(nginxSite, uid); await protect(nginxSite, { uid });
  const original = await readFile(nginxSite, 'utf8');
  const includes = await inspectNginxIncludes(original, config.origin, uid);
  const candidate = insertProxy(original, config.origin, join(target.config, 'auth-location.nginx.conf'), includes);
  const backup = join(target.root, 'nginx-site.before'); await exclusive(backup, original);
  const before = { ...receipt }, receiptPath = join(target.root, 'installation.json');
  Object.assign(receipt, { status: 'enabling-proxy', nginxSite, nginxBeforeSha256: digest(original), nginxAfterSha256: digest(candidate) });
  let changed = false;
  try {
    await replace(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
    await run('systemctl', ['start', target.unitName]); await waitForProbe(config);
    assert.deepEqual(await inspectNginxIncludes(original, config.origin, uid), includes, 'AUTH_NGINX_INCLUDES_CHANGED');
    if (digest(await readFile(nginxSite)) !== digest(original)) fail('AUTH_NGINX_CHANGED_MANUAL_REVIEW_REQUIRED');
    await replace(nginxSite, candidate); changed = true;
    await run('nginx', ['-t']); await run('systemctl', ['reload', 'nginx']);
    await run('systemctl', ['enable', target.unitName]);
    receipt.status = 'proxy-enabled';
    await replace(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
    return { status: receipt.status, socketPath: receipt.socketPath, capabilitiesVerified: true, accountEnrollmentVerified: false };
  } catch (error) {
    let recoveryRequired = false;
    try {
      if (changed) {
        if (digest(await readFile(nginxSite)) !== digest(candidate)) fail('AUTH_NGINX_CHANGED_MANUAL_REVIEW_REQUIRED');
        await replace(nginxSite, original); await run('nginx', ['-t']); await run('systemctl', ['reload', 'nginx']);
      }
    } catch { recoveryRequired = true; }
    try { await run('systemctl', ['disable', '--now', target.unitName]); } catch { recoveryRequired = true; }
    if (recoveryRequired) fail('AUTH_PROXY_RECOVERY_REQUIRED');
    await replace(receiptPath, JSON.stringify(before, null, 2) + '\n');
    await unlink(backup); throw error;
  }
}
export async function rollback(options = {}) {
  const target = options.target ?? paths();
  return withOperationLock(target, options.uid ?? 0, () => rollbackLocked({ ...options, target }));
}
async function rollbackLocked({ target, uid = 0, run = (file, args) => execFileSync(file, args, { stdio: 'pipe' }) }) {
  const { receipt } = await inspect({ target, uid });
  if (['proxy-enabled', 'enabling-proxy'].includes(receipt.status)) {
    await protectedAncestors(receipt.nginxSite, uid); await protect(receipt.nginxSite, { uid });
    const current = await readFile(receipt.nginxSite);
    if (![receipt.nginxAfterSha256, receipt.nginxBeforeSha256].includes(digest(current))) fail('AUTH_NGINX_CHANGED_MANUAL_REVIEW_REQUIRED');
    const backupPath = join(target.root, 'nginx-site.before'); await protect(backupPath, { uid, privateMode: true });
    const before = await readFile(backupPath);
    if (digest(before) !== receipt.nginxBeforeSha256) fail('AUTH_BACKUP_CHANGED');
    await replace(receipt.nginxSite, before);
    try { await run('nginx', ['-t']); await run('systemctl', ['reload', 'nginx']); }
    catch (error) { await replace(receipt.nginxSite, current); throw error; }
  }
  await run('systemctl', ['disable', '--now', target.unitName]);
  receipt.status = 'rolled-back-preserving-credentials';
  await replace(join(target.root, 'installation.json'), JSON.stringify(receipt, null, 2) + '\n');
  return { status: receipt.status, credentialStatePreserved: true, publicWalletUnchanged: true };
}
async function switchRelease(target, runtime) {
  const pending = join(target.root, 'current.pending');
  await symlink(runtime, pending);
  try { await rename(pending, join(target.root, 'current')); }
  catch (error) { await unlink(pending).catch(() => {}); throw error; }
}
/** Code-only transition. Credential data is never read, copied, restored or changed. */
export async function upgrade(options) {
  const target = options.target ?? paths();
  return withOperationLock(target, options.uid ?? 0, () => upgradeLocked({ ...options, target }));
}
export async function rollbackCode(options = {}) {
  const target = options.target ?? paths();
  return withOperationLock(target, options.uid ?? 0, () => rollbackCodeLocked({ ...options, target }));
}
async function upgradeLocked({ packageDirectory, target = paths(), uid = 0, run = (file, args) => execFileSync(file, args, { stdio: 'pipe' }) }) {
  const { receipt, config } = await inspect({ target, uid });
  if (!['proxy-enabled', 'prepared-not-activated'].includes(receipt.status)) fail('AUTH_UPGRADE_STATE_REFUSED');
  const oldRelease = await verifyAuthDirectory(receipt.runtime, { expectedTree: receipt.sourceTree });
  await protectedPackage(packageDirectory, uid);
  const next = await verifyAuthDirectory(packageDirectory);
  if (next.runtime.credentialStoreFormat !== 1 || oldRelease.runtime.credentialStoreFormat !== 1) fail('AUTH_UPGRADE_STATE_FORMAT_REFUSED');
  validateAuthStateTransition(oldRelease, next);
  if (next.source.tree === receipt.sourceTree) return { status: 'already-current', sourceTree: receipt.sourceTree, credentialStatePreserved: true };
  const destination = join(target.root, 'releases', next.source.tree);
  let switched = false, stopped = false, candidateStartAttempted = false, recoveryRequired = false;
  try {
    if (await exists(destination)) assert.deepEqual(await verifyAuthDirectory(destination, { expectedTree: next.source.tree }), next, 'AUTH_UPGRADE_PACKAGE_MISMATCH');
    else { await cp(packageDirectory, destination, { recursive: true, force: false, errorOnExist: true }); assert.deepEqual(await verifyAuthDirectory(destination, { expectedTree: next.source.tree }), next, 'AUTH_UPGRADE_PACKAGE_CHANGED'); }
    if (receipt.status === 'proxy-enabled') { await run('systemctl', ['stop', target.unitName]); stopped = true; }
    await switchRelease(target, destination); switched = true;
    if (stopped) { candidateStartAttempted = true; await run('systemctl', ['start', target.unitName]); await waitForProbe(config); }
    const previousReleases = [...(receipt.previousReleases ?? []), { sourceTree: receipt.sourceTree, runtime: receipt.runtime, releaseManifestSha256: receipt.releaseManifestSha256 }];
    await replace(join(target.root, 'installation.json'), JSON.stringify({ ...receipt, sourceTree: next.source.tree, runtime: destination, releaseManifestSha256: digest(await readFile(join(destination, 'AUTH-RELEASE.json'))), previousReleases }, null, 2) + '\n');
    return { status: 'code-upgraded', sourceTree: next.source.tree, credentialStatePreserved: true };
  } catch (error) {
    // A start failure is uncertain: newer code may already have written state.
    // Never recover by starting a generation that can drop or bypass its fields.
    if (switched && candidateStartAttempted && authStateSemantics(next) !== authStateSemantics(oldRelease)) {
      try { await run('systemctl', ['stop', target.unitName]); } catch { /* Retain the lock for operator recovery either way. */ }
      fail('AUTH_UPGRADE_STATE_SEMANTICS_RECOVERY_REQUIRED');
    }
    try {
      if (switched) { if (stopped) await run('systemctl', ['stop', target.unitName]); await switchRelease(target, receipt.runtime); }
      if (stopped) { await run('systemctl', ['start', target.unitName]); await waitForProbe(config); }
    } catch { recoveryRequired = true; fail('AUTH_UPGRADE_RECOVERY_REQUIRED'); }
    throw error;
  }
}
async function rollbackCodeLocked({ target = paths(), uid = 0, run = (file, args) => execFileSync(file, args, { stdio: 'pipe' }) } = {}) {
  const { receipt, config } = await inspect({ target, uid });
  if (!['proxy-enabled', 'prepared-not-activated'].includes(receipt.status) || !receipt.previousReleases?.length) fail('AUTH_NO_CODE_ROLLBACK_AVAILABLE');
  const previous = receipt.previousReleases.at(-1);
  if (previous.runtime !== join(target.root, 'releases', previous.sourceTree)) fail('AUTH_ROLLBACK_PATH_REFUSED');
  const old = await verifyAuthDirectory(previous.runtime, { expectedTree: previous.sourceTree });
  if (digest(await readFile(join(previous.runtime, 'AUTH-RELEASE.json'))) !== previous.releaseManifestSha256) fail('AUTH_ROLLBACK_MANIFEST_CHANGED');
  if (old.runtime.credentialStoreFormat !== 1) fail('AUTH_UPGRADE_STATE_FORMAT_REFUSED');
  const current = await verifyAuthDirectory(receipt.runtime, { expectedTree: receipt.sourceTree });
  if (current.runtime.credentialStoreFormat !== 1) fail('AUTH_UPGRADE_STATE_FORMAT_REFUSED');
  validateAuthStateTransition(current, old, { rollback: true });
  let switched = false, stopped = false, recoveryRequired = false;
  try {
    if (receipt.status === 'proxy-enabled') { await run('systemctl', ['stop', target.unitName]); stopped = true; }
    await switchRelease(target, previous.runtime); switched = true;
    if (stopped) { await run('systemctl', ['start', target.unitName]); await waitForProbe(config); }
    await replace(join(target.root, 'installation.json'), JSON.stringify({ ...receipt, ...previous, previousReleases: receipt.previousReleases.slice(0, -1) }, null, 2) + '\n');
    return { status: 'code-rolled-back', sourceTree: previous.sourceTree, credentialStatePreserved: true };
  } catch (error) {
    try {
      if (switched) { if (stopped) await run('systemctl', ['stop', target.unitName]); await switchRelease(target, receipt.runtime); }
      if (stopped) { await run('systemctl', ['start', target.unitName]); await waitForProbe(config); }
    } catch { recoveryRequired = true; fail('AUTH_UPGRADE_RECOVERY_REQUIRED'); }
    throw error;
  }
}
/** Updates only private nonsecret configuration and an inert review file while the unit is stopped. */
export async function configureMail({ target = paths(), uid = 0, mail: requestedMail, serviceState = unit => execFileSync('systemctl', ['show', '--property=ActiveState', '--value', unit], { encoding: 'utf8' }).trim() }) {
  const mail = validateMailConfig(requestedMail);
  return withOperationLock(target, uid, async () => {
    const { config, receipt } = await inspect({ target, uid });
    const mailLock = join(target.config, 'mail-config.lock');
    await exclusive(mailLock, 'Mail configuration transition in progress. Inspect interrupted updates before removing.\n');
    let retainMailLock = false;
    try {
    if (await serviceState(target.unitName) !== 'inactive') fail('AUTH_MAIL_STOP_UNIT_REQUIRED');
    if (!await exists(join(receipt.runtime, 'server/mail-config.mjs'))) fail('AUTH_MAIL_RUNTIME_UPGRADE_REQUIRED');
    const configPath = join(target.config, 'auth.json'), receiptPath = join(target.root, 'installation.json'), reviewPath = join(target.config, 'smtp-override.review.conf');
    const oldConfig = await readFile(configPath), oldReceipt = await readFile(receiptPath);
    const reviewExists = await exists(reviewPath);
    if (reviewExists) await protect(reviewPath, { uid, privateMode: true });
    const priorReview = reviewExists ? await readFile(reviewPath) : null;
    const review = smtpReviewOverride(receipt.tenant, mail);
    try {
      if (priorReview) await replace(reviewPath, review); else await exclusive(reviewPath, review);
      await replace(configPath, JSON.stringify({ ...config, mail }, null, 2) + '\n');
      await replace(receiptPath, JSON.stringify({ ...receipt, mail, mailReviewSha256: digest(review) }, null, 2) + '\n');
      if (await serviceState(target.unitName) !== 'inactive') fail('AUTH_MAIL_STOP_UNIT_REQUIRED');
    } catch (error) {
      try {
        await replace(configPath, oldConfig); await replace(receiptPath, oldReceipt);
        if (priorReview) await replace(reviewPath, priorReview); else if (await exists(reviewPath)) await unlink(reviewPath);
      } catch { fail('AUTH_MAIL_CONFIG_RECOVERY_REQUIRED'); }
      throw error;
    }
    return { status: 'mail-configured-awaiting-operator-review', transport: mail.transport, reviewFile: reviewPath, reviewSha256: digest(review), serviceStarted: false, networkPermissionsChanged: false, credentialsRead: false };
    } catch (error) { retainMailLock = /RECOVERY_REQUIRED/.test(error.message); throw error; }
    finally { if (!retainMailLock) await unlink(mailLock); }
  });
}
function mailOptions(options) {
  const transport = options['--mail-transport'] ?? 'disabled';
  if (transport === 'disabled') {
    if (options['--smtp-port'] || options['--smtp-addresses']) fail('AUTH_MAIL_CONFIG_REFUSED');
    return validateMailConfig({ transport });
  }
  if (transport !== 'smtp' || !/^[1-9][0-9]{0,4}$/.test(options['--smtp-port'] ?? '') || !options['--smtp-addresses']) fail('AUTH_MAIL_CONFIG_REFUSED');
  return validateMailConfig({ transport, port: Number(options['--smtp-port']), addresses: options['--smtp-addresses'].split(',') });
}
export async function cli(args) {
  const [command, ...rest] = args;
  if (command === '--help') { console.log('prepare --package DIR --node ABSOLUTE_NODE --origin HTTPS_ORIGIN --tenant TENANT --bindings PRIVATE_PUBLIC_BINDINGS_JSON --reserved-ports COMMA_LIST|none [--mail-transport disabled|smtp --smtp-port PORT --smtp-addresses IP_LIST]\nconfigure-mail --mail-transport disabled|smtp [--smtp-port PORT --smtp-addresses IP_LIST] [--tenant TENANT]\ncheck [--tenant TENANT]\nenable-proxy --nginx-site EXACT_EXISTING_TLS_SITE [--tenant TENANT]\nrollback [--tenant TENANT]\nupgrade --package DIR [--tenant TENANT]\nrollback-code [--tenant TENANT]\nprepare installs an inactive runtime only. Human runs server/operator-activate.mjs in a trusted terminal. No command accepts secrets.'); return; }
  if (process.platform !== 'linux' || process.getuid?.() !== 0) fail('AUTH_INSTALL_LINUX_ROOT_REQUIRED');
  if (process.env.WALLET_AUTH_STORE_KEY || process.env.WALLET_AUTH_CONFIG || process.env.CREDENTIALS_DIRECTORY || process.env.NODE_OPTIONS || process.env.NODE_PATH ||
      Object.keys(process.env).some(key => key.startsWith('WALLET_AUTH_SMTP_'))) fail('AUTH_AMBIENT_CREDENTIAL_REFUSED');
  const options = {};
  for (let i = 0; i < rest.length; i += 2) { if (!/^--[a-z-]+$/.test(rest[i] ?? '') || !rest[i + 1] || Object.hasOwn(options, rest[i])) fail('AUTH_INSTALL_ARGUMENT_REFUSED'); options[rest[i]] = rest[i + 1]; }
  let result;
  if (command === 'prepare') {
    const required = ['--package', '--node', '--origin', '--tenant', '--bindings', '--reserved-ports'];
    const allowed = [...required, '--mail-transport', '--smtp-port', '--smtp-addresses'];
    if (Object.keys(options).some(k => !allowed.includes(k)) || required.some(k => !options[k])) fail('AUTH_INSTALL_ARGUMENT_REFUSED');
    const bindings = JSON.parse(await readFile(resolve(options['--bindings']), 'utf8'));
    if (!Array.isArray(bindings)) fail('AUTH_BINDINGS_ARRAY_REQUIRED');
    const reservedPorts = options['--reserved-ports'] === 'none' ? [] : options['--reserved-ports'].split(',').map(Number);
    result = await prepare({ packageDirectory: resolve(options['--package']), node: options['--node'], origin: options['--origin'], tenant: options['--tenant'], accounts: bindings, reservedPorts, mail: mailOptions(options) });
  } else if (command === 'configure-mail' && options['--mail-transport'] && Object.keys(options).every(k => ['--tenant', '--mail-transport', '--smtp-port', '--smtp-addresses'].includes(k))) result = await configureMail({ target: paths('', options['--tenant'] ?? 'xiongan'), mail: mailOptions(options) });
  else if (command === 'upgrade' && options['--package'] && Object.keys(options).every(k => ['--package', '--tenant'].includes(k))) result = await upgrade({ packageDirectory: resolve(options['--package']), target: paths('', options['--tenant'] ?? 'xiongan') });
  else if (command === 'rollback-code' && Object.keys(options).every(k => k === '--tenant')) result = await rollbackCode({ target: paths('', options['--tenant'] ?? 'xiongan') });
  else if (command === 'check' && Object.keys(options).every(k => k === '--tenant')) result = (await inspect({ target: paths('', options['--tenant'] ?? 'xiongan') })).summary;
  else if (command === 'enable-proxy' && Object.keys(options).every(k => ['--nginx-site', '--tenant'].includes(k)) && options['--nginx-site']) result = await enableProxy({ nginxSite: resolve(options['--nginx-site']), target: paths('', options['--tenant'] ?? 'xiongan') });
  else if (command === 'rollback' && Object.keys(options).every(k => k === '--tenant')) result = await rollback({ target: paths('', options['--tenant'] ?? 'xiongan') });
  else fail('AUTH_INSTALL_ARGUMENT_REFUSED');
  console.log(JSON.stringify(result));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) cli(process.argv.slice(2)).catch(error => { console.error(/^[A-Z0-9_]+$/.test(error.message) ? error.message : 'AUTH_INSTALL_FAILED'); process.exitCode = 1; });
