/**
 * Build the V3 delivery candidate package.
 *
 * V3 ships the surface V2 deliberately excludes: the responsibility control
 * kernel, the linked chain views and the browser entry. That surface has not
 * completed independent security acceptance. So this package is a CANDIDATE: the
 * status is in its name, its package.json and a notice this build refuses to
 * omit. A build that cannot find the notice does not produce a tarball.
 *
 * As with V2 the file list is derived from the import graph, never
 * hand-maintained, and the shipped tarball carries no runtime dependency.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { importGraph } from './shared.mjs';
import { V3_DOCUMENTS, verifyBoundaryDocument, verifyDocumentEntries } from './v3-document-contract.mjs';

const root = process.cwd();
const stage = join(root, 'dist', 'package-v3');
const ENTRIES = ['src/index.ts', 'src/controls/index.ts', 'src/controls/fileOperationStore.ts',
  'src/browser.ts', 'src/cli/main.ts'];
/** The candidate ships the control surface; what it must never ship is a claim. */
const FORBIDDEN_CLAIMS = [/independently audited/i, /security[- ]approved/i, /production[- ]ready/i,
  /release[- ]accepted/i];
const REQUIRED_NOTICE = 'NOT_INDEPENDENTLY_AUDITED';

const sources = importGraph(root, ENTRIES);
const controls = sources.filter((f) => f.startsWith('src/controls/'));
if (controls.length === 0) {
  console.error('PACKAGE_V3_MISSING_CONTROL_SURFACE');
  process.exit(1);
}

const DOCS = V3_DOCUMENTS;
for (const d of DOCS) if (!existsSync(d)) { console.error('MISSING_REQUIRED_DOC', d); process.exit(1); }
verifyBoundaryDocument(readFileSync(join(root, 'docs/INTEGRATION-BOUNDARIES.md'), 'utf8'));

// The notice is a shipped fact, not a build-time intention.
const notice = readFileSync('PACKAGE-V3.md', 'utf8');
if (!notice.includes(REQUIRED_NOTICE)) { console.error('PACKAGE_V3_STATUS_NOTICE_MISSING'); process.exit(1); }
for (const claim of FORBIDDEN_CLAIMS) {
  if (claim.test(notice.replace(/not independently audited/gi, '').replace(/NOT_INDEPENDENTLY_AUDITED/g, ''))) {
    console.error('PACKAGE_V3_WOULD_CLAIM_ACCEPTANCE', String(claim));
    process.exit(1);
  }
}

rmSync(stage, { recursive: true, force: true });
execFileSync('npx', ['tsc', '-p', 'tsconfig.package-v3.json'], { cwd: root, stdio: 'inherit' });

const cli = join(stage, 'cli', 'main.js');
writeFileSync(cli, `#!/usr/bin/env node\n${readFileSync(cli, 'utf8')}`);

for (const f of [...DOCS, 'PACKAGE-V3.md']) {
  mkdirSync(join(stage, dirname(f)), { recursive: true });
  copyFileSync(join(root, f), join(stage, f));
}

const dev = JSON.parse(readFileSync('package.json', 'utf8'));
/**
 * The product version is explicit, not derived from the repository's own
 * package.json: that value also drives V2, which is a deliberately narrower
 * surface and must not inherit this one's number. The pre-release tag is what
 * carries the claim, and verify-install-v3 enforces that it is present.
 */
const version = '3.0.0-beta';
writeFileSync(join(stage, 'package.json'), `${JSON.stringify({
  name: '8415wallet',
  version,
  description: 'ERC-8415 temporal asset wallet — V3 beta: standalone reading plus linked responsibility controls. Not independently audited; normal DApp control paths enforce testnet guards and SDK consumers set their own chain policy.',
  license: dev.license,
  type: 'module',
  engines: dev.engines,
  dependencies: {},
  exports: {
    '.': { types: './index.d.ts', default: './index.js' },
    './controls': { types: './controls/index.d.ts', default: './controls/index.js' },
    './controls/node-store': { types: './controls/fileOperationStore.d.ts', default: './controls/fileOperationStore.js' },
    './browser': { types: './browser.d.ts', default: './browser.js' },
  },
  types: './index.d.ts',
  bin: { '8415wallet': './cli/main.js' },
}, null, 2)}\n`);

const out = execFileSync('npm', ['pack', '--json'], { cwd: stage, encoding: 'utf8' });
const packed = JSON.parse(out)[0];
verifyDocumentEntries(packed.files.map(file => file.path));
const sha = createHash('sha256').update(readFileSync(join(stage, packed.filename))).digest('hex');

writeFileSync(join(root, 'dist', 'v3-package-manifest.json'), `${JSON.stringify({
  artifact: packed.filename,
  status: 'BETA_FUNCTIONAL_TESTING_NOT_INDEPENDENTLY_AUDITED',
  sha256: sha,
  entries: packed.entryCount,
  unpackedBytes: packed.unpackedSize,
  engines: dev.engines,
  runtimeDependencies: 0,
  entries_compiled: ENTRIES,
  sourceModules: sources.length,
  controlModules: controls.length,
  // A beta's gates are not a release's gates. Execution, device journeys and
  // W-20 are what this build exists to collect, not what blocks it; listing
  // them as blockers would describe the beta as waiting for its own purpose.
  betaCollects: ['public-chain execution with a genuine wallet',
    'physical device journeys in a wallet application in-app browser',
    'W-20 deployed same-token multi-wallet journey'],
  // Independent review bounds what the build may be used for rather than
  // blocking its publication. The normal DApp manifest and agent-request paths
  // enforce testnet guards; direct SDK consumers supply their own chain policy.
  beforeGeneralRelease: ['independent security review of the control kernel, adapters, verifiers, deployed contracts, recovery and optional payment integration'],
  controlKernelScope: 'The normal DApp control deployment-manifest path and agent-request path enforce testnet chain guards (CONTROL_TESTNET_REQUIRED, AGENT_TESTNET_REQUIRED). Direct SDK consumers must enforce their own chain policy; the SDK is not a universal mainnet barrier.',
}, null, 2)}\n`);
console.log(`${packed.filename}  ${packed.entryCount} entries  ${Math.round(packed.unpackedSize / 1024)} KB`);
console.log(`sha256 ${sha}`);
console.log(`${sources.length} source modules (${controls.length} control), 0 runtime dependencies`);
console.log('status BETA_FUNCTIONAL_TESTING_NOT_INDEPENDENTLY_AUDITED');
