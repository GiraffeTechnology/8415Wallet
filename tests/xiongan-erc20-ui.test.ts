import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ExternalAssetSession, ASSET_CHAINS, formatWeiAsEth, parseAssetState, type AssetState } from '../src/xiongan/externalAssets.ts';
import { ControlAdapterError, controlRpc } from '../src/controls/authorization.ts';
import { encodeCall } from '../src/codec/abi.ts';
const source = readFileSync(new URL('../web/external-assets.mjs', import.meta.url), 'utf8').replace(/^import[^\n]*\n/gm, '');
const actor = `0x${'1'.repeat(40)}`, recipient = `0x${'2'.repeat(40)}`, contract = `0x${'3'.repeat(40)}`;
const hash = `0x${'4'.repeat(64)}`, word = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}`;
function fixture() {
  const elements = new Map<string, any>(), lifecycle = new Map<string, (event: any) => void>(); let sends = 0, missingDecimals = false;
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, { value: '', textContent: '', checked: false, disabled: false, files: [], handlers: new Map(),
      addEventListener(name: string, fn: () => Promise<void>) { this.handlers.set(name, fn); } });
    return elements.get(id);
  };
  const provider = { async request({ method, params = [] }: { method: string; params?: readonly unknown[] }): Promise<unknown> {
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [actor];
    if (method === 'eth_chainId') return '0x1';
    if (method === 'eth_getCode') return params[0] === contract ? '0x6000' : '0x';
    if (method === 'eth_getBlockByNumber') return { number: '0x64', timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}`, hash };
    if (method === 'eth_getBalance') return '0x100000';
    if (method === 'eth_getTransactionCount') return '0x0';
    if (method === 'eth_estimateGas') return '0xc350';
    if (method === 'eth_sendTransaction') { sends++; throw { code: 4001 }; }
    if (method === 'eth_call') {
      const data = (params[0] as { data: string }).data;
      if (data.startsWith('0x70a08231')) return word(1_234_567n);
      if (data.startsWith('0xa9059cbb')) return word(1n);
      if (data === encodeCall('decimals()', [], [])) return missingDecimals ? '0x' : word(6n);
      return '0x';
    }
    throw new Error(`unexpected ${method}`);
  } };
  class Store {
    record: AssetState | null = null;
    async read() { return structuredClone(this.record); }
    async compareAndSwap(expected: number | null, next: AssetState) {
      if ((this.record?.revision ?? null) !== expected) return false;
      this.record = parseAssetState(JSON.stringify(next)); return true;
    }
  }
  const sdk = {
    // Authentication is isolated in wallet-login.test.ts and the full browser suite.
    walletLogin: { assert() {}, check: async () => {}, provider: () => provider, subscribe() {} }, WalletLoginError: class extends Error {}, getReleaseProfile: async () => ({ features: { externalAssets: true } }), ExternalAssetSession, ASSET_CHAINS, formatWeiAsEth, ControlAdapterError, controlRpc,
    BrowserExternalAssetStore: Store, acquireWalletUi: () => Symbol(), releaseWalletUi: () => {}, walletUiBusy: () => false };
  new Function('document', 'globalThis', ...Object.keys(sdk), source)(
    { getElementById: element, querySelectorAll: () => [...elements.values()] },
    { ethereum: provider, addEventListener: (name: string, fn: (event: any) => void) => lifecycle.set(name, fn) }, ...Object.values(sdk));
  const click = async (id: string) => element(id).handlers.get('click')();
  return { element, click, sends: () => sends, unknownDecimals: () => { missingDecimals = true; },
    lifecycle: (name: string) => lifecycle.get(name)!({ persisted: true }), async prepare() {
      await click('asset-connect'); element('asset-kind').value = 'erc20-transfer'; element('asset-recipient').value = recipient;
      element('asset-contract').value = contract; element('asset-amount').value = '1234567'; await click('asset-prepare');
    } };
}
test('ERC-20 form reviews raw and decimal amounts, shows exact contract and requires explicit acknowledgement', async () => {
  const f = fixture(); await f.prepare(); const r = JSON.parse(f.element('asset-review-text').textContent);
  assert.equal(r.asset, 'ERC-20'); assert.equal(r.amount, '1234567'); assert.equal(r.transaction.to, contract);
  assert.match(r.humanAmount, /^1\.234567 token units/); assert.match(r.amountUnit, /raw token units/);
  assert.match(r.tokenCautions, /Fee-on-transfer, rebasing/); assert.match(r.tokenCautions, /no ERC-20 withdrawal path/); assert.equal(f.sends(), 0);
  await f.click('asset-send'); assert.match(f.element('asset-result').textContent, /ASSET_OWNER_REVIEW_REQUIRED/); assert.equal(f.sends(), 0);
  f.element('asset-ack').checked = true; await f.click('asset-send'); assert.equal(f.sends(), 1);
  assert.match(f.element('asset-result').textContent, /Cancelled in your wallet/); assert.equal(f.element('asset-review-text').textContent, 'No transfer reviewed');
  await f.click('asset-send'); assert.equal(f.sends(), 1);
});
test('ERC-20 token read is explicit, chain-bound and read-only', async () => {
  const f = fixture(); await f.prepare(); await f.click('asset-token-balance');
  const r = JSON.parse(f.element('asset-result').textContent); assert.equal(r.contract, contract); assert.equal(r.chainId, '1');
  assert.equal(r.balanceRaw, '1234567'); assert.equal(r.displayBalance, '1.234567'); assert.match(r.metadataTrust, /untrusted/); assert.equal(f.sends(), 0);
});
test('ERC-20 missing decimals never displays an invented decimal amount', async () => {
  const f = fixture(); f.unknownDecimals(); await f.prepare(); const r = JSON.parse(f.element('asset-review-text').textContent);
  assert.equal(r.displayAmount, null); assert.equal(r.tokenMetadata.decimals, null); assert.match(r.humanAmount, /decimals unknown/);
  assert.equal(r.amount, '1234567'); assert.match(r.amountUnit, /no decimals assumed/); assert.equal(f.sends(), 0);
});
for (const field of ['asset-kind', 'asset-recipient', 'asset-amount', 'asset-contract', 'asset-token-id']) test(`ERC-20 input event for ${field} immediately invalidates review`, async () => {
  const f = fixture(); await f.prepare(); f.element('asset-ack').checked = true;
  await f.element(field).handlers.get('input')(); assert.equal(f.element('asset-review-text').textContent, 'No transfer reviewed');
  await f.click('asset-send'); assert.equal(f.sends(), 0);
});
test('ERC-20 valid request-file preview never signs and survives no stale review after history restoration', async () => {
  const f = fixture(); await f.prepare();
  f.element('asset-request-file').files = [{ size: 1, text: async () => JSON.stringify({ schema: 'xiongan-asset-request/1',
    requestId: 'erc20-ui', agent: 'Unverified token request', chainId: '1', actor, expiresAt: String(Math.floor(Date.now() / 1000) + 600),
    action: { kind: 'erc20-transfer', contract, recipient, amount: '1234567' } }) }];
  await f.click('asset-review-file'); assert.match(f.element('asset-review-text').textContent, /ERC-20/); assert.equal(f.sends(), 0);
  f.lifecycle('pageshow'); f.element('asset-ack').checked = true; await f.click('asset-send'); assert.equal(f.sends(), 0);
  assert.equal(f.element('asset-review-text').textContent, 'No transfer reviewed');
});
for (const field of ['contract', 'recipient']) test(`ERC-20 form bad ${field} checksum clears earlier review without sending`, async () => {
  const f = fixture(); await f.prepare(); f.element(`asset-${field}`).value = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAec';
  await f.click('asset-prepare'); assert.equal(f.element('asset-result').textContent, 'ASSET_ADDRESS_REFUSED');
  assert.equal(f.element('asset-review-text').textContent, 'No transfer reviewed'); f.element('asset-ack').checked = true;
  await f.click('asset-send'); assert.equal(f.sends(), 0);
});
