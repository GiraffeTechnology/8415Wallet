import { ResponsibilityWalletSession, ControlAdapterError, WalletSession, RpcErc8415Reader, Eip1193ReadTransport,
  renderAssetView, renderTemporalQuery, renderHistory, renderRegistration, renderAcquisitionDisclosure,
  renderRiskSurfaces, renderPosture, renderSettlementLog, renderOwnershipHistory, verifyControlDeployment, controlRpc } from '../dist/browser/browser.js';
import { BrowserPublicOperationStore } from './public-store.mjs';

const el = id => document.getElementById(id);
const display = value => { el('result').textContent = typeof value === 'string' ? value : JSON.stringify(value, (_k, v) => typeof v === 'bigint' ? v.toString() : v, 2); };
const value = id => el(id).value.trim();
const fail = code => { throw new ControlAdapterError(code); };
const integer = text => { if (!/^(0|[1-9][0-9]{0,77})$/.test(text) || BigInt(text) >= 1n << 256n) fail('CONTROL_INTEGER_REFUSED'); return BigInt(text); };
const number = id => integer(value(id));
const bytes = (text, size) => { if (!new RegExp(`^0x[0-9a-fA-F]{${size * 2}}$`).test(text)) fail('CONTROL_HEX_REFUSED'); return text.toLowerCase(); };
let deployment = null, provider = null, session = null, plainWallet = null, actor = null, review = null, signed = null, busy = false;
const selected = () => { if (!session || !deployment || !actor) fail('CONTROL_CONNECTION_REQUIRED'); return session; };
function clearConnection() { session = null; plainWallet = null; actor = null; review = null; el('acknowledge').checked = false; el('identity').textContent = 'Connection changed; reconnect and re-read before acting'; }
async function run(fn) {
  if (busy) return;
  busy = true; document.querySelectorAll('button,input').forEach(n => { n.disabled = true; });
  try { await fn(); } catch (e) {
    // Provider, RPC and DOM exception text is never rendered, logged or persisted.
    display(e instanceof ControlAdapterError ? e.code : 'CONTROL_UI_OPERATION_REFUSED');
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
  clearConnection(); signed = null; deployment = null;
  const d = await jsonFile('deployment', 8192);
  if (!d || Object.keys(d).sort().join(',') !== 'chainId,controller,payment,schema,token' || d.schema !== '8415-controls-testnet/1') fail('CONTROL_DEPLOYMENT_SCHEMA_REFUSED');
  const chainId = integer(d.chainId);
  if (![560048n, 11155111n].includes(chainId)) fail('CONTROL_TESTNET_REQUIRED');
  if (d.controller === null && d.payment !== null) fail('CONTROL_DEPLOYMENT_SCHEMA_REFUSED');
  deployment = { chainId, controller: d.controller === null ? null : pin(d.controller, chainId), token: pin(d.token, chainId), payment: d.payment === null ? null : pin(d.payment, chainId) };
  display({ deploymentLoaded: true, chainId, executionPerformed: false });
}));
el('connect').addEventListener('click', () => run(async () => {
  if (!deployment) fail('CONTROL_DEPLOYMENT_REQUIRED');
  if (!provider) {
    provider = globalThis.ethereum;
    if (!provider || typeof provider.request !== 'function') fail('CONTROL_GENUINE_WALLET_PROVIDER_REQUIRED');
    provider.on?.('accountsChanged', clearConnection);
    provider.on?.('chainChanged', () => { signed = null; clearConnection(); });
  }
  const accounts = await controlRpc(provider, 'eth_requestAccounts', []);
  if (!Array.isArray(accounts) || !accounts[0]) fail('CONTROL_SIGNER_REFUSED');
  const connected = bytes(accounts[0], 20);
  const chain = await controlRpc(provider, 'eth_chainId', []);
  if (typeof chain !== 'string' || !/^0x[0-9a-f]+$/i.test(chain) || BigInt(chain) !== deployment.chainId) fail('CONTROL_CHAIN_MISMATCH');
  actor = connected;
  await verifyControlDeployment(provider, deployment.token);
  plainWallet = new WalletSession(new RpcErc8415Reader(new Eip1193ReadTransport(provider, deployment.chainId),
    deployment.chainId, deployment.token.controller), { account: actor });
  session = deployment.controller === null ? null : new ResponsibilityWalletSession(provider, deployment.controller, actor,
    new BrowserPublicOperationStore(deployment.chainId, deployment.controller.controller, actor), deployment.payment);
  el('identity').textContent = `Chain ${deployment.chainId} · selected account ${actor}`;
  display(session ? await session.status() : 'Standalone wallet connected; no responsibility or payment module required.');
}));
document.querySelectorAll('[data-read]').forEach(button => button.addEventListener('click', () => run(async () => {
  if (!plainWallet || !deployment) fail('CONTROL_CONNECTION_REQUIRED');
  const wallet = plainWallet; await verifyControlDeployment(provider, deployment.token);
  const tokenId = number('tokenId'); let output;
  switch (button.dataset.read) {
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
  else if (kind === 'fund' || kind === 'allocate') operation = { kind, sequenceId: bytes(value('sequenceId'), 32), legIndex: number('index'), ...(kind === 'fund' ? { amount: number('amount') } : {}) };
  else if (kind === 'payout') operation = { kind, sequenceId: bytes(value('sequenceId'), 32), legId: bytes(value('legId'), 32) };
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
  if (!input || Object.keys(input).sort().join(',') !== 'consent,documents') fail('CONTROL_PUBLIC_DOCUMENT_REFUSED');
  for (const k of ['expectedRevision', 'tokenId', 'deadline', 'recipientNonce']) input.consent[k] = integer(input.consent[k]);
  for (const d of [input.documents.incoming, ...input.documents.inherited]) if (d.terms.scheme === 'native-payment-v1') d.terms.amount = integer(d.terms.amount);
  review = await s.consent.prepare(input.consent, actor, input.documents);
  el('terms').textContent = JSON.stringify(review, (_k, v) => typeof v === 'bigint' ? v.toString() : v, 2);
  display('Review ready. No signature or transaction requested.');
}));
el('accept').addEventListener('click', () => run(async () => {
  const s = selected(); if (!review || !el('acknowledge').checked) fail('CONTROL_REVIEW_ACKNOWLEDGEMENT_REFUSED');
  const r = review; review = null; el('acknowledge').checked = false;
  const signature = await s.consent.accept(r, r.digest);
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
el('ack-terminal').addEventListener('click', () => run(async () => {
  const s = selected(); const state = await s.status();
  if (!state.submission) fail('CONTROL_KNOWN_SUBMISSION_REQUIRED');
  await s.acknowledgeTerminal(state.submission.transactionHash); display(await s.status());
}));
