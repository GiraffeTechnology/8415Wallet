/** Single-writer encrypted credential state. Sessions/challenges intentionally die on restart. */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { open, readFile, rename, unlink, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
export class MemoryCredentialStore {
  #data; #queue = Promise.resolve(); #failed = false;
  constructor(data = {}) { this.#data = structuredClone(data); }
  async read(username) { if (this.#failed) throw new Error('AUTH_STORE_UNHEALTHY'); return structuredClone(Object.hasOwn(this.#data, username) ? this.#data[username] : null); }
  async transaction(username, update) {
    const run = this.#queue.then(async () => {
      if (this.#failed) throw new Error('AUTH_STORE_UNHEALTHY');
      const next = structuredClone(this.#data), value = await update(Object.hasOwn(next, username) ? next[username] : null);
      next[username] = value;
      try { await this.persist(next); } catch (error) { this.#failed = true; throw error; }
      this.#data = next; return structuredClone(value);
    });
    this.#queue = run.catch(() => {}); return run;
  }
  async persist(_data) {}
  async close() { await this.#queue; }
}
export async function openEncryptedStore(path, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('AUTH_STORE_KEY_REQUIRED');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // Never infer that an existing lock is stale. Operators must establish that the
  // prior process stopped before removing it; concurrent replicas are unsupported.
  const lock = await open(`${path}.lock`, 'wx', 0o600);
  let initial = {};
  try {
    try {
      const raw = await readFile(path, 'utf8');
      if (raw.length > 4 * 1024 * 1024) throw new Error('AUTH_STORE_TOO_LARGE');
      const envelope = JSON.parse(raw);
      if (envelope.version !== 1) throw new Error('AUTH_STORE_VERSION_REFUSED');
      const decrypt = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
      decrypt.setAAD(Buffer.from('8415wallet-auth-store/1')); decrypt.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      initial = JSON.parse(Buffer.concat([decrypt.update(Buffer.from(envelope.data, 'base64')), decrypt.final()]).toString('utf8'));
      if (!initial || typeof initial !== 'object' || Array.isArray(initial)) throw new Error('AUTH_STORE_INVALID');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  } catch (error) { await lock.close(); await unlink(`${path}.lock`); throw error; }
  class EncryptedStore extends MemoryCredentialStore {
    async persist(data) {
      const iv = randomBytes(12), encrypt = createCipheriv('aes-256-gcm', key, iv);
      encrypt.setAAD(Buffer.from('8415wallet-auth-store/1'));
      const ciphertext = Buffer.concat([encrypt.update(JSON.stringify(data)), encrypt.final()]);
      const temp = `${path}.${randomBytes(12).toString('hex')}.tmp`;
      const file = await open(temp, 'wx', 0o600);
      try {
        await file.writeFile(JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: encrypt.getAuthTag().toString('base64'), data: ciphertext.toString('base64') }));
        await file.sync(); await file.close(); await rename(temp, path);
        const directory = await open(dirname(path), 'r'); try { await directory.sync(); } finally { await directory.close(); }
      } catch (error) { await file.close().catch(() => {}); await unlink(temp).catch(() => {}); throw error; }
    }
    async close() { await super.close(); await lock.close(); await unlink(`${path}.lock`); }
  }
  return new EncryptedStore(initial);
}
