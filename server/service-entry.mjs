/** Fixed systemd credential entry; do not invoke until operator activation. */
import { open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
if (process.platform !== 'linux' || process.getuid?.() !== 0) throw Error('AUTH_SERVICE_IDENTITY_REQUIRED');
if (process.env.WALLET_AUTH_STORE_KEY) throw Error('AUTH_AMBIENT_STORE_KEY_REFUSED');
if (process.env.CREDENTIALS_DIRECTORY !== '/run/credentials/8415wallet-auth-xiongan.service') throw Error('AUTH_CREDENTIAL_DIRECTORY_REFUSED');
const directory = await lstat(process.env.CREDENTIALS_DIRECTORY);
if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== 0 || (directory.mode & 0o077)) throw Error('AUTH_CREDENTIAL_DIRECTORY_REFUSED');
const file = await open(`${process.env.CREDENTIALS_DIRECTORY}/store-key`, constants.O_RDONLY | constants.O_NOFOLLOW);
let key;
try {
  const stat = await file.stat();
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== 0 || (stat.mode & 0o077) || stat.size > 66) throw Error('AUTH_CREDENTIAL_FILE_REFUSED');
  key = await file.readFile();
  const text = key.toString('utf8').trim();
  if (!/^[a-fA-F0-9]{64}$/.test(text)) throw Error('AUTH_CREDENTIAL_FORMAT_REFUSED');
  process.env.WALLET_AUTH_STORE_KEY = text;
  process.env.WALLET_AUTH_CONFIG = '/etc/8415wallet-auth-xiongan/auth.json';
  await import('./main.mjs');
} finally { key?.fill(0); delete process.env.WALLET_AUTH_STORE_KEY; await file.close(); }
