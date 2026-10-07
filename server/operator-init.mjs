/** New, terminal-only initial public binding tool. Never generates or reads a store key. */
import { open, lstat, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateAuthConfig } from './config-validation.mjs';
export const CONFIG_DIRECTORY = '/etc/8415wallet-auth-xiongan';
const CONFIG_FILE = `${CONFIG_DIRECTORY}/auth.json`;
export function initialXionganConfig(username, account, chainIds) {
  if (!Array.isArray(chainIds) || !chainIds.length || chainIds.some(chain => !['1', '8453'].includes(chain)) || new Set(chainIds).size !== chainIds.length) throw Error('AUTH_CONFIRMED_CHAIN_SCOPE_REQUIRED');
  const config = { origin: 'https://xiongan.8415wallet.com:9446', tenant: 'xiongan', port: 18417,
    statePath: '/var/lib/8415wallet-auth-xiongan/credentials.enc',
    accounts: [{ username, wallets: chainIds.map(chainId => ({ account, chainId })) }] };
  validateAuthConfig(config); return config;
}
async function protectedDirectory() {
  for (const directory of ['/etc', CONFIG_DIRECTORY]) {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) || await realpath(directory) !== directory) throw Error('AUTH_OPERATOR_DIRECTORY_REFUSED');
  }
  if ((await lstat(CONFIG_DIRECTORY)).mode & 0o077) throw Error('AUTH_OPERATOR_DIRECTORY_REFUSED');
}
export async function runOperatorInit(args, input = process.stdin, output = process.stdout) {
  if (args.length !== 1 || !['--help', '--check', '--initialize'].includes(args[0])) throw Error('AUTH_OPERATOR_ARGUMENT_REFUSED');
  if (args[0] === '--help') {
    output.write('New tool: --check validates fixed private config; --initialize requires root and an interactive trusted terminal, public EOA/chain confirmation, and creates config once. No secret input, password/store-key generation, listener or activation. Operator separately provisions the store key through systemd credentials.\n'); return;
  }
  if (process.platform !== 'linux' || process.getuid?.() !== 0) throw Error('AUTH_OPERATOR_LINUX_ROOT_REQUIRED');
  await protectedDirectory();
  if (args[0] === '--check') {
    const file = await open(CONFIG_FILE, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== 0 || (stat.mode & 0o077) || stat.size > 1_000_000) throw Error('AUTH_OPERATOR_CONFIG_FILE_REFUSED');
      const summary = validateAuthConfig(JSON.parse(await file.readFile('utf8')));
      output.write(JSON.stringify({ bindingConfigValid: true, ...summary, activated: false, storeKeyVerified: false }) + '\n');
    } finally { await file.close(); }
    return;
  }
  if (!input.isTTY || !output.isTTY) throw Error('AUTH_TRUSTED_TERMINAL_REQUIRED');
  const prompt = createInterface({ input, output });
  let file;
  try {
    const username = (await prompt.question('Confirmed username (default xiongan): ')).trim() || 'xiongan';
    const account = (await prompt.question('Public EOA controlled by you (never a private key): ')).trim();
    const chains = (await prompt.question('Confirmed Ethereum/Base chain scope (1, 8453, or 1,8453): ')).trim().split(',').map(v => v.trim());
    const config = initialXionganConfig(username, account, chains);
    if (await prompt.question('Independently verified EOA control and approved these bindings? Type APPROVED: ') !== 'APPROVED') throw Error('AUTH_BINDING_APPROVAL_REQUIRED');
    file = await open(CONFIG_FILE, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await file.writeFile(JSON.stringify(config, null, 2) + '\n'); await file.sync();
    const directory = await open(CONFIG_DIRECTORY, constants.O_RDONLY | constants.O_DIRECTORY); try { await directory.sync(); } finally { await directory.close(); }
    output.write('AUTH_CONFIG_CREATED_NOT_ACTIVATED: registered-wallet only. Store key remains independently operator-provisioned; no password, CA or TOTP configured.\n');
  } finally { await file?.close(); prompt.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runOperatorInit(process.argv.slice(2)).catch(error => {
    process.stderr.write(/^[A-Z0-9_]+$/.test(error.message) ? error.message + '\n' : 'AUTH_OPERATOR_INITIALIZATION_FAILED\n'); process.exitCode = 1;
  });
}
