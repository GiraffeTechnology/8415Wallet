import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ExternalAssetSession, ASSET_CHAINS, formatWeiAsEth, parseAssetState, type AssetState } from '../src/xiongan/externalAssets.ts';
import { ControlAdapterError, controlRpc } from '../src/controls/authorization.ts';

// Actual UI handlers and SDK with deterministic DOM/provider boundaries.
// This is regression coverage, not real-wallet or physical-device acceptance.
const source = readFileSync(new URL('../web/external-assets.mjs', import.meta.url), 'utf8').replace(/^import[^\n]*\n/gm, '');
const actor = `0x${'1'.repeat(40)}`, recipient = `0x${'2'.repeat(40)}`;
const valid = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const invalid = [valid.slice(0, -1) + 'c', valid.replace('aA', 'AA')];
function fixture(sendError?: unknown, connectError?: unknown, releaseError?: unknown) {
  const elements = new Map<string, any>(), lifecycle = new Map<string, (event: any) => void>(); let sends = 0;
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, { value: '', textContent: '', checked: false, disabled: false, files: [],
      handlers: new Map(), addEventListener(name: string, fn: () => Promise<void>) { this.handlers.set(name, fn); } });
    return elements.get(id);
  };
  const provider = { async request({ method }: { method: string }) {
    if (method === 'eth_requestAccounts' && connectError !== undefined) throw connectError;
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [actor];
    if (method === 'eth_chainId') return '0x1';
    if (method === 'eth_getCode') return '0x';
    if (method === 'eth_getBlockByNumber') return { number: '0x64', timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}`, hash: `0x${'4'.repeat(64)}` };
    if (method === 'eth_getBalance') return '0x100000';
    if (method === 'eth_getTransactionCount') return '0x0';
    if (method === 'eth_estimateGas') return '0x5208';
    if (method === 'eth_sendTransaction') { sends++; throw sendError ?? new Error('unexpected send'); }
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
  const sdk = { getReleaseProfile: async () => { if (releaseError !== undefined) throw releaseError; return { features: { externalAssets: true } }; }, ExternalAssetSession, ASSET_CHAINS, formatWeiAsEth, ControlAdapterError, controlRpc,
    BrowserExternalAssetStore: Store, acquireWalletUi: () => Symbol(), releaseWalletUi: () => {}, walletUiBusy: () => false };
  new Function('document', 'globalThis', ...Object.keys(sdk), source)(
    { getElementById: element, querySelectorAll: () => [...elements.values()] }, { ethereum: provider, addEventListener: (name: string, fn: (event: any) => void) => lifecycle.set(name, fn) }, ...Object.values(sdk));
  const click = async (id: string) => element(id).handlers.get('click')();
  return { element, click, lifecycle: (name: string) => lifecycle.get(name)!({ persisted: true }), sends: () => sends, async connectAndReview() {
    await click('asset-connect'); element('asset-kind').value = 'native-transfer';
    element('asset-recipient').value = recipient; element('asset-amount').value = '1000';
    await click('asset-prepare'); assert.match(element('asset-review-text').textContent, /digest/);
  } };
}
for (const kind of ['native-transfer', 'erc721-transfer', 'erc1155-transfer']) {
  for (const field of kind === 'native-transfer' ? ['recipient'] : ['recipient', 'contract']) {
    for (const mode of ['form', 'agent JSON']) test(`${mode} ${kind} invalid ${field} checksum clears review and sends zero`, async () => {
      for (const address of invalid) {
        const f = fixture(); await f.connectAndReview();
        const action = kind === 'native-transfer' ? { kind, recipient: address, valueWei: '1000' } :
          { kind, recipient, contract: `0x${'3'.repeat(40)}`, tokenId: '7',
            ...(kind === 'erc1155-transfer' ? { amount: '1' } : {}), [field]: address };
        if (mode === 'form') {
          f.element('asset-kind').value = kind; f.element('asset-recipient').value = action.recipient;
          if ('contract' in action) { f.element('asset-contract').value = action.contract; f.element('asset-token-id').value = action.tokenId; }
          await f.click('asset-prepare');
        } else {
          const payload = { schema: 'xiongan-asset-request/1', requestId: 'ui-checksum', agent: 'Test', chainId: '1', actor,
            expiresAt: String(Math.floor(Date.now() / 1000) + 600), action };
          f.element('asset-request-file').files = [{ size: 1, text: async () => JSON.stringify(payload) }];
          await f.click('asset-review-file');
        }
        assert.equal(f.element('asset-result').textContent, 'ASSET_ADDRESS_REFUSED');
        assert.equal(f.element('asset-review-text').textContent, 'No transfer reviewed');
        f.element('asset-ack').checked = true; await f.click('asset-send');
        assert.equal(f.element('asset-result').textContent, 'ASSET_OWNER_REVIEW_REQUIRED');
        assert.equal(f.sends(), 0);
      }
    });
  }
}
test('manual form and agent JSON retain valid mixed, lower and upper-case input compatibility', async () => {
  const f = fixture(); await f.connectAndReview();
  for (const recipient of [valid, valid.toLowerCase(), `0x${valid.slice(2).toUpperCase()}`]) {
    f.element('asset-recipient').value = recipient; await f.click('asset-prepare');
    assert.match(f.element('asset-review-text').textContent, new RegExp(valid.toLowerCase()));
    const payload = { schema: 'xiongan-asset-request/1', requestId: 'ui-checksum', agent: 'Test', chainId: '1', actor,
      expiresAt: String(Math.floor(Date.now() / 1000) + 600), action: { kind: 'native-transfer', recipient, valueWei: '1000' } };
    f.element('asset-request-file').files = [{ size: 1, text: async () => JSON.stringify(payload) }];
    await f.click('asset-review-file'); assert.match(f.element('asset-review-text').textContent, new RegExp(valid.toLowerCase()));
  }
  assert.equal(f.sends(), 0);
});


test('external wallet connection rejection is presented as cancellation without a send', async () => {
  const f = fixture(undefined, { code: 4001, message: 'never display provider details' });
  await f.click('asset-connect');
  assert.match(f.element('asset-result').textContent, /CONTROL_PROVIDER_REQUEST_REJECTED: Cancelled in your wallet/);
  assert.doesNotMatch(f.element('asset-result').textContent, /never display provider details|uncertain/);
  assert.equal(f.sends(), 0);
});

test('external send rejection clears review, survives explicit reconnect and never retries automatically', async () => {
  const f = fixture({ code: 4001 }); await f.connectAndReview();
  f.element('asset-ack').checked = true; await f.click('asset-send');
  assert.match(f.element('asset-result').textContent, /Cancelled in your wallet/);
  assert.equal(f.element('asset-review-text').textContent, 'No transfer reviewed');
  assert.match(f.element('asset-state').textContent, /"status": "idle"/);
  assert.equal(f.sends(), 1);
  f.element('asset-ack').checked = true; await f.click('asset-send');
  assert.equal(f.element('asset-result').textContent, 'ASSET_OWNER_REVIEW_REQUIRED');
  assert.equal(f.sends(), 1);
  await f.click('asset-connect'); assert.equal(f.sends(), 1);
  await f.click('asset-prepare'); f.element('asset-ack').checked = true;
  await f.click('asset-send'); assert.equal(f.sends(), 2);
});


test('missing or mismatched release configuration blocks the external provider surface', async () => {
  for (const code of ['RELEASE_CONFIG_UNAVAILABLE', 'RELEASE_LOCATION_MISMATCH', 'RELEASE_PROFILE_REFUSED']) {
    const f = fixture(undefined, { code: 4001 }, new Error(code));
    await f.click('asset-connect');
    assert.equal(f.element('asset-result').textContent, 'ASSET_RELEASE_CONFIG_REFUSED');
    assert.equal(f.sends(), 0);
  }
});


test('external review is discarded on page exit and back-forward restoration', async () => {
  for (const event of ['pagehide', 'pageshow']) {
    const f = fixture(); await f.connectAndReview(); f.element('asset-ack').checked = true;
    f.lifecycle(event); await f.click('asset-send');
    assert.equal(f.element('asset-review-text').textContent, 'No transfer reviewed');
    assert.equal(f.element('asset-ack').checked, false);
    assert.equal(f.element('asset-result').textContent, 'ASSET_CONNECTION_REQUIRED');
    assert.equal(f.sends(), 0);
  }
});
