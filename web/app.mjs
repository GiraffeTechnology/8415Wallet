import { ResponsibilityWalletSession, DetachedResponsibilityHistoryClient, ControlAdapterError, WalletSession, RpcErc8415Reader, Eip1193ReadTransport,
  renderAssetView, renderTemporalQuery, renderHistory, renderRegistration, renderAcquisitionDisclosure,
  renderRiskSurfaces, renderPosture, renderSettlementLog, renderOwnershipHistory, renderCollisions, CollisionScanError, verifyControlDeployment, controlRpc } from '../dist/browser/browser.js';
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
let connectionRevision = 0n, operationRevision = 0n;
function requireCurrentConnection() {
  if (operationRevision !== connectionRevision) fail('CONTROL_CONNECTION_CHANGED');
}
const selected = () => { if (!session || !deployment || !actor) fail('CONTROL_CONNECTION_REQUIRED'); return session; };
function clearConnection() {
  connectionRevision++; session = null; plainWallet = null; actor = null; review = null;
  el('acknowledge').checked = false; el('terms').textContent = 'No review prepared';
  el('identity').textContent = 'Connection changed; reconnect and re-read before acting';
  renderResult('Connection changed. Reconnect to reconcile any submitted or unknown operation; do not automatically repeat it.');
}
async function run(fn, reconnect = false) {
  if (busy) return;
  if (reconnect) clearConnection();
  operationRevision = connectionRevision;
  busy = true; document.querySelectorAll('button,input').forEach(n => { n.disabled = true; });
  try { await fn(); } catch (e) {
    // Provider, RPC and DOM exception text is never rendered, logged or persisted.
    renderResult(operationRevision !== connectionRevision ? 'CONTROL_CONNECTION_CHANGED' :
      e instanceof ControlAdapterError ? e.code : 'CONTROL_UI_OPERATION_REFUSED');
  } finally { busy = false; document.querySelectorAll('button,input').forEach(n => { n.disabled = false; }); }
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
  if (!provider) {
    provider = globalThis.ethereum;
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
  const nextWallet = new WalletSession(new RpcErc8415Reader(new Eip1193ReadTransport(provider, deployment.chainId),
    deployment.chainId, deployment.token.controller), { account: connected });
  const nextSession = deployment.controller === null ? null : new ResponsibilityWalletSession(provider, deployment.controller, connected,
    new BrowserPublicOperationStore(deployment.chainId, deployment.controller.controller, connected), deployment.payment);
  const state = nextSession ? await nextSession.status() : 'Standalone wallet connected; no responsibility or payment module required.';
  requireCurrentConnection();
  actor = connected; plainWallet = nextWallet; session = nextSession;
  el('identity').textContent = `Chain ${deployment.chainId} · selected account ${actor}`;
  display(state);
}, true));
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
el('standalone-tab').addEventListener('click', () => { el('standalone').hidden = false; el('linked').hidden = true; });
el('linked-tab').addEventListener('click', () => { el('standalone').hidden = true; el('linked').hidden = false; });
document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => run(async () => {
  const s = selected(), kind = button.dataset.action;
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
  if (kind === 'deposit' || kind === 'standalone-withdraw') operation = { kind, token: deployment.token, tokenId: number('tokenId'), ...(kind === 'standalone-withdraw' ? { destination: bytes(value('destination'), 20) } : {}) };
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
el('review').addEventListener('click', () => run(async () => {
  const s = selected(); review = null; signed = null; el('acknowledge').checked = false;
  const input = await jsonFile('consent-file', 2300000);
  requireCurrentConnection();
  if (!input || Object.keys(input).sort().join(',') !== 'consent,documents') fail('CONTROL_PUBLIC_DOCUMENT_REFUSED');
  for (const k of ['expectedRevision', 'tokenId', 'deadline', 'recipientNonce', 'paymentAmount']) input.consent[k] = integer(input.consent[k]);
  for (const d of [input.documents.incoming, ...input.documents.inherited]) if (d.terms.scheme === 'native-payment-v1') d.terms.amount = integer(d.terms.amount);
  const prepared = await s.consent.prepare(input.consent, actor, input.documents);
  requireCurrentConnection(); review = prepared;
  el('terms').textContent = JSON.stringify(review, (_k, v) => typeof v === 'bigint' ? v.toString() : v, 2);
  display('Review ready. No signature or transaction requested.');
}));
el('accept').addEventListener('click', () => run(async () => {
  const s = selected(); if (!review || !el('acknowledge').checked) fail('CONTROL_REVIEW_ACKNOWLEDGEMENT_REFUSED');
  const r = review; review = null; el('acknowledge').checked = false;
  const signature = await s.consent.accept(r, r.digest);
  requireCurrentConnection();
  signed = { consent: r.consent, recipientSignature: signature };
  display({ acceptedDigest: r.digest, signatureStored: false, transactionSent: false });
}));
el('forward').addEventListener('click', () => run(async () => {
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
