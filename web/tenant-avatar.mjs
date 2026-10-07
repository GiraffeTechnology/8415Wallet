import { resolveReleaseProfile, verifyReleaseLocation } from './release-profile.mjs';

/** Optional browser-local decoration. Never an identity, login or tenant-server setting. */
export const AVATAR_LIMITS = Object.freeze({ maxBytes: 2 * 1024 * 1024, maxDimension: 2048, maxPixels: 4 * 1024 * 1024 });
const MIME_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp']);
const contexts = new WeakSet();
const SCHEMA = '8415wallet-tenant-avatar/1';
export class TenantAvatarError extends Error {
  constructor(code) { super(code); this.name = 'TenantAvatarError'; this.code = code; }
}
const fail = code => { throw new TenantAvatarError(code); };
const aborted = signal => { if (signal?.aborted) fail('AVATAR_CANCELLED'); };
const checkContext = context => { if (!context || !contexts.has(context)) fail('AVATAR_CONTEXT_REFUSED'); };
const dimensions = (width, height) => {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      width > AVATAR_LIMITS.maxDimension || height > AVATAR_LIMITS.maxDimension || width * height > AVATAR_LIMITS.maxPixels) fail('AVATAR_DIMENSIONS_REFUSED');
};

/** Pass the resolved getReleaseProfile() result, not UI text or account state. */
export function createTenantAvatarContext(profile, location = globalThis.location) {
  let validated, actual;
  try {
    validated = resolveReleaseProfile({ schema: '8415wallet-release/1', product: profile.product, platform: profile.platform,
      profile: profile.id, tenant: profile.tenant, deployment: profile.deployment });
    actual = new URL(location.href);
    verifyReleaseLocation(validated, location);
  } catch { fail('AVATAR_CONTEXT_REFUSED'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(actual.hostname);
  if (actual.username || actual.password || actual.origin === 'null' ||
      !(actual.protocol === 'https:' || (actual.protocol === 'http:' && loopback))) fail('AVATAR_ORIGIN_REFUSED');
  const context = Object.freeze({ origin: actual.origin, profile: validated.id, tenantId: validated.tenant.id,
    key: JSON.stringify([SCHEMA, actual.origin, validated.id, validated.tenant.id]) });
  contexts.add(context);
  return context;
}

function rasterHeader(bytes) {
  const ascii = (at, text) => [...text].every((character, index) => bytes[at + index] === character.charCodeAt(0));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 33 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) {
    if (view.getUint32(8) !== 13 || !ascii(12, 'IHDR')) fail('AVATAR_FORMAT_REFUSED');
    return { mime: 'image/png', width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
    let offset = 2;
    while (offset + 3 < bytes.length) {
      if (bytes[offset++] !== 255) fail('AVATAR_FORMAT_REFUSED');
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 217 || marker === 218 || marker === undefined) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (offset + 2 > bytes.length) break;
      const size = view.getUint16(offset);
      if (size < 2 || offset + size > bytes.length) break;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
        if (size < 8) break;
        return { mime: 'image/jpeg', width: view.getUint16(offset + 5), height: view.getUint16(offset + 3) };
      }
      offset += size;
    }
    fail('AVATAR_FORMAT_REFUSED');
  }
  if (bytes.length >= 26 && ascii(0, 'RIFF') && ascii(8, 'WEBP') && view.getUint32(4, true) + 8 === bytes.length) {
    const chunkSize = view.getUint32(16, true);
    if (chunkSize + 20 > bytes.length) fail('AVATAR_FORMAT_REFUSED');
    const uint24 = at => bytes[at] | bytes[at + 1] << 8 | bytes[at + 2] << 16;
    if (ascii(12, 'VP8X') && bytes.length >= 30 && chunkSize === 10) return { mime: 'image/webp', width: uint24(24) + 1, height: uint24(27) + 1 };
    if (ascii(12, 'VP8 ') && chunkSize >= 10 && bytes[20] % 2 === 0 && bytes[23] === 157 && bytes[24] === 1 && bytes[25] === 42)
      return { mime: 'image/webp', width: view.getUint16(26, true) & 16383, height: view.getUint16(28, true) & 16383 };
    if (ascii(12, 'VP8L') && chunkSize >= 5 && bytes[20] === 47)
      return { mime: 'image/webp', width: 1 + (view.getUint32(21, true) & 16383), height: 1 + (view.getUint32(21, true) >>> 14 & 16383) };
  }
  fail('AVATAR_FORMAT_REFUSED');
}

function abortable(promise, signal, discard = () => {}) {
  aborted(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => { if (settled) return; settled = true; signal?.removeEventListener('abort', cancel); fn(value); };
    const cancel = () => finish(reject, new TenantAvatarError('AVATAR_CANCELLED'));
    signal?.addEventListener('abort', cancel, { once: true });
    Promise.resolve(promise).then(value => { if (settled) discard(value); else finish(resolve, value); }, error => finish(reject, error));
  });
}

async function decodeRaster(blob, signal) {
  if (typeof globalThis.createImageBitmap === 'function') {
    return abortable(globalThis.createImageBitmap(blob), signal, bitmap => bitmap.close?.());
  }
  if (typeof globalThis.Image !== 'function' || typeof globalThis.URL?.createObjectURL !== 'function') fail('AVATAR_DECODE_UNAVAILABLE');
  return new Promise((resolve, reject) => {
    const image = new globalThis.Image(), url = globalThis.URL.createObjectURL(blob);
    const clean = () => { image.onload = image.onerror = null; signal?.removeEventListener('abort', cancel); image.src = ''; globalThis.URL.revokeObjectURL(url); };
    const cancel = () => { clean(); reject(new TenantAvatarError('AVATAR_CANCELLED')); };
    image.onload = () => { const result = { width: image.naturalWidth, height: image.naturalHeight }; clean(); resolve(result); };
    image.onerror = () => { clean(); reject(new TenantAvatarError('AVATAR_DECODE_REFUSED')); };
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel(); else image.src = url;
  });
}

/** Validate bytes before decoding; MIME/extension alone never authorizes rendering. */
export async function validateTenantAvatar(blob, { signal, decodeImage = decodeRaster } = {}) {
  aborted(signal);
  if (!(blob instanceof Blob) || !MIME_TYPES.includes(blob.type)) fail('AVATAR_TYPE_REFUSED');
  if (blob.size < 1 || blob.size > AVATAR_LIMITS.maxBytes) fail('AVATAR_SIZE_REFUSED');
  let header, image;
  try {
    const bytes = new Uint8Array(await abortable(blob.arrayBuffer(), signal));
    header = rasterHeader(bytes);
    if (header.mime !== blob.type) fail('AVATAR_TYPE_REFUSED');
    dimensions(header.width, header.height);
    aborted(signal);
    image = await abortable(Promise.resolve().then(() => decodeImage(blob, signal)), signal, result => result?.close?.());
    aborted(signal);
    dimensions(image?.width, image?.height);
    // JPEG orientation can legitimately exchange width and height.
    if (!((header.width === image.width && header.height === image.height) ||
        (header.mime === 'image/jpeg' && header.width === image.height && header.height === image.width))) fail('AVATAR_DIMENSIONS_REFUSED');
    // Drop File.name/lastModified from the durable record; store only a raster Blob.
    return Object.freeze({ blob: blob.slice(0, blob.size, header.mime), mime: header.mime, width: image.width, height: image.height });
  } catch (error) {
    if (error instanceof TenantAvatarError) throw error;
    fail('AVATAR_DECODE_REFUSED');
  } finally { image?.close?.(); }
}

/** Origin-scoped IndexedDB. No localStorage, network or in-memory persistence fallback. */
export class BrowserTenantAvatarStore {
  constructor({ indexedDB = globalThis.indexedDB, secureContext = globalThis.isSecureContext } = {}) {
    this.indexedDB = indexedDB; this.secureContext = secureContext;
  }
  async database(signal) {
    aborted(signal);
    if (!this.indexedDB || this.secureContext !== true) fail('AVATAR_STORAGE_UNAVAILABLE');
    return new Promise((resolve, reject) => {
      let request, settled = false;
      const finish = (fn, value) => { if (settled) return; settled = true; signal?.removeEventListener('abort', cancel); fn(value); };
      const cancel = () => finish(reject, new TenantAvatarError('AVATAR_CANCELLED'));
      try { request = this.indexedDB.open('8415wallet-local-tenant-avatars-v1', 1); }
      catch { finish(reject, new TenantAvatarError('AVATAR_STORAGE_UNAVAILABLE')); return; }
      signal?.addEventListener('abort', cancel, { once: true });
      request.onupgradeneeded = () => {
        if (settled) { request.transaction?.abort(); return; }
        try { request.result.createObjectStore('avatars'); }
        catch { request.transaction?.abort(); finish(reject, new TenantAvatarError('AVATAR_STORAGE_REFUSED')); }
      };
      request.onerror = request.onblocked = () => finish(reject, new TenantAvatarError('AVATAR_STORAGE_REFUSED'));
      request.onsuccess = () => {
        if (settled) { request.result.close(); return; }
        request.result.onversionchange = () => request.result.close();
        finish(resolve, request.result);
      };
    });
  }
  async transact(context, mode, change, { signal, isCurrent = () => true } = {}) {
    checkContext(context);
    const guard = () => { aborted(signal); if (!isCurrent()) fail('AVATAR_CONTEXT_CHANGED'); };
    guard();
    const db = await this.database(signal);
    try {
      guard();
      return await new Promise((resolve, reject) => {
        let tx, value = null, failure = null, settled = false;
        const finish = (fn, result) => { if (settled) return; settled = true; signal?.removeEventListener('abort', cancel); fn(result); };
        const cancel = () => { failure = new TenantAvatarError('AVATAR_CANCELLED'); try { tx.abort(); } catch { finish(reject, failure); } };
        try { tx = db.transaction('avatars', mode); } catch { finish(reject, new TenantAvatarError('AVATAR_STORAGE_REFUSED')); return; }
        signal?.addEventListener('abort', cancel, { once: true });
        tx.onabort = tx.onerror = () => finish(reject, failure ?? new TenantAvatarError('AVATAR_STORAGE_REFUSED'));
        tx.oncomplete = () => {
          try { guard(); finish(resolve, value); } catch (error) { finish(reject, error); }
        };
        try {
          guard();
          const store = tx.objectStore('avatars'), request = store.get(context.key);
          request.onsuccess = () => {
            try { guard(); value = change(store, request.result); }
            catch (error) { failure = error instanceof TenantAvatarError ? error : new TenantAvatarError('AVATAR_STORAGE_REFUSED'); tx.abort(); }
          };
        } catch (error) { failure = error instanceof TenantAvatarError ? error : new TenantAvatarError('AVATAR_STORAGE_REFUSED'); try { tx.abort(); } catch { finish(reject, failure); } }
      });
    } finally { db.close(); }
  }
  read(context, options) {
    return this.transact(context, 'readonly', (_store, value) => {
      if (value === undefined) return null;
      if (!value || value.schema !== SCHEMA || value.contextKey !== context.key || !(value.blob instanceof Blob) ||
          Object.keys(value).sort().join(',') !== 'blob,contextKey,schema') fail('AVATAR_STORED_DATA_REFUSED');
      return value.blob;
    }, options);
  }
  write(context, avatar, options) {
    return this.transact(context, 'readwrite', store => {
      if (!(avatar?.blob instanceof Blob) || !MIME_TYPES.includes(avatar.blob.type) || avatar.blob.size > AVATAR_LIMITS.maxBytes) fail('AVATAR_TYPE_REFUSED');
      store.put({ schema: SCHEMA, contextKey: context.key, blob: avatar.blob }, context.key);
    }, options);
  }
  remove(context, options) { return this.transact(context, 'readwrite', store => { store.delete(context.key); }, options); }
}

/** UI-independent state holder. Render only its blob URLs into a tenant-avatar <img>. */
export class TenantAvatarController {
  constructor({ store = new BrowserTenantAvatarStore(), decodeImage = decodeRaster, urlApi = globalThis.URL } = {}) {
    this.store = store; this.decodeImage = decodeImage; this.urlApi = urlApi;
    this.context = null; this.revision = 0; this.pending = null; this.saved = null; this.draft = null;
    this.savedUrl = null; this.previewUrl = null; this.status = 'unavailable'; this.errorCode = null; this.disposed = false;
  }
  snapshot() {
    return Object.freeze({ context: this.context, savedUrl: this.savedUrl, previewUrl: this.previewUrl,
      hasSaved: this.saved !== null, hasDraft: this.draft !== null, status: this.status, errorCode: this.errorCode });
  }
  revoke(url) { if (url) this.urlApi.revokeObjectURL(url); }
  dropDraft() { this.revoke(this.previewUrl); this.previewUrl = null; this.draft = null; }
  stop() { this.revision++; this.pending?.abort(); this.pending = null; }
  setContext(profile, location = globalThis.location) {
    if (this.disposed) fail('AVATAR_DISPOSED');
    // Refused new context clears the old tenant too; no misleading old avatar.
    this.stop(); this.dropDraft(); this.revoke(this.savedUrl); this.savedUrl = null; this.saved = null; this.context = null;
    this.status = 'unavailable'; this.errorCode = null;
    this.context = createTenantAvatarContext(profile, location); this.status = 'empty';
    return this.snapshot();
  }
  begin(status) {
    if (this.disposed) fail('AVATAR_DISPOSED');
    checkContext(this.context); this.stop();
    const revision = this.revision, context = this.context, controller = new AbortController();
    this.pending = controller; this.status = status; this.errorCode = null;
    const isCurrent = () => !this.disposed && this.revision === revision && this.context === context;
    const guard = () => { if (!isCurrent()) fail('AVATAR_CONTEXT_CHANGED'); aborted(controller.signal); };
    return { context, signal: controller.signal, isCurrent, guard };
  }
  async perform(operation, action) {
    try { await action(); operation.guard(); this.pending = null; return this.snapshot(); }
    catch (error) {
      const refusal = error instanceof TenantAvatarError ? error : new TenantAvatarError('AVATAR_OPERATION_REFUSED');
      if (operation.isCurrent()) { this.pending = null; this.status = 'error'; this.errorCode = refusal.code; }
      throw refusal;
    }
  }
  makeUrl(blob) {
    if (typeof this.urlApi?.createObjectURL !== 'function') fail('AVATAR_PREVIEW_UNAVAILABLE');
    return this.urlApi.createObjectURL(blob);
  }
  async load() {
    const operation = this.begin('loading'); this.dropDraft();
    return this.perform(operation, async () => {
      const blob = await this.store.read(operation.context, operation); operation.guard();
      const avatar = blob === null ? null : await validateTenantAvatar(blob, { signal: operation.signal, decodeImage: this.decodeImage });
      operation.guard();
      const url = avatar === null ? null : this.makeUrl(avatar.blob);
      this.revoke(this.savedUrl); this.saved = avatar; this.savedUrl = url; this.status = avatar ? 'saved' : 'empty';
    });
  }
  async select(blob) {
    const operation = this.begin('validating'); this.dropDraft();
    return this.perform(operation, async () => {
      const avatar = await validateTenantAvatar(blob, { signal: operation.signal, decodeImage: this.decodeImage }); operation.guard();
      this.previewUrl = this.makeUrl(avatar.blob); this.draft = avatar; this.status = 'draft';
    });
  }
  async save() {
    if (!this.draft) fail('AVATAR_SELECTION_REQUIRED');
    const operation = this.begin('saving'), avatar = this.draft;
    return this.perform(operation, async () => {
      await this.store.write(operation.context, avatar, operation); operation.guard();
      this.revoke(this.savedUrl); this.savedUrl = this.previewUrl; this.saved = avatar; this.previewUrl = null; this.draft = null; this.status = 'saved';
    });
  }
  cancel() {
    this.stop(); this.dropDraft(); this.errorCode = null;
    this.status = this.context ? (this.saved ? 'saved' : 'empty') : 'unavailable'; return this.snapshot();
  }
  async remove() {
    const operation = this.begin('removing'); this.dropDraft();
    return this.perform(operation, async () => {
      await this.store.remove(operation.context, operation); operation.guard();
      this.revoke(this.savedUrl); this.savedUrl = null; this.saved = null; this.status = 'empty';
    });
  }
  dispose() {
    this.cancel(); this.revoke(this.savedUrl); this.savedUrl = null; this.saved = null; this.context = null;
    this.disposed = true; this.status = 'unavailable'; return this.snapshot();
  }
}
