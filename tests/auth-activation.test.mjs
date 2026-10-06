// Deterministic, disposable synthetic fixtures only. Never invokes the production CLI or randomBytes.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { runOperatorActivate, createTrustedTerminal } from '../server/operator-activate.mjs';

const syntheticPassword = 'synthetic fixture password';
const syntheticHash = `scrypt-v1$${'1'.repeat(32)}$${'2'.repeat(64)}`;
function statWith(stat, values) { return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, values); }

async function fixture(t, answers = ['NONE', 'CREATE']) {
  const root = await fs.mkdtemp(resolve('.activation-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const configDirectory = `${root}/config`, stateDirectory = `${root}/state`;
  await fs.mkdir(configDirectory, { mode: 0o700 }); await fs.mkdir(stateDirectory, { mode: 0o700 });
  const paths = { configDirectory, stateDirectory, config: `${configDirectory}/auth.json`, key: `${configDirectory}/store-key`, state: `${stateDirectory}/credentials.enc` };
  const config = { origin: 'https://synthetic.example:9446', tenant: 'xiongan', port: 21001,
    statePath: paths.state, accounts: [{ username: 'synthetic-user', wallets: [{ account: `0x${'1'.repeat(40)}`, chainId: '8453' }] }] };
  const original = JSON.stringify(config) + '\n';
  await fs.writeFile(paths.config, original, { mode: 0o600 });
  const calls = { keys: 0, hashes: 0, prompts: [], output: '', closed: false, buffers: [] };
  const rootStat = (path, stat) => statWith(stat, { uid: 0, gid: 0,
    ...(!path.startsWith(root) ? { mode: (stat.mode & ~0o7777) | 0o755 } : {}) });
  const syntheticFs = {
    ...fs,
    lstat: async path => rootStat(path, await fs.lstat(path)),
    open: async (path, flags, mode) => {
      const file = await fs.open(path, flags, mode);
      return new Proxy(file, { get(target, property) {
        if (property === 'stat') return async () => rootStat(path, await file.stat());
        const value = target[property]; return typeof value === 'function' ? value.bind(target) : value;
      } });
    },
  };
  const input = { isTTY: true, fd: 0, setRawMode() {} }, output = { isTTY: true, fd: 1, write(text) { calls.output += text; } };
  const dependencies = { paths, fs: syntheticFs, platform: 'linux', getuid: () => 0, geteuid: () => 0,
    environment: {}, ttyCheck: () => true,
    generateKey(size) { calls.keys++; assert.equal(size, 32); const key = Buffer.alloc(size, 0x42); calls.buffers.push(key); return key; },
    async passwordHasher(value) { calls.hashes++; assert.equal(value, syntheticPassword); return syntheticHash; },
    terminalFactory() { return { async question(prompt, hidden = false) {
      calls.prompts.push({ prompt, hidden }); assert.ok(answers.length, 'fixture has an answer');
      const next = answers.shift(); if (next instanceof Error) throw next; return next;
    }, close() { calls.closed = true; } }; },
  };
  const run = (overrides = {}, args = ['--activate']) => runOperatorActivate(args, input, output, { ...dependencies, ...overrides });
  return { root, paths, config, original, calls, dependencies, input, output, run, syntheticFs };
}
async function cleanTransaction(value, expectedConfig = value.original) {
  assert.equal(await fs.readFile(value.paths.config, 'utf8'), expectedConfig);
  assert.deepEqual((await fs.readdir(value.paths.configDirectory)).sort(), ['auth.json']);
  assert.deepEqual(await fs.readdir(value.paths.stateDirectory), []);
}
const passwordAnswers = () => ['PASSWORD', 'synthetic-user', syntheticPassword, syntheticPassword, 'CREATE'];

test('help is side-effect free and rejects all credential or override arguments', async () => {
  let text = '';
  await runOperatorActivate(['--help'], {}, { write(value) { text += value; } }, { fs: null });
  assert.match(text, /First activation only/); assert.match(text, /trusted interactive terminal/);
  for (const args of [[], ['--activate', '--password=fixture'], ['--key', 'fixture'], ['--config', '/tmp/fixture']]) {
    await assert.rejects(runOperatorActivate(args, {}, {}), /AUTH_OPERATOR_ARGUMENT_REFUSED/);
  }
});

test('key-only first activation publishes exactly one private synthetic key and preserves original config bytes', async t => {
  const value = await fixture(t); await value.run();
  assert.equal(await fs.readFile(value.paths.key, 'utf8'), '42'.repeat(32) + '\n');
  assert.equal((await fs.stat(value.paths.key)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(value.paths.key)).nlink, 1);
  assert.equal(await fs.readFile(value.paths.config, 'utf8'), value.original);
  assert.deepEqual((await fs.readdir(value.paths.configDirectory)).sort(), ['auth.json', 'store-key']);
  assert.deepEqual(await fs.readdir(value.paths.stateDirectory), []);
  assert.equal(value.calls.keys, 1); assert.equal(value.calls.hashes, 0); assert.ok(value.calls.closed);
  assert.ok(value.calls.buffers[0].every(byte => byte === 0));
  assert.doesNotMatch(value.calls.output, /4242424242/);
  assert.match(value.calls.output, /AUTH_CREDENTIALS_PREPARED_NOT_STARTED/);
});

test('initial password is entered twice with hidden prompts; only its hash changes config', async t => {
  const value = await fixture(t, passwordAnswers()); await value.run();
  const saved = JSON.parse(await fs.readFile(value.paths.config, 'utf8'));
  const expected = structuredClone(value.config); expected.accounts[0].passwordHash = syntheticHash;
  assert.deepEqual(saved, expected);
  assert.equal((await fs.stat(value.paths.config)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(value.paths.config)).nlink, 1);
  assert.deepEqual(value.calls.prompts.map(prompt => prompt.hidden), [false, false, true, true, false]);
  assert.equal(value.calls.hashes, 1); assert.equal(value.calls.keys, 1);
  assert.doesNotMatch(value.calls.output, /synthetic fixture password|scrypt-v1|4242424242/);
  assert.deepEqual((await fs.readdir(value.paths.configDirectory)).sort(), ['auth.json', 'store-key']);
});

for (const overrides of [{ platform: 'darwin' }, { getuid: () => 1000 }, { geteuid: () => 1000 }]) {
  test(`requires both real and effective Linux root: ${Object.keys(overrides)[0]}`, async t => {
    const value = await fixture(t); await assert.rejects(value.run(overrides), /AUTH_OPERATOR_LINUX_ROOT_REQUIRED/);
    assert.equal(value.calls.keys, 0); await cleanTransaction(value);
  });
}
for (const name of ['WALLET_AUTH_STORE_KEY', 'WALLET_AUTH_CONFIG', 'CREDENTIALS_DIRECTORY', 'PASSWORD', 'API_TOKEN', 'NODE_OPTIONS', 'NODE_PATH']) {
  test(`refuses even empty ambient credential or runtime variable ${name}`, async t => {
    const value = await fixture(t); await assert.rejects(value.run({ environment: { [name]: '' } }), /AUTH_AMBIENT_CREDENTIAL_ENV_REFUSED/);
    assert.equal(value.calls.keys, 0); await cleanTransaction(value);
  });
}
for (const mode of ['input pipe', 'output pipe', 'forged TTY property']) {
  test(`refuses ${mode}`, async t => {
    const value = await fixture(t);
    if (mode === 'input pipe') value.input.isTTY = false;
    if (mode === 'output pipe') value.output.isTTY = false;
    await assert.rejects(value.run(mode === 'forged TTY property' ? { ttyCheck: () => false } : {}), /AUTH_TRUSTED_TERMINAL_REQUIRED/);
    assert.equal(value.calls.keys, 0); await cleanTransaction(value);
  });
}
for (const kind of ['key', 'state', 'state lock', 'activation lock', 'staged key', 'staged config', 'backup']) {
  test(`refuses an existing ${kind} without replacing it`, async t => {
    const value = await fixture(t), p = value.paths;
    const path = { key: p.key, state: p.state, 'state lock': `${p.state}.lock`, 'activation lock': `${p.configDirectory}/.activation.lock`,
      'staged key': `${p.configDirectory}/.activation-key`, 'staged config': `${p.configDirectory}/.activation-config`, backup: `${p.configDirectory}/.activation-original` }[kind];
    await fs.writeFile(path, 'synthetic-existing', { mode: 0o600 });
    await assert.rejects(value.run(), /AUTH_EXISTING_CREDENTIAL_OR_STAGING_REFUSED/);
    assert.equal(await fs.readFile(path, 'utf8'), 'synthetic-existing'); assert.equal(value.calls.keys, 0);
  });
}
for (const kind of ['symlink', 'hardlink', 'group-readable', 'owner', 'group', 'directory']) {
  test(`refuses unsafe config ${kind}`, async t => {
    const value = await fixture(t);
    if (kind === 'symlink') { await fs.rename(value.paths.config, `${value.root}/original`); await fs.symlink(`${value.root}/original`, value.paths.config); }
    if (kind === 'hardlink') await fs.link(value.paths.config, `${value.root}/alias`);
    if (kind === 'group-readable') await fs.chmod(value.paths.config, 0o640);
    if (kind === 'directory') { await fs.unlink(value.paths.config); await fs.mkdir(value.paths.config); }
    const overrides = {};
    if (['owner', 'group'].includes(kind)) {
      overrides.fs = { ...value.syntheticFs, open: async (...args) => {
        const file = await value.syntheticFs.open(...args);
        if (args[0] === value.paths.config) return new Proxy(file, { get(target, property) {
          if (property === 'stat') return async () => statWith(await file.stat(), kind === 'owner' ? { uid: 1000 } : { gid: 1000 });
          return target[property];
        } });
        return file;
      } };
    }
    await assert.rejects(value.run(overrides)); assert.equal(value.calls.keys, 0);
  });
}
for (const kind of ['mode', 'owner', 'symlink']) {
  test(`refuses unsafe directory ${kind}`, async t => {
    const value = await fixture(t); const overrides = {};
    if (kind === 'mode') await fs.chmod(value.paths.stateDirectory, 0o750);
    if (kind === 'owner') overrides.fs = { ...value.syntheticFs, lstat: async path => statWith(await value.syntheticFs.lstat(path), path === value.paths.configDirectory ? { uid: 1000 } : {}) };
    if (kind === 'symlink') { await fs.rename(value.paths.stateDirectory, `${value.root}/actual-state`); await fs.symlink(`${value.root}/actual-state`, value.paths.stateDirectory); }
    await assert.rejects(value.run(overrides), /AUTH_OPERATOR_DIRECTORY_REFUSED/); assert.equal(value.calls.keys, 0);
  });
}
for (const delta of [{ tenant: 'platform' }, { statePath: '/tmp/wrong-state' }, { accounts: [] }, { credential: 'not-an-input' }]) {
  test(`refuses config scope or validation error ${Object.keys(delta)[0]}`, async t => {
    const value = await fixture(t); await fs.writeFile(value.paths.config, JSON.stringify({ ...value.config, ...delta }));
    await assert.rejects(value.run()); assert.equal(value.calls.keys, 0);
  });
}
for (const [name, answers, error] of [
  ['declined key creation', ['NONE', 'NO'], /AUTH_CREDENTIAL_APPROVAL_REQUIRED/],
  ['ambiguous password choice', ['', 'CREATE'], /AUTH_PASSWORD_SELECTION_REQUIRED/],
  ['unknown account', ['PASSWORD', 'unknown'], /AUTH_EXISTING_ACCOUNT_REQUIRED/],
  ['password mismatch', ['PASSWORD', 'synthetic-user', syntheticPassword, 'different fixture'], /AUTH_PASSWORD_CONFIRMATION_REFUSED/],
  ['short password', ['PASSWORD', 'synthetic-user', 'short', 'short'], /PASSWORD_LENGTH_REFUSED/],
  ['overlong password', ['PASSWORD', 'synthetic-user', 'x'.repeat(1025), 'x'.repeat(1025)], /PASSWORD_LENGTH_REFUSED/],
  ['terminal cancellation', [Error('AUTH_OPERATOR_CANCELLED')], /AUTH_OPERATOR_CANCELLED/],
]) {
  test(`${name} creates no credential and removes only its locks`, async t => {
    const value = await fixture(t, [...answers]); await assert.rejects(value.run(), error);
    assert.equal(value.calls.keys, 0); assert.equal(value.calls.hashes, 0); await cleanTransaction(value);
  });
}

test('an existing password is never overwritten by first activation', async t => {
  const value = await fixture(t, ['PASSWORD', 'synthetic-user']); value.config.accounts[0].passwordHash = syntheticHash;
  const before = JSON.stringify(value.config); await fs.writeFile(value.paths.config, before);
  await assert.rejects(value.run(), /AUTH_EXISTING_PASSWORD_REFUSED/);
  assert.equal(value.calls.keys, 0); assert.equal(value.calls.hashes, 0); await cleanTransaction(value, before);
});

test('config changed while operator prompts is refused before hashing or key generation', async t => {
  const value = await fixture(t);
  const factory = value.dependencies.terminalFactory;
  await assert.rejects(value.run({ terminalFactory(...args) {
    const terminal = factory(...args), question = terminal.question;
    terminal.question = async (...params) => { const answer = await question(...params); if (answer === 'CREATE') await fs.appendFile(value.paths.config, ' '); return answer; };
    return terminal;
  } }), /AUTH_OPERATOR_CONFIG_CHANGED/);
  assert.equal(value.calls.keys, 0); await cleanTransaction(value, value.original + ' ');
});

for (const stage of ['staged key write', 'staged config write', 'config rename', 'key publication']) {
  test(`failure at ${stage} atomically restores original config and cleans owned staging`, async t => {
    const value = await fixture(t, passwordAnswers()); let injected = false;
    const syntheticFs = { ...value.syntheticFs,
      open: async (...args) => {
        const file = await value.syntheticFs.open(...args);
        const suffix = stage === 'staged key write' ? '/.activation-key' : stage === 'staged config write' ? '/.activation-config' : null;
        if (suffix && args[0].endsWith(suffix)) return new Proxy(file, { get(target, property) {
          if (property === 'writeFile') return async () => { injected = true; throw Error('SYNTHETIC_WRITE_FAILURE'); };
          return target[property];
        } });
        return file;
      },
      rename: async (from, to) => { if (stage === 'config rename' && from.endsWith('/.activation-config')) { injected = true; throw Error('SYNTHETIC_RENAME_FAILURE'); } return fs.rename(from, to); },
      link: async (from, to) => { if (stage === 'key publication' && to === value.paths.key) { injected = true; throw Error('SYNTHETIC_LINK_FAILURE'); } return fs.link(from, to); },
    };
    await assert.rejects(value.run({ fs: syntheticFs }), /SYNTHETIC_/); assert.ok(injected);
    await cleanTransaction(value); assert.ok(value.calls.buffers.every(buffer => buffer.every(byte => byte === 0)));
  });
}

test('exclusive key publication preserves a raced existing key and restores config', async t => {
  const value = await fixture(t, passwordAnswers());
  await assert.rejects(value.run({ fs: { ...value.syntheticFs, link: async (from, to) => {
    if (to === value.paths.key) await fs.writeFile(to, 'synthetic-racing-key', { flag: 'wx', mode: 0o600 });
    return fs.link(from, to);
  } } }), { code: 'EEXIST' });
  assert.equal(await fs.readFile(value.paths.key, 'utf8'), 'synthetic-racing-key');
  assert.equal(await fs.readFile(value.paths.config, 'utf8'), value.original);
  assert.deepEqual((await fs.readdir(value.paths.configDirectory)).sort(), ['auth.json', 'store-key']);
  assert.deepEqual(await fs.readdir(value.paths.stateDirectory), []);
});

test('unsafe rollback keeps both locks for manual recovery rather than removing a replaced config', async t => {
  const value = await fixture(t, passwordAnswers());
  await assert.rejects(value.run({ fs: { ...value.syntheticFs, link: async (from, to) => {
    if (to === value.paths.key) {
      await fs.unlink(value.paths.config); await fs.writeFile(value.paths.config, 'synthetic-replacement', { mode: 0o600 });
      throw Error('SYNTHETIC_LINK_FAILURE');
    }
    return fs.link(from, to);
  } } }), /AUTH_OPERATOR_RECOVERY_REQUIRED/);
  assert.equal(await fs.readFile(value.paths.config, 'utf8'), 'synthetic-replacement');
  await fs.stat(`${value.paths.state}.lock`); await fs.stat(`${value.paths.configDirectory}/.activation.lock`);
  await assert.rejects(fs.stat(value.paths.key), { code: 'ENOENT' });
});

function terminalFixture() {
  const input = new EventEmitter(); let output = '', paused = true;
  Object.assign(input, { isRaw: false, isPaused: () => paused,
    pause() { paused = true; }, resume() { paused = false; }, setRawMode(value) { this.isRaw = value; } });
  const controller = new AbortController();
  const terminal = createTrustedTerminal(input, { write(text) { output += text; } }, controller.signal);
  return { input, terminal, controller, get output() { return output; }, get paused() { return paused; } };
}
test('terminal password input never echoes, handles UTF-8 and erasure, and restores terminal state', async () => {
  const value = terminalFixture(); assert.equal(value.input.isRaw, true);
  const question = value.terminal.question('Password: ', true);
  const bytes = Buffer.from('synthetic 密码x\x7f\r');
  for (const byte of bytes) value.input.emit('data', Buffer.from([byte]));
  assert.equal(await question, 'synthetic 密码'); assert.equal(value.output, 'Password: \n');
  value.terminal.close(); assert.equal(value.input.isRaw, false); assert.equal(value.paused, true);
  assert.equal(value.input.listenerCount('data'), 0);
});
for (const [name, data, error] of [
  ['Ctrl-C', '\x03', /AUTH_OPERATOR_CANCELLED/], ['Ctrl-D', '\x04', /AUTH_OPERATOR_CANCELLED/],
  ['multiline paste', 'fixture\rsecond secret\r', /AUTH_TERMINAL_PASTE_REFUSED/],
  ['control sequence', '\x1b[A', /AUTH_TERMINAL_CONTROL_REFUSED/],
  ['overlong hidden input', 'x'.repeat(1025), /AUTH_TERMINAL_INPUT_TOO_LONG/],
]) {
  test(`terminal ${name} fails without echoing the password`, async () => {
    const value = terminalFixture(), question = value.terminal.question('Password: ', true);
    value.input.emit('data', Buffer.from(data)); await assert.rejects(question, error);
    assert.equal(value.output, 'Password: '); value.terminal.close(); assert.equal(value.input.isRaw, false);
  });
}
test('terminal abort cancels pending input; typed-ahead data is discarded', async () => {
  const value = terminalFixture(); value.input.emit('data', Buffer.from('unsolicited secret'));
  const question = value.terminal.question('Password: ', true); value.controller.abort();
  await assert.rejects(question, /AUTH_OPERATOR_CANCELLED/); value.terminal.close();
  assert.equal(value.output, 'Password: '); assert.equal(value.input.isRaw, false);
});

test('tenant-scoped activation supports a reusable installation without arbitrary paths', async t => {
  const value = await fixture(t); value.config.tenant = 'synthetic-tenant';
  const before = JSON.stringify(value.config); await fs.writeFile(value.paths.config, before);
  await value.run({}, ['--activate', '--tenant', 'synthetic-tenant']);
  assert.equal(await fs.readFile(value.paths.config, 'utf8'), before);
  assert.match(value.calls.output, /tenant synthetic-tenant/);
  assert.equal(value.calls.keys, 1);
});
for (const tenant of ['../xiongan', 'UPPER', '', '-bad', 'a/b', 'a'.repeat(49), 'xiongan\0ignored']) {
  test(`refuses unsafe tenant parameter ${JSON.stringify(tenant)}`, async () => {
    await assert.rejects(runOperatorActivate(['--activate', '--tenant', tenant], {}, {}), /AUTH_OPERATOR_TENANT_REFUSED/);
  });
}

test('requested tenant must match already verified config', async t => {
  const value = await fixture(t);
  await assert.rejects(value.run({}, ['--activate', '--tenant', 'different']), /AUTH_OPERATOR_CONFIG_SCOPE_REFUSED/);
  assert.equal(value.calls.keys, 0); await cleanTransaction(value);
});

test('abort during hashing generates no key and cleans owned state', async t => {
  const value = await fixture(t, passwordAnswers()), controller = new AbortController();
  await assert.rejects(value.run({ signal: controller.signal, passwordHasher: async () => { controller.abort(); return syntheticHash; } }), /AUTH_OPERATOR_CANCELLED/);
  assert.equal(value.calls.keys, 0); await cleanTransaction(value);
});

test('a generated non-32-byte fixture is refused before persistence', async t => {
  const value = await fixture(t); const bytes = Buffer.alloc(31, 0x42);
  await assert.rejects(value.run({ generateKey: () => bytes }), /AUTH_GENERATED_KEY_REFUSED/);
  assert.ok(bytes.every(byte => byte === 0)); await cleanTransaction(value);
});

test('non-buffer key generator result is refused with no credential persistence', async t => {
  const value = await fixture(t);
  await assert.rejects(value.run({ generateKey: () => 'synthetic-not-bytes' }), /AUTH_GENERATED_KEY_REFUSED/);
  await cleanTransaction(value);
});

test('one-time publication fsync failure rolls back key and password together', async t => {
  const value = await fixture(t, passwordAnswers()); let injected = false;
  await assert.rejects(value.run({ fs: { ...value.syntheticFs, open: async (...args) => {
    const file = await value.syntheticFs.open(...args);
    if (args[0] !== value.paths.configDirectory) return file;
    return new Proxy(file, { get(target, property) {
      if (property === 'sync') return async () => {
        let published = false; try { await fs.stat(value.paths.key); published = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (published && !injected) { injected = true; throw Error('SYNTHETIC_FSYNC_FAILURE'); }
        return file.sync();
      };
      return target[property];
    } });
  } } }), /SYNTHETIC_FSYNC_FAILURE/);
  assert.ok(injected); await cleanTransaction(value);
});

test('post-commit cleanup failure preserves durable credentials and locks for review', async t => {
  const value = await fixture(t, passwordAnswers());
  await assert.rejects(value.run({ fs: { ...value.syntheticFs, unlink: async path => {
    if (path.endsWith('/.activation-original')) throw Error('SYNTHETIC_CLEANUP_FAILURE');
    return fs.unlink(path);
  } } }), /AUTH_OPERATOR_RECOVERY_REQUIRED/);
  assert.equal(await fs.readFile(value.paths.key, 'utf8'), '42'.repeat(32) + '\n');
  assert.equal(JSON.parse(await fs.readFile(value.paths.config, 'utf8')).accounts[0].passwordHash, syntheticHash);
  await fs.stat(`${value.paths.state}.lock`); await fs.stat(`${value.paths.configDirectory}/.activation.lock`);
  assert.doesNotMatch(value.calls.output, /AUTH_CREDENTIALS_PREPARED_NOT_STARTED/);
});

test('failure to identify a newly created file requires manual review and keeps service blocked', async t => {
  const value = await fixture(t);
  await assert.rejects(value.run({ fs: { ...value.syntheticFs, open: async (...args) => {
    const file = await value.syntheticFs.open(...args);
    if (!args[0].endsWith('/.activation-key')) return file;
    return new Proxy(file, { get(target, property) {
      if (property === 'stat') return async () => { throw Error('SYNTHETIC_STAT_FAILURE'); };
      return target[property];
    } });
  } } }), /AUTH_OPERATOR_RECOVERY_REQUIRED/);
  await fs.stat(`${value.paths.state}.lock`); await fs.stat(`${value.paths.configDirectory}/.activation.lock`);
  await assert.rejects(fs.stat(value.paths.key), { code: 'ENOENT' });
  assert.equal(await fs.readFile(value.paths.config, 'utf8'), value.original);
});

test('simultaneous first activation is refused before generating a second key', async t => {
  const value = await fixture(t); let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  let questions = 0;
  const first = value.run({ terminalFactory: () => ({
    async question() { if (++questions === 1) { enter(); await held; return 'NONE'; } return 'CREATE'; }, close() {},
  }) });
  await entered;
  await assert.rejects(value.run(), /AUTH_EXISTING_CREDENTIAL_OR_STAGING_REFUSED/);
  assert.equal(value.calls.keys, 0); release(); await first; assert.equal(value.calls.keys, 1);
});

test('terminal initialization failure restores raw mode and removes listeners', () => {
  const input = new EventEmitter();
  Object.assign(input, { isRaw: false, isPaused: () => true, pause() {},
    resume() { throw Error('SYNTHETIC_RESUME_FAILURE'); }, setRawMode(value) { this.isRaw = value; } });
  assert.throws(() => createTrustedTerminal(input, { write() {} }, new AbortController().signal), /AUTH_TERMINAL_SETUP_FAILED/);
  assert.equal(input.isRaw, false); assert.equal(input.listenerCount('data'), 0);
});
