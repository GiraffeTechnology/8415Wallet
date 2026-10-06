import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { captureAuthSource } from '../../scripts/package/build-auth.mjs';
import { AUTH_SCHEMA, AUTH_STATUS, AUTH_STATE_SEMANTICS, runtimePackage, sha256, walkAuth } from '../../scripts/package/verify-auth.mjs';
const sourceFiles = ['server/main.mjs', 'server/service-entry.mjs', 'server/runtime-entry.mjs', 'server/socket-path.mjs', 'server/mail-config.mjs', 'server/mail-otp.mjs', 'server/account-directory.mjs', 'server/recovery-service.mjs', 'server/registration-service.mjs', 'server/auth-service.mjs', 'server/crypto.mjs', 'server/config-validation.mjs', 'server/ca-verifier.mjs', 'server/store.mjs', 'server/operator-init.mjs', 'server/operator-activate.mjs', 'web/login-core.mjs', 'deploy/auth-xiongan/install.mjs', 'deploy/auth-xiongan/migrate-legacy.mjs', 'deploy/auth-xiongan/8415wallet-auth-xiongan.service', 'deploy/auth-xiongan/auth-location.nginx.conf', 'docs/AUTH-INSTALL.md', 'scripts/package/verify-auth.mjs', 'LICENSE'];
function put(root, path, data) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), data, { mode: 0o644 }); }
export function syntheticPackage(root, label = '', { mailSupported = true } = {}) {
  const source = join(root, 'source'), runtime = join(root, 'runtime'); mkdirSync(source); mkdirSync(runtime);
  const files = sourceFiles.filter(path => mailSupported || path !== 'server/mail-config.mjs');
  for (const path of files) put(source, path, readFileSync(new URL(`../../${path}`, import.meta.url)));
  if (label) put(source, 'docs/AUTH-INSTALL.md', readFileSync(join(source, 'docs/AUTH-INSTALL.md'), 'utf8') + `\nSynthetic upgrade marker: ${label}\n`);
  const pkg = { name: '8415wallet', version: '0.1.0', license: 'CC0-1.0', dependencies: { ethers: '^6.17.0' } };
  const lock = { name: pkg.name, lockfileVersion: 3, packages: { '': { dependencies: pkg.dependencies }, 'node_modules/ethers': { version: '6.17.0', resolved: 'https://registry.npmjs.org/ethers/-/ethers-6.17.0.tgz', integrity: 'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==' } } };
  put(source, 'package.json', JSON.stringify(pkg)); put(source, 'package-lock.json', JSON.stringify(lock));
  const git = args => execFileSync('git', args, { cwd: source, stdio: 'pipe' });
  git(['init', '-q']); git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Synthetic installation package']);
  const identity = captureAuthSource(source);
  for (const path of files) put(runtime, path, readFileSync(join(source, path)));
  const generated = runtimePackage(pkg, lock);
  put(runtime, 'package.json', JSON.stringify(generated.manifest)); put(runtime, 'package-lock.json', JSON.stringify(generated.lock));
  put(runtime, 'provenance/package.source.json', JSON.stringify(pkg)); put(runtime, 'provenance/package-lock.source.json', JSON.stringify(lock));
  put(runtime, 'node_modules/ethers/package.json', JSON.stringify({ name: 'ethers', version: '6.17.0' }));
  const release = { schema: AUTH_SCHEMA, status: AUTH_STATUS, source: identity, runtime: { node: '>=22.18.0', bundledNode: false, bundledProductionDependencies: true, credentialStoreFormat: 1, legacyImportProtocol: 1, authStateSemantics: AUTH_STATE_SEMANTICS }, files: Object.fromEntries(walkAuth(runtime).map(path => [path, sha256(readFileSync(join(runtime, path)))])) };
  put(runtime, 'AUTH-RELEASE.json', JSON.stringify(release));
  put(runtime, 'SHA256SUMS', walkAuth(runtime).map(path => `${sha256(readFileSync(join(runtime, path)))}  ${path}`).join('\n') + '\n');
  return runtime;
}
