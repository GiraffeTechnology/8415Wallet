/** Bounded PR58 import. Run only by an authorized host operator; never initializes/rekeys an account. */
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { open, readFile, lstat, realpath, readlink, readdir, mkdir, cp, unlink, symlink, rename, rmdir } from 'node:fs/promises';
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
const runAliasHost = (file, args) => execFileSync(file, args, { encoding: 'utf8', env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' }, timeout: 30000, killSignal: 'SIGKILL', maxBuffer: 4_000_000, stdio: ['ignore', 'pipe', 'pipe'] });
function candidateAliasVersion(node) {
  // Only called after protectedNode on the NEW candidate, never the observed alias.
  const version = execFileSync(node, ['--version'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LANG: 'C' }, timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 4096, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const m = /^v(22|24)\.(\d+)\.(\d+)$/.exec(version);
  if (!m || m[1] === '22' && Number(m[2]) < 18) fail('AUTH_NODE_22_18_OR_24_REQUIRED');
  return version;
}
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
const ALIAS_MODE = 'observed-alias-forward-only';
const ALIAS_SCHEMA = '8415wallet-legacy-alias-migration/1';
const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const sameIdentity = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fileIdentity = s => ({ dev: s.dev, ino: s.ino, size: s.size, uid: s.uid, gid: s.gid, mode: s.mode, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs });
const migrationJournal = (target, j) => join(target.root, j.schema === ALIAS_SCHEMA ? 'legacy-alias-migration.json' : 'legacy-migration.json');
const aliasFence = target => ({ file: join(target.config, 'legacy-alias-migration.fence'), directory: `${target.unit}.d`, dropIn: join(`${target.unit}.d`, '90-legacy-alias-migration.conf') });
const fenceText = j => JSON.stringify({ schema: ALIAS_SCHEMA, id: j.id, candidateNode: j.candidateNode }) + '\n';
const dropInText = target => `[Unit]\nConditionPathExists=!${aliasFence(target).file}\n`;
async function pinnedPublicRecord(path, expected, uid) {
  if (!safePath(path) || !sha256(expected)) fail('AUTH_LEGACY_ALIAS_INDEPENDENT_EVIDENCE_REQUIRED');
  try {
  await protectedAncestors(path, uid); await protect(path, { uid });
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.uid !== uid || before.gid !== uid || (before.mode & 0o7022) || before.size > 32768) fail('AUTH_LEGACY_ALIAS_EVIDENCE_PIN_REFUSED');
    bytes = await file.readFile();
    if (!sameIdentity(fileIdentity(before), fileIdentity(await file.stat()))) fail('AUTH_LEGACY_ALIAS_EVIDENCE_PIN_REFUSED');
  } finally { await file.close(); }
  if (hash(bytes) !== expected) fail('AUTH_LEGACY_ALIAS_EVIDENCE_PIN_REFUSED');
  try { return JSON.parse(bytes); } catch { fail('AUTH_LEGACY_ALIAS_EVIDENCE_SCHEMA_REFUSED'); }
  } catch (error) {
    if (/^AUTH_[A-Z0-9_]+$/.test(error.message ?? '')) throw error;
    fail('AUTH_LEGACY_ALIAS_EVIDENCE_UNAVAILABLE');
  }
}
async function observedParents(path, owner) {
  const result = [];
  for (let directory = dirname(path); ; directory = dirname(directory)) {
    const s = await lstat(directory);
    if (!s.isDirectory() || s.isSymbolicLink() || ![0, owner].includes(s.uid) || s.gid !== s.uid || (s.mode & 0o6000) ||
        ((s.mode & 0o022) && !((s.mode & 0o1000) && [0, owner].includes(s.uid))) || await realpath(directory) !== directory) fail('AUTH_LEGACY_ALIAS_ANCESTOR_REFUSED');
    result.push({ path: directory, identity: { dev: s.dev, ino: s.ino, uid: s.uid, gid: s.gid, mode: s.mode } });
    if (directory === dirname(directory)) break;
  }
  return result;
}
async function imageFromHandle(file) {
  const before = await file.stat();
  if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > 256 * 1024 * 1024) fail('AUTH_LEGACY_ALIAS_IMAGE_REFUSED');
  const bytes = await file.readFile();
  if (!sameIdentity(fileIdentity(before), fileIdentity(await file.stat()))) fail('AUTH_LEGACY_ALIAS_IMAGE_CHANGED');
  return { identity: fileIdentity(before), sha256: hash(bytes) };
}
/** Read-only observation. It must never become candidate execution authority. */
export async function observeLegacyAlias({ path, baselinePath, baselineSha256 }, uid = 0) {
  const baseline = await pinnedPublicRecord(baselinePath, baselineSha256, uid);
  if (Object.keys(baseline).sort().join(',') !== 'aliasPath,gid,mode,publisherEvidenceSha256,resolvedPath,schema,sha256,size,sourceCommit,uid' ||
      baseline.schema !== '8415wallet-legacy-image-baseline/1' || baseline.sourceCommit !== LEGACY_COMMIT || baseline.aliasPath !== path ||
      !safePath(path) || !safePath(baseline.resolvedPath) || !sha256(baseline.sha256) || !sha256(baseline.publisherEvidenceSha256) ||
      !Number.isInteger(baseline.uid) || baseline.uid < 0 || baseline.gid !== baseline.uid || !Number.isInteger(baseline.mode) ||
      (baseline.mode & 0o7022) || !(baseline.mode & 0o111) || !Number.isInteger(baseline.size)) fail('AUTH_LEGACY_ALIAS_BASELINE_REFUSED');
  const parents = await observedParents(path, uid), leaf = await lstat(path);
  if (!leaf.isSymbolicLink() || leaf.uid !== uid || leaf.gid !== uid || leaf.nlink !== 1) fail('AUTH_LEGACY_ALIAS_LEAF_REFUSED');
  const linkText = await readlink(path);
  if (!safePath(linkText) || linkText !== baseline.resolvedPath || await realpath(path) !== linkText) fail('AUTH_LEGACY_ALIAS_TARGET_REFUSED');
  const targetParents = await observedParents(linkText, baseline.uid);
  const file = await open(linkText, constants.O_RDONLY | constants.O_NOFOLLOW);
  let image; try { image = await imageFromHandle(file); } finally { await file.close(); }
  const s = image.identity;
  if (s.uid !== baseline.uid || s.gid !== baseline.gid || (s.mode & 0o7777) !== baseline.mode || s.size !== baseline.size || image.sha256 !== baseline.sha256) fail('AUTH_LEGACY_ALIAS_BASELINE_MISMATCH');
  if (!sameIdentity(fileIdentity(leaf), fileIdentity(await lstat(path))) || await readlink(path) !== linkText ||
      !sameIdentity(s, fileIdentity(await lstat(linkText))) || !sameIdentity(parents, await observedParents(path, uid)) ||
      !sameIdentity(targetParents, await observedParents(linkText, baseline.uid))) fail('AUTH_LEGACY_ALIAS_CHANGED');
  return { leaf: fileIdentity(leaf), linkText, parents, targetParents, image };
}
async function observedProcess(pid) {
  if (!/^[1-9][0-9]*$/.test(String(pid))) fail('AUTH_LEGACY_ALIAS_PROCESS_REQUIRED');
  const statPath = `/proc/${pid}/stat`, text = await readFile(statPath, 'utf8');
  const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/), startTime = fields[19];
  if (!/^[0-9]+$/.test(startTime ?? '')) fail('AUTH_LEGACY_ALIAS_PROCESS_REFUSED');
  const exe = `/proc/${pid}/exe`, link = await readlink(exe);
  const status = await readFile(`/proc/${pid}/status`, 'utf8'), match = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/m.exec(status);
  if (!match) fail('AUTH_LEGACY_ALIAS_PROCESS_REFUSED');
  const uids = match.slice(1).map(Number);
  if (link.endsWith(' (deleted)')) fail('AUTH_LEGACY_ALIAS_PROCESS_REFUSED');
  // Intentional kernel procfs executable reference, never a caller path.
  const file = await open(exe, constants.O_RDONLY);
  let image; try { image = await imageFromHandle(file); } finally { await file.close(); }
  const after = await readFile(statPath, 'utf8');
  if (after.slice(after.lastIndexOf(')') + 2).trim().split(/\s+/)[19] !== startTime || await readlink(exe) !== link) fail('AUTH_LEGACY_ALIAS_PROCESS_CHANGED');
  const afterStatus = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/m.exec(await readFile(`/proc/${pid}/status`, 'utf8'));
  if (!afterStatus || !sameIdentity(afterStatus.slice(1).map(Number), uids)) fail('AUTH_LEGACY_ALIAS_PROCESS_CHANGED');
  return { pid: String(pid), startTime, uids, image };
}
export async function attestEmptyLegacyEvidence(o, target, uid) {
  try {
  const record = await pinnedPublicRecord(o.emptyStateEvidence, o.emptyStateEvidenceSha256, uid);
  const scope = { tenant: o.tenant, origin: o.origin, sourceCommit: o.sourceCommit, statePath: o.legacyState };
  const expectedScope = hash(Buffer.from(JSON.stringify(scope)));
  const questions = ['password', 'totp', 'recoveryCodes', 'emailOrOtherAccount', 'deletedResetRestoredOrMoved'];
  if (Object.keys(record).sort().join(',') !== 'activationEvidenceSha256,answers,confirmedAt,schema,scopeSha256,userConfirmed' ||
      record.schema !== '8415wallet-never-enrolled-confirmation/1' || record.scopeSha256 !== expectedScope || record.userConfirmed !== true ||
      !sha256(record.activationEvidenceSha256) || !Number.isSafeInteger(record.confirmedAt) || record.confirmedAt < 1 ||
      !record.answers || Object.keys(record.answers).sort().join(',') !== [...questions].sort().join(',') || questions.some(q => record.answers[q] !== 'NO')) fail('AUTH_LEGACY_EMPTY_STATE_REVIEW_REQUIRED');
  const activation = await pinnedPublicRecord(o.activationEvidence, record.activationEvidenceSha256, uid);
  if (Object.keys(activation).sort().join(',') !== 'credentialWrites,enrollmentEvents,initializationOutcome,passwordProvisioned,schema,scopeSha256,unknownOutcomes' ||
      activation.schema !== '8415wallet-original-activation-evidence/1' || activation.scopeSha256 !== expectedScope ||
      activation.initializationOutcome !== 'complete' || activation.passwordProvisioned !== false || activation.credentialWrites !== 0 ||
      activation.enrollmentEvents !== 0 || activation.unknownOutcomes !== 0 || await exists(join(target.state, 'credentials.enc'))) fail('AUTH_LEGACY_EMPTY_STATE_REVIEW_REQUIRED');
  return { scopeSha256: expectedScope, confirmationSha256: o.emptyStateEvidenceSha256, activationEvidenceSha256: record.activationEvidenceSha256 };
  } catch { fail('AUTH_LEGACY_EMPTY_STATE_REVIEW_REQUIRED'); }
}
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
async function serviceProperties(run, target, expectedDropIn = '') {
  const text = String(await run('systemctl', ['show', target.unitName, '--property=FragmentPath,DropInPaths,ActiveState,SubState,MainPID,UnitFileState']));
  const p = Object.fromEntries(text.trim().split('\n').map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
  if (p.FragmentPath !== target.unit || p.DropInPaths !== expectedDropIn || !['enabled', 'disabled'].includes(p.UnitFileState) || !['active', 'inactive'].includes(p.ActiveState) || !/^\d+$/.test(p.MainPID ?? '')) fail('AUTH_LEGACY_SERVICE_OVERRIDE_OR_STATE_REFUSED');
  return p;
}
async function stopped(run, target, expectedDropIn = '') {
  const p = await serviceProperties(run, target, expectedDropIn);
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
      ![o.legacySource, o.legacyProxy, o.nginxSite, o.node, o.legacyNode ?? o.node, o.packageDirectory].every(safePath) || o.legacyProxy === o.nginxSite || o.sourceCommit !== LEGACY_COMMIT) fail('AUTH_LEGACY_EXPLICIT_BINDING_REQUIRED');
  if (o.legacyNodePolicy && o.legacyNodePolicy !== ALIAS_MODE) fail('AUTH_LEGACY_NODE_POLICY_REFUSED');
  if (o.legacyNodePolicy === ALIAS_MODE && (!safePath(o.legacyNode) || !safePath(o.legacyImageBaseline) || !sha256(o.legacyImageBaselineSha256))) fail('AUTH_LEGACY_ALIAS_INDEPENDENT_EVIDENCE_REQUIRED');
  if (o.legacyNodePolicy !== ALIAS_MODE && [o.legacyImageBaseline, o.legacyImageBaselineSha256, o.emptyStateEvidence, o.emptyStateEvidenceSha256, o.activationEvidence].some(v => v !== undefined)) fail('AUTH_LEGACY_NODE_POLICY_REFUSED');
  return target;
}
async function legacyNodeIdentity(node, uid, nodeUid) {
  try { return await protectedNode(node, uid, nodeUid); }
  catch { fail('AUTH_LEGACY_NODE_PROTECTION_REQUIRED'); }
}
async function assertLegacyNode(binding, uid) {
  if (!binding || !safePath(binding.path) || !Number.isInteger(binding.uid) || (uid === 0 && binding.uid !== 0)) fail('AUTH_LEGACY_NODE_BINDING_REFUSED');
  if (binding.policy === ALIAS_MODE) {
    const actual = await observeLegacyAlias(binding, uid);
    if (!sameIdentity(actual, binding.identity)) fail('AUTH_LEGACY_ALIAS_CHANGED');
    return;
  }
  const actual = await legacyNodeIdentity(binding.path, uid, binding.uid);
  if (JSON.stringify(actual) !== JSON.stringify(binding.identity)) fail('AUTH_LEGACY_NODE_CHANGED');
}
/** Nonmutating inspection; summaries never contain paths, keys, ciphertext, account identities or their hashes. */
export async function inspectLegacy(o) {
  const target = bindOptions(o), uid = o.uid ?? 0, run = o.run ?? (o.legacyNodePolicy === ALIAS_MODE ? runAliasHost : runHost);
  for (const dir of [target.root, target.config, target.state]) { await protectedAncestors(dir, uid); await protect(dir, { uid, directory: true, privateMode: dir !== target.root }); }
  if (await exists(join(target.root, 'installation.json')) || await exists(join(target.root, 'operation.lock'))) fail('AUTH_LEGACY_EXISTING_RECEIPT_OR_TRANSITION_REFUSED');
  if (await exists(join(target.root, 'legacy-alias-migration.json'))) fail('AUTH_LEGACY_ALIAS_RESUME_REQUIRED');
  if (await exists(join(target.root, 'legacy-migration.json'))) {
    const previous = JSON.parse(await privateBytes(join(target.root, 'legacy-migration.json'), uid, 1_000_000));
    if (previous.schema !== '8415wallet-legacy-migration/1' || previous.phase !== 'restored-before-start' || previous.candidateStartAttempted) fail('AUTH_LEGACY_EXISTING_RECEIPT_OR_TRANSITION_REFUSED');
  }
  await protectedPackage(o.legacySource, uid);
  for (const [path, expected] of Object.entries(LEGACY_FILES)) if (blob(await readFile(join(o.legacySource, path))) !== expected) fail('AUTH_LEGACY_UNSUPPORTED_SOURCE');
  const current = await lstat(join(target.root, 'current'));
  if (!current.isSymbolicLink() || current.uid !== uid || current.gid !== uid || await realpath(join(target.root, 'current')) !== o.legacySource) fail('AUTH_LEGACY_CURRENT_SOURCE_REFUSED');
  const nodeIdentity = await protectedNode(o.node, uid, o.nodeUid ?? 0), nodeVersion = o.legacyNodePolicy === ALIAS_MODE ? candidateAliasVersion(o.node) : runtimeVersion(o.node);
  if (JSON.stringify(await protectedNode(o.node, uid, o.nodeUid ?? 0)) !== JSON.stringify(nodeIdentity)) fail('AUTH_NODE_CHANGED');
  // The legacy unit's executable spelling is independent of the candidate's.
  // Keep the existing regular-file/no-follow/owner/ancestor policy for both.
  const legacyNode = { path: o.legacyNode ?? o.node, uid: o.nodeUid ?? 0 };
  if (o.legacyNodePolicy === ALIAS_MODE) {
    Object.assign(legacyNode, { policy: ALIAS_MODE, baselinePath: o.legacyImageBaseline, baselineSha256: o.legacyImageBaselineSha256 });
    legacyNode.identity = await observeLegacyAlias(legacyNode, uid);
  } else legacyNode.identity = await legacyNodeIdentity(legacyNode.path, uid, legacyNode.uid);
  await assertLegacyNode(legacyNode, uid);
  const unit = await publicBytes(target.unit, uid);
  let expectedUnit = await readFile(join(o.legacySource, 'deploy/auth-xiongan/8415wallet-auth-xiongan.service'), 'utf8');
  expectedUnit = expectedUnit.replace('ExecStart=/usr/bin/node', `ExecStart=${legacyNode.path}`).replace('WorkingDirectory=/opt/8415wallet-auth-xiongan/current', `WorkingDirectory=${join(target.root, 'current')}`);
  if (unitLines(unit.toString()) !== unitLines(expectedUnit)) fail('AUTH_LEGACY_UNIT_UNSUPPORTED');
  const service = await serviceProperties(run, target);
  let legacyProcess;
  if (legacyNode.policy === ALIAS_MODE) {
    if (service.ActiveState !== 'active' || service.SubState !== 'running') fail('AUTH_LEGACY_ALIAS_PROCESS_REQUIRED');
    legacyProcess = await (o.observeProcess ?? observedProcess)(service.MainPID);
    if (legacyProcess.pid !== service.MainPID || !/^[0-9]+$/.test(legacyProcess.startTime ?? '') || !Array.isArray(legacyProcess.uids) || legacyProcess.uids.length !== 4 || legacyProcess.uids.some(value => value !== uid) ||
        legacyProcess.image?.identity.dev !== legacyNode.identity.image.identity.dev || legacyProcess.image?.identity.ino !== legacyNode.identity.image.identity.ino ||
        legacyProcess.image?.sha256 !== legacyNode.identity.image.sha256) fail('AUTH_LEGACY_ALIAS_PROCESS_REFUSED');
    if (!sameIdentity(await (o.observeProcess ?? observedProcess)(service.MainPID), legacyProcess)) fail('AUTH_LEGACY_ALIAS_PROCESS_CHANGED');
  }
  const configBytes = await privateBytes(o.legacyConfig, uid, 1_000_000);
  const config = JSON.parse(configBytes); validateAuthConfig(config);
  if (config.tenant !== o.tenant || config.origin !== o.origin || !o.origin.startsWith('https://') || config.statePath !== o.legacyState ||
      !Number.isInteger(config.port) || Object.keys(config).some(k => !['origin', 'tenant', 'port', 'statePath', 'accounts'].includes(k))) fail('AUTH_LEGACY_CONFIG_UNSUPPORTED');
  const proxy = await publicBytes(o.legacyProxy, uid), site = await publicBytes(o.nginxSite, uid);
  const expectedProxy = (await readFile(join(o.legacySource, 'deploy/auth-xiongan/auth-location.nginx.conf'), 'utf8')).replace('127.0.0.1:18417', `127.0.0.1:${config.port}`);
  if (normalized(proxy.toString()) !== normalized(expectedProxy)) fail('AUTH_LEGACY_PROXY_UNSUPPORTED');
  const nginxGraph = await inspectLegacyNginx({ run, uid, nginxSite: o.nginxSite, legacyProxy: o.legacyProxy, origin: config.origin });
  await protectedPackage(o.packageDirectory, uid); const release = await verifyAuthDirectory(o.packageDirectory);
  if (release.runtime.legacyImportProtocol !== 1 || release.runtime.credentialStoreFormat !== 1 || authStateSemantics(release) !== AUTH_STATE_SEMANTICS) fail('AUTH_LEGACY_FORWARD_PACKAGE_REQUIRED');
  for (const path of ['auth-location.nginx.conf', 'smtp-override.review.conf', 'mail-config.lock', 'migration-config.lock']) if (await exists(join(target.config, path))) fail('AUTH_LEGACY_TARGET_CONFLICT');
  let emptyEvidence;
  if (legacyNode.policy === ALIAS_MODE && !await exists(o.legacyState)) {
    if (o.allowEmptyState !== true || !o.emptyStateEvidence || !o.activationEvidence) fail('AUTH_LEGACY_EMPTY_STATE_REVIEW_REQUIRED');
    emptyEvidence = await attestEmptyLegacyEvidence(o, target, uid);
  }
  // In alias mode check/inspect is metadata-only. Read/authenticate credentials
  // only after the confirmed transition has fenced and stopped the legacy unit.
  const statePresent = Boolean(await exists(o.legacyState));
  let credentialHashes = null;
  if (legacyNode.policy === ALIAS_MODE) {
    await protectedAncestors(o.legacyKey, uid);
    const keyMetadata = await protect(o.legacyKey, { uid, privateMode: true });
    if (![64, 65].includes(keyMetadata.size)) fail('AUTH_LEGACY_KEY_METADATA_REFUSED');
    if (statePresent) { await protectedAncestors(o.legacyState, uid); await protect(o.legacyState, { uid, privateMode: true }); }
  } else credentialHashes = await credentials(target, uid, o.allowEmptyState === true, config);
  return { target, config, configBytes, unit, proxy, site, nginxGraph, service, release, nodeIdentity, nodeVersion, legacyNode, legacyProcess, emptyEvidence, credentialHashes,
    summary: { status: legacyNode.policy === ALIAS_MODE ? 'observed-alias-awaiting-forward-only-approval' : 'supported-legacy-awaiting-operator-confirmation',
      sourceCommit: LEGACY_COMMIT, tenant: o.tenant, emptyState: !statePresent, forwardOnlyAfterCandidateStart: true, accountCount: config.accounts.length,
      ...(legacyNode.policy === ALIAS_MODE ? { legacyExecutionTrusted: false, independentImageBaselineMatched: true, forwardOnlyAfterFence: true, metadataOnly: true, credentialsAuthenticated: false } : {}) } };
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
async function verifyAliasFence(j, target, uid, run) {
  const fence = aliasFence(target);
  if (!sameIdentity(JSON.parse(await privateBytes(fence.file, uid, 32768)), JSON.parse(fenceText(j))) ||
      (await publicBytes(fence.dropIn, uid)).toString() !== dropInText(target)) fail('AUTH_LEGACY_ALIAS_FENCE_CHANGED');
  await protect(fence.directory, { uid, directory: true });
  if ((await readdir(fence.directory)).join(',') !== basename(fence.dropIn)) fail('AUTH_LEGACY_ALIAS_FENCE_CHANGED');
  await serviceProperties(run, target, fence.dropIn);
}
async function createAliasFence(j, target, uid, run) {
  const fence = aliasFence(target);
  if (await exists(fence.file) || await exists(fence.directory)) fail('AUTH_LEGACY_ALIAS_FENCE_CONFLICT');
  await exclusive(fence.file, fenceText(j)); await durableDirectory(target.config);
  await mkdir(fence.directory, { mode: 0o755 }); await protect(fence.directory, { uid, directory: true });
  await exclusive(fence.dropIn, dropInText(target), 0o644);
  await durableDirectory(fence.directory); await durableDirectory(dirname(target.unit));
  await run('systemctl', ['daemon-reload']); await verifyAliasFence(j, target, uid, run);
}
async function releaseAliasFence(j, target, uid, run) {
  if (!j.candidateStartAttempted) fail('AUTH_LEGACY_ALIAS_START_INTENT_REQUIRED');
  const fence = aliasFence(target);
  if (!await exists(fence.file) || !await exists(fence.dropIn)) {
    // Only a durable candidate-start intent permits crash recovery after removal.
    if (await exists(fence.file) || await exists(fence.dropIn)) fail('AUTH_LEGACY_ALIAS_FENCE_REVIEW_REQUIRED');
    await serviceProperties(run, target);
    return;
  }
  await verifyAliasFence(j, target, uid, run);
  await unlink(fence.dropIn); await durableDirectory(fence.directory);
  await rmdir(fence.directory); await durableDirectory(dirname(target.unit));
  await unlink(fence.file); await durableDirectory(target.config);
  await run('systemctl', ['daemon-reload']); await serviceProperties(run, target);
}
async function migrateObservedAlias(o, before) {
  const { target } = before, uid = o.uid ?? 0, run = o.run ?? runAliasHost;
  await assertLegacyNode(before.legacyNode, uid);
  const live = await (o.observeProcess ?? observedProcess)(before.service.MainPID);
  if (!sameIdentity(live, before.legacyProcess)) fail('AUTH_LEGACY_ALIAS_PROCESS_CHANGED');
  const service = await serviceProperties(run, target);
  if (service.MainPID !== before.service.MainPID || service.ActiveState !== 'active' || service.SubState !== 'running') fail('AUTH_LEGACY_ALIAS_PROCESS_CHANGED');
  const lock = join(target.root, 'operation.lock'), backup = join(target.root, `legacy-backup-${randomBytes(8).toString('hex')}`);
  const j = { schema: ALIAS_SCHEMA, id: randomBytes(16).toString('hex'), tenant: target.tenant, phase: 'alias-intent', candidateStartAttempted: false, backup,
    legacyNode: before.legacyNode, legacyProcess: before.legacyProcess, legacySource: o.legacySource, legacyLink: await readlink(join(target.root, 'current')),
    legacyProxy: o.legacyProxy, nginxSite: o.nginxSite, nginxGraph: before.nginxGraph, origin: before.config.origin, before: {},
    candidateNode: { path: o.node, uid: o.nodeUid ?? 0, identity: before.nodeIdentity, version: before.nodeVersion }, emptyEvidence: before.emptyEvidence ?? null };
  await exclusive(lock, 'Observed legacy alias migration: never restart legacy code or remove this lock by inference.\n');
  let stateLock;
  try {
    await exclusive(migrationJournal(target, j), JSON.stringify(j, null, 2) + '\n'); await durableDirectory(target.root);
    await createAliasFence(j, target, uid, run);
    j.phase = 'fenced'; await writeJournal(migrationJournal(target, j), j); await durableDirectory(target.root); await o.checkpoint?.('alias-fenced');
    await run('systemctl', ['stop', target.unitName]); await stopped(run, target, aliasFence(target).dropIn);
    j.phase = 'stopped'; await writeJournal(migrationJournal(target, j), j); await durableDirectory(target.root); await o.checkpoint?.('alias-stopped');
    await assertLegacyNode(before.legacyNode, uid);
    stateLock = await open(`${o.legacyState}.lock`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    if (!await exists(o.legacyState)) {
      const proof = await attestEmptyLegacyEvidence(o, target, uid);
      if (!sameIdentity(proof, before.emptyEvidence)) fail('AUTH_LEGACY_EMPTY_STATE_REVIEW_REQUIRED');
    }
    const second = await credentials(target, uid, before.emptyEvidence !== undefined, before.config);
    for (const [path, expected, secret] of [[o.legacyConfig, hash(before.configBytes), true], [target.unit, hash(before.unit), false], [o.nginxSite, hash(before.site), false], [o.legacyProxy, hash(before.proxy), false]]) await assertSnapshot(path, expected, uid, secret);
    await mkdir(backup, { mode: 0o700 });
    for (const [name, path, secret] of [['config', o.legacyConfig, true], ['unit', target.unit, false], ['proxy', o.legacyProxy, false], ['site', o.nginxSite, false], ['key', o.legacyKey, true], ...(second.stateSha256 ? [['state', o.legacyState, true]] : [])]) j.before[name] = await backupFile(path, join(backup, name), uid, secret);
    if (j.before.key !== second.keySha256 || (j.before.state ?? null) !== second.stateSha256) fail('AUTH_LEGACY_BACKUP_MISMATCH');
    j.credentials = second; j.phase = 'snapshot-verified'; await durableTree(backup); await durableDirectory(target.root);
    await writeJournal(migrationJournal(target, j), j); await durableDirectory(target.root); await o.checkpoint?.('alias-snapshot-verified');
    await installCandidate(o, before, j); await stateUnchanged(j, target, uid);
    j.phase = 'candidate-installed'; await writeJournal(migrationJournal(target, j), j); await durableDirectory(target.root);
    await stateLock.close(); stateLock = null; await unlink(`${o.legacyState}.lock`);
    return await finishForward(j, target, uid, run, o.probe ?? waitForProbe);
  } catch (error) {
    // There is deliberately no restoreBeforeStart or legacy start in this mode.
    if (stateLock) { await stateLock.close(); stateLock = null; /* retain the owned writer lock for explicit review */ }
    try {
      const own = JSON.parse(await privateBytes(migrationJournal(target, j), uid, 1_000_000));
      if (own.id === j.id) {
        j.lastFailure = { stage: j.phase, stableCode: /^[A-Z0-9_]+$/.test(error.message ?? '') ? error.message : 'AUTH_LEGACY_ALIAS_RUNTIME_REFUSED' };
        await writeJournal(migrationJournal(target, j), j); await durableDirectory(target.root);
      }
    } catch { /* Original safety state is retained; do not overwrite an unknown journal. */ }
    try { await run('systemctl', ['stop', target.unitName]); } catch { /* retain journal/fence/operation lock */ }
    fail('AUTH_LEGACY_ALIAS_FORWARD_RECOVERY_REQUIRED');
  }
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
  await writeJournal(migrationJournal(target, journal), journal);
  await exclusive(join(target.config, 'auth-location.nginx.conf'), location); await o.checkpoint?.('snippet-written');
  await exclusive(join(target.config, 'smtp-override.review.conf'), review);
  await replace(join(target.config, 'auth.json'), JSON.stringify(nextConfig, null, 2) + '\n'); await o.checkpoint?.('config-written');
  await replace(target.unit, unit); await durableDirectory(dirname(target.unit)); await durableDirectory(target.config); await o.checkpoint?.('unit-written');
  await switchRelease(target, destination); await o.checkpoint?.('current-switched');
  await exclusive(join(target.root, 'installation.json'), JSON.stringify(receipt, null, 2) + '\n'); await o.checkpoint?.('receipt-written');
  return nextConfig;
}
async function restoreBeforeStart(j, target, uid, run) {
  if (j.schema === ALIAS_SCHEMA) fail('AUTH_LEGACY_ALIAS_DOWNGRADE_REFUSED');
  if (j.candidateStartAttempted) fail('AUTH_LEGACY_DOWNGRADE_REFUSED');
  // Old journals retain their existing behavior; new journals bind the separately
  // observed legacy executable before any recovery writes or old-service start.
  if (j.legacyNode) await assertLegacyNode(j.legacyNode, uid);
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
  const journalPath = migrationJournal(target, j);
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
  if (j.schema === ALIAS_SCHEMA) await releaseAliasFence(j, target, uid, run);
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
  if (before.legacyNode.policy === ALIAS_MODE) return migrateObservedAlias(o, before);
  await assertLegacyNode(before.legacyNode, uid);
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
      legacySource: o.legacySource, legacyNode: before.legacyNode, legacyLink: await readlink(join(target.root, 'current')), legacyProxy: o.legacyProxy, nginxSite: o.nginxSite,
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
async function resumeObservedAlias({ tenant, target, uid, run, probe }) {
  const j = JSON.parse(await privateBytes(join(target.root, 'legacy-alias-migration.json'), uid, 1_000_000));
  if (j.schema !== ALIAS_SCHEMA || j.tenant !== tenant || !/^[a-f0-9]{32}$/.test(j.id ?? '') ||
      !safePath(j.backup) || dirname(j.backup) !== target.root || !/^legacy-backup-[a-f0-9]{16}$/.test(basename(j.backup)) ||
      ![j.legacyProxy, j.nginxSite, j.legacySource, j.candidateNode?.path].every(safePath) || j.legacyProxy === j.nginxSite ||
      j.candidateNode?.uid !== uid || !j.candidateNode?.identity || !sha256(j.candidateNode.identity.sha256)) fail('AUTH_LEGACY_ALIAS_JOURNAL_REFUSED');
  const currentNode = await protectedNode(j.candidateNode.path, uid, j.candidateNode.uid);
  if (!sameIdentity(currentNode, j.candidateNode.identity)) fail('AUTH_NODE_CHANGED');
  if (!['candidate-installed', 'candidate-start-attempted', 'complete'].includes(j.phase) || !j.candidate?.receipt || !/^[a-f0-9]{40}$/.test(j.candidate.receipt.sourceTree ?? '') ||
      j.phase !== 'candidate-installed' && j.candidateStartAttempted !== true || !j.credentials || !sha256(j.credentials.keySha256) ||
      !j.before || !['config', 'unit', 'proxy', 'site', 'key'].every(name => sha256(j.before[name])) ||
      !(j.credentials.stateSha256 === null || sha256(j.credentials.stateSha256) && sha256(j.before.state))) fail('AUTH_LEGACY_ALIAS_PRESTART_REVIEW_REQUIRED');
  await protect(join(target.root, 'operation.lock'), { uid, privateMode: true }).catch(error => {
    if (j.phase !== 'complete' || error.code !== 'ENOENT') throw error;
  });
  if (await exists(join(target.state, 'credentials.enc.lock'))) fail('AUTH_LEGACY_ALIAS_WRITER_LOCK_REVIEW_REQUIRED');
  const resumeLock = join(target.root, 'legacy-alias-resume.lock');
  await exclusive(resumeLock, 'Alias migration forward-only resume is running.\n');
  try {
    for (const [name, expected] of Object.entries(j.before)) {
      if (!['config', 'unit', 'proxy', 'site', 'key', 'state'].includes(name) || !sha256(expected)) fail('AUTH_LEGACY_ALIAS_JOURNAL_REFUSED');
      await assertSnapshot(join(j.backup, name), expected, uid, true);
    }
    const result = await inspect({ target, uid });
    if (result.receipt.node !== j.candidateNode.path || result.receipt.nodeSha256 !== currentNode.sha256 || result.receipt.sourceTree !== j.candidate.receipt.sourceTree) fail('AUTH_LEGACY_CANDIDATE_CHANGED');
    if (j.phase === 'complete') {
      if (result.receipt.status !== 'proxy-enabled' || await exists(aliasFence(target).file) || await exists(aliasFence(target).dropIn)) fail('AUTH_LEGACY_ALIAS_FENCE_REVIEW_REQUIRED');
      await serviceProperties(run, target);
      if (await exists(join(target.root, 'operation.lock'))) await unlink(join(target.root, 'operation.lock'));
      return { status: 'already-imported', credentialsPreserved: true, forwardOnly: true };
    }
    const expectedDropIn = await exists(aliasFence(target).dropIn) ? aliasFence(target).dropIn : '';
    if (!j.candidateStartAttempted) await verifyAliasFence(j, target, uid, run);
    await run('systemctl', ['stop', target.unitName]); await stopped(run, target, expectedDropIn);
    try { return await finishForward(j, target, uid, run, probe); }
    catch { try { await run('systemctl', ['stop', target.unitName]); } catch {} fail('AUTH_LEGACY_ALIAS_FORWARD_RECOVERY_REQUIRED'); }
  } finally { await unlink(resumeLock); }
}
export async function resumeLegacy({ tenant, confirm, target = paths('', tenant), uid = 0, run, probe = waitForProbe }) {
  if (tenant !== 'xiongan' || target.tenant !== tenant || confirm !== 'MIGRATE-PR58-FORWARD-ONLY') fail('AUTH_LEGACY_CONFIRMATION_REQUIRED');
  for (const path of [target.root, target.config, target.state]) { await protectedAncestors(path, uid); await protect(path, { uid, directory: true, privateMode: path !== target.root }); }
  if (await exists(join(target.root, 'legacy-alias-migration.json'))) return resumeObservedAlias({ tenant, target, uid, run: run ?? runAliasHost, probe });
  run ??= runHost;
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
  if (command === '--help') {
    output.write('check|migrate --package DIR --node ABSOLUTE_CANDIDATE_NODE [--legacy-node EXACT_LEGACY_EXECUTABLE] --tenant xiongan --origin EXACT_HTTPS_ORIGIN --source-commit PR58_MERGE --legacy-source EXACT_DIRECTORY --legacy-service EXACT_UNIT --legacy-config EXACT_FILE --legacy-key EXACT_FILE --legacy-state EXACT_FILE --legacy-proxy EXACT_INCLUDED_FILE --nginx-site EXACT_SITE [--allow-empty-state yes]\nresume --tenant xiongan\nCandidate Node is always a protected regular file. Default legacy mode also refuses aliases. Check is nonmutating but reads the protected key and authenticates ciphertext in memory. Migration/resume require a trusted terminal and explicit forward-only approval. No secret arguments. Never run initialization for existing accounts.\n');
    output.write('Explicit alias observation: --legacy-node-policy observed-alias-forward-only --legacy-node EXACT_ALIAS --legacy-image-baseline PROTECTED_RECORD --legacy-image-baseline-sha256 INDEPENDENT_PIN. Empty-state additionally requires --empty-state-evidence PROTECTED_PERSONAL_CONFIRMATION --empty-state-evidence-sha256 INDEPENDENT_PIN --activation-evidence PROTECTED_ORIGINAL_RECORD. Missing evidence refuses; no restart of legacy code after fencing.\n');
    output.write('The credential-reading check warning above applies to default protected-node mode. Explicit alias-mode check reads only credential file metadata and reports credentialsAuthenticated=false; credential contents are validated only after confirmed fencing and stop.\n');
    return;
  }
  if (process.platform !== 'linux' || process.getuid?.() !== 0 || process.geteuid?.() !== 0) fail('AUTH_INSTALL_LINUX_ROOT_REQUIRED');
  if (process.env.NODE_OPTIONS || process.env.NODE_PATH || process.env.CREDENTIALS_DIRECTORY || Object.keys(process.env).some(k => k.startsWith('WALLET_AUTH_'))) fail('AUTH_AMBIENT_CREDENTIAL_REFUSED');
  const options = {};
  for (let i = 0; i < rest.length; i += 2) { if (!/^--[a-z-]+$/.test(rest[i] ?? '') || !rest[i + 1] || Object.hasOwn(options, rest[i])) fail('AUTH_INSTALL_ARGUMENT_REFUSED'); options[rest[i]] = rest[i + 1]; }
  const required = ['package', 'node', 'tenant', 'origin', 'source-commit', 'legacy-source', 'legacy-service', 'legacy-config', 'legacy-key', 'legacy-state', 'legacy-proxy', 'nginx-site'];
  const allowed = command === 'resume' ? ['tenant'] : [...required, 'legacy-node', 'allow-empty-state', 'legacy-node-policy', 'legacy-image-baseline', 'legacy-image-baseline-sha256', 'empty-state-evidence', 'empty-state-evidence-sha256', 'activation-evidence'];
  if (!['check', 'migrate', 'resume'].includes(command) || Object.keys(options).some(k => !allowed.includes(k.slice(2))) || (command !== 'resume' && required.some(k => !options[`--${k}`])) || options['--allow-empty-state'] && options['--allow-empty-state'] !== 'yes') fail('AUTH_INSTALL_ARGUMENT_REFUSED');
  const o = Object.fromEntries(Object.entries(options).map(([k, v]) => [k.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase()), v]));
  o.packageDirectory = o.package; delete o.package; o.allowEmptyState = o.allowEmptyState === 'yes';
  if (command === 'check') { output.write(JSON.stringify((await inspectLegacy(o)).summary) + '\n'); return; }
  if (!input.isTTY || !output.isTTY) fail('AUTH_TRUSTED_TERMINAL_REQUIRED');
  const prompt = createInterface({ input, output });
  try {
    const aliasMode = o.legacyNodePolicy === ALIAS_MODE || command === 'resume' && await exists(join(paths('', o.tenant).root, 'legacy-alias-migration.json'));
    o.confirm = await prompt.question(aliasMode
      ? 'This fences and stops only the bound legacy service. Its shared Node is observed, NEVER trusted/executed. After fencing, recovery may require continued downtime and NEVER restarts legacy code or restores old ciphertext. Existing key is preserved; no initialization. Approved for this forward-only transition? Type MIGRATE-PR58-FORWARD-ONLY: '
      : 'This stops only the specified service, privately backs up existing credentials, and changes its systemd/proxy transport. After the new runtime starts, recovery is forward-only; old code/ciphertext will NEVER be restored. Approved to proceed? Type MIGRATE-PR58-FORWARD-ONLY: ');
    output.write(JSON.stringify(command === 'resume' ? await resumeLegacy(o) : await migrateLegacy(o)) + '\n');
  } finally { prompt.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) cli(process.argv.slice(2)).catch(error => { console.error(/^[A-Z0-9_]+$/.test(error.message) ? error.message : 'AUTH_LEGACY_MIGRATION_FAILED'); process.exitCode = 1; });
