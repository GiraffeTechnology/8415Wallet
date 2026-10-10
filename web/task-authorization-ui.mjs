/** Human-only task authorization form; no OTP, credential or grant is persisted. */
import { TaskAuthorizationClient, TaskAuthorizationFlow } from './task-authorization.mjs';
import { msg, paint } from './i18n.mjs';
const validDigest = value => typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value) ? value : null;
export function mountTaskAuthorization({ document, window, walletLogin, getClient, Client = TaskAuthorizationClient, Flow = TaskAuthorizationFlow }) {
  const el = id => document.getElementById(id);
  let flow = null, visible = false, generation = 0, identity = null, active = null, continuationTimer = null;
  let coordinationTimer = null, releaseLease = null, leasePending = false, leader = false, leaseEpoch = 0;
  let selectedDigest = validDigest(window.history.state?.walletTaskDigest);
  const clearCode = () => { el('task-code').value = ''; el('task-ack').checked = false; };
  function rememberDigest(digest) {
    selectedDigest = validDigest(digest);
    // A digest is a public locator, never login, authority, a grant reference or OTP.
    window.history.replaceState({ ...(window.history.state ?? {}), walletTaskDigest: selectedDigest }, '');
  }
  function row(key, value) {
    const item = document.createElement('div'); item.className = 'review-row';
    const name = document.createElement('span'), data = document.createElement('strong');
    paint(name, msg(key)); data.textContent = String(value); item.append(name, data); el('task-summary').append(item);
  }
  function stopContinuation() { if (continuationTimer !== null) window.clearTimeout(continuationTimer); continuationTimer = null; }
  function stopCoordination() {
    leaseEpoch++; leasePending = false; leader = false;
    if (coordinationTimer !== null) window.clearTimeout(coordinationTimer); coordinationTimer = null;
    const release = releaseLease; releaseLease = null; release?.();
  }
  function coordinate() {
    if (leader || leasePending || coordinationTimer !== null) return;
    if (!window.navigator?.locks?.request) { paint(el('task-auto-status'), msg('task.autoUnavailable')); return; }
    const epoch = leaseEpoch; leasePending = true;
    // One visible same-origin tab polls at a time. A lock is coordination only;
    // no task, credential, grant or account detail is shared or persisted.
    void window.navigator.locks.request('8415wallet:task-continuation', { ifAvailable: true }, async lock => {
      if (epoch !== leaseEpoch) return; leasePending = false;
      if (!lock) {
        paint(el('task-auto-status'), msg('task.autoOtherTab'));
        coordinationTimer = window.setTimeout(() => { coordinationTimer = null; scheduleContinuation(); }, 60000); return;
      }
      leader = true; paint(el('task-auto-status'), '');
      await new Promise(resolve => { releaseLease = resolve; scheduleContinuation(); });
    }).catch(() => { if (epoch === leaseEpoch) { leasePending = false; leader = false; paint(el('task-auto-status'), msg('task.autoUnavailable')); } });
  }
  function scheduleContinuation() {
    stopContinuation();
    const eligible = visible && document.visibilityState !== 'hidden' &&
      (active?.selected?.capabilities.adapterConfigured || active?.selected?.capabilities.receiptVerifierConfigured) &&
      ['authorized-waiting', 'outcome-unknown', 'submitted', 'awaiting-evidence', 'rate-limited'].includes(active?.phase);
    if (!eligible) {
      // Keep the lease across one in-flight request; release on terminal/hidden/closed states.
      if (!active?.busy || !visible || document.visibilityState === 'hidden') stopCoordination();
      paint(el('task-auto-status'), ''); return;
    }
    if (active.busy) return;
    if (!leader) { coordinate(); return; }
    const timing = flow?.snapshot() ?? active;
    const delay = Math.max(timing.continuationDelayMs ?? 30000, timing.retryAfterMs ?? 0);
    continuationTimer = window.setTimeout(() => { continuationTimer = null; void flow?.continue(); }, delay);
  }
  function render(snapshot) {
    if (document.visibilityState === 'hidden' && snapshot.selected?.completion.fresh) { flow?.markHistorical(); return; }
    active = snapshot; el('task-list').replaceChildren(); el('task-summary').replaceChildren();
    for (const view of snapshot.tasks) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'task-list-item';
      const title = document.createElement('strong'); title.textContent = view.task.policy.taskId;
      const status = document.createElement('span'); paint(status, msg(`task.${view.effectiveStatus}`)); button.append(title, status);
      button.addEventListener('click', () => { clearCode(); rememberDigest(view.task.digest); void flow?.open(view.task.digest); });
      el('task-list').append(button);
    }
    el('task-empty').hidden = snapshot.phase !== 'list' || snapshot.tasks.length !== 0;
    paint(el('task-status'), msg(`task.state.${snapshot.phase}`, snapshot.phase === 'rate-limited' ?
      { seconds: Math.ceil(Math.max(snapshot.retryAfterMs, snapshot.continuationDelayMs) / 1000) } : {}));
    paint(el('task-error'), snapshot.error ?? snapshot.selected?.continuation?.code ?? '');
    const view = snapshot.selected; el('task-detail').hidden = !view;
    if (view) {
      const { policy, digest } = view.task;
      row('task.agentId', view.executor.identity.agentId); row('task.agentVersion', view.executor.identity.agentVersion);
      row('task.adapterId', view.executor.identity.adapterId); row('task.adapterVersion', view.executor.identity.adapterVersion);
      row('task.implementationDigest', view.executor.identity.implementationDigest); row('task.executorDigest', view.executor.digest);
      if (view.observationPolicy) {
        row('task.minimumConfirmations', view.observationPolicy.policy.minimumConfirmations);
        row('task.observationPolicyDigest', view.observationPolicy.digest);
      }
      paint(el('task-policy-status'), msg(view.observationPolicy ? 'task.observationPolicyConfigured' : 'task.observationPolicyMissing'));
      if (view.receiptVerifier) {
        row('task.verifierId', view.receiptVerifier.verifierId); row('task.verifierVersion', view.receiptVerifier.verifierVersion);
        row('task.verifierDigest', view.receiptVerifier.verifierImplementationDigest);
      }
      paint(el('task-verifier-status'), msg(view.receiptVerifier ? 'task.verifierPinned' : 'task.verifierMissing'));
      paint(el('task-completion'), msg(`task.completion.${view.completion.state}`));
      paint(el('task-observation-freshness'), msg(view.completion.fresh ? 'task.observationFresh' : 'task.observationHistorical'));
      el('task-observation-states').replaceChildren();
      for (const entry of view.observations) {
        const item = document.createElement('p');
        paint(item, msg(entry.available && entry.observation ? `task.observation.${entry.observation.state}` : 'task.observationUnavailable'));
        el('task-observation-states').append(item);
      }
      el('task-observations').textContent = JSON.stringify(view.observations, null, 2);
      row('task.id', policy.taskId); row('task.digest', digest); row('task.account', policy.actor);
      row('task.tenant', policy.tenant); row('task.origin', policy.origin); row('task.chain', policy.chainId);
      if (policy.intent.kind === 'nft-sale') {
        const intent = policy.intent, amount = intent.minimumProceeds.amountMinor.padStart(3, '0');
        row('task.intent', intent.kind); row('task.standard', intent.standard); row('task.contract', intent.contract);
        row('task.token', intent.tokenId); row('task.quantity', intent.quantity);
        row('task.minimum', `${intent.minimumProceeds.comparison === 'gt' ? '>' : '≥'} ${amount.slice(0, -2)}.${amount.slice(-2)} USD`);
        row('task.basis', intent.minimumProceeds.basis); row('task.markets', intent.marketAdapters.join(', '));
      } else {
        row('task.intent', policy.intent.operation.kind);
        const fields = (object, prefix = '') => { for (const [key, value] of Object.entries(object)) {
          if (value && typeof value === 'object') fields(value, `${prefix}${key}.`);
          else { const item = document.createElement('div'); item.className = 'review-row';
            const name = document.createElement('span'), data = document.createElement('strong');
            name.textContent = `${prefix}${key}`; data.textContent = value; item.append(name, data); el('task-summary').append(item); }
        } }; fields(policy.intent.operation);
      }
      row('task.expiry', `${policy.expiresAt} (Unix seconds)`);
      row('task.feeEach', `${policy.fees.perOperationWei} wei`); row('task.feeTotal', `${policy.fees.totalWei} wei`);
      el('task-canonical').textContent = JSON.stringify(policy, null, 2);
      el('task-missing').textContent = view.capabilities.missing.join('\n');
      paint(el('task-execution-status'), msg(`task.execution.${view.executionState}`));
      el('task-operations').textContent = JSON.stringify(view.budget?.reservations ?? [], null, 2);
    } else { for (const id of ['task-policy-status', 'task-verifier-status', 'task-completion', 'task-observation-freshness', 'task-observations']) el(id).textContent = '';
      el('task-observation-states').replaceChildren(); el('task-canonical').textContent = ''; el('task-missing').textContent = ''; el('task-execution-status').textContent = ''; el('task-operations').textContent = ''; }
    el('task-authorize-fields').hidden = snapshot.phase !== 'review';
    el('task-code').disabled = snapshot.phase !== 'review';
    el('task-authorize').disabled = snapshot.phase !== 'review';
    el('task-refresh').disabled = snapshot.busy || snapshot.retryAfterMs > 0;
    el('task-recheck').hidden = !view || snapshot.busy; el('task-recheck').disabled = snapshot.retryAfterMs > 0;
    el('task-revoke').hidden = !view?.authorization || ['revoked', 'expired'].includes(view?.effectiveStatus);
    el('task-revoke').disabled = snapshot.busy;
    el('task-recover').hidden = !['unknown', 'submitted'].includes(view?.executionState);
    paint(el('task-recover'), msg(view?.executionState === 'submitted' ? 'task.observe' : 'task.recover')); el('task-recover').disabled = snapshot.busy || snapshot.retryAfterMs > 0;
    el('task-blocked').hidden = snapshot.phase !== 'authorized-blocked';
    if (snapshot.phase !== 'review') clearCode();
    scheduleContinuation();
  }
  function leave() { stopContinuation(); stopCoordination(); generation++; visible = false; clearCode(); flow?.suspend(); }
  async function show() {
    visible = true; const current = ++generation; clearCode();
    try {
      const session = await walletLogin.check(); if (!visible || current !== generation) return;
      const client = getClient();
      if (!session.serverId || !client) { flow?.lock(); paint(el('task-status'), msg('task.serverLogin')); return; }
      const key = `${session.id}:${session.serverId}:${session.account}:${session.chainId}:${session.tenant}`;
      if (!flow || key !== identity) {
        identity = key;
        const binding = walletLogin.capture();
        flow = new Flow({ client: new Client({ context: session, request: async (path, body) => {
          walletLogin.assert(binding); await walletLogin.check(); walletLogin.assert(binding);
          const result = await client.request(path, body); walletLogin.assert(binding); return result;
        } }), onChange: render });
      }
      await flow.load(selectedDigest);
    } catch { if (visible && current === generation) { flow?.lock(); paint(el('task-status'), msg('task.serverLogin')); } }
  }
  el('task-refresh').addEventListener('click', () => { clearCode(); void flow?.load(selectedDigest); });
  el('task-recheck').addEventListener('click', () => { clearCode(); if (selectedDigest) void flow?.open(selectedDigest); });
  el('task-authorize-form').addEventListener('submit', event => {
    event.preventDefault();
    if (!visible || active?.phase !== 'review' || !el('task-ack').checked) { paint(el('task-error'), msg('task.ackRequired')); return; }
    let code = el('task-code').value; clearCode(); void flow?.authorize(code); code = '';
  });
  el('task-cancel').addEventListener('click', () => { clearCode(); flow?.suspend(); });
  el('task-recover').addEventListener('click', () => { clearCode(); void flow?.recover(); });
  el('task-revoke').addEventListener('click', () => { clearCode(); void flow?.revoke(); });
  document.addEventListener('wallet:page', event => { if (event.detail === 'tasks') { if (!visible) void show(); } else if (visible) leave(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { clearCode(); stopContinuation(); stopCoordination(); flow?.markHistorical(); } else scheduleContinuation(); });
  window.addEventListener('pagehide', leave);
  window.addEventListener('keydown', event => { if (event.key === 'Escape' && visible) { clearCode(); flow?.suspend(); } });
  walletLogin.subscribe(session => {
    stopContinuation(); stopCoordination(); generation++; clearCode(); flow?.lock(); flow = null; identity = null;
    if (!session) { el('task-summary').replaceChildren(); el('task-canonical').textContent = ''; el('task-missing').textContent = ''; el('task-execution-status').textContent = ''; el('task-operations').textContent = ''; }
    // Login never authorizes a task. Reload only the page already selected.
    if (session && visible) void show();
  });
  render({ phase: 'locked', tasks: [], selected: null, busy: false, error: null });
  return { snapshot: () => flow?.snapshot() ?? null };
}
