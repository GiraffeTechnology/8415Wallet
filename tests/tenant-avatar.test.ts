import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// Dynamic URL imports keep the browser-native module independently runnable.
const { TenantAvatarController, BrowserTenantAvatarStore, createTenantAvatarContext, validateTenantAvatar, AVATAR_LIMITS } =
  await import(new URL('../web/tenant-avatar.mjs', import.meta.url).href);
const { resolveReleaseProfile } = await import(new URL('../web/release-profile.mjs', import.meta.url).href);
const location = { href: 'https://wallet.example.invalid:18443/web/index.html' };
const profile = (id = 'v3', tenant = 'default', deployment: any = { environment: 'unconfigured', url: null }) => resolveReleaseProfile({
  schema: '8415wallet-release/1', product: '8415wallet', platform: '8415wallet.com', profile: id, tenant: { id: tenant, label: tenant }, deployment,
});
const pngBytes = (width = 64, height = 64) => {
  const bytes = new Uint8Array(33); bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer); view.setUint32(8, 13); bytes.set([73, 72, 68, 82], 12);
  view.setUint32(16, width); view.setUint32(20, height); return bytes;
};
const png = (width = 64, height = 64) => new Blob([pngBytes(width, height)], { type: 'image/png' });
const jpeg = () => new Blob([new Uint8Array([255, 216, 255, 192, 0, 11, 8, 0, 64, 0, 64, 1, 1, 17, 0, 255, 217])], { type: 'image/jpeg' });
const webp = () => { const bytes = new Uint8Array(30), view = new DataView(bytes.buffer);
  bytes.set(Buffer.from('RIFF')); view.setUint32(4, 22, true); bytes.set(Buffer.from('WEBPVP8X'), 8); view.setUint32(16, 10, true);
  bytes[24] = 63; bytes[27] = 63; return new Blob([bytes], { type: 'image/webp' }); };
const decode = async () => ({ width: 64, height: 64 });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T = any>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function memoryStore() {
  const records = new Map<string, Blob>();
  return { records, fail: false, read: async (context: any) => records.get(context.key) ?? null,
    async write(context: any, avatar: any, operation: any) {
      if (this.fail) throw Error('private provider message');
      if (operation.signal.aborted || !operation.isCurrent()) throw Error('cancelled'); records.set(context.key, avatar.blob);
    },
    async remove(context: any) { if (this.fail) throw Error('private provider message'); records.delete(context.key); },
  };
}
function fixture(options: any = {}) {
  const store = options.store ?? memoryStore(), live = new Set<string>(), revoked: string[] = []; let counter = 0;
  const controller = new TenantAvatarController({ store, decodeImage: options.decodeImage ?? decode, urlApi: {
    createObjectURL(blob: Blob) { assert.ok(blob instanceof Blob); const url = `blob:local-${++counter}`; live.add(url); return url; },
    revokeObjectURL(url: string) { assert.ok(live.has(url), `URL revoked more than once: ${url}`); live.delete(url); revoked.push(url); },
  } });
  controller.setContext(profile(), location); return { controller, store, live, revoked };
}

test('avatar context uses validated origin, profile and tenant IDs with collision-free keys', () => {
  const base = createTenantAvatarContext(profile(), location);
  const keys = [base.key, createTenantAvatarContext(profile('v2'), location).key,
    createTenantAvatarContext(profile('v3', 'partner'), location).key,
    createTenantAvatarContext(profile(), { href: 'https://wallet.example.invalid:28443/web/index.html' }).key];
  assert.equal(new Set(keys).size, 4); assert.equal(Object.isFrozen(base), true);
  assert.throws(() => createTenantAvatarContext({ ...profile(), id: 'v9' }, location), /AVATAR_CONTEXT_REFUSED/);
  assert.throws(() => createTenantAvatarContext({ ...profile(), tenant: { id: '../global', label: 'x' } }, location), /AVATAR_CONTEXT_REFUSED/);
  assert.throws(() => createTenantAvatarContext({ ...profile(), id: 'v3', tenant: { id: 'xiongan', label: 'x' } }, location), /AVATAR_CONTEXT_REFUSED/);
});
test('avatar origin refuses opaque/insecure/credential URLs and mismatched release deployments', () => {
  for (const href of ['file:///wallet/web/index.html', 'data:image/png;base64,AAAA', 'http://wallet.example.invalid:18443/web/index.html', 'https://u:p@wallet.example.invalid:18443/web/index.html'])
    assert.throws(() => createTenantAvatarContext(profile(), { href }), /AVATAR_ORIGIN_REFUSED/);
  const release = profile('v3', 'default', { environment: 'other', url: location.href });
  assert.equal(createTenantAvatarContext(release, location).origin, 'https://wallet.example.invalid:18443');
  assert.throws(() => createTenantAvatarContext(release, { href: 'https://wallet.example.invalid:28443/web/index.html' }), /AVATAR_CONTEXT_REFUSED/);
  assert.throws(() => createTenantAvatarContext(release, { href: `${location.href}?override=yes` }), /AVATAR_CONTEXT_REFUSED/);
  assert.equal(createTenantAvatarContext(profile(), { href: 'http://localhost:18443/web/index.html' }).origin, 'http://localhost:18443');
});
for (const [name, blob] of [['PNG', png()], ['JPEG', jpeg()], ['WebP', webp()]] as const) test(`${name} needs matching raster bytes and decoded bounded dimensions`, async () => {
  let closed = 0;
  const result = await validateTenantAvatar(blob, { decodeImage: async () => ({ width: 64, height: 64, close() { closed++; } }) });
  assert.equal(result.blob.type, blob.type); assert.equal(result.width, 64); assert.equal(closed, 1);
});
test('file name never grants image type and is not retained in the stored raster', async () => {
  const file = new File([pngBytes()], 'private-customer-name.png', { type: 'image/png' });
  const avatar = await validateTenantAvatar(file, { decodeImage: decode }); assert.equal(avatar.blob instanceof File, false);
  assert.equal(avatar.blob.name, undefined);
});
test('remote URLs, SVG, GIF, HTML, empty type and MIME spoofing are refused before decode', async () => {
  let decodes = 0;
  const decoder = async () => { decodes++; return { width: 64, height: 64 }; };
  for (const blob of ['https://tracker.invalid/avatar.png', 'data:image/png;base64,AAAA',
    new Blob(['<svg xmlns="http://www.w3.org/2000/svg"/>'], { type: 'image/svg+xml' }),
    new Blob(['GIF89a'], { type: 'image/gif' }), new Blob(['<html/>'], { type: 'image/png' }),
    new Blob([pngBytes()]), new Blob([pngBytes()], { type: 'image/jpeg' })])
    await assert.rejects(validateTenantAvatar(blob, { decodeImage: decoder }), /AVATAR_(TYPE|FORMAT)_REFUSED/);
  assert.equal(decodes, 0);
});
test('empty, oversized, malformed headers and excessive dimensions are refused before decoding', async () => {
  let decodes = 0; const decoder = async () => { decodes++; return { width: 64, height: 64 }; };
  for (const blob of [new Blob([], { type: 'image/png' }), new Blob([new Uint8Array(AVATAR_LIMITS.maxBytes + 1)], { type: 'image/png' }), png(0, 64), png(2049, 64),
    new Blob([new Uint8Array([255, 216, 255, 192, 255, 255])], { type: 'image/jpeg' })])
    await assert.rejects(validateTenantAvatar(blob, { decodeImage: decoder }), /AVATAR_(SIZE|DIMENSIONS|FORMAT)_REFUSED/);
  assert.equal(decodes, 0);
});
test('decoded image failure, unsafe/mismatched dimensions and hostile exception text fail closed', async () => {
  await assert.rejects(validateTenantAvatar(png(), { decodeImage: async () => { throw Error('sensitive runtime detail'); } }), /^TenantAvatarError: AVATAR_DECODE_REFUSED$/);
  for (const result of [{ width: 0, height: 64 }, { width: 4096, height: 64 }, { width: NaN, height: 64 }, { width: 63, height: 64 }])
    await assert.rejects(validateTenantAvatar(png(), { decodeImage: async () => result }), /AVATAR_DIMENSIONS_REFUSED/);
});
test('selection previews only; explicit save persists Blob and replacement revokes the previous URL', async () => {
  const f = fixture(); await f.controller.load(); assert.equal(f.controller.snapshot().status, 'empty');
  const staged = await f.controller.select(png()); assert.equal(staged.hasDraft, true); assert.equal(staged.hasSaved, false); assert.equal(f.store.records.size, 0);
  const saved = await f.controller.save(); assert.equal(saved.savedUrl, staged.previewUrl); assert.equal(saved.previewUrl, null); assert.equal(f.store.records.size, 1);
  await f.controller.select(png()); const newer = await f.controller.save(); assert.notEqual(newer.savedUrl, saved.savedUrl);
  assert.deepEqual(f.revoked, [saved.savedUrl]); assert.equal(f.live.size, 1); f.controller.dispose(); assert.equal(f.live.size, 0);
});
test('cancel preserves saved avatar, discards draft, and remove deletes only the current scope', async () => {
  const f = fixture(); await f.controller.select(png()); const saved = await f.controller.save(); await f.controller.select(png());
  const cancelled = f.controller.cancel(); assert.equal(cancelled.savedUrl, saved.savedUrl); assert.equal(cancelled.hasDraft, false);
  f.store.records.set('another-tenant', png()); await f.controller.remove(); assert.equal(f.live.size, 0);
  assert.deepEqual([...f.store.records.keys()], ['another-tenant']); assert.equal(f.controller.snapshot().status, 'empty');
});
test('reload loads only matching origin/profile/tenant; invalid next context clears old avatar', async () => {
  const f = fixture(); await f.controller.select(png()); await f.controller.save(); const firstKey = f.controller.snapshot().context.key;
  f.controller.setContext(profile('v2', 'xiongan'), location); await f.controller.load(); assert.equal(f.controller.snapshot().hasSaved, false); assert.equal(f.live.size, 0);
  f.controller.setContext(profile(), location); await f.controller.load(); assert.equal(f.controller.snapshot().hasSaved, true); assert.equal(f.controller.snapshot().context.key, firstKey);
  assert.throws(() => f.controller.setContext({ id: 'forged' }, location), /AVATAR_CONTEXT_REFUSED/); assert.equal(f.live.size, 0); assert.equal(f.controller.snapshot().context, null);
});
test('late decode after cancel or tenant switch cannot create a preview and releases its image', async () => {
  for (const switchContext of [false, true]) {
    const pending = deferred(), f = fixture({ decodeImage: () => pending.promise }); let closed = 0;
    const selection = f.controller.select(png()); const rejected = assert.rejects(selection, /AVATAR_(CANCELLED|CONTEXT_CHANGED)/); await tick();
    if (switchContext) f.controller.setContext(profile('v2', 'xiongan'), location); else f.controller.cancel();
    await rejected; pending.resolve({ width: 64, height: 64, close() { closed++; } }); await tick();
    assert.equal(closed, 1); assert.equal(f.live.size, 0); assert.equal(f.controller.snapshot().hasDraft, false);
  }
});
test('newer selection supersedes slow older selection and dispose releases every URL', async () => {
  const pending = deferred(); let calls = 0;
  const f = fixture({ decodeImage: () => ++calls === 1 ? pending.promise : decode() });
  const older = f.controller.select(png()), rejected = assert.rejects(older, /AVATAR_(CANCELLED|CONTEXT_CHANGED)/); await tick();
  const newer = await f.controller.select(png()); pending.resolve({ width: 64, height: 64 }); await rejected; await tick();
  assert.equal(f.controller.snapshot().previewUrl, newer.previewUrl); assert.equal(f.live.size, 1);
  f.controller.dispose(); f.controller.dispose(); assert.equal(f.live.size, 0);
  await assert.rejects(f.controller.select(png()), /AVATAR_DISPOSED/);
});
test('stale load cannot leak the old tenant avatar into a new context', async () => {
  const pending = deferred(), store = memoryStore(); store.read = async () => pending.promise;
  const f = fixture({ store }); const loading = f.controller.load(), rejected = assert.rejects(loading, /AVATAR_CONTEXT_CHANGED/);
  f.controller.setContext(profile('v2', 'xiongan'), location); pending.resolve(png()); await rejected;
  assert.equal(f.controller.snapshot().hasSaved, false); assert.equal(f.live.size, 0);
});
test('failed save/remove preserves last confirmed image; failed save retains draft for retry', async () => {
  const f = fixture(); await f.controller.select(png()); const saved = await f.controller.save(); await f.controller.select(png()); f.store.fail = true;
  await assert.rejects(f.controller.save(), /^TenantAvatarError: AVATAR_OPERATION_REFUSED$/);
  assert.equal(f.controller.snapshot().savedUrl, saved.savedUrl); assert.equal(f.controller.snapshot().hasDraft, true);
  await assert.rejects(f.controller.remove(), /AVATAR_OPERATION_REFUSED/); assert.equal(f.controller.snapshot().savedUrl, saved.savedUrl);
  f.store.fail = false; await f.controller.remove(); assert.equal(f.live.size, 0);
});
test('stored raster is revalidated before a display URL is created', async () => {
  const f = fixture(); f.store.records.set(f.controller.snapshot().context.key, new Blob(['<svg/>'], { type: 'image/png' }));
  await assert.rejects(f.controller.load(), /AVATAR_FORMAT_REFUSED/); assert.equal(f.live.size, 0);
});

// Transaction-event fixture, not a substitute for genuine browser IndexedDB evidence.
function indexedDbFixture(options: any = {}) {
  const records = new Map<string, any>(); let closes = 0, commits = 0, writes = 0;
  const db: any = { close() { closes++; }, createObjectStore() {}, transaction(_name: string, mode: string) {
    const changes: (() => void)[] = []; let stopped = false;
    const tx: any = { abort() { if (stopped) return; stopped = true; queueMicrotask(() => tx.onabort?.()); }, objectStore() { return {
      get(key: string) {
        const request: any = { result: records.get(key) };
        queueMicrotask(() => { if (stopped) return; request.onsuccess?.(); setImmediate(() => {
          if (stopped || options.holdCommit) return;
          if (options.failCommit && mode === 'readwrite') { tx.abort(); return; }
          stopped = true; changes.forEach(change => change()); commits++; tx.oncomplete?.();
        }); }); return request;
      },
      put(value: any, key: string) { writes++; if (options.quota) throw Error('QuotaExceededError details'); changes.push(() => records.set(key, value)); },
      delete(key: string) { changes.push(() => records.delete(key)); },
    }; } }; return tx;
  } };
  const indexedDB = { open() {
    if (options.unavailable) throw Error('private storage detail');
    const request: any = { result: db }; queueMicrotask(() => {
      if (options.blocked) { request.onblocked?.(); setImmediate(() => request.onsuccess?.()); }
      else request.onsuccess?.();
    }); return request;
  } };
  return { store: new BrowserTenantAvatarStore({ indexedDB, secureContext: options.secureContext ?? true }), records,
    stats: () => ({ closes, commits, writes }) };
}
test('IndexedDB stores a raster Blob under the exact scope and resolves only on transaction completion', async () => {
  const f = indexedDbFixture(), context = createTenantAvatarContext(profile(), location), avatar = await validateTenantAvatar(png(), { decodeImage: decode });
  assert.equal(await f.store.read(context), null); await f.store.write(context, avatar); assert.equal(f.stats().commits, 2);
  const stored = f.records.get(context.key); assert.deepEqual(Object.keys(stored).sort(), ['blob', 'contextKey', 'schema']); assert.ok(stored.blob instanceof Blob);
  assert.ok(await f.store.read(context) instanceof Blob); await f.store.remove(context); assert.equal(await f.store.read(context), null); assert.equal(f.stats().closes, 5);
});
test('IndexedDB quota/commit abort/open failure never reports saved and has no fallback', async () => {
  const context = createTenantAvatarContext(profile(), location), avatar = await validateTenantAvatar(png(), { decodeImage: decode });
  for (const options of [{ quota: true }, { failCommit: true }, { unavailable: true }, { secureContext: false }, { blocked: true }]) {
    const f = indexedDbFixture(options); await assert.rejects(f.store.write(context, avatar), /AVATAR_STORAGE_(REFUSED|UNAVAILABLE)/);
    assert.equal(f.records.size, 0); await tick(); if (options.blocked) assert.equal(f.stats().closes, 1);
  }
});
test('context revision guard and cancellation abort an in-flight IndexedDB mutation', async () => {
  const context = createTenantAvatarContext(profile(), location), avatar = await validateTenantAvatar(png(), { decodeImage: decode });
  const stale = indexedDbFixture(); await assert.rejects(stale.store.write(context, avatar, { isCurrent: () => false }), /AVATAR_CONTEXT_CHANGED/); assert.equal(stale.stats().writes, 0);
  const f = indexedDbFixture({ holdCommit: true }), signal = new AbortController();
  const save = f.store.write(context, avatar, { signal: signal.signal }); const rejected = assert.rejects(save, /AVATAR_CANCELLED/);
  await tick(); signal.abort(); await rejected; assert.equal(f.records.size, 0); assert.equal(f.stats().closes, 1);
});
test('IndexedDB rows cannot substitute URLs, other tenants or extra attacker fields', async () => {
  const f = indexedDbFixture(), context = createTenantAvatarContext(profile(), location);
  for (const record of [{ schema: '8415wallet-tenant-avatar/1', contextKey: 'different', blob: png() },
    { schema: '8415wallet-tenant-avatar/1', contextKey: context.key, blob: 'https://tracker.invalid/a.png' },
    { schema: '8415wallet-tenant-avatar/1', contextKey: context.key, blob: png(), url: 'https://tracker.invalid/a.png' }]) {
    f.records.set(context.key, record); await assert.rejects(f.store.read(context), /AVATAR_STORED_DATA_REFUSED/);
  }
  await assert.rejects(f.store.read({ ...context }), /AVATAR_CONTEXT_REFUSED/);
});
test('tenant avatar module has no network, auth-service or platform-logo write path', () => {
  const source = readFileSync(new URL('../web/tenant-avatar.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|sendBeacon|localStorage\.|document\.|walletLogin|AccountAuthClient/);
});

test('WebP simple lossy and lossless headers and JPEG orientation are supported', async () => {
  const lossless = new Uint8Array(26), losslessView = new DataView(lossless.buffer);
  lossless.set(Buffer.from('RIFF')); losslessView.setUint32(4, 18, true); lossless.set(Buffer.from('WEBPVP8L'), 8);
  losslessView.setUint32(16, 5, true); lossless[20] = 47; losslessView.setUint32(21, 63 | 63 << 14, true);
  assert.equal((await validateTenantAvatar(new Blob([lossless], { type: 'image/webp' }), { decodeImage: decode })).width, 64);
  const lossy = new Uint8Array(30), lossyView = new DataView(lossy.buffer);
  lossy.set(Buffer.from('RIFF')); lossyView.setUint32(4, 22, true); lossy.set(Buffer.from('WEBPVP8 '), 8);
  lossyView.setUint32(16, 10, true); lossy.set([157, 1, 42], 23); lossyView.setUint16(26, 64, true); lossyView.setUint16(28, 64, true);
  assert.equal((await validateTenantAvatar(new Blob([lossy], { type: 'image/webp' }), { decodeImage: decode })).height, 64);
  const jpegBytes = new Uint8Array(await jpeg().arrayBuffer()); jpegBytes[10] = 32;
  const rotated = await validateTenantAvatar(new Blob([jpegBytes], { type: 'image/jpeg' }), { decodeImage: async () => ({ width: 64, height: 32 }) });
  assert.equal(rotated.height, 32);
});
test('a stale save cannot repaint or revoke the next tenant preview', async () => {
  const pending = deferred<void>(), store = memoryStore(); store.write = async () => pending.promise;
  const f = fixture({ store }); await f.controller.select(png()); const save = f.controller.save();
  const rejected = assert.rejects(save, /AVATAR_CONTEXT_CHANGED/);
  f.controller.setContext(profile('v2', 'xiongan'), location); const newer = await f.controller.select(png());
  pending.resolve(); await rejected; assert.equal(f.controller.snapshot().previewUrl, newer.previewUrl); assert.equal(f.live.size, 1);
  f.controller.dispose();
});
test('Image-element decoder fallback revokes temporary URLs on success, failure and cancellation', async () => {
  const globals = globalThis as any, originalImage = globals.Image, originalBitmap = globals.createImageBitmap;
  const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL;
  const live = new Set<string>(); let sequence = 0, mode = 'load';
  class FakeImage {
    naturalWidth = 64; naturalHeight = 64; onload: any; onerror: any;
    set src(value: string) { if (value && mode !== 'hold') queueMicrotask(() => mode === 'load' ? this.onload?.() : this.onerror?.()); }
  }
  try {
    globals.Image = FakeImage; globals.createImageBitmap = undefined;
    URL.createObjectURL = () => { const url = `blob:fallback-${++sequence}`; live.add(url); return url; };
    URL.revokeObjectURL = url => { assert.ok(live.delete(url)); };
    await validateTenantAvatar(png()); assert.equal(live.size, 0);
    mode = 'error'; await assert.rejects(validateTenantAvatar(png()), /AVATAR_DECODE_REFUSED/); assert.equal(live.size, 0);
    mode = 'hold'; const controller = new AbortController(), validation = validateTenantAvatar(png(), { signal: controller.signal });
    const rejected = assert.rejects(validation, /AVATAR_CANCELLED/); await tick(); assert.equal(live.size, 1);
    controller.abort(); await rejected; assert.equal(live.size, 0);
  } finally {
    globals.Image = originalImage; globals.createImageBitmap = originalBitmap; URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke;
  }
});
