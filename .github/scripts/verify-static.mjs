import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// No dependencies, RPC, wallet, secrets or build step. Check committed browser
// bytes, not reconstructed TypeScript or a prior CI result.
const root = fileURLToPath(new URL('../..', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
// Verified handoff for source 763b0067 / tree 14abc51f. Future releases must
// review this pin alongside the new source identity and complete manifest.
const expectedManifest = 'b39e63497220bd0357d4bbaa0b817587b0ddd695da46ca38977fe281cf4e0607';
const manifestBytes = readFileSync(resolve(root, 'SHA256SUMS'));
assert.equal(sha256(manifestBytes), expectedManifest, 'unexpected artifact manifest');
const files = new Map();
for (const line of manifestBytes.toString().trimEnd().split('\n')) {
  const match = /^([a-f0-9]{64})  ((?:web|dist\/browser)\/[A-Za-z0-9_./-]+)$/.exec(line);
  assert.ok(match, `malformed checksum line: ${line}`);
  const [, hash, name] = match;
  assert.ok(!name.split('/').some(part => part === '..' || part === '.' || part === ''));
  assert.ok(!files.has(name), `duplicate checksum path: ${name}`);
  files.set(name, hash);
}
function walk(directory) {
  assert.ok(lstatSync(directory).isDirectory(), `not a regular directory: ${directory}`);
  return readdirSync(directory).flatMap(name => {
    const path = resolve(directory, name), info = lstatSync(path);
    assert.equal(info.isSymbolicLink(), false, `symlink refused: ${path}`);
    if (info.isDirectory()) return walk(path);
    assert.ok(info.isFile(), `non-regular file: ${path}`);
    return [relative(root, path).split(sep).join('/')];
  });
}
const publicPaths = [...walk(resolve(root, 'web')), ...walk(resolve(root, 'dist/browser'))].sort();
assert.deepEqual(publicPaths, [...files.keys()].sort(), 'unlisted or missing public file');
assert.equal(publicPaths.length, 62);
for (const [name, hash] of files) assert.equal(sha256(readFileSync(resolve(root, name))), hash, name);
// Import shipped modules only after their complete fixed manifest is verified.
let networkRequests = 0;
globalThis.fetch = async () => { networkRequests++; throw new Error('network forbidden in static artifact tests'); };
const load = name => import(pathToFileURL(resolve(root, `dist/browser/xiongan/${name}.js`)).href);
const { isAddressInput } = await load('address');
const { ExternalAssetSession } = await load('externalAssets');
const { reviewAgentRequest } = await load('agentRequest');

await test('approved manifest matches exactly 62 regular files and file kinds', () => {
  const kinds = Object.fromEntries(['.html', '.css', '.mjs', '.js'].map(ext => [ext, publicPaths.filter(p => extname(p) === ext).length]));
  assert.deepEqual(kinds, { '.html': 1, '.css': 1, '.mjs': 5, '.js': 55 });
  assert.equal(publicPaths.reduce((n, p) => n + readFileSync(resolve(root, p)).length, 0), 351600);
});
await test('151 relative imports and three HTML resources resolve within the public tree', () => {
  let imports = 0;
  for (const name of publicPaths.filter(p => /\.(?:m?js)$/.test(p))) {
    for (const [, specifier] of readFileSync(resolve(root, name), 'utf8').matchAll(/\b(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g)) {
      const target = relative(root, resolve(root, dirname(name), specifier)).split(sep).join('/');
      assert.ok(files.has(target), `${name}: missing ${specifier}`); imports++;
    }
  }
  assert.equal(imports, 151);
  const resources = [...readFileSync(resolve(root, 'web/index.html'), 'utf8').matchAll(/(?:src|href)="([^"]+)"/g)];
  assert.equal(resources.length, 3);
  for (const [, resource] of resources) assert.ok(files.has(`web/${resource}`), resource);
});
// Literal official vectors, https://eips.ethereum.org/EIPS/eip-55#test-cases
const vectors = [
  '0x52908400098527886E0F7030069857D2E4169EE7',
  '0x8617E340B3D01FA5F11F306F4090FD50E238070D',
  '0xde709f2102306220921060314715629080e2fb77',
  '0x27b1fdb04752bbc536007a920d24acb045561c26',
  '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
  '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
  '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
  '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
];
const valid = vectors[4], bad = [valid.slice(0, -1) + 'c', valid.replace('aA', 'AA')];
await test('official ERC-55 vectors and lower/upper compatibility are accepted', () => {
  for (const address of vectors) for (const value of [address, address.toLowerCase(), `0x${address.slice(2).toUpperCase()}`])
    assert.equal(isAddressInput(value), true, value);
});
await test('single-letter case mutations, character typo, zero and malformed inputs are rejected', () => {
  for (const address of vectors) for (let i = 2; i < address.length; i++) {
    const c = address[i]; if (!/[a-f]/i.test(c)) continue;
    const flipped = c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase();
    assert.equal(isAddressInput(address.slice(0, i) + flipped + address.slice(i + 1)), false);
  }
  for (const address of [...bad, null, {}, '0x1234', `0x${'0'.repeat(40)}`, valid.toLowerCase() + '\n'])
    assert.equal(isAddressInput(address), false);
});
const actor = `0x${'1'.repeat(40)}`, recipient = `0x${'2'.repeat(40)}`, contract = `0x${'3'.repeat(40)}`;
function fixture(providerActor = actor) {
  let sends = 0, record = null;
  const provider = { async request({ method }) {
    if (method === 'eth_chainId') return '0x1';
    if (method === 'eth_accounts') return [providerActor];
    if (method === 'eth_getCode') return '0x';
    if (method === 'eth_getBlockByNumber') return { number: '0x64', timestamp: '0x3e8', hash: `0x${'4'.repeat(64)}` };
    if (method === 'eth_getBalance') return '0x100000';
    if (method === 'eth_getTransactionCount') return '0x0';
    if (method === 'eth_estimateGas') return '0x5208';
    if (method === 'eth_sendTransaction') { sends++; throw new Error('send forbidden'); }
    throw new Error(`unexpected method: ${method}`);
  } };
  const store = { async read() { return structuredClone(record); }, async compareAndSwap(expected, next) {
    if ((record?.revision ?? null) !== expected) return false;
    record = structuredClone(next); return true;
  } };
  const session = new ExternalAssetSession(provider, '1', providerActor, store);
  const payload = (action, overrides = {}) => JSON.stringify({ schema: 'xiongan-asset-request/1', requestId: 'static-test', agent: 'Synthetic',
    chainId: '1', actor: providerActor.toLowerCase(), expiresAt: '1500', action, ...overrides });
  return { session, payload, sends: () => sends };
}
for (const kind of ['native-transfer', 'erc721-transfer', 'erc1155-transfer']) {
  await test(`${kind} refuses bad recipient/contract checksum before send`, async () => {
    const f = fixture();
    for (const address of bad) {
      const action = kind === 'native-transfer' ? { kind, recipient: address, valueWei: '1' } :
        { kind, recipient: address, contract, tokenId: '7', ...(kind === 'erc1155-transfer' ? { amount: '1' } : {}) };
      await assert.rejects(f.session.prepare(f.payload(action)), /ASSET_ADDRESS_REFUSED/);
      if (kind !== 'native-transfer') await assert.rejects(f.session.prepare(f.payload({ ...action, recipient, contract: address })), /ASSET_ADDRESS_REFUSED/);
    }
    assert.equal(f.sends(), 0); assert.equal((await f.session.status()).status, 'idle');
  });
}
await test('valid compatibility and actor/submit-time revalidation preserve zero sends', async () => {
  const f = fixture();
  for (const address of [valid, valid.toLowerCase(), `0x${valid.slice(2).toUpperCase()}`])
    assert.equal((await f.session.prepare(f.payload({ kind: 'native-transfer', recipient: address, valueWei: '1' }))).recipient, valid.toLowerCase());
  for (const actor of bad) await assert.rejects(f.session.prepare(f.payload({ kind: 'native-transfer', recipient, valueWei: '1' }, { actor })), /ASSET_ADDRESS_REFUSED/);
  const reviewed = await f.session.prepare(f.payload({ kind: 'native-transfer', recipient: valid, valueWei: '1' }));
  await assert.rejects(f.session.submit({ ...reviewed, requestText: f.payload({ kind: 'native-transfer', recipient: bad[0], valueWei: '1' }) }, reviewed.digest), /ASSET_ADDRESS_REFUSED/);
  assert.equal(f.sends(), 0); assert.equal((await f.session.status()).status, 'idle');
});
await test('provider-returned account casing remains byte-oriented', async () => {
  const f = fixture(bad[1]);
  assert.equal((await f.session.prepare(f.payload({ kind: 'native-transfer', recipient, valueWei: '1' }))).transaction.from, valid.toLowerCase());
  assert.equal(f.sends(), 0);
});
await test('agent withdrawal destinations and request identities validate mixed case', () => {
  const pin = { chainId: 11155111n, controller: contract, runtimeCodeHash: `0x${'3'.repeat(64)}` };
  const context = { actor, controller: pin, token: { ...pin, controller: recipient }, now: 1000n };
  const payload = { schema: 'xiongan-agent-request/1', requestId: 'static-agent', agent: 'Synthetic', chainId: '11155111', actor,
    controller: contract, expiresAt: '1500' };
  const request = destination => JSON.stringify({ ...payload, operation: { kind: 'standalone-withdraw', tokenId: '7', destination } });
  for (const address of [valid, valid.toLowerCase(), `0x${valid.slice(2).toUpperCase()}`])
    assert.equal(reviewAgentRequest(request(address), context).operation.destination, valid.toLowerCase());
  for (const address of bad) assert.throws(() => reviewAgentRequest(request(address), context), /AGENT_REQUEST_ADDRESS_REFUSED/);
  for (const field of ['actor', 'controller']) assert.throws(() => reviewAgentRequest(JSON.stringify({ ...payload,
    [field]: bad[1], operation: { kind: 'create-account' } }), context), /AGENT_REQUEST_ADDRESS_REFUSED/);
});
await test('artifact verification used no network requests', () => assert.equal(networkRequests, 0));
