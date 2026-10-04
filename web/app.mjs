import { walletLogin, WalletLoginError } from './wallet-auth.mjs';
import { getReleaseProfile } from './release-profile.mjs';
import { BrowserSettlementStore } from './settlement-store.mjs';
import { StandaloneSettlementSession, isAddressInput, TransactionWouldRevertError } from '../dist/browser/browser.js';
import { acquireWalletUi, releaseWalletUi } from './ui-lock.mjs';
import { ResponsibilityWalletSession, DetachedResponsibilityHistoryClient, ControlAdapterError, WalletSession, RpcErc8415Reader, Eip1193ReadTransport,
  renderAssetView, renderTemporalQuery, renderHistory, renderRegistration, renderAcquisitionDisclosure,
  renderRiskSurfaces, renderPosture, renderSettlementLog, renderOwnershipHistory, renderCollisions, CollisionScanError, verifyControlDeployment, controlRpc } from '../dist/browser/browser.js';
import { reviewAgentRequest, recoveryGuidance } from '../dist/browser/browser.js';
import { BrowserPublicOperationStore } from './public-store.mjs';

const el = id => document.getElementById(id);
const renderResult = value => { el('result').textContent = typeof value === 'string' ? value : JSON.stringify(value, (_k, v) => typeof v === 'bigint' ? v.toString() : v, 2); };
const display = value => { requireCurrentConnection(); renderResult(value); };
const value = id => el(id).value.trim();
const fail = code => { throw new ControlAdapterError(code); };
const integer = text => { if (!/^(0|[1-9][0-9]{0,77})$/.test(text) || BigInt(text) >= 1n << 256n) fail('CONTROL_INTEGER_REFUSED'); return BigInt(text); };
const number = id => integer(value(id));
const bytes = (text, size) => { if (!new RegExp(`^0x[0-9a-fA-F]{${size * 2}}$`).test(text)) fail('CONTROL_HEX_REFUSED'); return text.toLowerCase(); };
let deployment = null, provider = null, session = null, plainWallet = null, actor = null, review = null, signed = null, busy = false;
let agentRequestText = null, agentReview = null;
let settlementSession = null, settlementReview = null, settlementReviewRevision = 0n, consentRevision = 0n;
let releaseProfile = null;
const releaseReady = getReleaseProfile().then(profile => {
  releaseProfile = profile;
  el('release-profile').textContent = `${profile.product} · ${profile.version} · ${profile.platform} · tenant: ${profile.tenant.label}`;
  el('linked-tab').hidden = !profile.features.linkedResponsibilities;
  el('controlled-account-actions').hidden = false;
  el('agent-controls-panel').hidden = false;
  el('control-recovery-panel').hidden = false;
}).catch(() => { el('release-profile').textContent = 'Release configuration unavailable. Signing is disabled; reload a verified artifact.'; });
let connectionRevision = 0n, operationRevision = 0n;
function requireCurrentConnection() {
  walletLogin.assert();
  if (operationRevision !== connectionRevision) fail('CONTROL_CONNECTION_CHANGED');
}
const selected = () => { walletLogin.assert(); if (!session || !deployment || !actor) fail('CONTROL_CONNECTION_REQUIRED'); return session; };
function clearAgentReview() {
  agentRequestText = null; agentReview = null;
  el('agent-acknowledge').checked = false; el('agent-terms').textContent = 'No agent request reviewed';
}
function clearConsent(discardAcceptance = true) {
  consentRevision++; review = null; if (discardAcceptance) signed = null;
  el('acknowledge').checked = false; el('terms').textContent = 'No review prepared';
}
function clearSettlementReview() {
  settlementReviewRevision++; settlementReview = null;
  el('settlement-ack').checked = false; el('settlement-terms').textContent = 'No settlement reviewed';
}
function clearConnection() {
  clearConsent(false); clearSettlementReview(); settlementSession = null;
  el('settlement-state').textContent = 'Reconnect the same account and deployment to inspect the saved settlement. No automatic resend.';
  clearAgentReview(); el('recovery-guidance').textContent = recoveryGuidance(null);
  connectionRevision++; session = null; plainWallet = null; actor = null; review = null;
  el('acknowledge').checked = false; el('terms').textContent = 'No review prepared';
  el('identity').textContent = 'Connection changed; reconnect and re-read before acting';
  renderResult('Connection changed. Reconnect to reconcile any submitted or unknown operation; do not automatically repeat it.');
}
async function run(fn, reconnect = false) {
  if (busy) return;
  const uiLock = acquireWalletUi(); if (uiLock === null) return;
  if (reconnect) clearConnection();
  operationRevision = connectionRevision;
  busy = true; document.querySelectorAll('button:not([data-auth-control]),input,select').forEach(n => { n.disabled = true; });
  try { await walletLogin.check(); if (!releaseProfile) await releaseReady; if (!releaseProfile) fail('CONTROL_RELEASE_PROFILE_REFUSED'); await fn(); } catch (e) {
    // Provider, RPC and DOM exception text is never rendered, logged or persisted.
    renderResult(operationRevision !== connectionRevision ? 'CONTROL_CONNECTION_CHANGED' :
      e instanceof WalletLoginError ? e.code : e instanceof ControlAdapterError ? (e.code === 'CONTROL_PROVIDER_REQUEST_REJECTED' ? 'Wallet request cancelled. Prepare and acknowledge a fresh review before trying again.' : e.code) :
      e instanceof TransactionWouldRevertError ? { action: e.kind, refusedChecks: e.checks, transactionSent: false } : 'CONTROL_UI_OPERATION_REFUSED');
  } finally {
    if (session && operationRevision === connectionRevision) {
      const current = session;
      try {
        const state = await current.status();
        if (current === session && operationRevision === connectionRevision) el('recovery-guidance').textContent = recoveryGuidance(state);
      } catch { el('recovery-guidance').textContent = 'Saved state unavailable. Do not resend or clear browser storage. Reconnect the same account and deployment.'; }
    }
    if (settlementSession && operationRevision === connectionRevision) {
      const current = settlementSession;
      try { const state = await current.status();
        if (current === settlementSession && operationRevision === connectionRevision) el('settlement-state').textContent = JSON.stringify(state, (_k, v) => typeof v === 'bigint' ? v.toString() : v, 2);
      } catch { if (current === settlementSession && operationRevision === connectionRevision) el('settlement-state').textContent = 'Saved settlement unavailable. Do not resend or clear storage. Reconnect the same account and deployment.'; }
    }
    busy = false; releaseWalletUi(uiLock); document.querySelectorAll('button:not([data-auth-control]),input,select').forEach(n => { n.disabled = false; });
  }
}
async function jsonFile(id, maximum) {
  const file = el(id).files?.[0]; if (!file || file.size > maximum) fail('CONTROL_PUBLIC_DOCUMENT_REFUSED');
  try { return JSON.parse(await file.text()); } catch { fail('CONTROL_PUBLIC_DOCUMENT_REFUSED'); }
}
function pin(raw, chainId) {
  if (!raw || Object.keys(raw).sort().join(',') !== 'address,runtimeCodeHash') fail('CONTROL_DEPLOYMENT_PIN_REFUSED');
  return { chainId, controller: bytes(raw.address, 20), runtimeCodeHash: bytes(raw.runtimeCodeHash, 32) };
}
el('deployment').addEventListener('change', () => run(async () => {
  signed = null; deployment = null;
  const d = await jsonFile('deployment', 8192);
  requireCurrentConnection();
  if (!d || Object.keys(d).sort().join(',') !== 'chainId,controller,payment,schema,token' || d.schema !== '8415-controls-testnet/1') fail('CONTROL_DEPLOYMENT_SCHEMA_REFUSED');
  const chainId = integer(d.chainId);
  if (![560048n, 11155111n].includes(chainId)) fail('CONTROL_TESTNET_REQUIRED');
  if (d.controller === null && d.payment !== null) fail('CONTROL_DEPLOYMENT_SCHEMA_REFUSED');
  deployment = { chainId, controller: d.controller === null ? null : pin(d.controller, chainId), token: pin(d.token, chainId), payment: d.payment === null ? null : pin(d.payment, chainId) };
  display({ deploymentLoaded: true, chainId, executionPerformed: false });
}, true));
el('connect').addEventListener('click', () => run(async () => {
  if (!deployment) fail('CONTROL_DEPLOYMENT_REQUIRED');
  {
    provider = walletLogin.provider();
    if (!provider || typeof provider.request !== 'function') fail('CONTROL_GENUINE_WALLET_PROVIDER_REQUIRED');
    provider.on?.('accountsChanged', clearConnection);
    provider.on?.('chainChanged', () => { signed = null; clearConnection(); });
    provider.on?.('disconnect', () => { signed = null; clearConnection(); });
  }
  const accounts = await controlRpc(provider, 'eth_requestAccounts', []);
  requireCurrentConnection();
  if (!Array.isArray(accounts) || !accounts[0]) fail('CONTROL_SIGNER_REFUSED');
  const connected = bytes(accounts[0], 20);
  const chain = await controlRpc(provider, 'eth_chainId', []);
  requireCurrentConnection();
  if (typeof chain !== 'string' || !/^0x[0-9a-f]+$/i.test(chain) || BigInt(chain) !== deployment.chainId) fail('CONTROL_CHAIN_MISMATCH');
  await verifyControlDeployment(provider, deployment.token);
  requireCurrentConnection();
  const capturedRevision = connectionRevision;
  const connectedProvider = { request: args => {
    if (capturedRevision !== connectionRevision) fail('CONTROL_CONNECTION_CHANGED');
    return provider.request(args);
  } };
  const nextWallet = new WalletSession(new RpcErc8415Reader(new Eip1193ReadTransport(connectedProvider, deployment.chainId),
    deployment.chainId, deployment.token.controller), { account: connected });
  const nextSettlement = new StandaloneSettlementSession(connectedProvider, deployment.token, connected,
    new BrowserSettlementStore(deployment.chainId, deployment.token.controller, connected),
    () => { if (capturedRevision !== connectionRevision) fail('CONTROL_CONNECTION_CHANGED'); }, nextWallet);
  await nextSettlement.status();
  const nextSession = deployment.controller === null ? null : new ResponsibilityWalletSession(connectedProvider, deployment.controller, connected,
    new BrowserPublicOperationStore(deployment.chainId, deployment.controller.controller, connected), deployment.payment);
  const state = nextSession ? await nextSession.status() : 'Standalone wallet connected; no responsibility or payment module required.';
  requireCurrentConnection();
  actor = connected; plainWallet = nextWallet; session = nextSession; settlementSession = nextSettlement;
  el('identity').textContent = `Chain ${deployment.chainId} · selected account ${actor}`;
  display(state);
}, true));
walletLogin.subscribe((authenticated, reason) => {
  if (authenticated) return;
  if (!['LOGIN_ACCOUNT_CHANGED', 'LOGIN_STARTING'].includes(reason)) signed = null;
  clearConnection(); provider = null;
  for (const input of document.querySelectorAll('#standalone input, #linked input, #agent-controls-panel input, #control-recovery-panel input')) {
    if (input.type === 'checkbox') input.checked = false; else input.value = input.type === 'file' ? '' : input.defaultValue ?? '';
  }
  el('settlement-state').textContent = 'Log in to inspect the preserved settlement journal.';
  el('recovery-guidance').textContent = 'Log in to inspect preserved recovery state. No automatic resend.';
  el('identity').textContent = 'Login required';
  renderResult('Log in to view assets and history.');
});
document.querySelectorAll('[data-read]').forEach(button => button.addEventListener('click', () => run(async () => {
  if (!plainWallet || !deployment) fail('CONTROL_CONNECTION_REQUIRED');
  const wallet = plainWallet; await verifyControlDeployment(provider, deployment.token);
  requireCurrentConnection();
  const tokenId = button.dataset.read === 'collisions' ? 0n : number('tokenId'); let output;
  switch (button.dataset.read) {
    case 'collisions': {
      const input = value('collision-token-ids');
      if (input.length === 0 || input.length > 2560) fail('COLLISION_TOKEN_INPUT_REFUSED');
      const parts = input.split(',');
      if (parts.length > 32) fail('COLLISION_TOKEN_BUDGET_REFUSED');
      const ids = parts.map(part => integer(part.trim()));
      if (new Set(ids).size !== ids.length) fail('COLLISION_DUPLICATE_TOKEN_REFUSED');
      try { output = renderCollisions(await wallet.collisions(ids)); }
      catch (error) {
        if (error instanceof CollisionScanError) fail(error.code);
        throw error;
      }
      break;
    }
    case 'asset': output = renderAssetView(await wallet.assetView(tokenId)); break;
    case 'temporal': output = renderTemporalQuery(await wallet.temporalQuery(tokenId, number('instant'))); break;
    case 'history': output = renderHistory(await wallet.history(tokenId)); break;
    case 'registration': output = renderRegistration(await wallet.registration(tokenId)); break;
    case 'acquisition': output = renderAcquisitionDisclosure(await wallet.acquisitionDisclosure(tokenId)); break;
    case 'risk': output = renderRiskSurfaces(await wallet.riskSurfaces(tokenId)); break;
    case 'posture': output = renderPosture(await wallet.posture(tokenId, number('instant'))); break;
    case 'settlements': output = renderSettlementLog(await wallet.settlementLog(tokenId)); break;
    case 'ownership': output = renderOwnershipHistory(await wallet.ownershipHistory(tokenId)); break;
    default: fail('CONTROL_ACTION_REFUSED');
  }
  if (wallet !== plainWallet) fail('CONTROL_CONNECTION_CHANGED'); display(output);
})));
el('standalone-tab').addEventListener('click', () => { clearConsent(false); clearSettlementReview(); el('standalone').hidden = false; el('linked').hidden = true; });
el('linked-tab').addEventListener('click', () => { if (!releaseProfile?.features.linkedResponsibilities) return; clearConsent(false); clearSettlementReview(); el('standalone').hidden = true; el('linked').hidden = false; });
document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => run(async () => {
  const s = selected(), kind = button.dataset.action;
  if (!releaseProfile.features.linkedResponsibilities && !['create-account', 'account', 'deposit', 'standalone-withdraw'].includes(kind)) fail('CONTROL_RELEASE_PROFILE_REFUSED');
  if (kind === 'account') { display(await s.accounts.account(actor)); return; }
  if (kind === 'read-detached-history') {
    const archive = new DetachedResponsibilityHistoryClient(provider, deployment.controller);
    const sequenceId = bytes(value('sequenceId'), 32);
    const document = await jsonFile('detached-history-file', 4 * 1024 * 1024);
    requireCurrentConnection();
    const observation = await archive.observe(sequenceId, document);
    if (s !== session) fail('CONTROL_CONNECTION_CHANGED');
    display({ ...observation, disclosure: 'Public control history checked against a canonical chain commitment. Not legal identity, not ERC temporal finality, and not authority to send a transaction.' }); return;
  }
  if (kind === 'read-payment') {
    if (!s.payments) fail('CONTROL_PAYMENT_NOT_CONFIGURED');
    const observation = await s.payments.observe(bytes(value('sequenceId'), 32), bytes(value('legId'), 32));
    if (s !== session) fail('CONTROL_CONNECTION_CHANGED');
    display(observation); return;
  }
  if (kind === 'read') {
    const observed = await s.reader.observe(bytes(value('sequenceId'), 32));
    const payments = [];
    if (s.payments) for (const leg of observed.snapshot.legs) payments.push(await s.payments.readAt(observed.snapshot.sequenceId, leg.id, observed.snapshot.blockHash));
    const header = await controlRpc(provider, 'eth_getBlockByNumber', [`0x${observed.snapshot.blockNumber.toString(16)}`, false]);
    if (header?.hash?.toLowerCase() !== observed.snapshot.blockHash) fail('CONTROL_SNAPSHOT_REORGED');
    display({ responsibility: observed.snapshot, projection: observed.projection, occurrenceEvidence: observed.evidence,
      payments: s.payments ? payments : 'not configured — responsibility remains independent', readOnly: true }); return;
  }
  let operation;
  if (kind === 'deposit' || kind === 'standalone-withdraw') operation = { kind, token: deployment.token, tokenId: number('tokenId'), ...(kind === 'standalone-withdraw' ? { destination: addressInput(value('destination')) } : {}) };
  else if (kind === 'reserve-payment') {
    if (!signed) fail('CONTROL_IN_MEMORY_CONSENT_REQUIRED');
    operation = { kind, consent: signed.consent };
  }
  else if (kind === 'allocate') operation = { kind, sequenceId: bytes(value('sequenceId'), 32), legId: bytes(value('legId'), 32) };
  else if (kind === 'payout' || kind === 'cancel-reservation') operation = { kind, sequenceId: bytes(value('sequenceId'), 32), legId: bytes(value('legId'), 32) };
  else {
    let action;
    if (kind === 'create-account') action = { kind };
    else if (kind === 'open-sequence') action = { kind, token: deployment.token.controller, tokenId: number('tokenId'), evidenceAuthority: bytes(value('authority'), 20) };
    else if (kind === 'invalidate-consent') action = { kind, nextNonce: number('nonce') };
    else {
      action = { kind, sequenceId: bytes(value('sequenceId'), 32), expectedRevision: number('revision') };
      if (kind === 'bind-admission') Object.assign(action, { occurrence: number('index'), version: number('version') });
      else if (kind === 'complete') action.throughLegId = bytes(value('legId'), 32);
      else if (kind === 'return-hop') action.legId = bytes(value('legId'), 32);
      else if (kind === 'begin-return') Object.assign(action, { rootLegId: bytes(value('legId'), 32), conditionHash: bytes(value('condition'), 32), evidenceCommitment: bytes(value('evidence'), 32) });
      else if (kind !== 'close-sequence') fail('CONTROL_ACTION_REFUSED');
    }
    operation = { kind: 'control', action };
  }
  display(await s.execute(operation));
})));
el('consent-file').addEventListener('change', () => clearConsent());
el('consent-dismiss').addEventListener('click', () => clearConsent());
el('review').addEventListener('click', () => run(async () => {
  clearConsent(); if (!releaseProfile.features.linkedResponsibilities) fail('CONTROL_RELEASE_PROFILE_REFUSED');
  const s = selected(), revision = consentRevision;
  const input = await jsonFile('consent-file', 2300000);
  requireCurrentConnection();
  if (!input || Object.keys(input).sort().join(',') !== 'consent,documents') fail('CONTROL_PUBLIC_DOCUMENT_REFUSED');
  for (const k of ['expectedRevision', 'tokenId', 'deadline', 'recipientNonce', 'paymentAmount']) input.consent[k] = integer(input.consent[k]);
  for (const d of [input.documents.incoming, ...input.documents.inherited]) if (d.terms.scheme === 'native-payment-v1') d.terms.amount = integer(d.terms.amount);
  const prepared = await s.consent.prepare(input.consent, actor, input.documents);
  requireCurrentConnection(); if (revision !== consentRevision || s !== session) fail('CONTROL_REVIEW_CHANGED'); review = prepared;
  el('terms').textContent = JSON.stringify(review, (_k, v) => typeof v === 'bigint' ? v.toString() : v, 2);
  display('Review ready. No signature or transaction requested.');
}));
el('accept').addEventListener('click', () => run(async () => {
  if (!releaseProfile.features.linkedResponsibilities) fail('CONTROL_RELEASE_PROFILE_REFUSED');
  const s = selected(); if (!review || !el('acknowledge').checked) fail('CONTROL_REVIEW_ACKNOWLEDGEMENT_REFUSED');
  const r = review; clearConsent(); const revision = consentRevision;
  const signature = await s.consent.accept(r, r.digest);
  requireCurrentConnection();
  if (revision !== consentRevision || s !== session) fail('CONTROL_REVIEW_CHANGED');
  signed = { consent: r.consent, recipientSignature: signature };
  display({ acceptedDigest: r.digest, signatureStored: false, transactionSent: false });
}));
el('forward').addEventListener('click', () => run(async () => {
  if (!releaseProfile.features.linkedResponsibilities) fail('CONTROL_RELEASE_PROFILE_REFUSED');
  const s = selected(); if (!signed) fail('CONTROL_IN_MEMORY_CONSENT_REQUIRED');
  const acceptance = signed; signed = null;
  display(await s.execute({ kind: 'control', action: { kind: 'forward', ...acceptance } }));
}));
el('recover').addEventListener('click', () => run(async () => { display(await selected().reconcile()); }));
el('discard-unprepared').addEventListener('click', () => run(async () => {
  const s = selected(); await s.discardUnpreparedIntent(); display(await s.status());
}));
el('recover-hash').addEventListener('click', () => run(async () => {
  const s = selected(); await s.recoverTransactionHash(bytes(value('recovery-hash'), 32)); display(await s.reconcile());
}));
el('superseded-nonce').addEventListener('click', () => run(async () => {
  display(await selected().acknowledgeSupersededNonce(bytes(value('recovery-hash'), 32)));
}));
el('ack-terminal').addEventListener('click', () => run(async () => {
  const s = selected(); const state = await s.status();
  if (!state.submission) fail('CONTROL_KNOWN_SUBMISSION_REQUIRED');
  await s.acknowledgeTerminal(state.submission.transactionHash); display(await s.status());
}));

// Public file input only: no ambient message listener, HTTP write endpoint or agent credential.
async function agentContext() {
  selected();
  const header = await controlRpc(provider, 'eth_getBlockByNumber', ['latest', false]);
  requireCurrentConnection();
  if (!header || typeof header.timestamp !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(header.timestamp)) fail('AGENT_CHAIN_TIME_UNAVAILABLE');
  return { actor, controller: deployment.controller, token: deployment.token, now: BigInt(header.timestamp) };
}
el('agent-file').addEventListener('change', clearAgentReview);
el('agent-dismiss').addEventListener('click', clearAgentReview);
el('agent-review').addEventListener('click', () => run(async () => {
  clearAgentReview();
  const file = el('agent-file').files?.[0];
  if (!file || file.size > 8192) fail('AGENT_REQUEST_SIZE_REFUSED');
  const text = await file.text(); requireCurrentConnection();
  const prepared = reviewAgentRequest(text, await agentContext());
  requireOperationProfile(prepared.operation);
  requireCurrentConnection(); agentRequestText = text; agentReview = prepared;
  el('agent-terms').textContent = JSON.stringify(prepared, (_k, v) => typeof v === 'bigint' ? v.toString() : v, 2);
  display('Agent request reviewed. No signature or transaction requested. The claimed agent name is unverified.');
}));
el('agent-execute').addEventListener('click', () => run(async () => {
  const s = selected();
  if (!agentReview || !agentRequestText || !el('agent-acknowledge').checked) fail('AGENT_OWNER_REVIEW_REQUIRED');
  const prior = agentReview, text = agentRequestText;
  // Consume review before any asynchronous work. Repeated clicks cannot reuse it.
  clearAgentReview();
  const fresh = reviewAgentRequest(text, await agentContext());
  requireOperationProfile(fresh.operation);
  if (s !== session || fresh.digest !== prior.digest) fail('AGENT_REVIEW_CHANGED');
  display(await s.execute(fresh.operation));
}));

const addressInput = text => { if (!isAddressInput(text)) fail('CONTROL_ADDRESS_REFUSED'); return text.toLowerCase(); };
const settlementSelected = () => { if (!settlementSession) fail('CONTROL_CONNECTION_REQUIRED'); return settlementSession; };
for (const id of ['settlement-kind', 'settlement-id', 'settlement-holder', 'settlement-snapshot', 'settlement-deadline',
  'settlement-commitment', 'settlement-reference', 'settlement-effective', 'settlement-proof', 'settlement-reason', 'tokenId']) {
  el(id).addEventListener('input', clearSettlementReview); el(id).addEventListener('change', clearSettlementReview);
}
el('settlement-dismiss').addEventListener('click', clearSettlementReview);
el('settlement-prepare').addEventListener('click', () => run(async () => {
  clearSettlementReview(); const s = settlementSelected(), revision = settlementReviewRevision;
  const kind = value('settlement-kind'), settlementId = bytes(value('settlement-id'), 32); let params;
  if (kind === 'beginSettlement') params = { tokenId: number('tokenId'), settlementId, expectedHolder: addressInput(value('settlement-holder')),
    snapshotHash: bytes(value('settlement-snapshot'), 32), deadline: number('settlement-deadline') };
  else if (kind === 'finalizeSettlement') params = { settlementId, recordCommitment: bytes(value('settlement-commitment'), 32),
    registryReference: bytes(value('settlement-reference'), 32), effectiveAt: number('settlement-effective'), proofData: value('settlement-proof') };
  else if (kind === 'cancelSettlement') params = { settlementId, reasonHash: bytes(value('settlement-reason'), 32) };
  else fail('SETTLEMENT_ACTION_REFUSED');
  const prepared = await s.prepare({ kind, params }); requireCurrentConnection();
  if (revision !== settlementReviewRevision || s !== settlementSession) fail('SETTLEMENT_REVIEW_CHANGED');
  settlementReview = prepared; el('settlement-terms').textContent = JSON.stringify(prepared, (_k, v) => typeof v === 'bigint' ? v.toString() : v, 2);
  display('Settlement review prepared. Check authority, contract identity, all consequences and the wallet prompt. Nothing sent.');
}));
el('settlement-send').addEventListener('click', () => run(async () => {
  const s = settlementSelected(); if (!settlementReview || !el('settlement-ack').checked) fail('SETTLEMENT_REVIEW_REQUIRED');
  const accepted = settlementReview; clearSettlementReview();
  display({ transactionHash: await s.submit(accepted, accepted.digest), protocolFinality: 'not-evaluated' });
}));
el('settlement-reconcile').addEventListener('click', () => run(async () => { display(await settlementSelected().reconcile()); }));
el('settlement-recover').addEventListener('click', () => run(async () => { display(await settlementSelected().recover(bytes(value('settlement-recovery-hash'), 32))); }));
el('settlement-replacement').addEventListener('click', () => run(async () => { display(await settlementSelected().acknowledgeReplacement(bytes(value('settlement-recovery-hash'), 32))); }));
el('settlement-ack-terminal').addEventListener('click', () => run(async () => { const s = settlementSelected(); await s.acknowledge(); display(await s.status()); }));

// A restored history entry must not reuse a review or signature from the old page lifecycle.
globalThis.addEventListener?.('pagehide', () => { signed = null; clearConnection(); });
globalThis.addEventListener?.('pageshow', event => { if (event.persisted) { signed = null; clearConnection(); } });

function requireOperationProfile(operation) {
  if (releaseProfile?.features.linkedResponsibilities) return;
  if (['deposit', 'standalone-withdraw'].includes(operation.kind) || operation.kind === 'control' && operation.action.kind === 'create-account') return;
  fail('CONTROL_RELEASE_PROFILE_REFUSED');
}
