/**
 * Prove the package installs and works, from outside the repository.
 *
 * This exists because the repository's own no-build-step property does not
 * survive packaging, and nothing else catches it: a tarball of .ts files packs
 * cleanly, installs cleanly, and then cannot be imported at all, because Node
 * refuses to strip types under node_modules. Building the package is not
 * evidence that it works; installing it is.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.cwd();
const run = (cmd, args, cwd, quiet = true) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: quiet ? 'pipe' : 'inherit' });

execFileSync('node', ['scripts/package/build-v2.mjs'], { cwd: root, stdio: 'inherit' });
const manifest = JSON.parse(readFileSync(join(root, 'dist', 'v2-package-manifest.json'), 'utf8'));
const tarball = join(root, 'dist', 'package', manifest.artifact);

const dir = mkdtempSync(join(tmpdir(), 'erc8415-install-'));
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

try {
  writeFileSync(join(dir, 'package.json'), '{"name":"consumer","private":true,"type":"module"}\n');
  run('npm', ['install', tarball], dir);
  check('installs from the tarball', true);

  const deps = run('npm', ['ls', '--all', '--parseable'], dir).trim().split('\n').length - 1;
  check('no runtime dependencies', deps === 1, `${deps} installed package(s)`);

  const probe = join(dir, 'probe.mjs');
  writeFileSync(probe, `
import * as w from '8415wallet';
const required = ['WalletSession','RpcErc8415Reader','HttpCallTransport','Eip1193Signer',
  'buildAssetView','buildTemporalView','buildEscrowView','describeRegistration','buildBeginSettlement'];
const missing = required.filter((n) => typeof w[n] !== 'function');
const leaked = ['prepareResponsibilityTransition','buildLinkedChainView','renderLinkedChain']
  .filter((n) => n in w);
console.log(JSON.stringify({ exports: Object.keys(w).length, missing, leaked }));
`);
  const out = JSON.parse(run('node', [probe], dir).trim());
  check('imports after install', true, `${out.exports} exports`);
  check('V2 surface complete', out.missing.length === 0, out.missing.join(', '));
  check('unaudited v3 surface absent', out.leaked.length === 0, out.leaked.join(', '));

  const cli = run(join(dir, 'node_modules', '.bin', '8415wallet'), [], dir);
  check('CLI runs the bundled scenarios', cli.includes('TRADEABLE POSITION') && cli.includes('CONFIRMED HOLDER'));
  check('CLI keeps the two facts apart', !/\bOWNER\b.*confirmed holder/i.test(cli));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} install checks passed`);
if (failed.length > 0) process.exit(1);
