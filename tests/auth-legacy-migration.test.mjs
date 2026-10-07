/** Synthetic files and injected host commands only; no production credentials or host changes. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod, symlink, lstat, readlink, unlink, cp, link, chown } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { paths, inspect, rollback, rollbackCode } from '../deploy/auth-xiongan/install.mjs';
import { LEGACY_COMMIT, inspectLegacy, migrateLegacy, resumeLegacy, cli, observeLegacyAlias } from '../deploy/auth-xiongan/migrate-legacy.mjs';
import { hotp } from '../server/crypto.mjs';
import { openEncryptedStore } from '../server/store.mjs';
import { syntheticPackage } from './helpers/auth-legacy-fixture.mjs';
import { independentNode } from './helpers/independent-node.mjs';
import { fixture, node, uid, tenant, origin, key, record, confirm } from './helpers/auth-legacy-host.mjs';
const hash = b => createHash('sha256').update(b).digest('hex');
async function snapshot(f) { return Promise.all([f.options.legacyConfig, f.options.legacyKey, f.options.legacyState, f.target.unit, f.options.legacyProxy, f.options.nginxSite].map(async p => [p, hash(await readFile(p))])); }

test('PR58 inspection is read-only and never exposes private identities, key or ciphertext hashes', async t => {
  const f = await fixture(t), before = await snapshot(f), r = await inspectLegacy(f.options);
  assert.equal(r.summary.status, 'supported-legacy-awaiting-operator-confirmation'); assert.deepEqual(await snapshot(f), before);
  const out = JSON.stringify(r.summary); for (const secret of ['fixture-user', 'fixture@example.invalid', key.toString('hex'), r.credentialHashes.keySha256, r.credentialHashes.stateSha256]) assert.ok(!out.includes(secret));
  assert.equal(f.calls.some(c => c.includes('stop')), false);
});
test('legacy and candidate executables are independently bound without editing the old unit', async t => {
  const f = await fixture(t), candidate = await independentNode(); t.after(candidate.cleanup);
  const originalUnit = await readFile(f.target.unit);
  f.options.legacyNode = f.options.node; f.options.node = candidate.node;
  const inspected = await inspectLegacy(f.options);
  assert.equal(inspected.legacyNode.path, node.node);
  assert.notEqual(inspected.legacyNode.identity.ino, inspected.nodeIdentity.ino);
  assert.deepEqual(await readFile(f.target.unit), originalUnit);
  await migrateLegacy(f.options);
  const installed = await inspect({ target: f.target, uid });
  assert.equal(installed.receipt.node, candidate.node);
  assert.ok((await readFile(f.target.unit, 'utf8')).includes(`ExecStart=${candidate.node} `));
  const journal = JSON.parse(await readFile(join(f.target.root, 'legacy-migration.json')));
  assert.equal(journal.legacyNode.path, node.node);
  assert.equal(journal.legacyNode.identity.sha256, node.sha256);
});
test('an independently protected but incorrect legacy executable does not authenticate the old unit', async t => {
  const f = await fixture(t), wrong = await independentNode(); t.after(wrong.cleanup);
  await assert.rejects(inspectLegacy({ ...f.options, legacyNode: wrong.node }), /AUTH_LEGACY_UNIT_UNSUPPORTED/);
  assert.equal(f.calls.some(c => c.includes('stop')), false);
});
test('legacy executable aliases remain refused rather than silently rewriting the original unit', async t => {
  const f = await fixture(t), alias = join(f.root, 'legacy-node');
  await symlink(node.node, alias);
  await assert.rejects(inspectLegacy({ ...f.options, legacyNode: alias }), /AUTH_LEGACY_NODE_PROTECTION_REQUIRED/);
  assert.equal(f.calls.some(c => c.includes('stop')), false);
});
test('separate legacy-node does not weaken candidate executable protection', async t => {
  const f = await fixture(t), candidate = await independentNode(); t.after(candidate.cleanup);
  await chmod(candidate.node, 0o777);
  await assert.rejects(inspectLegacy({ ...f.options, legacyNode: node.node, node: candidate.node }), /AUTH_INSTALL_UNSAFE_PATH/);
  assert.equal(f.calls.some(c => c.includes('stop')), false);
});
test('new pre-start recovery refuses a changed separately bound legacy executable', async t => {
  const f = await fixture(t), legacy = await independentNode(); t.after(legacy.cleanup);
  await writeFile(f.target.unit, (await readFile(f.target.unit, 'utf8')).replace(`ExecStart=${node.node} `, `ExecStart=${legacy.node} `));
  f.options.legacyNode = legacy.node;
  f.options.checkpoint = async phase => {
    if (phase === 'receipt-written') {
      await writeFile(legacy.node, 'not the pinned executable');
      throw Error('SYNTHETIC_PRESTART_FAILURE');
    }
  };
  await assert.rejects(migrateLegacy(f.options), /AUTH_LEGACY_PRESTART_RECOVERY_REQUIRED/);
  const starts = f.calls.filter(c => c.includes('start')).length;
  await assert.rejects(resumeLegacy(f.options), /AUTH_LEGACY_NODE_CHANGED/);
  assert.equal(f.calls.filter(c => c.includes('start')).length, starts);
});

async function aliasFixture(t, settings = {}) {
  const f = await fixture(t, settings), legacy = await independentNode(); t.after(legacy.cleanup);
  const alias = join(f.root, 'legacy-alias'); await symlink(legacy.node, alias);
  await writeFile(f.target.unit, (await readFile(f.target.unit, 'utf8')).replace(`ExecStart=${node.node} `, `ExecStart=${alias} `));
  const stat = await lstat(legacy.node), baselinePath = join(f.root, 'independent-image-baseline.json');
  const baseline = { schema: '8415wallet-legacy-image-baseline/1', sourceCommit: LEGACY_COMMIT, aliasPath: alias, resolvedPath: legacy.node,
    sha256: legacy.sha256, uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o7777, size: stat.size, publisherEvidenceSha256: '1'.repeat(64) };
  await writeFile(baselinePath, JSON.stringify(baseline), { mode: 0o600 });
  Object.assign(f.options, { legacyNode: alias, legacyNodePolicy: 'observed-alias-forward-only', legacyImageBaseline: baselinePath, legacyImageBaselineSha256: hash(await readFile(baselinePath)) });
  f.options.observeProcess = async pid => ({ pid: String(pid), startTime: '123', uids: [uid, uid, uid, uid], image: (await observeLegacyAlias({ path: alias, baselinePath, baselineSha256: f.options.legacyImageBaselineSha256 }, uid)).image });
  const originalRun = f.options.run;
  f.options.run = async (file, args) => {
    const out = await originalRun(file, args);
    if (file === 'systemctl' && args[0] === 'show') {
      let dropIn = ''; try { await lstat(join(`${f.target.unit}.d`, '90-legacy-alias-migration.conf')); dropIn = join(`${f.target.unit}.d`, '90-legacy-alias-migration.conf'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      return out.replace('DropInPaths=\n', `DropInPaths=${dropIn}\n`);
    }
    return out;
  };
  return Object.assign(f, { alias, legacy, baseline, baselinePath });
}
async function emptyAliasEvidence(f) {
  const scope = { tenant: f.options.tenant, origin: f.options.origin, sourceCommit: f.options.sourceCommit, statePath: f.options.legacyState };
  const scopeSha256 = hash(Buffer.from(JSON.stringify(scope))), activation = join(f.root, 'original-activation-evidence.json');
  await writeFile(activation, JSON.stringify({ schema: '8415wallet-original-activation-evidence/1', scopeSha256, initializationOutcome: 'complete', passwordProvisioned: false, credentialWrites: 0, enrollmentEvents: 0, unknownOutcomes: 0 }), { mode: 0o600 });
  const confirmation = join(f.root, 'personal-confirmation.json');
  const value = { schema: '8415wallet-never-enrolled-confirmation/1', scopeSha256, activationEvidenceSha256: hash(await readFile(activation)), confirmedAt: 1, userConfirmed: true,
    answers: Object.fromEntries(['password', 'totp', 'recoveryCodes', 'emailOrOtherAccount', 'deletedResetRestoredOrMoved'].map(k => [k, 'NO'])) };
  await writeFile(confirmation, JSON.stringify(value), { mode: 0o600 });
  Object.assign(f.options, { activationEvidence: activation, emptyStateEvidence: confirmation, emptyStateEvidenceSha256: hash(await readFile(confirmation)) });
  return value;
}
test('observed alias migration preserves shared alias/image and installs only the protected candidate', async t => {
  const f = await aliasFixture(t), oldUnit = await readFile(f.target.unit), aliasStat = await lstat(f.alias), oldImage = hash(await readFile(f.legacy.node));
  const preflight = await inspectLegacy(f.options);
  assert.equal(preflight.summary.legacyExecutionTrusted, false); assert.equal(preflight.summary.metadataOnly, true);
  assert.equal(preflight.summary.credentialsAuthenticated, false); assert.equal(preflight.credentialHashes, null);
  const state = await readFile(f.options.legacyState), keyBytes = await readFile(f.options.legacyKey);
  await migrateLegacy(f.options);
  assert.equal((await lstat(f.alias)).ino, aliasStat.ino); assert.equal(await readlink(f.alias), f.legacy.node); assert.equal(hash(await readFile(f.legacy.node)), oldImage);
  const j = JSON.parse(await readFile(join(f.target.root, 'legacy-alias-migration.json')));
  assert.equal(j.schema, '8415wallet-legacy-alias-migration/1'); assert.equal(j.phase, 'complete'); assert.equal(j.candidateStartAttempted, true);
  assert.deepEqual(await readFile(join(j.backup, 'unit')), oldUnit);
  assert.equal((await inspect({ target: f.target, uid })).receipt.node, node.node);
  assert.deepEqual(await readFile(f.options.legacyState), state); assert.deepEqual(await readFile(f.options.legacyKey), keyBytes);
  await assert.rejects(lstat(join(f.target.config, 'legacy-alias-migration.fence')), { code: 'ENOENT' });
  assert.equal((await resumeLegacy(f.options)).status, 'already-imported');
});
test('non-root-owned legacy image remains observational and never becomes candidate authorization', async t => {
  if (uid !== 0) { t.skip('requires isolated root-owned Linux fixture to assign a synthetic legacy owner'); return; }
  const f = await aliasFixture(t);
  await chown(f.legacy.node, 1001, 1001); f.baseline.uid = 1001; f.baseline.gid = 1001;
  await writeFile(f.baselinePath, JSON.stringify(f.baseline)); f.options.legacyImageBaselineSha256 = hash(await readFile(f.baselinePath));
  await migrateLegacy(f.options);
  assert.equal((await lstat(f.legacy.node)).uid, 1001);
  const receipt = (await inspect({ target: f.target, uid })).receipt;
  assert.equal(receipt.nodeUid, 0); assert.equal(receipt.node, node.node);
});
test('alias check does not read/authenticate credential values before confirmed stop', async t => {
  const f = await aliasFixture(t);
  // Invalid same-size bytes prove the metadata check does not parse/decrypt them.
  await writeFile(f.options.legacyKey, 'Z'.repeat(64));
  const before = await snapshot(f), result = await inspectLegacy(f.options);
  assert.equal(result.summary.metadataOnly, true); assert.equal(result.summary.credentialsAuthenticated, false);
  assert.equal(result.credentialHashes, null); assert.deepEqual(await snapshot(f), before);
  assert.equal(f.calls.some(c => c.includes('stop')), false);
  await assert.rejects(migrateLegacy(f.options), /AUTH_LEGACY_ALIAS_FORWARD_RECOVERY_REQUIRED/);
  const j = JSON.parse(await readFile(join(f.target.root, 'legacy-alias-migration.json')));
  assert.equal(j.lastFailure.stableCode, 'AUTH_LEGACY_KEY_FORMAT_REFUSED');
  assert.equal(f.calls.some(c => c.includes('start')), false);
});
for (const [name, mutate, expected] of [
  ['missing independent image baseline', async f => { delete f.options.legacyImageBaseline; }, /INDEPENDENT_EVIDENCE_REQUIRED/],
  ['wrong baseline pin', async f => { f.options.legacyImageBaselineSha256 = '0'.repeat(64); }, /EVIDENCE_PIN_REFUSED/],
  ['changed target bytes', async f => writeFile(f.legacy.node, 'changed'), /BASELINE_MISMATCH/],
  ['target hardlink', async f => link(f.legacy.node, join(f.root, 'extra-image-link')), /IMAGE_REFUSED/],
  ['wrong live image', async f => { f.options.observeProcess = async pid => ({ pid: String(pid), startTime: '123', image: { identity: { dev: 0, ino: 0 }, sha256: '0'.repeat(64) } }); }, /PROCESS_REFUSED/],
  ['insecure candidate', async f => { f.options.node = f.alias; }, /AUTH_INSTALL_UNSAFE_PATH/]
]) test(`alias migration refuses ${name} before stopping`, async t => {
  const f = await aliasFixture(t); await mutate(f);
  await assert.rejects(migrateLegacy(f.options), expected);
  assert.equal(f.calls.some(c => c.includes('stop')), false);
});
test('failure after persistent alias fence never restarts legacy and retains explicit recovery state', async t => {
  const f = await aliasFixture(t);
  f.options.checkpoint = async phase => { if (phase === 'alias-stopped') throw Error('SYNTHETIC_STOPPED_FAILURE'); };
  const keyBytes = await readFile(f.options.legacyKey), state = await readFile(f.options.legacyState);
  await assert.rejects(migrateLegacy(f.options), /AUTH_LEGACY_ALIAS_FORWARD_RECOVERY_REQUIRED/);
  assert.equal(f.calls.some(c => c.includes('start')), false);
  await lstat(join(f.target.config, 'legacy-alias-migration.fence'));
  assert.match(await readFile(join(`${f.target.unit}.d`, '90-legacy-alias-migration.conf'), 'utf8'), /ConditionPathExists=!/);
  await assert.rejects(resumeLegacy(f.options), /AUTH_LEGACY_ALIAS_PRESTART_REVIEW_REQUIRED/);
  assert.deepEqual(await readFile(f.options.legacyKey), keyBytes); assert.deepEqual(await readFile(f.options.legacyState), state);
});
test('alias probe failure resumes candidate forward without restoring consumed counters', async t => {
  const f = await aliasFixture(t); f.options.probe = async () => { throw Error('SYNTHETIC_PROBE_FAILURE'); };
  await assert.rejects(migrateLegacy(f.options), /AUTH_LEGACY_ALIAS_FORWARD_RECOVERY_REQUIRED/);
  const advanced = { ...record, lastStep: 92346, recoveryHashes: [] }, store = await openEncryptedStore(f.options.legacyState, key);
  await store.transaction('xiongan:fixture-user', () => advanced); await store.close();
  const bytes = await readFile(f.options.legacyState);
  assert.equal((await resumeLegacy({ ...f.options, probe: async () => {} })).status, 'legacy-imported-proxy-enabled');
  assert.deepEqual(await readFile(f.options.legacyState), bytes);
});
test('changed alias fence refuses candidate start and retains original credential bytes', async t => {
  const f = await aliasFixture(t), state = await readFile(f.options.legacyState), keyBytes = await readFile(f.options.legacyKey);
  f.options.checkpoint = async phase => {
    if (phase === 'receipt-written') await writeFile(join(f.target.config, 'legacy-alias-migration.fence'), '{"changed":true}');
  };
  await assert.rejects(migrateLegacy(f.options), /AUTH_LEGACY_ALIAS_FORWARD_RECOVERY_REQUIRED/);
  const j = JSON.parse(await readFile(join(f.target.root, 'legacy-alias-migration.json')));
  assert.equal(j.lastFailure.stableCode, 'AUTH_LEGACY_ALIAS_FENCE_CHANGED');
  assert.equal(f.calls.some(c => c.includes('start')), false);
  assert.deepEqual(await readFile(f.options.legacyState), state); assert.deepEqual(await readFile(f.options.legacyKey), keyBytes);
});
test('an extra task-owned-directory drop-in is never accepted as part of the alias fence', async t => {
  const f = await aliasFixture(t);
  f.options.checkpoint = async phase => {
    if (phase === 'receipt-written') await writeFile(join(`${f.target.unit}.d`, 'extra.conf'), '[Service]\nEnvironment=UNREVIEWED=yes\n');
  };
  await assert.rejects(migrateLegacy(f.options), /AUTH_LEGACY_ALIAS_FORWARD_RECOVERY_REQUIRED/);
  const j = JSON.parse(await readFile(join(f.target.root, 'legacy-alias-migration.json')));
  assert.equal(j.lastFailure.stableCode, 'AUTH_LEGACY_ALIAS_FENCE_CHANGED');
  assert.equal(f.calls.some(c => c.includes('start')), false);
});
test('absent state without corroborated personal evidence refuses before stop', async t => {
  const f = await aliasFixture(t, { empty: true });
  await assert.rejects(migrateLegacy(f.options), /EMPTY_STATE_REVIEW_REQUIRED/);
  assert.equal(f.calls.some(c => c.includes('stop')), false);
});
for (const answer of ['YES', 'UNKNOWN']) test(`empty alias state refuses personal ${answer} even with pinned records`, async t => {
  const f = await aliasFixture(t, { empty: true }), proof = await emptyAliasEvidence(f);
  proof.answers.totp = answer;
  await writeFile(f.options.emptyStateEvidence, JSON.stringify(proof)); f.options.emptyStateEvidenceSha256 = hash(await readFile(f.options.emptyStateEvidence));
  await assert.rejects(migrateLegacy(f.options), /EMPTY_STATE_REVIEW_REQUIRED/);
  assert.equal(f.calls.some(c => c.includes('stop')), false);
});
test('corroborated synthetic empty-state migration preserves original key and creates no ciphertext', async t => {
  const f = await aliasFixture(t, { empty: true }); await emptyAliasEvidence(f);
  const keyBytes = await readFile(f.options.legacyKey); await migrateLegacy(f.options);
  assert.deepEqual(await readFile(f.options.legacyKey), keyBytes); await assert.rejects(lstat(f.options.legacyState), { code: 'ENOENT' });
});
test('empty-state declaration without original activation corroboration is not sufficient', async t => {
  const f = await aliasFixture(t, { empty: true }); await emptyAliasEvidence(f);
  await unlink(f.options.activationEvidence);
  await assert.rejects(migrateLegacy(f.options)); assert.equal(f.calls.some(c => c.includes('stop')), false);
});
test('late nonempty state is preserved and validated, never replaced with empty state', async t => {
  const f = await aliasFixture(t, { empty: true }); await emptyAliasEvidence(f);
  let late;
  f.options.checkpoint = async phase => {
    if (phase === 'alias-stopped') {
      const store = await openEncryptedStore(f.options.legacyState, key);
      await store.transaction('xiongan:fixture-user', () => record);
      await store.transaction('@registration:xiongan', () => ({ version: 1, records: [{ username: 'fixture-user', email: 'fixture@example.invalid', verifiedAt: 42 }] })); await store.close();
      late = await readFile(f.options.legacyState);
    }
  };
  await migrateLegacy(f.options); assert.deepEqual(await readFile(f.options.legacyState), late);
});
test('migration preserves every credential byte and backup; creates a genuine generation-2 receipt without initialization', async t => {
  const f = await fixture(t), before = await snapshot(f), state = await readFile(f.options.legacyState), keyBytes = await readFile(f.options.legacyKey);
  const result = await migrateLegacy(f.options); assert.equal(result.status, 'legacy-imported-proxy-enabled');
  assert.deepEqual(await readFile(f.options.legacyState), state); assert.deepEqual(await readFile(f.options.legacyKey), keyBytes);
  assert.deepEqual(await readFile(join(f.target.root, 'legacy-backup/state')), state); assert.deepEqual(await readFile(join(f.target.root, 'legacy-backup/key')), keyBytes);
  const store = await openEncryptedStore(f.options.legacyState, key); assert.deepEqual(await store.read('xiongan:fixture-user'), record); await store.close();
  const installed = await inspect({ target: f.target, uid }); assert.equal(installed.receipt.status, 'proxy-enabled'); assert.equal(installed.receipt.legacyImport.sourceCommit, LEGACY_COMMIT);
  assert.equal(installed.config.port, undefined); assert.deepEqual(installed.config.accounts, f.config.accounts); assert.equal(installed.config.mail.transport, 'disabled');
  assert.equal(hash(await readFile(f.options.nginxSite)), before.at(-1)[1]); assert.match(await readFile(f.options.legacyProxy, 'utf8'), /http:\/\/unix:/);
  assert.match(await readFile(f.target.unit, 'utf8'), /RestrictAddressFamilies=AF_UNIX/); assert.equal((await lstat(join(f.target.root, 'legacy-backup'))).mode & 0o777, 0o700);
  await assert.rejects(migrateLegacy(f.options), /EXISTING_RECEIPT/); const resumed = await resumeLegacy(f.options); assert.equal(resumed.status, 'already-imported');
  await assert.rejects(rollback({ target: f.target, uid, run: f.options.run }), /LEGACY_FORWARD_ONLY/); await assert.rejects(rollbackCode({ target: f.target, uid, run: f.options.run }), /NO_CODE_ROLLBACK/);
});
test('no credential state is invented for a previously wallet-only empty store', async t => {
  const f = await fixture(t, { empty: true }); await assert.rejects(inspectLegacy({ ...f.options, allowEmptyState: false }), /EMPTY_STATE/);
  await migrateLegacy(f.options); await assert.rejects(lstat(f.options.legacyState), { code: 'ENOENT' });
  const journal = JSON.parse(await readFile(join(f.target.root, 'legacy-migration.json'))); assert.equal(journal.credentials.stateSha256, null); assert.equal(journal.before.state, undefined);
});
for (const [label, mutate, expected] of [
  ['source mismatch', async f => writeFile(join(f.options.legacySource, 'server/main.mjs'), '// tampered'), /UNSUPPORTED_SOURCE/],
  ['different tenant', async f => { f.options.tenant = 'platform'; }, /EXPLICIT_BINDING/],
  ['config origin drift', async f => { f.options.origin = 'https://other.example.invalid'; }, /CONFIG_UNSUPPORTED/],
  ['unknown service', async f => { f.options.legacyService = 'unrelated.service'; }, /EXPLICIT_BINDING/],
  ['credential source guess', async f => { f.options.legacyKey += '.other'; }, /EXPLICIT_BINDING/],
  ['unit override', async f => writeFile(f.target.unit, (await readFile(f.target.unit)) + '\nEnvironment=UNREVIEWED=yes\n'), /UNIT_UNSUPPORTED/],
  ['drop-in', async f => { f.host.dropIns = '/etc/example.conf'; }, /OVERRIDE_OR_STATE/],
  ['shared proxy', async f => { f.host.shared = true; }, /SHARED_PROXY/],
  ['private file mode', async f => chmod(f.options.legacyKey, 0o644), /UNSAFE_PATH/],
  ['symlink credential', async f => { await cp(f.options.legacyKey, f.options.legacyKey + '.orig'); await unlink(f.options.legacyKey); await symlink(f.options.legacyKey + '.orig', f.options.legacyKey); }, /UNSAFE_PATH/],
  ['unsupported state envelope', async f => writeFile(f.options.legacyState, '{"version":2}'), /STATE_FORMAT/],
  ['missing confirmation', async f => { f.options.confirm = ''; }, /CONFIRMATION/]
]) test(`refuses ${label} without stopping services`, async t => { const f = await fixture(t); await mutate(f); await assert.rejects(migrateLegacy(f.options), expected); assert.equal(f.calls.some(c => c.includes('stop')), false); });
test('a live or leftover state writer lock is retained and never treated as stale', async t => {
  const f = await fixture(t); await writeFile(f.options.legacyState + '.lock', 'synthetic prior writer', { mode: 0o600 });
  await assert.rejects(migrateLegacy(f.options), { code: 'EEXIST' }); assert.equal(await readFile(f.options.legacyState + '.lock', 'utf8'), 'synthetic prior writer');
  assert.equal(f.calls.some(c => c.includes('start')), false); await assert.rejects(lstat(join(f.target.root, 'installation.json')), { code: 'ENOENT' });
});
test('inactive with a remaining process is refused before snapshots or writes', async t => {
  const f = await fixture(t); f.host.runningPid = 99; const before = await snapshot(f); await assert.rejects(migrateLegacy(f.options), /STOP_NOT_CONFIRMED/); assert.deepEqual(await snapshot(f), before);
});
test('failure before candidate start restores old config/unit/current without touching counters', async t => {
  const f = await fixture(t), before = await snapshot(f); let once = false;
  f.host.fail = (file, args) => file === 'systemctl' && args[0] === 'daemon-reload' && !once && (once = true);
  await assert.rejects(migrateLegacy(f.options), /SYNTHETIC_HOST_FAILURE/); assert.deepEqual(await snapshot(f), before); assert.equal(await readlink(join(f.target.root, 'current')), f.options.legacySource);
  assert.equal(f.active(), true); assert.equal(JSON.parse(await readFile(join(f.target.root, 'legacy-migration.json'))).candidateStartAttempted, false);
  assert.equal((await resumeLegacy(f.options)).retryMigration, true);
  assert.equal((await migrateLegacy(f.options)).status, 'legacy-imported-proxy-enabled');
});
for (const phase of ['start', 'probe', 'nginx-test', 'nginx-reload']) test(`forward recovery after ${phase} failure never restarts old code or restores consumed counters`, async t => {
  const f = await fixture(t); let once = false;
  f.host.fail = (file, args) => !once && ((phase === 'start' && args[0] === 'start') || (phase === 'nginx-test' && file === 'nginx' && args[0] === '-t') || (phase === 'nginx-reload' && args[0] === 'reload')) && (once = true);
  if (phase === 'probe') f.options.probe = async () => { throw Error('SYNTHETIC_PROBE_FAILURE'); };
  const oldCiphertext = await readFile(f.options.legacyState); await assert.rejects(migrateLegacy(f.options), /FORWARD_RECOVERY_REQUIRED/);
  assert.notEqual(await readlink(join(f.target.root, 'current')), f.options.legacySource); assert.equal(f.active(), false);
  await lstat(join(f.target.root, 'operation.lock'));
  const s = await openEncryptedStore(f.options.legacyState, key); const advanced = { ...record, lastStep: 92346, recoveryHashes: [] }; await s.transaction('xiongan:fixture-user', () => advanced); await s.close();
  const current = await readFile(f.options.legacyState); assert.notDeepEqual(current, oldCiphertext);
  const r = await resumeLegacy({ ...f.options, probe: async () => {} }); assert.equal(r.status, 'legacy-imported-proxy-enabled'); assert.deepEqual(await readFile(f.options.legacyState), current);
  const state = await openEncryptedStore(f.options.legacyState, key); assert.deepEqual(await state.read('xiongan:fixture-user'), advanced); await state.close();
  assert.equal((await inspect({ target: f.target, uid })).receipt.status, 'proxy-enabled');
});
test('forward recovery refuses damaged backup and competing recovery lock', async t => {
  const f = await fixture(t); f.options.probe = async () => { throw Error('FAIL'); }; await assert.rejects(migrateLegacy(f.options), /FORWARD_RECOVERY/);
  await writeFile(join(f.target.root, 'legacy-resume.lock'), 'active', { mode: 0o600 }); await assert.rejects(resumeLegacy(f.options), { code: 'EEXIST' }); await unlink(join(f.target.root, 'legacy-resume.lock'));
  await writeFile(join(f.target.root, 'legacy-backup/state'), 'changed'); await assert.rejects(resumeLegacy(f.options), /SNAPSHOT_CHANGED/);
});
test('help is secret-free and does not accept a command-line confirmation bypass', async () => {
  let text = ''; await cli(['--help'], {}, { write: s => { text += s; } }); assert.match(text, /trusted terminal/); assert.ok(!text.includes('--confirm'));
});
for (const damage of ['missing', 'corrupt', 'foreign']) test(`resume rejects ${damage} current state without using old backup`, async t => {
  const f = await fixture(t); f.options.probe = async () => { throw Error('FAIL'); }; await assert.rejects(migrateLegacy(f.options), /FORWARD_RECOVERY/);
  if (damage === 'missing') await unlink(f.options.legacyState);
  if (damage === 'corrupt') await writeFile(f.options.legacyState, '{"version":1,"iv":"AAAAAAAAAAAAAAAA","tag":"AAAAAAAAAAAAAAAAAAAAAA==","data":"AAAA"}');
  if (damage === 'foreign') { const s = await openEncryptedStore(f.options.legacyState, key); await s.transaction('another:fixture-user', () => record); await s.close(); }
  const starts = f.calls.filter(c => c.includes('start')).length;
  await assert.rejects(resumeLegacy({ ...f.options, probe: async () => {} }), /FORWARD_RECOVERY/);
  assert.equal(f.calls.filter(c => c.includes('start')).length, starts); await lstat(join(f.target.root, 'operation.lock'));
});
test('wrong key and cross-tenant ciphertext fail before service stop', async t => {
  const f = await fixture(t); await writeFile(f.options.legacyKey, Buffer.alloc(32, 0x33).toString('hex'));
  await assert.rejects(migrateLegacy(f.options), /STATE_AUTHENTICATION/); assert.equal(f.calls.some(c => c.includes('stop')), false);
});
test('a commented include cannot masquerade as the selected live auth route', async t => {
  const f = await fixture(t); await writeFile(f.options.nginxSite, (await readFile(f.options.nginxSite, 'utf8')).replace('include ', '\n# include '));
  await assert.rejects(migrateLegacy(f.options), /SHARED_PROXY|NGINX/); assert.equal(f.calls.some(c => c.includes('stop')), false);
});
test('systemd directive line boundaries are part of the supported unit identity', async t => {
  const f = await fixture(t); await writeFile(f.target.unit, (await readFile(f.target.unit, 'utf8')).replace('User=root\nGroup=root', 'User=root Group=root'));
  await assert.rejects(migrateLegacy(f.options), /UNIT_UNSUPPORTED/); assert.equal(f.calls.some(c => c.includes('stop')), false);
});
for (const phase of ['snapshot-copied', 'fence-written', 'release-copied', 'snippet-written', 'config-written', 'unit-written', 'current-switched', 'receipt-written']) test(`failure at ${phase} preserves original credentials and permits a fresh verified migration`, async t => {
  const f = await fixture(t), before = await snapshot(f); let failed = false;
  f.options.checkpoint = async point => { if (point === phase && !failed) { failed = true; throw Error('SYNTHETIC_WRITE_FAILURE'); } };
  await assert.rejects(migrateLegacy(f.options), /SYNTHETIC_WRITE_FAILURE/); assert.deepEqual(await snapshot(f), before);
  assert.equal(await readlink(join(f.target.root, 'current')), f.options.legacySource);
  await assert.rejects(lstat(join(f.target.config, 'migration-config.lock')), { code: 'ENOENT' });
  assert.equal((await migrateLegacy(f.options)).status, 'legacy-imported-proxy-enabled');
});
test('candidate protocol must declare its persistent migration startup fence', async t => {
  const f = await fixture(t); const raw = await readFile(join(f.options.packageDirectory, 'server/runtime-entry.mjs'), 'utf8');
  assert.match(raw, /migration-config\.lock/);
  const release = JSON.parse(await readFile(join(f.options.packageDirectory, 'AUTH-RELEASE.json'))); assert.equal(release.runtime.legacyImportProtocol, 1);
});

test('synthetic legacy authenticator uses the supported full-length RFC fixture', () => {
  assert.equal(hotp(record.secret, 0), '755224');
});

test('importer does not impose a product-wide TCP port reservation', async t => {
  const f = await fixture(t); f.config.port = 443;
  await writeFile(f.options.legacyConfig, JSON.stringify(f.config));
  await writeFile(f.options.legacyProxy, (await readFile(f.options.legacyProxy, 'utf8')).replace('127.0.0.1:18587', '127.0.0.1:443'));
  assert.equal((await inspectLegacy(f.options)).summary.status, 'supported-legacy-awaiting-operator-confirmation');
  assert.equal(f.calls.some(c => c.includes('stop')), false);
});
