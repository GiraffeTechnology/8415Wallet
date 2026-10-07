/** Human-operated first credential provisioning. Importing this module has no side effects. */
import * as filesystem from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { isatty } from 'node:tty';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hashPassword } from './crypto.mjs';
import { validateAuthConfig } from './config-validation.mjs';

export function activationPaths(tenant = 'xiongan') {
  if (typeof tenant !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(tenant)) throw Error('AUTH_OPERATOR_TENANT_REFUSED');
  const configDirectory = `/etc/8415wallet-auth-${tenant}`, stateDirectory = `/var/lib/8415wallet-auth-${tenant}`;
  return Object.freeze({ configDirectory, stateDirectory, config: `${configDirectory}/auth.json`,
    key: `${configDirectory}/store-key`, state: `${stateDirectory}/credentials.enc` });
}
export const ACTIVATION_PATHS = activationPaths();
const fail = code => { throw Error(code); };
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const privateFile = stat => stat.isFile() && stat.uid === 0 && stat.gid === 0 &&
  stat.nlink === 1 && (stat.mode & 0o7777) === 0o600;
const interrupted = signal => { if (signal.aborted) fail('AUTH_OPERATOR_CANCELLED'); };
const wipe = value => { if (Buffer.isBuffer(value)) value.fill(0); };

/** No shell, readline history, echo or password-bearing arguments. Raw mode is restored on exit. */
export function createTrustedTerminal(input, output, signal) {
  const previousRaw = Boolean(input.isRaw), wasPaused = input.isPaused();
  let pending = null, closed = false;
  function finish(error, value) {
    if (!pending) return;
    const current = pending; pending = null;
    current.characters.length = 0;
    if (error) current.reject(error); else current.resolve(value);
  }
  function onData(chunk) {
    if (!pending) return; // Discard unsolicited/pasted-ahead input, including secrets.
    try {
      const text = pending.decoder.decode(chunk, { stream: true });
      const end = text.search(/[\r\n]/);
      if (end !== -1 && !/^(\r\n|\r|\n)$/.test(text.slice(end))) fail('AUTH_TERMINAL_PASTE_REFUSED');
      for (const char of text) {
        if (!pending) break;
        if (char === '\r' || char === '\n') {
          pending.decoder.decode();
          output.write('\n'); finish(null, pending.characters.join('')); break;
        }
        if (char === '\u0003' || char === '\u0004') fail('AUTH_OPERATOR_CANCELLED');
        if (char === '\u007f' || char === '\b') {
          if (pending.characters.length) { pending.characters.pop(); if (!pending.hidden) output.write('\b \b'); }
          continue;
        }
        if (/\p{Cc}|\p{Cf}|\p{Cs}/u.test(char)) fail('AUTH_TERMINAL_CONTROL_REFUSED');
        pending.characters.push(char);
        if (Buffer.byteLength(pending.characters.join('')) > (pending.hidden ? 1024 : 256)) fail('AUTH_TERMINAL_INPUT_TOO_LONG');
        if (!pending.hidden) output.write(char);
      }
    } catch (error) { finish(error); }
  }
  const cancel = () => finish(Error('AUTH_OPERATOR_CANCELLED'));
  const inputError = () => finish(Error('AUTH_TERMINAL_INPUT_FAILED'));
  try {
    input.setRawMode(true); // Disable kernel echo before displaying any prompt.
    input.on('data', onData); input.on('end', cancel); input.on('error', inputError);
    signal.addEventListener('abort', cancel); input.resume();
  } catch {
    input.removeListener('data', onData); input.removeListener('end', cancel); input.removeListener('error', inputError);
    signal.removeEventListener('abort', cancel);
    if (wasPaused) input.pause();
    input.setRawMode(previousRaw);
    fail('AUTH_TERMINAL_SETUP_FAILED');
  }
  return {
    question(message, hidden = false) {
      interrupted(signal);
      if (closed || pending) fail('AUTH_TERMINAL_STATE_REFUSED');
      return new Promise((resolveAnswer, reject) => {
        pending = { resolve: resolveAnswer, reject, characters: [], hidden, decoder: new TextDecoder('utf-8', { fatal: true }) };
        try { output.write(message); } catch { finish(Error('AUTH_TERMINAL_OUTPUT_FAILED')); }
      });
    },
    close() {
      if (closed) return; closed = true; cancel();
      input.removeListener('data', onData); input.removeListener('end', cancel); input.removeListener('error', inputError);
      signal.removeEventListener('abort', cancel);
      if (wasPaused) input.pause();
      input.setRawMode(previousRaw);
    },
  };
}

/** Dependency injection is for synthetic tests only; the CLI accepts no path/secret overrides. */
export async function runOperatorActivate(args, input = process.stdin, output = process.stdout, dependencies = {}) {
  if (!Array.isArray(args) || !(args.length === 1 && ['--help', '--activate'].includes(args[0]) ||
    args.length === 3 && args[0] === '--activate' && args[1] === '--tenant')) fail('AUTH_OPERATOR_ARGUMENT_REFUSED');
  const tenant = args.length === 3 ? args[2] : 'xiongan';
  const selectedPaths = activationPaths(tenant);
  if (args[0] === '--help') {
    output.write('First activation only: --activate [--tenant TENANT] requires Linux root and a trusted interactive terminal. The default tenant is xiongan; tenant names contain only lowercase letters, digits and hyphens and start with a letter. Paths are derived under /etc/8415wallet-auth-TENANT and /var/lib/8415wallet-auth-TENANT; arbitrary path arguments are refused. It confirms creation of an independent 32-byte store key and optionally a hidden, confirmed password for an existing account without a password. Fixed root-owned 0700 config/state directories and a validated root-owned 0600 auth.json must already exist. Existing key, state, locks and unfinished staging are refused. No credential arguments or environment, service start, network access, account binding, password rotation or recovery. Run personally from a verified installation, with terminal recording disabled.\n');
    return;
  }
  const {
    fs = filesystem, paths = selectedPaths, platform = process.platform,
    getuid = () => process.getuid?.(), geteuid = () => process.geteuid?.(),
    environment = process.env, ttyCheck = isatty, terminalFactory = createTrustedTerminal,
    generateKey = randomBytes, passwordHasher = hashPassword,
  } = dependencies;
  if (platform !== 'linux' || getuid() !== 0 || geteuid() !== 0) fail('AUTH_OPERATOR_LINUX_ROOT_REQUIRED');
  if (Object.keys(environment).some(name => /^WALLET_AUTH_/i.test(name) ||
    /(^|_)(PASSWORD|PASSWD|SECRET|TOKEN|PRIVATE_KEY|STORE_KEY|CREDENTIALS?)(_|$)/i.test(name) ||
    ['NODE_OPTIONS', 'NODE_PATH'].includes(name))) fail('AUTH_AMBIENT_CREDENTIAL_ENV_REFUSED');
  if (!input.isTTY || !output.isTTY || !ttyCheck(input.fd) || !ttyCheck(output.fd) ||
    typeof input.setRawMode !== 'function') fail('AUTH_TRUSTED_TERMINAL_REQUIRED');

  const activationLock = `${paths.configDirectory}/.activation.lock`;
  const stateLock = `${paths.state}.lock`;
  const stagedKey = `${paths.configDirectory}/.activation-key`;
  const stagedConfig = `${paths.configDirectory}/.activation-config`;
  const backupConfig = `${paths.configDirectory}/.activation-original`;
  const controller = new AbortController(), signal = dependencies.signal ?? controller.signal;
  const cancel = () => controller.abort();
  for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(name, cancel);
  const owned = new Map(), directories = new Map(), openFiles = new Set();
  let terminal, original, configRecord, configInstalled = false, committed = false, untrackedCreate = false, key, encodedKey, password, repeated;

  async function absent(path) {
    try { await fs.lstat(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    fail('AUTH_EXISTING_CREDENTIAL_OR_STAGING_REFUSED');
  }
  async function verifyDirectory(path, privateDirectory = false) {
    const stat = await fs.lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || stat.gid !== 0 ||
      (stat.mode & 0o7022) || (privateDirectory && (stat.mode & 0o7777) !== 0o700) ||
      await fs.realpath(path) !== path) fail('AUTH_OPERATOR_DIRECTORY_REFUSED');
    if (directories.has(path) && !sameFile(stat, directories.get(path))) fail('AUTH_OPERATOR_DIRECTORY_CHANGED');
    directories.set(path, stat);
  }
  async function verifyDirectories() {
    for (const leaf of [paths.configDirectory, paths.stateDirectory]) {
      const ancestors = []; for (let path = leaf; ; path = dirname(path)) { ancestors.unshift(path); if (path === dirname(path)) break; }
      for (const path of ancestors) await verifyDirectory(path, path === leaf);
    }
  }
  async function syncDirectory(path) {
    await verifyDirectory(path, true);
    const file = await fs.open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      if (!sameFile(await file.stat(), directories.get(path))) fail('AUTH_OPERATOR_DIRECTORY_CHANGED');
      await file.sync();
    } finally { await file.close(); }
  }
  async function createPrivate(path, data) {
    const file = await fs.open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    // Keep an open descriptor until cleanup finishes, preventing inode-reuse races.
    openFiles.add(file); untrackedCreate = true;
    const stat = await file.stat(); owned.set(path, stat); untrackedCreate = false;
    if (!privateFile(stat)) fail('AUTH_OPERATOR_PRIVATE_FILE_REFUSED');
    await file.writeFile(data); await file.sync();
    return stat;
  }
  async function removeOwned(path) {
    if (!owned.has(path)) return;
    const stat = await fs.lstat(path);
    if (!sameFile(stat, owned.get(path)) || !stat.isFile() || stat.uid !== 0 || stat.gid !== 0) fail('AUTH_OPERATOR_RECOVERY_REQUIRED');
    await fs.unlink(path); owned.delete(path);
  }
  async function assertConfigUnchanged() {
    const stat = await fs.lstat(paths.config);
    if (!sameFile(stat, configRecord) || !privateFile(stat) ||
      stat.size !== configRecord.size || stat.mtimeMs !== configRecord.mtimeMs) {
      fail('AUTH_OPERATOR_CONFIG_CHANGED');
    }
    const copy = Buffer.alloc(configRecord.size);
    const { bytesRead } = await original.read(copy, 0, copy.length, 0);
    if (bytesRead !== copy.length || !copy.equals(originalBytes)) fail('AUTH_OPERATOR_CONFIG_CHANGED');
  }
  let originalBytes;
  try {
    interrupted(signal); await verifyDirectories();
    for (const path of [paths.key, paths.state, stateLock, activationLock, stagedKey, stagedConfig, backupConfig]) await absent(path);
    original = await fs.open(paths.config, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    configRecord = await original.stat();
    if (!privateFile(configRecord) || configRecord.size > 1_000_000) fail('AUTH_OPERATOR_CONFIG_FILE_REFUSED');
    originalBytes = await original.readFile();
    if (originalBytes.length !== configRecord.size) fail('AUTH_OPERATOR_CONFIG_CHANGED');
    const config = JSON.parse(originalBytes.toString('utf8'));
    validateAuthConfig(config);
    if (config.tenant !== tenant || config.statePath !== paths.state) fail('AUTH_OPERATOR_CONFIG_SCOPE_REFUSED');
    await createPrivate(activationLock, 'First credential provisioning in progress. Do not remove without operator review.\n');
    await createPrivate(stateLock, 'Operator activation in progress.\n');
    await syncDirectory(paths.configDirectory); await syncDirectory(paths.stateDirectory);
    await absent(paths.key); await absent(paths.state); await assertConfigUnchanged();
    interrupted(signal);
    terminal = terminalFactory(input, output, signal);
    output.write(`First credential provisioning for tenant ${tenant}. No service will start. Stop terminal recording before continuing. Existing verified public bindings will be preserved.\n`);
    const method = await terminal.question('Optional initial password: type PASSWORD to provision one, or NONE: ');
    if (!['PASSWORD', 'NONE'].includes(method)) fail('AUTH_PASSWORD_SELECTION_REQUIRED');
    let account;
    if (method === 'PASSWORD') {
      const username = await terminal.question('Existing account username for the initial password: ');
      account = config.accounts.find(value => value.username === username);
      if (!account) fail('AUTH_EXISTING_ACCOUNT_REQUIRED');
      if (account.passwordHash !== undefined) fail('AUTH_EXISTING_PASSWORD_REFUSED');
      password = await terminal.question('New password (hidden; at least 12 characters, at most 1024 UTF-8 bytes): ', true);
      repeated = await terminal.question('Confirm password (hidden): ', true);
      if (password !== repeated) fail('AUTH_PASSWORD_CONFIRMATION_REFUSED');
      if (password.length < 12 || Buffer.byteLength(password) > 1024) fail('PASSWORD_LENGTH_REFUSED');
      repeated = undefined;
    }
    if (await terminal.question('Create and privately save a NEW independent store key' + (account ? ' and the initial password hash' : '') + '? Type CREATE: ') !== 'CREATE') fail('AUTH_CREDENTIAL_APPROVAL_REQUIRED');
    interrupted(signal); await verifyDirectories(); await assertConfigUnchanged();
    await absent(paths.key); await absent(paths.state);
    if (account) { account.passwordHash = await passwordHasher(password); password = undefined; validateAuthConfig(config); }
    interrupted(signal);
    key = generateKey(32);
    if (!Buffer.isBuffer(key) || key.length !== 32) fail('AUTH_GENERATED_KEY_REFUSED');
    encodedKey = Buffer.from(key.toString('hex') + '\n', 'ascii');
    await createPrivate(stagedKey, encodedKey);
    wipe(key); wipe(encodedKey);
    if (account) {
      await createPrivate(stagedConfig, JSON.stringify(config, null, 2) + '\n');
      await assertConfigUnchanged();
      // Exclusive backup plus atomic rename preserves the original for pre-commit rollback.
      await fs.link(paths.config, backupConfig); owned.set(backupConfig, configRecord);
      const backup = await fs.lstat(backupConfig), current = await fs.lstat(paths.config);
      if (!sameFile(backup, configRecord) || !sameFile(current, configRecord) || backup.nlink !== 2) fail('AUTH_OPERATOR_CONFIG_CHANGED');
      await fs.rename(stagedConfig, paths.config);
      owned.set(paths.config, owned.get(stagedConfig)); owned.delete(stagedConfig); configInstalled = true;
      await syncDirectory(paths.configDirectory);
    }
    interrupted(signal); await absent(paths.state); await absent(paths.key);
    // link() is an atomic no-clobber publication; unlike rename it cannot replace an existing key.
    await fs.link(stagedKey, paths.key); owned.set(paths.key, owned.get(stagedKey));
    await removeOwned(stagedKey);
    if (!privateFile(await fs.lstat(paths.key))) fail('AUTH_OPERATOR_PRIVATE_FILE_REFUSED');
    await syncDirectory(paths.configDirectory); committed = true;
    await removeOwned(backupConfig);
    await syncDirectory(paths.configDirectory);
    await removeOwned(activationLock); await syncDirectory(paths.configDirectory);
    await removeOwned(stateLock); await syncDirectory(paths.stateDirectory);
    output.write('AUTH_CREDENTIALS_PREPARED_NOT_STARTED: independent store key saved privately' + (account ? '; initial password hash provisioned' : '') + '. No service, proxy, authenticator, account binding or network change performed.\n');
  } catch (error) {
    let recoveryRequired = committed || untrackedCreate;
    if (!recoveryRequired) {
      try {
        if (owned.has(paths.key)) { await absent(paths.state); await removeOwned(paths.key); }
        if (configInstalled) {
          const current = await fs.lstat(paths.config), backup = await fs.lstat(backupConfig);
          if (!sameFile(current, owned.get(paths.config)) || !sameFile(backup, configRecord) || !privateFile(backup)) fail('AUTH_OPERATOR_RECOVERY_REQUIRED');
          await fs.rename(backupConfig, paths.config); owned.delete(backupConfig); owned.delete(paths.config);
        }
        for (const path of [stagedKey, stagedConfig, backupConfig]) await removeOwned(path);
        if (owned.has(activationLock)) await syncDirectory(paths.configDirectory);
        await removeOwned(activationLock);
        if (owned.has(stateLock)) await syncDirectory(paths.stateDirectory);
        await removeOwned(stateLock);
      } catch { recoveryRequired = true; }
    }
    if (recoveryRequired) fail('AUTH_OPERATOR_RECOVERY_REQUIRED');
    throw error;
  } finally {
    wipe(key); wipe(encodedKey); password = undefined; repeated = undefined;
    for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.removeListener(name, cancel);
    try { terminal?.close(); } finally {
      await Promise.allSettled([...openFiles, ...(original ? [original] : [])].map(file => file.close()));
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runOperatorActivate(process.argv.slice(2)).catch(error => {
    process.stderr.write(/^[A-Z0-9_]+$/.test(error.message) ? error.message + '\n' : 'AUTH_OPERATOR_ACTIVATION_FAILED\n');
    process.exitCode = 1;
  });
}
