/** Prove the V2 package installs and works, from outside the repository. */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { builtTarball, verifyInstalled } from './shared.mjs';

const tarball = builtTarball('scripts/package/build-v2.mjs',
  join(process.cwd(), 'dist', 'v2-package-manifest.json'), 'package');

verifyInstalled(tarball, ({ directory, check, shell }) => {
  const probe = join(directory, 'probe.mjs');
  writeFileSync(probe, `
import * as w from '8415wallet';
const required = ['WalletSession','RpcErc8415Reader','HttpCallTransport','Eip1193Signer',
  'buildAssetView','buildTemporalView','buildEscrowView','describeRegistration','buildBeginSettlement'];
const missing = required.filter((n) => typeof w[n] !== 'function');
const leaked = ['prepareResponsibilityTransition','buildLinkedChainView','renderLinkedChain']
  .filter((n) => n in w);
console.log(JSON.stringify({ exports: Object.keys(w).length, missing, leaked }));
`);
  const out = JSON.parse(shell('node', [probe]).trim());
  check('imports after install', true, `${out.exports} exports`);
  check('V2 surface complete', out.missing.length === 0, out.missing.join(', '));
  check('unaudited v3 surface absent', out.leaked.length === 0, out.leaked.join(', '));

  const cli = shell(join(directory, 'node_modules', '.bin', '8415wallet'), []);
  check('CLI runs the bundled scenarios', cli.includes('TRADEABLE POSITION') && cli.includes('CONFIRMED HOLDER'));
  check('CLI keeps the two facts apart', !/\bOWNER\b.*confirmed holder/i.test(cli));
});
