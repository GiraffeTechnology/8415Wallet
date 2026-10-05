/** Loopback port selection for the auth service. No port is fixed in advance. */
import { writeFile, rename } from 'node:fs/promises';

const AUTO_ATTEMPTS = 16;
const validPort = value => Number.isInteger(value) && value >= 1 && value <= 65535;

// Ports the host keeps for other services. Environment configuration, never a product default.
export function reservedPortSet(value) {
  if (value === undefined || value === null) return new Set();
  if (!Array.isArray(value) || value.length > 64 || !value.every(validPort)) throw new Error('AUTH_RESERVED_PORTS_REFUSED');
  return new Set(value);
}

function listenOnce(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = error => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError); server.once('listening', onListening);
    server.listen(port, host);
  });
}

/** Listen on the requested port if it is free and not reserved, otherwise on an OS-assigned free port. */
export async function listenOnUsablePort(server, { host, requested = null, reserved = new Set() }) {
  if (requested !== null && requested !== undefined && !validPort(requested)) throw new Error('AUTH_PORT_REFUSED');
  const candidates = [...(validPort(requested) && !reserved.has(requested) ? [requested] : []), ...Array(AUTO_ATTEMPTS).fill(0)];
  for (const port of candidates) {
    try {
      await listenOnce(server, port, host);
    } catch (error) {
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') continue;
      throw error;
    }
    const bound = server.address().port;
    if (!reserved.has(bound)) return bound;
    await new Promise(resolve => server.close(resolve));
  }
  throw new Error('AUTH_NO_USABLE_PORT');
}

/** Publish the chosen port for the reverse proxy; written atomically. */
export async function writePortFile(path, port) {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${port}\n`, { mode: 0o644 });
  await rename(temp, path);
}
