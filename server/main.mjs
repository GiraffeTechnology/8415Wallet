/** Explicitly configured private-IPC or legacy loopback auth service; deploy behind the approved same-origin TLS proxy. */
import { createServer } from 'node:http';
import { readFile, chmod, lstat } from 'node:fs/promises';
import { createAuthService } from './auth-service.mjs';
import { openEncryptedStore } from './store.mjs';
import { createCaVerifier } from './ca-verifier.mjs';
import { protectSocketDirectory } from './socket-path.mjs';
import { validateAuthConfig } from './config-validation.mjs';
import { createOtpSenderFromEnvironment } from './mail-otp.mjs';
const configPath = process.env.WALLET_AUTH_CONFIG;
if (!configPath) throw new Error('WALLET_AUTH_CONFIG_REQUIRED');
const config = JSON.parse(await readFile(configPath, 'utf8'));
validateAuthConfig(config); // Refuse ambiguous bindings before opening credential state.
if (config.socketPath) {
  await protectSocketDirectory(config.socketPath);
  try { await lstat(config.socketPath); throw Error('AUTH_EXISTING_SOCKET_REFUSED'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
if (typeof config.statePath !== 'string' || !/^[a-fA-F0-9]{64}$/.test(process.env.WALLET_AUTH_STORE_KEY ?? '')) throw new Error('AUTH_ENCRYPTED_STORE_CONFIG_REQUIRED');
const store = await openEncryptedStore(config.statePath, Buffer.from(process.env.WALLET_AUTH_STORE_KEY, 'hex'));
try {
  const verifyCa = config.ca ? await createCaVerifier(config.ca) : null;
  const sendOtp = createOtpSenderFromEnvironment(process.env, config.mail); // No connection/send until a verified registration/recovery workflow requests it.
  const handler = createAuthService({ origin: config.origin, tenant: config.tenant, accounts: config.accounts, store, verifyCa, sendOtp });
  const server = createServer(handler);
  server.requestTimeout = 10000; server.headersTimeout = 10000; server.timeout = 15000;
  server.maxHeadersCount = 40;
  server.on('error', async error => { process.stderr.write(`AUTH_LISTENER_FAILED_${/^[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : 'UNKNOWN'}\n`); await store.close(); process.exitCode = 1; });
  if (config.socketPath) server.listen(config.socketPath, async () => {
    try { await chmod(config.socketPath, 0o666); process.stdout.write('8415wallet auth service listening on protected local socket. No credentials logged.\n'); }
    catch { server.close(async () => { await store.close(); process.exitCode = 1; }); }
  });
  else server.listen(config.port, '127.0.0.1', () => process.stdout.write('8415wallet auth service listening on configured legacy loopback port. No credentials logged.\n'));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => server.close(async () => { await store.close(); }));
} catch (error) { await store.close(); throw error; }
