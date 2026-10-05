/** Assemble existing independently verified UI/auth artifacts into one reusable kit. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureSource, deterministicArchive, sha256, walk } from './dapp-release.mjs';
import { DELIVERY_FILES, DELIVERY_SCHEMA, verifyDeliveryArchive } from './verify-delivery.mjs';
export function buildDelivery({ root = process.cwd(), rebuild = true, offline = false } = {}) {
  root = resolve(root);
  if (rebuild) {
    execFileSync('npm', ['run', 'pack:dapp:all'], { cwd: root, stdio: 'inherit' });
    execFileSync('npm', ['run', 'pack:auth', ...(offline ? ['--', '--offline'] : [])], { cwd: root, stdio: 'inherit' });
  }
  execFileSync('npm', ['run', 'pack:dapp:verify'], { cwd: root, stdio: 'inherit' });
  execFileSync('npm', ['run', 'pack:auth:verify'], { cwd: root, stdio: 'inherit' });
  const source = captureSource(root), output = join(root, 'dist');
  const manifests = Object.fromEntries(['v2', 'v3', 'auth'].map(id => [id, JSON.parse(readFileSync(join(output, id === 'auth' ? 'auth-package-manifest.json' : `dapp-${id}-package-manifest.json`), 'utf8'))]));
  for (const manifest of Object.values(manifests)) assert.equal(manifest.source.tree, source.tree, 'DAPP_DELIVERY_REBUILD_REQUIRED: source changed or artifact from another tree');
  assert.deepEqual(manifests.v2.sourceArchive, manifests.v3.sourceArchive, 'DAPP_DELIVERY_SOURCE_ARCHIVE_MISMATCH');
  for (const id of ['v2', 'v3']) {
    assert.equal(manifests[id].tenant.id, 'default', 'DAPP_DELIVERY_GENERIC_TEMPLATE_REQUIRED');
    assert.deepEqual(manifests[id].deployment, { environment: 'unconfigured', url: null }, 'DAPP_DELIVERY_NO_PRIVATE_ENDPOINTS');
  }
  const temporary = mkdtempSync(join(tmpdir(), 'wallet-delivery-build-'));
  try {
    for (const path of DELIVERY_FILES) {
      assert.ok(source.files[path], `DAPP_DELIVERY_STAGE_SOURCE_REQUIRED: ${path}`);
      mkdirSync(dirname(join(temporary, path)), { recursive: true }); cpSync(join(root, path), join(temporary, path));
      assert.equal(sha256(readFileSync(join(temporary, path))), source.files[path]);
    }
    const artifacts = { ...Object.fromEntries(Object.entries(manifests).map(([id, manifest]) => [id, { artifact: manifest.artifact, sha256: manifest.sha256 }])), source: manifests.v2.sourceArchive };
    mkdirSync(join(temporary, 'artifacts'));
    for (const item of Object.values(artifacts)) {
      assert.ok(/^[A-Za-z0-9_.-]+\.tar\.gz$/.test(item.artifact));
      cpSync(join(output, item.artifact), join(temporary, 'artifacts', item.artifact));
      assert.equal(sha256(readFileSync(join(temporary, 'artifacts', item.artifact))), item.sha256);
    }
    for (const id of ['v2', 'v3', 'auth']) {
      const path = id === 'auth' ? 'auth-package-manifest.json' : `dapp-${id}-package-manifest.json`;
      cpSync(join(output, path), join(temporary, 'artifacts', path));
    }
    const files = Object.fromEntries(walk(temporary).map(path => [path, sha256(readFileSync(join(temporary, path)))]));
    const release = { schema: DELIVERY_SCHEMA, product: '8415wallet', status: 'BETA_FUNCTIONAL_TESTING_NOT_INDEPENDENTLY_AUDITED',
      source: { commit: source.commit, tree: source.tree, dirty: source.dirty }, artifacts, files,
      runtime: { node: '>=22.18.0 (operator supplied)', installationNetwork: 'None; compiled browser UI and production auth dependencies bundled', openssl: 'OpenSSL 3 for configured hardware CA verification only' },
      scope: { install: 'Explicit tenant, profile, config and target; immutable origin; bounded UI release switch', auth: 'Separate reviewed auth installer and operator activation; never copy credential state into releases',
        infrastructure: 'No TLS, firewall, SSH, public listener or unrelated service changes', acceptance: 'Functional Beta packaging, not production deployment, physical-device, public-chain or independent audit acceptance' } };
    writeFileSync(join(temporary, 'DELIVERY.json'), JSON.stringify(release, null, 2) + '\n');
    writeFileSync(join(temporary, 'SHA256SUMS'), walk(temporary).map(path => `${sha256(readFileSync(join(temporary, path)))}  ${path}`).join('\n') + '\n');
    if (captureSource(root).tree !== source.tree) throw Error('DAPP_DELIVERY_SOURCE_CHANGED_DURING_BUILD');
    const artifact = `8415wallet-dapp-delivery-${source.tree}.tar.gz`, archive = join(output, artifact);
    const digest = deterministicArchive(temporary, archive);
    verifyDeliveryArchive(archive, { expectedSha256: digest, expectedTree: source.tree });
    const manifest = { artifact, sha256: digest, ...release };
    writeFileSync(join(output, 'delivery-package-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    return manifest;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2); if (new Set(args).size !== args.length || args.some(arg => !['--reuse', '--offline'].includes(arg))) throw Error('DAPP_DELIVERY_ARGUMENT_REFUSED');
  const result = buildDelivery({ rebuild: !args.includes('--reuse'), offline: args.includes('--offline') });
  console.log(`${result.artifact}\nsha256 ${result.sha256}\nsource tree ${result.source.tree}\nObtain and convey these pins through the release owner’s trusted channel; checksums alongside an archive alone do not authenticate its publisher.`);
}
