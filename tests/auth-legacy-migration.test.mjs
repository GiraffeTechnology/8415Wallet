/** Synthetic files and injected host commands only; no production credentials or host changes. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod, symlink, lstat, readlink, unlink, cp } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { paths, inspect, rollback, rollbackCode } from '../deploy/auth-xiongan/install.mjs';
import { LEGACY_COMMIT, inspectLegacy, migrateLegacy, resumeLegacy, cli } from '../deploy/auth-xiongan/migrate-legacy.mjs';
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
