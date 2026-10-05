/** Explicitly configured loopback auth service; deploy behind the approved same-origin TLS proxy. */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createAuthService } from './auth-service.mjs';
import { openEncryptedStore } from './store.mjs';
import { createCaVerifier } from './ca-verifier.mjs';
import { listenOnUsablePort, reservedPortSet, writePortFile } from './ports.mjs';
const configPath = process.env.WALLET_AUTH_CONFIG;
if (!configPath) throw new Error('WALLET_AUTH_CONFIG_REQUIRED');
const config = JSON.parse(await readFile(configPath, 'utf8'));
// The port is chosen automatically unless one is requested; reserved ports
// (host configuration, e.g. SSH on CTYun) are never used.
const reserved = reservedPortSet(config.reservedPorts);
if (config.portFile !== undefined && config.portFile !== null && typeof config.portFile !== 'string') throw new Error('AUTH_PORT_FILE_REFUSED');
if (typeof config.statePath !== 'string' || !/^[a-fA-F0-9]{64}$/.test(process.env.WALLET_AUTH_STORE_KEY ?? '')) throw new Error('AUTH_ENCRYPTED_STORE_CONFIG_REQUIRED');
const store = await openEncryptedStore(config.statePath, Buffer.from(process.env.WALLET_AUTH_STORE_KEY, 'hex'));
try {
  const verifyCa = config.ca ? await createCaVerifier(config.ca) : null;
  const handler = createAuthService({ origin: config.origin, tenant: config.tenant, accounts: config.accounts, store, verifyCa,
    trustedProxyHeader: config.trustedProxyHeader ?? null });
  const server = createServer(handler);
  server.requestTimeout = 10000; server.headersTimeout = 10000; server.timeout = 15000;
  server.maxHeadersCount = 40;
  const port = await listenOnUsablePort(server, { host: '127.0.0.1', requested: config.port ?? null, reserved });
  server.on('error', async () => { await store.close(); process.exitCode = 1; });
  if (config.portFile) await writePortFile(config.portFile, port);
  process.stdout.write(`8415wallet auth service listening on 127.0.0.1:${port}. No credentials logged.\n`);
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => server.close(async () => { await store.close(); }));
} catch (error) { await store.close(); throw error; }
