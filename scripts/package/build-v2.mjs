/**
 * Build the V2 product package.
 *
 * The file list is DERIVED from the import graph of the V2 entry and the CLI,
 * never hand-maintained: a hand-written allowlist drifts the moment a module
 * moves, and the one thing this package must guarantee is that the unaudited
 * v3.0 control kernel is not in it. That is asserted here rather than trusted,
 * and the build fails if the graph ever reaches it.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { importGraph } from './shared.mjs';
import { V2_DOCUMENTS, verifyV2DocumentEntries } from './v3-document-contract.mjs';

const root = process.cwd();
const stage = join(root, 'dist', 'package');
const ENTRIES = ['src/v2.ts', 'src/cli/main.ts'];
/** Nothing matching these may end up in the package. */
const FORBIDDEN = [/^src\/controls\//, /^src\/wallet\/linkedChainView\.ts$/,
  /^src\/wallet\/renderLinkedChain\.ts$/, /^src\/sdk\/linked\.ts$/, /^src\/browser\.ts$/];

const sources = importGraph(root, ENTRIES);
const leaked = sources.filter((f) => FORBIDDEN.some((re) => re.test(f)));
if (leaked.length > 0) {
  console.error('PACKAGE_WOULD_SHIP_UNAUDITED_SURFACE');
  for (const f of leaked) console.error('  ', f);
  process.exit(1);
}

const DOCS = V2_DOCUMENTS;
for (const d of DOCS) if (!existsSync(d)) { console.error('MISSING_REQUIRED_DOC', d); process.exit(1); }

rmSync(stage, { recursive: true, force: true });

// Compile, rather than shipping the sources.
//
// The repository runs TypeScript directly and has no build step, which is a real
// property of working in it. It does not survive packaging: Node refuses to strip
// types for anything under node_modules
// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), so a tarball of .ts files
// installs fine and then cannot be imported at all. Found by installing one.
execFileSync('npx', ['tsc', '-p', 'tsconfig.package.json'], { cwd: root, stdio: 'inherit' });

// A bin needs a shebang, and the sources have none because they are imported.
const cli = join(stage, 'cli', 'main.js');
writeFileSync(cli, `#!/usr/bin/env node\n${readFileSync(cli, 'utf8')}`);

for (const f of DOCS) {
  mkdirSync(join(stage, dirname(f)), { recursive: true });
  copyFileSync(join(root, f), join(stage, f));
}

const dev = JSON.parse(readFileSync('package.json', 'utf8'));
/**
 * V2 and V3 are separate product lines that happen to share a repository, not
 * two iterations of one. Each states its own version rather than deriving it
 * from the repository's, so neither moves when the other does.
 */
const VERSION = '2.0.0';
writeFileSync(join(stage, 'package.json'), `${JSON.stringify({
  name: '8415wallet',
  version: VERSION,
  description: '8415wallet V2 SDK — standalone native ERC-8415 reading and transaction client for the general-purpose wallet',
  license: dev.license,
  type: 'module',
  engines: dev.engines,
  // No runtime dependencies, and none of the build or chain tooling.
  dependencies: {},
  exports: { '.': { types: './v2.d.ts', default: './v2.js' } },
  types: './v2.d.ts',
  bin: { '8415wallet': './cli/main.js' },
}, null, 2)}\n`);
copyFileSync(join(root, 'PACKAGE.md'), join(stage, 'PACKAGE.md'));
// npm renders README.md and nothing else, so the package carries its own.
copyFileSync(join(root, 'README-package.md'), join(stage, 'README.md'));
// What instructs development never ships; the consumer documents all do.
verifyV2DocumentEntries(readdirSync(stage, { recursive: true }).map((p) => String(p).replaceAll('\\', '/')));

const out = execFileSync('npm', ['pack', '--json'], { cwd: stage, encoding: 'utf8' });
const packed = JSON.parse(out)[0];
const tarball = join(stage, packed.filename);
const sha = createHash('sha256').update(readFileSync(tarball)).digest('hex');

const manifest = {
  artifact: packed.filename,
  sha256: sha,
  entries: packed.entryCount,
  unpackedBytes: packed.unpackedSize,
  engines: dev.engines,
  runtimeDependencies: 0,
  entry: 'v2.js',
  compiledFrom: 'src/v2.ts',
  sourceModules: sources.length,
  excludedByAssertion: FORBIDDEN.map(String),
};
writeFileSync(join(root, 'dist', 'v2-package-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`${packed.filename}  ${packed.entryCount} entries  ${Math.round(packed.unpackedSize / 1024)} KB`);
console.log(`sha256 ${sha}`);
console.log(`${sources.length} source modules, 0 runtime dependencies`);
