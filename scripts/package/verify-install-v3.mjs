/**
 * Prove the V3 candidate installs and works, from outside the repository.
 *
 * Same reason as the V2 verifier: the repository's no-build-step property does
 * not survive packaging, so building is not evidence that it works. This one
 * additionally proves the shipped package tells the truth about its status —
 * a candidate that installs cleanly while presenting itself as accepted would
 * be the worse failure.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.cwd();
const run = (cmd, args, cwd, quiet = true) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: quiet ? 'pipe' : 'inherit' });

execFileSync('node', ['scripts/package/build-v3.mjs'], { cwd: root, stdio: 'inherit' });
const manifest = JSON.parse(readFileSync(join(root, 'dist', 'v3-package-manifest.json'), 'utf8'));
const tarball = join(root, 'dist', 'package-v3', manifest.artifact);

const dir = mkdtempSync(join(tmpdir(), 'erc8415-v3-install-'));
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
import * as root from '8415wallet';
import * as controls from '8415wallet/controls';
import * as store from '8415wallet/controls/node-store';
import * as browser from '8415wallet/browser';
const rootRequired = ['WalletSession','RpcErc8415Reader','buildAssetView','buildTemporalView',
  'buildLinkedChainView','renderLinkedChain','prepareResponsibilityTransition'];
const controlRequired = ['ResponsibilityControlClient','RpcResponsibilityControlReader',
  'NativeResponsibilityPaymentClient','DetachedResponsibilityHistoryClient','ForwardConsentReview',
  'ResponsibilityWalletSession','signForwardConsent'];
const missing = [...rootRequired.filter((n) => typeof root[n] !== 'function'),
  ...controlRequired.filter((n) => typeof controls[n] !== 'function')];
console.log(JSON.stringify({
  rootExports: Object.keys(root).length,
  controlExports: Object.keys(controls).length,
  browserExports: Object.keys(browser).length,
  storeExports: Object.keys(store).length,
  missing,
  disclosure: typeof controls.CONTROL_AUTHORITY_DISCLOSURE === 'string' && controls.CONTROL_AUTHORITY_DISCLOSURE.length > 0,
}));
`);
  const probed = JSON.parse(run('node', [probe], dir).trim().split('\n').at(-1));
  check('imports after install', probed.missing.length === 0,
    `${probed.rootExports} root / ${probed.controlExports} control exports`);
  // Every name an integrator is told to use resolves, and the authority
  // disclosure travels with them; the count is reported, not thresholded, so
  // adding an export is not a failure while losing one is.
  check('control surface complete', probed.missing.length === 0 && probed.disclosure,
    `${probed.controlExports} control exports, authority disclosure present`);
  check('browser entry ships', probed.browserExports > 0, `${probed.browserExports} exports`);
  check('node operation store ships', probed.storeExports > 0);

  const help = run('node', [join(dir, 'node_modules', '8415wallet', 'cli', 'main.js')], dir).toString();
  check('CLI runs from the installed package', help.length > 0);

  // The package must present its own status honestly to whoever installs it.
  const installed = JSON.parse(readFileSync(join(dir, 'node_modules', '8415wallet', 'package.json'), 'utf8'));
  const notice = readFileSync(join(dir, 'node_modules', '8415wallet', 'PACKAGE-V3.md'), 'utf8');
  check('ships as a candidate, not a release',
    installed.version.endsWith('-v3-candidate') && /not independently audited/i.test(installed.description) &&
    notice.includes('NOT_INDEPENDENTLY_AUDITED'),
    installed.version);
  check('ships the boundaries it is integrated against',
    readFileSync(join(dir, 'node_modules', '8415wallet', 'AGENTS.md'), 'utf8').includes('Forbidden Inferences'));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} install checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
