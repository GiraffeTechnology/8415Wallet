/**
 * Prove the V3 candidate installs and works, from outside the repository.
 *
 * It additionally proves the package tells the truth about its status: a
 * candidate that installs cleanly while presenting itself as accepted would be
 * the worse failure.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { builtTarball, verifyInstalled } from './shared.mjs';

const tarball = builtTarball('scripts/package/build-v3.mjs',
  join(process.cwd(), 'dist', 'v3-package-manifest.json'), 'package-v3');

verifyInstalled(tarball, ({ directory, check, shell, packageRoot }) => {
  const probe = join(directory, 'probe.mjs');
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
  const probed = JSON.parse(shell('node', [probe]).trim().split('\n').at(-1));
  check('imports after install', probed.missing.length === 0,
    `${probed.rootExports} root / ${probed.controlExports} control exports`);
  // Every documented name resolves and the authority disclosure travels with
  // them; the count is reported, not thresholded, so adding an export is not a
  // failure while losing one is.
  check('control surface complete', probed.missing.length === 0 && probed.disclosure,
    `${probed.controlExports} control exports, authority disclosure present`);
  check('browser entry ships', probed.browserExports > 0, `${probed.browserExports} exports`);
  check('node operation store ships', probed.storeExports > 0);

  check('CLI runs from the installed package', shell('node', [join(packageRoot, 'cli', 'main.js')]).length > 0);

  const installed = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  const notice = readFileSync(join(packageRoot, 'PACKAGE-V3.md'), 'utf8');
  check('ships as a candidate, not a release',
    installed.version.endsWith('-v3-candidate') && /not independently audited/i.test(installed.description) &&
    notice.includes('NOT_INDEPENDENTLY_AUDITED'),
    installed.version);
  check('ships the boundaries it is integrated against',
    readFileSync(join(packageRoot, 'AGENTS.md'), 'utf8').includes('Forbidden Inferences'));
});
