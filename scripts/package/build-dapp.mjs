/**
 * Build the deployable dApp bundle.
 *
 * This is not the npm package. It is the static tree a web server hosts: the
 * page, its modules and the compiled browser entry, with nothing else. A static
 * host resolves nothing, so the two ways this artifact fails in production are
 * a module specifier that does not resolve and an asset the page references but
 * the tree does not carry. Both are checked here rather than discovered after
 * deployment.
 *
 * The build is a BETA. Its UI is sufficient for functional testing and it has
 * not completed public-chain execution, physical device journeys, W-20 or
 * independent security review. The status travels in RELEASE.json and the build
 * refuses to ship text that claims otherwise.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { BEFORE_GENERAL_RELEASE, BETA_COLLECTS, STATUS, findAcceptanceClaim } from './release-contract.mjs';
import { dirname, join, relative, resolve } from 'node:path';

const root = process.cwd();
const VERSION = '3.0.0-beta';
const SCOPE = {
  controlKernel: 'In THIS bundle the control panel is testnet only: web/app.mjs refuses a non-testnet deployment with CONTROL_TESTNET_REQUIRED, and the agent request parser refuses one with AGENT_TESTNET_REQUIRED. The restriction lives in these two call sites, NOT in src/controls, so it binds this page and does not bind a consumer who imports the control surface directly from the npm package.',
  assetTransfers: 'Ethereum mainnet, Base, Sepolia and Base Sepolia. This layer holds no key and sets no amount ceiling; the final authority is the confirmation dialog of the user own wallet.',
  recommendation: 'For functional testing set the wallet to Sepolia before connecting.',
};
/**
 * A beta ships the surface; what it must never ship is a claim. The phrases
 * below are claims only when asserted: the page's own banner says "Not
 * independently audited", which is the opposite, so a negation immediately
 * before the phrase clears it. Matching the phrase alone would refuse the very
 * disclaimer this check exists to protect.
 */
const NEGATION = String.raw`(?:not|never|no|without|refuses? to be|yet to be|pending)\s+(?:\w+\s+){0,2}`;
const CLAIMS = ['independently audited', 'security[- ]approved', 'production[- ]ready',
  'release[- ]accepted', 'audit(?:ed)? complete'];
const FORBIDDEN_CLAIMS = CLAIMS.map((c) => new RegExp(String.raw`(?<!${NEGATION})(?:${c})`, 'i'));
const TREES = ['web', 'dist/browser'];
const stage = join(root, 'dist', 'package-dapp');
const fail = (code, detail) => { console.error(code, detail ?? ''); process.exit(1); };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Compile from source rather than trusting whatever dist/browser happens to hold.
execFileSync('npx', ['tsc', '-p', 'tsconfig.browser.json'], { cwd: root, stdio: 'inherit' });

function walk(directory) {
  return readdirSync(join(root, directory)).flatMap((name) => {
    const rel = `${directory}/${name}`, info = lstatSync(join(root, rel));
    if (info.isSymbolicLink()) fail('DAPP_SYMLINK_REFUSED', rel);
    return info.isDirectory() ? walk(rel) : [rel];
  });
}
const files = TREES.flatMap(walk).sort();
if (files.length === 0) fail('DAPP_EMPTY_TREE');

// Every relative specifier must resolve inside the shipped tree, and no bare
// specifier may survive: a static host has no resolver to fall back on.
const present = new Set(files);
let relativeImports = 0;
for (const file of files) {
  if (!/\.(mjs|js)$/.test(file)) continue;
  const text = readFileSync(join(root, file), 'utf8');
  for (const match of text.matchAll(/(?:^|[\s;{(])(?:import|export)\b[^'"\n]*?from\s*['"]([^'"]+)['"]/g)) {
    const spec = match[1];
    if (!spec.startsWith('.')) fail('DAPP_BARE_SPECIFIER_REFUSED', `${file} -> ${spec}`);
    const target = relative(root, resolve(join(root, dirname(file)), spec)).split('\\').join('/');
    if (!present.has(target)) fail('DAPP_UNRESOLVED_IMPORT', `${file} -> ${spec}`);
    relativeImports += 1;
  }
}

// Everything the page pulls in must be in the tree and must be local.
const pageFile = 'web/index.html';
if (!present.has(pageFile)) fail('DAPP_PAGE_MISSING', pageFile);
const page = readFileSync(join(root, pageFile), 'utf8');
let pageAssets = 0;
for (const match of page.matchAll(/(?:src|href)="([^"]+)"/g)) {
  const ref = match[1];
  if (/^(https?:)?\/\//.test(ref)) fail('DAPP_EXTERNAL_ASSET_REFUSED', ref);
  const target = relative(root, resolve(join(root, dirname(pageFile)), ref)).split('\\').join('/');
  if (!present.has(target)) fail('DAPP_MISSING_PAGE_ASSET', ref);
  pageAssets += 1;
}
if (!/<meta http-equiv="Content-Security-Policy"/.test(page)) fail('DAPP_PAGE_CSP_MISSING');

for (const file of files) {
  if (!/\.(mjs|js|html|css)$/.test(file)) continue;
  const claim = findAcceptanceClaim(readFileSync(join(root, file), 'utf8'));
  if (claim) fail('DAPP_FORBIDDEN_CLAIM', `${file} :: ${claim}`);
}

// The page states the release's status in prose and the manifest states it as a
// token. They cannot share a constant, because the page ships as committed bytes
// and is never generated. So the duplication is checked instead: a page that
// still calls itself something else is a page that disagrees with its own
// artifact, which is how "development candidate" survived next to a beta.
if (!/\bbeta\b/i.test(page)) fail('DAPP_PAGE_STATUS_DISAGREES', 'the page does not state the beta status the manifest declares');
if (!/not independently audited/i.test(page)) fail('DAPP_PAGE_DISCLAIMER_MISSING');

let source = 'unknown';
try { source = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim(); } catch {}

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const file of files) {
  mkdirSync(join(stage, dirname(file)), { recursive: true });
  writeFileSync(join(stage, file), readFileSync(join(root, file)));
}

const release = {
  name: '8415wallet-dapp', version: VERSION, status: STATUS,
  description: 'ERC-8415 temporal asset wallet - deployable dApp bundle. Beta: UI sufficient for functional testing. Not independently audited.',
  source, files: files.length, relativeImports, pageAssets, externalRequests: 0,
  entry: 'web/index.html',
  scope: SCOPE, betaCollects: BETA_COLLECTS, beforeGeneralRelease: BEFORE_GENERAL_RELEASE,
  notes: ['Serve over HTTPS: the operation journal refuses to start outside a secure context.',
    'Serve .mjs as text/javascript; most servers do not map it by default.',
    'Send frame-ancestors as a response header; the page meta CSP cannot carry it.',
    'The served origin is part of stored state. Changing host, scheme or port strands existing journals.'],
};
writeFileSync(join(stage, 'RELEASE.json'), `${JSON.stringify(release, null, 2)}\n`);

const sums = files.map((f) => `${sha256(readFileSync(join(stage, f)))}  ${f}`).join('\n');
writeFileSync(join(stage, 'SHA256SUMS'), `${sums}\n`);

// Deterministic: the same source must give the same digest, or publishing a
// hash for people to verify against means nothing. tar embeds mtimes and owners
// and gzip embeds its own timestamp, so all three are pinned.
const tarball = join(root, 'dist', `8415wallet-dapp-${VERSION}.tar.gz`);
const tar = execFileSync('tar', ['--sort=name', '--mtime=UTC 1970-01-01', '--owner=0', '--group=0',
  '--numeric-owner', '--format=gnu', '-cf', '-', '-C', stage, '.'],
  { stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 1 << 28 });
writeFileSync(tarball, execFileSync('gzip', ['-9', '-n'], { input: tar, maxBuffer: 1 << 28 }));
const digest = sha256(readFileSync(tarball));
writeFileSync(join(root, 'dist', 'dapp-package-manifest.json'),
  `${JSON.stringify({ artifact: `8415wallet-dapp-${VERSION}.tar.gz`, sha256: digest, ...release }, null, 2)}\n`);

console.log(`8415wallet-dapp-${VERSION}.tar.gz  ${files.length} files`);
console.log(`sha256 ${digest}`);
console.log(`${relativeImports} relative imports resolved, ${pageAssets} page assets, 0 external references`);
console.log(`status ${STATUS}`);
