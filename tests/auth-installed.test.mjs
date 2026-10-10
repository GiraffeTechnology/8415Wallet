/** Full offline package rehearsal. Every identity/key/password is a temporary synthetic fixture. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir, networkInterfaces } from 'node:os';
import { createServer as createTlsServer } from 'node:tls';
import { request } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { Wallet } from 'ethers';
import { prepare, inspect, paths, probe } from '../deploy/auth-xiongan/install.mjs';
import { runOperatorActivate } from '../server/operator-activate.mjs';
import { hotp } from '../server/crypto.mjs';
import { verifyAuthArchive, unpackAuthArchive } from '../scripts/package/verify-auth.mjs';
import { renderEnrollmentQr, clearEnrollmentQr } from '../web/enrollment-qr.mjs';
const decode = createRequire(import.meta.url)('./vendor/jsqr.cjs');
const syntheticKey = Buffer.alloc(32, 0x5a);
const signer = new Wallet(`0x${'0'.repeat(63)}1`); // Publicly known local-only test signer, never funded or transmitted to a chain.
const tenant = 'rehearsal', origin = 'https://rehearsal.example.invalid:19447';
const password = 'synthetic-integration-password', email = 'synthetic-user@example.invalid';
import { independentNode } from './helpers/independent-node.mjs';
const fixtureNode = await independentNode();
after(() => fixtureNode.cleanup());
const uid = process.getuid(), nodeUid = fixtureNode.uid;
function canvasFixture() {
  let width = 0, height = 0, pixels = new Uint8ClampedArray(0);
  const context = { fillStyle: '', fillRect(x, y, w, h) { const value = this.fillStyle === '#ffffff' ? 255 : 0; for (let r = y; r < y + h; r++) for (let c = x; c < x + w; c++) { const offset = (r * width + c) * 4; pixels.fill(value, offset, offset + 3); pixels[offset + 3] = 255; } } };
  return { hidden: true, get width() { return width; }, set width(v) { width = v; pixels = new Uint8ClampedArray(width * height * 4); }, get height() { return height; }, set height(v) { height = v; pixels = new Uint8ClampedArray(width * height * 4); }, getContext: () => context, pixels: () => pixels };
}
// Test only: real tempfile IO, injected ownership/TTY checks. This is not systemd/root identity evidence.
function activationFilesystem(privateRoots) {
  const annotate = (stat, path) => Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { uid: 0, gid: 0,
    mode: privateRoots.some(root => path === root || path.startsWith(root + '/')) ? stat.mode : (stat.mode & ~0o7777) | 0o755 });
  return { ...fs, lstat: async path => annotate(await fs.lstat(path), path), open: async (path, ...args) => {
    const handle = await fs.open(path, ...args);
    return new Proxy(handle, { get(object, key) { if (key === 'stat') return async () => annotate(await object.stat(), path); const value = object[key]; return typeof value === 'function' ? value.bind(object) : value; } });
  } };
}
// Real, bounded local TLS SMTP. The installed sender still validates its fixed
// hostname, pinned address, certificate, SMTP authentication and DATA acceptance.
// A temporary CA is trusted only by the synthetic child, never the system trust
// store. No DNS change, external mailbox, TLS bypass or production test flag.
async function localMail(root) {
  let interfaces; try { interfaces = networkInterfaces(); } catch { throw Error('AUTH_INSTALLED_TEST_INTERFACE_UNAVAILABLE'); }
  const address = Object.values(interfaces).flat().find(value => value && value.family === 'IPv4' && !value.internal &&
    /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(value.address))?.address;
  assert.ok(address, 'AUTH_INSTALLED_TEST_PRIVATE_IPV4_REQUIRED');
  const directory = join(root, 'synthetic-mail'); await fs.mkdir(directory, { mode: 0o700 });
  const key = join(directory, 'key.pem'), cert = join(directory, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=mail.8415wallet.com',
    '-addext', 'subjectAltName=DNS:mail.8415wallet.com', '-addext', 'extendedKeyUsage=serverAuth', '-keyout', key, '-out', cert], { stdio: 'ignore' });
  await fs.chmod(key, 0o600);
  const deliveries = [], errors = [], connections = new Set();
  const smtpUser = 'synthetic-installed-mail', smtpPassword = 'synthetic-installed-mail-password';
  const expectedAuth = Buffer.from(`\0${smtpUser}\0${smtpPassword}`).toString('base64');
  const server = createTlsServer({ key: await fs.readFile(key), cert: await fs.readFile(cert), minVersion: 'TLSv1.2', handshakeTimeout: 3000 }, socket => {
    connections.add(socket); let accepted = false;
    socket.once('close', () => connections.delete(socket)); socket.on('error', () => { if (!accepted) errors.push('SOCKET_ERROR'); });
    socket.setTimeout(5000, () => socket.destroy());
    if (socket.servername !== 'mail.8415wallet.com' || socket.remoteAddress !== address || !['TLSv1.2', 'TLSv1.3'].includes(socket.getProtocol())) {
      errors.push('TLS_BINDING_REFUSED'); socket.destroy(); return;
    }
    let buffer = '', body = [], data = false, authenticated = false, from = false, recipient = false;
    const reply = value => socket.write(`${value}\r\n`);
    const refuse = () => { errors.push('SMTP_SEQUENCE_REFUSED'); buffer = ''; body = []; socket.destroy(); };
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8'); if (buffer.length > 16384 || body.length > 64) { refuse(); return; }
      let end;
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (data) {
          if (line !== '.') { body.push(line); continue; }
          const message = body.join('\r\n'), code = /Your account method change verification code is: (\d{8})/.exec(message)?.[1];
          if (!code || !message.includes(`To: <${email}>`) || !message.includes('Subject: 8415wallet account method change verification') ||
              !message.includes('This code cannot log you in or approve a transaction.')) { refuse(); return; }
          deliveries.push({ to: email, code }); body = []; data = false; accepted = true; reply('250 accepted');
        } else if (line === 'EHLO 8415wallet.com') reply('250-local synthetic fixture\r\n250 AUTH PLAIN');
        else if (line === `AUTH PLAIN ${expectedAuth}`) { authenticated = true; reply('235 authenticated'); }
        else if (authenticated && line === 'MAIL FROM:<noreply@8415wallet.com>') { from = true; reply('250 ok'); }
        else if (from && line === `RCPT TO:<${email}>`) { recipient = true; reply('250 ok'); }
        else if (recipient && line === 'DATA') { data = true; reply('354 continue'); }
        else if (line === 'QUIT') socket.end('221 bye\r\n');
        else { refuse(); return; }
      }
    });
    reply('220 local synthetic fixture');
  });
  server.maxConnections = 2; server.on('tlsClientError', () => errors.push('TLS_CLIENT_REFUSED'));
  const close = async () => { for (const socket of connections) socket.destroy(); await new Promise(resolve => server.close(resolve)); };
  let port;
  try { server.listen(0, address); await once(server, 'listening'); port = server.address().port; assert.ok(port > 1023); }
  catch (error) { await close(); throw error; }
  return { config: { transport: 'smtp', port, addresses: [address] }, deliveries, errors,
    environment: { WALLET_AUTH_SMTP_PORT: String(port), WALLET_AUTH_SMTP_USERNAME: smtpUser, WALLET_AUTH_SMTP_PASSWORD: smtpPassword, NODE_EXTRA_CA_CERTS: cert },
    close };
}
async function startService(runtime, config, configPath, mailEnvironment) {
  const child = spawn(fixtureNode.node, ['server/main.mjs'], { cwd: runtime, env: { ...mailEnvironment, PATH: process.env.PATH, WALLET_AUTH_CONFIG: configPath, WALLET_AUTH_STORE_KEY: syntheticKey.toString('hex') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw Error(`PACKAGED_SERVICE_EXITED_${child.exitCode}: ${output.trim()}`);
    try { await probe(config); return { child, output: () => output }; } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  child.kill('SIGTERM'); throw Error('PACKAGED_SERVICE_START_TIMEOUT');
}
async function stopService(service) { if (service.child.exitCode === null) { const closed = once(service.child, 'exit'); service.child.kill('SIGTERM'); await closed; } }
function client(config) {
  const jar = new Map(); let csrf = '';
  return { async call(path, body, extra = {}) {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const response = await new Promise((yes, no) => {
      const req = request({ ...(config.socketPath ? { socketPath: config.socketPath } : { host: '127.0.0.1', port: config.port }), path: `/auth/${path}`, method: body === undefined ? 'GET' : 'POST',
        headers: { Host: new URL(config.origin).host, Origin: config.origin, 'X-Wallet-Tenant': config.tenant, 'X-Wallet-CSRF': csrf, Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...(encoded === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded) }), ...extra } }, res => {
        let raw = ''; res.on('data', chunk => { raw += chunk; }); res.on('end', () => { try { yes({ status: res.statusCode, headers: res.headers, data: JSON.parse(raw) }); } catch (error) { no(error); } });
      }); req.on('error', no); req.end(encoded);
    });
    for (const cookie of response.headers['set-cookie'] ?? []) { const [name, value] = cookie.split(';')[0].split('='); if (value) jar.set(name, value); else jar.delete(name); }
    if (response.status === 200 && response.data.csrf) csrf = response.data.csrf;
    return response;
  } };
}
test('verified offline package prepares, initializes synthetic credential, starts, enrolls local QR, consumes recovery and logs out across restart', { timeout: 45000 }, async t => {
  const manifestPath = resolve('dist/auth-package-manifest.json');
  const release = verifyAuthArchive(manifestPath); const manifest = JSON.parse(await fs.readFile(manifestPath));
  const runtime = unpackAuthArchive(join(dirname(manifestPath), manifest.artifact)); t.after(() => fs.rm(runtime, { recursive: true, force: true }));
  const root = await fs.mkdtemp(join(tmpdir(), 'wallet-auth-installed-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const mail = await localMail(root); t.after(() => mail.close());
  const target = paths(join(root, 'host'), tenant);
  for (const dir of [dirname(target.root), dirname(target.config), dirname(target.state), dirname(target.unit)]) await fs.mkdir(dir, { recursive: true, mode: 0o755 });
  const result = await prepare({ packageDirectory: runtime, target, uid, nodeUid, node: fixtureNode.node, origin, tenant, accounts: [{ username: 'synthetic-user', wallets: [{ account: signer.address, chainId: '8453' }] }], reservedPorts: [], mail: mail.config, reload: () => {} });
  assert.equal(result.sourceTree, release.source.tree); assert.equal(result.secretCreated, false);
  const statePath = join(target.state, 'credentials.enc'), configPath = join(target.config, 'auth.json');
  const prompts = ['PASSWORD', 'synthetic-user', password, password, 'CREATE']; let transcript = '';
  await runOperatorActivate(['--activate', '--tenant', tenant], { isTTY: true, fd: 0, setRawMode() {} }, { isTTY: true, fd: 1, write(value) { transcript += value; } }, {
    paths: { configDirectory: target.config, stateDirectory: target.state, config: configPath, key: join(target.config, 'store-key'), state: statePath },
    platform: 'linux', getuid: () => 0, geteuid: () => 0, environment: {}, ttyCheck: () => true,
    fs: activationFilesystem([target.config, target.state]), generateKey: () => Buffer.from(syntheticKey),
    terminalFactory: () => ({ question: async () => prompts.shift(), close() {} }),
  });
  assert.equal(prompts.length, 0); assert.equal(transcript.includes(syntheticKey.toString('hex')), false); assert.equal(transcript.includes('synthetic-integration-password'), false);
  const { config, receipt } = await inspect({ target, uid }); assert.ok(config.accounts[0].passwordHash); assert.deepEqual(config.mail, mail.config);
  await fs.mkdir(target.socketDirectory, { recursive: true, mode: 0o755 });
  let service = await startService(receipt.runtime, config, configPath, mail.environment); t.after(() => stopService(service));
  const c = client(config), selected = { username: 'synthetic-user', account: signer.address, chainId: '8453' };
  assert.equal((await c.call('capabilities')).status, 200);
  assert.equal((await c.call('capabilities', undefined, { 'X-Wallet-Tenant': 'other' })).status, 403);
  assert.equal((await c.call('capabilities', undefined, { Host: 'wrong.example.invalid' })).status, 403);
  assert.equal((await c.call('password', { ...selected, password })).status, 403);
  await c.call('bootstrap'); assert.equal((await c.call('password', { ...selected, password })).status, 200);
  // Retired URLs must explicitly direct a fresh session into the exact change flow.
  for (const route of ['totp/enroll/start', 'totp/enroll/confirm']) {
    const legacy = await c.call(route, {}); assert.equal(legacy.status, 409); assert.equal(legacy.data.error, 'AUTH_CHANGE_FLOW_REQUIRED');
  }
  const authorize = async (action, fields = {}) => {
    const before = mail.deliveries.length;
    const change = await c.call('account/change/start', { action, ...fields }); assert.equal(change.status, 200);
    assert.equal(change.data.factor, 'password'); assert.equal(change.data.action, action);
    const verified = await c.call('account/change/verify', { changeId: change.data.changeId, originalPassword: password });
    assert.equal(verified.status, 200); assert.equal(mail.deliveries.length, before + 1); assert.equal(mail.deliveries[before].to, email);
    const proof = await c.call('account/change/confirm', { changeId: change.data.changeId, code: mail.deliveries[before].code });
    assert.equal(proof.status, 200); assert.equal(proof.data.action, action); return proof;
  };
  // Operator initialization preserves login without inventing an already verified
  // email. Complete its explicit bootstrap through the installed HTTP service.
  const registration = await authorize('email.initial', { email });
  const migrated = await c.call('account/change/commit', { changeProof: registration.data.changeProof }); assert.equal(migrated.status, 200);
  assert.equal((await c.call('session')).status, 401);
  await c.call('bootstrap'); assert.equal((await c.call('password', { ...selected, password })).status, 200);
  const account = await c.call('account'); assert.equal(account.data.registration.complete, true); assert.equal(account.data.registration.email, email);
  const setup = await authorize('totp.initial');
  assert.equal(mail.deliveries.length, 2); assert.deepEqual(mail.errors, []);
  const canvas = canvasFixture(); renderEnrollmentQr(canvas, setup.data.uri);
  assert.equal(decode(canvas.pixels(), canvas.width, canvas.height)?.data === setup.data.uri, true, 'independent local QR decoder must match actual installed-server URI');
  clearEnrollmentQr(canvas); assert.equal(canvas.pixels().length, 0);
  const code = hotp(setup.data.secret, Math.floor(Date.now() / 30000));
  const confirmed = await c.call('account/change/commit', { changeProof: setup.data.changeProof, code }); assert.equal(confirmed.status, 200); assert.equal(confirmed.data.recoveryCodes.length, 8);
  assert.equal((await c.call('session')).status, 401);
  await c.call('bootstrap'); assert.equal((await c.call('totp', { ...selected, code })).status, 401);
  const recovery = { ...selected, code: confirmed.data.recoveryCodes[0], recovery: true };
  assert.equal((await c.call('totp', recovery)).status, 200); assert.equal((await c.call('logout', {})).status, 200); assert.equal((await c.call('session')).status, 401);
  const encrypted = await fs.readFile(statePath, 'utf8'); assert.equal(encrypted.includes(setup.data.secret), false); assert.equal(encrypted.includes(recovery.code), false);
  const firstOutput = service.output(); await stopService(service); service = await startService(receipt.runtime, config, configPath, mail.environment);
  const after = client(config); await after.call('bootstrap'); assert.equal((await after.call('totp', recovery)).status, 401);
  const challenge = (await after.call('challenge', { account: signer.address, chainId: '8453', method: 'wallet' })).data;
  assert.equal((await after.call('proof', { account: signer.address, chainId: '8453', id: challenge.id, signature: await signer.signMessage(challenge.message) })).status, 200);
  assert.equal((await after.call('logout', {})).status, 200);
  const output = firstOutput + service.output();
  for (const message of mail.deliveries) assert.equal(output.includes(message.code), false);
  assert.equal(output.includes(password), false); assert.deepEqual(mail.errors, []);
  assert.equal(output.includes(setup.data.secret), false); assert.equal(output.includes(recovery.code), false);
});
