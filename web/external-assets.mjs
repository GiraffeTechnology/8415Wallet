import { msg, paint, jsonUi, decimalUi } from './i18n.mjs';
import { walletLogin, WalletLoginError } from './wallet-auth.mjs';
import { getReleaseProfile } from './release-profile.mjs';
import { acquireWalletUi, releaseWalletUi, walletUiBusy } from './ui-lock.mjs';
import { ExternalAssetSession, ASSET_CHAINS, ControlAdapterError, controlRpc, formatWeiAsEth } from '../dist/browser/browser.js';
import { BrowserExternalAssetStore } from './external-store.mjs';
const el = id => document.getElementById(id);
const format = value => jsonUi(value);
let session = null, provider = null, listeningProvider = null, review = null, busy = false, generation = 0;
const output = value => { paint(el('asset-result'), typeof value === 'string' ? value : format(value)); };
function dismiss() { review = null; el('asset-ack').checked = false; paint(el('asset-review-text'), msg('ui.055')); }
function invalidate() {
  generation++; session = null; dismiss(); paint(el('asset-receive'), msg('message.022')); paint(el('asset-identity'), msg('message.023'));
  output(msg('message.024'));
}
async function run(fn) {
  if (busy) return; const uiLock = acquireWalletUi(); if (uiLock === null) return; busy = true; const current = generation;
  document.querySelectorAll('button:not([data-auth-control]):not([data-ui-locale]),input,select').forEach(n => { n.disabled = true; });
  try {
    await walletLogin.check();
    let profile;
    try { profile = await getReleaseProfile(); }
    catch { throw new ControlAdapterError('ASSET_RELEASE_CONFIG_REFUSED'); }
    if (!profile.features.externalAssets) throw new ControlAdapterError('ASSET_RELEASE_FEATURE_REFUSED');
    checkCurrent(current); await fn(current);
  } catch (e) {
    output(current !== generation ? 'ASSET_CONNECTION_CHANGED' : e instanceof WalletLoginError ? e.code : e instanceof ControlAdapterError ? (e.code === 'CONTROL_PROVIDER_REQUEST_REJECTED' ?
      msg('message.025') : e.code) : 'ASSET_UI_OPERATION_REFUSED');
  } finally {
    if (session && current === generation) {
      const s = session;
      try { const state = await s.status(); if (s === session && current === generation) paint(el('asset-state'), format(state)); }
      catch { paint(el('asset-state'), msg('message.026')); }
    }
    busy = false; releaseWalletUi(uiLock); document.querySelectorAll('button:not([data-auth-control]):not([data-ui-locale]),input,select').forEach(n => { n.disabled = false; });
  }
}
const checkCurrent = g => { walletLogin.assert(); if (g !== generation) throw new ControlAdapterError('ASSET_CONNECTION_CHANGED'); };
const selected = () => { walletLogin.assert(); if (!session) throw new ControlAdapterError('ASSET_CONNECTION_REQUIRED'); return session; };
el('asset-connect').addEventListener('click', () => {
  if (busy || walletUiBusy()) return;
  invalidate(); return run(async g => {
    provider = walletLogin.provider();
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
    session = next; paint(el('asset-identity'), `${ASSET_CHAINS[chainId]} · EOA ${actor}`);
    paint(el('asset-receive'), msg('status.receive', { network: ASSET_CHAINS[chainId], chain: chainId, account: actor }));
    output({ ...balance, balanceETH: formatWeiAsEth(balance.balanceWei), custody: msg('message.027') });
  });
});
el('asset-token-balance').addEventListener('click', () => run(async g => {
  const result = await selected().erc20Balance(el('asset-contract').value.trim()); checkCurrent(g);
  output({ ...result, amountUnit: msg('message.028'),
    metadataTrust: msg('message.029') });
}));
el('asset-balance').addEventListener('click', () => run(async g => { const result = await selected().balance(); checkCurrent(g); output({ ...result, balanceETH: formatWeiAsEth(result.balanceWei) }); }));
for (const id of ['asset-kind', 'asset-recipient', 'asset-amount', 'asset-contract', 'asset-token-id', 'asset-request-file']) { el(id).addEventListener('change', dismiss); el(id).addEventListener('input', dismiss); }
el('asset-dismiss').addEventListener('click', dismiss);
async function prepare(text, g) {
  dismiss(); const prepared = await selected().prepare(text); checkCurrent(g); review = prepared;
  paint(el('asset-review-text'), format({ ...prepared, requestText: undefined, humanAmount: prepared.asset === 'ETH' ? `${formatWeiAsEth(prepared.amount)} ETH` : prepared.asset === 'ERC-20' ? (prepared.displayAmount === null ? msg('message.030') : msg('amount.tokenUnits', { amount: decimalUi(prepared.displayAmount) })) : msg('amount.nftUnits', { amount: decimalUi(prepared.amount) }), amountUnit: prepared.asset === 'ETH' ? 'wei (1 ETH = 1000000000000000000 wei)' : prepared.asset === 'ERC-20' ? msg('message.031') : msg('message.032'),
    tokenCautions: prepared.asset === 'ERC-20' ? msg('message.033') : undefined, gas: msg('message.034'),
    custody: msg('message.035'), acceptance: msg('message.036') }));
  output(msg('message.037'));
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
  output(msg('message.039'));
  const transactionHash = await s.submit(confirmed, confirmed.digest); checkCurrent(g);
  output({ transactionHash, state: 'submitted', next: msg('message.040') });
}));
el('asset-reconcile').addEventListener('click', () => run(async g => { const r = await selected().reconcile(); checkCurrent(g); output(r); }));
el('asset-recover').addEventListener('click', () => run(async g => { const r = await selected().recover(el('asset-recovery-hash').value.trim()); checkCurrent(g); output(r); }));
el('asset-ack-terminal').addEventListener('click', () => run(async g => { await selected().acknowledge(); checkCurrent(g); output(msg('message.041')); }));

el('asset-replacement').addEventListener('click', () => run(async g => { const r = await selected().acknowledgeReplacement(el('asset-recovery-hash').value.trim()); checkCurrent(g); output(r); }));

// A history-restored page cannot retain an old review or account binding.
globalThis.addEventListener?.('pagehide', invalidate);
globalThis.addEventListener?.('pageshow', event => { if (event.persisted) invalidate(); });

walletLogin.subscribe(authenticated => {
  if (authenticated) return;
  invalidate(); provider = null;
  for (const id of ['asset-recipient', 'asset-amount', 'asset-contract', 'asset-token-id', 'asset-request-file', 'asset-recovery-hash']) el(id).value = '';
  paint(el('asset-state'), msg('message.042'));
  output(msg('message.011'));
});
