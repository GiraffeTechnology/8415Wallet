/** Tenant-scoped systemd credential entry. No key arguments or arbitrary filesystem paths. */
import { open, lstat, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname } from 'node:path';
import { protectSocketDirectory } from './socket-path.mjs';
import { validateAuthConfig } from './config-validation.mjs';
import { installedMailEnvironment } from './mail-config.mjs';
if (process.argv.length !== 4 || process.argv[2] !== '--tenant' || !/^[a-z][a-z0-9-]{0,47}$/.test(process.argv[3])) throw Error('AUTH_SERVICE_TENANT_REQUIRED');
const tenant = process.argv[3], name = `8415wallet-auth-${tenant}`;
if (process.platform !== 'linux' || process.getuid?.() !== 0 || process.geteuid?.() !== 0) throw Error('AUTH_SERVICE_IDENTITY_REQUIRED');
if (process.env.WALLET_AUTH_STORE_KEY || process.env.WALLET_AUTH_CONFIG || process.env.NODE_OPTIONS || process.env.NODE_PATH ||
    Object.keys(process.env).some(key => key.startsWith('WALLET_AUTH_SMTP_'))) throw Error('AUTH_AMBIENT_CREDENTIAL_REFUSED');
const credentialDirectory = `/run/credentials/${name}.service`, configDirectory = `/etc/${name}`;
if (process.env.CREDENTIALS_DIRECTORY !== credentialDirectory) throw Error('AUTH_CREDENTIAL_DIRECTORY_REFUSED');
async function directory(path, privateMode = false) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || stat.gid !== 0 || (stat.mode & (privateMode ? 0o7077 : 0o7022)) || await realpath(path) !== path) throw Error('AUTH_SERVICE_DIRECTORY_REFUSED');
}
async function privateFile(path, limit) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== 0 || stat.gid !== 0 || (stat.mode & 0o7077) || stat.size > limit) throw Error('AUTH_SERVICE_FILE_REFUSED');
    return await file.readFile();
  } finally { await file.close(); }
}
for (const leaf of [credentialDirectory, configDirectory, `/var/lib/${name}`]) {
  const ancestors = []; for (let path = leaf; ; path = dirname(path)) { ancestors.unshift(path); if (path === dirname(path)) break; }
  for (const path of ancestors) await directory(path, path === leaf);
}
const configPath = `${configDirectory}/auth.json`;
for (const lock of ['mail-config.lock', 'migration-config.lock']) {
  try { await lstat(`${configDirectory}/${lock}`); throw Error('AUTH_CONFIG_TRANSITION_IN_PROGRESS'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const config = JSON.parse(await privateFile(configPath, 1_000_000));
validateAuthConfig(config);
if (config.tenant !== tenant || config.statePath !== `/var/lib/${name}/credentials.enc` || config.socketPath !== `/run/${name}/auth.sock` || config.port !== undefined) throw Error('AUTH_SERVICE_CONFIG_BINDING_REFUSED');
await protectSocketDirectory(config.socketPath, 0);
let key;
try {
  key = await privateFile(`${credentialDirectory}/store-key`, 66);
  const text = key.toString('utf8').trim();
  if (!/^[a-fA-F0-9]{64}$/.test(text)) throw Error('AUTH_CREDENTIAL_FORMAT_REFUSED');
  process.env.WALLET_AUTH_STORE_KEY = text; process.env.WALLET_AUTH_CONFIG = configPath;
  Object.assign(process.env, await installedMailEnvironment(config.mail, credentialDirectory, privateFile));
  await import('./main.mjs');
} finally {
  key?.fill(0); delete process.env.WALLET_AUTH_STORE_KEY; delete process.env.WALLET_AUTH_CONFIG;
  for (const name of ['WALLET_AUTH_SMTP_PORT', 'WALLET_AUTH_SMTP_USERNAME', 'WALLET_AUTH_SMTP_PASSWORD']) delete process.env[name];
}
