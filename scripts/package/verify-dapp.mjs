/** Verify extracted deployment content and the independently supplied source archive. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveReleaseProfile } from '../../web/release-profile.mjs';
import { sha256, validateStaticTree, walk } from './dapp-release.mjs';

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--profile' || !['v2', 'v3', 'all'].includes(args[1]))) throw new Error('DAPP_ARGUMENT_REFUSED');
const profiles = !args.length || args[1] === 'all' ? ['v2', 'v3'] : [args[1]];
const root = process.cwd();
function unpack(artifact, label) {
  const paths = execFileSync('tar', ['-tzf', artifact], { encoding: 'utf8' }).trim().split('\n');
  if (paths.some(path => !path.startsWith('./') || path.split('/').includes('..') || path.includes('\\'))) throw new Error('DAPP_ARCHIVE_PATH_REFUSED');
  const types = execFileSync('tar', ['-tvzf', artifact], { encoding: 'utf8' }).trim().split('\n');
  if (types.some(line => !['d', '-'].includes(line[0]))) throw new Error('DAPP_ARCHIVE_LINK_REFUSED');
  const directory = mkdtempSync(join(tmpdir(), `wallet-${label}-verify-`));
  try { execFileSync('tar', ['--no-same-owner', '-xzf', artifact, '-C', directory]); walk(directory); }
  catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; }
  return directory;
}
for (const id of profiles) {
  const manifest = JSON.parse(readFileSync(join(root, 'dist', `dapp-${id}-package-manifest.json`), 'utf8'));
  const artifact = join(root, 'dist', manifest.artifact);
  assert.equal(sha256(readFileSync(artifact)), manifest.sha256, 'DApp archive digest');
  const directory = unpack(artifact, id);
  let sourceDirectory;
  try {
    const release = JSON.parse(readFileSync(join(directory, 'RELEASE.json'), 'utf8'));
    const { artifact: _artifact, sha256: _sha256, ...expectedRelease } = manifest;
    assert.deepEqual(release, expectedRelease, 'manifest and archived release identity');
    const config = JSON.parse(readFileSync(join(directory, 'web/release-config.json'), 'utf8'));
    const profile = resolveReleaseProfile(config);
    assert.equal(profile.id, id); assert.equal(release.profile, id);
    assert.equal(release.version, profile.version); assert.equal(release.status, profile.status);
    assert.deepEqual(release.features, profile.features); assert.deepEqual(release.tenant, profile.tenant);
    assert.deepEqual(release.deployment, profile.deployment);
    assert.equal(release.build.configSha256, sha256(readFileSync(join(directory, 'web/release-config.json'))));
    assert.equal(release.prd.sha256, sha256(readFileSync(join(directory, release.prd.file))));
    const files = walk(directory).filter(file => file !== 'SHA256SUMS');
    const expectedSums = files.map(file => `${sha256(readFileSync(join(directory, file)))}  ${file}`).join('\n') + '\n';
    assert.equal(readFileSync(join(directory, 'SHA256SUMS'), 'utf8'), expectedSums, 'complete exact file inventory');
    const validation = validateStaticTree(directory);
    assert.deepEqual(Object.fromEntries(validation.files.map(file => [file, sha256(readFileSync(join(directory, file)))])), release.runtimeFiles);
    const sourceArtifact = join(root, 'dist', release.sourceArchive.artifact);
    assert.equal(sha256(readFileSync(sourceArtifact)), release.sourceArchive.sha256, 'source archive digest');
    sourceDirectory = unpack(sourceArtifact, 'source');
    assert.deepEqual(Object.fromEntries(walk(sourceDirectory).map(file => [file, sha256(readFileSync(join(sourceDirectory, file)))])), release.source.files);
    execFileSync('git', ['init', '-q'], { cwd: sourceDirectory });
    execFileSync('git', ['add', '--all'], { cwd: sourceDirectory });
    const tree = execFileSync('git', ['write-tree'], { cwd: sourceDirectory, encoding: 'utf8' }).trim();
    assert.equal(tree, release.source.tree, 'source archive reconstructs the exact Git content tree');
    console.log(`${id}: archive, exact inventory, runtime imports, config, PRD, source digest and Git tree verified`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    if (sourceDirectory) rmSync(sourceDirectory, { recursive: true, force: true });
  }
}
