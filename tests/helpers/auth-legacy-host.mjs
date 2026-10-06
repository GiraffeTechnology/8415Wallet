import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod, symlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { paths } from '../../deploy/auth-xiongan/install.mjs';
import { LEGACY_COMMIT } from '../../deploy/auth-xiongan/migrate-legacy.mjs';
import { openEncryptedStore } from '../../server/store.mjs';
import { syntheticPackage } from './auth-legacy-fixture.mjs';
import { independentNode } from './independent-node.mjs';
import { after } from 'node:test';
export const node = await independentNode(); after(() => node.cleanup());
export const uid = process.getuid(), tenant = 'xiongan', origin = 'https://migration.example.invalid:19447';
const hash = b => createHash('sha256').update(b).digest('hex');
export const key = Buffer.alloc(32, 0x52);
export const record = { secret: 'JBSWY3DPEHPK3PXP', lastStep: 92345, recoverySalt: 'synthetic-salt', recoveryHashes: ['a'.repeat(64)], revision: 3, enabledMethods: ['wallet', 'totp', 'password'], registration: { version: 1, email: 'fixture@example.invalid', verifiedAt: 42 } };
export const confirm = 'MIGRATE-PR58-FORWARD-ONLY';
export async function fixture(t, { empty = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'wal-mig-')); t.after(() => rm(root, { recursive: true, force: true }));
  const target = paths(join(root, 'h'), tenant), legacySource = join(target.root, 'legacy-release');
  for (const dir of [target.root, target.config, target.state, dirname(target.unit), join(root, 'nginx'), legacySource]) await mkdir(dir, { recursive: true, mode: dir === target.config || dir === target.state ? 0o700 : 0o755 });
  await chmod(target.config, 0o700); await chmod(target.state, 0o700);
  const archive = new URL('../fixtures/auth-pr58-source.tar.gz', import.meta.url);
  assert.equal(hash(await readFile(archive)), '0cadf4a479f5629813bd01e8df9d2ffbbafbdb10be050a1ad3eb27577e7aadc7');
  execFileSync('tar', ['xzf', archive.pathname, '-C', legacySource]);
  await symlink(legacySource, join(target.root, 'current'));
  const legacyConfig = join(target.config, 'auth.json'), legacyKey = join(target.config, 'store-key'), legacyState = join(target.state, 'credentials.enc');
  const config = { origin, tenant, port: 18587, statePath: legacyState, accounts: [{ username: 'fixture-user', wallets: [{ account: `0x${'1'.repeat(40)}`, chainId: '8453' }] }] };
  await writeFile(legacyConfig, JSON.stringify(config), { mode: 0o600 }); await writeFile(legacyKey, key.toString('hex') + '\n', { mode: 0o600 });
  if (!empty) { const s = await openEncryptedStore(legacyState, key); await s.transaction('xiongan:fixture-user', () => record); await s.transaction('@registration:xiongan', () => ({ version: 1, records: [{ username: 'fixture-user', email: 'fixture@example.invalid', verifiedAt: 42 }] })); await s.close(); }
  let unit = await readFile(join(legacySource, 'deploy/auth-xiongan/8415wallet-auth-xiongan.service'), 'utf8');
  unit = unit.replace('ExecStart=/usr/bin/node', `ExecStart=${node.node}`).replace('WorkingDirectory=/opt/8415wallet-auth-xiongan/current', `WorkingDirectory=${join(target.root, 'current')}`);
  await writeFile(target.unit, unit, { mode: 0o644 });
  const legacyProxy = join(root, 'nginx', 'old-auth.conf'), nginxSite = join(root, 'nginx', 'site.conf'), nginxMain = join(root, 'nginx', 'nginx.conf');
  await writeFile(nginxMain, `events {} http { include ${nginxSite}; }\n`, { mode: 0o644 });
  await writeFile(legacyProxy, (await readFile(join(legacySource, 'deploy/auth-xiongan/auth-location.nginx.conf'), 'utf8')).replace('127.0.0.1:18417', `127.0.0.1:${config.port}`), { mode: 0o644 });
  await writeFile(nginxSite, `server { listen 19447 ssl; server_name migration.example.invalid; include ${legacyProxy}; location /web/ { root /srv/fixture; } }\n`, { mode: 0o644 });
  let active = true; const calls = [], host = { fail: null, dropIns: '', shared: false, runningPid: null };
  const run = async (file, args) => {
    calls.push([file, ...args]);
    if (host.fail?.(file, args)) throw Error('SYNTHETIC_HOST_FAILURE');
    if (file === 'nginx' && args[0] === '-T') {
      if (host.shared) await writeFile(nginxMain, `events {} http { include ${nginxSite}; include ${nginxSite}; }\n`);
      let dump = ''; for (const p of [nginxMain, nginxSite, legacyProxy]) dump += `# configuration file ${p}:\n${await readFile(p, 'utf8')}\n`; return dump;
    }
    if (args[0] === 'show') return `FragmentPath=${target.unit}\nDropInPaths=${host.dropIns}\nActiveState=${active ? 'active' : 'inactive'}\nSubState=${active ? 'running' : 'dead'}\nMainPID=${host.runningPid ?? (active ? 100 : 0)}\nUnitFileState=enabled\n`;
    if (args[0] === 'stop') active = false;
    if (args[0] === 'start') active = true;
    return '';
  };
  const options = { packageDirectory: syntheticPackage(root), node: node.node, nodeUid: node.uid, uid, tenant, origin, sourceCommit: LEGACY_COMMIT, legacySource, legacyService: target.unitName, legacyConfig, legacyKey, legacyState, legacyProxy, nginxSite, target, run, probe: async () => {}, confirm, allowEmptyState: empty };
  return { root, target, config, options, calls, host, active: () => active };
}
