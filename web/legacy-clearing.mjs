import { walletLogin, WalletLoginError } from './wallet-auth.mjs';
import { LegacyClearingSession, parseLegacyClearingDeployment, CLEARING_NOTES, controlRpc, ControlAdapterError } from '../dist/browser/browser.js';
import { BrowserLegacyClearingStore } from './legacy-clearing-store.mjs';
import { getReleaseProfile } from './release-profile.mjs';
import { acquireWalletUi, releaseWalletUi } from './ui-lock.mjs';

const mount = document.getElementById('legacy-clearing-panel');
if (mount) {
  // Static markup only. Imported documents and provider responses are textContent.
  mount.innerHTML = `
    <h2>8415 Clearing: single trade</h2>
    <p>Standalone legacy escrow. Review exact terms before each separate wallet request. This does not establish linked responsibility controls.</p>
    <p id="clearing-notes"></p>
    <label>Verified clearing deployment JSON <input id="clearing-deployment" type="file" accept="application/json,.json"></label>
    <p>The file must pin chainId, escrow and projection addresses/runtimeCodeHash, registerId, and verificationProfile (null only without the settlement interface). Supported Beta chains: Sepolia, Hoodi, and local 31337. Obtain it from the deployment operator and verify its source.</p>
    <button id="clearing-connect" type="button">Connect clearing wallet</button>
    <p id="clearing-identity">No clearing wallet connected</p>
    <fieldset><legend>Open a single trade</legend>
      <label>Seller-local ID (nonzero bytes32) <input id="clearing-local-id" autocomplete="off" placeholder="0x..."></label>
      <label>Token ID <input id="clearing-token-id" inputmode="numeric" value="1"></label>
      <label>Buyer address <input id="clearing-buyer" autocomplete="off" placeholder="0x..."></label>
      <label>Exact price (wei) <input id="clearing-price" inputmode="numeric" value="0"></label>
      <label>Admission deadline (Unix seconds) <input id="clearing-deadline" inputmode="numeric"></label>
      <label>Maximum accepted effectiveAt (Unix seconds) <input id="clearing-max-effective" inputmode="numeric"></label>
      <button id="clearing-review-approve" type="button">Review exact token approval</button>
      <button id="clearing-review-open" type="button">Review open</button>
      <p>Approval is limited to this token and the pinned escrow. It does not open the trade. After the approval receipt is verified and acknowledged, review open separately.</p>
    </fieldset>
    <fieldset><legend>Existing trade</legend>
      <label>Trade key (bytes32) <input id="clearing-trade-key" autocomplete="off" placeholder="0x..."></label>
      <button id="clearing-observe" type="button">Read trade</button>
      <button id="clearing-review-fund" type="button">Review exact payment</button>
      <button id="clearing-review-release" type="button">Review release</button>
      <button id="clearing-review-refund" type="button">Review return and refund</button>
      <button id="clearing-review-abandon" type="button">Review seller withdrawal</button>
    </fieldset>
    <h3>Exact transaction review</h3><pre id="clearing-review">No clearing review prepared</pre>
    <label><input id="clearing-acknowledge" type="checkbox">I reviewed the chain, contracts, action, parties, token, amount, deadline, approval scope and provisional-release terms.</label>
    <button id="clearing-send" type="button">Ask my wallet to send reviewed action</button>
    <button id="clearing-cancel-review" type="button">Discard unsent review</button>
    <fieldset><legend>Submission recovery</legend>
      <button id="clearing-status" type="button">Read saved submission</button>
      <button id="clearing-reconcile" type="button">Verify saved transaction receipt</button>
      <label>Transaction hash from your wallet <input id="clearing-recovery-hash" autocomplete="off" placeholder="0x..."></label>
      <button id="clearing-recover" type="button">Bind matching transaction hash</button>
      <button id="clearing-replacement" type="button">Verify wallet cancellation or replacement</button>
      <button id="clearing-finish" type="button">Acknowledge verified receipt</button>
      <p id="clearing-recovery-guidance">A timeout or unknown result stays locked. Never resend automatically or clear browser storage. A verified receipt is chain evidence, not register finality.</p>
    </fieldset>
    <pre id="clearing-result" aria-live="polite">Load a verified deployment and connect.</pre>`;
  const el = id => document.getElementById(id), text = id => el(id).value.trim();
  const stringify = value => JSON.stringify(value, (_k, v) => typeof v === 'bigint' ? v.toString() : v, 2);
  const result = value => { el('clearing-result').textContent = typeof value === 'string' ? value : stringify(value); };
  el('clearing-notes').textContent = CLEARING_NOTES;
  let provider = null, deployment = null, session = null, review = null, generation = 0, busy = false;
  const clearReview = () => { review = null; el('clearing-acknowledge').checked = false; el('clearing-review').textContent = 'No clearing review prepared'; };
  const disconnect = () => { generation++; session = null; clearReview(); el('clearing-identity').textContent = 'Connection changed; reconnect the same account and deployment to recover.'; };
  globalThis.addEventListener?.('pagehide', disconnect);
  globalThis.addEventListener?.('pageshow', event => { if (event.persisted) disconnect(); });
  const selected = () => { walletLogin.assert(); if (!session) throw new ControlAdapterError('CLEARING_CONNECTION_REQUIRED'); return session; };
  async function run(fn) {
    if (busy) return;
    const lock = acquireWalletUi(); if (lock === null) return;
    busy = true; const current = generation;
    document.querySelectorAll('button:not([data-auth-control]),input,select').forEach(n => { n.disabled = true; });
    const guard = () => { walletLogin.assert(); if (current !== generation) throw new ControlAdapterError('CLEARING_CONNECTION_CHANGED'); };
    try { await walletLogin.check(); await getReleaseProfile(); guard(); await fn(guard); guard(); } catch (error) {
      result(current !== generation ? 'CLEARING_CONNECTION_CHANGED' : error instanceof WalletLoginError ? error.code : error instanceof ControlAdapterError ? error.code : 'CLEARING_UI_OPERATION_REFUSED');
    } finally {
      if (session && current === generation) {
        try {
          const state = await session.status(); guard();
          el('clearing-recovery-guidance').textContent = state.status === 'idle' ? 'No uncertain submission saved. Every action requires a new review and explicit wallet confirmation.' :
            state.status === 'outcome-unknown' ? 'Submission outcome is unknown. Keep this browser storage. Find the transaction hash in the same wallet, then bind and verify it. No resend is available.' :
              `Saved transaction ${state.transactionHash}. Verify its receipt, then explicitly acknowledge. No automatic resend.`;
        } catch { el('clearing-recovery-guidance').textContent = 'Saved state is unavailable or bound to another deployment. Keep browser storage; reconnect the original account and deployment.'; }
      }
      busy = false; releaseWalletUi(lock); document.querySelectorAll('button:not([data-auth-control]),input,select').forEach(n => { n.disabled = false; });
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
    el('clearing-identity').textContent = `${account} on chain ${deployment.chainId}; escrow ${deployment.escrow.address}`;
    result(status);
  }));
  walletLogin.subscribe(authenticated => {
    if (authenticated) return;
    disconnect(); provider = null;
    result('Log in to view clearing assets and history.');
    el('clearing-recovery-guidance').textContent = 'Log in to inspect preserved recovery state. No automatic resend.';
  });
  function inputRequest(kind) {
    if (kind !== 'open' && kind !== 'approve') return { kind, tradeKey: text('clearing-trade-key') };
    return { kind, localId: text('clearing-local-id'), tokenId: text('clearing-token-id'), buyer: text('clearing-buyer'),
      priceWei: text('clearing-price'), admissionDeadline: text('clearing-deadline'), maxEffectiveAt: text('clearing-max-effective') };
  }
  for (const action of ['approve', 'open', 'fund', 'release', 'refund', 'abandon']) el(`clearing-review-${action}`).addEventListener('click', () => run(async guard => {
    clearReview(); const next = await selected().prepare(JSON.stringify(inputRequest(action))); guard(); review = next;
    el('clearing-trade-key').value = next.tradeKey;
    el('clearing-review').textContent = stringify({ ...next, facts: JSON.parse(next.facts), notes: CLEARING_NOTES });
    result('Review prepared. No transaction sent.');
  }));
  el('clearing-cancel-review').addEventListener('click', clearReview);
  el('clearing-send').addEventListener('click', () => run(async guard => {
    if (!review || !el('clearing-acknowledge').checked) throw new ControlAdapterError('CLEARING_OWNER_REVIEW_REQUIRED');
    const approved = review; clearReview(); const hash = await selected().submit(approved, approved.digest); guard();
    el('clearing-recovery-hash').value = hash; result({ transactionHash: hash, status: 'submitted', registerFinalityEstablished: false });
  }));
  el('clearing-observe').addEventListener('click', () => run(async guard => { const observation = await selected().observe(text('clearing-trade-key')); guard(); result(observation); }));
  el('clearing-status').addEventListener('click', () => run(async guard => { const state = await selected().status(); guard(); result(state); }));
  el('clearing-reconcile').addEventListener('click', () => run(async guard => { const receipt = await selected().reconcile(); guard(); result(receipt); }));
  el('clearing-recover').addEventListener('click', () => run(async guard => { const receipt = await selected().recover(text('clearing-recovery-hash')); guard(); result(receipt); }));
  el('clearing-replacement').addEventListener('click', () => run(async guard => { const replacement = await selected().acknowledgeReplacement(text('clearing-recovery-hash')); guard(); clearReview(); result(replacement); }));
  el('clearing-finish').addEventListener('click', () => run(async guard => { await selected().acknowledge(); guard(); clearReview(); result('Canonical matching receipt acknowledged. Re-read the trade before preparing another action.'); }));
}
