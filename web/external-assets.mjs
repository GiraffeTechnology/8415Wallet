import { getReleaseProfile } from './release-profile.mjs';
import { acquireWalletUi, releaseWalletUi, walletUiBusy } from './ui-lock.mjs';
import { ExternalAssetSession, ASSET_CHAINS, ControlAdapterError, controlRpc, formatWeiAsEth } from '../dist/browser/browser.js';
import { BrowserExternalAssetStore } from './external-store.mjs';
const el = id => document.getElementById(id);
const format = value => JSON.stringify(value, null, 2);
let session = null, provider = null, listeningProvider = null, review = null, busy = false, generation = 0;
const output = value => { el('asset-result').textContent = typeof value === 'string' ? value : format(value); };
function dismiss() { review = null; el('asset-ack').checked = false; el('asset-review-text').textContent = 'No transfer reviewed'; }
function invalidate() {
  generation++; session = null; dismiss(); el('asset-receive').textContent = 'No receive address verified. Reconnect before copying an address.'; el('asset-identity').textContent = 'Disconnected. Reconnect the same chain/account to inspect its journal.';
  output('Connection changed. Any unresolved transaction remains saved. Do not repeat it or clear browser storage.');
}
async function run(fn) {
  if (busy) return; const uiLock = acquireWalletUi(); if (uiLock === null) return; busy = true; const current = generation;
  document.querySelectorAll('button,input,select').forEach(n => { n.disabled = true; });
  try {
    let profile;
    try { profile = await getReleaseProfile(); }
    catch { throw new ControlAdapterError('ASSET_RELEASE_CONFIG_REFUSED'); }
    if (!profile.features.externalAssets) throw new ControlAdapterError('ASSET_RELEASE_FEATURE_REFUSED');
    checkCurrent(current); await fn(current);
  } catch (e) {
    output(current !== generation ? 'ASSET_CONNECTION_CHANGED' : e instanceof ControlAdapterError ? (e.code === 'CONTROL_PROVIDER_REQUEST_REJECTED' ?
      'CONTROL_PROVIDER_REQUEST_REJECTED: Cancelled in your wallet. Nothing was submitted by this request. Prepare a new review before trying again.' : e.code) : 'ASSET_UI_OPERATION_REFUSED');
  } finally {
    if (session && current === generation) {
      const s = session;
      try { const state = await s.status(); if (s === session && current === generation) el('asset-state').textContent = format(state); }
      catch { el('asset-state').textContent = 'Journal unavailable. Do not resend or clear browser storage.'; }
    }
    busy = false; releaseWalletUi(uiLock); document.querySelectorAll('button,input,select').forEach(n => { n.disabled = false; });
  }
}
const checkCurrent = g => { if (g !== generation) throw new ControlAdapterError('ASSET_CONNECTION_CHANGED'); };
const selected = () => { if (!session) throw new ControlAdapterError('ASSET_CONNECTION_REQUIRED'); return session; };
el('asset-connect').addEventListener('click', () => {
  if (busy || walletUiBusy()) return;
  invalidate(); return run(async g => {
    provider = globalThis.ethereum;
    if (!provider || typeof provider.request !== 'function') throw new ControlAdapterError('ASSET_WALLET_PROVIDER_REQUIRED');
    if (listeningProvider !== provider) {
      provider.on?.('accountsChanged', invalidate); provider.on?.('chainChanged', invalidate); provider.on?.('disconnect', invalidate);
      // Listener attachment is local UI state only; no wallet permission or persistent delegation.
      listeningProvider = provider;
    }
    const accounts = await controlRpc(provider, 'eth_requestAccounts', []); checkCurrent(g);
    const chainHex = await controlRpc(provider, 'eth_chainId', []); checkCurrent(g);
    if (typeof chainHex !== 'string' || !/^0x[0-9a-f]+$/i.test(chainHex) || !Array.isArray(accounts) || typeof accounts[0] !== 'string') throw new ControlAdapterError('ASSET_CONNECTION_REFUSED');
    const chainId = BigInt(chainHex).toString(), actor = accounts[0].toLowerCase();
    const next = new ExternalAssetSession(provider, chainId, actor, new BrowserExternalAssetStore(chainId, actor), () => checkCurrent(g));
    const balance = await next.balance(); await next.status(); checkCurrent(g);
    session = next; el('asset-identity').textContent = `${ASSET_CHAINS[chainId]} · EOA ${actor}`;
    el('asset-receive').textContent = `Receive only on ${ASSET_CHAINS[chainId]} (chain ${chainId}): ${actor}`;
    output({ ...balance, balanceETH: formatWeiAsEth(balance.balanceWei), custody: 'Your external wallet account. Never an 8415 controlled-contract deposit address.' });
  });
});
el('asset-token-balance').addEventListener('click', () => run(async g => {
  const result = await selected().erc20Balance(el('asset-contract').value.trim()); checkCurrent(g);
  output({ ...result, amountUnit: 'Integer raw token units; display balance only when decimals are available.',
    metadataTrust: 'Name, symbol and decimals are untrusted token-supplied display metadata. Identify the asset by chain and exact contract address.' });
}));
el('asset-balance').addEventListener('click', () => run(async g => { const result = await selected().balance(); checkCurrent(g); output({ ...result, balanceETH: formatWeiAsEth(result.balanceWei) }); }));
for (const id of ['asset-kind', 'asset-recipient', 'asset-amount', 'asset-contract', 'asset-token-id', 'asset-request-file']) { el(id).addEventListener('change', dismiss); el(id).addEventListener('input', dismiss); }
el('asset-dismiss').addEventListener('click', dismiss);
async function prepare(text, g) {
  dismiss(); const prepared = await selected().prepare(text); checkCurrent(g); review = prepared;
  el('asset-review-text').textContent = format({ ...prepared, requestText: undefined, humanAmount: prepared.asset === 'ETH' ? `${formatWeiAsEth(prepared.amount)} ETH` : prepared.asset === 'ERC-20' ? (prepared.displayAmount === null ? 'Display amount unavailable; decimals unknown' : `${prepared.displayAmount} token units (token-reported decimals)`) : `${prepared.amount} NFT unit(s)`, amountUnit: prepared.asset === 'ETH' ? 'wei (1 ETH = 1000000000000000000 wei)' : prepared.asset === 'ERC-20' ? 'Integer raw token units; no decimals assumed' : 'NFT units',
    tokenCautions: prepared.asset === 'ERC-20' ? 'Identify by chain and contract address, not optional token metadata. Do not send ERC-20 tokens to an 8415 controlled-account contract unless a separate withdrawal path has been verified. This Beta provides no ERC-20 withdrawal path there. Fee-on-transfer, rebasing and other nonstandard token economics are unsupported. Runtime-code checks do not pin proxy implementations. A canonical exact Transfer event does not guarantee future balance or economic value.' : undefined, gas: 'Review exact gas fees in your wallet. Fees are not included in the amount.',
    custody: 'External EOA only. The claimed agent name is not authenticated.', acceptance: 'Functional-testing Beta; no independent audit or genuine-wallet/device acceptance claimed.' });
  output('Prepared and simulated only. No signature or transaction requested.');
}
el('asset-prepare').addEventListener('click', () => run(async g => {
  const s = selected(), kind = el('asset-kind').value, recipient = el('asset-recipient').value.trim();
  const action = kind === 'native-transfer' ? { kind, recipient, valueWei: el('asset-amount').value.trim() } :
    kind === 'erc20-transfer' ? { kind, recipient, contract: el('asset-contract').value.trim(), amount: el('asset-amount').value.trim() } :
    { kind, recipient, contract: el('asset-contract').value.trim(), tokenId: el('asset-token-id').value.trim(), ...(kind === 'erc1155-transfer' ? { amount: el('asset-amount').value.trim() } : {}) };
  const text = JSON.stringify({ schema: 'xiongan-asset-request/1', requestId: `owner-${Date.now()}`, agent: 'Owner form',
    chainId: s.chainId, actor: s.actor, expiresAt: String(Math.floor(Date.now() / 1000) + 600), action });
  await prepare(text, g);
}));
el('asset-review-file').addEventListener('click', () => run(async g => {
  const f = el('asset-request-file').files?.[0];
  if (!f || f.size > 8192) throw new ControlAdapterError('ASSET_REQUEST_SIZE_REFUSED');
  const text = await f.text(); checkCurrent(g); await prepare(text, g);
}));
el('asset-send').addEventListener('click', () => run(async g => {
  const s = selected(); if (!review || !el('asset-ack').checked) throw new ControlAdapterError('ASSET_OWNER_REVIEW_REQUIRED');
  const confirmed = review; dismiss();
  output('Your wallet must show the final transaction, gas and signing/submission decision. No automatic retry.');
  const transactionHash = await s.submit(confirmed, confirmed.digest); checkCurrent(g);
  output({ transactionHash, state: 'submitted', next: 'Reconcile canonical receipt. A hash is not success.' });
}));
el('asset-reconcile').addEventListener('click', () => run(async g => { const r = await selected().reconcile(); checkCurrent(g); output(r); }));
el('asset-recover').addEventListener('click', () => run(async g => { const r = await selected().recover(el('asset-recovery-hash').value.trim()); checkCurrent(g); output(r); }));
el('asset-ack-terminal').addEventListener('click', () => run(async g => { await selected().acknowledge(); checkCurrent(g); output('Freshly verified terminal receipt acknowledged. No transaction was sent.'); }));

el('asset-replacement').addEventListener('click', () => run(async g => { const r = await selected().acknowledgeReplacement(el('asset-recovery-hash').value.trim()); checkCurrent(g); output(r); }));

// A history-restored page cannot retain an old review or account binding.
globalThis.addEventListener?.('pagehide', invalidate);
globalThis.addEventListener?.('pageshow', event => { if (event.persisted) invalidate(); });
