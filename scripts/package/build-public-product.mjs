/** Inspect by default. An approved, externally pinned policy is required to build. */
import { execFileSync } from 'node:child_process';
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ORIGIN_FILE, cleanEnvironment, commonOptions, git, gitHash, inspectSource, jsonBytes,
  parseArguments, planSummary, regularFile, safeDirectory, sha256, verifyProductArchive,
  verifyProductDirectory, walkFiles,
} from './verify-product-origin.mjs';

const fail = (condition, code) => { if (!condition) throw Error(`PRODUCT_${code}`); };
function disjoint(a, b) {
  const outside = path => path === '..' || path.startsWith('../');
  return a !== b && outside(relative(a, b)) && outside(relative(b, a));
}
function freshOutput(outputRoot, sourceRoot, toolingRoot) {
  fail(typeof outputRoot === 'string' && outputRoot.length > 0, 'FRESH_OUTPUT_ROOT_REQUIRED');
  outputRoot = resolve(outputRoot);
  fail(disjoint(outputRoot, sourceRoot) && disjoint(outputRoot, toolingRoot), 'OUTPUT_MUST_BE_SEPARATE');
  safeDirectory(dirname(outputRoot));
  // lstat, unlike existsSync, refuses even dangling symlinks and stale empty dirs.
  let present = false;
  try { lstatSync(outputRoot); present = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  fail(!present, 'STALE_OUTPUT_REFUSED');
  return outputRoot;
}
/** This primitive is also exercised against synthetic-only source repositories. */
export function materializeProduct(options) {
  const plan = inspectSource(options);
  fail(plan.policy.review.status === 'approved-for-local-build' && !plan.policy.review.blockers.length && !plan.policy.review.holds.length, 'ALLOWLIST_NOT_APPROVED');
  fail(options.expectedProductTree === plan.productTree, 'REVIEWED_PRODUCT_TREE_REQUIRED');
  const toolingRoot = options.toolingRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const outputRoot = freshOutput(options.outputRoot, plan.sourceRoot, resolve(toolingRoot));
  // No mutation has occurred before every pin, closure and review check above.
  mkdirSync(outputRoot, { mode: 0o700 });
  const productRoot = join(outputRoot, 'product'); mkdirSync(productRoot, { mode: 0o755 });
  try {
    for (const entry of plan.productEntries) {
      const target = join(productRoot, entry.path);
      mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
      const bytes = entry.path === ORIGIN_FILE ? plan.originBytes : plan.blobs.get(entry.path);
      writeFileSync(target, bytes, { flag: 'wx', mode: entry.mode === '100755' ? 0o755 : 0o644 });
      chmodSync(target, entry.mode === '100755' ? 0o755 : 0o644);
    }
    // No clone, alternates, upstream parent, remote, hooks, signing or user config.
    git(productRoot, ['init', '--quiet', '--object-format=sha1', '--initial-branch=product-export', '--template=']);
    for (const entry of plan.productEntries) {
      const bytes = regularFile(productRoot, entry.path).bytes;
      const object = git(productRoot, ['hash-object', '-w', '--stdin'], { input: bytes }).toString().trim();
      fail(object === entry.object, 'MATERIALIZED_BLOB_MISMATCH');
    }
    git(productRoot, ['update-index', '-z', '--index-info'], {
      input: Buffer.from(plan.productEntries.map(entry => `${entry.mode} ${entry.object}\t${entry.path}\0`).join('')),
    });
    const tree = git(productRoot, ['write-tree']).toString().trim(); fail(tree === plan.productTree, 'MATERIALIZED_TREE_MISMATCH');
    const commit = git(productRoot, ['hash-object', '-t', 'commit', '-w', '--stdin'], { input: plan.commitBytes }).toString().trim();
    fail(commit === plan.productCommit && gitHash('commit', plan.commitBytes) === commit, 'MATERIALIZED_COMMIT_MISMATCH');
    git(productRoot, ['update-ref', 'refs/heads/product-export', commit]);
    verifyProductDirectory(plan, productRoot, plan.productTree);
    const guideBytes = regularFile(toolingRoot, 'docs/PUBLIC-PRODUCT-KIT.md').bytes;
    const guideSha256 = sha256(guideBytes);
    fail(guideSha256 === plan.tooling.files.find(file => file.path === 'docs/PUBLIC-PRODUCT-KIT.md').sha256, 'COMPANION_GUIDE_CHANGED');
    writeFileSync(join(outputRoot, 'PUBLIC-PRODUCT-KIT.md'), guideBytes, { flag: 'wx', mode: 0o644 });
    const report = { schema: '8415wallet-product-build-report/2', status: 'SOURCE_ONLY_PACKERS_NOT_RUN',
      upstream: plan.upstreamIdentity, allowlistSha256: plan.policySha256, toolingSha256: plan.tooling.sha256,
      product: { commit: plan.productCommit, tree: plan.productTree, dirty: false, sourceEntries: plan.productEntries.length,
        originSha256: sha256(plan.originBytes), history: 'One deterministic local root commit. No upstream history, remote, signature or GitHub CI result.' },
      companions: [{ path: 'PUBLIC-PRODUCT-KIT.md', sha256: guideSha256, scope: 'Separate guide; never an outer delivery archive addition' }],
      archives: [], evidence: 'Local source materialization only. No build, publication, deployment or acceptance result.' };
    writeFileSync(join(outputRoot, 'PRODUCT-BUILD-REPORT.json'), jsonBytes(report), { flag: 'wx', mode: 0o644 });
    return { plan, outputRoot, productRoot, report };
  } catch (error) {
    // Preserve failed fresh output for diagnosis. Never delete/reuse another run.
    writeFileSync(join(outputRoot, 'BUILD-FAILED.txt'), `${error.message}\n`, { flag: 'wx', mode: 0o644 });
    throw error;
  }
}
const ARCHIVE_PATTERN = /^8415wallet-dapp-delivery-[a-f0-9]{40}\.tar\.gz$/;
const PUBLIC_REPORT = 'PRODUCT-BUILD-REPORT.json';
const PUBLIC_GUIDE = 'PUBLIC-PRODUCT-KIT.md';
const VERIFIED_STATUS = 'LOCAL_PRODUCT_PACKAGING_VERIFIED';
function publicationReport(plan, artifact, archiveSha256, guideSha256) {
  const upstream = plan.upstreamIdentity;
  // Fixed shape only: never spread arbitrary manifests, paths, process env or logs.
  return { schema: '8415wallet-public-product-report/2', status: VERIFIED_STATUS, product: '8415wallet',
    upstream: { commit: upstream.commit, commitTree: upstream.commitTree, snapshotTree: upstream.snapshotTree,
      snapshotRelation: upstream.snapshotRelation, stagedChanges: upstream.stagedChanges,
      trackedWorktreeMatchesSnapshot: upstream.trackedWorktreeMatchesSnapshot,
      hasUntrackedFiles: upstream.hasUntrackedFiles, dirty: upstream.dirty },
    selection: { schema: plan.policy.schema, version: plan.policy.version, sha256: plan.policySha256,
      sourceEntries: plan.policy.entries.length },
    tooling: { version: plan.tooling.version, sha256: plan.tooling.sha256 },
    localProduct: { commit: plan.productCommit, tree: plan.productTree, dirty: false,
      sourceEntries: plan.productEntries.length, originSha256: sha256(plan.originBytes) },
    archive: { artifact, sha256: archiveSha256 },
    guide: { artifact: PUBLIC_GUIDE, sha256: guideSha256 },
    verification: 'Unchanged strict delivery/auth validators, exact source/origin and source-bound DApp inventory passed.',
    evidence: 'Local packaging integrity only. Local product identity does not establish publisher authorship, upstream CI, deployment, device/public-chain acceptance or an independent audit. Trusted external pins remain required.' };
}
function publicationPaths(outputRoot, artifact) {
  fail(ARCHIVE_PATTERN.test(artifact), 'PUBLIC_ARTIFACT_NAME_REFUSED');
  const directory = join(outputRoot, 'publication');
  return { archive_path: join(directory, artifact), guide_path: join(directory, PUBLIC_GUIDE),
    checksums_path: join(directory, 'SHA256SUMS'), report_path: join(directory, PUBLIC_REPORT) };
}
function checksumBytes(files) {
  return Buffer.from([...files].sort(([a], [b]) => a < b ? -1 : 1).map(([path, bytes]) => `${sha256(bytes)}  ${path}\n`).join(''));
}
/** Build-only publication staging; callers must supply the successful strict verification result. */
export function preparePublicFiles({ plan, productRoot, outputRoot, verification }) {
  fail(verification?.productTree === plan.productTree && verification?.localProductCommit === plan.productCommit
    && verification?.sourceEntries === plan.productEntries.length && /^[a-f0-9]{64}$/.test(verification?.archiveSha256 ?? ''),
    'PUBLICATION_REQUIRES_VERIFIED_BUILD');
  outputRoot = safeDirectory(outputRoot); productRoot = safeDirectory(productRoot);
  fail(productRoot === join(outputRoot, 'product'), 'PUBLIC_PRODUCT_ROOT_MISMATCH');
  const artifact = `8415wallet-dapp-delivery-${plan.productTree}.tar.gz`;
  const archiveBytes = regularFile(productRoot, `dist/${artifact}`).bytes;
  fail(sha256(archiveBytes) === verification.archiveSha256, 'PUBLIC_ARCHIVE_DIGEST_MISMATCH');
  const guideBytes = regularFile(outputRoot, PUBLIC_GUIDE).bytes;
  const guideSha256 = sha256(guideBytes);
  fail(guideSha256 === plan.tooling.files.find(file => file.path === 'docs/PUBLIC-PRODUCT-KIT.md')?.sha256,
    'PUBLIC_GUIDE_DIGEST_MISMATCH');
  const report = publicationReport(plan, artifact, verification.archiveSha256, guideSha256);
  const files = new Map([[artifact, archiveBytes], [PUBLIC_GUIDE, guideBytes], [PUBLIC_REPORT, jsonBytes(report)]]);
  files.set('SHA256SUMS', checksumBytes(files));
  // mkdir without recursive/writable reuse refuses stale dirs and symlink targets.
  const directory = join(outputRoot, 'publication'); mkdirSync(directory, { mode: 0o755 });
  for (const [path, bytes] of files) writeFileSync(join(directory, path), bytes, { flag: 'wx', mode: 0o644 });
  return verifyPublicFiles({ plan, outputRoot, verification });
}
/** Check the exact four public files, including all three checksum-covered files. */
export function verifyPublicFiles({ plan, outputRoot, verification }) {
  fail(verification?.productTree === plan.productTree && verification?.localProductCommit === plan.productCommit
    && verification?.sourceEntries === plan.productEntries.length && /^[a-f0-9]{64}$/.test(verification?.archiveSha256 ?? ''),
    'PUBLICATION_REQUIRES_VERIFIED_BUILD');
  outputRoot = safeDirectory(outputRoot);
  const artifact = `8415wallet-dapp-delivery-${plan.productTree}.tar.gz`;
  const paths = publicationPaths(outputRoot, artifact), directory = join(outputRoot, 'publication');
  const expected = [artifact, PUBLIC_GUIDE, PUBLIC_REPORT, 'SHA256SUMS'].sort();
  fail(JSON.stringify(walkFiles(directory)) === JSON.stringify(expected), 'PUBLICATION_EXACT_FOUR_FILES_REQUIRED');
  const files = new Map(expected.map(path => [path, regularFile(directory, path).bytes]));
  const report = JSON.parse(files.get(PUBLIC_REPORT));
  const archiveSha256 = sha256(files.get(artifact)), guideSha256 = sha256(files.get(PUBLIC_GUIDE));
  fail(archiveSha256 === verification.archiveSha256, 'PUBLIC_VERIFIED_ARCHIVE_PIN_MISMATCH');
  fail(guideSha256 === plan.tooling.files.find(file => file.path === 'docs/PUBLIC-PRODUCT-KIT.md')?.sha256,
    'PUBLIC_GUIDE_DIGEST_MISMATCH');
  fail(files.get(PUBLIC_REPORT).equals(jsonBytes(publicationReport(plan, artifact, archiveSha256, guideSha256))),
    'PUBLIC_REPORT_IDENTITY_MISMATCH');
  const covered = new Map([...files].filter(([path]) => path !== 'SHA256SUMS'));
  fail(files.get('SHA256SUMS').equals(checksumBytes(covered)), 'PUBLIC_CHECKSUMS_MISMATCH');
  return { status: VERIFIED_STATUS, paths, report, pins: {
    upstream_commit: plan.upstreamIdentity.commit, upstream_commit_tree: plan.upstreamIdentity.commitTree,
    upstream_tree: plan.upstreamIdentity.snapshotTree, product_tree: plan.productTree,
    local_product_commit: plan.productCommit, allowlist_sha256: plan.policySha256, tooling_sha256: plan.tooling.sha256,
    archive_sha256: archiveSha256, guide_sha256: guideSha256,
    checksums_sha256: sha256(files.get('SHA256SUMS')), report_sha256: sha256(files.get(PUBLIC_REPORT)),
  } };
}
function validateGithubOutput(githubOutput, outputRoot, plan) {
  fail(typeof githubOutput === 'string' && githubOutput && typeof process.env.GITHUB_OUTPUT === 'string'
    && process.env.GITHUB_OUTPUT && !/[\r\n]/.test(githubOutput), 'EXPLICIT_GITHUB_OUTPUT_REQUIRED');
  const path = resolve(githubOutput);
  fail(path === resolve(process.env.GITHUB_OUTPUT), 'GITHUB_OUTPUT_TARGET_MISMATCH');
  fail(disjoint(path, outputRoot) && disjoint(path, plan.sourceRoot), 'GITHUB_OUTPUT_MUST_BE_SEPARATE');
  safeDirectory(dirname(path));
  const stat = lstatSync(path);
  fail(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, 'GITHUB_OUTPUT_FILE_REQUIRED');
  return { path, stat };
}
/** No wildcard, guessed filename or fallback; emit only fully reverified publication paths. */
export function emitGithubOutputs({ githubOutput, outputRoot, plan, verification }) {
  const publication = verifyPublicFiles({ plan, outputRoot, verification });
  fail(publication.status === VERIFIED_STATUS, 'GITHUB_OUTPUT_REQUIRES_VERIFIED_BUILD');
  const { path, stat } = validateGithubOutput(githubOutput, outputRoot, plan);
  const values = { ...publication.paths, ...publication.pins };
  fail(Object.values(values).every(value => typeof value === 'string' && value && !/[\r\n]/.test(value)), 'GITHUB_OUTPUT_VALUE_REFUSED');
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    fail(opened.isFile() && opened.nlink === 1 && opened.dev === stat.dev && opened.ino === stat.ino, 'GITHUB_OUTPUT_TARGET_CHANGED');
    writeFileSync(fd, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''));
  } finally { closeSync(fd); }
  return publication;
}
export async function buildProduct(options) {
  // Validate an explicitly requested output file before spending build time, but never write it yet.
  if (options.githubOutput) {
    const preflight = inspectSource(options);
    validateGithubOutput(options.githubOutput, resolve(options.outputRoot ?? ''), preflight);
  }
  const result = materializeProduct(options), { plan, productRoot, outputRoot, report } = result;
  const run = (command, args) => execFileSync(command, args, { cwd: productRoot, env: cleanEnvironment(), stdio: 'inherit', timeout: 600000 });
  try {
    fail(!existsSync(join(productRoot, 'node_modules')) && !existsSync(join(productRoot, 'dist')), 'BUILD_OUTPUT_MUST_START_EMPTY');
    // Install from the exact lockfile, never copy developer dependencies. No hooks.
    run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', ...(options.offline ? ['--offline'] : [])]);
    verifyProductDirectory(plan, productRoot, plan.productTree, { buildOutputs: true });
    // All existing packers and strict verifiers execute unchanged in this checkout.
    run(process.execPath, ['scripts/package/build-delivery.mjs', ...(options.offline ? ['--offline'] : [])]);
    verifyProductDirectory(plan, productRoot, plan.productTree, { buildOutputs: true });
    const manifest = JSON.parse(readFileSync(join(productRoot, 'dist/delivery-package-manifest.json')));
    fail(ARCHIVE_PATTERN.test(manifest.artifact ?? '') && manifest.artifact === `8415wallet-dapp-delivery-${plan.productTree}.tar.gz`, 'BUILD_ARTIFACT_NAME_REFUSED');
    const archive = join(productRoot, 'dist', manifest.artifact), digest = sha256(regularFile(productRoot, `dist/${manifest.artifact}`).bytes);
    fail(digest === manifest.sha256, 'BUILD_ARCHIVE_DIGEST_MISMATCH');
    const verification = await verifyProductArchive({ ...options, archive, expectedArchiveSha256: digest, expectedProductTree: plan.productTree });
    report.status = VERIFIED_STATUS;
    report.archives = [{ artifact: manifest.artifact, sha256: digest, path: `product/dist/${manifest.artifact}` }];
    report.verification = verification;
    report.evidence = 'Local exact-source packaging and strict recursive verification. No publication, upstream CI, deployment, genuine device/public-chain or independent audit acceptance. Source pin and archive pin still require trusted release-owner distribution.';
    writeFileSync(join(outputRoot, PUBLIC_REPORT), jsonBytes(report), { mode: 0o644 });
    const publication = preparePublicFiles({ plan, productRoot, outputRoot, verification });
    if (options.githubOutput) emitGithubOutputs({ githubOutput: options.githubOutput, outputRoot, plan, verification });
    return { ...report, publication };
  } catch (error) {
    writeFileSync(join(outputRoot, 'PACKAGING-FAILED.txt'), `${error.message}\n`, { flag: 'wx', mode: 0o644 });
    throw error;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArguments(process.argv.slice(2), ['--mode', '--source', '--allowlist', '--allowlist-sha256', '--upstream-commit', '--upstream-tree', '--tooling-sha256', '--require-clean', '--output', '--product-tree', '--offline', '--github-output']);
    const options = commonOptions(args), mode = args['--mode'] ?? 'inspect';
    fail(['inspect', 'plan', 'build'].includes(mode), 'MODE_REFUSED');
    if (mode !== 'build') {
      fail(!args['--output'] && !args['--product-tree'] && !args['--offline'] && !args['--github-output'], 'INSPECT_ARGUMENT_SCOPE_REFUSED');
      console.log(JSON.stringify(planSummary(inspectSource(options)), null, 2));
    } else {
      fail(!args['--offline'] || ['true', 'false'].includes(args['--offline']), 'OFFLINE_FLAG_REFUSED');
      console.log(JSON.stringify(await buildProduct({ ...options, outputRoot: args['--output'], expectedProductTree: args['--product-tree'],
        offline: args['--offline'] === 'true', githubOutput: args['--github-output'] }), null, 2));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
