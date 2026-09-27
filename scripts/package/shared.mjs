/**
 * What both package builds and both install verifiers need, in one place.
 *
 * The file list of a package is derived from its entry points' import graph and
 * never hand-maintained: a written allowlist drifts the moment a module moves,
 * and what these packages must guarantee about their contents would drift with
 * it.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

/** Every local module reachable from `entries`, relative to `root`. */
export function importGraph(root, entries) {
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file) || !existsSync(file)) return;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const m of source.matchAll(/from\s+'(\.[^']+)'/g)) walk(resolve(dirname(file), m[1]));
    for (const m of source.matchAll(/^\s*import\s+'(\.[^']+)'/gm)) walk(resolve(dirname(file), m[1]));
  };
  for (const entry of entries) walk(resolve(root, entry));
  return [...seen].map((file) => relative(root, file)).sort();
}

/**
 * Install a tarball into a throwaway directory outside the repository and run
 * checks against it.
 *
 * Building a package is not evidence that it works. This repository runs
 * TypeScript directly, and that property does not survive packaging: a tarball
 * of `.ts` files packs cleanly, installs cleanly, and then cannot be imported
 * at all, because Node refuses to strip types under `node_modules`. Only an
 * install finds that.
 *
 * Exits the process with the verdict, so a caller is a description of checks
 * and nothing else.
 */
export function verifyInstalled(tarball, run) {
  const directory = mkdtempSync(join(tmpdir(), 'erc8415-install-'));
  const checks = [];
  const check = (name, ok, detail = '') => {
    checks.push({ name, ok });
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  };
  const shell = (command, args, quiet = true) =>
    execFileSync(command, args, { cwd: directory, encoding: 'utf8', stdio: quiet ? 'pipe' : 'inherit' });

  try {
    writeFileSync(join(directory, 'package.json'), '{"name":"consumer","private":true,"type":"module"}\n');
    shell('npm', ['install', tarball]);
    check('installs from the tarball', true);

    const installed = shell('npm', ['ls', '--all', '--parseable']).trim().split('\n').length - 1;
    check('no runtime dependencies', installed === 1, `${installed} installed package(s)`);

    run({ directory, check, shell, packageRoot: join(directory, 'node_modules', '8415wallet') });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} install checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

/** Build the package, then hand back the tarball its manifest names. */
export function builtTarball(builder, manifest, stage) {
  execFileSync('node', [builder], { cwd: process.cwd(), stdio: 'inherit' });
  const { artifact } = JSON.parse(readFileSync(manifest, 'utf8'));
  return join(process.cwd(), 'dist', stage, artifact);
}
