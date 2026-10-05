import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { listenOnUsablePort, reservedPortSet } from '../server/ports.mjs';

const close = (server: any) => new Promise<void>(resolve => server.close(() => resolve()));

test('reserved ports are host configuration and validated', () => {
  assert.deepEqual([...reservedPortSet(undefined)], []);
  assert.deepEqual([...reservedPortSet([19022, 19023])], [19022, 19023]);
  for (const value of [[0], [65536], ['19022'], 19022]) assert.throws(() => reservedPortSet(value), /RESERVED_PORTS_REFUSED/);
});

test('without a requested port the service binds a free OS-assigned port', async t => {
  const server = createServer(); t.after(() => close(server));
  const port = await listenOnUsablePort(server, { host: '127.0.0.1' });
  assert.ok(port > 0); assert.equal((server.address() as any).port, port);
});

test('a requested port is used when free and skipped when busy or reserved', async t => {
  const probe = createServer(); const free = await listenOnUsablePort(probe, { host: '127.0.0.1' }); await close(probe);
  const first = createServer(); t.after(() => close(first));
  assert.equal(await listenOnUsablePort(first, { host: '127.0.0.1', requested: free }), free);
  const second = createServer(); t.after(() => close(second));
  assert.notEqual(await listenOnUsablePort(second, { host: '127.0.0.1', requested: free }), free);
  const third = createServer(); t.after(() => close(third));
  const reserved = new Set([free + 1]);
  assert.notEqual(await listenOnUsablePort(third, { host: '127.0.0.1', requested: free + 1, reserved }), free + 1);
});

test('the auth service starts without a configured port and publishes the chosen one', async t => {
  const directory = await mkdtemp(join(tmpdir(), '8415-auth-port-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const portFile = join(directory, 'auth.port'), configPath = join(directory, 'auth.json');
  await writeFile(configPath, JSON.stringify({ origin: 'http://127.0.0.1:18080', tenant: 'platform', port: null, portFile,
    reservedPorts: [19022], statePath: join(directory, 'state', 'credentials.enc'),
    accounts: [{ username: 'tester', wallets: [{ account: '0x' + '1'.repeat(40), chainId: '1' }] }] }));
  const child = spawn(process.execPath, ['server/main.mjs'], { env: { ...process.env, WALLET_AUTH_CONFIG: configPath,
    WALLET_AUTH_STORE_KEY: randomBytes(32).toString('hex') }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { child.kill('SIGTERM'); });
  let port = 0;
  for (let i = 0; i < 100 && !port; i++) {
    port = Number((await readFile(portFile, 'utf8').catch(() => '')).trim()) || 0;
    if (!port) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(port > 0 && port !== 19022);
  // The reverse proxy preserves the public Host; fetch cannot set it, so use http.request.
  const { status, body } = await new Promise<{ status: number, body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/auth/capabilities', headers: { Host: '127.0.0.1:18080', 'X-Wallet-Tenant': 'platform' } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    req.on('error', reject); req.end();
  });
  assert.equal(status, 200);
  assert.equal(JSON.parse(body).tenant, 'platform');
});
