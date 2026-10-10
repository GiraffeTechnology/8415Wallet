/** Bounded task review. A sign-in session and a task grant are separate facts. */
import { sha256, toUtf8Bytes } from '../dist/browser/vendor/ethers.js';
import { freezeTaskObservationPolicy, normalizeObservationVerifier, normalizeTaskObservation } from '../dist/browser/agent/receiptObservation.js';
import { freezeTaskPolicy, normalizeAuthorizationReference, normalizeTaskBudget } from '../dist/browser/agent/taskContract.js';
export class TaskUiError extends Error {
  constructor(code) { super(code); this.name = 'TaskUiError'; this.code = code; }
}
const insist = (value, code = 'TASK_RESPONSE_REFUSED') => { if (!value) throw new TaskUiError(code); };
const statuses = new Set(['pending', 'authorized', 'suspended', 'revoked', 'expired']);
const freeze = value => { if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); } return value; };
/** Public executor identity, not a signing credential or proof of adapter safety. */
export function normalizeExecutor(value) {
  const names = ['schema', 'agentId', 'agentVersion', 'adapterId', 'adapterVersion', 'implementationDigest'];
  insist(value && typeof value === 'object' && value.identity && typeof value.identity === 'object' &&
    Object.keys(value).sort().join(',') === 'digest,identity' &&
    Object.keys(value.identity).sort().join(',') === [...names].sort().join(','), 'TASK_EXECUTOR_IDENTITY_REFUSED');
  const raw = value.identity;
  insist(raw.schema === '8415-task-executor/1' && ['agentId', 'agentVersion', 'adapterId', 'adapterVersion'].every(key =>
    typeof raw[key] === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(raw[key])) &&
    typeof raw.implementationDigest === 'string' && /^0x[0-9a-f]{64}$/.test(raw.implementationDigest) &&
    !/^0x0+$/.test(raw.implementationDigest), 'TASK_EXECUTOR_IDENTITY_REFUSED');
  const identity = { schema: raw.schema, agentId: raw.agentId, agentVersion: raw.agentVersion,
    adapterId: raw.adapterId, adapterVersion: raw.adapterVersion, implementationDigest: raw.implementationDigest };
  const digest = sha256(toUtf8Bytes(JSON.stringify(identity)));
  insist(value.digest === digest, 'TASK_EXECUTOR_DIGEST_MISMATCH'); return freeze({ identity, digest });
}
export function normalizeObservationContext(value) {
  let observationPolicy = null;
  if (value.observationPolicy !== null) {
    insist(value.observationPolicy && Object.keys(value.observationPolicy).sort().join(',') === 'digest,policy', 'TASK_OBSERVATION_POLICY_REFUSED');
    observationPolicy = freezeTaskObservationPolicy(value.observationPolicy.policy);
    insist(observationPolicy.digest === value.observationPolicy.digest, 'TASK_OBSERVATION_POLICY_MISMATCH');
  }
  const receiptVerifier = value.receiptVerifier === null ? null : normalizeObservationVerifier(value.receiptVerifier);
  insist(receiptVerifier === null || observationPolicy !== null, 'TASK_OBSERVATION_POLICY_REQUIRED');
  return freeze({ observationPolicy, receiptVerifier });
}
function sameObservationContext(value, expected) {
  insist((value.observationPolicy?.digest ?? null) === (expected.observationPolicy?.digest ?? null), 'TASK_OBSERVATION_POLICY_CHANGED');
  insist(JSON.stringify(value.receiptVerifier) === JSON.stringify(expected.receiptVerifier), 'TASK_RECEIPT_VERIFIER_CHANGED');
}
const completionStates = new Set(['not-attempted', 'outcome-unknown', 'awaiting-evidence', 'completed-at-observation-depth', 'failed-at-observation-depth']);
function observationView(value, task, executor, budget, authorization, allowFresh) {
  const context = normalizeObservationContext(value);
  insist(Array.isArray(value.observations) && value.observations.length <= (budget?.reservations.length ?? 0) &&
    typeof value.observationRevision === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value.observationRevision) &&
    BigInt(value.observationRevision) < (1n << 256n), 'TASK_OBSERVATION_RESPONSE_REFUSED');
  const observations = value.observations.map(entry => {
    insist(entry && Object.keys(entry).sort().join(',') === 'available,observation,operationId' && typeof entry.available === 'boolean' &&
      typeof entry.operationId === 'string' && (!entry.available || entry.observation !== null), 'TASK_OBSERVATION_RESPONSE_REFUSED');
    const reservation = budget?.reservations.find(item => item.operationId === entry.operationId);
    insist(reservation?.status === 'submitted', 'TASK_OBSERVATION_BINDING_REFUSED');
    const observation = entry.observation === null ? null : normalizeTaskObservation(entry.observation);
    if (observation) {
      insist(context.observationPolicy && context.receiptVerifier && authorization &&
        observation.taskDigest === task.digest && observation.childDigest === reservation.childDigest &&
        observation.chainId === task.policy.chainId && observation.actor === task.policy.actor &&
        observation.attemptExecutorDigest === executor.digest && observation.originalTransactionHash === reservation.transactionHash &&
        BigInt(observation.attemptGrantPolicyVersion) <= BigInt(authorization.grantPolicyVersion) &&
        observation.observationPolicyDigest === context.observationPolicy.digest &&
        observation.verifierId === context.receiptVerifier.verifierId && observation.verifierVersion === context.receiptVerifier.verifierVersion &&
        observation.verifierImplementationDigest === context.receiptVerifier.verifierImplementationDigest,
      'TASK_OBSERVATION_BINDING_REFUSED');
      insist(task.policy.intent.kind === 'exact-operation' ? observation.effect !== 'atomic-sale-observed' :
        observation.effect !== 'exact-operation-observed', 'TASK_OBSERVATION_EFFECT_REFUSED');
    }
    return { operationId: entry.operationId, observation, available: entry.available };
  });
  insist(new Set(observations.map(entry => entry.operationId)).size === observations.length, 'TASK_OBSERVATION_RESPONSE_REFUSED');
  const spent = budget?.reservations.filter(item => item.status !== 'cancelled') ?? [];
  const current = spent.map(item => observations.find(entry => entry.operationId === item.operationId && entry.available)?.observation);
  const state = !spent.length ? 'not-attempted' : spent.some(item => item.status === 'outcome-unknown') ? 'outcome-unknown' :
    current.every(item => item?.state === 'confirmed-at-depth') ? 'completed-at-observation-depth' :
    current.some(item => ['reverted-at-depth', 'superseded-at-depth'].includes(item?.state)) ? 'failed-at-observation-depth' : 'awaiting-evidence';
  insist(value.completion && completionStates.has(value.completion.state) && value.completion.state === state &&
    typeof value.completion.fresh === 'boolean', 'TASK_COMPLETION_RESPONSE_REFUSED');
  insist(!value.completion.fresh || (allowFresh && spent.length === 1 && current[0]), 'TASK_OBSERVATION_FRESHNESS_REFUSED');
  return freeze({ ...context, observations, observationRevision: value.observationRevision, completion: { state, fresh: value.completion.fresh } });
}
const historical = view => view ? freeze({ ...view, completion: { ...view.completion, fresh: false } }) : null;
/** Validate server facts before they enter any UI, including complete parent digest. */
export class TaskAuthorizationClient {
  #request; #context;
  constructor({ request, context }) { this.#request = request; this.#context = Object.freeze({ ...context }); }
  task(value) {
    insist(value && typeof value === 'object');
    const task = freezeTaskPolicy(value.policy), context = this.#context;
    insist(task.digest === value.digest, 'TASK_DIGEST_MISMATCH');
    insist(task.policy.origin === context.origin && task.policy.tenant === context.tenant &&
      task.policy.chainId === context.chainId && task.policy.actor === context.account.toLowerCase(), 'TASK_IDENTITY_REFUSED');
    return task;
  }
  view(value, { allowFresh = false } = {}) {
    insist(value && typeof value === 'object' && statuses.has(value.effectiveStatus));
    const task = this.task(value.task), authorization = value.authorization, executor = normalizeExecutor(value.executor);
    insist(value.capabilities?.executable === false && typeof value.capabilities.adapterConfigured === 'boolean' && typeof value.capabilities.receiptVerifierConfigured === 'boolean' && Array.isArray(value.capabilities.missing) &&
      value.capabilities.missing.length <= 16 &&
      value.capabilities.missing.every(code => typeof code === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(code)), 'TASK_EXECUTION_CAPABILITY_REFUSED');
    if (authorization === null) insist(value.effectiveStatus === 'pending' || value.effectiveStatus === 'expired');
    else { const reference = normalizeAuthorizationReference(authorization); insist(reference.taskDigest === task.digest && reference.status === value.effectiveStatus); }
    const budget = value.budget === null ? null : normalizeTaskBudget(value.budget);
    insist(authorization === null ? budget === null : budget?.taskDigest === task.digest);
    const executionState = budget?.reservations.some(item => item.status === 'outcome-unknown') ? 'unknown' :
      budget?.reservations.some(item => item.status === 'submitted') ? 'submitted' :
      budget?.reservations.some(item => item.status === 'reserved') ? 'reserved' : 'not-started';
    // Readiness is not authority or success. Only the authenticated service can
    // continue this task; quotes, provider events and references cannot execute it.
    return freeze({ task, executor, ...observationView(value, task, executor, budget, authorization, allowFresh), authorization: authorization ? { ...authorization } : null, effectiveStatus: value.effectiveStatus, budget, executionState,
      capabilities: { executable: false, adapterConfigured: value.capabilities.adapterConfigured, receiptVerifierConfigured: value.capabilities.receiptVerifierConfigured, missing: [...value.capabilities.missing] } });
  }
  async list() {
    const tasks = [], cursors = new Set(); let cursor = null, revision = null;
    do {
      const value = await this.#request('tasks/list', cursor === null ? {} : { cursor, revision });
      insist(Array.isArray(value.tasks) && value.tasks.length <= 50 &&
        (typeof value.revision === 'string' || Number.isSafeInteger(value.revision)) &&
        (value.nextCursor === null || (typeof value.nextCursor === 'string' && value.nextCursor.length > 0 && value.nextCursor.length <= 256)));
      if (revision !== null) insist(value.revision === revision, 'TASK_LIST_CHANGED');
      revision = value.revision; tasks.push(...value.tasks.map(item => this.view(item)));
      cursor = value.nextCursor;
      if (cursor !== null) { insist(!cursors.has(cursor), 'TASK_LIST_CHANGED'); cursors.add(cursor); }
      insist(cursors.size <= 1000, 'TASK_LIST_TOO_LARGE');
    } while (cursor !== null);
    insist(new Set(tasks.map(item => item.task.digest)).size === tasks.length);
    return Object.freeze(tasks);
  }
  async resume(taskDigest, expectedExecutorDigest, expectedObservationContext) {
    const raw = await this.#request('tasks/resume', { taskDigest }), value = this.view(raw, { allowFresh: true });
    insist(value.executor.digest === expectedExecutorDigest, 'TASK_EXECUTOR_CHANGED');
    sameObservationContext(value, expectedObservationContext);
    const continuation = raw.continuation;
    insist(value.task.digest === taskDigest && continuation &&
      ['blocked', 'waiting-for-operation', 'outcome-unknown', 'submitted', 'awaiting-evidence', 'completed-at-observation-depth', 'failed-at-observation-depth'].includes(continuation.state), 'TASK_EXECUTION_CAPABILITY_REFUSED');
    if (['blocked', 'waiting-for-operation'].includes(continuation.state) || continuation.code !== undefined)
      insist(typeof continuation.code === 'string' && /^TASK_[A-Z_]+$/.test(continuation.code));
    if (['outcome-unknown', 'submitted'].includes(continuation.state))
      insist(value.budget?.reservations.some(item => item.operationId === continuation.operationId && item.status === continuation.state));
    if (['awaiting-evidence', 'completed-at-observation-depth', 'failed-at-observation-depth'].includes(continuation.state)) {
      insist(value.budget?.reservations.some(item => item.status === 'submitted'));
      if (continuation.code === undefined) insist(value.completion.state === continuation.state &&
        (value.observations.some(entry => entry.operationId === continuation.operationId) ||
          continuation.operationId === undefined && !value.completion.fresh && ['completed-at-observation-depth', 'failed-at-observation-depth'].includes(continuation.state)), 'TASK_COMPLETION_RESPONSE_REFUSED');
      else insist(continuation.state === 'awaiting-evidence', 'TASK_COMPLETION_RESPONSE_REFUSED');
    }
    return freeze({ ...value, continuation: { state: continuation.state, ...(continuation.code ? { code: continuation.code } : {}),
      ...(continuation.operationId ? { operationId: continuation.operationId } : {}) } });
  }
  async observe(expected) {
    const operation = expected.budget?.reservations.find(item => item.status === 'submitted');
    insist(operation && expected.capabilities.receiptVerifierConfigured, 'TASK_RECEIPT_VERIFIER_NOT_CONNECTED');
    const raw = await this.#request('tasks/observe', { taskDigest: expected.task.digest, operationId: operation.operationId,
      childDigest: operation.childDigest, expectedBudgetRevision: expected.budget.revision });
    const value = this.view(raw, { allowFresh: true });
    insist(value.task.digest === expected.task.digest && value.executor.digest === expected.executor.digest, 'TASK_EXECUTOR_CHANGED');
    sameObservationContext(value, expected);
    const observation = normalizeTaskObservation(raw.observation);
    insist(raw.outcome === observation.state && value.observations.some(entry => entry.operationId === operation.operationId && entry.available &&
      JSON.stringify(entry.observation) === JSON.stringify(observation)), 'TASK_OBSERVATION_RESPONSE_REFUSED');
    // Map the service's observed completion into a UI phase; this creates no authority.
    return freeze({ ...value, continuation: { state: value.completion.state, operationId: operation.operationId } });
  }
  async status(taskDigest) { const value = this.view(await this.#request('tasks/status', { taskDigest })); insist(value.task.digest === taskDigest); return value; }
  async prepare(task, expectedExecutorDigest = null, expectedObservationContext = null) {
    const value = await this.#request('tasks/prepare', { policy: task.policy });
    insist(value.purpose === 'authorize-task' && typeof value.challengeId === 'string' && /^[A-Za-z0-9._:-]{16,256}$/.test(value.challengeId) && Number.isSafeInteger(value.expiresAt));
    const checked = this.task(value.task); insist(checked.digest === task.digest, 'TASK_DIGEST_MISMATCH');
    const executor = normalizeExecutor(value.executor);
    insist(expectedExecutorDigest === null || executor.digest === expectedExecutorDigest, 'TASK_EXECUTOR_CHANGED');
    const observation = normalizeObservationContext(value);
    if (expectedObservationContext !== null) sameObservationContext(observation, expectedObservationContext);
    return Object.freeze({ task: checked, executor, ...observation, challengeId: value.challengeId, expiresAt: value.expiresAt });
  }
  async authorize(challenge, code) {
    insist(typeof code === 'string' && /^\d{6}$/.test(code), 'TASK_CODE_REQUIRED');
    const value = this.view(await this.#request('tasks/authorize', { challengeId: challenge.challengeId, taskDigest: challenge.task.digest, executorDigest: challenge.executor.digest, observationPolicyDigest: challenge.observationPolicy?.digest ?? null, code }));
    insist(value.task.digest === challenge.task.digest && value.effectiveStatus === 'authorized');
    insist(value.executor.digest === challenge.executor.digest, 'TASK_EXECUTOR_CHANGED'); sameObservationContext(value, challenge); return value;
  }
  async revoke(view) {
    insist(view.authorization, 'TASK_AUTHORIZATION_REQUIRED');
    const value = this.view(await this.#request('tasks/revoke', { taskDigest: view.task.digest, expectedGrantPolicyVersion: view.authorization.grantPolicyVersion }));
    insist(value.task.digest === view.task.digest && value.executor.digest === view.executor.digest && value.effectiveStatus === 'revoked'); sameObservationContext(value, view); return value;
  }
}
/** No credentials, secrets, signatures or grant references are browser-persisted. */
export class TaskAuthorizationFlow {
  #client; #now; #notify; #epoch = 0; #challenge = null; #busy = false; #retryAt = 0; #waiting = 0; #continuationDelay = 30000;
  #state = { phase: 'locked', tasks: [], selected: null, error: null };
  constructor({ client, now = Date.now, onChange = () => {} }) { this.#client = client; this.#now = now; this.#notify = onChange; }
  snapshot() { return Object.freeze({ ...this.#state, challengeExpiresAt: this.#challenge?.expiresAt ?? null, busy: this.#busy, retryAfterMs: Math.max(0, this.#retryAt - this.#now()), continuationDelayMs: this.#continuationDelay }); }
  #paint(update) { this.#state = { ...this.#state, ...update };
    if (update.selected) this.#state.tasks = this.#state.tasks.map(view => view.task.digest === update.selected.task.digest ? update.selected : view);
    this.#notify(this.snapshot()); }
  #current(epoch) { return epoch === this.#epoch; }
  #progress(view) {
    this.#retryAt = 0;
    this.#waiting = view.continuation?.state === 'waiting-for-operation' ? Math.min(this.#waiting + 1, 3) : 0;
    this.#continuationDelay = this.#waiting ? Math.min(120000, 30000 * 2 ** (this.#waiting - 1)) : 30000;
    return view;
  }
  #phase(view) {
    if (view.effectiveStatus !== 'authorized') return view.effectiveStatus;
    return ({ blocked: 'authorized-blocked', 'waiting-for-operation': 'authorized-waiting',
      'outcome-unknown': 'outcome-unknown', submitted: 'submitted', 'awaiting-evidence': 'awaiting-evidence',
      'completed-at-observation-depth': view.completion.fresh ? 'completed-at-observation-depth' : 'awaiting-evidence',
      'failed-at-observation-depth': view.completion.fresh ? 'failed-at-observation-depth' : 'awaiting-evidence' })[view.continuation?.state] ?? 'authorized';
  }
  #continueRequest(view) {
    return view.executionState === 'submitted' && view.capabilities.receiptVerifierConfigured ? this.#client.observe(view) :
      this.#client.resume(view.task.digest, view.executor.digest, view);
  }
  #error(error) { return typeof error?.code === 'string' && /^(TASK|AUTH|LOGIN)_[A-Z_]+$/.test(error.code) ? error.code : 'TASK_SERVICE_UNAVAILABLE'; }
  suspend() { this.#epoch++; this.#challenge = null; this.#busy = false; this.#paint({ phase: this.#state.selected ? 'paused' : 'list', selected: historical(this.#state.selected), error: null }); }
  lock() { this.#epoch++; this.#challenge = null; this.#busy = false; this.#paint({ phase: 'locked', tasks: [], selected: null, error: null }); }
  async load(taskDigest = null) {
    const epoch = ++this.#epoch; this.#challenge = null; this.#busy = true; this.#paint({ phase: 'loading', selected: null, error: null });
    try { const tasks = await this.#client.list(); if (!this.#current(epoch)) return;
      this.#busy = false; this.#paint({ phase: 'list', tasks });
      if (taskDigest && tasks.some(view => view.task.digest === taskDigest)) await this.open(taskDigest);
    } catch (error) { if (this.#current(epoch)) { this.#busy = false; this.#paint({ phase: 'error', error: this.#error(error) }); } }
  }
  async open(taskDigest) {
    const epoch = ++this.#epoch; this.#challenge = null; this.#busy = true; this.#paint({ phase: 'loading', selected: null, error: null });
    try {
      const view = await this.#client.status(taskDigest); if (!this.#current(epoch)) return;
      this.#paint({ selected: view });
      if (view.effectiveStatus === 'pending') {
        const challenge = await this.#client.prepare(view.task, view.executor.digest, view); if (!this.#current(epoch)) return;
        insist(challenge.expiresAt > this.#now() && challenge.expiresAt <= this.#now() + 120000, 'TASK_CHALLENGE_EXPIRED');
        this.#challenge = challenge;
      }
      const checked = view.effectiveStatus === 'authorized' || view.executionState === 'submitted' && view.capabilities.receiptVerifierConfigured ?
        await this.#continueRequest(view) : view;
      if (!this.#current(epoch)) return;
      this.#busy = false; this.#paint({ phase: checked.effectiveStatus === 'pending' ? 'review' : this.#phase(checked), selected: this.#progress(checked) });
    } catch (error) { if (this.#state.selected?.effectiveStatus === 'authorized' || this.#state.selected?.executionState === 'submitted') await this.#refreshFailure(epoch, error);
      else if (this.#current(epoch)) { this.#busy = false; this.#paint({ phase: 'error', error: this.#error(error) }); } }
  }
  async authorize(code) {
    if (this.#busy || this.#state.phase !== 'review' || !this.#challenge) return;
    const epoch = this.#epoch, challenge = this.#challenge; this.#busy = true; this.#paint({ phase: 'authorizing', error: null });
    try {
      insist(challenge.expiresAt > this.#now(), 'TASK_CHALLENGE_EXPIRED');
      const view = await this.#client.authorize(challenge, code); code = ''; if (!this.#current(epoch)) return;
      this.#challenge = null; this.#paint({ phase: 'checking', selected: view });
      // The service continues the SAME bounded parent task, enforcing its grant
      // and scope. Missing adapters remain blocked; submission is not success.
      const checked = await this.#continueRequest(view); if (!this.#current(epoch)) return;
      this.#busy = false; this.#paint({ phase: this.#phase(checked), selected: this.#progress(checked) });
    } catch (error) { code = ''; if (this.#current(epoch) && this.#challenge === null && this.#state.selected?.effectiveStatus === 'authorized') { await this.#refreshFailure(epoch, error); return; }
      if (this.#current(epoch)) { this.#challenge = null; this.#busy = false;
      this.#paint({ phase: 'uncertain', error: this.#error(error) }); } }
  }
  markHistorical() { if (this.#state.selected?.completion.fresh) this.#paint({ selected: historical(this.#state.selected),
    ...(['completed-at-observation-depth', 'failed-at-observation-depth'].includes(this.#state.phase) ? { phase: 'awaiting-evidence' } : {}) }); }
  async #refreshFailure(epoch, error) {
    if (!this.#current(epoch)) return;
    if (error?.code === 'AUTH_RATE_LIMITED' && error.status === 429 && Number.isSafeInteger(error.retryAfterMs) && error.retryAfterMs >= 1000 && error.retryAfterMs <= 900000) {
      this.#retryAt = this.#now() + error.retryAfterMs; this.#busy = false;
      this.#paint({ phase: 'rate-limited', selected: historical(this.#state.selected), error: this.#error(error) }); return;
    }
    let selected = historical(this.#state.selected);
    if (selected) {
      try { const checked = await this.#client.status(selected.task.digest);
        if (!this.#current(epoch)) return;
        insist(checked.executor.digest === selected.executor.digest, 'TASK_EXECUTOR_CHANGED'); sameObservationContext(checked, selected); selected = checked;
      } catch { /* Keep any old evidence explicitly historical if status also fails. */ }
    }
    if (!this.#current(epoch)) return; this.#busy = false;
    this.#paint({ phase: selected?.executionState === 'submitted' ? 'awaiting-evidence' : 'uncertain', selected, error: this.#error(error) });
  }
  async continue() {
    const selected = this.#state.selected;
    if (this.#busy || this.#now() < this.#retryAt || !selected || !(selected.effectiveStatus === 'authorized' && selected.capabilities.adapterConfigured ||
      selected.executionState === 'submitted' && selected.capabilities.receiptVerifierConfigured)) return;
    const epoch = this.#epoch; this.#busy = true;
    this.#paint({ phase: 'checking', selected: historical(this.#state.selected), error: null });
    try { const view = await this.#continueRequest(this.#state.selected); if (!this.#current(epoch)) return;
      this.#busy = false; this.#paint({ phase: this.#phase(view), selected: this.#progress(view) });
    } catch (error) { await this.#refreshFailure(epoch, error); }
  }
  async recover() {
    if (this.#busy || this.#now() < this.#retryAt || !['unknown', 'submitted'].includes(this.#state.selected?.executionState)) return;
    const epoch = this.#epoch; this.#busy = true;
    this.#paint({ phase: 'recovering', selected: historical(this.#state.selected), error: null });
    try { const view = await this.#continueRequest(this.#state.selected); if (!this.#current(epoch)) return;
      this.#busy = false; this.#paint({ phase: this.#phase(view), selected: this.#progress(view) });
    } catch (error) { await this.#refreshFailure(epoch, error); }
  }
  async revoke() {
    if (this.#busy || !this.#state.selected?.authorization) return;
    const epoch = this.#epoch, selected = this.#state.selected; this.#busy = true; this.#paint({ phase: 'revoking', selected: historical(selected), error: null });
    try { const view = await this.#client.revoke(selected); if (!this.#current(epoch)) return;
      this.#busy = false; this.#challenge = null; this.#paint({ phase: this.#phase(view), selected: view });
    } catch (error) { if (this.#current(epoch)) { this.#busy = false; this.#paint({ phase: 'uncertain', error: this.#error(error) }); } }
  }
}
