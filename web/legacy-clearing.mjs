import { clearingDisplay, clearingReviewDisplay } from './native-i18n.mjs';
import { msg, paint, jsonUi, translateStatic, trustedMessage } from './i18n.mjs';
import { walletLogin, WalletLoginError } from './wallet-auth.mjs';
import { LegacyClearingSession, parseLegacyClearingDeployment, CLEARING_NOTES, controlRpc, ControlAdapterError } from '../dist/browser/browser.js';
import { BrowserLegacyClearingStore } from './legacy-clearing-store.mjs';
import { getReleaseProfile } from './release-profile.mjs';
import { acquireWalletUi, releaseWalletUi } from './ui-lock.mjs';

const mount = document.getElementById('legacy-clearing-panel');
if (mount) {
  // Static markup only. Imported documents and provider responses are textContent.
  mount.innerHTML = `
    <h2><span data-i18n="ui.179">8415 Clearing: single trade</span></h2>
    <p><span data-i18n="ui.180">Standalone legacy escrow. Review exact terms before each separate wallet request. This does not establish linked responsibility controls.</span></p>
    <p id="clearing-notes"></p>
    <label><span data-i18n="ui.181">Verified clearing deployment JSON</span> <input id="clearing-deployment" type="file" accept="application/json,.json"></label>
    <p><span data-i18n="ui.182">The file must pin chainId, escrow and projection addresses/runtimeCodeHash, registerId, and verificationProfile (null only without the settlement interface). Supported Beta chains: Sepolia, Hoodi, and local 31337. Obtain it from the deployment operator and verify its source.</span></p>
    <button id="clearing-connect" type="button"><span data-i18n="ui.183">Connect clearing wallet</span></button>
    <p id="clearing-identity"><span data-i18n="ui.184">No clearing wallet connected</span></p>
    <fieldset><legend><span data-i18n="ui.185">Open a single trade</span></legend>
      <label><span data-i18n="ui.186">Seller-local ID (nonzero bytes32)</span> <input id="clearing-local-id" autocomplete="off" placeholder="0x..."></label>
      <label><span data-i18n="ui.076">Token ID</span> <input id="clearing-token-id" inputmode="numeric" value="1"></label>
      <label><span data-i18n="ui.187">Buyer address</span> <input id="clearing-buyer" autocomplete="off" placeholder="0x..."></label>
      <label><span data-i18n="ui.188">Exact price (wei)</span> <input id="clearing-price" inputmode="numeric" value="0"></label>
      <label><span data-i18n="ui.189">Admission deadline (Unix seconds)</span> <input id="clearing-deadline" inputmode="numeric"></label>
      <label><span data-i18n="ui.190">Maximum accepted effectiveAt (Unix seconds)</span> <input id="clearing-max-effective" inputmode="numeric"></label>
      <button id="clearing-review-approve" type="button"><span data-i18n="ui.191">Review exact token approval</span></button>
      <button id="clearing-review-open" type="button"><span data-i18n="ui.192">Review open</span></button>
      <p><span data-i18n="ui.193">Approval is limited to this token and the pinned escrow. It does not open the trade. After the approval receipt is verified and acknowledged, review open separately.</span></p>
    </fieldset>
    <fieldset><legend><span data-i18n="ui.194">Existing trade</span></legend>
      <label><span data-i18n="ui.195">Trade key (bytes32)</span> <input id="clearing-trade-key" autocomplete="off" placeholder="0x..."></label>
      <button id="clearing-observe" type="button"><span data-i18n="ui.196">Read trade</span></button>
      <button id="clearing-review-fund" type="button"><span data-i18n="ui.197">Review exact payment</span></button>
      <button id="clearing-review-release" type="button"><span data-i18n="ui.198">Review release</span></button>
      <button id="clearing-review-refund" type="button"><span data-i18n="ui.199">Review return and refund</span></button>
      <button id="clearing-review-abandon" type="button"><span data-i18n="ui.200">Review seller withdrawal</span></button>
    </fieldset>
    <h3><span data-i18n="ui.201">Exact transaction review</span></h3><pre id="clearing-review"><span data-i18n="ui.202">No clearing review prepared</span></pre>
    <label><input id="clearing-acknowledge" type="checkbox"><span data-i18n="ui.203">I reviewed the chain, contracts, action, parties, token, amount, deadline, approval scope and provisional-release terms.</span></label>
    <button id="clearing-send" type="button"><span data-i18n="ui.204">Ask my wallet to send reviewed action</span></button>
    <button id="clearing-cancel-review" type="button"><span data-i18n="ui.205">Discard unsent review</span></button>
    <fieldset><legend><span data-i18n="ui.206">Submission recovery</span></legend>
      <button id="clearing-status" type="button"><span data-i18n="ui.207">Read saved submission</span></button>
      <button id="clearing-reconcile" type="button"><span data-i18n="ui.208">Verify saved transaction receipt</span></button>
      <label><span data-i18n="ui.209">Transaction hash from your wallet</span> <input id="clearing-recovery-hash" autocomplete="off" placeholder="0x..."></label>
      <button id="clearing-recover" type="button"><span data-i18n="ui.210">Bind matching transaction hash</span></button>
      <button id="clearing-replacement" type="button"><span data-i18n="ui.211">Verify wallet cancellation or replacement</span></button>
      <button id="clearing-finish" type="button"><span data-i18n="ui.212">Acknowledge verified receipt</span></button>
      <p id="clearing-recovery-guidance"><span data-i18n="ui.213">A timeout or unknown result stays locked. Never resend automatically or clear browser storage. A verified receipt is chain evidence, not register finality.</span></p>
    </fieldset>
    <pre id="clearing-result" aria-live="polite"><span data-i18n="ui.214">Load a verified deployment and connect.</span></pre>`;
  translateStatic(mount);
  const el = id => document.getElementById(id), text = id => el(id).value.trim();
  const stringify = value => jsonUi(value);
  const result = value => { paint(el('clearing-result'), typeof value === 'string' ? value : stringify(value)); };
  paint(el('clearing-notes'), trustedMessage(CLEARING_NOTES));
  let provider = null, deployment = null, session = null, review = null, generation = 0, busy = false;
  const clearReview = () => { review = null; el('clearing-acknowledge').checked = false; paint(el('clearing-review'), msg('ui.202')); };
  const disconnect = () => { generation++; session = null; clearReview(); paint(el('clearing-identity'), msg('message.043')); };
  globalThis.addEventListener?.('pagehide', disconnect);
  globalThis.addEventListener?.('pageshow', event => { if (event.persisted) disconnect(); });
  const selected = () => { walletLogin.assert(); if (!session) throw new ControlAdapterError('CLEARING_CONNECTION_REQUIRED'); return session; };
  async function run(fn) {
    if (busy) return;
    const lock = acquireWalletUi(); if (lock === null) return;
    busy = true; const current = generation;
    document.querySelectorAll('button:not([data-auth-control]):not([data-ui-locale]) ,input,select:not([data-ui-locale])').forEach(n => { n.disabled = true; });
    const guard = () => { walletLogin.assert(); if (current !== generation) throw new ControlAdapterError('CLEARING_CONNECTION_CHANGED'); };
    try { await walletLogin.check(); await getReleaseProfile(); guard(); await fn(guard); guard(); } catch (error) {
      result(current !== generation ? 'CLEARING_CONNECTION_CHANGED' : error instanceof WalletLoginError ? error.code : error instanceof ControlAdapterError ? error.code : 'CLEARING_UI_OPERATION_REFUSED');
    } finally {
      if (session && current === generation) {
        try {
          const state = await session.status(); guard();
          paint(el('clearing-recovery-guidance'), state.status === 'idle' ? msg('message.044') :
            state.status === 'outcome-unknown' ? msg('message.045') :
              msg('status.savedTransaction', { hash: state.transactionHash }));
        } catch { paint(el('clearing-recovery-guidance'), msg('message.046')); }
      }
      busy = false; releaseWalletUi(lock); document.querySelectorAll('button:not([data-auth-control]):not([data-ui-locale]) ,input,select:not([data-ui-locale])').forEach(n => { n.disabled = false; });
    }
  }
  for (const input of mount.querySelectorAll('input:not([type="checkbox"]):not([type="file"])')) input.addEventListener('input', clearReview);
  el('clearing-deployment').addEventListener('change', () => {
    disconnect(); deployment = null;
    return run(async guard => {
      const file = el('clearing-deployment').files?.[0];
      if (!file || file.size > 8192) throw new ControlAdapterError('CLEARING_DEPLOYMENT_FILE_REFUSED');
      let data; try { data = JSON.parse(await file.text()); } catch { throw new ControlAdapterError('CLEARING_DEPLOYMENT_FILE_REFUSED'); }
      guard(); deployment = parseLegacyClearingDeployment(data); result({ deploymentLoaded: deployment, executionPerformed: false });
    });
  });
  el('clearing-connect').addEventListener('click', () => run(async guard => {
    session = null; clearReview();
    if (!deployment) throw new ControlAdapterError('CLEARING_DEPLOYMENT_REQUIRED');
    if (!provider) {
      provider = walletLogin.provider();
      if (!provider || typeof provider.request !== 'function') throw new ControlAdapterError('CLEARING_GENUINE_WALLET_REQUIRED');
      provider.on?.('accountsChanged', disconnect); provider.on?.('chainChanged', disconnect); provider.on?.('disconnect', disconnect);
    }
    const accounts = await controlRpc(provider, 'eth_requestAccounts', []); guard();
    if (!Array.isArray(accounts) || typeof accounts[0] !== 'string') throw new ControlAdapterError('CLEARING_ACCOUNT_REQUIRED');
    const current = generation, account = accounts[0];
    const connectionGuard = () => { if (current !== generation) throw new ControlAdapterError('CLEARING_CONNECTION_CHANGED'); };
    const connectedProvider = { request: args => { connectionGuard(); return provider.request(args); } };
    const next = new LegacyClearingSession(connectedProvider, deployment, account,
      new BrowserLegacyClearingStore(deployment.chainId, account), connectionGuard);
    await next.verify(); guard(); const status = await next.status(); guard(); session = next;
    paint(el('clearing-identity'), msg('status.clearingIdentity', { account, chain: deployment.chainId, escrow: deployment.escrow.address }));
    result(status);
  }));
  walletLogin.subscribe(authenticated => {
    if (authenticated) return;
    disconnect(); provider = null;
    for (const input of mount.querySelectorAll('input:not([type="checkbox"])')) input.value = input.type === 'file' ? '' : input.defaultValue ?? '';
    result(msg('message.047'));
    paint(el('clearing-recovery-guidance'), msg('message.009'));
  });
  function inputRequest(kind) {
    if (kind !== 'open' && kind !== 'approve') return { kind, tradeKey: text('clearing-trade-key') };
    return { kind, localId: text('clearing-local-id'), tokenId: text('clearing-token-id'), buyer: text('clearing-buyer'),
      priceWei: text('clearing-price'), admissionDeadline: text('clearing-deadline'), maxEffectiveAt: text('clearing-max-effective') };
  }
  for (const action of ['approve', 'open', 'fund', 'release', 'refund', 'abandon']) el(`clearing-review-${action}`).addEventListener('click', () => run(async guard => {
    clearReview(); const next = await selected().prepare(JSON.stringify(inputRequest(action))); guard(); review = next;
    el('clearing-trade-key').value = next.tradeKey;
    paint(el('clearing-review'), clearingReviewDisplay(next, CLEARING_NOTES));
    result(msg('message.048'));
  }));
  el('clearing-cancel-review').addEventListener('click', clearReview);
  el('clearing-send').addEventListener('click', () => run(async guard => {
    if (!review || !el('clearing-acknowledge').checked) throw new ControlAdapterError('CLEARING_OWNER_REVIEW_REQUIRED');
    document.dispatchEvent?.(new CustomEvent('wallet:summary-stale'));
    const approved = review; clearReview(); const hash = await selected().submit(approved, approved.digest); guard();
    el('clearing-recovery-hash').value = hash; result({ transactionHash: hash, status: 'submitted', registerFinalityEstablished: false });
  }));
  el('clearing-observe').addEventListener('click', () => run(async guard => { const observation = await selected().observe(text('clearing-trade-key')); guard(); paint(el('clearing-result'), clearingDisplay(observation)); }));
  el('clearing-status').addEventListener('click', () => run(async guard => { const state = await selected().status(); guard(); result(state); }));
  el('clearing-reconcile').addEventListener('click', () => run(async guard => { const receipt = await selected().reconcile(); guard(); result(receipt); }));
  el('clearing-recover').addEventListener('click', () => run(async guard => { const receipt = await selected().recover(text('clearing-recovery-hash')); guard(); result(receipt); }));
  el('clearing-replacement').addEventListener('click', () => run(async guard => { const replacement = await selected().acknowledgeReplacement(text('clearing-recovery-hash')); guard(); clearReview(); result(replacement); }));
  el('clearing-finish').addEventListener('click', () => run(async guard => { await selected().acknowledge(); guard(); clearReview(); result(msg('message.049')); }));
}
