/**
 * Build the V3 delivery candidate package.
 *
 * V3 ships the surface V2 deliberately excludes: the responsibility control
 * kernel, the linked chain views and the browser entry. That surface has not
 * been independently audited, and AGENTS.md forbids connecting the kernel to
 * signing or execution before it is. So this package is a CANDIDATE: the
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

const root = process.cwd();
const stage = join(root, 'dist', 'package-v3');
const ENTRIES = ['src/index.ts', 'src/controls/index.ts', 'src/controls/fileOperationStore.ts',
  'src/browser.ts', 'src/cli/main.ts'];
/** The candidate ships the control surface; what it must never ship is a claim. */
const FORBIDDEN_CLAIMS = [/independently audited/i, /security[- ]approved/i, /production[- ]ready/i,
  /release[- ]accepted/i];
const REQUIRED_NOTICE = 'NOT_INDEPENDENTLY_AUDITED';

function graph(entry) {
  const seen = new Set();
  (function walk(file) {
    if (seen.has(file) || !existsSync(file)) return;
    seen.add(file);
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/from\s+'(\.[^']+)'/g)) walk(resolve(dirname(file), m[1]));
    for (const m of src.matchAll(/^\s*import\s+'(\.[^']+)'/gm)) walk(resolve(dirname(file), m[1]));
  })(resolve(root, entry));
  return [...seen].map((f) => relative(root, f));
}

const sources = [...new Set(ENTRIES.flatMap(graph))].sort();
const controls = sources.filter((f) => f.startsWith('src/controls/'));
if (controls.length === 0) {
  console.error('PACKAGE_V3_MISSING_CONTROL_SURFACE');
  process.exit(1);
}

const DOCS = ['LICENSE', 'docs/INTEGRATION.md', 'docs/ERC-8415-Wallet-PRD.md',
  'docs/RESPONSIBILITY-CONTROLS-SECURITY.md', 'docs/V3-REVIEW-AND-VALIDATION.md',
  'docs/stages/STAGE-5J-PUBLIC-PATH-AND-UI.md', 'AGENTS.md'];
for (const d of DOCS) if (!existsSync(d)) { console.error('MISSING_REQUIRED_DOC', d); process.exit(1); }

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
const version = `${dev.version}-v3-candidate`;
writeFileSync(join(stage, 'package.json'), `${JSON.stringify({
  name: '8415wallet',
  version,
  description: 'ERC-8415 temporal asset wallet — V3 candidate: standalone reading plus linked responsibility controls. Not independently audited; testnet use only.',
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
const sha = createHash('sha256').update(readFileSync(join(stage, packed.filename))).digest('hex');

writeFileSync(join(root, 'dist', 'v3-package-manifest.json'), `${JSON.stringify({
  artifact: packed.filename,
  status: 'CANDIDATE_NOT_INDEPENDENTLY_AUDITED_TESTNET_ONLY',
  sha256: sha,
  entries: packed.entryCount,
  unpackedBytes: packed.unpackedSize,
  engines: dev.engines,
  runtimeDependencies: 0,
  entries_compiled: ENTRIES,
  sourceModules: sources.length,
  controlModules: controls.length,
  openGates: ['public-testnet execution', 'W-20 deployed same-token multi-wallet journey',
    'independent security review', 'physical device journeys'],
}, null, 2)}\n`);
console.log(`${packed.filename}  ${packed.entryCount} entries  ${Math.round(packed.unpackedSize / 1024)} KB`);
console.log(`sha256 ${sha}`);
console.log(`${sources.length} source modules (${controls.length} control), 0 runtime dependencies`);
console.log('status CANDIDATE_NOT_INDEPENDENTLY_AUDITED_TESTNET_ONLY');
