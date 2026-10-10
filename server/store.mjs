/** Single-writer encrypted credential state. Sessions/challenges intentionally die on restart. */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { open, readFile, rename, unlink, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
export const MAX_STORE_BYTES = 4 * 1024 * 1024;
const envelopeOverhead = Buffer.byteLength(JSON.stringify({ version: 1, iv: 'A'.repeat(16), tag: 'A'.repeat(24), data: '' }));
function checkStoreSize(data) {
  const bytes = Buffer.byteLength(JSON.stringify(data));
  if (4 * Math.ceil(bytes / 3) + envelopeOverhead > MAX_STORE_BYTES) throw new Error('AUTH_STORE_CAPACITY');
}
export class MemoryCredentialStore {
  #data; #queue = Promise.resolve(); #failed = false;
  constructor(data = {}) { this.#data = structuredClone(data); }
  async read(username) { if (this.#failed) throw new Error('AUTH_STORE_UNHEALTHY'); return structuredClone(Object.hasOwn(this.#data, username) ? this.#data[username] : null); }
  async readMany(keys) {
    if (!Array.isArray(keys) || !keys.length || keys.some(key => typeof key !== 'string' || !key ||
      ['__proto__', 'constructor', 'prototype'].includes(key)) || new Set(keys).size !== keys.length) throw new Error('AUTH_STORE_KEYS_REFUSED');
    const run = this.#queue.then(() => {
      if (this.#failed) throw new Error('AUTH_STORE_UNHEALTHY');
      return structuredClone(Object.fromEntries(keys.map(key => [key, Object.hasOwn(this.#data, key) ? this.#data[key] : null])));
    });
    this.#queue = run.catch(() => {}); return run;
  }
  async transaction(username, update) {
    const result = await this.transactionMany([username], async values => ({ [username]: await update(values[username]) }));
    return result[username];
  }
  // One queue entry and durable replace cover every index/credential involved.
  // Keys cannot escape the explicit selection; failures leave all old values intact.
  async transactionMany(keys, update) {
    if (!Array.isArray(keys) || !keys.length || keys.some(key => typeof key !== 'string' || !key ||
      ['__proto__', 'constructor', 'prototype'].includes(key)) || new Set(keys).size !== keys.length) throw new Error('AUTH_STORE_KEYS_REFUSED');
    const run = this.#queue.then(async () => {
      if (this.#failed) throw new Error('AUTH_STORE_UNHEALTHY');
      const next = structuredClone(this.#data);
      const values = Object.fromEntries(keys.map(key => [key, Object.hasOwn(next, key) ? next[key] : null]));
      const changed = await update(values);
      if (!changed || typeof changed !== 'object' || Array.isArray(changed) ||
        Object.keys(changed).length !== keys.length || keys.some(key => !Object.hasOwn(changed, key))) throw new Error('AUTH_STORE_UPDATE_REFUSED');
      for (const key of keys) next[key] = structuredClone(changed[key]);
      checkStoreSize(next); // Rejected capacity is not a failed/uncertain durable write.
      try { await this.persist(next); } catch (error) { this.#failed = true; throw error; }
      this.#data = next; return structuredClone(changed);
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
      if (Buffer.byteLength(raw) > MAX_STORE_BYTES) throw new Error('AUTH_STORE_TOO_LARGE');
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
