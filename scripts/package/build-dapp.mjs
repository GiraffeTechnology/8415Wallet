/** Build distinct static Beta artifacts; SDK npm tarballs use separate commands. */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { RELEASE_PROFILES, RELEASE_STATUS, resolveReleaseProfile } from '../../web/release-profile.mjs';
import { captureSource, deterministicArchive, exportSource, sha256, stagePublicWeb, validateStaticTree, walk } from './dapp-release.mjs';

import { buildLoginVendor } from './build-login-vendor.mjs';

const root = process.cwd();
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  if (!['--profile', '--config'].includes(key) || !process.argv[i + 1] || options[key]) throw new Error('DAPP_ARGUMENT_REFUSED');
  options[key] = process.argv[i + 1];
}
const id = options['--profile'] ?? 'v3';
if (!Object.hasOwn(RELEASE_PROFILES, id)) throw new Error('DAPP_PROFILE_REFUSED');
const configPath = options['--config'] ? resolve(root, options['--config']) : join(root, 'config', 'releases', `${id}.json`);
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const profile = resolveReleaseProfile(config);
if (profile.id !== id) throw new Error('DAPP_CONFIG_PROFILE_MISMATCH');
const source = captureSource(root);
const prdPath = 'docs/ERC-8415-Wallet-PRD.md';
if (!source.files[prdPath]) throw new Error('DAPP_PRD_MISSING');
for (const tree of ['src', 'web']) {
  for (const file of walk(root, tree)) if (!Object.hasOwn(source.files, file)) throw new Error(`DAPP_UNTRACKED_SOURCE_STAGE_REQUIRED: ${file}`);
}
for (const file of ['docs/BETA-DAPP-DELIVERY.md', 'docs/BETA-PRD-COVERAGE.md', 'docs/STANDARDS-COMPATIBILITY.md', 'docs/WALLET-LOGIN.md', 'docs/ACCOUNT-AUTHENTICATION.md', 'docs/APPROVED-UI-IMPLEMENTATION.md', 'docs/TENANT-AVATAR.md', 'docs/stages/LEGACY-CLEARING-BETA-DAPP.md']) {
  if (!Object.hasOwn(source.files, file)) throw new Error(`DAPP_UNTRACKED_SOURCE_STAGE_REQUIRED: ${file}`);
}
// Clear output first: removed source modules must never survive a prior emit.
rmSync(join(root, 'dist/browser'), { recursive: true, force: true });
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.browser.json'], { cwd: root, stdio: 'inherit' });
buildLoginVendor(root);
const stage = join(root, 'dist', `package-dapp-${id}`);
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
stagePublicWeb(root, source, stage);
cpSync(join(root, 'dist/browser'), join(stage, 'dist/browser'), { recursive: true });
writeFileSync(join(stage, 'web/release-config.json'), `${JSON.stringify(config, null, 2)}\n`);
for (const file of [prdPath, 'docs/BETA-DAPP-DELIVERY.md', 'docs/BETA-PRD-COVERAGE.md', 'docs/STANDARDS-COMPATIBILITY.md', 'docs/WALLET-LOGIN.md', 'docs/ACCOUNT-AUTHENTICATION.md', 'docs/APPROVED-UI-IMPLEMENTATION.md', 'docs/TENANT-AVATAR.md', 'docs/stages/LEGACY-CLEARING-BETA-DAPP.md']) {
  mkdirSync(join(stage, dirname(file)), { recursive: true }); cpSync(join(root, file), join(stage, file));
}
if (captureSource(root).tree !== source.tree) throw new Error('DAPP_SOURCE_CHANGED_DURING_BUILD');
const validation = validateStaticTree(stage);
const runtimeFiles = Object.fromEntries(validation.files.map(file => [file, sha256(readFileSync(join(stage, file)))]));
const sourceArtifact = `8415wallet-source-${source.tree}.tar.gz`;
const sourceSha256 = exportSource(root, source, join(root, 'dist', sourceArtifact));
const { entries, ...sourceIdentity } = source;
const release = {
  schema: '8415wallet-dapp-release/2', name: `8415wallet-dapp-${id}`, product: '8415wallet', platform: '8415wallet.com',
  description: 'General-purpose wallet with existing wallet and asset standards compatibility and native ERC-8415 support',
  profile: id, version: profile.version, status: RELEASE_STATUS, tenant: profile.tenant, deployment: profile.deployment,
  entry: 'web/index.html', prd: { file: prdPath, sha256: source.files[prdPath], ...profile.prd },
  features: profile.features, source: sourceIdentity, sourceArchive: { artifact: sourceArtifact, sha256: sourceSha256 },
  toolchain: { node: process.version, typescript: JSON.parse(readFileSync(join(root, 'node_modules/typescript/package.json'), 'utf8')).version,
    lockfileSha256: sha256(readFileSync(join(root, 'package-lock.json'))) },
  build: { installCommand: 'npm ci', browserCommand: 'npm run wallet:browser:build',
    packageCommand: `npm run pack:dapp:${id} -- --config dist/release-input/${id}.json`,
    configurationPreparation: `Copy this artifact's web/release-config.json to the verified source checkout at dist/release-input/${id}.json before the package command. The dist directory is excluded from the source content tree.`,
    configSha256: sha256(readFileSync(join(stage, 'web/release-config.json'))),
    archiveFormat: 'GNU tar, sorted paths, epoch mtime, owner/group 0, normalized permissions; gzip -9 -n' },
  validation: { files: validation.files.length, relativeImports: validation.relativeImports, pageAssets: validation.pageAssets },
  runtimeFiles,
  evidence: { package: 'static module/asset resolution and file integrity only',
    localMock: 'record separately; not genuine-wallet or deployed acceptance', localEvm: 'record separately; not public-testnet acceptance',
    publicTestnet: 'not established by packaging', deviceJourneys: 'not established by packaging',
    W20: id === 'v3' ? 'requires deployed same-token multi-wallet UI journey, with funded and unfunded variants' : 'not part of V2 foundation',
    independentReview: 'not independently audited; functional Beta publication is permitted, general release acceptance is not established' },
  scope: { login: 'Verified origin/account/chain-bound in-memory wallet login is required for asset/history display. Public entry and blockchain records remain public; private APIs require separate server authorization.', controlKernel: 'The normal DApp control deployment-manifest path and agent-request path enforce testnet chain guards. Direct SDK consumers must enforce their own chain policy; the SDK is not a universal mainnet barrier.',
    externalAssets: 'ETH, ERC-20, ERC-721 and ERC-1155 on Ethereum, Base, Sepolia and Base Sepolia; no private-key custody; each transfer requires the user wallet confirmation',
    recommendation: 'Use authorized test assets and testnets for Beta testing. Mainnet testing requires separate authorization.' },
  notes: ['Serve the complete tree with its web/ and dist/browser/ layout intact.',
    'A full confirmed deployment URL is required before hosting; null means no endpoint has been assigned.',
    'Honor the deployment host reservedPorts configuration; preserve existing listeners and the exact browser origin.',
    'Preserve origin and browser operation journals across deployments and rollbacks.'],
};
writeFileSync(join(stage, 'RELEASE.json'), `${JSON.stringify(release, null, 2)}\n`);
const sums = walk(stage).map(file => `${sha256(readFileSync(join(stage, file)))}  ${file}`).join('\n');
writeFileSync(join(stage, 'SHA256SUMS'), `${sums}\n`);
const artifact = `8415wallet-dapp-${id}-${profile.version}.tar.gz`;
const digest = deterministicArchive(stage, join(root, 'dist', artifact));
writeFileSync(join(root, 'dist', `dapp-${id}-package-manifest.json`), `${JSON.stringify({ artifact, sha256: digest, ...release }, null, 2)}\n`);
console.log(`${artifact}\nsha256 ${digest}\nsource tree ${source.tree}${source.dirty ? ' (uncommitted changes included)' : ''}\nstatus ${RELEASE_STATUS}`);
